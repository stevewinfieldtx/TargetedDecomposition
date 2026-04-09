/**
 * TDE — Solution Research Module
 * ═══════════════════════════════════════════════════════════════════
 * Provides parallel agent swarm intelligence gathering and deep-fill
 * enrichment for the /research/:collectionId endpoint.
 *
 * Three exports:
 *   runSwarm(solutionUrl, solutionName, webContent)
 *     → Phase 1: parallel agents build a Minimum Solution Intelligence Profile (MSIP)
 *
 *   runDeepFill(engine, collectionId, solutionUrl, solutionName, msip)
 *     → Phase 2: background enrichment — ingests additional sources into TDE
 *
 *   msipToText(msip, solutionUrl)
 *     → Serialises an MSIP object to a plain-text block suitable for TDE ingest
 */

'use strict';

const { callLLM } = require('../utils/llm');
const config      = require('../config');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a clean domain label from a URL (used as a fallback product name).
 * e.g. "https://www.acme.com/product" → "acme.com"
 */
function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/https?:\/\//, '').split('/')[0];
  }
}

/**
 * Safely parse a JSON string that may be wrapped in markdown fences.
 * Returns null on failure so callers can fall back gracefully.
 */
function safeParseJSON(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch {} }
  return null;
}

// ── Agent definitions ────────────────────────────────────────────────────────
//
// Each agent focuses on a distinct intelligence dimension.  They run in
// parallel during Phase 1 so the total wall-clock time is bounded by the
// slowest single agent rather than the sum of all agents.

const AGENTS = [
  {
    name: 'product_identity',
    description: 'Extracts product name, category, tagline, and core value proposition',
    prompt: (url, name, content) =>
      `You are a product intelligence analyst. Analyse the following web content from ${url} and extract structured product identity information.\n\nProduct name hint: ${name || '(unknown)'}\n\nWEB CONTENT:\n${content.slice(0, 4000)}\n\nReturn JSON with these fields (use null for anything you cannot determine):\n{\n  "product_name": "string",\n  "category": "string — e.g. CRM, DevOps platform, Analytics SaaS",\n  "tagline": "string — the main marketing tagline if present",\n  "value_proposition": "string — one sentence core value prop",\n  "target_market": "string — primary buyer segment"\n}\n\nReturn valid JSON only.`,
  },
  {
    name: 'capabilities',
    description: 'Extracts key product capabilities and feature areas',
    prompt: (url, name, content) =>
      `You are a product capabilities analyst. Analyse the following web content from ${url} and extract the product's key capabilities.\n\nWEB CONTENT:\n${content.slice(0, 4000)}\n\nReturn JSON:\n{\n  "capabilities": ["string", ...],\n  "feature_areas": ["string", ...],\n  "integrations": ["string", ...]\n}\n\nReturn valid JSON only. Use empty arrays if nothing is found.`,
  },
  {
    name: 'differentiators',
    description: 'Identifies competitive differentiators and unique claims',
    prompt: (url, name, content) =>
      `You are a competitive intelligence analyst. Analyse the following web content from ${url} and identify what makes this product different from competitors.\n\nWEB CONTENT:\n${content.slice(0, 4000)}\n\nReturn JSON:\n{\n  "differentiators": ["string", ...],\n  "unique_claims": ["string", ...],\n  "competitors_mentioned": ["string", ...]\n}\n\nReturn valid JSON only. Use empty arrays if nothing is found.`,
  },
  {
    name: 'proof_points',
    description: 'Extracts social proof, statistics, case studies, and customer evidence',
    prompt: (url, name, content) =>
      `You are a proof-point analyst. Analyse the following web content from ${url} and extract all evidence of customer success and credibility.\n\nWEB CONTENT:\n${content.slice(0, 4000)}\n\nReturn JSON:\n{\n  "statistics": ["string", ...],\n  "customer_quotes": ["string", ...],\n  "case_studies": ["string", ...],\n  "notable_customers": ["string", ...]\n}\n\nReturn valid JSON only. Use empty arrays if nothing is found.`,
  },
  {
    name: 'pain_points',
    description: 'Identifies the buyer pain points and problems the product solves',
    prompt: (url, name, content) =>
      `You are a buyer-psychology analyst. Analyse the following web content from ${url} and identify the pain points and problems this product addresses.\n\nWEB CONTENT:\n${content.slice(0, 4000)}\n\nReturn JSON:\n{\n  "pain_points": ["string", ...],\n  "problems_solved": ["string", ...],\n  "buyer_fears": ["string", ...]\n}\n\nReturn valid JSON only. Use empty arrays if nothing is found.`,
  },
  {
    name: 'pricing_model',
    description: 'Extracts pricing model, tiers, and commercial signals',
    prompt: (url, name, content) =>
      `You are a commercial intelligence analyst. Analyse the following web content from ${url} and extract any pricing or commercial information.\n\nWEB CONTENT:\n${content.slice(0, 4000)}\n\nReturn JSON:\n{\n  "pricing_model": "string — e.g. per-seat SaaS, usage-based, freemium, enterprise",\n  "pricing_tiers": ["string", ...],\n  "free_trial": true | false | null,\n  "pricing_signals": ["string", ...]\n}\n\nReturn valid JSON only. Use null / empty arrays if nothing is found.`,
  },
];

