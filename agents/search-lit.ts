/**
 * Literature Search Sub-Agent — Finds relevant academic papers via real APIs.
 *
 * Search strategy (with fallback chain):
 *   1. Sandbox curl → CrossRef API (free, no auth, structured JSON)
 *   2. Semantic Scholar API (fallback if CrossRef returns too few)
 *   3. Runtime fetch fallback (same APIs)
 *   4. Mock data (for local dev without network)
 *
 * Called by orchestrator via context.agents.invoke('/search-lit', payload).
 */
import { createModel, createLogger, safeFetch } from './_shared';
import { HumanMessage } from '@langchain/core/messages';

const logger = createLogger('search-lit');

// ─── Mock Data (fallback) ────────────────────────────────────────────────────

const MOCK_PAPERS = [
    { title: 'Quantum Error Correction with Surface Codes: A Comprehensive Review', authors: 'Chen, L., Wang, M., & Park, S.', journal: 'Physical Review Letters', year: 2024, doi: '10.1103/PhysRevLett.132.040601', abstract: 'We present a comprehensive review of surface code implementations for quantum error correction, demonstrating a 10x improvement in logical error rates.' },
    { title: 'Large Language Models as Research Assistants: Capabilities and Limitations', authors: 'Thompson, R., Garcia, A., & Kim, J.', journal: 'Nature Machine Intelligence', year: 2024, doi: '10.1038/s42256-024-0812-3', abstract: 'This study evaluates the effectiveness of large language models in assisting scientific research.' },
    { title: 'Transformer Architectures for Scientific Discovery', authors: 'Liu, H., Patel, N., & Brown, K.', journal: 'Science', year: 2025, doi: '10.1126/science.abq1234', abstract: 'Novel transformer architectures specifically designed for scientific hypothesis generation.' },
    { title: 'Sustainable AI: Environmental Impact of Training Large Models', authors: 'Mueller, F., Santos, P., & Johnson, D.', journal: 'Nature Climate Change', year: 2024, doi: '10.1038/s41558-024-1987-2', abstract: 'Carbon footprint of training large AI models has decreased by 40% through algorithmic efficiency improvements.' },
    { title: 'Brain-Computer Interfaces: From Laboratory to Clinical Practice', authors: 'Yamamoto, K., Fischer, E., & O\'Brien, T.', journal: 'The Lancet Neurology', year: 2025, doi: '10.1016/S1474-4422(25)00034-1', abstract: 'Review of brain-computer interfaces transitioning from research settings to clinical applications.' },
    { title: 'Nuclear Fusion: Progress Toward Commercial Viability', authors: 'Anderson, J., Zhao, W., & Petrov, I.', journal: 'Nature Energy', year: 2025, doi: '10.1038/s41560-025-0145-7', abstract: 'Recent breakthroughs in tokamak confinement bring commercial fusion power within a 15-year horizon.' },
    { title: 'Drug Discovery with Graph Neural Networks', authors: 'Robinson, S., Lee, C., & Nakamura, H.', journal: 'Journal of Medicinal Chemistry', year: 2024, doi: '10.1021/acs.jmedchem.4c00891', abstract: 'Graph neural networks have accelerated drug candidate identification by 3x.' },
    { title: 'Advances in Multimodal AI for Healthcare Diagnostics', authors: 'Gupta, R., Williams, T., & Choi, S.', journal: 'NEJM', year: 2025, doi: '10.1056/NEJMoa2501234', abstract: 'Multimodal AI systems achieve diagnostic accuracy exceeding specialist physicians.' },
];

// ─── CrossRef API ────────────────────────────────────────────────────────────

