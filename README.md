# Deep Research Agent

Multi-agent powered deep research assistant with human-in-the-loop approval, parallel sub-agent invocation, and persistent memory. Built on EdgeOne Pages platform with deepagents framework integration.

## Features

- **Multi-Stage Research Pipeline** — Decompose → Search (parallel) → Synthesize
- **Real Web Search** — DuckDuckGo HTML search via Sandbox or runtime fetch
- **Real Academic Search** — CrossRef API + Semantic Scholar with structured paper data
- **Sandbox Integration** — Remote code execution via `context.sandbox.commands.run()`
- **Human-in-the-Loop** — AI generates sub-questions, user reviews and edits before proceeding
- **Parallel Sub-Agent Invocation** — Literature and web search run simultaneously via `context.agents.invoke()`
- **Persistent Memory** — Conversation history saved via EdgeOne Pages Memory API
- **Research Archive** — Completed reports stored in Blob storage for later retrieval
- **Research History** — Browse and reload past research reports
- **Depth Control** — Quick (2-3 min), Standard (5-7 min), Deep (10+ min)
- **Real-time Streaming** — SSE with progress indicators and stage lifecycle events
- **i18n** — Chinese and English interface
- **Graceful Fallback** — Sandbox → runtime fetch → mock data (3-layer fault tolerance)

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Frontend | Next.js 16 + React 19 | App Router, Turbopack |
| Styling | Tailwind CSS 3.4 | Dark mode support |
| Agent Framework | deepagents 1.9+ | Used in `/search` endpoint with tool calling + middleware |
| LLM Integration | LangChain.js (`@langchain/openai`) | ChatOpenAI for sub-agents |
| Platform | EdgeOne Pages | Cloud Functions, Memory API, Blob Storage, Sandbox, Agent Invoke |
| Language | TypeScript 5.6 | ESM modules |

## Architecture

```
┌─────────── Frontend ──────────────────────────────────────┐
│ ResearchForm → POST /research (SSE)                       │
│ ApprovalCard → POST /approve → POST /research (resume)    │
│ ProgressTree ← subagent_lifecycle events                  │
│ SourcesPanel ← parsed from stage completions              │
│ ReportView   ← ai_response stream from synthesizer       │
└───────────────────────────────────────────────────────────┘

┌─────────── Orchestrator (/research) ─────────────────────┐
│ context.agents.invoke('/decompose')                       │
│   → HITL pause (emit hitl_request, wait for /approve)    │
│ Promise.all([                                            │
│   context.agents.invoke('/search-lit'),                   │
│   context.agents.invoke('/search-web'),                   │
│ ])                                                        │
│ context.agents.invoke('/synthesize')                      │
│ context.store.appendMessage() → Memory                    │
│ blobStore.setJSON() → Archive                            │
└───────────────────────────────────────────────────────────┘

┌─────────── Sub-Agents ────────────────────────────────────┐
│ /decompose   — Breaks question into sub-questions         │
│ /search-lit  — Real academic search (CrossRef + Semantic Scholar) │
│ /search-web  — Real web search (DuckDuckGo via Sandbox/fetch)    │
│ /synthesize  — Compiles full research report              │
│ /search      — Standalone deepagents search (tool calling)│
│ /approve     — HITL approval endpoint                     │
│ /history     — Research history CRUD (Blob)               │
│ /stop        — Cancel active research                     │
│ /health      — Health check                               │
└───────────────────────────────────────────────────────────┘
```

## EdgeOne Pages Platform Features Used

| Feature | Usage |
|---------|-------|
| `context.agents.invoke()` | Orchestrator calls 4 sub-agents (decompose, search-lit, search-web, synthesize) |
| `Promise.all` + `agents.invoke` | Parallel execution of literature + web search |
| `context.sandbox.commands.run()` | Execute shell commands (curl) in remote sandbox for web scraping |
| `context.store` (Memory API) | Save user questions and AI reports to conversation history |
| `context.conversation_id` | Automatic session association across requests |
| `@edgeone/pages-blob` | Archive completed research reports for later retrieval |
| `context.tracer` | Observability spans (when available) |
| `context.utils.abortActiveRun()` | Graceful cancellation via /stop endpoint |
| Cloud Functions (`agents/` dir) | Each .ts file auto-maps to an HTTP endpoint |

## deepagents Features Used

| Feature | Location | Purpose |
|---------|----------|---------|
| `createDeepAgent()` | `/search` | Autonomous agent with tool selection |
| Tool Calling (Zod) | `/search` | `search_academic`, `search_web`, `synthesize` tools |
| `modelRetryMiddleware` | `/search` | Auto-retry on model failures (max 3) |
| `modelCallLimitMiddleware` | `/search` | Prevent infinite loops (max 30 rounds) |
| `toolRetryMiddleware` | `/search` | Retry failed tools (max 2) |
| `toolCallLimitMiddleware` | `/search` | Per-tool call limits (max 10 each) |
| `streamMode: 'messages'` | `/search` | Stream tool events + AI responses |

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your AI Gateway credentials

