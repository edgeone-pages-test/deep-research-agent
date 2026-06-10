/**
 * Source types + academic-database response parsers.
 *
 * Pure data transformation, no AI runtime dependency. Used by:
 *   - agents/_tools.ts (search_literature tool)
 *   - agents/research.ts (typing the synthesizer pipeline)
 */

export interface Paper {
  title: string;
  authors: string;
  journal: string;
  year: number;
  doi: string;
  abstract: string;
  /** Deterministic citation number assigned by the citation registry. */
  citationNumber?: number;
}

export interface Article {
  title: string;
  url: string;
  source: string;
  date: string;
  snippet: string;
  /** Deterministic citation number assigned by the citation registry. */
  citationNumber?: number;
}

/**
 * Parse a raw CrossRef `/works` JSON response into our Paper shape. Strips
 * embedded HTML in abstracts. Silently returns [] on malformed JSON.
 */
export function parseCrossRefResponse(json: string): Paper[] {
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

/**
 * Parse a Semantic Scholar `/paper/search` JSON response into our Paper
 * shape. Silently returns [] on malformed JSON.
 */
export function parseSemanticScholarResponse(json: string): Paper[] {
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
