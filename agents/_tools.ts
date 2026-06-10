/**
 * Tool factories for the deep-research agent.
 *
 * Each builder closes over the request's `context` so the tool's execute()
 * never reads from a module-level variable — that pattern was racy when
 * the runtime ran multiple invocations in the same process. Construct a
 * fresh tool instance per request via `buildResearchTools(context)`.
 */
import { z } from 'zod';
import { tool, createLogger, safeFetch } from './_shared';
import {
  parseCrossRefResponse,
  parseSemanticScholarResponse,
  type Paper,
  type Article,
} from './_sources';

const logger = createLogger('tools');

/** Parse a JSON string, returning null on failure (never throws). */
function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Shared citation registry for a single research request. search_literature
 * fills `papers` first (numbered 1..P), then search_web fills `articles`
 * (numbered P+1..N). Both tools return each source's assigned citationNumber
 * to the model so it can cite ONLY these exact numbers — eliminating the
 * drift between the model's invented numbering and the canonical source list.
 */
export interface CitationRegistry {
  papers: Paper[];
  articles: Article[];
}

export function createCitationRegistry(): CitationRegistry {
  return { papers: [], articles: [] };
}

// ─── decompose_question ──────────────────────────────────────────────────────

export const buildDecomposeQuestion = () => tool({
  name: 'decompose_question',
  description: 'Break a research question into focused sub-questions. You (the agent) should generate the sub-questions yourself based on the question and depth. Return them as a JSON string with a subQuestions array.',
  parameters: z.object({
    question: z.string().describe('The main research question'),
    depth: z.enum(['quick', 'standard', 'deep']).describe('Research depth: quick (2-3 sub-questions), standard (3-5), deep (5-7)'),
    subQuestions: z.array(z.string()).describe('The sub-questions YOU generated. Cover: background, current state, challenges, future directions. Write in same language as question.'),
  }),
  execute: async ({ question, subQuestions }) => {
    // The agent generates sub-questions via the parameters — no extra LLM call needed
    if (Array.isArray(subQuestions) && subQuestions.length > 0) {
      return JSON.stringify({ subQuestions });
    }
    // Fallback
    return JSON.stringify({
      subQuestions: [
        `What is the current state of "${question}"?`,
        `What are the main challenges in "${question}"?`,
        `What are the future directions for "${question}"?`,
      ],
    });
  },
});

// ─── search_literature ───────────────────────────────────────────────────────

export const buildSearchLiterature = (context: any, registry: CitationRegistry) => tool({
  name: 'search_literature',
  description: 'Search academic databases (CrossRef + Semantic Scholar) for relevant papers. Call this ONCE with a combined query from the sub-questions. Returns JSON with papers array — each paper carries a "citationNumber" you MUST use for its inline [n] citations.',
  parameters: z.object({
    query: z.string().describe('Search query for academic papers (combine key terms from sub-questions)'),
  }),
  execute: async ({ query }) => {
    let papers: Paper[] = [];

    // 1) Try CrossRef
    const crossRefUrl = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=8&select=title,author,container-title,published,DOI,abstract`;
    const crossRefResponse = await safeFetch(context, crossRefUrl, {
      timeout: 8_000,
      headers: { 'User-Agent': 'DeepResearch/1.0 (mailto:research@edgeone.ai)' },
    });
    if (crossRefResponse) {
      papers = parseCrossRefResponse(crossRefResponse);
      logger.log(`CrossRef returned ${papers.length} papers`);
    }

    // 2) Supplement with Semantic Scholar if < 3
    if (papers.length < 3) {
      const ssUrl = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=8&fields=title,authors,year,venue,abstract,externalIds,publicationVenue`;
      const ssResponse = await safeFetch(context, ssUrl, { timeout: 8_000 });
      if (ssResponse) {
        const ssPapers = parseSemanticScholarResponse(ssResponse);
        logger.log(`Semantic Scholar returned ${ssPapers.length} papers`);
        const existingDois = new Set(papers.map(p => p.doi).filter(Boolean));
        for (const paper of ssPapers) {
          if (!paper.doi || !existingDois.has(paper.doi)) {
            papers.push(paper);
            if (paper.doi) existingDois.add(paper.doi);
          }
        }
      }
    }

    // 3) Report no results — do not fabricate fake papers
    if (papers.length === 0) {
      logger.log('No real academic results found for query');
      return JSON.stringify({
        papers: [],
        _note: 'No academic papers found for this query. Do NOT invent or fabricate citations. Report that no verified academic sources were found and synthesize based on web results only.',
      });
    }

    // Record into the shared registry and assign deterministic citation
    // numbers starting at 1. Web articles continue from here.
    registry.papers = papers.slice(0, 10);
    const numbered = registry.papers.map((p, i) => ({ ...p, citationNumber: i + 1 }));

    return JSON.stringify({
      papers: numbered,
      _note: 'Search complete. Each paper has a "citationNumber" — when you cite it in the report, you MUST use exactly that number as [n]. Do NOT renumber. Do NOT call search_literature again.',
    });
  },
});