// ── runSwarm ─────────────────────────────────────────────────────────────────

/**
 * Phase 1 — Parallel agent swarm.
 *
 * Runs all AGENTS concurrently against the scraped web content and merges
 * their outputs into a single Minimum Solution Intelligence Profile (MSIP).
 *
 * @param {string} solutionUrl   - The product/solution URL being researched
 * @param {string} solutionName  - Optional human-readable product name hint
 * @param {string} webContent    - Pre-scraped text content from the URL
 * @returns {Promise<{ msip: object, agents: object[], elapsed: number }>}
 */
async function runSwarm(solutionUrl, solutionName, webContent) {
  const t0 = Date.now();
  const fallbackName = solutionName || domainFromUrl(solutionUrl);

  console.log(`  [Swarm] Running ${AGENTS.length} agents in parallel for: ${solutionUrl}`);

  // Run all agents concurrently; individual failures are caught so one bad
  // agent cannot abort the whole swarm.
  const agentResults = await Promise.all(
    AGENTS.map(async (agent) => {
      const agentT0 = Date.now();
      try {
        if (!webContent || webContent.length < 50) {
          // No content to analyse — return an empty result for this agent
          return { name: agent.name, status: 'skipped', reason: 'no_web_content', data: {}, elapsed: 0 };
        }

        const raw = await callLLM(
          agent.prompt(solutionUrl, solutionName, webContent),
          {
            model: config.CONTENT_MODEL,
            system: 'You are a structured intelligence extraction agent. Return only valid JSON — no prose, no markdown fences.',
            maxTokens: 800,
            temperature: 0.2,
          }
        );

        const data = safeParseJSON(raw) || {};
        return { name: agent.name, status: 'ok', data, elapsed: Date.now() - agentT0 };
      } catch (err) {
        console.error(`  [Swarm] Agent "${agent.name}" failed: ${err.message}`);
        return { name: agent.name, status: 'error', error: err.message, data: {}, elapsed: Date.now() - agentT0 };
      }
    })
  );

  // Merge all agent outputs into a single MSIP
  const merged = {};
  for (const result of agentResults) {
    if (result.data && typeof result.data === 'object') {
      Object.assign(merged, result.data);
    }
  }

  // Build the canonical MSIP — guarantee required fields are always present
  const msip = {
    product_name:       merged.product_name       || fallbackName,
    category:           merged.category           || null,
    tagline:            merged.tagline            || null,
    value_proposition:  merged.value_proposition  || null,
    target_market:      merged.target_market      || null,
    capabilities:       Array.isArray(merged.capabilities)    ? merged.capabilities    : [],
    feature_areas:      Array.isArray(merged.feature_areas)   ? merged.feature_areas   : [],
    integrations:       Array.isArray(merged.integrations)    ? merged.integrations    : [],
    differentiators:    Array.isArray(merged.differentiators) ? merged.differentiators : [],
    unique_claims:      Array.isArray(merged.unique_claims)   ? merged.unique_claims   : [],
    competitors_mentioned: Array.isArray(merged.competitors_mentioned) ? merged.competitors_mentioned : [],
    statistics:         Array.isArray(merged.statistics)      ? merged.statistics      : [],
    customer_quotes:    Array.isArray(merged.customer_quotes) ? merged.customer_quotes : [],
    case_studies:       Array.isArray(merged.case_studies)    ? merged.case_studies    : [],
    notable_customers:  Array.isArray(merged.notable_customers) ? merged.notable_customers : [],
    pain_points:        Array.isArray(merged.pain_points)     ? merged.pain_points     : [],
    problems_solved:    Array.isArray(merged.problems_solved) ? merged.problems_solved : [],
    buyer_fears:        Array.isArray(merged.buyer_fears)     ? merged.buyer_fears     : [],
    pricing_model:      merged.pricing_model      || null,
    pricing_tiers:      Array.isArray(merged.pricing_tiers)   ? merged.pricing_tiers   : [],
    free_trial:         merged.free_trial         != null ? merged.free_trial : null,
    pricing_signals:    Array.isArray(merged.pricing_signals) ? merged.pricing_signals : [],
    source_url:         solutionUrl,
    researched_at:      new Date().toISOString(),
  };

  const elapsed = Date.now() - t0;
  const okCount = agentResults.filter(r => r.status === 'ok').length;
  console.log(`  [Swarm] Complete: ${okCount}/${AGENTS.length} agents succeeded in ${elapsed}ms`);

  return { msip, agents: agentResults, elapsed };
}

