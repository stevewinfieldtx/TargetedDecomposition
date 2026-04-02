/**
 * TDE — Analyzers
 * ═══════════════════════════════════════════════════════════════════
 * Deep content extraction via LLM. Each extractor is a focused prompt
 * that pulls structured data from atoms or content segments.
 *
 * Extractors: communication, topics, food, religion, products,
 *             competitive, pitch_ready, speaker_separation, objections,
 *             comments (mines audience comments for actionable insight)
 */

const { callLLMJSON, callLLM } = require('../utils/llm');
const config = require('../config');

async function analyzeCommunication(atoms, sourceMetadata) {
  const sampleText = atoms.slice(0, 15).map(c => c.text).join('\n\n---\n\n');
  return callLLMJSON(`Analyze this content across communication dimensions.\n\nCONTENT:\n${sampleText.slice(0, 12000)}\n\nReturn JSON:\n{\n  "communication_style": {\n    "primary_mode": "teacher|storyteller|debater|motivator|analyst|entertainer|advisor",\n    "secondary_mode": "...",\n    "description": "2-3 sentence summary"\n  },\n  "vocabulary": {\n    "complexity_level": "basic|intermediate|advanced|expert",\n    "signature_phrases": ["list of recurring phrases"],\n    "filler_patterns": ["um", "like", "you know"],\n    "unique_expressions": ["distinctive phrases this person uses"]\n  },\n  "persuasion_style": "data_driven|anecdotal|authoritative|empathetic|mixed",\n  "pacing": "rapid|moderate|deliberate|variable",\n  "emotional_range": {\n    "primary_tone": "...",\n    "passion_triggers": ["topics that increase energy"],\n    "calm_topics": ["topics discussed more neutrally"]\n  },\n  "audience_relationship": "peer|mentor|entertainer|authority|friend",\n  "storytelling_density": "low|medium|high",\n  "humor_frequency": "rare|occasional|frequent|constant",\n  "call_to_action_style": "direct|subtle|none|mixed",\n  "engagement_hooks": ["how they grab attention"],\n  "closing_patterns": ["how they end segments"]\n}`, { model: config.ANALYSIS_MODEL, system: 'You are a communication analyst. Return ONLY valid JSON.', maxTokens: 3000 });
}

async function extractTopics(atoms) {
  const text = atoms.map(c => `[${formatTime(c.startTime || c.start_time)}] ${c.text}`).join('\n').slice(0, 15000);
  return callLLMJSON(`Extract all topics discussed in this content.\n\nCONTENT:\n${text}\n\nReturn JSON array of topics:\n[\n  {\n    "topic": "topic name",\n    "subtopics": ["specific subtopics"],\n    "mentions": 3,\n    "timestamps": ["0:00", "2:15"],\n    "depth": "surface|moderate|deep",\n    "sentiment": "positive|neutral|negative|mixed"\n  }\n]`, { system: 'Extract topics from content. Return ONLY a JSON array.', maxTokens: 3000 });
}

async function extractFood(atoms) {
  const text = atoms.map(c => `[${formatTime(c.startTime || c.start_time)}] ${c.text}`).join('\n').slice(0, 15000);
  return callLLMJSON(`You are a food content analyst. Extract EVERY mention of food, restaurants, dishes, and dining experiences from this content. Miss NOTHING.\n\nCONTENT:\n${text}\n\nFor EACH food/restaurant mention, extract:\n[\n  {\n    "restaurant_name": "exact name or null",\n    "dish_name": "what they ate/discussed or null",\n    "rating": "hate|dislike|meh|good|great|not_rated",\n    "rating_quotes": "exact words they used about it",\n    "cuisine_type": "Italian|Vietnamese|etc or unknown",\n    "location_description": "any location clues mentioned",\n    "price_mentioned": "any price references or null",\n    "timestamp": "MM:SS when discussed",\n    "speaker": "who is talking about it if identifiable",\n    "context": "brief context of the mention",\n    "recommended": true\n  }\n]\n\nBe exhaustive. Include passing mentions, not just reviews.`, { system: 'You are a food content extraction specialist. Miss nothing. Return ONLY valid JSON array.', maxTokens: 4000 });
}

