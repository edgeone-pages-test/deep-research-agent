/**
 * DOI Enrichment — EdgeOne Makers Node Function.
 *
 * File path `cloud-functions/enrich-doi/index.ts` maps to **POST /enrich-doi**.
 *
 * Why this lives in cloud-functions, not agents/:
 * It's a pure data-fetch endpoint (CrossRef / Semantic Scholar lookup, no
 * model call, no streaming), so it doesn't need the agent runtime budget.
 *
 * Request: `{ doi: string }` or `{ url: string }` (we'll try to extract
 *          the DOI from the URL if it looks like a doi.org URL).
 * Response: `{ source: Source }` matching the frontend's Source shape, or
 *          `{ error }` on lookup failure.
 *
 * Usage: when a user manually adds a source in the SourcesPanel and types
 * a DOI, we call this to fill in title/authors/year/journal/abstract from
 * the upstream metadata so the model isn't free to hallucinate them later.
 */
import { createLogger } from '../_logger';
import { jsonResponse, errorResponse, readJsonBody } from '../_http';

const logger = createLogger('enrich-doi');

// ─── DOI extraction ──────────────────────────────────────────────────────────

/**
 * Pull a DOI out of a freeform input. Accepts:
 *   - bare DOIs:          "10.1038/s41586-020-2649-2"
 *   - doi.org URLs:       "https://doi.org/10.1038/s41586-020-2649-2"
 *   - dx.doi.org URLs:    "https://dx.doi.org/10.1038/..."
 *   - prefixed forms:     "doi:10.1038/...", "DOI: 10.1038/..."
 */
function extractDoi(raw: string): string | null {
  if (!raw) return null;
  // First try the bare-DOI regex anywhere in the string.
  // DOI syntax: "10." + registrant code + "/" + suffix
  const m = raw.match(/10\.\d{4,9}\/[^\s"<>]+/);
  if (!m) return null;
  // Strip trailing punctuation that often comes from URL paths
  return m[0].replace(/[.,;)]+$/, '');
}

// ─── CrossRef lookup ─────────────────────────────────────────────────────────

interface EnrichedSource {
  type: 'academic';
  title: string;
  authors: string[];
  journal: string;
  year: number;
  doi: string;
  abstract: string;
  url: string;
  citationNumber: number;
}

async function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = 8000): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    logger.error('fetch failed:', (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch metadata for a DOI from CrossRef. CrossRef is the authoritative
 * source for journal articles registered with a DOI; Semantic Scholar is
 * a useful fallback for preprints / older items.
 */
async function lookupCrossRef(doi: string): Promise<Partial<EnrichedSource> | null> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'DeepResearch/1.0 (mailto:research@edgeone.ai)' },
  });
  if (!res || !res.ok) {
    logger.log(`CrossRef returned ${res?.status ?? 'no-response'} for doi=${doi}`);
    return null;
  }
  const data: any = await res.json().catch(() => null);
  const item = data?.message;
  if (!item) return null;

  const title = Array.isArray(item.title) ? item.title[0] : (item.title || '');
  const authors = Array.isArray(item.author)
    ? item.author.map((a: any) => `${a.given || ''} ${a.family || ''}`.trim()).filter(Boolean)
    : [];
  const journal = Array.isArray(item['container-title'])
    ? item['container-title'][0]
    : (item['container-title'] || '');
  const dateParts = item?.published?.['date-parts']?.[0];
  const year = dateParts?.[0] || item?.['published-print']?.['date-parts']?.[0]?.[0] || 0;
  const abstract = (item.abstract || '').replace(/<[^>]+>/g, '').trim();

  return {
    title,
    authors,
    journal,
    year,
    doi,
    abstract,
    url: `https://doi.org/${doi}`,
  };
}

/**
 * Semantic Scholar fallback for DOIs CrossRef doesn't know about (preprints,
 * older items). Returns `null` if S2 also doesn't have it.
 */
async function lookupSemanticScholar(doi: string): Promise<Partial<EnrichedSource> | null> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=title,authors,year,venue,abstract`;
  const res = await fetchWithTimeout(url);
  if (!res || !res.ok) {
    logger.log(`Semantic Scholar returned ${res?.status ?? 'no-response'} for doi=${doi}`);
    return null;
  }
  const item: any = await res.json().catch(() => null);
  if (!item) return null;

  return {
    title: item.title || '',
    authors: Array.isArray(item.authors) ? item.authors.map((a: any) => a.name).filter(Boolean) : [],
    journal: item.venue || '',
    year: item.year || 0,
    doi,
    abstract: item.abstract || '',
    url: `https://doi.org/${doi}`,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function onRequestPost(context: any): Promise<Response> {
  const body = await readJsonBody(context);
  const rawInput = (body.doi || body.url || body.input || '') as string;
  if (!rawInput || typeof rawInput !== 'string') {
    return errorResponse('Missing doi/url/input', 400);
  }

  const doi = extractDoi(rawInput);
  if (!doi) {
    logger.log(`Could not extract a DOI from input="${rawInput.slice(0, 100)}"`);
    return errorResponse('Could not find a valid DOI in the input', 400);
  }

  logger.log(`Enriching doi=${doi}`);
  // Try CrossRef first (more reliable for published journal articles).
  let enriched = await lookupCrossRef(doi);
  if (!enriched || !enriched.title) {
    logger.log('CrossRef miss, trying Semantic Scholar');
    enriched = await lookupSemanticScholar(doi);
  }

  if (!enriched || !enriched.title) {
    logger.log(`Both lookups failed for doi=${doi}`);
    return errorResponse(`No metadata found for DOI ${doi}`, 404);
  }

  // Shape the response to match the frontend's Source type. citationNumber
  // is assigned by the frontend when the source is appended; we leave it 0.
  const source = {
    type: 'academic' as const,
    title: enriched.title || '',
    authors: enriched.authors || [],
    journal: enriched.journal || '',
    year: enriched.year || 0,
    doi: enriched.doi || doi,
    abstract: enriched.abstract || '',
    url: enriched.url || `https://doi.org/${doi}`,
    citationNumber: 0,
  };

  logger.log(`Enriched: title="${source.title.slice(0, 60)}" authors=${source.authors.length} year=${source.year}`);
  return jsonResponse({ source });
}
