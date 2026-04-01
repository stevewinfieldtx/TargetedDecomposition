/**
 * TDE — The Munger
 * ═══════════════════════════════════════════════════════════════════
 * This is the core differentiator of the Targeted Decomposition Engine.
 *
 * Instead of splitting text into arbitrary 500-word chunks (standard RAG),
 * The Munger identifies ATOMIC INTELLIGENCE UNITS — self-contained ideas
 * that have standalone meaning and value.
 *
 * Example of a chunk (bad): "...and so we saw that encryption for healthcare
 *   compliance was important in 2024 but also the ROI was significant..."
 *
 * Example of an atom (good): "Healthcare organizations that implemented encryption
 *   for HIPAA compliance in 2024 achieved an average 27% ROI within 18 months."
 *
 * The Munger processes text in windows, calls LLM to extract atoms,
 * then deduplicates and scores them by confidence.
 *
 * Fallback: if LLM fails or is not configured, falls back to
 * sentence-boundary splitting with quality filtering.
 */

const { v4: uuidv4 } = require('uuid');
const { callLLMJSON }  = require('../utils/llm');

const WINDOW_WORDS   = 600;   // words per LLM window
const WINDOW_OVERLAP = 100;   // overlap to catch atoms that span windows
const MIN_ATOM_WORDS = 8;     // atoms shorter than this are noise
const MAX_ATOM_WORDS = 120;   // atoms longer than this are probably compound ideas

/**
 * Main entry point.
 * Takes any extracted content object and returns an array of atoms.
 *
 * @param {Object} content  — output from any ingestor (has .text, .segments)
 * @param {string} sourceId — used for ID generation
 * @returns {Array}         — array of atom objects ready for tagging + embedding
 */
async function munge(content, sourceId) {
  const { text, segments } = content;
  if (!text || text.trim().length < 50) return [];

  console.log(`  Munger: processing ${Math.round(text.length / 5)} words...`);

  // Build segment index for time/page lookups
  const segIndex = buildSegmentIndex(segments || []);

  // Split into processing windows
  const windows = buildWindows(text);
  console.log(`  Munger: ${windows.length} windows to process`);

  // Extract atoms from each window
  const rawAtoms = [];
  for (let i = 0; i < windows.length; i++) {
    const win = windows[i];
    console.log(`  Munger: window ${i + 1}/${windows.length}...`);
    const extracted = await extractAtomsFromWindow(win.text, i);
    rawAtoms.push(...extracted);
  }

  // Deduplicate
  const unique = deduplicateAtoms(rawAtoms);
  console.log(`  Munger: ${rawAtoms.length} raw → ${unique.length} unique atoms`);

  // Enrich with source context (timestamps / page numbers)
  const enriched = unique.map((atom, idx) => ({
    id:          `${sourceId}_a${String(idx).padStart(4, '0')}`,
    atomIndex:   idx,
    text:        atom.text,
    atomType:    atom.type || 'general',
    confidence:  atom.confidence || 0.8,
    startTime:   lookupTime(atom.text, segIndex, 'start'),
    endTime:     lookupTime(atom.text, segIndex, 'end'),
    pageNumber:  lookupPage(atom.text, segIndex),
    speaker:     atom.speaker || null,
    // 6D fields will be filled by tagger.js
    d_persona:         '',
    d_buying_stage:    '',
    d_emotional_driver:'',
    d_evidence_type:   '',
    d_credibility:     3,
    d_recency:         '',
    embedding:         null,
  }));

  return enriched;
}

// ── Window Processing ─────────────────────────────────────────────────────────

function buildWindows(text) {
  const words   = text.split(/\s+/).filter(Boolean);
  const windows = [];
  let i = 0;
  while (i < words.length) {
    const end   = Math.min(i + WINDOW_WORDS, words.length);
    const slice = words.slice(i, end).join(' ');
    windows.push({ text: slice, startWord: i, endWord: end });
    i += WINDOW_WORDS - WINDOW_OVERLAP;
    if (i >= words.length) break;
  }
  return windows;
}

