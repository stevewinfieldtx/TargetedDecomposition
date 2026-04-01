/**
 * TDE — Targeted Decomposition Engine
 * Configuration
 */

require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 8400,

  // OpenRouter
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',

  // Models
  ANALYSIS_MODEL:  process.env.ANALYSIS_MODEL  || 'qwen/qwen-2.5-72b-instruct',
  CONTENT_MODEL:   process.env.CONTENT_MODEL   || 'meta-llama/llama-3.1-70b-instruct',
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'sentence-transformers/multi-qa-mpnet-base-dot-v1',

  // External services
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || '',
  GROQ_API_KEY:    process.env.GROQ_API_KEY    || '',

  // Storage
  DATABASE_URL:       process.env.DATABASE_URL       || '',
  QDRANT_URL:         process.env.QDRANT_URL         || '',
  QDRANT_API_KEY:     process.env.QDRANT_API_KEY     || '',
  EMBEDDING_DIMENSION: parseInt(process.env.EMBEDDING_DIMENSION || '768'),
  DATA_DIR:           process.env.DATA_DIR           || './data',

  // API security
  API_SECRET_KEY: process.env.API_SECRET_KEY || '',

  // ── 6D Taxonomy ────────────────────────────────────────────────────────────
  // The six dimensions every atom is tagged across.
  // Edit these values to tune for your domain.

  DIMENSIONS: {
    persona: ['Executive/C-Suite', 'CFO/Finance', 'CISO/Security', 'CTO/IT', 'VP Sales', 'VP Marketing', 'Operations', 'Practitioner', 'End User', 'General'],
    buying_stage: ['Awareness', 'Interest', 'Evaluation', 'Decision', 'Retention', 'Advocacy'],
    emotional_driver: ['Fear/Risk', 'Aspiration/Growth', 'Validation/Proof', 'Curiosity', 'Trust/Credibility', 'Urgency', 'FOMO'],
    evidence_type: ['Statistic/Data', 'Case Study', 'Analyst Report', 'Customer Quote', 'Framework/Model', 'Anecdote/Story', 'Expert Opinion', 'Product Demo', 'Comparison', 'Definition'],
    credibility: [1, 2, 3, 4, 5], // 1=anecdotal → 5=tier-1 analyst/peer-reviewed
    recency_tier: ['Current Quarter', 'This Year', 'Last 1-2 Years', 'Dated (3-5yr)', 'Evergreen'],
  },
};
