import { ChatMessage } from '@/providers/types';
import { countMessagesTokens } from '@/lib/tokenizer';

const MAX_HISTORY_MESSAGES = 12;

interface CompressResult {
  messages: ChatMessage[];
  originalTokens: number;
  compressedTokens: number;
}

export function compressMessages(messages: ChatMessage[]): CompressResult {
  const originalTokens = countMessagesTokens(messages);

  let compressed = deduplicateSystemPrompts(messages);
  compressed = normalizeWhitespace(compressed);
  compressed = truncateOldHistory(compressed);

  const compressedTokens = countMessagesTokens(compressed);

  return { messages: compressed, originalTokens, compressedTokens };
}

/** Removes duplicate consecutive system prompts, keeping only the last one. */
function deduplicateSystemPrompts(messages: ChatMessage[]): ChatMessage[] {
  const systemMessages = messages.filter((m) => m.role === 'system');
  if (systemMessages.length <= 1) return messages;

  const lastSystem = systemMessages.at(-1)!;
  return [lastSystem, ...messages.filter((m) => m.role !== 'system')];
}

/** Strips excessive whitespace from text content in every message. */
function normalizeWhitespace(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (typeof msg.content !== 'string') return msg;
    const normalized = msg.content.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return normalized === msg.content ? msg : { ...msg, content: normalized };
  });
}

/**
 * If there are more than MAX_HISTORY_MESSAGES non-system messages,
 * collapses the oldest ones into a single summary message.
 */
function truncateOldHistory(messages: ChatMessage[]): ChatMessage[] {
  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversation = messages.filter((m) => m.role !== 'system');

  if (conversation.length <= MAX_HISTORY_MESSAGES) return messages;

  const excess = conversation.slice(0, conversation.length - MAX_HISTORY_MESSAGES);
  const kept = conversation.slice(conversation.length - MAX_HISTORY_MESSAGES);

  const summaryText = excess
    .map((m) => {
      const text = typeof m.content === 'string' ? m.content : '[media content]';
      return `${m.role}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`;
    })
    .join(' | ');

  const summaryMessage: ChatMessage = {
    role: 'user',
    content: `[Earlier conversation summary: ${summaryText}]`,
  };

  return [...systemMessages, summaryMessage, ...kept];
}
