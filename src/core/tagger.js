/**
 * TDE — The 6D Tagger
 * ═══════════════════════════════════════════════════════════════════
 * Takes atoms from The Munger and enriches each one with
 * 6-dimensional metadata for surgical precision retrieval.
 *
 * The Six Dimensions:
 *   1. Persona         — Who would most care about this atom?
 *   2. Buying Stage    — Where in the buyer journey is this most relevant?
 *   3. Emotional Driver — What emotion does this appeal to?
 *   4. Evidence Type   — What kind of proof/content is this?
 *   5. Credibility     — How authoritative is this? (1-5 scale)
 *   6. Recency Tier    — How time-sensitive is this?
 *
 * Processing strategy:
 * - Atoms are processed in batches of 10 to minimize LLM calls
 * - Falls back to rule-based classification if LLM fails
 */

const { callLLMJSON } = require('../utils/llm');
const config          = require('../config');

const BATCH_SIZE = 10; // atoms per LLM call

/**
 * Tag an array of atoms with 6D metadata.
 * @param {Array}  atoms    — from munger.js
 * @param {string} context  — optional context about the content source (e.g. "B2B sales training webinar")
 * @returns {Array}         — same atoms with d_* fields populated
 */
async function tagAtoms(atoms, context = '') {
  if (!atoms.length) return [];
  console.log(`  Tagger: tagging ${atoms.length} atoms in batches of ${BATCH_SIZE}...`);

  const tagged = [];
  for (let i = 0; i < atoms.length; i += BATCH_SIZE) {
    const batch = atoms.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const total    = Math.ceil(atoms.length / BATCH_SIZE);
    console.log(`  Tagger: batch ${batchNum}/${total}`);
    const result = await tagBatch(batch, context);
    tagged.push(...result);
  }
  return tagged;
}

async function tagBatch(atoms, context) {
  const dims = config.DIMENSIONS;

  const prompt = `You are tagging intelligence units across 6 dimensions for a B2B sales content system.
${context ? `Context about this content: ${context}` : ''}

DIMENSIONS AND VALID VALUES:
1. persona: ${dims.persona.join(' | ')}
2. buying_stage: ${dims.buying_stage.join(' | ')}
3. emotional_driver: ${dims.emotional_driver.join(' | ')}
4. evidence_type: ${dims.evidence_type.join(' | ')}
5. credibility: 1 (anecdotal/personal) to 5 (tier-1 analyst/peer-reviewed research)
6. recency_tier: ${dims.recency_tier.join(' | ')}

ATOMS TO TAG:
${atoms.map((a, i) => `[${i}] "${a.text}"`).join('\n')}

For each atom, return its 6D tags. Return ONLY a JSON array with one object per atom (same order):
[
  {
    "d_persona": "...",
    "d_buying_stage": "...",
    "d_emotional_driver": "...",
    "d_evidence_type": "...",
    "d_credibility": 3,
    "d_recency": "..."
  }
]

Rules:
- Pick the SINGLE best match for each dimension (no arrays)
- For credibility: statistics from named research firms = 4-5, product claims = 2-3, personal anecdotes = 1-2
- For recency: if no date is mentioned, use "Evergreen" unless content is clearly time-bound
- Always return exactly ${atoms.length} objects in the array`;

  const result = await callLLMJSON(prompt, { maxTokens: 2000, temperature: 0.1 });

  if (!Array.isArray(result) || result.length !== atoms.length) {
    console.log(`  Tagger: LLM failed or wrong count, using rule-based fallback`);
    return atoms.map(a => ({ ...a, ...ruleBasedTag(a) }));
  }

  return atoms.map((atom, i) => {
    const tags = result[i] || {};
    return {
      ...atom,
      d_persona:          validateDim(tags.d_persona, config.DIMENSIONS.persona, 'General'),
      d_buying_stage:     validateDim(tags.d_buying_stage, config.DIMENSIONS.buying_stage, 'Awareness'),
      d_emotional_driver: validateDim(tags.d_emotional_driver, config.DIMENSIONS.emotional_driver, 'Curiosity'),
      d_evidence_type:    validateDim(tags.d_evidence_type, config.DIMENSIONS.evidence_type, 'Anecdote/Story'),
      d_credibility:      validateCredibility(tags.d_credibility),
      d_recency:          validateDim(tags.d_recency, config.DIMENSIONS.recency_tier, 'Evergreen'),
    };
  });
}

// ── Rule-Based Fallback ────────────────────────────────────────────────────────

