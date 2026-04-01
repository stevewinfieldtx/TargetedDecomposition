/**
 * TDE — DOCX Ingestor
 * Extracts text from Word documents using mammoth.
 * Preserves paragraph structure.
 */

const fs   = require('fs');
const path = require('path');

async function extractDOCX(filePath) {
  let mammoth;
  try { mammoth = require('mammoth'); }
  catch { throw new Error('mammoth not installed — run: npm install mammoth'); }

  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });

  const rawText = result.value || '';
  // Split into paragraphs (non-empty lines)
  const paragraphs = rawText.split(/\n+/).map(p => p.trim()).filter(p => p.length > 20);

  // Build segments: each paragraph is a logical segment
  const segments = paragraphs.map((text, i) => ({ pageNumber: 0, segmentIndex: i, text }));

  const title = path.basename(filePath, path.extname(filePath));
  return {
    text: rawText,
    segments,
    pageCount: 0,
    title,
    author: '',
    metadata: { messages: result.messages || [] },
  };
}

module.exports = { extractDOCX };
