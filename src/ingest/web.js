/**
 * TDE — Web Page Ingestor
 * Single page extraction + site crawl mode.
 * 
 * If FIRECRAWL_API_KEY is set in env, uses Firecrawl for clean markdown extraction.
 * Otherwise falls back to fetch + cheerio (original behavior).
 */

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || '';

function firecrawlAvailable() { return !!FIRECRAWL_API_KEY; }

/**
 * Extract a single web page. Tries Firecrawl first, falls back to cheerio.
 */
async function extractWeb(url) {
  // Try Firecrawl if available
  if (firecrawlAvailable()) {
    try {
      const result = await extractWithFirecrawl(url);
      if (result && result.text.length > 100) {
        console.log(`  [Firecrawl] Extracted ${result.text.length} chars from ${url}`);
        return result;
      }
      console.log(`  [Firecrawl] Insufficient content, falling back to cheerio`);
    } catch (err) {
      console.log(`  [Firecrawl] Failed (${err.message}), falling back to cheerio`);
    }
  }

  // Fallback: cheerio
  let cheerio;
  try { cheerio = require('cheerio'); }
  catch { throw new Error('cheerio not installed — run: npm install cheerio'); }

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const html = await resp.text();
  return parseHTML(cheerio, html, url);
}

/**
 * Extract using Firecrawl API — returns clean markdown converted to our format.
 */
async function extractWithFirecrawl(url) {
  const resp = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      waitFor: 3000,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Firecrawl HTTP ${resp.status}: ${errText.substring(0, 200)}`);
  }

  const data = await resp.json();
  const markdown = data.data?.markdown || '';
  if (!markdown) return null;

  // Convert markdown to our standard format
  const title = data.data?.metadata?.title || url;
  const author = data.data?.metadata?.author || '';

  // Split markdown into paragraphs for segments
  const paragraphs = markdown.split(/\n{2,}/).filter(p => p.trim().length > 20);
  const segments = paragraphs.map((text, i) => ({ segmentIndex: i, pageNumber: 0, text: text.trim() }));

  return {
    text: markdown,
    segments,
    pageCount: 0,
    title,
    author,
    sourceUrl: url,
    metadata: { url, paragraphCount: paragraphs.length, scraper: 'firecrawl' },
  };
}

/**
 * Crawl a site starting from a URL. Follows links on the same domain
 * up to maxPages. Returns an array of extracted page objects.
 * 
 * Note: Firecrawl has its own crawl endpoint but it's credit-heavy.
 * We use Firecrawl per-page within the crawl loop instead.
 */
async function crawlSite(startUrl, maxPages = 50) {
  let cheerio;
  try { cheerio = require('cheerio'); }
  catch { throw new Error('cheerio not installed — run: npm install cheerio'); }

  const { URL } = require('url');
  const base = new URL(startUrl);
  const basePath = base.pathname.replace(/\/$/, '');
  const visited = new Set();
  const queue = [startUrl];
  const results = [];

  const scraper = firecrawlAvailable() ? 'Firecrawl' : 'cheerio';
  console.log(`  Crawling: ${startUrl} (max ${maxPages} pages, using ${scraper})`);

  while (queue.length > 0 && results.length < maxPages) {
    const url = queue.shift();
    const normalized = normalizeUrl(url);
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    try {
      // For link discovery we always need raw HTML (even with Firecrawl)
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        redirect: 'follow',
      });
      if (!resp.ok) continue;
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) continue;

      const html = await resp.text();

      // Extract content — Firecrawl for quality, cheerio as fallback
      let page;
      if (firecrawlAvailable()) {
        try {
          page = await extractWithFirecrawl(url);
        } catch (e) {
          page = parseHTML(cheerio, html, url);
        }
      } else {
        page = parseHTML(cheerio, html, url);
      }

      if (page && page.text.length > 100) {
        results.push(page);
        console.log(`  [${results.length}/${maxPages}] ${page.title.slice(0, 60)}`);
      }

      // Extract links on the same domain under the same path
      const $ = cheerio.load(html);
      $('a[href]').each((i, el) => {
        try {
          const href = $(el).attr('href');
          if (!href) return;
          const resolved = new URL(href, url);
          if (resolved.hostname !== base.hostname) return;
          if (basePath && !resolved.pathname.startsWith(basePath)) return;
          if (resolved.hash && resolved.pathname === base.pathname) return;
          if (/\.(pdf|jpg|png|gif|svg|css|js|zip|mp4|mp3)$/i.test(resolved.pathname)) return;

          const clean = resolved.origin + resolved.pathname;
          if (!visited.has(normalizeUrl(clean))) {
            queue.push(clean);
          }
        } catch {}
      });

      // Be polite — slightly longer delay for Firecrawl to avoid rate limits
      await new Promise(r => setTimeout(r, firecrawlAvailable() ? 1000 : 500));
    } catch (err) {
      console.log(`  Crawl error on ${url}: ${err.message}`);
    }
  }

  console.log(`  Crawl complete: ${results.length} pages extracted`);
  return results;
}

function normalizeUrl(url) {
  return url.replace(/\/+$/, '').replace(/^https?:\/\/www\./, 'https://').toLowerCase();
}

function parseHTML(cheerio, html, url) {
  const $ = cheerio.load(html);

  // Remove noise
  $('script, style, nav, footer, header, aside, .ad, .ads, .advertisement, .cookie, .popup, .modal, .sidebar').remove();

  // Find main content
  const contentSelectors = ['article', 'main', '[role="main"]', '.post-content', '.article-body', '.entry-content', '.content'];
  let $content = null;
  for (const sel of contentSelectors) {
    if ($(sel).length) { $content = $(sel).first(); break; }
  }
  if (!$content) $content = $('body');

  const title  = $('title').text().trim() || $('h1').first().text().trim() || url;
  const author = $('[rel="author"]').first().text().trim() || $('[class*="author"]').first().text().trim() || '';

  const paragraphs = [];
  $content.find('p, h1, h2, h3, h4, li').each((i, el) => {
    const text = $(el).text().trim();
    if (text.length > 20) paragraphs.push(text);
  });

  const unique = paragraphs.filter((p, i) => i === 0 || p !== paragraphs[i - 1]);
  const fullText = unique.join('\n\n');
  const segments = unique.map((text, i) => ({ segmentIndex: i, pageNumber: 0, text }));

  return {
    text: fullText, segments, pageCount: 0,
    title, author, sourceUrl: url,
    metadata: { url, paragraphCount: unique.length, scraper: 'cheerio' },
  };
}

module.exports = { extractWeb, crawlSite };