// ── runDeepFill ──────────────────────────────────────────────────────────────

/**
 * Phase 2 — Background deep-fill enrichment.
 *
 * Runs after the HTTP response has already been sent to the client.
 * Ingests additional content sources (competitor pages, review sites, etc.)
 * into the TDE collection to enrich the knowledge base over time.
 *
 * @param {TDEngine} engine        - The TDE engine instance from server.js
 * @param {string}   collectionId  - Target collection to enrich
 * @param {string}   solutionUrl   - The primary solution URL
 * @param {string}   solutionName  - Human-readable product name
 * @param {object}   msip          - The MSIP produced by runSwarm
 * @returns {Promise<void>}
 */
async function runDeepFill(engine, collectionId, solutionUrl, solutionName, msip) {
  console.log(`  [DeepFill] Starting background enrichment for: ${collectionId}`);

  const productName = msip.product_name || solutionName || domainFromUrl(solutionUrl);

  // Build a list of supplementary ingest tasks.
  // Each task is attempted independently — failures are logged but do not
  // propagate, since this runs in the background with no client waiting.
  const tasks = [];

  // Task 1: Ingest a structured competitive summary as a text document
  // so the collection has a baseline even if LLM calls are unavailable.
  if (msip.differentiators.length > 0 || msip.capabilities.length > 0) {
    const competitiveSummary = buildCompetitiveSummaryText(msip, solutionUrl);
    if (competitiveSummary.length > 100) {
      tasks.push({
        label: 'competitive_summary',
        fn: () => engine.ingest(collectionId, 'text', competitiveSummary, {
          title: `${productName} — Competitive Summary (Deep Fill)`,
          context: 'Structured competitive intelligence derived from MSIP swarm research',
        }),
      });
    }
  }

  // Task 2: Attempt to ingest a proof-points document if we have evidence
  if (msip.statistics.length > 0 || msip.customer_quotes.length > 0 || msip.notable_customers.length > 0) {
    const proofText = buildProofPointsText(msip, solutionUrl);
    if (proofText.length > 100) {
      tasks.push({
        label: 'proof_points',
        fn: () => engine.ingest(collectionId, 'text', proofText, {
          title: `${productName} — Proof Points (Deep Fill)`,
          context: 'Customer evidence and social proof from MSIP swarm research',
        }),
      });
    }
  }

  // Task 3: Attempt to ingest a pain-points / buyer-psychology document
  if (msip.pain_points.length > 0 || msip.problems_solved.length > 0) {
    const painText = buildPainPointsText(msip, solutionUrl);
    if (painText.length > 100) {
      tasks.push({
        label: 'pain_points',
        fn: () => engine.ingest(collectionId, 'text', painText, {
          title: `${productName} — Buyer Pain Points (Deep Fill)`,
          context: 'Buyer pain points and problems solved from MSIP swarm research',
        }),
      });
    }
  }

  // Execute tasks sequentially to avoid hammering the LLM pipeline
  let completed = 0;
  for (const task of tasks) {
    try {
      await task.fn();
      completed++;
      console.log(`  [DeepFill] Task "${task.label}" complete (${completed}/${tasks.length})`);
    } catch (err) {
      console.error(`  [DeepFill] Task "${task.label}" failed: ${err.message}`);
    }
    // Small pause between ingest tasks to be kind to downstream services
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`  [DeepFill] Enrichment complete: ${completed}/${tasks.length} tasks succeeded for ${collectionId}`);
}