async function extractAtomsFromWindow(windowText, windowIndex) {
  const prompt = `You are extracting ATOMIC INTELLIGENCE UNITS from content.

An atomic intelligence unit is a self-contained, standalone idea that:
- Makes a complete, meaningful claim on its own
- Could stand alone without surrounding context
- Contains a specific insight, fact, statistic, recommendation, story, or framework
- Is NOT a transitional phrase, introduction, or filler

CONTENT TO PROCESS:
${windowText}

Extract every atomic intelligence unit from this content. For each atom:
- "text": the complete self-contained idea (8-120 words, use the original wording where possible)
- "type": one of: statistic | claim | recommendation | story | framework | quote | definition | comparison | question | other
- "confidence": 0.0-1.0 (how confident you are this is a genuine standalone idea)
- "speaker": name of speaker if content is a transcript and speaker is identifiable (null otherwise)

Return ONLY a JSON array. No explanation. Example:
[
  {"text":"Healthcare organizations that implemented encryption achieved 27% ROI within 18 months.","type":"statistic","confidence":0.95,"speaker":null},
  {"text":"The biggest mistake sales teams make is treating every prospect as an interchangeable variable.","type":"claim","confidence":0.88,"speaker":null}
]`;

  const result = await callLLMJSON(prompt, { maxTokens: 2000, temperature: 0.1 });
  if (!Array.isArray(result)) {
    console.log(`  Munger: LLM failed on window ${windowIndex + 1}, using sentence fallback`);
    return sentenceFallback(windowText);
  }

  return result
    .filter(a => a && typeof a.text === 'string')
    .filter(a => {
      const wc = a.text.trim().split(/\s+/).length;
      return wc >= MIN_ATOM_WORDS && wc <= MAX_ATOM_WORDS;
    })
    .map(a => ({
      text:       a.text.trim(),
      type:       a.type || 'other',
      confidence: typeof a.confidence === 'number' ? a.confidence : 0.7,
      speaker:    a.speaker || null,
    }));
}

// ── Fallback: Sentence-Based Splitting ────────────────────────────────────────

function sentenceFallback(text) {
  // Split on sentence boundaries, keeping context
  const sentences = text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map(s => s.trim())
    .filter(s => {
      const wc = s.split(/\s+/).length;
      return wc >= MIN_ATOM_WORDS && wc <= MAX_ATOM_WORDS;
    });

  return sentences.map(s => ({
    text:       s,
    type:       classifySentence(s),
    confidence: 0.5,
    speaker:    null,
  }));
}

function classifySentence(text) {
  if (/\d+%|\$\d|\d+ (million|billion|thousand)/.test(text)) return 'statistic';
  if (/recommend|should|must|need to|best practice/i.test(text)) return 'recommendation';
  if (/means|defined as|is a |refers to/i.test(text)) return 'definition';
  if (/compared to|versus|unlike|while |whereas/i.test(text)) return 'comparison';
  return 'claim';
}

// ── Deduplication ──────────────────────────────────────────────────────────────

function deduplicateAtoms(atoms) {
  const seen  = new Set();
  const result = [];
  for (const atom of atoms) {
    // Normalize: lowercase, remove punctuation, collapse whitespace
    const key = atom.text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(atom);
    }
  }
  // Sort by confidence descending
  return result.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
}

// ── Segment Index (time/page lookup) ─────────────────────────────────────────

function buildSegmentIndex(segments) {
  // Build a list of {text, startTime, endTime, pageNumber}
  return segments.map(seg => ({
    text:       (seg.text || '').toLowerCase(),
    startTime:  seg.start || seg.startTime || 0,
    endTime:    seg.end   || seg.endTime   || 0,
    pageNumber: seg.pageNumber || 0,
  }));
}

function lookupTime(atomText, segIndex, which) {
  if (!segIndex.length) return 0;
  const lower   = atomText.toLowerCase().slice(0, 50);
  const match   = segIndex.find(s => s.text.includes(lower.slice(0, 20)));
  if (!match) return 0;
  return which === 'start' ? match.startTime : match.endTime;
}

function lookupPage(atomText, segIndex) {
  if (!segIndex.length) return 0;
  const lower = atomText.toLowerCase().slice(0, 50);
  const match = segIndex.find(s => s.text.includes(lower.slice(0, 20)));
  return match?.pageNumber || 0;
}

module.exports = { munge };
