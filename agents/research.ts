/**
 * Deep Research Agent — OpenAI Agents SDK
 *
 * Single agent with function tools that orchestrates the full research pipeline:
 *   1. decompose_question — breaks research question into sub-questions
 *   2. search_literature — queries CrossRef + Semantic Scholar
 *   3. search_web — uses context.tools browser to scrape Google
 *   4. (Final output) — agent synthesizes a report with citations
 *
 * Runs as a one-shot flow: question → tools → report.
 * No HITL approval step — agent decides tool call order autonomously.
 *
 * Streaming via SSE: tool_call events map to progress stages on the frontend.
 */
import { z } from "zod";
import { getStore } from '@edgeone/pages-blob';
import {
  Agent,
  run,
  tool,
  ensureProvider,
  getModel,
  createLogger,
  createSSEResponse,
  sseEvent,
  safeFetch,
} from './_shared';

const logger = createLogger('research');

// Disable OpenAI tracing (we use EdgeOne's own observability)
if (!process.env.OPENAI_AGENTS_DISABLE_TRACING) {
  process.env.OPENAI_AGENTS_DISABLE_TRACING = 'true';
}

// ─── Blob Store ──────────────────────────────────────────────────────────────

function getReportStore() {
  const projectId = process.env.PROJECT_ID || process.env.EDGEONE_PROJECT_ID || process.env.ProjectId;
  const token = process.env.EDGEONE_PAGES_API_TOKEN;
  if (projectId && token) {
    return getStore({ name: 'research-reports', projectId, token });
  }
  try { return getStore('research-reports'); } catch { return null; }
}

// ─── Mock Data ───────────────────────────────────────────────────────────────

const MOCK_PAPERS = [
  { title: 'Quantum Error Correction with Surface Codes: A Comprehensive Review', authors: 'Chen, L., Wang, M., & Park, S.', journal: 'Physical Review Letters', year: 2024, doi: '10.1103/PhysRevLett.132.040601', abstract: 'We present a comprehensive review of surface code implementations for quantum error correction.' },
  { title: 'Large Language Models as Research Assistants: Capabilities and Limitations', authors: 'Thompson, R., Garcia, A., & Kim, J.', journal: 'Nature Machine Intelligence', year: 2024, doi: '10.1038/s42256-024-0812-3', abstract: 'This study evaluates the effectiveness of large language models in assisting scientific research.' },
  { title: 'Transformer Architectures for Scientific Discovery', authors: 'Liu, H., Patel, N., & Brown, K.', journal: 'Science', year: 2025, doi: '10.1126/science.abq1234', abstract: 'Novel transformer architectures specifically designed for scientific hypothesis generation.' },
  { title: 'Sustainable AI: Environmental Impact of Training Large Models', authors: 'Mueller, F., Santos, P., & Johnson, D.', journal: 'Nature Climate Change', year: 2024, doi: '10.1038/s41558-024-1987-2', abstract: 'Carbon footprint of training large AI models has decreased by 40% through efficiency improvements.' },
  { title: 'Brain-Computer Interfaces: From Laboratory to Clinical Practice', authors: 'Yamamoto, K., Fischer, E., & O\'Brien, T.', journal: 'The Lancet Neurology', year: 2025, doi: '10.1016/S1474-4422(25)00034-1', abstract: 'Review of brain-computer interfaces transitioning from research to clinical applications.' },
];

const MOCK_ARTICLES = [
  { title: 'The Race to Build a Practical Quantum Computer', url: 'https://www.technologyreview.com/2025/quantum-computing-race', source: 'MIT Technology Review', date: '2025-03-15', snippet: 'Major tech companies are competing to achieve quantum advantage in practical applications.' },
  { title: 'AI Research Tools Are Changing How Scientists Work', url: 'https://www.nature.com/articles/d41586-025-00892-3', source: 'Nature News', date: '2025-02-28', snippet: 'A growing number of research institutions are adopting AI-powered tools for literature review.' },
  { title: 'OpenAI Announces New Research-Focused Model Architecture', url: 'https://openai.com/blog/research-model-2025', source: 'OpenAI Blog', date: '2025-04-01', snippet: 'New architecture designed for multi-step reasoning in scientific contexts.' },
  { title: 'Climate Impact of AI: Industry Report 2025', url: 'https://www.iea.org/reports/ai-energy-2025', source: 'International Energy Agency', date: '2025-01-20', snippet: 'Data centers supporting AI workloads now consume 4% of global electricity.' },
  { title: 'Neuralink Achieves Milestone in Brain-Computer Interface Trials', url: 'https://www.reuters.com/technology/neuralink-bci-milestone-2025', source: 'Reuters', date: '2025-03-22', snippet: 'Participants can now control complex digital interfaces using thought alone.' },
];

// ─── Search Helpers ──────────────────────────────────────────────────────────

interface Paper {
  title: string;
  authors: string;
  journal: string;
  year: number;
  doi: string;
  abstract: string;
}

interface Article {
  title: string;
  url: string;
  source: string;
  date: string;
  snippet: string;
}

function parseCrossRefResponse(json: string): Paper[] {
  try {
    const data = JSON.parse(json);
    const items = data?.message?.items;
    if (!Array.isArray(items)) return [];
    return items.map((item: any) => {
      const title = Array.isArray(item.title) ? item.title[0] : (item.title || '');
      const authors = Array.isArray(item.author)
        ? item.author.map((a: any) => `${a.given || ''} ${a.family || ''}`.trim()).join(', ')
        : '';
      const journal = Array.isArray(item['container-title'])
        ? item['container-title'][0]
        : (item['container-title'] || '');
      const dateParts = item?.published?.['date-parts']?.[0];
      const year = dateParts?.[0] || item?.['published-print']?.['date-parts']?.[0]?.[0] || 0;
      const doi = item.DOI || '';
      const abstract = (item.abstract || '').replace(/<[^>]+>/g, '').trim();
      return { title, authors, journal, year, doi, abstract };
    }).filter((p: Paper) => p.title);
  } catch {
    return [];
  }
}

function parseSemanticScholarResponse(json: string): Paper[] {
  try {
    const data = JSON.parse(json);
    const papers = data?.data;
    if (!Array.isArray(papers)) return [];
    return papers.map((item: any) => {
      const title = item.title || '';
      const authors = Array.isArray(item.authors)
        ? item.authors.map((a: any) => a.name || '').join(', ')
        : '';
      const journal = item.venue || item.publicationVenue?.name || '';
      const year = item.year || 0;
      const doi = item.externalIds?.DOI || '';
      const abstract = item.abstract || '';
      return { title, authors, journal, year, doi, abstract };
    }).filter((p: Paper) => p.title);
  } catch {
    return [];
  }
}

