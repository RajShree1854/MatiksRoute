import { ProviderName } from '@/providers/types';

interface ProviderAdmissionState {
  inFlight: number;
  windowCompletions: number;
  windowRejections: number;
  windowStartMs: number;
  concurrencyLimit: number;
}

const WINDOW_MS = 10_000;
const DEFAULT_CONCURRENCY = 8;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 64;
const SCALE_DOWN_THRESHOLD = 0.25;
const SCALE_UP_THRESHOLD = 0.05;

declare global {
  // eslint-disable-next-line no-var
  var __admissionState: Map<ProviderName, ProviderAdmissionState> | undefined;
}

function getAdmissionState(): Map<ProviderName, ProviderAdmissionState> {
  if (!global.__admissionState) {
    global.__admissionState = new Map();
  }
  return global.__admissionState;
}

function getOrCreate(provider: ProviderName): ProviderAdmissionState {
  const map = getAdmissionState();
  if (!map.has(provider)) {
    map.set(provider, {
      inFlight: 0,
      windowCompletions: 0,
      windowRejections: 0,
      windowStartMs: Date.now(),
      concurrencyLimit: DEFAULT_CONCURRENCY,
    });
  }
  return map.get(provider)!;
}

function rotateWindowIfStale(state: ProviderAdmissionState): void {
  const now = Date.now();
  if (now - state.windowStartMs < WINDOW_MS) return;

  const total = state.windowCompletions + state.windowRejections;
  if (total > 0) {
    const rejectionRate = state.windowRejections / total;

    if (rejectionRate > SCALE_DOWN_THRESHOLD && state.concurrencyLimit > MIN_CONCURRENCY) {
      state.concurrencyLimit = Math.max(MIN_CONCURRENCY, Math.floor(state.concurrencyLimit * 0.75));
    } else if (rejectionRate < SCALE_UP_THRESHOLD && state.inFlight >= state.concurrencyLimit * 0.8) {
      state.concurrencyLimit = Math.min(MAX_CONCURRENCY, Math.ceil(state.concurrencyLimit * 1.25));
    }
  }

  state.windowCompletions = 0;
  state.windowRejections = 0;
  state.windowStartMs = now;
}

export function admitRequest(provider: ProviderName): boolean {
  const state = getOrCreate(provider);
  rotateWindowIfStale(state);

  if (state.inFlight >= state.concurrencyLimit) {
    state.windowRejections++;
    return false;
  }

  state.inFlight++;
  return true;
}

export function releaseRequest(provider: ProviderName, succeeded: boolean): void {
  const state = getOrCreate(provider);
  state.inFlight = Math.max(0, state.inFlight - 1);
  if (succeeded) {
    state.windowCompletions++;
  } else {
    state.windowRejections++;
  }
}

export function getSaturation(provider: ProviderName): number {
  const state = getOrCreate(provider);
  if (state.concurrencyLimit === 0) return 1;
  return state.inFlight / state.concurrencyLimit;
}

export function getHeadroom(provider: ProviderName): number {
  return Math.max(0, 1 - getSaturation(provider));
}
