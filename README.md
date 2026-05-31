# Deep Research Agent

Multi-agent powered deep research assistant built on EdgeOne Makers platform. Features human-in-the-loop sub-question confirmation, real-time web & academic search, iterative report generation with auto-continuation, and project-based version management.

## Features

- **Two-Phase Research** — AI decomposes question → User confirms/edits sub-questions → Full research proceeds
- **Real Web Search** — Built-in `web_search` tool (primary) + Bing/DuckDuckGo via Sandbox (fallback)
- **Real Academic Search** — CrossRef API + Semantic Scholar with structured paper metadata
- **Auto-Continuation** — If model output is cut short, automatically retries up to 15 times to complete the report
- **Structure Check** — Post-generation cleanup removes duplicate sections and fixes formatting
- **Incremental Editing** — Follow-up research preserves existing report structure, only modifies requested sections
- **Project & Version Management** — Create projects, auto-save versions, compare diffs between versions
- **Follow-up Chat** — Conversational interface to discuss report, suggest edits, add sources (persisted to Blob)
- **Paper Management** — AI detects when user mentions new papers and offers to add them to the source list
- **Real-time Streaming** — SSE with progress indicators for each research stage
- **URL Scraping** — Scrape user-provided URLs and integrate content into research
- **i18n** — Chinese and English interface
- **Dark Mode** — Full dark mode support
- **Fixed Sidebar** — Project list stays visible while scrolling main content

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js + React 19 (App Router) |
| Styling | Tailwind CSS |
| Agent Framework | OpenAI Agents SDK (`@openai/agents`) |
| LLM | `@makers/deepseek-v4-flash` (hardcoded) via EdgeOne AI Gateway |
| Platform | EdgeOne Makers (Cloud Functions, Blob Storage, Sandbox, Tools) |
| Web Search | `context.tools.get('web_search')` built-in tool |
| Markdown | react-markdown + remark-gfm (tables, strikethrough) |

## Architecture

```
┌─────────── Frontend (Next.js) ─────────────────────────────┐
│ ResearchForm → depth selection + question input             │
│ SubQuestionConfirm → editable sub-question list (HITL)     │
│ ProgressTree ← stage lifecycle events (collapsible)        │
│ SourcesPanel ← academic/web sources with tabs              │
│ ReportView ← streaming markdown with GFM tables           │
│ FollowUpChat → discuss, suggest edits, add sources         │
│ VersionSelector → browse versions, compare diffs           │
│ ProjectSelector → fixed sidebar, full-height project list  │
└────────────────────────────────────────────────────────────┘

┌─────────── Backend (Cloud Functions) ──────────────────────┐
│ /research  — Main research pipeline (single agent, tools)  │
│   Phase 1: decomposeOnly → return sub-questions for HITL   │
│   Phase 2: confirmedSubQuestions → search + synthesize      │
│   Auto-continuation loop (up to 15 retries)                │
│   Post-generation structure check & cleanup                │
│ /chat     — Follow-up conversation (lightweight agent)     │
│ /project  — Project CRUD + version + chat history (Blob)   │
│ /scrape   — URL content extraction (browser_fetch tool)    │
│ /stop     — Cancel active research run                     │
│ /health   — Health check                                   │
└────────────────────────────────────────────────────────────┘
```

## Research Flow

```
1. User enters question + selects depth (Quick/Standard/Deep)
2. POST /research (decomposeOnly=true) → generates sub-questions
3. Frontend shows SubQuestionConfirm → user edits/confirms
4. POST /research (confirmedSubQuestions=[...]) → full research
5. Agent calls search_literature (CrossRef + Semantic Scholar)
6. Agent calls search_web (web_search tool + fallbacks)
7. Agent writes report (streaming via SSE)
8. Auto-continuation if report incomplete (checks for conclusion + references)
9. Structure check: removes duplicate sections, fixes formatting
10. Frontend saves version to /project → version list updates
11. User can continue research via FollowUpChat (chat persisted to Blob)
```