// ── msipToText ───────────────────────────────────────────────────────────────

/**
 * Serialise an MSIP object into a plain-text block suitable for ingestion
 * into the TDE engine as a 'text' source.
 *
 * The output is intentionally verbose and structured so the munger can
 * extract high-quality atoms from it.
 *
 * @param {object} msip         - MSIP object produced by runSwarm
 * @param {string} solutionUrl  - The source URL (used for attribution)
 * @returns {string}
 */
function msipToText(msip, solutionUrl) {
  const lines = [];

  const productName = msip.product_name || domainFromUrl(solutionUrl);

  lines.push(`MINIMUM SOLUTION INTELLIGENCE PROFILE`);
  lines.push(`Product: ${productName}`);
  lines.push(`Source: ${solutionUrl}`);
  if (msip.researched_at) lines.push(`Researched: ${msip.researched_at}`);
  lines.push('');

  // Identity
  if (msip.category)          lines.push(`Category: ${msip.category}`);
  if (msip.tagline)           lines.push(`Tagline: ${msip.tagline}`);
  if (msip.value_proposition) lines.push(`Value Proposition: ${msip.value_proposition}`);
  if (msip.target_market)     lines.push(`Target Market: ${msip.target_market}`);
  lines.push('');

  // Capabilities
  if (msip.capabilities && msip.capabilities.length > 0) {
    lines.push('CAPABILITIES:');
    msip.capabilities.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }

  if (msip.feature_areas && msip.feature_areas.length > 0) {
    lines.push('FEATURE AREAS:');
    msip.feature_areas.forEach(f => lines.push(`- ${f}`));
    lines.push('');
  }

  if (msip.integrations && msip.integrations.length > 0) {
    lines.push('INTEGRATIONS:');
    msip.integrations.forEach(i => lines.push(`- ${i}`));
    lines.push('');
  }

  // Differentiators
  if (msip.differentiators && msip.differentiators.length > 0) {
    lines.push('DIFFERENTIATORS:');
    msip.differentiators.forEach(d => lines.push(`- ${d}`));
    lines.push('');
  }

  if (msip.unique_claims && msip.unique_claims.length > 0) {
    lines.push('UNIQUE CLAIMS:');
    msip.unique_claims.forEach(u => lines.push(`- ${u}`));
    lines.push('');
  }

  if (msip.competitors_mentioned && msip.competitors_mentioned.length > 0) {
    lines.push('COMPETITORS MENTIONED:');
    msip.competitors_mentioned.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }

  // Proof points
  if (msip.statistics && msip.statistics.length > 0) {
    lines.push('STATISTICS & DATA:');
    msip.statistics.forEach(s => lines.push(`- ${s}`));
    lines.push('');
  }

  if (msip.customer_quotes && msip.customer_quotes.length > 0) {
    lines.push('CUSTOMER QUOTES:');
    msip.customer_quotes.forEach(q => lines.push(`- "${q}"`));
    lines.push('');
  }

  if (msip.case_studies && msip.case_studies.length > 0) {
    lines.push('CASE STUDIES:');
    msip.case_studies.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }

  if (msip.notable_customers && msip.notable_customers.length > 0) {
    lines.push('NOTABLE CUSTOMERS:');
    msip.notable_customers.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }

  // Pain points
  if (msip.pain_points && msip.pain_points.length > 0) {
    lines.push('BUYER PAIN POINTS:');
    msip.pain_points.forEach(p => lines.push(`- ${p}`));
    lines.push('');
  }

  if (msip.problems_solved && msip.problems_solved.length > 0) {
    lines.push('PROBLEMS SOLVED:');
    msip.problems_solved.forEach(p => lines.push(`- ${p}`));
    lines.push('');
  }

  if (msip.buyer_fears && msip.buyer_fears.length > 0) {
    lines.push('BUYER FEARS ADDRESSED:');
    msip.buyer_fears.forEach(f => lines.push(`- ${f}`));
    lines.push('');
  }

  // Pricing
  if (msip.pricing_model) {
    lines.push(`PRICING MODEL: ${msip.pricing_model}`);
  }
  if (msip.pricing_tiers && msip.pricing_tiers.length > 0) {
    lines.push('PRICING TIERS:');
    msip.pricing_tiers.forEach(t => lines.push(`- ${t}`));
  }
  if (msip.free_trial != null) {
    lines.push(`Free Trial Available: ${msip.free_trial ? 'Yes' : 'No'}`);
  }
  if (msip.pricing_signals && msip.pricing_signals.length > 0) {
    lines.push('PRICING SIGNALS:');
    msip.pricing_signals.forEach(s => lines.push(`- ${s}`));
  }

  return lines.join('\n').trim();
}

