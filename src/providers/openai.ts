import { AIProvider, ChatMessage, ProviderName } from './types';
import { isProviderAvailable, recordRateLimit } from '@/lib/quotaManager';

export class OpenAIProvider implements AIProvider {
  readonly name: ProviderName = 'openai';
  readonly supportsVision = true;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl = 'https://api.openai.com/v1';

  constructor() {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY environment variable is not set');
    this.apiKey = key;
    this.model = process.env.OPENAI_MODEL ?? 'gpt-4o';
  }

  isAvailable(): boolean {
    return isProviderAvailable('openai');
  }

  async streamChat(messages: ChatMessage[], signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, messages, stream: true, max_tokens: 8192 }),
      signal: signal ?? AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') ?? '60', 10);
        recordRateLimit('openai', Number.isFinite(retryAfter) ? retryAfter : 60);
      }
      throw new Error(`OpenAI HTTP ${response.status}: ${text}`);
    }

    if (!response.body) throw new Error('OpenAI returned an empty response body');

    return response.body.pipeThrough(createOpenAITokenExtractor());
  }
}

/**
 * Transforms the raw OpenAI SSE stream into a normalized token-only stream.
 * Emits: data: {"type":"token","content":"..."}\n\n
 */
function createOpenAITokenExtractor(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const json = trimmed.slice(5).trim();
        if (!json || json === '[DONE]') continue;

        try {
          const parsed = JSON.parse(json);
          const content: string | undefined = parsed?.choices?.[0]?.delta?.content;
          const toolCalls = parsed?.choices?.[0]?.delta?.tool_calls;
          if (content) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'token', content })}\n\n`),
            );
          }
          if (toolCalls) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'tool_call_started' })}\n\n`),
            );
          }
        } catch {
          // Skip malformed SSE chunks
        }
      }
    },
    flush(controller) {
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    },
  });
}