## EdgeOne Makers Platform Features Used

| Feature | Usage |
|---------|-------|
| `context.tools.get('web_search')` | Built-in web search tool (primary strategy) |
| `context.tools.get('browser_fetch')` | URL scraping with real Chromium |
| `context.sandbox.commands.run()` | Shell commands for curl-based search fallback |
| `@edgeone/pages-blob` | Project storage, version management, chat history |
| Cloud Functions (`agents/` dir) | Each .ts file auto-maps to an HTTP endpoint |
| AI Gateway | LLM access via `@makers/deepseek-v4-flash` |

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your AI Gateway credentials

# Start development
edgeone makes dev

# After modifying agent files, force rebuild:
rm -rf .edgeone/agent-node && edgeone makes dev
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_GATEWAY_API_KEY` | Yes | AI Gateway API key |
| `AI_GATEWAY_BASE_URL` | Yes | AI Gateway base URL |

> Note: `PROJECT_ID` and `EDGEONE_PAGES_API_TOKEN` are auto-injected on deployment. For local dev with Blob persistence, configure them manually in `.env`. Without them, the app still works but projects/chat history won't persist (a warning will be shown).

## Project Structure

```
deep-research-edgeone/
├── agents/
│   ├── _shared.ts        # Model/provider init, SSE helpers, safeFetch, sandbox utils
│   ├── research.ts       # Main research agent (decompose + search + synthesize + continuation + structure check)
│   ├── chat.ts           # Follow-up chat agent (lightweight, no tools)
│   ├── project.ts        # Project CRUD + version management + chat persistence (Blob)
│   ├── scrape.ts         # URL scraping (browser_fetch + safeFetch fallback)
│   ├── stop.ts           # Cancel active research
│   └── health.ts         # Health check
├── app/
│   ├── page.tsx          # Main page (state management, SSE consumer, two-phase flow)
│   ├── layout.tsx
│   ├── globals.css       # Tailwind + prose-research styles (tables, code blocks)
│   └── components/
│       ├── research-form.tsx        # Question input + depth selector
│       ├── sub-question-confirm.tsx # HITL editable sub-question list
│       ├── progress-tree.tsx        # Stage lifecycle + collapsible sub-questions
│       ├── sources-panel.tsx        # Academic/web sources tabs
│       ├── source-card.tsx          # Individual source display
│       ├── report-view.tsx          # Streaming markdown (remark-gfm)
│       ├── follow-up-chat.tsx       # Chat + regenerate + add source + Blob persistence
│       ├── project-selector.tsx     # Fixed sidebar project list
│       ├── version-selector.tsx     # Version history + compare
│       └── diff-view.tsx            # Side-by-side version diff
├── components/ui/         # Shared UI primitives (Card, Button, Tabs, etc.)
├── lib/
│   ├── i18n.tsx          # Chinese/English translations
│   └── utils.ts
├── .env.example
└── package.json
```

## Development Notes

- **Agent rebuild**: Run `rm -rf .edgeone/agent-node && edgeone makes dev` after modifying `agents/` files.
- **Model**: Uses `@makers/deepseek-v4-flash` (hardcoded). This model may stop at ~300 tokens per response — the auto-continuation loop handles this.
- **Web search**: Primary strategy uses built-in `web_search` tool. Falls back to curl Bing/DuckDuckGo, then mock data.
- **Blob unavailable**: When `PROJECT_ID`/`EDGEONE_PAGES_API_TOKEN` are not configured, a warning banner appears. The app remains functional but projects and chat history won't persist.
- **Incremental editing**: Follow-up regeneration sends the full previous report with instructions to only modify requested sections.
- **Structure check**: After report generation, duplicate conclusion/references sections are automatically removed.

## Deployment

```bash
edgeone makes deploy
```

All platform features (Blob, Sandbox, Tools, AI Gateway) are automatically available on deployment.

## License

MIT
