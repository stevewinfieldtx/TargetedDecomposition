/**
 * TDE — Text / Transcript Ingestor
 * Handles raw .txt files, pre-written transcripts, and plain text strings.
 * Preserves paragraph structure.
 */

const fs   = require('fs');
const path = require('path');

function extractText(filePathOrString, title = '') {
  let raw;
  if (filePathOrString && fs.existsSync(filePathOrString)) {
    raw   = fs.readFileSync(filePathOrString, 'utf-8');
    title = title || path.basename(filePathOrString, path.extname(filePathOrString));
  } else {
    raw   = filePathOrString || '';
    title = title || 'Pasted Text';
  }

  const paragraphs = raw.split(/\n{2,}/).map(p => p.replace(/\n/g, ' ').trim()).filter(p => p.length > 20);

  // Detect timestamp patterns common in transcripts: "[00:00:00]" or "00:00" at line start
  const tsPattern = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*/;
  const segments  = paragraphs.map((text, i) => {
    const tsMatch = text.match(tsPattern);
    let startTime = 0;
    if (tsMatch) {
      const parts = tsMatch[1].split(':').map(Number);
      startTime = parts.length === 3 ? parts[0]*3600 + parts[1]*60 + parts[2] : parts[0]*60 + parts[1];
      text = text.replace(tsPattern, '').trim();
    }
    return { segmentIndex: i, startTime, text };
  });

  return {
    text: raw,
    segments,
    pageCount: 0,
    title,
    author: '',
    metadata: { charCount: raw.length, paragraphCount: paragraphs.length },
  };
}

module.exports = { extractText };
