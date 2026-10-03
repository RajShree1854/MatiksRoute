import { AIProvider, AnyRoutingEvent, ChatMessage, ProviderName } from '@/providers/types';

export interface RelayOptions {
  /** Called when a routing event occurs (fallback, mid-stream failover, etc.) */
  onEvent: (event: AnyRoutingEvent) => void;
}

/**
 * Creates a resilient SSE stream that tries each provider in order.
 *
 * - Pre-stream failures (network error, 4xx): silently fall back to next provider.
 * - Mid-stream failures (connection drop during streaming): inject a failover event,
 *   resume from the next provider with context of what was already sent.
 *
 * All provider streams must emit normalized SSE: `data: {"type":"token","content":"..."}\n\n`
 */
export function createResilientStream(
  providers: AIProvider[],
  messages: ChatMessage[],
  options: RelayOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const { onEvent } = options;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  (async () => {
    const attempted: ProviderName[] = [];
    let succeeded = false;
    let currentMessages = messages;

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i];
      attempted.push(provider.name);

      if (i > 0) {
        // Emit a fallback event before trying the next provider
        const prevProvider = providers[i - 1].name;
        const eventPayload: AnyRoutingEvent = {
          type: 'fallback',
          from: prevProvider,
          to: provider.name,
          reason: 'provider_error',
        };
        onEvent(eventPayload);
        await safeWrite(
          writer,
          encoder.encode(`data: ${JSON.stringify(eventPayload)}\n\n`),
        );
      }

      let stream: ReadableStream<Uint8Array>;
      try {
        stream = await provider.streamChat(currentMessages);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        onEvent({ type: 'error', message: `${provider.name}: ${reason}` });
        continue; // Try next provider
      }

      // Attempt to read the stream; handle mid-stream failures
      const bufferedTokens: string[] = [];
      let midStreamFailed = false;

      try {
        const reader = stream.getReader();
        const lineDecoder = new TextDecoder();
        let lineBuffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Forward raw bytes to client
          await safeWrite(writer, value);

          // Also buffer decoded tokens for mid-stream resume context
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
                bufferedTokens.push(parsed.content);
              }
            } catch { /* skip */ }
          }
        }

        succeeded = true;
        break; // Stream completed cleanly
      } catch {
        // Mid-stream failure
        midStreamFailed = true;
        const nextProvider = providers[i + 1];
        if (!nextProvider) break; // No more providers

        const failoverEvent: AnyRoutingEvent = {
          type: 'mid_stream_failover',
          from: provider.name,
          to: nextProvider.name,
          tokensStreamedBeforeFailure: bufferedTokens.length,
        };
        onEvent(failoverEvent);
        await safeWrite(
          writer,
          encoder.encode(`data: ${JSON.stringify(failoverEvent)}\n\n`),
        );

        // Inject the partial response as context for the next provider
        const partialContent = bufferedTokens.join('');
        if (partialContent) {
          currentMessages = [
            ...currentMessages,
            { role: 'assistant', content: `[Partial response, continue from here:] ${partialContent}` },
          ];
        }
      }

      if (!midStreamFailed) break;
    }

    if (!succeeded) {
      const errEvent: AnyRoutingEvent = { type: 'error', message: 'All providers failed' };
      await safeWrite(
        writer,
        encoder.encode(`data: ${JSON.stringify(errEvent)}\n\n`),
      );
    }

    await safeWrite(writer, encoder.encode('data: [DONE]\n\n'));
    await writer.close().catch(() => undefined);
  })();

  return readable;
}

async function safeWrite(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  chunk: Uint8Array,
): Promise<void> {
  try {
    await writer.write(chunk);
  } catch {
    // Client disconnected; ignore
  }
}
