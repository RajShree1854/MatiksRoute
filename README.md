# MatiksRoute

An intelligent, production-grade AI Gateway that routes chat requests across multiple LLM providers (OpenAI, Gemini, Groq) using smart complexity classification, adaptive concurrency control, multi-strategy compression, headroom-aware combo routing, and real-time observability — all streamed via Server-Sent Events.

---

## How It Works

Every chat message goes through an 8-stage pipeline before reaching an AI model:

```
User Message
    │
    ▼
1. Compress  ──► Multi-strategy (off / lite / auto) prompt compression
    │
    ▼
2. Classify  ──► Skip (FORCED_PRIORITY) OR classify as simple / medium / hard
    │            → buildRoutingStrategy() returns tier + chain + FOBR flag
    ▼
3. Pre-flight ──► Filter providers by: not in cooldown AND under TPM budget
    │            → selectByHeadroom() sorts survivors by least-saturated first
    ▼
4. Trim      ──► Trim context to provider's max context window (32k / 128k / 1M)
    │
    ▼
5. Modality  ──► Strip or resize images based on provider vision support
    │
    ▼
6. Stream    ──► Try each provider in chain; AbortSignal-based mid-stream failover
    │            → Failover Before Retry (FOBR) for instant sibling switching
    ▼
7. Telemetry ──► Record tokens, latency, errors async to SQLite (non-blocking)
    │
    ▼
SSE Stream to Client
```

---

## Features

### 1. Combo Routing with Failover-Before-Retry (FOBR)
A unified `buildRoutingStrategy()` function handles both smart and forced-priority routing modes in a single call, returning the complexity tier, the provider chain, and the `failoverBeforeRetry` flag.

When `FAILOVER_BEFORE_RETRY=true` (default), a single upstream error immediately skips to the next sibling provider in the chain **without waiting for any retry delay** — eliminating the latency cost of retry-then-fallback loops.

- `simple` → Groq (Llama 3, fastest, free)
- `medium` → Gemini (balanced cost/quality)
- `hard` → OpenAI (GPT-4o, most capable)

Disable smart routing with `FORCED_PRIORITY=true` to use a fixed `PRIORITY_ORDER` chain instead.

### 2. Adaptive Admission Controller
Each provider now tracks in-flight request concurrency independently via `admissionController.ts`. A 10-second sliding window measures rejection and completion rates and **automatically scales the per-provider concurrency limit up or down**:

- Rejection rate > 25% → scale down limit by 25%
- Rejection rate < 5% with high saturation → scale up limit by 25%

When `failoverBeforeRetry` is enabled and a provider's concurrency limit is full at dispatch time, the request is **instantly redirected** to the next provider without a network round-trip — no waiting, no timeout, no wasted latency.

### 3. Headroom-Aware Provider Selection
After filtering by TPM budget and cooldown status, surviving providers are sorted by `getHeadroom()` — the fraction of their concurrency limit that is currently free. The least-saturated provider is always dispatched first, distributing load intelligently instead of always hammering the first provider in the chain.

### 4. Multi-Strategy Prompt Compression
Three compression modes controlled by `COMPRESSION_MODE` env var:

| Mode | Behaviour |
|------|-----------|
| `off` | No compression. Passes messages through unchanged. |
| `lite` | Always compresses: merges system prompts, normalizes whitespace, collapses old history into a summarized message with token count. |
| `auto` | Compression triggers only when the request exceeds **2,000 tokens**. Prevents unnecessary processing on short prompts. |

Average token savings: 2–12% depending on history length and prompt verbosity.

### 5. AbortSignal-Based Mid-Stream Failover
When a provider's stream fails mid-response, a dedicated `AbortController` per-attempt cleanly cancels the abandoned upstream connection instead of letting it hang until the 30-second timeout. The relay:

1. Records the count of tokens already streamed before the failure
2. Emits a `mid_stream_failover` SSE event so the client knows a handoff occurred
3. Immediately initializes a fresh stream from the next sibling provider

No partial response is injected into the next provider's context (which caused response duplication artifacts in the prior implementation). The sibling model generates a complete fresh response.

### 6. Circuit Breaker (Proactive Cooldown)
When a provider returns `429 Too Many Requests`, the gateway parses the `Retry-After` header and places the provider in a hard cooldown. Future requests instantly skip the broken provider with zero network calls, eliminating wasted latency.

### 7. Multi-Modal Content Bridge (powered by `sharp`)
Automatically handles vision content based on the routed provider's capabilities:
- Provider **supports vision** → `passed` (forwarded as-is)
- Provider **supports vision** but image is very large → `resized` (downscaled to 512×512)
- Provider **does not support vision** → `stripped` (image removed, text-only request sent)

### 8. Universal SSE Adapter Pattern
OpenAI, Gemini, and Groq each have different streaming response formats. Three custom adapters normalize them all into a single unified SSE format:

```
data: {"type":"meta","tier":"simple","provider":"groq","compressionMode":"auto","failoverBeforeRetry":true}
data: {"type":"token","content":"..."}
data: {"type":"fallback","from":"groq","to":"openai","reason":"provider_error"}
data: {"type":"mid_stream_failover","from":"openai","to":"gemini","tokensStreamedBeforeFailure":42}
data: {"type":"done","provider":"openai","latencyMs":1234,"tokensUsed":512,"fallbackCount":1}
data: [DONE]
```

### 9. Asynchronous Telemetry & Observability
Every request writes a structured log to a local SQLite database (WAL mode). The write is detached from the request lifecycle using `Promise.resolve()`, ensuring disk I/O **never blocks the streaming response**.