async function extractReligion(atoms) {
  const text = atoms.map(c => `[${formatTime(c.startTime || c.start_time)}] ${c.text}`).join('\n').slice(0, 15000);
  return callLLMJSON(`You are a theological content analyst. Extract EVERY religious reference, Bible verse, spiritual theme, and teaching point from this content.\n\nCONTENT:\n${text}\n\nFor EACH religious reference:\n[\n  {\n    "type": "verse|theme|doctrine|testimony|prayer|illustration|application",\n    "verse_reference": "John 3:16 or null",\n    "theme": "forgiveness|grace|faith|love|etc",\n    "message_summary": "what point is being made",\n    "timestamp": "MM:SS",\n    "speaker": "who is speaking",\n    "emotional_intensity": "low|medium|high",\n    "audience_application": "how this applies to listeners",\n    "connected_verses": ["other verses referenced in context"]\n  }\n]\n\nBe exhaustive. Include subtle references not just explicit scripture quotes.`, { system: 'Theological content extraction specialist. Return ONLY valid JSON array.', maxTokens: 4000 });
}

async function extractProducts(atoms) {
  const text = atoms.map(c => `[${formatTime(c.startTime || c.start_time)}] ${c.text}`).join('\n').slice(0, 15000);
  return callLLMJSON(`Extract ALL product mentions, brand references, and recommendations from this content.\n\nCONTENT:\n${text}\n\nFor EACH product/brand mention:\n[\n  {\n    "product_name": "exact product or brand",\n    "category": "tech|fashion|food|beauty|home|other",\n    "sentiment": "positive|neutral|negative|mixed",\n    "is_sponsored": true,\n    "recommendation_strength": "none|mild|strong|enthusiastic",\n    "timestamp": "MM:SS",\n    "speaker": "who mentioned it",\n    "context": "how it came up"\n  }\n]`, { system: 'Product and brand extraction specialist. Return ONLY valid JSON array.', maxTokens: 3000 });
}

async function separateSpeakers(atoms, speakerNames = []) {
  const text = atoms.map(c => `[${formatTime(c.startTime || c.start_time)}] ${c.text}`).join('\n').slice(0, 15000);
  const nameHint = speakerNames.length ? `Known speakers: ${speakerNames.join(', ')}.` : 'Identify speakers by voice characteristics, content, or context clues.';
  return callLLMJSON(`Analyze this transcript and identify which speaker is talking in each segment. ${nameHint}\n\nCONTENT:\n${text}\n\nReturn speaker annotations:\n{\n  "speakers_identified": ["Speaker A name/label", "Speaker B name/label"],\n  "segments": [\n    {\n      "timestamp": "MM:SS",\n      "speaker": "speaker name/label",\n      "confidence": 0.9,\n      "text_excerpt": "first 10 words..."\n    }\n  ],\n  "speaker_profiles": {\n    "Speaker A": {\n      "estimated_talk_percentage": 55,\n      "topics_led": ["topics this speaker initiated"],\n      "communication_style": "brief description"\n    }\n  }\n}`, { system: 'Speaker diarization and attribution specialist. Return ONLY valid JSON.', maxTokens: 4000 });
}

async function extractCompetitive(atoms) {
  const text = atoms.map(c => `[${formatTime(c.startTime || c.start_time)}] ${c.text}`).join('\n').slice(0, 15000);
  return callLLMJSON(`Analyze this business content for competitive intelligence signals.\n\nCONTENT:\n${text}\n\nExtract:\n{\n  "competitors_mentioned": [\n    { "name": "...", "context": "how mentioned", "sentiment": "positive|neutral|negative", "timestamp": "MM:SS" }\n  ],\n  "differentiators_claimed": ["unique value props stated"],\n  "objections_addressed": [\n    { "objection": "the concern raised", "response": "how they addressed it", "effectiveness": "weak|moderate|strong" }\n  ],\n  "pricing_signals": ["any pricing or value discussions"],\n  "pain_points_targeted": ["customer problems discussed"],\n  "social_proof": ["case studies, testimonials, numbers cited"],\n  "closing_techniques": ["how they move toward action"]\n}`, { system: 'Competitive intelligence analyst. Return ONLY valid JSON.', maxTokens: 3000 });
}

