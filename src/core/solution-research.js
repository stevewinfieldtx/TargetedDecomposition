/**
 * TDE — Solution Research Module
 * Two-phase research: Swarm (paid, parallel, fast) + Deep Fill (free, background, thorough)
 */

const config = require('../config');
const { callLLM } = require('../utils/llm');

const MSIP_FIELDS = {
  product_name:       'Official product or solution name',
  vendor_name:        'Company that makes/sells the product',
  product_category:   'Category (e.g., ERP, Endpoint Security, Email Security, RMM, SIEM)',
  tagline:            'One-sentence value proposition',
  core_capabilities:  'Array of 5-10 specific technical capabilities',
  deployment_model:   'SaaS, on-prem, hybrid, cloud-only, etc.',
  target_market:      'Who is this built for? (SMB, mid-market, enterprise, specific verticals)',
  target_buyer:       'Primary buyer persona (CTO, CISO, CFO, IT Director, etc.)',
  pain_points_solved: 'Array of 5-8 specific business problems this product addresses',
  differentiators:    'Array of 3-5 things that make this genuinely different from competitors',
  competitors:        'Array of known competitive products',
  proof_points:       'Any discoverable statistics, case studies, awards, analyst mentions',
  pricing_model:      'Pricing structure if discoverable (per-user, per-device, tiered, etc.)',
  integrations:       'Key technology integrations and partnerships',
  certifications:     'Security/compliance certifications (SOC2, ISO27001, HIPAA, etc.)',
  sales_channel:      'How it is sold: direct, channel/VAR, marketplace, etc.',
};

const SWARM_AGENTS = [
  {
    id: 'product_identity',
    name: 'Product Identity Agent',
    fields: ['product_name', 'vendor_name', 'product_category', 'tagline', 'deployment_model', 'target_market', 'target_buyer', 'sales_channel'],
    prompt: 'You are a product research specialist. Given a solution URL, determine exactly what this product is, who makes it, what category it falls in, who it is built for, and how it is sold. Be specific. If you cannot determine something, say "UNKNOWN" rather than guessing.',
  },
  {
    id: 'capabilities_pain',
    name: 'Capabilities & Pain Agent',
    fields: ['core_capabilities', 'pain_points_solved'],
    prompt: 'You are a technical product analyst. Given a solution URL, identify the specific technical capabilities (not marketing language — what does it actually DO?) and the specific business problems it solves. List 5-10 capabilities and 5-8 pain points. Be concrete.',
  },
  {
    id: 'competitive_landscape',
    name: 'Competitive Intelligence Agent',
    fields: ['differentiators', 'competitors'],
    prompt: 'You are a competitive intelligence analyst. Given a solution URL, identify its main competitors and what genuinely differentiates this product. Do not list generic differentiators like "easy to use" — find the real ones. Name specific competing products.',
  },
  {
    id: 'evidence_ecosystem',
    name: 'Evidence & Ecosystem Agent',
    fields: ['proof_points', 'pricing_model', 'integrations', 'certifications'],
    prompt: 'You are a market research analyst. Given a solution URL, find any proof points (statistics, case studies, awards, analyst mentions), pricing information, key integrations, and compliance certifications. Report only what you can actually verify — never fabricate data.',
  },
];

