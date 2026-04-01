/**
 * TDE — PDF Ingestor
 * Extracts text + page structure from PDF files.
 * Uses pdf-parse. Falls back to raw text if page-level fails.
 */

const fs   = require('fs');
const path = require('path');

async function extractPDF(filePath) {
  let pdfParse;
  try { pdfParse = require('pdf-parse'); }
  catch { throw new Error('pdf-parse not installed — run: npm install pdf-parse'); }

  const buffer = fs.readFileSync(filePath);
  const data   = await pdfParse(buffer);

  // Build page-level segments if possible
  const segments = [];
  if (data.text) {
    // pdf-parse doesn't give per-page positions but gives page count.
    // Split text into rough page chunks using the page count as a guide.
    const pageCount = data.numpages || 1;
    const lines = data.text.split('\n').filter(l => l.trim().length > 0);
    const linesPerPage = Math.ceil(lines.length / pageCount);
    for (let p = 0; p < pageCount; p++) {
      const pageLines = lines.slice(p * linesPerPage, (p + 1) * linesPerPage);
      const pageText  = pageLines.join(' ').trim();
      if (pageText.length > 10) {
        segments.push({ pageNumber: p + 1, text: pageText });
      }
    }
  }

  const title = path.basename(filePath, path.extname(filePath));
  return {
    text:      data.text || '',
    segments,                          // [{pageNumber, text}]
    pageCount: data.numpages || 1,
    title,
    author:    data.info?.Author || '',
    metadata:  { pdfInfo: data.info || {}, numpages: data.numpages },
  };
}

module.exports = { extractPDF };
