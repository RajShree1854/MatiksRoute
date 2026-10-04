export type ProviderName = 'openai' | 'gemini' | 'groq';
export type ComplexityTier = 'simple' | 'medium' | 'hard';
export type ImageAction = 'passed' | 'resized' | 'stripped' | 'none';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImageUrlPart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export type ContentPart = TextPart | ImageUrlPart;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface RoutingEvent {
  type: 'meta' | 'token' | 'fallback' | 'mid_stream_failover' | 'done' | 'error' | 'tool_call_started';
}

export interface MetaEvent extends RoutingEvent {
  type: 'meta';
  tier: ComplexityTier;
  provider: ProviderName;
  hadImages: boolean;
  imageAction: ImageAction;
  originalTokens: number;
  compressedTokens: number;
  compressionMode: string;
  failoverBeforeRetry: boolean;
}


export interface TokenEvent extends RoutingEvent {
  type: 'token';
  content: string;
}

export interface FallbackEvent extends RoutingEvent {
  type: 'fallback';
  from: ProviderName;
  to: ProviderName;
  reason: string;
}

export interface MidStreamFailoverEvent extends RoutingEvent {
  type: 'mid_stream_failover';
  from: ProviderName;
  to: ProviderName;
  tokensStreamedBeforeFailure: number;
}

export interface DoneEvent extends RoutingEvent {
  type: 'done';
  provider: ProviderName;
  latencyMs: number;
  tokensUsed: number;
  fallbackCount: number;
  midStreamFailover: boolean;
}

export interface ErrorEvent extends RoutingEvent {
  type: 'error';
  message: string;
}

export interface ToolCallStartedEvent extends RoutingEvent {
  type: 'tool_call_started';
}

export type AnyRoutingEvent =
  | MetaEvent
  | TokenEvent
  | FallbackEvent
  | MidStreamFailoverEvent
  | DoneEvent
  | ErrorEvent
  | ToolCallStartedEvent;

export interface AIProvider {
  readonly name: ProviderName;
  readonly supportsVision: boolean;
  isAvailable(): boolean;
  streamChat(messages: ChatMessage[], signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

export interface QuotaStatus {
  provider: ProviderName;
  available: boolean;
  cooldownUntil: number | null;
  tokensUsedThisMinute: number;
  totalRequests: number;
}

export interface RequestLog {
  id?: number;
  timestamp: string;
  complexityTier: ComplexityTier;
  smartRouteTarget: ProviderName;
  providerAttempted: string;
  providerSucceeded: ProviderName | null;
  fallbackTriggered: boolean;
  midStreamFailover: boolean;
  hadImages: boolean;
  imageAction: ImageAction;
  originalTokens: number;
  compressedTokens: number;
  tokensSavedPct: number;
  latencyMs: number;
  errorReason: string | null;
}
