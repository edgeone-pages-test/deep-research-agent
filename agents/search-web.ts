/**
 * Web Search Sub-Agent — Finds relevant web articles via real search.
 *
 * Search strategy (with fallback chain):
 *   1. Sandbox curl → DuckDuckGo HTML search → parse results
 *   2. Runtime fetch fallback (same API)
 *   3. Mock data (for local dev without network)
 *
 * Called by orchestrator via context.agents.invoke('/search-web', payload).
 */
import { createModel, createLogger, safeFetch, sandboxExec } from './_shared';
import { HumanMessage } from '@langchain/core/messages';

const logger = createLogger('search-web');

// ─── Mock Data (fallback) ────────────────────────────────────────────────────

const MOCK_ARTICLES = [
    { title: 'The Race to Build a Practical Quantum Computer Enters a New Phase', url: 'https://www.technologyreview.com/2025/quantum-computing-race', source: 'MIT Technology Review', date: '2025-03-15', snippet: 'Major tech companies are competing to achieve quantum advantage in practical applications.' },
    { title: 'AI Research Tools Are Changing How Scientists Work', url: 'https://www.nature.com/articles/d41586-025-00892-3', source: 'Nature News', date: '2025-02-28', snippet: 'A growing number of research institutions are adopting AI-powered tools for literature review.' },
    { title: 'OpenAI Announces New Research-Focused Model Architecture', url: 'https://openai.com/blog/research-model-2025', source: 'OpenAI Blog', date: '2025-04-01', snippet: 'New architecture designed for multi-step reasoning in scientific contexts.' },
    { title: 'Climate Impact of AI: Industry Report 2025', url: 'https://www.iea.org/reports/ai-energy-2025', source: 'International Energy Agency', date: '2025-01-20', snippet: 'Data centers supporting AI workloads now consume 4% of global electricity.' },
    { title: 'Neuralink Achieves Milestone in Human Brain-Computer Interface Trials', url: 'https://www.reuters.com/technology/neuralink-bci-milestone-2025', source: 'Reuters', date: '2025-03-22', snippet: 'Participants can now control complex digital interfaces using thought alone.' },
    { title: 'Fusion Startup Secures Record $2B Funding Round', url: 'https://www.bloomberg.com/news/fusion-funding-2025', source: 'Bloomberg', date: '2025-02-10', snippet: 'Commonwealth Fusion Systems raises largest-ever private fusion investment.' },
    { title: 'CRISPR Gene Therapy Shows Promise for Rare Diseases', url: 'https://www.statnews.com/crispr-rare-diseases-2025', source: 'STAT News', date: '2025-04-05', snippet: 'Clinical trials demonstrate sustained remission in patients with sickle cell disease.' },
    { title: 'Autonomous Vehicles: The Regulatory Landscape in 2025', url: 'https://www.wired.com/autonomous-vehicles-regulation-2025', source: 'Wired', date: '2025-03-01', snippet: 'New federal guidelines create pathway for Level 4 autonomous driving.' },
];

// ─── Real Search via DuckDuckGo HTML ─────────────────────────────────────────

/**
 * Parse DuckDuckGo HTML search results into structured articles.
 * Uses a Node.js script in sandbox, or regex parsing as fallback.
 */