function ruleBasedTag(atom) {
  const t = atom.text.toLowerCase();
  return {
    d_persona:          inferPersona(t),
    d_buying_stage:     inferBuyingStage(t, atom.atomType),
    d_emotional_driver: inferEmotionalDriver(t),
    d_evidence_type:    inferEvidenceType(t, atom.atomType),
    d_credibility:      inferCredibility(t),
    d_recency:          inferRecency(t),
  };
}

function inferPersona(t) {
  if (/cfo|cfo|finance|budget|cost|revenue|roi|profit/i.test(t)) return 'CFO/Finance';
  if (/ciso|security|compliance|risk|cyber|breach/i.test(t)) return 'CISO/Security';
  if (/cto|cio|it |infrastructure|cloud|devops|engineer/i.test(t)) return 'CTO/IT';
  if (/sales|prospect|pipeline|quota|deal|close/i.test(t)) return 'VP Sales';
  if (/market|brand|campaign|lead gen|demand/i.test(t)) return 'VP Marketing';
  if (/ceo|executive|board|leadership|c-suite|strategy/i.test(t)) return 'Executive/C-Suite';
  return 'General';
}

function inferBuyingStage(t, type) {
  if (/what is|defined as|introduction|overview|problem with|challenge/i.test(t)) return 'Awareness';
  if (/how to|approach|consider|evaluate|compare|option/i.test(t)) return 'Evaluation';
  if (/choose|decision|recommend|best|top choice|why us/i.test(t)) return 'Decision';
  if (/implement|onboard|getting started|next step/i.test(t)) return 'Interest';
  if (/result|outcome|success|roi|after using/i.test(t)) return 'Retention';
  return 'Awareness';
}

function inferEmotionalDriver(t) {
  if (/risk|threat|lose|fail|breach|penalty|fine|danger/i.test(t)) return 'Fear/Risk';
  if (/grow|scale|opportun|potential|transform|future/i.test(t)) return 'Aspiration/Growth';
  if (/proof|result|evidence|case study|data shows|according to/i.test(t)) return 'Validation/Proof';
  if (/trust|reliable|proven|partner|guarantee/i.test(t)) return 'Trust/Credibility';
  if (/now|urgent|limited|deadline|before it/i.test(t)) return 'Urgency';
  return 'Curiosity';
}

function inferEvidenceType(t, type) {
  if (type === 'statistic' || /\d+%|\$\d|\d+ (million|billion)/.test(t)) return 'Statistic/Data';
  if (type === 'quote' || /"[^"]{10,}"/.test(t)) return 'Customer Quote';
  if (type === 'story' || /company|client|customer|they were|they had/i.test(t)) return 'Case Study';
  if (type === 'framework' || /step|model|framework|approach|method/i.test(t)) return 'Framework/Model';
  if (type === 'definition' || /defined as|means|refers to|is a /i.test(t)) return 'Definition';
  return 'Anecdote/Story';
}

function inferCredibility(t) {
  if (/gartner|forrester|idc|mckinsey|harvard|mit|stanford|peer.reviewed/i.test(t)) return 5;
  if (/research|study|survey|report|analysis|\d+ organizations/i.test(t)) return 4;
  if (/\d+%|\d+ (million|billion)|according to/i.test(t)) return 3;
  if (/our experience|we found|i believe|in my opinion/i.test(t)) return 2;
  return 2;
}

function inferRecency(t) {
  const currentYear = new Date().getFullYear();
  const yearMatch   = t.match(/\b(20\d{2})\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[1]);
    const age  = currentYear - year;
    if (age <= 0)  return 'Current Quarter';
    if (age <= 1)  return 'This Year';
    if (age <= 2)  return 'Last 1-2 Years';
    if (age <= 5)  return 'Dated (3-5yr)';
    return 'Dated (3-5yr)';
  }
  if (/this year|this quarter|recently|latest|new /i.test(t)) return 'This Year';
  return 'Evergreen';
}

// ── Validation Helpers ─────────────────────────────────────────────────────────

function validateDim(value, validValues, fallback) {
  if (!value) return fallback;
  // Exact match
  if (validValues.includes(value)) return value;
  // Case-insensitive match
  const lower = value.toLowerCase();
  const match = validValues.find(v => v.toLowerCase() === lower);
  if (match) return match;
  // Partial match
  const partial = validValues.find(v => v.toLowerCase().includes(lower) || lower.includes(v.toLowerCase()));
  return partial || fallback;
}

function validateCredibility(value) {
  const n = parseInt(value);
  if (!isNaN(n) && n >= 1 && n <= 5) return n;
  return 3;
}

module.exports = { tagAtoms };
