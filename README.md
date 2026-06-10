# Deep Research

**Language:** English | [简体中文](./README_zh-CN.md)

Multi-agent deep research assistant with human-in-the-loop sub-question confirmation, academic and web search, iterative report generation, and project-based version management. Built on the OpenAI Agents SDK and deployed on EdgeOne Makers.

**Framework:** None (raw Node.js) · **Category:** Orchestration · **Language:** TypeScript

[![Deploy to EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/makers/new?template=deep-research-agent&from=within&fromAgent=1&agentLang=typescript)

<!-- TODO: confirm -->
![preview](./assets/preview.png)

## Overview

This template automates rigorous, citation-backed research reports. It decomposes a research question into sub-questions for user confirmation, searches academic databases and the live web, synthesizes findings into a structured markdown report, and supports follow-up edits with full version history. An auto-continuation loop ensures reports are complete even when model outputs are truncated.

- **Human-in-the-Loop Planning** — AI decomposes the question into sub-questions; the user reviews, edits, and confirms before research proceeds.
- **Dual-Source Search** — Queries CrossRef + Semantic Scholar for academic papers and uses live web search for news and articles.
- **Auto-Continuation** — Detects incomplete reports (missing conclusion or references) and automatically continues writing up to 15 times.
- **Incremental Editing** — Follow-up research loads the previous report and modifies only the requested sections, preserving existing structure.
- **Project & Version Management** — Research projects, report versions, and follow-up chat history are persisted to Blob storage.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_GATEWAY_API_KEY` | Yes | Model gateway API key. Use your Makers Models API Key, or any OpenAI-compatible provider key. |
| `AI_GATEWAY_BASE_URL` | Yes | Gateway base URL. For Makers Models, use `https://ai-gateway.edgeone.link/v1`. |
| `WSA_API_KEY` | Yes | Tencent Cloud Web Search API key — required by the built-in `web_search` tool used during research. Without it, web search falls back to a less reliable scraping path. |

This template follows the OpenAI-compatible standard — point these at Makers Models or any compatible provider.

### How to get WSA_API_KEY

1. Open the Tencent Cloud Web Search API console (https://console.cloud.tencent.com/wsapi/index)
2. Overview → "Service API KEY" → Create API KEY, then copy it immediately (it cannot be viewed again later)
3. Copy it into `WSA_API_KEY` in your project environment variables


### How to get AI_GATEWAY_API_KEY

1. Open the Makers Console (https://console.cloud.tencent.com/edgeone/makers)
2. Sign in and enable Makers
3. Go to Makers → Models → API Key and create a key
4. Copy it into `AI_GATEWAY_API_KEY`

> Built-in models are free within quota and great for validation. For production, bind your own paid provider key (BYOK).

## Local Development

**Prerequisites**
- Node.js 18+
- EdgeOne CLI (`npm i -g @edgeone/cli`)

```bash
npm install
cp .env.example .env
# Edit .env with your AI_GATEWAY_API_KEY and AI_GATEWAY_BASE_URL
edgeone makers dev
```

Open the local observability dashboard at http://localhost:8080/agent-metrics.

## Project Structure

```
deep-research-agent/
├── agents/
│   ├── _shared.ts          # Model/provider init, SSE helpers, safeFetch, sandbox utils
│   ├── _tools.ts           # Tool factories (decompose, literature, web, scrape)
│   ├── _prompts.ts         # System prompt builder + ResearchOptions
│   ├── _sources.ts         # Paper / Article types + academic API parsers
│   ├── _web-search.ts      # Multi-engine fallback search
│   ├── _project-store.ts   # Version persistence helpers
│   ├── _follow-up.ts       # Follow-up edit stream (no-search path)
│   ├── _report-cleanup.ts  # Post-generation structure cleanup
│   ├── research.ts         # POST /research — main research pipeline
│   ├── chat.ts             # POST /chat — follow-up conversation
│   ├── scrape.ts           # POST /scrape — URL content extraction
│   └── stop.ts             # POST /stop — cancel active research
├── cloud-functions/
│   ├── project/            # POST /project — project CRUD + versions
│   ├── enrich-doi/         # POST /enrich-doi — DOI metadata enrichment
│   └── health/             # GET /health
├── app/                    # Next.js App Router frontend
├── components/             # UI components (report view, chat, version diff, etc.)
├── lib/
│   ├── i18n.tsx            # Chinese / English translations
│   └── utils.ts
└── edgeone.json            # EdgeOne deployment config
```

Files prefixed with `_` are private modules — not exposed as public routes.

## How It Works

### Runtime Mode
Files under `agents/` run in **session mode**: requests with the same `conversation_id` are sticky-routed to the same agent instance. The `/research` agent uses `context.store.openaiSession(conversationId)` to persist conversation history across turns.

### End-to-End Workflow

1. **Question entry** — The user enters a research question and selects depth (`quick`, `standard`, or `deep`).
2. **Sub-question decomposition** — The frontend calls `/research` with `decomposeOnly=true`. A dedicated sub-agent generates focused sub-questions.
3. **Human confirmation** — The frontend displays editable sub-questions; the user confirms or modifies them.
4. **Full research** — The frontend calls `/research` again with `confirmedSubQuestions`. The main agent executes:
   - `decompose_question` — formalizes the sub-question list.
   - `search_literature` — queries CrossRef and Semantic Scholar for academic papers.
   - `search_web` — uses the built-in `web_search` tool (with sandbox curl fallback).
   - `scrape_urls` — extracts content from user-provided URLs when supplied.
5. **Synthesis** — After all tool outputs are collected, the synthesizer writes the report in streaming markdown via SSE.
6. **Auto-continuation** — If the report lacks a conclusion or references section, a continuation agent picks up where the output left off (up to 15 retries).
7. **Structure cleanup** — Duplicate sections, leaked reasoning tags, and formatting issues are automatically removed.
8. **Persistence** — The final report, sources, and metadata are saved to Blob via `context.store` (or the `/project` cloud function as fallback).
9. **Follow-up chat** — The user discusses the report via `/chat`; when modifications are agreed, the frontend triggers a follow-up research run that edits the existing report in place.

### Key Routes & Parameters
- `/research` — Body: `{ message/question, depth, projectId, urls, confirmedSubQuestions, decomposeOnly, locale, citationStyle }`.
- `/chat` — Body: `{ message, chatHistory, report }`. Lightweight conversational endpoint with no search tools.
- `/scrape` — Body: `{ urls }`. Extracts content from URLs using `browser_fetch` or sandbox curl.
- `/project` — Body varies by action. Handles project CRUD, version listing, and chat history persistence.
- `/stop` — Body: `{ conversationId }`. Cancels the active research run.

### Timeouts
- `agents.timeout`: 300 seconds

## Resources

- [Makers Agents Documentation](https://edgeone.ai/makers)
- [Makers Quick Start](https://edgeone.ai/makers/docs/quickstart)
- [Makers Models](https://console.cloud.tencent.com/edgeone/makers/models)

## License

MIT