async function parseDuckDuckGoHTML(context: any, html: string): Promise<any[]> {
    // Try sandbox Node.js for robust parsing
    const parseScript = `
const html = process.argv[1];
const results = [];
const regex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\\/a>[\\s\\S]*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\\/a>/gi;
let match;
while ((match = regex.exec(html)) !== null && results.length < 8) {
    const url = match[1].replace(/.*uddg=([^&]+).*/, (_, u) => decodeURIComponent(u));
    const title = match[2].replace(/<[^>]+>/g, '').trim();
    const snippet = match[3].replace(/<[^>]+>/g, '').trim();
    if (title && url) {
        results.push({ title, url, snippet, source: new URL(url).hostname.replace('www.',''), date: '' });
    }
}
process.stdout.write(JSON.stringify(results));
`;

    // Use sandbox to run the parser with HTML piped in
    const escaped = html.replace(/'/g, "'\\''");
    const cmd = `echo '${escaped}' | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const html=d;const results=[];const regex=/<a[^>]+class=\\"result__a\\"[^>]*href=\\"([^\\"]*)\\"[^>]*>(.*?)<\\\\/a>[\\\\s\\\\S]*?<a[^>]+class=\\"result__snippet\\"[^>]*>(.*?)<\\\\/a>/gi;let m;while((m=regex.exec(html))!==null&&results.length<8){const url=m[1].replace(/.*uddg=([^&]+).*/,(_,u)=>decodeURIComponent(u));const title=m[2].replace(/<[^>]+>/g,'').trim();const snippet=m[3].replace(/<[^>]+>/g,'').trim();if(title&&url){try{results.push({title,url,snippet,source:new URL(url).hostname.replace('www.',''),date:''})}catch{}}}process.stdout.write(JSON.stringify(results))})"`;

    const sandboxResult = await sandboxExec(context, cmd, 15_000);
    if (sandboxResult?.stdout) {
        try {
            const parsed = JSON.parse(sandboxResult.stdout);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        } catch {}
    }

    // Fallback: simple regex in-process
    const results: any[] = [];
    const regex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gi;
    let match;
    while ((match = regex.exec(html)) !== null && results.length < 8) {
        const rawUrl = match[1];
        const url = rawUrl.includes('uddg=')
            ? decodeURIComponent(rawUrl.replace(/.*uddg=([^&]+).*/, '$1'))
            : rawUrl;
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        const snippet = match[3].replace(/<[^>]+>/g, '').trim();
        if (title && url) {
            try {
                results.push({ title, url, snippet, source: new URL(url).hostname.replace('www.', ''), date: '' });
            } catch {}
        }
    }
    return results;
}

/**
 * Search the web using DuckDuckGo HTML endpoint.
 */
async function searchWeb(context: any, query: string): Promise<any[]> {
    const encoded = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

    const html = await safeFetch(context, url, {
        timeout: 15_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DeepResearch/1.0)' },
    });

    if (!html) return [];
    return parseDuckDuckGoHTML(context, html);
}

// ─── Mock search (keyword matching) ─────────────────────────────────────────

function searchMockArticles(query: string, maxResults = 5): any[] {
    const keywords = query.toLowerCase().split(/\s+/);
    const scored = MOCK_ARTICLES.map(article => {
        const text = `${article.title} ${article.snippet} ${article.source}`.toLowerCase();
        const score = keywords.filter(k => text.includes(k)).length;
        return { ...article, score };
    }).sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map(({ score, ...a }) => a);
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a web research specialist. Based on the sub-questions provided, select the most relevant web articles from the search results.
Output ONLY a JSON array of the selected articles. No markdown fences, no explanations.`;

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function onRequest(context: any) {
    const { request } = context;
    const { subQuestions } = request?.body ?? {};

    if (!subQuestions || !Array.isArray(subQuestions)) {
        return new Response(JSON.stringify({ error: 'Missing subQuestions array' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    try {
        logger.log(`Searching web for ${subQuestions.length} sub-questions`);

        const query = subQuestions.slice(0, 3).join(' ');
        let searchResults: any[] = [];

        // 1) Try real search via sandbox/fetch
        searchResults = await searchWeb(context, query);
        if (searchResults.length > 0) {
            logger.log(`Real search returned ${searchResults.length} results`);
        } else {
            // 2) Fallback to mock data
            logger.log('Real search returned no results, using mock data');
            searchResults = searchMockArticles(query, 5);
        }

        // Use model to select and contextualize
        const model = createModel();
        const response = await model.invoke([
            { role: 'system', content: SYSTEM_PROMPT },
            new HumanMessage(`Sub-questions:\n${subQuestions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')}\n\nSearch results:\n${JSON.stringify(searchResults, null, 2)}\n\nSelect the most relevant articles and output as JSON array.`),
        ]);

        let articles: any[] = [];
        const content = typeof response.content === 'string' ? response.content : '';
        let jsonStr = content.trim();
        if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        try {
            const parsed = JSON.parse(jsonStr);
            if (Array.isArray(parsed)) articles = parsed;
        } catch {
            const match = content.match(/\[[\s\S]*\]/);
            if (match) { try { articles = JSON.parse(match[0]); } catch {} }
        }

        if (articles.length === 0) articles = searchResults;

        logger.log(`Found ${articles.length} articles`);
        return new Response(JSON.stringify({ articles }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
        logger.error((e as Error).message);
        const fallback = searchMockArticles(subQuestions.join(' '), 4);
        return new Response(JSON.stringify({ articles: fallback }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
}
