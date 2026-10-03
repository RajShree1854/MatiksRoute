import { OpenAIProvider } from '@/providers/openai';
import { GeminiProvider } from '@/providers/gemini';
import { GroqProvider } from '@/providers/groq';
import {
  AIProvider,
  AnyRoutingEvent,
  ChatMessage,
  DoneEvent,
  FallbackEvent,
  ImageAction,
  MetaEvent,
  ProviderName,
  RequestLog,
} from '@/providers/types';
import { compressMessages, CompressionMode } from '@/lib/compressor';
import { buildRoutingStrategy } from '@/lib/classifier';
import { isProviderAvailable, hasCapacityFor, recordUsage, selectByHeadroom } from '@/lib/quotaManager';
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

function resolveCompressionMode(): CompressionMode {
  const raw = (process.env.COMPRESSION_MODE ?? 'auto').toLowerCase();
  if (raw === 'off') return 'off';
  if (raw === 'lite') return 'lite';
  return 'auto';
}

export interface OrchestratorResult {
  stream: ReadableStream<Uint8Array>;
}

export async function route(messages: ChatMessage[]): Promise<OrchestratorResult> {
  const startTime = Date.now();
  const encoder = new TextEncoder();

  const compressionMode = resolveCompressionMode();
  const {
    messages: compressed,
    originalTokens,
    compressedTokens,
    mode: appliedMode,
  } = compressMessages(messages, { mode: compressionMode });

  const strategy = buildRoutingStrategy(compressed);
  const { tier, chain, failoverBeforeRetry } = strategy;

  const estimatedTotalTokens = Math.max(compressedTokens * 3, 100);

  const capacityFiltered = chain.filter(
    (p) => isProviderAvailable(p) && hasCapacityFor(p, estimatedTotalTokens),
  );

  const effectiveChain =
    capacityFiltered.length > 0
      ? selectByHeadroom(capacityFiltered)
      : chain;

  const primaryProvider = effectiveChain[0];
  const providers = buildProviders();

  const contextLimit = MODEL_CONTEXT_LIMIT[primaryProvider];
  const trimmedMessages = trimMessagesToTokenBudget(compressed, contextLimit);

  const { messages: processedMessages, hadImages, imageAction } =
    await processMessagesForProvider(trimmedMessages, providers[primaryProvider]);

  const collectedEvents: AnyRoutingEvent[] = [];

  const metaEvent: MetaEvent = {
    type: 'meta',
    tier,
    provider: primaryProvider,
    hadImages,
    imageAction: imageAction as ImageAction,
    originalTokens,
    compressedTokens,
    compressionMode: appliedMode,
    failoverBeforeRetry,
  };

  const aiProviderChain = effectiveChain.map((name) => providers[name]);
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  let outputTokenCount = 0;

  (async () => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(metaEvent)}\n\n`));

    const relayStream = createResilientStream(aiProviderChain, processedMessages, {
      onEvent: (event) => {
        collectedEvents.push(event);
      },
      failoverBeforeRetry,
    });

    const reader = relayStream.getReader();
    const lineDecoder = new TextDecoder();
    let lineBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);

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
            outputTokenCount += Math.ceil(parsed.content.length / 4);
          }
        } catch { /* skip */ }
      }
    }

    const fallbackEvents = collectedEvents.filter((e) => e.type === 'fallback') as FallbackEvent[];
    const midStreamEvents = collectedEvents.filter((e) => e.type === 'mid_stream_failover');
    const latencyMs = Date.now() - startTime;
    const totalTokens = compressedTokens + outputTokenCount;

    const actualProvider: ProviderName =
      fallbackEvents.length > 0
        ? fallbackEvents[fallbackEvents.length - 1].to
        : primaryProvider;

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

    recordUsage(actualProvider, totalTokens);

    const errorEvents = collectedEvents.filter(
      (e) => e.type === 'error',
    ) as { type: 'error'; message: string }[];
    const errorReason = errorEvents.length > 0 ? errorEvents.map((e) => e.message).join(' | ') : null;

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
      tokensSavedPct:
        originalTokens > 0
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
      // Non-critical
    }
  });
}
