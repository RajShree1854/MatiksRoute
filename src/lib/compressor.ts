import { ChatMessage } from '@/providers/types';
import { countMessagesTokens, countTokens } from '@/lib/tokenizer';

export type CompressionMode = 'off' | 'lite' | 'auto';

export interface CompressionConfig {
  mode: CompressionMode;
  maxHistoryMessages?: number;
}

export interface CompressResult {
  messages: ChatMessage[];
  originalTokens: number;
  compressedTokens: number;
  mode: CompressionMode;
}

const DEFAULT_MAX_HISTORY = 12;
const AUTO_TRIGGER_THRESHOLD = 2_000;

export function compressMessages(
  messages: ChatMessage[],
  config: CompressionConfig = { mode: 'auto' },
): CompressResult {
  const originalTokens = countMessagesTokens(messages);
  const effectiveMode = resolveMode(config, originalTokens);

  if (effectiveMode === 'off') {
    return { messages, originalTokens, compressedTokens: originalTokens, mode: 'off' };
  }

  const maxHistory = config.maxHistoryMessages ?? DEFAULT_MAX_HISTORY;
  let result = deduplicateSystemPrompts(messages);
  result = normalizeWhitespace(result);
  result = collapseHistory(result, maxHistory);

  const compressedTokens = countMessagesTokens(result);

  return { messages: result, originalTokens, compressedTokens, mode: effectiveMode };
}

function resolveMode(config: CompressionConfig, tokenCount: number): CompressionMode {
  if (config.mode === 'off') return 'off';
  if (config.mode === 'lite') return 'lite';
  return tokenCount >= AUTO_TRIGGER_THRESHOLD ? 'lite' : 'off';
}

function deduplicateSystemPrompts(messages: ChatMessage[]): ChatMessage[] {
  const systemMessages = messages.filter((m) => m.role === 'system');
  if (systemMessages.length <= 1) return messages;

  const merged = systemMessages
    .map((m) => (typeof m.content === 'string' ? m.content : extractText(m.content)))
    .join('\n');

  const mergedSystem: ChatMessage = { role: 'system', content: merged };
  return [mergedSystem, ...messages.filter((m) => m.role !== 'system')];
}

function normalizeWhitespace(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content !== 'string') return msg;

    const normalized = msg.content
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[^\S\n]{2,}/g, ' ')
      .trim();

    return normalized === msg.content ? msg : { ...msg, content: normalized };
  });
}

function collapseHistory(messages: ChatMessage[], maxHistory: number): ChatMessage[] {
  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversation = messages.filter((m) => m.role !== 'system');

  if (conversation.length <= maxHistory) return messages;

  const excess = conversation.slice(0, conversation.length - maxHistory);
  const kept = conversation.slice(conversation.length - maxHistory);

  const totalExcessTokens = excess.reduce((acc, m) => {
    const text = typeof m.content === 'string' ? m.content : extractText(m.content);
    return acc + countTokens(text);
  }, 0);

  const summaryParts = excess.map((m) => {
    const text = typeof m.content === 'string' ? m.content : '[media]';
    const preview = text.length > 100 ? `${text.slice(0, 100)}…` : text;
    return `${m.role}: ${preview}`;
  });

  const summaryMessage: ChatMessage = {
    role: 'user',
    content: `[Earlier context (${totalExcessTokens} tokens summarized): ${summaryParts.join(' | ')}]`,
  };

  return [...systemMessages, summaryMessage, ...kept];
}

function extractText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}