const DEEP_FILL_TOPICS = [
  { id: 'customer_reviews', prompt: 'Find real customer reviews, testimonials, and user feedback. What do actual users say — both positive and negative? Include specific quotes or sentiments if possible.' },
  { id: 'implementation_details', prompt: 'Research the typical implementation process. How long does deployment take? What does onboarding look like? What are common implementation challenges? What is the time-to-value?' },
  { id: 'competitive_deep_dive', prompt: 'Do a deep competitive comparison. How does this product compare feature-by-feature against its top 3 competitors? Where does it win? Where does it lose?' },
  { id: 'pricing_deep_dive', prompt: 'Research pricing in detail. What are the tiers? What does it cost per user or per device? What is the typical total cost of ownership? Are there hidden costs?' },
  { id: 'integration_ecosystem', prompt: 'Map the integration ecosystem. What does this product integrate with? Is there an API? A marketplace? Key technology partnerships?' },
  { id: 'vertical_use_cases', prompt: 'Identify specific industry/vertical use cases. Which industries is this product strongest in? Are there vertical-specific features?' },
  { id: 'partner_channel', prompt: 'Research the partner/channel ecosystem. Is there a partner program? What does it look like for VARs, MSPs, or resellers? What are the partner tiers, margins, requirements?' },
  { id: 'company_background', prompt: 'Research the company behind the product. When were they founded? Funding history? Key leadership? Size? Headquarters? Any recent acquisitions?' },
  { id: 'security_compliance', prompt: 'Research security and compliance posture. What certifications do they hold? GDPR compliance? Data residency options? Encryption standards?' },
  { id: 'roadmap_trends', prompt: 'Research recent product developments and future direction. What features have been released recently? Any roadmap announcements? AI/ML capabilities?' },
];

async function runSwarm(solutionUrl, solutionName, webContent) {
  const model = config.ANALYSIS_MODEL;
  const context = 'SOLUTION URL: ' + solutionUrl + '\n' + (solutionName ? 'SOLUTION NAME: ' + solutionName + '\n' : '') + (webContent ? '\nWEBSITE CONTENT (extracted):\n' + webContent.slice(0, 6000) + '\n' : '');

  console.log('  [Swarm] Launching ' + SWARM_AGENTS.length + ' agents in parallel...');
  var t0 = Date.now();

  var results = await Promise.allSettled(
    SWARM_AGENTS.map(async function(agent) {
      var fieldList = agent.fields.map(function(f) { return '- ' + f + ': ' + MSIP_FIELDS[f]; }).join('\n');
      var prompt = agent.prompt + '\n\n' + context + '\n\nReturn a JSON object with these fields:\n' + fieldList + '\n\nReturn ONLY valid JSON. No markdown fences. No explanation.';

      try {
        var raw = await callLLM(prompt, {
          model: model,
          system: 'You are a research agent. Return only valid JSON.',
          maxTokens: 3000,
          temperature: 0.2,
        });
        if (!raw) return { agentId: agent.id, error: 'No response' };

        var cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        try {
          var parsed = JSON.parse(cleaned);
          console.log('  [Swarm] ' + agent.name + ': done');
          return { agentId: agent.id, name: agent.name, data: parsed };
        } catch (e) {
          console.log('  [Swarm] ' + agent.name + ': JSON parse failed');
          return { agentId: agent.id, name: agent.name, data: null, raw: raw };
        }
      } catch (err) {
        console.log('  [Swarm] ' + agent.name + ': error — ' + err.message);
        return { agentId: agent.id, name: agent.name, error: err.message };
      }
    })
  );

  var elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('  [Swarm] All agents complete in ' + elapsed + 's');

  var msip = {};
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (r.status === 'fulfilled' && r.value.data) {
      Object.assign(msip, r.value.data);
    }
  }

  return {
    msip: msip,
    agents: results.map(function(r) { return r.status === 'fulfilled' ? r.value : { error: r.reason ? r.reason.message : 'unknown' }; }),
    elapsed: parseFloat(elapsed),
  };
}