async function extractPitchReady(atoms, productContext = '') {
  const text = atoms.map(c => `[${formatTime(c.startTime || c.start_time)}] ${c.text}`).join('\n').slice(0, 15000);
  return callLLMJSON(`Analyze this content to build a "Pretty Good Pitch" knowledge base.\n\n${productContext ? `PRODUCT CONTEXT: ${productContext}\n` : ''}\nCONTENT:\n${text}\n\nReturn:\n{\n  "solution_depth": {\n    "problems_solved": ["specific problems addressed"],\n    "implementation_details": ["how it actually works"],\n    "limitations_acknowledged": ["honest limitations"],\n    "integration_points": ["what it connects with"]\n  },\n  "counter_ammunition": [\n    {\n      "competitive_claim": "what a competitor might say",\n      "counter": "the substantive response",\n      "evidence": "proof point from the content",\n      "timestamp": "MM:SS"\n    }\n  ],\n  "pitch_fragments": [\n    {\n      "context": "what situation this addresses",\n      "content": "the actual pitch language",\n      "strength": "the proof behind it",\n      "timestamp": "MM:SS"\n    }\n  ],\n  "knowledge_gaps": ["topics that need more content"]\n}`, { system: 'Sales enablement and competitive intelligence specialist. Return ONLY valid JSON.', maxTokens: 4000 });
}

async function mineComments(comments, sourceMetadata) {
  if (!comments || comments.length === 0) return { status: 'no_comments' };
  const commentText = comments.map((c, i) =>
    `[${i+1}] ${c.author}: "${c.text}" (${c.likeCount} likes${c.replyCount > 0 ? ', ' + c.replyCount + ' replies' : ''})`
  ).join('\n').slice(0, 15000);
  return callLLMJSON(`You are an audience intelligence analyst. Analyze these comments to extract actionable insights.\n\nVIDEO: "${sourceMetadata.title || 'Unknown'}"\nVIDEO STATS: ${sourceMetadata.viewCount || 0} views, ${sourceMetadata.likeCount || 0} likes\n\nCOMMENTS:\n${commentText}\n\nReturn JSON:\n{\n  "questions_asked": [{"question":"...","frequency":1,"content_opportunity":"...","urgency":"low|medium|high"}],\n  "content_requests": [{"request":"...","frequency":1,"viability":"easy|moderate|hard"}],\n  "product_mentions": [{"product_or_place":"...","context":"...","affiliate_opportunity":true,"frequency":1}],\n  "sentiment_summary": {"overall":"positive|mixed|negative","what_they_love":[],"what_they_want_different":[],"emotional_triggers":[]},\n  "audience_segments": [{"segment":"...","size_estimate":"small|medium|large","interests":[],"monetization_angle":"..."}],\n  "top_comment_themes": [{"theme":"...","count":5,"actionable_insight":"..."}],\n  "viral_indicators": {"share_intent":[],"save_intent":[],"controversy":[]}\n}\n\nFocus on ACTIONABLE intelligence.`,
  { model: config.ANALYSIS_MODEL, system: 'Audience intelligence analyst. Return ONLY valid JSON.', maxTokens: 5000 });
}

async function runAnalysis(atoms, sourceMetadata, templateId = 'default') {
  const template = config.TEMPLATES[templateId] || config.TEMPLATES.default;
  const extractors = template.extractors || ['communication', 'topics'];
  const results = { templateId, extractors: {}, analyzedAt: new Date().toISOString() };
  console.log(`  Running ${extractors.length} extractors: ${extractors.join(', ')}`);

  for (const ext of extractors) {
    console.log(`  > ${ext}...`);
    try {
      switch (ext) {
        case 'communication': results.extractors.communication = await analyzeCommunication(atoms, sourceMetadata); break;
        case 'topics': results.extractors.topics = await extractTopics(atoms); break;
        case 'food': results.extractors.food = await extractFood(atoms); break;
        case 'religion': results.extractors.religion = await extractReligion(atoms); break;
        case 'products': results.extractors.products = await extractProducts(atoms); break;
        case 'speaker_separation': results.extractors.speakers = await separateSpeakers(atoms, sourceMetadata.speakerNames || []); break;
        case 'competitive': results.extractors.competitive = await extractCompetitive(atoms); break;
        case 'pitch_ready': results.extractors.pitchReady = await extractPitchReady(atoms, sourceMetadata.productContext || ''); break;
        case 'objections': results.extractors.objections = await extractCompetitive(atoms); break;
        case 'comments': results.extractors.comments = await mineComments(sourceMetadata._comments || [], sourceMetadata); break;
        default: console.log(`  Unknown extractor: ${ext}`);
      }
      console.log(`  OK: ${ext}`);
    } catch (err) {
      console.error(`  FAIL: ${ext}: ${err.message}`);
      results.extractors[ext] = { error: err.message };
    }
  }
  return results;
}

function formatTime(seconds) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

module.exports = { analyzeCommunication, extractTopics, extractFood, extractReligion, extractProducts, separateSpeakers, extractCompetitive, extractPitchReady, mineComments, runAnalysis };
