/**
 * TDE — Targeted Decomposition Engine
 * Configuration
 * ═══════════════════════════════════════════════════════════════════
 * Dual taxonomy: DIMENSIONS (6D atom tagging) + TEMPLATES (vertical extractors)
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
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'mistralai/mistral-embed-2312',

  // External services
  YOUTUBE_API_KEY:    process.env.YOUTUBE_API_KEY    || '',
  GROQ_API_KEY:       process.env.GROQ_API_KEY       || '',
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || '',

  // Service APIs (each service owns its domain — no forking)
  TRUEWRITING_API_URL: process.env.TRUEWRITING_API_URL || '',
  TRUEGRAPH_API_URL:   process.env.TRUEGRAPH_API_URL   || '',

  // Storage
  DATABASE_URL:        process.env.DATABASE_URL       || '',
  QDRANT_URL:          process.env.QDRANT_URL         || '',
  QDRANT_API_KEY:      process.env.QDRANT_API_KEY     || '',
  EMBEDDING_DIMENSION: parseInt(process.env.EMBEDDING_DIMENSION || '1024'),
  DATA_DIR:            process.env.DATA_DIR           || './data',

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
    credibility: [1, 2, 3, 4, 5],
    recency_tier: ['Current Quarter', 'This Year', 'Last 1-2 Years', 'Dated (3-5yr)', 'Evergreen'],
  },

  // ── Collection Templates ──────────────────────────────────────────────────
  // Core extractors always run: communication, topics
  // Template extractors add domain-specific fields on top.
  //
  // Available extractors:
  //   communication    → style, vocabulary, persuasion, pacing, emotion, hooks
  //   topics           → topic extraction with depth, sentiment, timestamps
  //   food             → restaurant_name, dish_name, rating, cuisine_type, location
  //   religion         → verse_reference, theme, message_summary, audience_application
  //   products         → product_name, category, sentiment, is_sponsored
  //   speaker_separation → speakers_identified, talk%, communication_style per speaker
  //   competitive      → competitors, differentiators, objections, social_proof
  //   pitch_ready      → counter_ammunition, pitch_fragments, knowledge_gaps
  //   objections       → objections raised, responses, effectiveness scores
  //   comments         → audience questions, product mentions, sentiment, viral indicators

  TEMPLATES: {

    influencer: {
      id: 'influencer',
      name: 'TrueInfluence',
      description: 'Content creator / influencer — voice, topics, products, and audience intel',
      extractors: ['communication', 'topics', 'food', 'products', 'comments'],
    },

    church: {
      id: 'church',
      name: 'TrueTeachings',
      description: 'Sermon and religious content — verse extraction and theological themes',
      extractors: ['communication', 'topics', 'religion', 'comments'],
      sermonFields: [
        'sermon_title', 'series_name', 'verse_reference', 'theme',
        'message_summary', 'audience_application', 'connected_verses',
        'emotional_intensity', 'timestamp',
      ],
    },

    food: {
      id: 'food',
      name: 'TrueFood',
      description: 'Food influencer — every restaurant, dish, and opinion extracted',
      extractors: ['communication', 'food', 'products', 'comments'],
    },

    influencereats: {
      id: 'influencereats',
      name: 'InfluencerEats',
      description: 'Food discovery map — restaurant pins with structured review data',
      extractors: ['communication', 'food', 'comments'],
      pinSchema: {
        restaurant_name:     'string',
        restaurant_location: 'string — city, neighborhood, or address',
        food_selected:       'string — dish ordered',
        food_review:         'string — direct quote from creator',
        rating:              'good | meh | bad',
        video_timestamp:     'MM:SS',
        source_video_id:     'string',
        source_channel:      'string',
        confidence:          '0.0 – 1.0',
      },
    },

    business: {
      id: 'business',
      name: 'TrueComms',
      description: 'Business communication, competitive intelligence, Pretty Good Pitch',
      extractors: ['communication', 'topics', 'objections', 'competitive', 'pitch_ready'],
    },

    couple: {
      id: 'couple',
      name: 'TrueCouple',
      description: 'Couple content creators — speaker-separated analysis',
      extractors: ['communication', 'topics', 'food', 'products', 'speaker_separation', 'comments'],
    },

    education: {
      id: 'education',
      name: 'TrueTeach',
      description: 'Educational content — topics, depth, and audience questions',
      extractors: ['communication', 'topics', 'comments'],
    },

    default: {
      id: 'default',
      name: 'TDE',
      description: 'General content intelligence — use this when no vertical fits',
      extractors: ['communication', 'topics', 'comments'],
    },
  },
};
