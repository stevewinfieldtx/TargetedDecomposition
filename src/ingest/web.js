/**
 * TDE — Web Page Ingestor
 * Single page extraction + site crawl mode.
 * Fetches URLs and extracts clean article text using cheerio.
 */

async function extractWeb(url) {
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
 * Crawl a site starting from a URL. Follows links on the same domain
 * up to maxPages. Returns an array of extracted page objects.
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

  console.log(`  Crawling: ${startUrl} (max ${maxPages} pages)`);

  while (queue.length > 0 && results.length < maxPages) {
    const url = queue.shift();
    const normalized = normalizeUrl(url);
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        redirect: 'follow',
      });
      if (!resp.ok) continue;
      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) continue;

      const html = await resp.text();
      const page = parseHTML(cheerio, html, url);
      if (page.text.length > 100) {
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
          // Same domain only
          if (resolved.hostname !== base.hostname) return;
          // Must be under the start path (or same level)
          if (basePath && !resolved.pathname.startsWith(basePath)) return;
          // Skip anchors, files, query-heavy URLs
          if (resolved.hash && resolved.pathname === base.pathname) return;
          if (/\.(pdf|jpg|png|gif|svg|css|js|zip|mp4|mp3)$/i.test(resolved.pathname)) return;

          const clean = resolved.origin + resolved.pathname;
          if (!visited.has(normalizeUrl(clean))) {
            queue.push(clean);
          }
        } catch {}
      });

      // Be polite
      await new Promise(r => setTimeout(r, 500));
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
    metadata: { url, paragraphCount: unique.length },
  };
}

module.exports = { extractWeb, crawlSite };