// ── Internal text builders (used by runDeepFill) ─────────────────────────────

function buildCompetitiveSummaryText(msip, solutionUrl) {
  const productName = msip.product_name || domainFromUrl(solutionUrl);
  const lines = [`COMPETITIVE INTELLIGENCE SUMMARY — ${productName}`, `Source: ${solutionUrl}`, ''];

  if (msip.differentiators && msip.differentiators.length > 0) {
    lines.push('KEY DIFFERENTIATORS:');
    msip.differentiators.forEach(d => lines.push(`- ${d}`));
    lines.push('');
  }
  if (msip.unique_claims && msip.unique_claims.length > 0) {
    lines.push('UNIQUE CLAIMS:');
    msip.unique_claims.forEach(u => lines.push(`- ${u}`));
    lines.push('');
  }
  if (msip.capabilities && msip.capabilities.length > 0) {
    lines.push('CAPABILITIES:');
    msip.capabilities.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }
  if (msip.competitors_mentioned && msip.competitors_mentioned.length > 0) {
    lines.push('COMPETITORS MENTIONED:');
    msip.competitors_mentioned.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }

  return lines.join('\n').trim();
}

function buildProofPointsText(msip, solutionUrl) {
  const productName = msip.product_name || domainFromUrl(solutionUrl);
  const lines = [`PROOF POINTS & SOCIAL PROOF — ${productName}`, `Source: ${solutionUrl}`, ''];

  if (msip.statistics && msip.statistics.length > 0) {
    lines.push('STATISTICS:');
    msip.statistics.forEach(s => lines.push(`- ${s}`));
    lines.push('');
  }
  if (msip.customer_quotes && msip.customer_quotes.length > 0) {
    lines.push('CUSTOMER QUOTES:');
    msip.customer_quotes.forEach(q => lines.push(`- "${q}"`));
    lines.push('');
  }
  if (msip.notable_customers && msip.notable_customers.length > 0) {
    lines.push('NOTABLE CUSTOMERS:');
    msip.notable_customers.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }
  if (msip.case_studies && msip.case_studies.length > 0) {
    lines.push('CASE STUDIES:');
    msip.case_studies.forEach(c => lines.push(`- ${c}`));
    lines.push('');
  }

  return lines.join('\n').trim();
}

function buildPainPointsText(msip, solutionUrl) {
  const productName = msip.product_name || domainFromUrl(solutionUrl);
  const lines = [`BUYER PAIN POINTS & PSYCHOLOGY — ${productName}`, `Source: ${solutionUrl}`, ''];

  if (msip.pain_points && msip.pain_points.length > 0) {
    lines.push('PAIN POINTS:');
    msip.pain_points.forEach(p => lines.push(`- ${p}`));
    lines.push('');
  }
  if (msip.problems_solved && msip.problems_solved.length > 0) {
    lines.push('PROBLEMS SOLVED:');
    msip.problems_solved.forEach(p => lines.push(`- ${p}`));
    lines.push('');
  }
  if (msip.buyer_fears && msip.buyer_fears.length > 0) {
    lines.push('BUYER FEARS ADDRESSED:');
    msip.buyer_fears.forEach(f => lines.push(`- ${f}`));
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = { runSwarm, runDeepFill, msipToText };
