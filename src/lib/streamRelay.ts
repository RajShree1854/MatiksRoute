import { AIProvider, AnyRoutingEvent, ChatMessage, ProviderName } from '@/providers/types';
import { admitRequest, releaseRequest } from '@/lib/admissionController';
import { getRemainingTpm } from '@/lib/quotaManager';

export interface RelayOptions {
  onEvent: (event: AnyRoutingEvent) => void;
  failoverBeforeRetry?: boolean;
  onProviderTokens?: (provider: ProviderName, outputTokens: number) => void;
  inputTokens: number;
}

export function createResilientStream(
  providers: AIProvider[],
  messages: ChatMessage[],
  options: RelayOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const { onEvent, failoverBeforeRetry = true, onProviderTokens } = options;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  (async () => {
    let succeeded = false;
    let accumulatedPartial = '';
    let lastError = 'All providers exhausted';

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      const nextProvider = providers[i + 1];

      const admitted = admitRequest(provider.name);
      if (!admitted && failoverBeforeRetry && nextProvider) {
        emitEvent(writer, encoder, onEvent, {
          type: 'fallback',
          from: provider.name,
          to: nextProvider.name,
          reason: 'admission_rejected',
        });
        continue;
      }

      if (i > 0) {
        emitEvent(writer, encoder, onEvent, {
          type: 'fallback',
          from: providers[i - 1].name,
          to: provider.name,
          reason: 'provider_error',
        });
      }

      const abortController = new AbortController();

      const attemptMessages = [...messages];
      if (accumulatedPartial) {
        attemptMessages.push({
          role: 'assistant',
          content: accumulatedPartial,
        });
      }

      let stream: ReadableStream<Uint8Array>;
      try {
        stream = await provider.streamChat(attemptMessages, abortController.signal);
      } catch (err) {
        releaseRequest(provider.name, false);
        const reason = err instanceof Error ? err.message : String(err);
        onEvent({ type: 'error', message: `${provider.name}: ${reason}` });

        if (failoverBeforeRetry && nextProvider) continue;
        break;
      }

      const result = await drainStream(
        stream,
        writer,
        provider.name,
        nextProvider?.name,
        onEvent,
        options.inputTokens,
        accumulatedPartial,
        onProviderTokens,
      );

      if (result.midStreamFailover) {
        accumulatedPartial += result.streamedText;
      }

      if (result.succeeded) {
        releaseRequest(provider.name, true);
        succeeded = true;
        break;
      }

      releaseRequest(provider.name, false);

      if (!result.midStreamFailover || !nextProvider) {
        if (result.error) lastError = result.error;
        break;
      }
    }

    if (!succeeded) {
      const errEvent: AnyRoutingEvent = { type: 'error', message: lastError };
      await safeWrite(writer, encoder.encode(`data: ${JSON.stringify(errEvent)}\n\n`));
    }

    await safeWrite(writer, encoder.encode('data: [DONE]\n\n'));
    await writer.close().catch(() => undefined);
  })();

  return readable;
}

function trimContinuationOverlap(emitted: string, continuation: string): string {
  if (!continuation || !emitted) return continuation;
  const max = Math.min(emitted.length, continuation.length, 512);
  for (let k = max; k > 0; k--) {
    if (emitted.endsWith(continuation.slice(0, k))) return continuation.slice(k);
  }
  return continuation;
}

interface DrainResult {
  succeeded: boolean;
  midStreamFailover: boolean;
  streamedText: string;
  error?: string;
}

