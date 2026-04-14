/**
 * TDE — Core Engine
 * ═══════════════════════════════════════════════════════════════════
 * INGEST → EXTRACT → MUNGE → TAG → EMBED → STORE → SEARCH → SYNTHESIZE → RECONSTRUCT
 *
 * Universal pipeline. Feed it anything:
 *   youtube  → YouTube video URL
 *   channel  → YouTube channel URL
 *   pdf      → local PDF file path
 *   docx     → local Word doc file path
 *   pptx     → local PowerPoint file path
 *   audio    → local MP3/MP4/WAV/M4A/etc.
 *   text     → raw text string or .txt file path
 *   web      → URL of any web page
 *
 * Every source goes through the same pipeline after extraction:
 *   Munger → 6D Tagger → Embeddings → Store
 *
 * Data gets OUT via:
 *   search()       → filtered vector search, returns ranked atoms with 6D tags
 *   ask()          → RAG Q&A, grounded answer from atoms
 *   reconstruct()  → targeted recomposition into deliverables (emails, briefs, questions, etc.)
 */

const config  = require('../config');
const Store   = require('./store');
const { munge }     = require('./munger');
const { tagAtoms }  = require('./tagger');
const { runAnalysis } = require('./analyzers');
const { batchEmbed, callLLM, generateEmbedding } = require('../utils/llm');
const { v4: uuidv4 } = require('uuid');

const youtube = require('../ingest/youtube');

const MAX_AUTO_RETRIES = 2;
const AUTO_RETRY_DELAYS = [10000, 30000]; // 10s first, 30s second

class TDEngine {
  constructor(dataDir) {
    this.store = new Store(dataDir || config.DATA_DIR);
    console.log('  TDEngine v2.1 initialized');
  }

  // ── Collections ──────────────────────────────────────────────────────────────

  createCollection(id, name, description = '', metadata = {}) {
    return this.store.createCollection(id, name, description, metadata);
  }
  getCollection(id)    { return this.store.getCollection(id); }
  listCollections()    { return this.store.listCollections(); }
  deleteCollection(id) { return this.store.deleteCollection(id); }

  // ── Universal Ingest ─────────────────────────────────────────────────────────

