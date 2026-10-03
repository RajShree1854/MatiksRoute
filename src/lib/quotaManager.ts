import { ProviderName, QuotaStatus } from '@/providers/types';
import { upsertQuotaSnapshot } from '@/lib/db';

interface ProviderQuotaState {
  cooldownUntil: number | null;
  tokensUsedThisMinute: number;
  lastMinuteReset: number;
  totalRequests: number;
}

const PROVIDERS: ProviderName[] = ['openai', 'gemini', 'groq'];

function getMaxTpm(provider: ProviderName): number {
  const envKey = `${provider.toUpperCase()}_MAX_TPM`;
  const val = parseInt(process.env[envKey] ?? '', 10);
  if (Number.isFinite(val) && val > 0) return val;
  const defaults: Record<ProviderName, number> = {
    openai: 200_000,
    gemini: 1_000_000,
    groq: 30_000,
  };
  return defaults[provider];
}

declare global {
  // eslint-disable-next-line no-var
  var __quotaState: Map<ProviderName, ProviderQuotaState> | undefined;
  // eslint-disable-next-line no-var
  var __quotaResetInterval: ReturnType<typeof setInterval> | undefined;
}

function initState(): Map<ProviderName, ProviderQuotaState> {
  const map = new Map<ProviderName, ProviderQuotaState>();
  for (const p of PROVIDERS) {
    map.set(p, { cooldownUntil: null, tokensUsedThisMinute: 0, lastMinuteReset: Date.now(), totalRequests: 0 });
  }
  return map;
}

function getState(): Map<ProviderName, ProviderQuotaState> {
  if (!global.__quotaState) {
    global.__quotaState = initState();
    if (!global.__quotaResetInterval) {
      global.__quotaResetInterval = setInterval(() => {
        if (!global.__quotaState) return;
        for (const [, state] of global.__quotaState) {
          state.tokensUsedThisMinute = 0;
          state.lastMinuteReset = Date.now();
        }
      }, 60_000);
    }
  }
  return global.__quotaState;
}

/** Returns true only if the provider is not in cooldown. */
export function isProviderAvailable(provider: ProviderName): boolean {
  const state = getState().get(provider);
  if (!state) return false;
  // Clear expired cooldown
  if (state.cooldownUntil !== null && Date.now() >= state.cooldownUntil) {
    state.cooldownUntil = null;
  }
  return state.cooldownUntil === null;
}

/**
 * Pre-flight check: returns true only if the provider has enough remaining
 * TPM budget to handle a request of `estimatedTokens` tokens.
 * If the budget would be exceeded, the provider is placed in cooldown immediately
 * so it is skipped cleanly and other providers are tried.
 */
export function hasCapacityFor(provider: ProviderName, estimatedTokens: number): boolean {
  const state = getState().get(provider);
  if (!state) return false;
  const maxTpm = getMaxTpm(provider);
  if (state.tokensUsedThisMinute + estimatedTokens > maxTpm) {
    // Put provider in cooldown until the current minute window resets
    state.cooldownUntil = state.lastMinuteReset + 60_000;
    persistSnapshot(provider, state);
    return false;
  }
  return true;
}

export function recordRateLimit(provider: ProviderName, retryAfterSeconds: number): void {
  const state = getState().get(provider);
  if (!state) return;
  state.cooldownUntil = Date.now() + retryAfterSeconds * 1_000;
  persistSnapshot(provider, state);
}

/**
 * Record actual token consumption against the provider that SERVED the request.
 * Must be called with the real succeeded provider, not the originally targeted one.
 */
export function recordUsage(provider: ProviderName, tokens: number): void {
  const state = getState().get(provider);
  if (!state) return;
  state.tokensUsedThisMinute += tokens;
  state.totalRequests += 1;
  // If recording this usage now exceeds the budget, schedule a cooldown
  if (state.tokensUsedThisMinute >= getMaxTpm(provider)) {
    state.cooldownUntil = state.lastMinuteReset + 60_000;
  }
  persistSnapshot(provider, state);
}

export function getAllQuotaStatuses(): QuotaStatus[] {
  return PROVIDERS.map((provider) => {
    const state = getState().get(provider) ?? {
      cooldownUntil: null,
      tokensUsedThisMinute: 0,
      totalRequests: 0,
    };
    // Clear expired cooldown before reporting
    if (state.cooldownUntil !== null && Date.now() >= state.cooldownUntil) {
      state.cooldownUntil = null;
    }
    return {
      provider,
      available: isProviderAvailable(provider),
      cooldownUntil: state.cooldownUntil,
      tokensUsedThisMinute: state.tokensUsedThisMinute,
      totalRequests: state.totalRequests,
    };
  });
}

function persistSnapshot(provider: ProviderName, state: ProviderQuotaState): void {
  try {
    upsertQuotaSnapshot({
      provider,
      available: isProviderAvailable(provider),
      cooldownUntil: state.cooldownUntil,
      tokensUsedThisMinute: state.tokensUsedThisMinute,
      totalRequests: state.totalRequests,
    });
  } catch {
    // Non-critical
  }
}
