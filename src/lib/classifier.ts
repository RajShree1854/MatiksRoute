import { ChatMessage, ComplexityTier, ProviderName } from '@/providers/types';
import { countMessagesTokens } from '@/lib/tokenizer';

const HARD_KEYWORDS = new Set([
  'algorithm', 'architect', 'refactor', 'optimize', 'compiler', 'theorem',
  'prove', 'system design', 'distributed', 'concurrent', 'parallel', 'scalab',
  'implement from scratch', 'design pattern', 'data structure', 'complexity',
  'big o', 'microservice', 'kubernetes', 'docker', 'binary tree', 'graph',
]);

const MEDIUM_KEYWORDS = new Set([
  'explain', 'summarize', 'compare', 'difference between', 'how does',
  'why does', 'debug', 'fix this', 'review', 'what is', 'help me',
  'step by step', 'example', 'pros and cons',
]);

const TIER_TOKEN_THRESHOLDS = { hard: 500, medium: 100 };

export function classifyComplexity(messages: ChatMessage[]): ComplexityTier {
  const lastUserMessage = messages.filter((m) => m.role === 'user').at(-1);
  if (!lastUserMessage) return 'simple';

  const text =
    typeof lastUserMessage.content === 'string'
      ? lastUserMessage.content
      : lastUserMessage.content
          .filter((p) => p.type === 'text')
          .map((p) => ('text' in p ? p.text : ''))
          .join('');

  const normalized = text.toLowerCase();
  const tokenCount = countMessagesTokens([lastUserMessage]);
  const historyLength = messages.filter((m) => m.role !== 'system').length;

  // Score-based classification
  if (
    tokenCount > TIER_TOKEN_THRESHOLDS.hard ||
    historyLength > 16 ||
    matchesKeywords(normalized, HARD_KEYWORDS)
  ) {
    return 'hard';
  }

  if (
    tokenCount > TIER_TOKEN_THRESHOLDS.medium ||
    historyLength > 6 ||
    matchesKeywords(normalized, MEDIUM_KEYWORDS)
  ) {
    return 'medium';
  }

  return 'simple';
}

function matchesKeywords(text: string, keywords: Set<string>): boolean {
  for (const kw of keywords) {
    if (text.includes(kw)) return true;
  }
  return false;
}

const TIER_PRIMARY: Record<ComplexityTier, ProviderName> = {
  hard:   (process.env.TIER_HARD   as ProviderName) ?? 'openai',
  medium: (process.env.TIER_MEDIUM as ProviderName) ?? 'gemini',
  simple: (process.env.TIER_SIMPLE as ProviderName) ?? 'groq',
};

const ALL_PROVIDERS: ProviderName[] = ['openai', 'gemini', 'groq'];

/**
 * Returns the fallback chain for a given tier.
 * The tier's primary provider is always first; remaining providers follow in env-configured order.
 */
export function getProviderChain(tier: ComplexityTier): ProviderName[] {
  const primary = TIER_PRIMARY[tier];
  const rest = ALL_PROVIDERS.filter((p) => p !== primary);
  return [primary, ...rest];
}

// ── Forced Priority Mode ─────────────────────────────────────────────────────
// When FORCED_PRIORITY=true (default), the complexity classifier is bypassed
// and ALL requests use the fixed PRIORITY_ORDER chain directly.
// Set FORCED_PRIORITY=false to re-enable the smart hard/medium/simple routing.

export const isForcedPriority: boolean =
  (process.env.FORCED_PRIORITY ?? 'true').toLowerCase() !== 'false';

function parsePriorityOrder(): ProviderName[] {
  const raw = process.env.PRIORITY_ORDER ?? 'openai,gemini,groq';
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase() as ProviderName)
    .filter((p): p is ProviderName => ALL_PROVIDERS.includes(p as ProviderName));

  // Ensure all providers are present (append any missing ones at the end)
  const missing = ALL_PROVIDERS.filter((p) => !parsed.includes(p));
  return [...parsed, ...missing];
}

/**
 * Returns the fixed priority chain from PRIORITY_ORDER env var.
 * Used when FORCED_PRIORITY=true — ignores complexity tier entirely.
 */
export function getForcedPriorityChain(): ProviderName[] {
  return parsePriorityOrder();
}