  async ingest(collectionId, type, input, opts = {}) {
    console.log(`\n  TDE Ingest: [${type}] ${input.slice(0, 80)}${input.length > 80 ? '...' : ''}`);
    let content, sourceId, sourceRecord;

    try {
      switch (type.toLowerCase()) {
        case 'youtube': return await this._ingestYouTube(collectionId, input);
        case 'pdf': { const { extractPDF } = require('../ingest/pdf'); content = await extractPDF(input); sourceId = uuidv4().slice(0, 8) + '_pdf'; break; }
        case 'docx': case 'word': { const { extractDOCX } = require('../ingest/docx'); content = await extractDOCX(input); sourceId = uuidv4().slice(0, 8) + '_docx'; break; }
        case 'pptx': case 'powerpoint': { const { extractPPTX } = require('../ingest/pptx'); content = await extractPPTX(input); sourceId = uuidv4().slice(0, 8) + '_pptx'; break; }
        case 'audio': case 'podcast': case 'mp3': case 'mp4': { const { extractAudio } = require('../ingest/audio'); content = await extractAudio(input); sourceId = uuidv4().slice(0, 8) + '_audio'; break; }
        case 'text': case 'transcript': { const { extractText } = require('../ingest/text'); content = extractText(input, opts.title); sourceId = uuidv4().slice(0, 8) + '_text'; break; }
        case 'web': case 'url': { const { extractWeb } = require('../ingest/web'); content = await extractWeb(input); sourceId = uuidv4().slice(0, 8) + '_web'; break; }
        default: throw new Error(`Unknown content type: ${type}. Valid: youtube, pdf, docx, pptx, audio, text, web`);
      }
    } catch (err) { console.error(`  Extraction failed: ${err.message}`); throw err; }

    if (!content || !content.text || content.text.length < 50) throw new Error(`No extractable content from: ${input}`);
    if (opts.title) content.title = opts.title;
    if (opts.author) content.author = opts.author;
    console.log(`  Extracted: "${content.title}" — ${Math.round(content.text.length / 5)} words`);

    sourceRecord = {
      id: sourceId, sourceType: type,
      sourceUrl: type === 'web' ? input : '',
      filePath: ['pdf','docx','pptx','audio','text'].includes(type) ? input : '',
      title: content.title || opts.title || 'Untitled',
      author: content.author || opts.author || '',
      publishedAt: content.publishedAt || '',
      duration: content.duration || 0,
      pageCount: content.pageCount || 0,
      metadata: content.metadata || {},
      status: 'processing',
    };
    await this.store.addSource(collectionId, sourceRecord);

    try {
      const atoms = await this._pipeline(collectionId, sourceId, content, opts.context || '');
      sourceRecord.status = 'ready';
      sourceRecord.metadata = { ...sourceRecord.metadata, atomCount: atoms.length };
      await this.store.addSource(collectionId, sourceRecord);
      console.log(`  Done: ${atoms.length} atoms stored for "${sourceRecord.title}"`);
      return { ...sourceRecord, atomCount: atoms.length };
    } catch (err) {
      const retryCount = sourceRecord.metadata.retryCount || 0;
      if (retryCount < MAX_AUTO_RETRIES) {
        const delay = AUTO_RETRY_DELAYS[retryCount] || 30000;
        sourceRecord.metadata.retryCount = retryCount + 1;
        sourceRecord.metadata.lastError = err.message;
        sourceRecord.metadata.lastRetryAt = new Date().toISOString();
        await this.store.addSource(collectionId, sourceRecord);
        console.log(`  [AUTO-RETRY] ${sourceId} — attempt ${retryCount + 1}/${MAX_AUTO_RETRIES} in ${delay/1000}s (${err.message})`);
        setTimeout(() => {
          this.ingest(collectionId, type, input, { ...opts, _retryCount: retryCount + 1 })
            .catch(e => console.error(`  [AUTO-RETRY] Failed: ${sourceId} — ${e.message}`));
        }, delay);
        return { ...sourceRecord, status: 'processing' };
      }
      sourceRecord.status = 'error';
      sourceRecord.metadata = { ...sourceRecord.metadata, error: err.message, retriesExhausted: true, finalFailedAt: new Date().toISOString() };
      await this.store.addSource(collectionId, sourceRecord);
      throw err;
    }
  }

  // ── Core Pipeline ────────────────────────────────────────────────────────────

  async _pipeline(collectionId, sourceId, content, context = '') {
    console.log(`  Pipeline: munging...`);
    const atoms = await munge(content, sourceId);
    if (!atoms.length) throw new Error('Munger produced no atoms — content may be too short or low-quality');
    console.log(`  Pipeline: ${atoms.length} atoms extracted`);

    console.log(`  Pipeline: tagging 6D metadata...`);
    const tagged = await tagAtoms(atoms, context);

    console.log(`  Pipeline: embedding...`);
    const texts = tagged.map(a => a.text);
    const embeddings = await batchEmbed(texts, 5);
    tagged.forEach((a, i) => { a.embedding = embeddings[i] || null; });
    console.log(`  Pipeline: ${embeddings.filter(Boolean).length}/${tagged.length} embedded`);

    await this.store.storeAtoms(collectionId, sourceId, tagged);
    return tagged;
  }

  // ── YouTube ──────────────────────────────────────────────────────────────────

