import { AIProvider, ChatMessage, ProviderName } from './types';
import { isProviderAvailable, recordRateLimit } from '@/lib/quotaManager';

export class GroqProvider implements AIProvider {
  readonly name: ProviderName = 'groq';
  readonly supportsVision = true;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl = 'https://api.groq.com/openai/v1';

  constructor() {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('GROQ_API_KEY environment variable is not set');
    this.apiKey = key;
    this.model = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
  }

  isAvailable(): boolean {
    return isProviderAvailable('groq');
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
        recordRateLimit('groq', Number.isFinite(retryAfter) ? retryAfter : 60);
      }
      throw new Error(`Groq HTTP ${response.status}: ${text}`);
    }

    if (!response.body) throw new Error('Groq returned an empty response body');

    return response.body.pipeThrough(createGroqTokenExtractor());
  }
}

/**
 * Groq is OpenAI-compatible. Extracts content delta tokens into the normalized format.
 */
function createGroqTokenExtractor(): TransformStream<Uint8Array, Uint8Array> {
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