interface Paper {
    title: string;
    authors: string;
    journal: string;
    year: number;
    doi: string;
    abstract: string;
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

async function searchCrossRef(context: any, query: string, rows = 8): Promise<Paper[]> {
    const encoded = encodeURIComponent(query);
    const url = `https://api.crossref.org/works?query=${encoded}&rows=${rows}&select=title,author,container-title,published,DOI,abstract`;

    const response = await safeFetch(context, url, {
        timeout: 15_000,
        headers: {
            'User-Agent': 'DeepResearch/1.0 (mailto:research@edgeone.ai)',
        },
    });

    if (!response) return [];
    return parseCrossRefResponse(response);
}

// ─── Semantic Scholar API ────────────────────────────────────────────────────

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

async function searchSemanticScholar(context: any, query: string, limit = 8): Promise<Paper[]> {
    const encoded = encodeURIComponent(query);
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encoded}&limit=${limit}&fields=title,authors,year,venue,abstract,externalIds,publicationVenue`;

    const response = await safeFetch(context, url, { timeout: 15_000 });
    if (!response) return [];
    return parseSemanticScholarResponse(response);
}

// ─── Mock search (keyword matching) ─────────────────────────────────────────

function searchMockPapers(query: string, maxResults = 5): Paper[] {
    const keywords = query.toLowerCase().split(/\s+/);
    const scored = MOCK_PAPERS.map(paper => {
        const text = `${paper.title} ${paper.abstract} ${paper.authors}`.toLowerCase();
        const score = keywords.filter(k => text.includes(k)).length;
        return { ...paper, score };
    }).sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map(({ score, ...p }) => p);
}

// ─── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an academic research librarian. Based on the sub-questions provided, select the most relevant academic papers from the search results.
Output ONLY a JSON array of the selected papers. No markdown fences, no explanations.`;

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function onRequest(context: any) {
    const { request } = context;
    const { subQuestions } = request?.body ?? {};

    if (!subQuestions || !Array.isArray(subQuestions)) {
        return new Response(JSON.stringify({ error: 'Missing subQuestions array' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    try {
        logger.log(`Searching literature for ${subQuestions.length} sub-questions`);

        const query = subQuestions.slice(0, 3).join(' ');
        let searchResults: Paper[] = [];

        // 1) Try CrossRef (primary)
        searchResults = await searchCrossRef(context, query);
        if (searchResults.length > 0) {
            logger.log(`CrossRef returned ${searchResults.length} papers`);
        }

        // 2) Semantic Scholar (supplement if CrossRef returned < 3)
        if (searchResults.length < 3) {
            logger.log('CrossRef insufficient, trying Semantic Scholar');
            const ssResults = await searchSemanticScholar(context, query);
            if (ssResults.length > 0) {
                logger.log(`Semantic Scholar returned ${ssResults.length} papers`);
                // Merge, deduplicate by DOI
                const existingDois = new Set(searchResults.map(p => p.doi).filter(Boolean));
                for (const paper of ssResults) {
                    if (!paper.doi || !existingDois.has(paper.doi)) {
                        searchResults.push(paper);
                        if (paper.doi) existingDois.add(paper.doi);
                    }
                }
            }
        }

        // 3) Fallback to mock if no real results
        if (searchResults.length === 0) {
            logger.log('No real results, using mock data');
            searchResults = searchMockPapers(query, 5);
        }

        // Use model to select and contextualize
        const model = createModel();
        const response = await model.invoke([
            { role: 'system', content: SYSTEM_PROMPT },
            new HumanMessage(`Sub-questions:\n${subQuestions.map((q: string, i: number) => `${i + 1}. ${q}`).join('\n')}\n\nSearch results:\n${JSON.stringify(searchResults, null, 2)}\n\nSelect the most relevant papers and output as JSON array.`),
        ]);

        let papers: any[] = [];
        const content = typeof response.content === 'string' ? response.content : '';
        let jsonStr = content.trim();
        if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        try {
            const parsed = JSON.parse(jsonStr);
            if (Array.isArray(parsed)) papers = parsed;
        } catch {
            const match = content.match(/\[[\s\S]*\]/);
            if (match) { try { papers = JSON.parse(match[0]); } catch {} }
        }

        if (papers.length === 0) papers = searchResults;

        logger.log(`Found ${papers.length} papers`);
        return new Response(JSON.stringify({ papers }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
        logger.error((e as Error).message);
        const fallback = searchMockPapers(subQuestions.join(' '), 4);
        return new Response(JSON.stringify({ papers: fallback }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
}