async function drainStream(
  stream: ReadableStream<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  currentProvider: ProviderName,
  nextProvider: ProviderName | undefined,
  onEvent: (event: AnyRoutingEvent) => void,
  inputTokens: number,
  previousTextToTrim: string,
  onProviderTokens?: (provider: ProviderName, outputTokens: number) => void,
): Promise<DrainResult> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let lineBuffer = '';
  let tokensStreamed = 0;
  let accumulatedText = '';
  let tpmExhausted = false;
  let toolCallInFlight = false;
  let overlapTrimmed = !previousTextToTrim;
  let bufferedContinuation = '';

  const maxOutputTokens = Math.max(0, getRemainingTpm(currentProvider) - inputTokens);

  try {
    const reader = stream.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (!overlapTrimmed && bufferedContinuation) {
          const trimmed = trimContinuationOverlap(previousTextToTrim, bufferedContinuation);
          if (trimmed) await safeWrite(writer, encoder.encode(`data: ${JSON.stringify({ type: 'token', content: trimmed })}\n\n`));
        }
        break;
      }

      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const json = trimmed.slice(5).trim();
        if (!json || json === '[DONE]') continue;
        
        try {
          const parsed = JSON.parse(json);
          if (parsed?.type === 'tool_call_started') {
            toolCallInFlight = true;
            await safeWrite(writer, encoder.encode(`data: ${json}\n\n`));
          } else if (parsed?.type === 'token' && typeof parsed.content === 'string') {
            tokensStreamed++;
            accumulatedText += parsed.content;

            if (!overlapTrimmed) {
              bufferedContinuation += parsed.content;
              if (bufferedContinuation.length >= 100) {
                const trimmedToken = trimContinuationOverlap(previousTextToTrim, bufferedContinuation);
                if (trimmedToken) {
                  await safeWrite(writer, encoder.encode(`data: ${JSON.stringify({ type: 'token', content: trimmedToken })}\n\n`));
                }
                overlapTrimmed = true;
              }
            } else {
              await safeWrite(writer, encoder.encode(`data: ${json}\n\n`));
            }

            if (nextProvider && tokensStreamed >= maxOutputTokens) {
              tpmExhausted = true;
              reader.cancel().catch(() => undefined);
              break;
            }
          } else {
            await safeWrite(writer, encoder.encode(`data: ${json}\n\n`));
          }
        } catch { /* skip */ }
      }

      if (tpmExhausted) break;
    }

    onProviderTokens?.(currentProvider, tokensStreamed);

    if (tpmExhausted && nextProvider) {
      if (toolCallInFlight) {
        return { succeeded: false, midStreamFailover: false, streamedText: accumulatedText, error: 'Mid-stream failover refused: tool-call in flight' };
      }
      const failoverEvent: AnyRoutingEvent = {
        type: 'mid_stream_failover',
        from: currentProvider,
        to: nextProvider,
        tokensStreamedBeforeFailure: tokensStreamed,
      };
      onEvent(failoverEvent);
      await safeWrite(writer, encoder.encode(`data: ${JSON.stringify(failoverEvent)}\n\n`));
      return { succeeded: false, midStreamFailover: true, streamedText: accumulatedText };
    }

    return { succeeded: true, midStreamFailover: false, streamedText: accumulatedText };
  } catch (err) {
    onProviderTokens?.(currentProvider, tokensStreamed);

    if (!nextProvider || toolCallInFlight) {
      const errorMsg = toolCallInFlight ? 'Mid-stream failover refused: tool-call in flight' : (err instanceof Error ? err.message : String(err));
      return { succeeded: false, midStreamFailover: false, streamedText: accumulatedText, error: errorMsg };
    }

    const failoverEvent: AnyRoutingEvent = {
      type: 'mid_stream_failover',
      from: currentProvider,
      to: nextProvider,
      tokensStreamedBeforeFailure: tokensStreamed,
    };
    onEvent(failoverEvent);
    await safeWrite(writer, encoder.encode(`data: ${JSON.stringify(failoverEvent)}\n\n`));

    return { succeeded: false, midStreamFailover: true, streamedText: accumulatedText };
  }
}

function emitEvent(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  onEvent: (event: AnyRoutingEvent) => void,
  event: AnyRoutingEvent,
): void {
  onEvent(event);
  safeWrite(writer, encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
}

async function safeWrite(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  chunk: Uint8Array,
): Promise<void> {
  try {
    await writer.write(chunk);
  } catch {
    // Client disconnected
  }
}