Logs include: timestamp, complexity tier, provider attempted, provider succeeded, fallback count, mid-stream failover flag, compression mode, image action, token counts, tokens saved %, latency, and full error strings from provider APIs.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript (strict mode) |
| Styling | Tailwind CSS |
| Streaming | Web Streams API (TransformStream, ReadableStream) |
| Tokenizer | `tiktoken` |
| Image Processing | `sharp` |
| Database | SQLite via `better-sqlite3` (WAL mode) |
| AI Providers | OpenAI (gpt-4o), Google Gemini, Groq (Llama 3) |

---

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── chat/route.ts            # Main SSE streaming endpoint (POST /api/chat)
│   │   ├── logs/route.ts            # Telemetry log viewer (GET /api/logs)
│   │   └── quota/route.ts           # Live provider quota status (GET /api/quota)
│   ├── dashboard/page.tsx           # Real-time observability dashboard
│   └── layout.tsx                   # Root layout
├── components/
│   ├── ChatPanel.tsx                # Chat UI + SSE event consumer
│   └── RouterLogs.tsx               # Router activity feed + provider health cards
├── lib/
│   ├── orchestrator.ts              # Main routing pipeline (the core)
│   ├── classifier.ts                # buildRoutingStrategy() — unified tier + FOBR
│   ├── compressor.ts                # Multi-strategy compression (off/lite/auto)
│   ├── admissionController.ts       # Per-provider adaptive concurrency + headroom
│   ├── db.ts                        # SQLite connection + log queries (WAL mode)
│   ├── modalityBridge.ts            # Image pass/resize/strip logic
│   ├── quotaManager.ts              # Sliding-window TPM + circuit breaker + headroom sort
│   ├── streamRelay.ts               # Resilient multi-provider SSE relay (FOBR + AbortSignal)
│   └── tokenizer.ts                 # Tiktoken token counting + context trimming
└── providers/
    ├── openai.ts                    # OpenAI SSE adapter (AbortSignal-aware)
    ├── gemini.ts                    # Gemini SSE adapter (AbortSignal-aware)
    ├── groq.ts                      # Groq SSE adapter (AbortSignal-aware)
    └── types.ts                     # Shared types (RoutingEvent, RequestLog, etc.)
```

---

## Getting Started

### Prerequisites
- Node.js 18+
- API keys for OpenAI, Google Gemini, and Groq

### 1. Clone and install

```bash
git clone <your-repo-url>
cd matiksroute
npm install
```

### 2. Set up environment variables

```bash
cp .env.local.example .env.local
```

Edit `.env.local` with your real API keys.

### 3. Build and run (production)

```bash
npm run build
npm start
```

Or for development with hot-reload:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the chat interface.  
Open [http://localhost:3000/dashboard](http://localhost:3000/dashboard) for the observability dashboard.

---

## Environment Variables

```env
# API Keys (required)
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AI...
GROQ_API_KEY=gsk_...

# Model Selection (optional, defaults shown)
OPENAI_MODEL=gpt-4o
GEMINI_MODEL=gemini-1.5-flash
GROQ_MODEL=llama-3.3-70b-versatile

# Smart Routing Tier to Provider Mapping
TIER_HARD=openai
TIER_MEDIUM=gemini
TIER_SIMPLE=groq

# Per-Provider Token-Per-Minute Budget
OPENAI_MAX_TPM=200000
GEMINI_MAX_TPM=1000000
GROQ_MAX_TPM=30000

# Priority Mode
# FORCED_PRIORITY=true  - skip complexity classifier, always use PRIORITY_ORDER
# FORCED_PRIORITY=false - use hard/medium/simple smart classifier
FORCED_PRIORITY=true
PRIORITY_ORDER=openai,gemini,groq

# Failover Strategy
# FAILOVER_BEFORE_RETRY=true  - skip immediately to next provider on any error (default)
# FAILOVER_BEFORE_RETRY=false - retry the same provider once before falling over
FAILOVER_BEFORE_RETRY=true

# Compression Mode
# off  - disabled, pass messages through unchanged
# lite - always compress (whitespace + history collapse)
# auto - compress only when request exceeds 2,000 tokens (default)
COMPRESSION_MODE=auto
```

---

## API Endpoints

### `POST /api/chat`
Main chat endpoint. Accepts a JSON body and streams back SSE events.

**Request:**
```json
{
  "messages": [
    { "role": "user", "content": "Hello!" }
  ]
}
```

**Stream Events:**
```
data: {"type":"meta","tier":"simple","provider":"groq","compressionMode":"off","failoverBeforeRetry":true,"hadImages":false}
data: {"type":"token","content":"Hi"}
data: {"type":"token","content":", how can I help?"}
data: {"type":"fallback","from":"groq","to":"openai","reason":"provider_error"}
data: {"type":"done","provider":"openai","latencyMs":812,"tokensUsed":48,"fallbackCount":1}
data: [DONE]
```

### `GET /api/logs?limit=50`
Returns the last N routing events from the SQLite database as clean JSON.

### `GET /api/quota`
Returns the live quota status of all three providers: TPM used, cooldown timer, and total requests.

---

## Known Limitations

- **TPM estimation is approximate**: The pre-flight check estimates token cost as `inputTokens × 3`. Real output token counts are measured from the stream after the fact. If a response is unusually long, a provider could marginally exceed its budget before the next request.
- **In-memory admission state**: Concurrency limits and quota state live in Node.js `global`. They reset on server restart. For multi-instance production deployments, replace with a distributed store like Redis.
- **Image resizing is best-effort**: If `sharp` fails to process an image, the gateway degrades gracefully by stripping the image rather than crashing.
- **Groq does not support vision natively**: Images sent to Groq are automatically stripped by the modality bridge.
- **Mid-stream failover generates a fresh response**: The sibling provider restarts generation from scratch. Tokens already streamed to the client before the failover remain visible, but the continuation is a new response rather than a resumed sentence.
