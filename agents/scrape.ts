/**
 * URL Scraper — Scrapes content from user-provided URLs via sandbox browser.
 *
 * POST /scrape
 * Body: { urls: string[] }
 * Returns: { results: [{ url, title, content, success }] }
 *
 * Uses platform browser tool (op: 'fetch') to render pages and extract text.
 * Fallback: runtime fetch for non-JS pages.
 */
import { createLogger, safeFetch } from './_shared';

const logger = createLogger('scrape');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScrapedUrl {
  url: string;
  title: string;
  content: string;
  success: boolean;
  scrapedAt: string;
  error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getPlatformTool(context: any, name: string): any {
  const tools = context.tools?.all?.() ?? [];
  return tools.find((t: any) => (t.name || t.function?.name) === name) || null;
}

async function executePlatformTool(context: any, toolName: string, args: Record<string, any>): Promise<any> {
  const tool = getPlatformTool(context, toolName);
  if (!tool) return null;
  const execute = tool.execute || tool.handler || tool.invoke;
  if (typeof execute !== 'function') return null;
  return execute.call(tool, args);
}

/**
 * Extract readable text from HTML content.
 * Strips tags, scripts, styles, and excessive whitespace.
 */
function extractText(html: string): string {
  let text = html;
  // Remove script/style blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  // Truncate to ~5000 chars to keep context manageable
  if (text.length > 5000) text = text.slice(0, 5000) + '...';
  return text;
}

/**
 * Extract title from HTML.
 */
function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/<[^>]+>/g, '').trim() : '';
}

// ─── Core Scraping Function (exported for use by research.ts) ────────────────

export async function scrapeUrls(context: any, urls: string[]): Promise<ScrapedUrl[]> {
  const results: ScrapedUrl[] = [];

  for (const url of urls.slice(0, 5)) { // Limit to 5 URLs per request
    const startTime = Date.now();
    logger.log(`[scrape] Fetching: ${url}`);

    try {
      // Strategy 1: Platform browser tool
      let content: string | null = null;
      let title = '';

      const browserResult = await executePlatformTool(context, 'browser', { op: 'fetch', url });
      if (browserResult) {
        const rawContent = typeof browserResult === 'string' ? browserResult : browserResult.content;
        title = browserResult.title || '';
        if (rawContent && rawContent.length > 100) {
          content = rawContent;
          if (!title) title = extractTitle(rawContent);
          logger.log(`[scrape] Browser fetch OK: ${url} (${rawContent.length} chars, ${Date.now() - startTime}ms)`);
        }
      }

      // Strategy 2: Fallback to safeFetch
      if (!content) {
        logger.log(`[scrape] Browser failed, trying safeFetch: ${url}`);
        const fetched = await safeFetch(context, url, { timeout: 10_000 });
        if (fetched && fetched.length > 100) {
          content = fetched;
          title = extractTitle(fetched);
          logger.log(`[scrape] safeFetch OK: ${url} (${fetched.length} chars, ${Date.now() - startTime}ms)`);
        }
      }

      if (content) {
        results.push({
          url,
          title: title || url,
          content: extractText(content),
          success: true,
          scrapedAt: new Date().toISOString(),
        });
      } else {
        logger.log(`[scrape] All strategies failed for: ${url}`);
        results.push({
          url,
          title: '',
          content: '',
          success: false,
          scrapedAt: new Date().toISOString(),
          error: 'Failed to fetch content',
        });
      }
    } catch (e) {
      logger.log(`[scrape] Error scraping ${url}: ${(e as Error).message}`);
      results.push({
        url,
        title: '',
        content: '',
        success: false,
        scrapedAt: new Date().toISOString(),
        error: (e as Error).message,
      });
    }
  }

  return results;
}

// ─── HTTP Handler ────────────────────────────────────────────────────────────

export async function onRequest(context: any) {
  const { request } = context;
  const { urls } = request?.body ?? {};

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    return new Response(JSON.stringify({ error: 'Missing urls array' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate URLs
  const validUrls = urls.filter((u: any) => typeof u === 'string' && u.startsWith('http'));
  if (validUrls.length === 0) {
    return new Response(JSON.stringify({ error: 'No valid URLs provided' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const results = await scrapeUrls(context, validUrls);

  return new Response(JSON.stringify({ results }), {
    status: 200, headers: { 'Content-Type': 'application/json; charset=UTF-8' },
  });
}
