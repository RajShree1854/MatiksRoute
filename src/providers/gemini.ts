import { AIProvider, ChatMessage, ContentPart, ProviderName } from './types';
import { isProviderAvailable, recordRateLimit } from '@/lib/quotaManager';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export class GeminiProvider implements AIProvider {
  readonly name: ProviderName = 'gemini';
  readonly supportsVision = true;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  constructor() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY environment variable is not set');
    this.apiKey = key;
    this.model = process.env.GEMINI_MODEL ?? 'gemini-1.5-pro';
  }

  isAvailable(): boolean {
    return isProviderAvailable('gemini');
  }

  async streamChat(messages: ChatMessage[], signal?: AbortSignal, maxTokens = 8192): Promise<ReadableStream<Uint8Array>> {
    const { systemInstruction, contents } = this.translateMessages(messages);

    const body: Record<string, unknown> = {
      contents,
      generationConfig: { maxOutputTokens: maxTokens },
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const url =
      `${this.baseUrl}/models/${this.model}:streamGenerateContent` +
      `?key=${this.apiKey}&alt=sse`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`Gemini HTTP ${response.status}: ${text}`);
    }

    if (!response.body) throw new Error('Gemini returned an empty response body');

    return response.body.pipeThrough(createGeminiTokenExtractor());
  }

  private translateMessages(messages: ChatMessage[]): {
    systemInstruction?: { parts: GeminiPart[] };
    contents: GeminiContent[];
  } {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    const systemInstruction =
      systemMessages.length > 0
        ? { parts: [{ text: systemMessages.map((m) => this.extractText(m.content)).join('\n') }] }
        : undefined;

    const contents: GeminiContent[] = conversationMessages.map((msg) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: this.translateContent(msg.content),
    }));

    return { systemInstruction, contents };
  }

  private extractText(content: ChatMessage['content']): string {
    if (typeof content === 'string') return content;
    return content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
  }

  private translateContent(content: ChatMessage['content']): GeminiPart[] {
    if (typeof content === 'string') return [{ text: content }];

    return content.map((part: ContentPart): GeminiPart => {
      if (part.type === 'text') return { text: part.text };

      // image_url — expect data URL format: data:<mime>;base64,<data>
      const url = part.image_url.url;
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return { text: '[unsupported image format]' };
      return { inlineData: { mimeType: match[1], data: match[2] } };
    });
  }
}

/**
 * Transforms Gemini SSE chunks into the normalized token stream format.
 */
function createGeminiTokenExtractor(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  let quotaHit = false;

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
          const text: string | undefined =
            parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'token', content: text })}\n\n`),
            );
          }
          // Gemini signals token cutoff with finishReason: "MAX_TOKENS"
          const finishReason: string | undefined = parsed?.candidates?.[0]?.finishReason;
          if (finishReason === 'MAX_TOKENS') {
            quotaHit = true;
          }
        } catch {
          // Skip malformed SSE chunks
        }
      }
    },
    flush(controller) {
      if (quotaHit) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'quota_hit', provider: 'gemini' })}\n\n`),
        );
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
    },
  });
}