async function runDeepFill(engine, collectionId, solutionUrl, solutionName, msip) {
  var FREE_MODEL = 'openrouter/free';
  var context = 'SOLUTION: ' + (solutionName || msip.product_name || 'Unknown') + '\nVENDOR: ' + (msip.vendor_name || 'Unknown') + '\nCATEGORY: ' + (msip.product_category || 'Unknown') + '\nURL: ' + solutionUrl + '\n\nKNOWN CAPABILITIES: ' + JSON.stringify(msip.core_capabilities || []) + '\nKNOWN COMPETITORS: ' + JSON.stringify(msip.competitors || []);

  console.log('\n  [Deep Fill] Starting background research (' + DEEP_FILL_TOPICS.length + ' topics, free models)...');

  for (var i = 0; i < DEEP_FILL_TOPICS.length; i++) {
    var topic = DEEP_FILL_TOPICS[i];
    console.log('  [Deep Fill] [' + (i + 1) + '/' + DEEP_FILL_TOPICS.length + '] ' + topic.id + '...');

    try {
      var prompt = topic.prompt + '\n\n' + context + '\n\nProvide detailed, specific findings. If you cannot find information on a sub-topic, skip it rather than making things up.';

      var result = await callLLM(prompt, {
        model: FREE_MODEL,
        system: 'You are a thorough market research analyst. Provide detailed, factual research. Never fabricate data.',
        maxTokens: 4000,
        temperature: 0.3,
      });

      if (result && result.length > 50) {
        await engine.ingest(collectionId, 'text', result, {
          title: (solutionName || msip.product_name || 'Solution') + ' — ' + topic.id.replace(/_/g, ' '),
          context: 'Deep research on ' + topic.id + ' for ' + (solutionName || solutionUrl),
        });
        console.log('  [Deep Fill] ' + topic.id + ': ingested');
      } else {
        console.log('  [Deep Fill] ' + topic.id + ': no useful content returned');
      }
    } catch (err) {
      console.log('  [Deep Fill] ' + topic.id + ': error — ' + err.message);
    }

    // Rate limit courtesy for free models
    await new Promise(function(r) { setTimeout(r, 4000); });
  }

  console.log('  [Deep Fill] Background research complete for ' + collectionId);
}

function msipToText(msip, solutionUrl) {
  var sections = [];
  var name = msip.product_name || 'Unknown Product';
  var vendor = msip.vendor_name || 'Unknown Vendor';

  sections.push(name + ' by ' + vendor + ' — Product Overview');
  if (msip.tagline) sections.push('Value proposition: ' + msip.tagline);
  if (msip.product_category) sections.push('Category: ' + msip.product_category);
  if (msip.deployment_model) sections.push('Deployment: ' + msip.deployment_model);
  if (msip.target_market) sections.push('Target market: ' + msip.target_market);
  if (msip.target_buyer) sections.push('Primary buyer: ' + msip.target_buyer);
  if (msip.sales_channel) sections.push('Sales channel: ' + msip.sales_channel);

  if (Array.isArray(msip.core_capabilities) && msip.core_capabilities.length) {
    sections.push('\nCore Capabilities:\n' + msip.core_capabilities.map(function(c) { return '- ' + c; }).join('\n'));
  }
  if (Array.isArray(msip.pain_points_solved) && msip.pain_points_solved.length) {
    sections.push('\nPain Points Solved:\n' + msip.pain_points_solved.map(function(p) { return '- ' + p; }).join('\n'));
  }
  if (Array.isArray(msip.differentiators) && msip.differentiators.length) {
    sections.push('\nDifferentiators:\n' + msip.differentiators.map(function(dd) { return '- ' + dd; }).join('\n'));
  }
  if (Array.isArray(msip.competitors) && msip.competitors.length) {
    sections.push('\nCompetitors: ' + msip.competitors.join(', '));
  }
  if (Array.isArray(msip.proof_points) && msip.proof_points.length) {
    sections.push('\nProof Points:\n' + msip.proof_points.map(function(p) { return typeof p === 'string' ? '- ' + p : '- ' + JSON.stringify(p); }).join('\n'));
  }
  if (msip.pricing_model) sections.push('\nPricing: ' + (typeof msip.pricing_model === 'string' ? msip.pricing_model : JSON.stringify(msip.pricing_model)));
  if (Array.isArray(msip.integrations) && msip.integrations.length) {
    sections.push('\nKey Integrations: ' + msip.integrations.join(', '));
  }
  if (Array.isArray(msip.certifications) && msip.certifications.length) {
    sections.push('\nCertifications: ' + msip.certifications.join(', '));
  }

  return sections.join('\n');
}

module.exports = {
  MSIP_FIELDS: MSIP_FIELDS,
  SWARM_AGENTS: SWARM_AGENTS,
  DEEP_FILL_TOPICS: DEEP_FILL_TOPICS,
  runSwarm: runSwarm,
  runDeepFill: runDeepFill,
  msipToText: msipToText,
};
