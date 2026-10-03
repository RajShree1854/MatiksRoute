import { OpenAIProvider } from '@/providers/openai';
import { GeminiProvider } from '@/providers/gemini';
import { GroqProvider } from '@/providers/groq';
import {
  AIProvider,
  AnyRoutingEvent,
  ChatMessage,
  ComplexityTier,
  DoneEvent,
  FallbackEvent,
  ImageAction,
  MetaEvent,
  ProviderName,
  RequestLog,
} from '@/providers/types';
import { compressMessages } from '@/lib/compressor';
import { classifyComplexity, getProviderChain, isForcedPriority, getForcedPriorityChain } from '@/lib/classifier';
import { isProviderAvailable, hasCapacityFor, recordUsage } from '@/lib/quotaManager';
import { processMessagesForProvider } from '@/lib/modalityBridge';
import { createResilientStream } from '@/lib/streamRelay';
import { trimMessagesToTokenBudget } from '@/lib/tokenizer';
import { insertRequestLog } from '@/lib/db';

const MODEL_CONTEXT_LIMIT: Record<ProviderName, number> = {
  openai: 128_000,
  gemini: 1_000_000,
  groq: 32_768,
};

function buildProviders(): Record<ProviderName, AIProvider> {
  return {
    openai: new OpenAIProvider(),
    gemini: new GeminiProvider(),
    groq: new GroqProvider(),
  };
}

export interface OrchestratorResult {
  stream: ReadableStream<Uint8Array>;
}

export async function route(messages: ChatMessage[]): Promise<OrchestratorResult> {
  const startTime = Date.now();
  const encoder = new TextEncoder();

  // ── 1. Compress ──────────────────────────────────────────────────────────
  const { messages: compressed, originalTokens, compressedTokens } = compressMessages(messages);

  // ── 2. Classify & build provider chain ──────────────────────────────────
  // FORCED_PRIORITY=true (default): skip the complexity classifier entirely.
  // Use the fixed PRIORITY_ORDER env var as the chain for every request.
  // FORCED_PRIORITY=false: run the standard hard / medium / simple classifier.
  let tier: ComplexityTier;
  let chain: ProviderName[];

  if (isForcedPriority) {
    tier = 'simple'; // neutral placeholder — classifier was intentionally skipped
    chain = getForcedPriorityChain();
  } else {
    tier = classifyComplexity(compressed);
    chain = getProviderChain(tier);
  }

  // ── 3. Filter to providers that are (a) not in cooldown AND
  //       (b) have enough TPM budget for this request.
  //    Estimate total tokens as 3× input (covers most real responses).
  const estimatedTotalTokens = Math.max(compressedTokens * 3, 100);
  const availableChain = chain.filter(
    (p) => isProviderAvailable(p) && hasCapacityFor(p, estimatedTotalTokens),
  );
  // If every provider is over budget, fall back to the original chain so we
  // still get a response rather than a silent failure.
  const effectiveChain = availableChain.length > 0 ? availableChain : chain;

  const primaryProvider = effectiveChain[0];
  const providers = buildProviders();

  // ── 4. Trim context to provider's context window ─────────────────────────
  const contextLimit = MODEL_CONTEXT_LIMIT[primaryProvider];
  const trimmedMessages = trimMessagesToTokenBudget(compressed, contextLimit);

  // ── 5. Process modality (images) ─────────────────────────────────────────
  const { messages: processedMessages, hadImages, imageAction } =
    await processMessagesForProvider(trimmedMessages, providers[primaryProvider]);

  // ── 6. Prepare routing metadata ──────────────────────────────────────────
  const collectedEvents: AnyRoutingEvent[] = [];

  const metaEvent: MetaEvent = {
    type: 'meta',
    tier,
    provider: primaryProvider,
    hadImages,
    imageAction: imageAction as ImageAction,
    originalTokens,
    compressedTokens,
  };

  // ── 7. Build resilient stream ────────────────────────────────────────────
  const aiProviderChain = effectiveChain.map((name) => providers[name]);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  // Track real output token count from streamed content
  let outputTokenCount = 0;

  (async () => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(metaEvent)}\n\n`));

    const relayStream = createResilientStream(aiProviderChain, processedMessages, {
      onEvent: (event) => {
        collectedEvents.push(event);
      },
    });

    const reader = relayStream.getReader();
    const lineDecoder = new TextDecoder();
    let lineBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);

      // Count output tokens from the live token stream
      lineBuffer += lineDecoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const json = trimmed.slice(5).trim();
        if (!json || json === '[DONE]') continue;
        try {
          const parsed = JSON.parse(json);
          if (parsed?.type === 'token' && typeof parsed.content === 'string') {
            // 1 token ≈ 4 chars (standard GPT-4 heuristic)
            outputTokenCount += Math.ceil(parsed.content.length / 4);
          }
        } catch { /* skip */ }
      }
    }

    const fallbackEvents = collectedEvents.filter((e) => e.type === 'fallback') as FallbackEvent[];
    const midStreamEvents = collectedEvents.filter((e) => e.type === 'mid_stream_failover');
    const latencyMs = Date.now() - startTime;
    const totalTokens = compressedTokens + outputTokenCount;

    // Determine which provider actually generated the final response.
    // If fallbacks occurred, it's the `to` provider of the last fallback event.
    const actualProvider: ProviderName =
      fallbackEvents.length > 0 ? fallbackEvents[fallbackEvents.length - 1].to : primaryProvider;

    const doneEvent: DoneEvent = {
      type: 'done',
      provider: actualProvider,
      latencyMs,
      tokensUsed: totalTokens,
      fallbackCount: fallbackEvents.length,
      midStreamFailover: midStreamEvents.length > 0,
    };

    await writer.write(encoder.encode(`data: ${JSON.stringify(doneEvent)}\n\n`));
    await writer.close().catch(() => undefined);

    // Record usage against the provider that actually served the response.
    recordUsage(actualProvider, totalTokens);

    const errorEvents = collectedEvents.filter((e) => e.type === 'error') as { type: 'error', message: string }[];
    const errorReason = errorEvents.length > 0 ? errorEvents.map(e => e.message).join(' | ') : null;

    scheduleLog({
      timestamp: new Date().toISOString(),
      complexityTier: tier,
      smartRouteTarget: primaryProvider,
      providerAttempted: effectiveChain.join(' → '),
      providerSucceeded: actualProvider,
      fallbackTriggered: fallbackEvents.length > 0,
      midStreamFailover: midStreamEvents.length > 0,
      hadImages,
      imageAction: imageAction as ImageAction,
      originalTokens,
      compressedTokens,
      tokensSavedPct: originalTokens > 0
        ? ((originalTokens - compressedTokens) / originalTokens) * 100
        : 0,
      latencyMs,
      errorReason,
    });
  })();

  return { stream: readable };
}

function scheduleLog(log: Omit<RequestLog, 'id'>): void {
  Promise.resolve().then(() => {
    try {
      insertRequestLog(log);
    } catch {
      // Non-critical; never surface DB errors to the user
    }
  });
}