function searchMockPapers(query: string): Paper[] {
  const keywords = query.toLowerCase().split(/\s+/);
  const scored = MOCK_PAPERS.map(paper => {
    const text = `${paper.title} ${paper.abstract} ${paper.authors}`.toLowerCase();
    const score = keywords.filter(k => k.length > 2 && text.includes(k)).length;
    return { ...paper, score };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map(({ score, ...p }) => p);
}

function searchMockArticles(query: string): Article[] {
  const keywords = query.toLowerCase().split(/\s+/);
  const scored = MOCK_ARTICLES.map(article => {
    const text = `${article.title} ${article.snippet} ${article.source}`.toLowerCase();
    const score = keywords.filter(k => k.length > 2 && text.includes(k)).length;
    return { ...article, score };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map(({ score, ...a }) => a);
}

// ─── Web Search ──────────────────────────────────────────────────────────────

/**
 * Search the web using sandbox commands (curl) across multiple engines.
 *
 * Strategy priority:
 *   S1: sandbox.commands.run + curl Bing (SSR, best for headless)
 *   S2: sandbox.commands.run + curl DuckDuckGo HTML (SSR, no JS needed)
 *   S3: safeFetch Bing (runtime fetch, may be blocked)
 *   S4: safeFetch DuckDuckGo (fallback)
 *
 * Note: sandbox.browser.goto + getContent is skipped because getContent()
 * returns empty in the current EdgeOne runtime (Chromium not fully initialized).
 */
async function searchWithBrowser(context: any, query: string): Promise<Article[]> {
  const shortQuery = query.length > 80 ? query.slice(0, 80) : query;
  logger.log(`[searchWeb] Starting web search, query="${shortQuery}"`);

  const sandbox = context?.sandbox;
  const hasCommands = sandbox?.commands?.run;

  // Strategy 1: curl Bing (most reliable for SSR results)
  if (hasCommands) {
    logger.log('[searchWeb] Strategy 1: curl Bing...');
    try {
      const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(shortQuery)}&count=10&setlang=zh-Hans`;
      const startTime = Date.now();
      const result = await sandbox.commands.run(
        `curl -sS --max-time 8 -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' -H 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8' '${bingUrl}'`,
        { timeout: 12_000 }
      );
      const elapsed = Date.now() - startTime;
      const stdout = result?.stdout || '';
      logger.log(`[searchWeb] S1 curl Bing: length=${stdout.length}, elapsed=${elapsed}ms`);

      if (stdout.length > 1000) {
        const articles = parseSearchHTML(stdout, 'bing');
        logger.log(`[searchWeb] S1 curl Bing: parsed ${articles.length} articles`);
        if (articles.length >= 3) {
          logger.log(`[searchWeb] S1 SUCCESS: ${articles.length} results`);
          return articles;
        }
      }
    } catch (e) {
      logger.log(`[searchWeb] S1 ERROR: ${(e as Error).message}`);
    }

    // Strategy 2: curl DuckDuckGo HTML (lightweight, no JS)
    logger.log('[searchWeb] Strategy 2: curl DuckDuckGo HTML...');
    try {
      const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(shortQuery)}`;
      const startTime = Date.now();
      const result = await sandbox.commands.run(
        `curl -sS --max-time 8 -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' '${ddgUrl}'`,
        { timeout: 12_000 }
      );
      const elapsed = Date.now() - startTime;
      const stdout = result?.stdout || '';
      logger.log(`[searchWeb] S2 curl DuckDuckGo: length=${stdout.length}, elapsed=${elapsed}ms`);

      if (stdout.length > 500) {
        const articles = parseSearchHTML(stdout, 'duckduckgo');
        logger.log(`[searchWeb] S2 curl DuckDuckGo: parsed ${articles.length} articles`);
        if (articles.length > 0) {
          logger.log(`[searchWeb] S2 SUCCESS: ${articles.length} results`);
          return articles;
        }
      }
    } catch (e) {
      logger.log(`[searchWeb] S2 ERROR: ${(e as Error).message}`);
    }
  }

  // Strategy 3: safeFetch Bing (runtime fetch)
  logger.log('[searchWeb] Strategy 3: safeFetch Bing...');
  try {
    const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(shortQuery)}&count=10&setlang=zh-Hans`;
    const content = await safeFetch(context, bingUrl, {
      timeout: 8_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    if (content && content.length > 1000) {
      const articles = parseSearchHTML(content, 'bing');
      logger.log(`[searchWeb] S3 safeFetch Bing: parsed ${articles.length} articles`);
      if (articles.length > 0) {
        logger.log(`[searchWeb] S3 SUCCESS: ${articles.length} results`);
        return articles;
      }
    }
  } catch (e) {
    logger.log(`[searchWeb] S3 ERROR: ${(e as Error).message}`);
  }

  // Strategy 4: safeFetch DuckDuckGo (last resort)
  logger.log('[searchWeb] Strategy 4: safeFetch DuckDuckGo...');
  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(shortQuery)}`;
    const content = await safeFetch(context, ddgUrl, {
      timeout: 8_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    if (content && content.length > 200) {
      const articles = parseSearchHTML(content, 'duckduckgo');
      logger.log(`[searchWeb] S4 safeFetch DuckDuckGo: parsed ${articles.length} articles`);
      if (articles.length > 0) {
        logger.log(`[searchWeb] S4 SUCCESS: ${articles.length} results`);
        return articles;
      }
    }
  } catch (e) {
    logger.log(`[searchWeb] S4 ERROR: ${(e as Error).message}`);
  }

  logger.log('[searchWeb] ALL STRATEGIES FAILED, returning empty');
  return [];
}

/**
 * Parse search results HTML (supports Bing, Google, DuckDuckGo, Sogou formats).
 */
function parseSearchHTML(content: string, engine: 'google' | 'duckduckgo' | 'bing' | 'sogou'): Article[] {
  const articles: Article[] = [];

  if (engine === 'sogou') {
    // Sogou results: <h3 class="vr-title"><a href="URL">Title</a></h3>
    const resultPattern = /<h3[^>]*class="[^"]*vr-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi;
    let match;
    while ((match = resultPattern.exec(content)) !== null && articles.length < 10) {
      const block = match[1];
      const linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (linkMatch) {
        const url = linkMatch[1];
        const title = (linkMatch[2] || '').replace(/<[^>]+>/g, '').trim();
        if (url && title && !url.includes('sogou.com')) {
          let source = '';
          try { source = new URL(url).hostname.replace('www.', ''); } catch {}
          articles.push({ title, url, snippet: '', source, date: '' });
        }
      }
    }
    // Try to get snippets from nearby paragraph/span elements
    if (articles.length === 0) {
      // Fallback: extract all external links
      const linkPattern = /<a[^>]*href="(https?:\/\/(?!.*sogou\.com)[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((match = linkPattern.exec(content)) !== null && articles.length < 10) {
        const url = match[1];
        const title = (match[2] || '').replace(/<[^>]+>/g, '').trim();
        if (url && title && title.length > 5 && !url.includes('sogou.com') && !url.includes('javascript:')) {
          let source = '';
          try { source = new URL(url).hostname.replace('www.', ''); } catch {}
          if (!articles.some(a => a.url === url)) {
            articles.push({ title, url, snippet: '', source, date: '' });
          }
        }
      }
    }
  } else if (engine === 'duckduckgo') {
    const linkPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = linkPattern.exec(content)) !== null && articles.length < 10) {
      let url = match[1] || '';
      const title = (match[2] || '').replace(/<[^>]+>/g, '').trim();
      if (url.includes('uddg=')) {
        try {
          const uddg = new URLSearchParams(url.split('?')[1]).get('uddg');
          if (uddg) url = decodeURIComponent(uddg);
        } catch {}
      }
      if (url.startsWith('http') && title) {
        let source = '';
        try { source = new URL(url).hostname.replace('www.', ''); } catch {}
        articles.push({ title, url, snippet: '', source, date: '' });
      }
    }
    const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let snippetIdx = 0;
    while ((match = snippetPattern.exec(content)) !== null && snippetIdx < articles.length) {
      articles[snippetIdx].snippet = (match[1] || '').replace(/<[^>]+>/g, '').trim();
      snippetIdx++;
    }
  } else if (engine === 'bing') {
    // Bing results: <li class="b_algo ..."><h2><a href="URL">Title</a></h2>...
    // Pattern is lenient — class may contain additional values
    const resultPattern = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
    let match;
    while ((match = resultPattern.exec(content)) !== null && articles.length < 10) {
      const block = match[1];
      // Try h2 > a first (standard format)
      let linkMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      // Fallback: any a with href
      if (!linkMatch) {
        linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      }
      if (linkMatch) {
        const url = linkMatch[1];
        const title = (linkMatch[2] || '').replace(/<[^>]+>/g, '').trim();
        // Try multiple snippet patterns
        const snippetMatch = block.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
          || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
          || block.match(/<span[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
        const snippet = snippetMatch ? (snippetMatch[1] || '').replace(/<[^>]+>/g, '').trim() : '';
        if (url && title && !url.includes('bing.com') && !url.includes('microsoft.com/bing')) {
          let source = '';
          try { source = new URL(url).hostname.replace('www.', ''); } catch {}
          articles.push({ title, url, snippet: snippet.slice(0, 300), source, date: '' });
        }
      }
    }
    // Secondary pattern: some Bing results use <div class="b_title"><h2><a>
    if (articles.length < 3) {
      const altPattern = /<h2[^>]*><a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/gi;
      while ((match = altPattern.exec(content)) !== null && articles.length < 10) {
        const url = match[1];
        const title = (match[2] || '').replace(/<[^>]+>/g, '').trim();
        if (url && title && !url.includes('bing.com') && !articles.some(a => a.url === url)) {
          let source = '';
          try { source = new URL(url).hostname.replace('www.', ''); } catch {}
          articles.push({ title, url, snippet: '', source, date: '' });
        }
      }
    }
    // Fallback: extract all external URLs if structured parsing failed
    if (articles.length === 0) {
      const urlPattern = /https?:\/\/[^\s"'<>&]+/g;
      const urls = (content.match(urlPattern) || []).filter((u: string) =>
        !u.includes('bing.') && !u.includes('microsoft.') && !u.includes('msn.') &&
        !u.includes('schema.org') && u.startsWith('http')
      );
      const seen = new Set<string>();
      for (const url of urls) {
        if (seen.has(url) || articles.length >= 10) continue;
        seen.add(url);
        let source = '';
        try { source = new URL(url).hostname.replace('www.', ''); } catch { continue; }
        if (source) articles.push({ title: source, url, snippet: '', source, date: '' });
      }
    }
  } else {
    // Google: extract URLs from page content
    const urlPattern = /https?:\/\/[^\s"'<>&]+/g;
    const urls = (content.match(urlPattern) || []).filter((u: string) =>
      !u.includes('google.') && !u.includes('googleapis.') && !u.includes('gstatic.') &&
      !u.includes('schema.org') && !u.includes('w3.org') && u.startsWith('http')
    );
    const seen = new Set<string>();
    for (const url of urls) {
      if (seen.has(url) || articles.length >= 10) continue;
      seen.add(url);
      let source = '';
      try { source = new URL(url).hostname.replace('www.', ''); } catch { continue; }
      if (source) articles.push({ title: source, url, snippet: '', source, date: '' });
    }
  }

  return articles;
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

// We need context for sandbox/fetch calls — stored per-request
let _currentContext: any = null;

const decomposeQuestion = tool({
  name: "decompose_question",
  description: "Break a research question into focused sub-questions. You (the agent) should generate the sub-questions yourself based on the question and depth. Return them as a JSON string with a subQuestions array.",
  parameters: z.object({
    question: z.string().describe("The main research question"),
    depth: z.enum(["quick", "standard", "deep"]).describe("Research depth: quick (2-3 sub-questions), standard (3-5), deep (5-7)"),
    subQuestions: z.array(z.string()).describe("The sub-questions YOU generated. Cover: background, current state, challenges, future directions. Write in same language as question."),
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

const searchLiterature = tool({
  name: "search_literature",
  description: "Search academic databases (CrossRef + Semantic Scholar) for relevant papers. Call this ONCE with a combined query from the sub-questions. Returns JSON with papers array.",
  parameters: z.object({
    query: z.string().describe("Search query for academic papers (combine key terms from sub-questions)"),
  }),
  execute: async ({ query }) => {
    const context = _currentContext;
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

    // 3) Fallback to mock
    if (papers.length === 0) {
      logger.log('No real results, using mock papers');
      papers = searchMockPapers(query);
    }

    return JSON.stringify({
      papers: papers.slice(0, 10),
      _note: "Search complete. Use these results as-is for the report. Do NOT call search_literature again.",
    });
  },
});

const searchWeb = tool({
  name: "search_web",
  description: "Search the web for relevant articles. Call this ONCE with a focused query directly related to the research topic. The query should be specific and in the same language as the research question. Returns JSON with articles array.",
  parameters: z.object({
    query: z.string().describe("Search query — MUST be specific and directly related to the main research topic. Use the same language as the original question. Example: if topic is '315打假', query should be '315打假 消费者权益 央视晚会' NOT generic terms."),
  }),
  execute: async ({ query }) => {
    const context = _currentContext;
    let articles: Article[] = [];

    // Strategy 1: Use built-in web_search tool (most reliable)
    try {
      const webSearchTool = context?.tools?.get?.('web_search') || context?.tools?.all?.()?.find((t: any) => t.name === 'web_search');
      if (webSearchTool) {
        logger.log(`[searchWeb] Using built-in web_search tool, query="${query}"`);
        const result = await webSearchTool.execute({ query, maxResults: 10 });
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        // Parse result: web_search returns {title, href, body, engine}[]
        const items = parsed?.content?.[0]?.text ? JSON.parse(parsed.content[0].text) : (Array.isArray(parsed) ? parsed : []);
        if (Array.isArray(items) && items.length > 0) {
          articles = items.map((item: any) => ({
            title: item.title || '',
            url: item.href || item.url || '',
            source: (() => { try { return new URL(item.href || item.url || '').hostname.replace('www.', ''); } catch { return ''; } })(),
            date: item.date || '',
            snippet: item.body || item.snippet || '',
          })).filter((a: Article) => a.title && a.url);
          logger.log(`[searchWeb] web_search tool returned ${articles.length} results:`);
          articles.forEach((a, i) => logger.log(`  [${i+1}] ${a.title} | ${a.url} | ${a.snippet?.slice(0, 80)}`));
        } else {
          logger.log(`[searchWeb] web_search tool returned empty/unparseable result: ${JSON.stringify(parsed).slice(0, 500)}`);
        }
      }
    } catch (e) {
      logger.log(`[searchWeb] web_search tool failed: ${(e as Error).message}`);
    }

    // Strategy 2: Fallback to searchWithBrowser (curl Bing/DuckDuckGo)
    if (articles.length === 0) {
      logger.log('[searchWeb] Falling back to searchWithBrowser');
      articles = await searchWithBrowser(context, query);
    }

    // Strategy 3: Fallback to mock
    if (articles.length === 0) {
      logger.log('All search strategies failed, using mock articles');
      articles = searchMockArticles(query);
    }

    return JSON.stringify({
      articles: articles.slice(0, 10),
      _note: "Search complete. Use these results as-is for the report. Do NOT call search_web again.",
    });
  },
});

const scrapeUrls = tool({
  name: "scrape_urls",
  description: "Scrape content from user-provided URLs. Use this when the user provides specific URLs to include in the research. Returns extracted text content from each URL.",
  parameters: z.object({
    urls: z.array(z.string()).describe("URLs to scrape for content"),
  }),
  execute: async ({ urls }) => {
    const context = _currentContext;
    const { scrapeUrls: doScrape } = await import('./scrape');
    const results = await doScrape(context, urls);
    return JSON.stringify({
      scrapedUrls: results,
      _note: "Scraping complete. Use the scraped content in your report.",
    });
  },
});

// ─── Agent Definition & Stream ───────────────────────────────────────────────

interface ResearchOptions {
  depth: string;
  projectId?: string;
  urls?: string[];
  previousReport?: string;
  isFollowUp?: boolean;
  confirmedSubQuestions?: string[];
  decomposeOnly?: boolean;
}

function buildSystemPrompt(opts: ResearchOptions): string {
  const { depth, urls, previousReport, isFollowUp, confirmedSubQuestions } = opts;
  const countMap: Record<string, string> = { quick: '2-3', standard: '3-5', deep: '5-7' };
  const count = countMap[depth] || '3-5';

  const hasUrls = urls && urls.length > 0;
  const hasConfirmedQuestions = confirmedSubQuestions && confirmedSubQuestions.length > 0;
  const toolSteps = [];

  if (hasConfirmedQuestions) {
    // Sub-questions already confirmed by user — skip decompose step
    toolSteps.push('1. The sub-questions have been pre-confirmed by the user (listed below). Do NOT call `decompose_question`.');
    toolSteps.push('2. Call `search_literature` ONCE with a query combining KEY TERMS from the main question (keep it focused and specific)');
    toolSteps.push('3. Call `search_web` ONCE with a query using the MAIN TOPIC keywords in the original language (e.g. for Chinese topics, search in Chinese)');
    if (hasUrls) {
      toolSteps.push(`4. Call \`scrape_urls\` with the user-provided URLs: ${JSON.stringify(urls)}`);
      toolSteps.push('5. After all tool calls complete, write the final research report');
    } else {
      toolSteps.push('4. After all tool calls complete, write the final research report');
    }
  } else {
    toolSteps.push(`1. Call \`decompose_question\` with the question and depth="${depth}" — generate ${count} sub-questions (pass them in the subQuestions parameter)`);
    toolSteps.push('2. Call `search_literature` ONCE — query should use KEY TERMS from the main research topic (keep focused, specific)');
    toolSteps.push('3. Call `search_web` ONCE — query should use the MAIN TOPIC keywords in the SAME LANGUAGE as the question (e.g. Chinese question → Chinese search query)');
    if (hasUrls) {
      toolSteps.push(`4. Call \`scrape_urls\` with the user-provided URLs: ${JSON.stringify(urls)}`);
      toolSteps.push('5. After all tool calls complete, write the final research report');
    } else {
      toolSteps.push('4. After all 3 tool calls complete, write the final research report');
    }
  }

  const lengthMap: Record<string, string> = { quick: '2000-3000字', standard: '4000-6000字', deep: '6000-10000字' };
  const targetLength = lengthMap[depth] || '4000-6000字';

  let prompt = `You are a deep research assistant. Use the provided tools to conduct research, then write a comprehensive report.

## Steps (each tool ONCE, in order):
${toolSteps.join('\n')}

## CRITICAL RULES:
- Each tool must be called EXACTLY ONCE. NEVER call any tool more than once.
- Combine sub-questions into ONE search query for each search tool.
- After receiving tool results, write the report IMMEDIATELY.
- NEVER retry a tool call. The results you get are final.
${hasConfirmedQuestions ? `\n## Pre-confirmed Sub-questions:\n${confirmedSubQuestions!.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\nUse these sub-questions directly for your searches. Do NOT call decompose_question.` : ''}

## Report Format:
- Target length: ${targetLength} (IMPORTANT: stay within this range)
- Markdown with ## for main sections, ### for subsections
- Use GFM tables (| header | header |) when presenting comparative data
- Inline citations like [1], [2] referencing sources
- Academic but accessible tone
- Write in the same language as the original research question
- Section headings: use clean names like "## 结论" or "## 参考文献" — do NOT use slash-combined names like "结论/总结" or "参考文献/References"

## MANDATORY Report Structure (follow exactly in this order):
1. **## 序言** (or ## Introduction for English) — background, context, research objectives
2. **## 一、[Topic Chapter]** … **## N、[Topic Chapter]** — the main body chapters (AI decides titles and count based on depth)
3. **## 结论** (or ## Conclusion for English) — summary of key findings, takeaways
4. **## 参考文献** (or ## References for English) — ALL citations, numbered [1]–[N]. This is the ONLY references section in the entire report. NO supplementary references elsewhere.
5. **## 附录** (or ## Appendix for English) — OPTIONAL. Include only if there are data tables or charts to present. The appendix must NOT contain any reference list or citation section.

## CRITICAL Structure Rules:
- The report MUST end with ## 参考文献 (or ## References). Nothing comes after it except optionally ## 附录.
- There must be EXACTLY ONE references section. NEVER create "参考文献（补充）", "补充参考文献", "Additional References", or any secondary citation list.
- ALL inline citations [1]–[N] must resolve to entries in the single ## 参考文献 section.
- If an appendix is included, it may only contain tables, charts, or supplementary data — no citation lists.
- References section: list cited sources concisely (author, title, year only — NO full URLs)
- CRITICAL: You MUST write the COMPLETE report. Do NOT stop mid-sentence or mid-section. Write all sections through ## 参考文献 before stopping.`;

  if (isFollowUp && previousReport) {
    prompt += `

## FOLLOW-UP RESEARCH — INCREMENTAL EDITING MODE:
You are EDITING an existing research report based on user feedback.
CRITICAL RULES for editing:
- PRESERVE the existing report structure and content that doesn't need changes
- Only MODIFY sections the user explicitly asks to change
- Only ADD new sections/chapters where the user requests them
- If user asks to "add a chapter about X": insert it at the appropriate position in the report, keep everything else intact
- If user asks to "update section Y": rewrite only that section, preserve all others
- If user provides new sources/papers: integrate them into relevant sections
- Always output the COMPLETE updated report (existing content + modifications)
- Maintain consistent citation numbering throughout

Full previous report:
${previousReport}`;
  }

  return prompt;
}

// ─── Follow-up Editing Flow ───────────────────────────────────────────────────
// Lightweight path used when isFollowUp=true: skips decompose/search, edits
// the previous report directly with a no-tool agent.

async function* streamFollowUpEdit(
  modificationRequest: string,
  previousReport: string,
  opts: ResearchOptions,
  context: any,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const { depth, projectId } = opts;
  const conversationId = context.conversation_id || "default";
  const session = context.store?.openaiSession?.(conversationId);

  // Show only the synthesizer stage (editing = synthesis without search)
  yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'synthesizer', id: 'stage-4' });
  yield sseEvent({ type: 'progress', step: 1, total: 1, label: 'Editing report...' });

  const editorAgent = new Agent({
    name: "report-editor",
    instructions: `You are a precise research report editor.

## Your Task:
Edit the provided research report according to the user's modification request.

## CRITICAL RULES:
- PRESERVE all existing content that is not explicitly requested to change
- Only MODIFY / ADD / REMOVE exactly what the user requests
- Output the COMPLETE updated report — all original content with your modifications seamlessly integrated
- Maintain the same writing style, citation format, citation numbering, and language as the original report
- Do NOT prefix with any meta-commentary like "以下是更新后的报告" or "Here is the updated report" — start directly from the first heading
- Do NOT explain what you changed — just output the finished report
- If user asks to add a chapter: insert it in the logically appropriate position within the existing structure, BEFORE ## 结论
- If user asks to update a section: rewrite only that section, keep everything else verbatim
- If user asks to remove content: remove it and ensure surrounding text still flows naturally

## MANDATORY Structure Rules (preserve in all edits):
- The report must follow: ## 序言 → numbered body chapters → ## 结论 → ## 参考文献 → ## 附录 (optional)
- There must be EXACTLY ONE ## 参考文献 (or ## References) section — never create "参考文献（补充）" or any secondary citation list
- All citations [1]–[N] must resolve to entries in the single ## 参考文献 section
- The ## 附录 section must NOT contain any reference list`,
    model: getModel(),
    tools: [],
    modelSettings: { maxTokens: 65536 },
  });

  const input = [{
    role: "user" as const,
    content: `## Modification Request:\n${modificationRequest}\n\n## Report to Edit:\n${previousReport}`,
  }];

  let report = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    const result = await run(editorAgent, input as any, {
      stream: true,
      signal,
      maxTurns: 3,
      modelSettings: { maxTokens: 65536 },
      ...(session ? { session } : {}),
    });

    for await (const event of result) {
      if (signal?.aborted) break;

      if (event.type === "raw_model_stream_event") {
        const data = (event as any).data;
        if (data?.type === 'output_text_delta' && data.delta) {
          const text = data.delta;
          if (!text.includes('<think>') && !text.includes('</think>')) {
            report += text;
            yield sseEvent({ type: 'ai_response', content: text, agent: 'synthesizer' });
          }
        }
      } else if (event.type === "run_item_stream_event") {
        const item = event.item as any;
        if (item.rawItem?.usage) {
          totalInputTokens += item.rawItem.usage.input_tokens || 0;
          totalOutputTokens += item.rawItem.usage.output_tokens || 0;
        }
      }
    }
    await result.completed;

    // Fallback: non-streaming output
    if (!report) {
      const output = result.finalOutput;
      if (typeof output === 'string' && output) {
        report = output.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        yield sseEvent({ type: 'ai_response', content: report, agent: 'synthesizer' });
      }
    }
  } catch (e: any) {
    if (e.name !== 'AbortError' && !signal?.aborted) {
      logger.error('Follow-up edit error:', e.message);
      yield sseEvent({ type: 'error_message', content: e.message });
    }
  }

  if (report) {
    yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'synthesizer', id: 'stage-4' });
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      yield sseEvent({ type: 'token_usage', input: totalInputTokens, output: totalOutputTokens });
    }

    // Save versioned copy to project
    if (projectId) {
      try {
        const versionData = {
          question: modificationRequest,
          depth,
          subQuestions: [],
          papers: [],
          articles: [],
          scrapedUrls: [],
          report,
          trigger: 'follow-up',
        };
        if (context.agents?.invoke) {
          await context.agents.invoke('/project', { action: 'save_version', id: projectId, versionData });
          logger.log(`Saved follow-up edit version to project ${projectId}`);
        }
      } catch (e) {
        logger.log('Project version save failed (follow-up):', (e as Error).message);
      }
    }
  }

  yield sseEvent({ type: 'research_complete', sources: [] });
  yield "data: [DONE]\n\n";
}

async function* streamResearch(
  question: string,
  opts: ResearchOptions,
  context: any,
  signal?: AbortSignal
): AsyncGenerator<string> {
  ensureProvider();
  _currentContext = context;

  const { depth, projectId, urls, previousReport, isFollowUp, confirmedSubQuestions, decomposeOnly } = opts;
  const conversationId = context.conversation_id || "default";

  // Create OpenAI Agents SDK session for conversation history persistence
  const session = context.store?.openaiSession?.(conversationId);

  // ─── Follow-up editing mode: skip search, edit existing report directly ───
  if (isFollowUp && previousReport) {
    yield* streamFollowUpEdit(question, previousReport, opts, context, signal);
    return;
  }

  // ─── DecomposeOnly mode: just generate sub-questions and return ───
  if (decomposeOnly) {
    yield sseEvent({ type: 'subagent_lifecycle', status: 'pending', agent: 'question-decomposer', id: 'stage-1' });
    yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'question-decomposer', id: 'stage-1' });

    const decomposeAgent = new Agent({
      name: "question-decomposer",
      instructions: `You are a research question decomposer. Break the given research question into focused sub-questions.
Generate ${depth === 'quick' ? '2-3' : depth === 'deep' ? '5-7' : '3-5'} sub-questions that cover:
- Background and definitions
- Current state of research
- Key challenges and debates
- Future directions and applications
Write sub-questions in the same language as the input question.
Call the decompose_question tool with your generated sub-questions.`,
      model: getModel(),
      tools: [decomposeQuestion],
      modelSettings: { maxTokens: 2048 },
    });

    try {
      const result = await run(decomposeAgent, [{ role: "user", content: question }] as any, {
        stream: true, signal, maxTurns: 10, modelSettings: { maxTokens: 4096 },
        ...(session ? { session } : {}),
      });

      let subQs: string[] = [];
      for await (const event of result) {
        if (signal?.aborted) break;
        if (event.type === "run_item_stream_event") {
          const item = event.item as any;
          if (item.type === "tool_call_output_item") {
            try {
              const parsed = JSON.parse(item.output || '');
              if (parsed.subQuestions) subQs = parsed.subQuestions;
            } catch {}
          }
        }
      }
      await result.completed;

      if (subQs.length === 0) {
        // Fallback
        subQs = [
          `What is the current state of "${question}"?`,
          `What are the main challenges in "${question}"?`,
          `What are the future directions for "${question}"?`,
        ];
      }

      yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'question-decomposer', id: 'stage-1', content: JSON.stringify(subQs) });
      yield sseEvent({ type: 'decompose_complete', subQuestions: subQs });
    } catch (e: any) {
      if (e.name !== 'AbortError' && !signal?.aborted) {
        yield sseEvent({ type: 'error_message', content: e.message });
      }
    }

    yield "data: [DONE]\n\n";
    return;
  }

  // ─── Full research mode ───
  // Initialize progress stages
  if (confirmedSubQuestions && confirmedSubQuestions.length > 0) {
    // Skip decompose stage — already confirmed
    yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'question-decomposer', id: 'stage-1', content: JSON.stringify(confirmedSubQuestions) });
  } else {
    yield sseEvent({ type: 'subagent_lifecycle', status: 'pending', agent: 'question-decomposer', id: 'stage-1' });
  }
  yield sseEvent({ type: 'subagent_lifecycle', status: 'pending', agent: 'literature-searcher', id: 'stage-2' });
  yield sseEvent({ type: 'subagent_lifecycle', status: 'pending', agent: 'web-researcher', id: 'stage-3' });
  yield sseEvent({ type: 'subagent_lifecycle', status: 'pending', agent: 'synthesizer', id: 'stage-4' });

  const tools = confirmedSubQuestions ? [searchLiterature, searchWeb] : [decomposeQuestion, searchLiterature, searchWeb];
  if (urls && urls.length > 0) {
    tools.push(scrapeUrls as any);
  }

  const agent = new Agent({
    name: "deep-research",
    instructions: buildSystemPrompt(opts),
    model: getModel(),
    tools,
    modelSettings: {
      maxTokens: 65536,
    },
  });

  const input = confirmedSubQuestions
    ? [{ role: "user", content: `${question}\n\nPre-confirmed sub-questions:\n${confirmedSubQuestions.map((q, i) => `${i+1}. ${q}`).join('\n')}` }]
    : [{ role: "user", content: question }];

  let report = '';
  let papers: any[] = [];
  let articles: any[] = [];
  let subQuestions: string[] = confirmedSubQuestions || [];
  let scrapedUrls: any[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    // maxTurns: 15 allows tool calls + long report generation
    const result = await run(agent, input as any, { stream: true, signal, maxTurns: 15, modelSettings: { maxTokens: 65536 }, ...(session ? { session } : {}) });

    let synthesizing = false;
    let allToolsDone = false;   // Track if all tool outputs received

    for await (const event of result) {
      if (signal?.aborted) break;

      if (event.type === "run_item_stream_event") {
        const item = event.item as any;

        if (item.type === "tool_call_item") {
          const raw = item.rawItem;
          const toolName = raw?.name || "tool";
          allToolsDone = false;  // New tool call starting, not done yet
          // If we were accumulating pre-tool-call text, discard it
          if (synthesizing) {
            synthesizing = false;
            report = '';
          }

          // Map tool calls to progress stages
          if (toolName === 'decompose_question') {
            yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'question-decomposer', id: 'stage-1' });
            yield sseEvent({ type: 'progress', step: 1, total: 4, label: 'Decomposing research question...' });
          } else if (toolName === 'search_literature') {
            yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'literature-searcher', id: 'stage-2' });
            yield sseEvent({ type: 'progress', step: 2, total: 4, label: 'Searching academic papers...' });
          } else if (toolName === 'search_web') {
            yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'web-researcher', id: 'stage-3' });
            yield sseEvent({ type: 'progress', step: 3, total: 4, label: 'Searching web articles...' });
          } else if (toolName === 'scrape_urls') {
            yield sseEvent({ type: 'progress', step: 3, total: 4, label: 'Scraping user-provided URLs...' });
          }
        } else if (item.type === "tool_call_output_item") {
          const output = item.output || '';
          const toolName = item.rawItem?.name || '';
          allToolsDone = true;  // Tool completed — next text delta is likely the report

          // Parse tool results for frontend sources display
          try {
            const parsed = JSON.parse(output);
            if (toolName === 'decompose_question' && parsed.subQuestions) {
              subQuestions = parsed.subQuestions;
              yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'question-decomposer', id: 'stage-1', content: JSON.stringify(subQuestions) });
              yield sseEvent({ type: 'ai_response', content: subQuestions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n'), agent: 'question-decomposer' });
            } else if (toolName === 'search_literature' && parsed.papers) {
              papers = parsed.papers;
              yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'literature-searcher', id: 'stage-2', content: JSON.stringify(papers) });
            } else if (toolName === 'search_web' && parsed.articles) {
              articles = parsed.articles;
              yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'web-researcher', id: 'stage-3', content: JSON.stringify(articles) });
            } else if (toolName === 'scrape_urls' && parsed.scrapedUrls) {
              scrapedUrls = parsed.scrapedUrls;
              logger.log(`Scraped ${scrapedUrls.length} URLs`);
            }
          } catch {}
        } else if (item.type === "message_output_item") {
          // This is the final text output after all tool calls
          allToolsDone = true;
          if (!synthesizing) {
            synthesizing = true;
            yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'synthesizer', id: 'stage-4' });
            yield sseEvent({ type: 'source_switch', agent: 'synthesizer' });
            yield sseEvent({ type: 'progress', step: 4, total: 4, label: 'Writing research report...' });
          }
        }
      } else if (event.type === "raw_model_stream_event") {
        // Stream text deltas for the report
        const data = (event as any).data;
        if (data?.type === 'output_text_delta' && data.delta) {
          const text = data.delta;
          // Skip <think> blocks
          if (!text.includes('<think>') && !text.includes('</think>')) {
            // Only emit as report if all tools have completed
            if (!allToolsDone) {
              // Still in tool-calling phase or pre-tool text — don't emit as report
            } else {
              if (!synthesizing) {
                synthesizing = true;
                yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'synthesizer', id: 'stage-4' });
                yield sseEvent({ type: 'source_switch', agent: 'synthesizer' });
                yield sseEvent({ type: 'progress', step: 4, total: 4, label: 'Writing research report...' });
              }
              report += text;
              yield sseEvent({ type: 'ai_response', content: text, agent: 'synthesizer' });
            }
          }
        }
        // Capture token usage from response.completed or response.done events
        if (data?.type === 'response.completed' || data?.type === 'response.done') {
          const usage = data?.response?.usage || data?.usage;
          if (usage) {
            totalInputTokens += usage.input_tokens || usage.prompt_tokens || 0;
            totalOutputTokens += usage.output_tokens || usage.completion_tokens || 0;
          }
        }
        // Also capture from chat.completion.chunk usage (OpenAI format)
        if (data?.usage) {
          const u = data.usage;
          if (u.prompt_tokens && u.completion_tokens) {
            totalInputTokens += u.prompt_tokens;
            totalOutputTokens += u.completion_tokens;
          }
        }
      }
    }

    // Finalize
    await result.completed;

    // If report wasn't captured via streaming, get from finalOutput
    if (!report) {
      const output = result.finalOutput;
      if (typeof output === "string" && output) {
        report = output.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        if (report) {
          if (!synthesizing) {
            yield sseEvent({ type: 'subagent_lifecycle', status: 'running', agent: 'synthesizer', id: 'stage-4' });
            yield sseEvent({ type: 'source_switch', agent: 'synthesizer' });
            yield sseEvent({ type: 'progress', step: 4, total: 4, label: 'Writing research report...' });
          }
          yield sseEvent({ type: 'ai_response', content: report, agent: 'synthesizer' });
        }
      }
    }

    logger.log('Research complete');
  } catch (e: any) {
    if (e.name === 'AbortError' || signal?.aborted) {
      // Normal cancellation
    } else if (e.message?.includes('Max turns')) {
      logger.log('Max turns reached');
      yield sseEvent({ type: 'error_message', content: 'Research tools completed but report generation was interrupted. Please try again.' });
    } else if (e.message?.includes('terminated')) {
      logger.log('Stream terminated by runtime (likely timeout)');
      if (report) {
        report += '\n\n---\n*[Note: Report generation was interrupted due to connection timeout. The above content is partial.]*';
      }
    } else {
      logger.error('Agent error:', e.message);
      // Don't emit error to user if we already have a partial report — we'll try to continue
      if (!report) {
        yield sseEvent({ type: 'error_message', content: e.message });
      } else {
        logger.log(`Agent ended with error but report exists (len=${report.length}), attempting continuation...`);
      }
    }
  }

  // ─── Continuation: detect if report was cut short and continue (with retry loop) ───
  const MAX_CONTINUATIONS = 15;
  for (let attempt = 0; attempt < MAX_CONTINUATIONS && !signal?.aborted; attempt++) {
    // No report at all — nothing to continue
    if (!report || report.length === 0) break;

    const reportLower = report.toLowerCase();
    const hasConclusion = reportLower.includes('## 结论') || reportLower.includes('## conclusion') ||
      reportLower.includes('## 总结');
    const hasReferences = reportLower.includes('## 参考') || reportLower.includes('## references') ||
      reportLower.includes('## 引用') || reportLower.includes('参考文献');

    // Report is complete if it has BOTH conclusion AND references AND is reasonably long
    if (hasConclusion && hasReferences && report.length > 2000) {
      logger.log(`Report appears complete (len=${report.length}). No continuation needed.`);
      break;
    }

    // If report is already very long (>8000 chars), stop regardless to prevent infinite loops
    if (report.length > 8000) {
      logger.log(`Report is already ${report.length} chars, stopping continuation to prevent infinite loop.`);
      break;
    }

    logger.log(`Report incomplete (attempt ${attempt + 1}/${MAX_CONTINUATIONS}, len=${report.length}, hasConclusion=${hasConclusion}, hasReferences=${hasReferences}). Continuing...`);

    try {
      const continueAgent = new Agent({
        name: "report-continuator",
        instructions: `You are continuing an incomplete research report. The previous output was cut short. Continue writing from EXACTLY where it left off — do NOT add any prefix, greeting, or "continued from" note. Do NOT repeat any content that already exists. Complete ALL remaining sections following this exact structure: main body chapters → ## 结论 (or ## Conclusion) → ## 参考文献 (or ## References). Do NOT use "结论/总结" or slash-combined heading names. CRITICAL: There must be EXACTLY ONE references section in the entire report — never create "参考文献（补充）", "Additional References", or any secondary citation list. The appendix (## 附录) is optional and must NOT contain a citation list. Write in the same language as the existing content. Output ONLY the continuation text. Write as MUCH content as possible — aim for at least 2000 characters.`,
        model: getModel(),
        tools: [],
        modelSettings: { maxTokens: 65536 },
      });

      const continueInput = [
        { role: "user" as const, content: `The following research report was cut short at ${report.length} characters. Continue writing from where it stopped. You MUST output substantial content (at least 2000 characters). Complete the report with all remaining sections, conclusion, and references:\n\n---\n${report.slice(-3000)}` },
      ];

      const continueResult = await run(continueAgent, continueInput as any, {
        stream: true, signal, maxTurns: 3, modelSettings: { maxTokens: 65536 },
      });

      let continuation = '';
      for await (const event of continueResult) {
        if (signal?.aborted) break;
        if (event.type === "raw_model_stream_event") {
          const data = (event as any).data;
          if (data?.type === 'output_text_delta' && data.delta) {
            const text = data.delta;
            if (!text.includes('<think>') && !text.includes('</think>')) {
              continuation += text;
              report += text;
              yield sseEvent({ type: 'ai_response', content: text, agent: 'synthesizer' });
            }
          }
          if (data?.type === 'response.completed' || data?.type === 'response.done') {
            const usage = data?.response?.usage || data?.usage;
            if (usage) {
              totalOutputTokens += usage.output_tokens || usage.completion_tokens || 0;
            }
          }
        }
      }
      await continueResult.completed;
      logger.log(`Continuation ${attempt + 1} added ${continuation.length} chars (total report: ${report.length} chars)`);

      // If continuation added nothing, stop retrying
      if (continuation.length < 10) {
        logger.log('Continuation produced no meaningful output, stopping');
        break;
      }
    } catch (e: any) {
      logger.log(`Continuation ${attempt + 1} failed: ${e.message}`);
      // Don't break — try again
    }
  }

  // ─── Structure Check: fix common issues from multi-continuation ───
  if (report && report.length > 500) {
    const originalLen = report.length;

    // 0. Strip any supplementary reference sections inside appendix
    //    e.g. "参考文献（补充）", "补充参考文献", "Additional References", "参考文献\n" that appear AFTER the first references section
    report = report
      .replace(/\n###?\s*(参考文献（补充）|补充参考文献|Additional References?|参考文献补充)[^\n]*\n[\s\S]*?(?=\n##|\s*$)/gi, '')
      .trimEnd();

    // 1. Find the FIRST references section and remove everything after it that's a duplicate
    const refPatterns = [/\n## 参考文献\n/g, /\n## 参考\n/g, /\n## References\n/g, /\n## 引用文献\n/g];
    let firstRefIndex = -1;
    let firstRefPattern = '';
    for (const pattern of refPatterns) {
      const match = pattern.exec(report);
      if (match && (firstRefIndex === -1 || match.index < firstRefIndex)) {
        firstRefIndex = match.index;
        firstRefPattern = match[0];
      }
      pattern.lastIndex = 0; // reset regex
    }

    if (firstRefIndex > 0) {
      // Find if there's a SECOND references section (duplicate)
      const afterFirstRef = report.slice(firstRefIndex + firstRefPattern.length);
      let secondRefIndex = -1;
      for (const pattern of refPatterns) {
        const match = pattern.exec(afterFirstRef);
        if (match && (secondRefIndex === -1 || match.index < secondRefIndex)) {
          secondRefIndex = match.index;
        }
        pattern.lastIndex = 0;
      }

      // Also check for duplicate conclusion sections
      const conclusionPatterns = [/\n## 结论\n/g, /\n## 总结\n/g, /\n## Conclusion\n/g];
      const reportAfterRef = report.slice(firstRefIndex);
      let hasDuplicateConclusion = false;
      for (const pattern of conclusionPatterns) {
        if (pattern.test(reportAfterRef)) {
          hasDuplicateConclusion = true;
        }
        pattern.lastIndex = 0;
      }

      if (secondRefIndex > -1 || hasDuplicateConclusion) {
        // There's duplicate content after the first references section
        // Keep only the first references section and its content until the duplicate starts
        if (secondRefIndex > -1) {
          const cutPoint = firstRefIndex + firstRefPattern.length + secondRefIndex;
          report = report.slice(0, cutPoint).trimEnd();
          logger.log(`Structure fix: removed duplicate content after references (cut ${originalLen - report.length} chars)`);
        }
      }

      // Remove any citation sub-section inside ## 附录 (after the first references section)
      const appendixMatch = /\n## 附录[\s\S]*$/.exec(report);
      if (appendixMatch) {
        const appendixStart = appendixMatch.index;
        const appendixContent = appendixMatch[0];
        // Strip any ### sub-heading that looks like a reference list inside appendix
        const cleanedAppendix = appendixContent.replace(
          /\n###?\s*(参考文献|References?|引用|补充参考)[^\n]*\n[\s\S]*/gi,
          ''
        );
        if (cleanedAppendix !== appendixContent) {
          report = report.slice(0, appendixStart) + cleanedAppendix;
          logger.log(`Structure fix: removed citation list inside appendix`);
        }
      }
    }

    // 2. If report somehow ends with trailing continuation artifacts, clean them
    // Remove any trailing "## 结论" or "## 参考文献" headers that have no content after them
    report = report.replace(/\n## (结论|总结|Conclusion|参考文献|References|引用文献)\s*$/i, '').trimEnd();

    // 3. Notify frontend of the final cleaned report (replace current content)
    if (report.length !== originalLen) {
      logger.log(`Structure check: report adjusted from ${originalLen} to ${report.length} chars`);
      // Send the full cleaned report to replace what's on screen
      yield sseEvent({ type: 'report_replace', content: report });
    }
  }

  // Mark synthesizer as complete (only once, after any continuation)
  if (report) {
    yield sseEvent({ type: 'subagent_lifecycle', status: 'complete', agent: 'synthesizer', id: 'stage-4' });
  }

  // Save to project (versioned) or standalone blob
  if (projectId && report) {
    try {
      // Call project endpoint to save version
      const versionData = {
        question, depth, subQuestions, papers, articles, scrapedUrls, report,
        trigger: isFollowUp ? 'follow-up' : 'initial',
      };
      if (context.agents?.invoke) {
        await context.agents.invoke('/project', { action: 'save_version', id: projectId, versionData });
        logger.log(`Saved version to project ${projectId}`);
      }
    } catch (e) {
      logger.log('Project version save failed:', (e as Error).message);
    }
  } else {
    try {
      const reportStore = getReportStore();
      if (reportStore && report) {
        await reportStore.setJSON(`report-${conversationId}-${Date.now()}`, {
          question, depth, subQuestions, papers, articles, scrapedUrls, report,
          createdAt: new Date().toISOString(), conversationId,
        });
        logger.log('Report archived to Blob');
      }
    } catch (e) {
      logger.log('Blob archive skipped:', (e as Error).message);
    }
  }

  // Estimate tokens if SDK didn't provide them (common with deepseek models)
  if (totalInputTokens === 0 && totalOutputTokens === 0 && report) {
    // Rough estimation: ~1.5 chars per token for mixed CJK/English
    const systemPromptLen = buildSystemPrompt(opts).length;
    totalInputTokens = Math.ceil((question.length + systemPromptLen) / 1.5);
    totalOutputTokens = Math.ceil(report.length / 1.5);
  }

  yield sseEvent({ type: 'usage', input_tokens: totalInputTokens, output_tokens: totalOutputTokens, total_tokens: totalInputTokens + totalOutputTokens });
  yield "data: [DONE]\n\n";
}

// ─── HTTP Handler ────────────────────────────────────────────────────────────

export async function onRequest(context: any) {
  const { request } = context;
  const body = request?.body ?? {};
  const { message, question: questionField, depth = 'standard', projectId, urls, confirmedSubQuestions, decomposeOnly } = body;
  const question = message || questionField || '';

  if (!question) {
    return new Response(JSON.stringify({ error: 'Missing research question' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Load previous report context if this is a follow-up in a project
  let previousReport: string | undefined;
  let isFollowUp = false;

  if (projectId) {
    try {
      if (context.agents?.invoke) {
        const projectData = await context.agents.invoke('/project', { action: 'get', id: projectId });
        if (projectData?.project?.versionCount > 0) {
          isFollowUp = true;
          const lastVersion = await context.agents.invoke('/project', {
            action: 'get_version', id: projectId, version: projectData.project.versionCount,
          });
          if (lastVersion?.version?.report) {
            previousReport = lastVersion.version.report;
          }
        }
      }
    } catch (e) {
      logger.log('Failed to load project context:', (e as Error).message);
    }
  }

  const signal = request?.signal as AbortSignal | undefined;
  const opts: ResearchOptions = {
    depth,
    projectId,
    urls: Array.isArray(urls) ? urls.filter((u: any) => typeof u === 'string' && u.startsWith('http')) : undefined,
    previousReport,
    isFollowUp,
    confirmedSubQuestions: Array.isArray(confirmedSubQuestions) ? confirmedSubQuestions : undefined,
    decomposeOnly: !!decomposeOnly,
  };
  const generator = streamResearch(question, opts, context, signal);
  return createSSEResponse(generator, signal);
}
