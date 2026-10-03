# MatiksRoute 

An intelligent, production-grade AI Gateway that routes chat requests across multiple LLM providers (OpenAI, Gemini, Groq) using smart complexity classification, circuit-breaking, quota management, and real-time observability — all streamed via Server-Sent Events.

---

## How It Works

Every chat message goes through an 8-stage pipeline before reaching an AI model:

```
User Message
    │
    ▼
1. Compress  ──► Strip whitespace, trim chat history to token budget
    │
    ▼
2. Classify  ──► Skip (FORCED_PRIORITY) OR classify as simple / medium / hard
    │
    ▼
3. Pre-flight ──► Filter providers by: not in cooldown AND under TPM budget
    │
    ▼
4. Trim      ──► Trim context to provider's max context window (32k / 128k / 1M)
    │
    ▼
5. Modality  ──► Strip or resize images based on provider vision support
    │
    ▼
6. Stream    ──► Try each provider in chain; mid-stream failover on disconnect
    │
    ▼
7. Telemetry ──► Record tokens, latency, errors async to SQLite (non-blocking)
    │
    ▼
SSE Stream to Client
```

---

## Features

### 1. Smart Complexity Classifier
Analyzes token count, keyword signals, and conversation history length to classify each request as `simple`, `medium`, or `hard`. Each tier routes to a different primary provider.

- `simple` → Groq (Llama 3, fastest, free)
- `medium` → Gemini (balanced cost/quality)
- `hard` → OpenAI (GPT-4o, most capable)

Disable with `FORCED_PRIORITY=true` to use a fixed priority order instead.

### 2. Circuit Breaker (Proactive Cooldown)
When a provider returns a `429 Too Many Requests` or quota error, the gateway parses the `Retry-After` header and places that provider in a **hard cooldown penalty box**. Future requests instantly skip the broken provider without making any network calls, eliminating wasted latency.

### 3. Multi-Tier Fallback & Mid-Stream Failover
The provider chain is tried in sequence. If a provider fails:
- **Pre-stream failure** (network error, 4xx before any tokens): silently skip to the next provider.
- **Mid-stream failure** (connection dropped during streaming): the partial response is injected back into context, the next provider is invoked to continue the sentence, and the client never sees a gap.

### 4. Sliding-Window TPM Quota Management
Each provider has a configurable `MAX_TPM` (Tokens Per Minute) budget enforced on a rolling 60-second window. Before routing any request, a **pre-flight capacity check** estimates the token cost (`input x 3`). If a provider would exceed its budget, it is immediately skipped and put in cooldown — preventing overspending before any API call is made.

### 5. Multi-Modal Content Bridge (powered by `sharp`)
Automatically handles vision content based on the routed provider's capabilities:
- Provider **supports vision** → `passed` (forwarded as-is)
- Provider **supports vision** but image is very large → `resized` (downscaled to 512x512 to save vision tokens)
- Provider **does not support vision** → `stripped` (image removed, text-only request sent to prevent a 400 crash)

### 6. Prompt Compression
Before any request is sent, the gateway:
1. Aggressively minifies repeated whitespace and characters in the prompt.
2. Trims the full chat history using `tiktoken` to fit within the provider's context window.

Average token savings: 2-6%.

### 7. Universal SSE Adapter Pattern
OpenAI, Gemini, and Groq each have completely different streaming response formats. Three custom adapters normalize them all into a single unified SSE format:

```
data: {"type":"token","content":"..."}
data: {"type":"fallback","from":"gemini","to":"openai","reason":"provider_error"}
data: {"type":"done","provider":"openai","latencyMs":1234,"tokensUsed":512}
```

The frontend only consumes one interface regardless of which AI is running.

### 8. Asynchronous Telemetry & Observability
Every request writes a structured log to a local SQLite database (WAL mode). The write is detached from the request lifecycle using `Promise.resolve()`, meaning disk I/O **never blocks the streaming response**.

Logs include: timestamp, complexity tier, provider attempted, provider succeeded, fallback count, mid-stream failover flag, image action, token counts, tokens saved %, latency, and full error strings from provider APIs.

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
│   │   ├── chat/route.ts       # Main SSE streaming endpoint (POST /api/chat)
│   │   ├── logs/route.ts       # Telemetry log viewer (GET /api/logs)
│   │   └── quota/route.ts      # Live provider quota status (GET /api/quota)
│   ├── dashboard/page.tsx      # Real-time observability dashboard
│   └── layout.tsx              # Root layout
├── components/
│   ├── ChatPanel.tsx           # Chat UI + SSE event consumer
│   └── RouterLogs.tsx          # Router activity feed + provider health cards
├── lib/
│   ├── orchestrator.ts         # Main routing pipeline (the core)
│   ├── classifier.ts           # Complexity classifier + forced priority chain
│   ├── compressor.ts           # Prompt compression pipeline
│   ├── db.ts                   # SQLite connection + log queries (WAL mode)
│   ├── modalityBridge.ts       # Image pass/resize/strip logic
│   ├── quotaManager.ts         # Sliding-window TPM + circuit breaker state
│   ├── streamRelay.ts          # Resilient multi-provider SSE relay
│   └── tokenizer.ts            # Tiktoken token counting + context trimming
└── providers/
    ├── openai.ts               # OpenAI SSE adapter
    ├── gemini.ts               # Gemini SSE adapter
    ├── groq.ts                 # Groq SSE adapter
    └── types.ts                # Shared types (RoutingEvent, RequestLog, etc.)
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

Copy `.env.local.example` to `.env.local` and fill in your values.

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
# Set GROQ_MAX_TPM to a small value (e.g. 200) to demo quota fallback live
OPENAI_MAX_TPM=200000
GEMINI_MAX_TPM=1000000
GROQ_MAX_TPM=30000

# Priority Mode
# FORCED_PRIORITY=true  - skip complexity classifier, always use PRIORITY_ORDER
# FORCED_PRIORITY=false - use hard/medium/simple smart classifier
FORCED_PRIORITY=true
PRIORITY_ORDER=openai,gemini,groq
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
data: {"type":"meta","tier":"simple","provider":"groq","hadImages":false}
data: {"type":"token","content":"Hi"}
data: {"type":"token","content":", how can I help?"}
data: {"type":"fallback","from":"groq","to":"openai","reason":"provider_error"}
data: {"type":"done","provider":"openai","latencyMs":812,"tokensUsed":48,"fallbackCount":1}
data: [DONE]
```

### `GET /api/logs?limit=50`
Returns the last N routing events from the SQLite database with clean JSON. Null and default fields are omitted automatically.

### `GET /api/quota`
Returns the live quota status of all three providers: TPM used, cooldown timer, and total requests.

---

## Known Limitations

- **TPM estimation is approximate**: The pre-flight check estimates token cost as `inputTokens x 3`. Real output token counts are measured from the stream after the fact. If a response is unusually long, a provider could marginally exceed its budget before the next request.
- **In-memory quota state**: Quota state lives in Node.js `global`. It resets on server restart. For multi-instance production deployments, replace with a distributed store like Redis.
- **Image resizing is best-effort**: If `sharp` fails to process an image, the gateway degrades gracefully by stripping the image rather than crashing.
- **Groq does not support vision natively**: Images sent to Groq are automatically stripped by the modality bridge.
- **Free-tier Gemini has a hard daily limit**: On the free tier, Gemini allows around 20 requests/day. The circuit breaker will catch the `429` and reroute to the next provider automatically.
