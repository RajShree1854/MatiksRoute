import { get_encoding, Tiktoken } from 'tiktoken';
import { ChatMessage } from '@/providers/types';

declare global {
  // eslint-disable-next-line no-var
  var __tiktoken: Tiktoken | undefined;
}

function getEncoder(): Tiktoken {
  if (!global.__tiktoken) global.__tiktoken = get_encoding('cl100k_base');
  return global.__tiktoken;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  return getEncoder().encode(text).length;
}

export function countMessagesTokens(messages: ChatMessage[]): number {
  // 4 tokens per message overhead (role tag, separators)
  return messages.reduce((total, msg) => {
    const text = typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((p) => p.type === 'text')
          .map((p) => ('text' in p ? p.text : ''))
          .join('');
    return total + countTokens(text) + 4;
  }, 0);
}

/**
 * Trims the oldest non-system messages until the token count fits within maxTokens.
 * System messages are always preserved.
 */
export function trimMessagesToTokenBudget(
  messages: ChatMessage[],
  maxTokens: number,
): ChatMessage[] {
  if (countMessagesTokens(messages) <= maxTokens) return messages;

  const systemMessages = messages.filter((m) => m.role === 'system');
  let conversationMessages = messages.filter((m) => m.role !== 'system');

  while (
    conversationMessages.length > 1 &&
    countMessagesTokens([...systemMessages, ...conversationMessages]) > maxTokens
  ) {
    // Remove the oldest non-system message
    conversationMessages = conversationMessages.slice(1);
  }

  return [...systemMessages, ...conversationMessages];
}