// ─── search_web ──────────────────────────────────────────────────────────────

export const buildSearchWeb = (context: any, registry: CitationRegistry) => tool({
  name: 'search_web',
  description: 'Search the web for relevant articles. Call this ONCE with a focused query directly related to the research topic. The query should be specific and in the same language as the research question. Returns JSON with articles array — each article carries a "citationNumber" you MUST use for its inline [n] citations.',
  parameters: z.object({
    query: z.string().describe("Search query — MUST be specific and directly related to the main research topic. Use the same language as the original question. Example: if topic is '315打假', query should be '315打假 消费者权益 央视晚会' NOT generic terms."),
  }),
  execute: async ({ query }) => {
    let articles: Article[] = [];
    // Set to an env-var name when web search is unusable due to missing config
    // (e.g. 'WSA_API_KEY'). Surfaced to the frontend so it can prompt the user.
    let configError: string | null = null;

    // Strategy 1: built-in web_search tool (Tencent Cloud WSA search API).
    //
    // Per the EdgeOne Makers tools spec, web_search returns a structured
    // SearchResult[] — { title, href, snippet, site, date } — directly (or as a
    // JSON string of that array under the openai-agents-sdk framework). It does
    // NOT use the Claude-MCP `{ content: [{ text }] }` envelope. Requires
    // `WSA_API_KEY` to be configured in the project environment.
    try {
      const webSearchTool = context?.tools?.get?.('web_search') ?? context?.tools?.web_search;
      if (webSearchTool) {
        logger.log(`[searchWeb] Using built-in web_search tool, query="${query}"`);
        const raw = await webSearchTool.execute({ query, maxResults: 10 });

        // Normalize into a SearchResult[]: accept a plain array, a JSON string,
        // or (defensively) a legacy MCP `{ content: [{ text }] }` envelope.
        let items: any = typeof raw === 'string' ? safeParse(raw) : raw;
        if (items && !Array.isArray(items) && typeof items?.content?.[0]?.text === 'string') {
          items = safeParse(items.content[0].text);
        }
        if (!Array.isArray(items)) items = [];

        articles = items
          .map((item: any) => ({
            title: item.title || '',
            url: item.href || item.url || '',
            // Prefer the SearchResult `site` field; fall back to the URL host.
            source: item.site || (() => {
              try { return new URL(item.href || item.url || '').hostname.replace('www.', ''); } catch { return ''; }
            })(),
            date: item.date || '',
            snippet: item.snippet || item.body || '',
          }))
          .filter((a: Article) => a.title && a.url);

        if (articles.length > 0) {
          logger.log(`[searchWeb] web_search returned ${articles.length} results:`);
          articles.forEach((a, i) => logger.log(`  [${i + 1}] ${a.title} | ${a.url} | ${a.source}${a.date ? ` | ${a.date}` : ''}`));
        } else {
          logger.log('[searchWeb] web_search returned no usable results');
        }
      } else {
        // The toolkit only registers `web_search` when WSA_API_KEY is present,
        // so a missing tool almost always means the key is not configured.
        configError = 'WSA_API_KEY';
        logger.log('[searchWeb] built-in web_search tool not available — WSA_API_KEY likely not configured');
      }
    } catch (e) {
      const msg = (e as Error).message || '';
      // 401 / auth failures point at a missing or invalid WSA_API_KEY.
      if (/401|403|unauthor|forbidden|api[\s_-]?key|wsa/i.test(msg)) {
        configError = 'WSA_API_KEY';
      }
      logger.log(`[searchWeb] web_search tool failed: ${msg}`);
    }

    // When web search yields nothing, the most common cause is a missing
    // WSA_API_KEY: the toolkit silently returns an empty list (no throw) when
    // the key is absent. Check the injected env directly as a reliable signal.
    if (articles.length === 0 && !configError) {
      const wsaKey = (context?.env?.WSA_API_KEY ?? '').trim();
      if (!wsaKey || /^(your-|<)/i.test(wsaKey)) {
        configError = 'WSA_API_KEY';
        logger.log('[searchWeb] empty results and WSA_API_KEY not configured → flagging config error');
      }
    }

    // Report no results — do not fabricate fake articles. We intentionally do
    // NOT fall back to home-rolled HTML scraping: per the EdgeOne Makers tools
    // spec the platform `web_search` (Tencent Cloud WSA) is the single source
    // of truth for open-web discovery.
    if (articles.length === 0) {
      logger.log(`[searchWeb] web_search returned no results${configError ? ` (configError=${configError})` : ''}`);
      return JSON.stringify({
        articles: [],
        ...(configError ? { _configError: configError } : {}),
        _note: configError
          ? `Web search is not configured (missing ${configError}). Tell the user web search is unavailable and continue with academic sources only. Do NOT invent or fabricate URLs or sources.`
          : 'No web articles found. Do NOT invent or fabricate URLs or sources. Report that no verified web sources were found for this query.',
      });
    }

    logger.log(`[searchWeb] Returning ${articles.slice(0, 10).length} articles to agent`);
    // Record into the shared registry and continue citation numbering after
    // the papers (papers = 1..P, articles = P+1..N).
    registry.articles = articles.slice(0, 10);
    const offset = registry.papers.length;
    const numbered = registry.articles.map((a, i) => ({ ...a, citationNumber: offset + i + 1 }));

    return JSON.stringify({
      articles: numbered,
      _note: 'Search complete. Each article has a "citationNumber" — when you cite it in the report, you MUST use exactly that number as [n]. Do NOT renumber. Do NOT call search_web again.',
    });
  },
});

