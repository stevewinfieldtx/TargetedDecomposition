/**
 * TDE — Web Page Ingestor
 * Fetches a URL and extracts clean article text using cheerio.
 * Strips nav, footer, ads, scripts.
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

  const $ = cheerio.load(html);

  // Remove noise elements
  $('script, style, nav, footer, header, aside, .ad, .ads, .advertisement, .cookie, .popup, .modal, .sidebar').remove();

  // Try to find the main content area
  const contentSelectors = ['article', 'main', '[role="main"]', '.post-content', '.article-body', '.entry-content', '.content'];
  let $content = null;
  for (const sel of contentSelectors) {
    if ($(sel).length) { $content = $(sel).first(); break; }
  }
  if (!$content) $content = $('body');

  const title  = $('title').text().trim() || $('h1').first().text().trim() || url;
  const author = $('[rel="author"]').first().text().trim() || $('[class*="author"]').first().text().trim() || '';

  // Extract paragraphs
  const paragraphs = [];
  $content.find('p, h1, h2, h3, h4, li').each((i, el) => {
    const text = $(el).text().trim();
    if (text.length > 20) paragraphs.push(text);
  });

  // Deduplicate adjacent identical paragraphs
  const unique = paragraphs.filter((p, i) => i === 0 || p !== paragraphs[i - 1]);
  const fullText = unique.join('\n\n');

  const segments = unique.map((text, i) => ({ segmentIndex: i, pageNumber: 0, text }));

  return {
    text: fullText,
    segments,
    pageCount: 0,
    title,
    author,
    sourceUrl: url,
    metadata: { url, paragraphCount: unique.length },
  };
}

module.exports = { extractWeb };