  async _ingestYouTube(collectionId, videoUrl) {
    const videoId = youtube.extractVideoId(videoUrl);
    if (!videoId) throw new Error(`Invalid YouTube URL: ${videoUrl}`);

    const existing = await this.store.getSource(collectionId, videoId);
    if (existing && existing.status === 'ready') { console.log(`  Already ingested: ${existing.title}`); return existing; }

    const meta = await youtube.getVideoMetadata(videoId);
    let comments = [];
    try { comments = await youtube.getVideoComments(videoId, 50); } catch {}

    const source = {
      id: videoId, sourceType: 'youtube', sourceUrl: videoUrl,
      title: meta?.title || `Video ${videoId}`, author: meta?.author || '',
      publishedAt: meta?.publishedAt || '', duration: meta?.duration || 0,
      metadata: { ...(meta || {}), comments, commentCount: meta?.commentCount || 0, tags: meta?.tags || [] },
      status: 'processing',
    };
    await this.store.addSource(collectionId, source);
    console.log(`  YouTube: ${source.title} (${Math.round(source.duration / 60)}m)`);

    const transcript = await youtube.getTranscript(videoId);
    if (!transcript) {
      const retryCount = source.metadata.retryCount || 0;
      if (retryCount < MAX_AUTO_RETRIES) {
        const delay = AUTO_RETRY_DELAYS[retryCount] || 30000;
        source.metadata.retryCount = retryCount + 1;
        source.metadata.lastError = 'No transcript available';
        source.metadata.lastRetryAt = new Date().toISOString();
        await this.store.addSource(collectionId, source);
        console.log(`  [AUTO-RETRY] ${videoId} — attempt ${retryCount + 1}/${MAX_AUTO_RETRIES} in ${delay/1000}s (no transcript)`);
        setTimeout(() => {
          this._ingestYouTube(collectionId, videoUrl)
            .then(r => r ? console.log(`  [AUTO-RETRY] Success: ${videoId}`) : null)
            .catch(err => console.error(`  [AUTO-RETRY] Failed: ${videoId} — ${err.message}`));
        }, delay);
        return null; // Return null but don't mark error yet
      }
      // Auto-retries exhausted — mark permanent error
      source.status = 'error';
      source.metadata.error = 'No transcript available';
      source.metadata.retriesExhausted = true;
      source.metadata.finalFailedAt = new Date().toISOString();
      await this.store.addSource(collectionId, source);
      return null;
    }

    const content = { text: transcript.text, segments: transcript.segments, title: source.title, author: source.author, duration: source.duration, metadata: source.metadata, sourceUrl: videoUrl };
    const atoms = await this._pipeline(collectionId, videoId, content, `YouTube video: "${source.title}" by ${source.author}`);
    source.status = 'ready'; source.metadata.atomCount = atoms.length;
    await this.store.addSource(collectionId, source);
    return source;
  }

  // ── Channel Ingest ───────────────────────────────────────────────────────────

  async ingestChannel(collectionId, channelInput, maxVideos = 50) {
    console.log(`\n  Scanning channel: ${channelInput}`);
    const videoList = await youtube.getChannelVideoIds(channelInput, maxVideos);
    const results = { total: videoList.length, ingested: 0, errors: 0, skipped: 0 };
    for (let i = 0; i < videoList.length; i++) {
      const { videoId, title } = videoList[i];
      console.log(`\n  [${i + 1}/${videoList.length}] ${title || videoId}`);
      try {
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        const result = await this._ingestYouTube(collectionId, url);
        if (result) { result.status === 'ready' ? results.ingested++ : results.skipped++; }
        else { results.errors++; }
      } catch (err) { console.error(`  Error: ${err.message}`); results.errors++; }
      if (i < videoList.length - 1) await sleep(5000);
    }
    console.log(`\n  Channel complete: ${results.ingested}/${results.total} ingested`);
    return results;
  }

  // ── Batch Ingest ─────────────────────────────────────────────────────────────