// ─── scrape_urls ─────────────────────────────────────────────────────────────

export const buildScrapeUrls = (context: any) => tool({
  name: 'scrape_urls',
  description: 'Scrape content from user-provided URLs. Use this when the user provides specific URLs to include in the research. Returns extracted text content from each URL.',
  parameters: z.object({
    urls: z.array(z.string()).describe('URLs to scrape for content'),
  }),
  execute: async ({ urls }) => {
    const { scrapeUrls: doScrape } = await import('./scrape');
    const results = await doScrape(context, urls);
    return JSON.stringify({
      scrapedUrls: results,
      _note: 'Scraping complete. Use the scraped content in your report.',
    });
  },
});

// ─── Convenience builder ─────────────────────────────────────────────────────

/**
 * Build all four research tools for a single request. Each returned tool
 * has its own context closure — safe to use across concurrent invocations.
 * The literature + web tools share a `CitationRegistry` so sources get
 * deterministic, non-overlapping citation numbers (papers first, then web).
 * The registry is returned alongside the tools so the caller can read the
 * canonical numbered source list after the run.
 */
export function buildResearchTools(context: any) {
  const registry = createCitationRegistry();
  return {
    registry,
    decomposeQuestion: buildDecomposeQuestion(),
    searchLiterature: buildSearchLiterature(context, registry),
    searchWeb: buildSearchWeb(context, registry),
    scrapeUrls: buildScrapeUrls(context),
  };
}