# Start development (requires EdgeOne CLI)
edgeone dev

# IMPORTANT: After modifying agent files, force rebuild:
rm -rf .edgeone/agent-node && edgeone dev
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_GATEWAY_API_KEY` | Yes | AI Gateway API key |
| `AI_GATEWAY_BASE_URL` | Yes | AI Gateway base URL |
| `AI_MODEL` | No | Model name (default: `@Pages/deepseek-v4-flash`) |
| `PROJECT_ID` | No | Pages project ID for Blob/Sandbox (auto-injected on EdgeOne Pages) |
| `EDGEONE_PAGES_API_TOKEN` | No | API token for Blob/Sandbox access (auto-injected on EdgeOne Pages) |
| `SANDBOX_API_BASE` | No | Sandbox API endpoint (default: auto-resolved by platform) |

## Research Flow

```
1. User enters research question + selects depth
2. POST /research → Orchestrator starts
3. agents.invoke('/decompose') → generates sub-questions
4. SSE: hitl_request → Frontend shows ApprovalCard
5. User edits sub-questions → POST /approve
6. POST /research (resume) → continues with approved questions
7. Promise.all([agents.invoke('/search-lit'), agents.invoke('/search-web')])
8. agents.invoke('/synthesize') → generates markdown report
9. Report streamed via SSE → rendered in ReportView
10. Report saved to Memory + archived to Blob
```

## Project Structure

```
deep-research-edgeone/
├── agents/
│   ├── _shared.ts        # Model init, logger, SSE helpers, Sandbox utils
│   ├── research.ts       # Orchestrator — agents.invoke + Memory + Blob
│   ├── decompose.ts      # Sub-agent: question decomposition
│   ├── search-lit.ts     # Sub-agent: academic search (CrossRef + Semantic Scholar)
│   ├── search-web.ts     # Sub-agent: web search (DuckDuckGo + Sandbox)
│   ├── synthesize.ts     # Sub-agent: report compilation
│   ├── search.ts         # Standalone deepagents search (tool calling demo)
│   ├── approve.ts        # HITL approval endpoint
│   ├── history.ts        # Research history CRUD (Blob)
│   ├── stop.ts           # Cancel active research
│   ├── health.ts         # Health check
│   └── test.ts           # Model connectivity test
├── app/
│   ├── page.tsx          # Main page (SSE consumer, HITL, history)
│   ├── layout.tsx
│   ├── globals.css
│   └── components/
│       ├── research-form.tsx    # Input + depth + history dropdown
│       ├── approval-card.tsx    # HITL sub-question editor
│       ├── progress-tree.tsx    # Stage lifecycle visualization
│       ├── sources-panel.tsx    # Academic/web sources tabs
│       ├── source-card.tsx      # Individual source display
│       └── report-view.tsx      # Markdown report rendering
├── components/ui/         # Shared UI primitives
├── lib/
│   ├── i18n.tsx          # Chinese/English translations
│   └── utils.ts
├── edgeone.json          # EdgeOne deployment config
├── .env.example          # Environment variable template
└── package.json
```

## Development Notes

- **Agent rebuild**: EdgeOne CLI may not hot-reload agent changes reliably. Always run `rm -rf .edgeone/agent-node && edgeone pages dev -t <TOKEN>` after modifying files in `agents/`.
- **Sandbox**: Requires `@edgeone/pages-agent-toolkit` in `.edgeone/agent-node/node_modules/`. In local dev, sandbox may fail to acquire (WAF/network); search agents gracefully fallback to runtime fetch.
- **Blob storage**: Works with `PROJECT_ID` + `EDGEONE_PAGES_API_TOKEN` configured in `.env`, or auto-injected on deployment.
- **Memory API**: Requires EdgeOne Pages runtime. Falls back gracefully in local dev.
- **Model choice**: `@Pages/deepseek-v4-flash` recommended for speed. Avoid `@Pages/glm-5.1` (slow, may timeout).
- **No `temperature` param**: Some models (kimi-k2.6) only allow temperature=1. Omitted for compatibility.
- **Search fallback**: Sandbox curl → runtime fetch → mock data. Real search works in both local dev (via fetch) and deployed (via sandbox).

## Deployment

```bash
edgeone deploy
```

Once deployed, all platform features (Memory, Blob, Agent Invoke, Tracer) are automatically available without additional configuration.

## License

MIT