  async ingestBatch(collectionId, items, context = '') {
    const results = { total: items.length, ingested: 0, errors: 0 };
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      console.log(`\n  Batch [${i + 1}/${items.length}]: ${item.type} — ${(item.input || '').slice(0, 60)}`);
      try { await this.ingest(collectionId, item.type, item.input, { ...item.opts, context }); results.ingested++; }
      catch (err) { console.error(`  Error: ${err.message}`); results.errors++; }
      if (i < items.length - 1) await sleep(500);
    }
    return results;
  }

  // ── Search ───────────────────────────────────────────────────────────────────

  async search(collectionId, query, topK = 10, filters = {}) {
    const queryEmb = await generateEmbedding(query);
    if (!queryEmb) return this._keywordSearch(collectionId, query, topK);
    const results = await this.store.search(collectionId, queryEmb, topK, filters);
    return results.map(r => ({
      atomId: r.id || r.atom_id, sourceId: r.source_id, text: r.text,
      similarity: Math.round((r.similarity || 0) * 1000) / 10,
      atomType: r.atom_type, persona: r.d_persona, buyingStage: r.d_buying_stage,
      emotionalDriver: r.d_emotional_driver, evidenceType: r.d_evidence_type,
      credibility: r.d_credibility, recency: r.d_recency,
      startTime: r.start_time, pageNumber: r.page_number,
    }));
  }

  async _keywordSearch(collectionId, query, topK) {
    const atoms = await this.store.getAtoms(collectionId);
    const terms = query.toLowerCase().split(/\s+/);
    const scored = atoms
      .map(a => ({ ...a, score: terms.filter(t => a.text.toLowerCase().includes(t)).length / terms.length }))
      .filter(a => a.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
    return scored.map(r => ({ atomId: r.id, sourceId: r.source_id, text: r.text, similarity: Math.round(r.score * 100) }));
  }

  // ── Ask (RAG) ────────────────────────────────────────────────────────────────

  async ask(collectionId, question, filters = {}, topK = 8) {
    const results = await this.search(collectionId, question, topK, filters);
    if (!results.length) return { answer: 'Not enough content to answer this question.', atoms: [] };
    const col = await this.store.getCollection(collectionId);
    const context = results.map((r, i) => `[${i + 1}] ${r.text}`).join('\n\n');
    const filterStr = Object.entries(filters).filter(([,v]) => v).map(([k,v]) => `${k}: ${v}`).join(', ');
    const answer = await callLLM(
      `Answer this question using ONLY the content below:\n\nQUESTION: ${question}${filterStr ? '\nFILTER CONTEXT: ' + filterStr : ''}\n\nCONTENT ATOMS:\n${context}\n\nBe specific, cite the atoms, and be concise.`,
      { model: config.CONTENT_MODEL, system: `You answer questions using only provided content from the knowledge base "${col?.name || collectionId}". Be accurate and cite specific atoms.`, maxTokens: 1500, temperature: 0.3 }
    );
    return { answer: answer || 'Error generating response.', atoms: results.slice(0, 5) };
  }

  // ── Reconstruct (Targeted Recomposition) ─────────────────────────────────────

  async reconstruct(collectionIds, options = {}) {
    const {
      intent = 'custom',
      query,
      filters = {},
      context = '',
      format = 'text',
      max_atoms = 15,
      max_words = 500,
    } = options;

    if (!query) throw new Error('query is required for reconstruction');
    const cols = Array.isArray(collectionIds) ? collectionIds : [collectionIds];

    console.log(`\n  Reconstruct: "${intent}" across [${cols.join(', ')}]`);
    console.log(`  Query: ${query.slice(0, 80)}...`);
    console.log(`  Filters: ${JSON.stringify(filters)}`);

    // Step 1: Filtered search across all requested collections
    let allResults = [];
    for (const colId of cols) {
      try {
        const results = await this.search(colId, query, max_atoms, filters);
        allResults.push(...results.map(r => ({ ...r, collectionId: colId })));
      } catch (err) { console.log(`  Search failed for ${colId}: ${err.message}`); }
    }
    allResults.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    const topAtoms = allResults.slice(0, max_atoms);

    if (!topAtoms.length) {
      return { output: 'Insufficient content in the knowledge base to fulfill this request.', atoms_used: [], atoms_available: 0, confidence: 'none', gaps: ['No atoms matched the query and filters.'] };
    }
    console.log(`  Retrieved ${topAtoms.length} atoms (from ${allResults.length} total matches)`);

    // Step 2: Build reconstruction prompt
    const intentPrompts = {
      sales_email: 'Write a professional sales email. Be specific and evidence-based, referencing real capabilities and proof points from the atoms. No generic sales language. Every claim must be backed by a specific atom.',
      competitive_brief: 'Create a competitive intelligence brief: Overview, Key Strengths, Key Weaknesses, Differentiators, Battle Cards. Ground every point in source atoms.',
      executive_summary: 'Write a concise executive summary for C-level readers. Lead with business impact, use only high-credibility evidence, focus on strategic implications.',
      discovery_questions: 'Generate discovery questions for a sales conversation. Each: (1) grounded in atom insights, (2) probes a real pain point, (3) includes rationale, (4) suggests what a good answer looks like.',
      enrichment: 'Produce a structured enrichment package as JSON: "capabilities" (with evidence), "differentiators" (with proof), "proof_points" (stats, cases, quotes), "gaps" (what is missing). No filler.',
      agent_response: 'Write a conversational response for a voice agent. Short sentences (under 20 words). Natural spoken language, not written prose. Direct and specific.',
      objection_handling: 'Create an objection handling playbook. Per objection: state it, recommended response (from atoms), supporting evidence, follow-up question.',
      custom: 'Fulfill the request using the provided atoms as your ONLY source material. Be specific and evidence-based.',
    };
    const intentInstruction = intentPrompts[intent] || intentPrompts.custom;

    const atomContext = topAtoms.map((a, i) => {
      const tags = [];
      if (a.persona) tags.push(`Persona: ${a.persona}`);
      if (a.buyingStage) tags.push(`Stage: ${a.buyingStage}`);
      if (a.evidenceType) tags.push(`Evidence: ${a.evidenceType}`);
      if (a.credibility) tags.push(`Credibility: ${a.credibility}/5`);
      if (a.emotionalDriver) tags.push(`Driver: ${a.emotionalDriver}`);
      if (a.collectionId && cols.length > 1) tags.push(`Source: ${a.collectionId}`);
      return `[ATOM ${i + 1}] ${tags.join(' | ')}\n${a.text}`;
    }).join('\n\n');

    const filterDesc = Object.entries(filters).filter(([,v]) => v).map(([k,v]) => `${k}: ${v}`).join(', ');

    const systemPrompt = `You are the Targeted Decomposition Engine's reconstruction system. Take atomic intelligence units and REASSEMBLE them into a targeted deliverable.

RULES:
- Use ONLY the provided atoms. Do not add information from general knowledge.
- Every claim must trace to a specific atom.
- If atoms are insufficient, state what is missing in a GAPS section at the end.
- ${max_words ? `Stay under ${max_words} words.` : 'Be comprehensive but not padded.'}
- ${format === 'json' ? 'Return valid JSON only. No markdown fences.' : format === 'markdown' ? 'Use markdown formatting.' : 'Use clean prose.'}`;

    const userPrompt = `INTENT: ${intent}\n${intentInstruction}\n\n${context ? `CONTEXT: ${context}\n` : ''}${filterDesc ? `AUDIENCE FILTERS: ${filterDesc}\n` : ''}\nQUERY: ${query}\n\nATOMS (${topAtoms.length} of ${allResults.length} matches):\n\n${atomContext}\n\n${format === 'json' ? 'Respond with valid JSON only.' : 'After your main output, include a GAPS section listing information the atoms could NOT provide.'}`;

    // Step 3: LLM reconstruction
    console.log(`  Reconstructing (${intent}, ${format}, max ${max_words} words)...`);
    const t0 = Date.now();
    const raw = await callLLM(userPrompt, {
      model: config.CONTENT_MODEL, system: systemPrompt,
      maxTokens: Math.min(max_words ? max_words * 2 : 4000, 8000),
      temperature: intent === 'enrichment' ? 0.2 : 0.4,
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  Reconstruction complete (${elapsed}s)`);

    if (!raw) {
      return { output: 'Reconstruction failed.', atoms_used: topAtoms, atoms_available: allResults.length, confidence: 'failed', gaps: ['LLM returned no response'] };
    }

    // Step 4: Parse output and extract gaps
    let output = raw;
    let gaps = [];
    const gapMatch = raw.match(/(?:GAPS?|MISSING|INFORMATION GAPS?)[:\s]*\n([\s\S]*?)$/i);
    if (gapMatch) {
      output = raw.slice(0, gapMatch.index).trim();
      gaps = gapMatch[1].split('\n').map(l => l.replace(/^[-*\u2022\d.)\s]+/, '').trim()).filter(l => l.length > 5);
    }
    if (format === 'json') {
      try {
        const cleaned = output.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        output = JSON.parse(cleaned);
        if (output.gaps) { gaps = [...gaps, ...(Array.isArray(output.gaps) ? output.gaps : [output.gaps])]; }
      } catch { /* leave as string */ }
    }

    let confidence = 'high';
    if (topAtoms.length < 3) confidence = 'low';
    else if (topAtoms.length < 7) confidence = 'medium';
    if (gaps.length > 3) confidence = confidence === 'high' ? 'medium' : 'low';

    return {
      output, atoms_used: topAtoms, atoms_available: allResults.length, confidence, gaps,
      meta: { intent, collections: cols, filters, elapsed_seconds: parseFloat(elapsed), atoms_retrieved: topAtoms.length },
    };
  }

  // ── Analysis Layer (Template-Specific Extractors) ────────────────────────────

  async analyzeSource(collectionId, sourceId) {
    const col = await this.store.getCollection(collectionId);
    if (!col) throw new Error(`Collection not found: ${collectionId}`);
    const atoms = await this.store.getAtoms(collectionId, sourceId);
    if (!atoms.length) throw new Error(`No atoms for source: ${sourceId}`);
    const source = await this.store.getSource(collectionId, sourceId);

    const meta = typeof col.metadata === 'string' ? JSON.parse(col.metadata || '{}') : (col.metadata || {});
    const templateId = meta.templateId || col.template_id || 'default';

    const sourceMeta = typeof source.metadata === 'string' ? JSON.parse(source.metadata || '{}') : (source.metadata || {});
    const enrichedMeta = {
      ...source,
      viewCount: sourceMeta.viewCount || 0, likeCount: sourceMeta.likeCount || 0,
      commentCount: sourceMeta.commentCount || 0, _comments: sourceMeta.comments || [],
      tags: sourceMeta.tags || [], speakerNames: meta.speakerNames || [],
      productContext: meta.productContext || '',
    };

    console.log(`\n  Analyzing: ${source?.title || sourceId} (template: ${templateId})`);
    const analysis = await runAnalysis(atoms, enrichedMeta, templateId);
    await this.store.storeIntelligence(collectionId, `analysis_${sourceId}`, analysis);
    console.log(`  Analysis stored for ${sourceId}`);
    return analysis;
  }

  async analyzeCollection(collectionId) {
    const sources = await this.store.getSources(collectionId);
    const readySources = sources.filter(s => s.status === 'ready');
    console.log(`\n  Analyzing collection: ${collectionId} (${readySources.length} sources)`);
    const results = [];
    for (const source of readySources) {
      try {
        const analysis = await this.analyzeSource(collectionId, source.id);
        results.push({ sourceId: source.id, title: source.title, analysis });
      } catch (err) { console.error(`  Analysis failed for ${source.title}: ${err.message}`); }
    }
    await this._buildCollectionIntelligence(collectionId, results);
    await this._buildVoiceProfile(collectionId);
    return results;
  }

  async _buildCollectionIntelligence(collectionId, analysisResults) {
    if (!analysisResults.length) return;
    const merged = {};
    for (const r of analysisResults) {
      const extractors = r.analysis?.extractors || {};
      for (const [key, value] of Object.entries(extractors)) {
        if (!merged[key]) merged[key] = [];
        merged[key].push(value);
      }
    }
    await this.store.storeIntelligence(collectionId, 'merged_extractors', merged);

    const sources = await this.store.getSources(collectionId);
    const readySources = sources.filter(s => s.status === 'ready');
    const engagement = readySources.map(s => {
      const meta = typeof s.metadata === 'string' ? JSON.parse(s.metadata || '{}') : (s.metadata || {});
      return {
        id: s.id, title: s.title, publishedAt: s.published_at || meta.publishedAt,
        viewCount: meta.viewCount || 0, likeCount: meta.likeCount || 0,
        commentCount: meta.commentCount || 0,
        likeRate: meta.viewCount > 0 ? Math.round((meta.likeCount / meta.viewCount) * 10000) / 100 : 0,
        commentRate: meta.viewCount > 0 ? Math.round((meta.commentCount / meta.viewCount) * 10000) / 100 : 0,
        tags: meta.tags || [],
      };
    });
    const totalViews = engagement.reduce((s, e) => s + e.viewCount, 0);
    const totalLikes = engagement.reduce((s, e) => s + e.likeCount, 0);
    const totalComments = engagement.reduce((s, e) => s + e.commentCount, 0);
    const avgViews = engagement.length > 0 ? Math.round(totalViews / engagement.length) : 0;

    await this.store.storeIntelligence(collectionId, 'engagement_analytics', {
      totalVideos: engagement.length, totalViews, totalLikes, totalComments, avgViews,
      topByViews: [...engagement].sort((a, b) => b.viewCount - a.viewCount).slice(0, 10),
      highPassion: [...engagement].sort((a, b) => b.commentRate - a.commentRate).slice(0, 10),
      allVideos: engagement,
    });
    console.log(`  Intelligence merged: ${Object.keys(merged).join(', ')}`);
    console.log(`  Engagement: ${engagement.length} sources, ${totalViews} total views`);
  }

  async _buildVoiceProfile(collectionId) {
    const apiUrl = config.TRUEWRITING_API_URL;
    if (!apiUrl) { console.log(`  Voice profile: TRUEWRITING_API_URL not configured`); return null; }

    const sources = await this.store.getSources(collectionId);
    const readySources = sources.filter(s => s.status === 'ready');
    const segments = [];
    for (const source of readySources) {
      const atoms = await this.store.getAtoms(collectionId, source.id);
      const fullText = atoms.map(a => a.text).join(' ');
      if (fullText.length > 20) {
        const meta = typeof source.metadata === 'string' ? JSON.parse(source.metadata || '{}') : (source.metadata || {});
        segments.push({ text: fullText, source_id: source.id, title: source.title || '', date: source.published_at || meta.publishedAt || null });
      }
    }
    if (segments.length < 3) { console.log(`  Voice profile: Need 3+ sources (have ${segments.length})`); return null; }

    console.log(`\n  Building voice profile via TrueWriting API...`);
    try {
      const resp = await fetch(`${apiUrl}/analyze`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_type: 'transcript', segments, min_words: 50 }),
      });
      if (!resp.ok) { console.log(`  Voice profile: API error ${resp.status}`); return null; }
      const profile = await resp.json();
      await this.store.storeIntelligence(collectionId, 'voice_profile', profile);
      console.log(`  Voice profile stored`);
      return profile;
    } catch (err) {
      console.log(`  Voice profile: TrueWriting unreachable (${err.message})`);
      return null;
    }
  }

  // ── Stats & Intelligence ──────────────────────────────────────────────────────

  async deleteSource(collectionId, sourceId) { return this.store.deleteSource(collectionId, sourceId); }

  async getStats(collectionId)               { return this.store.getStats(collectionId); }
  async getIntelligence(collectionId, type)  { return this.store.getIntelligence(collectionId, type); }
  async getSources(collectionId)             { return this.store.getSources(collectionId); }
  async getAtoms(collectionId, sourceId, filters) { return this.store.getAtoms(collectionId, sourceId, filters); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = TDEngine;
