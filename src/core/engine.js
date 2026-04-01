/**
 * TDE — Core Engine
 * ═══════════════════════════════════════════════════════════════════
 * INGEST → EXTRACT → MUNGE → TAG → EMBED → STORE → SEARCH → SYNTHESIZE
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
 */

const config  = require('../config');
const Store   = require('./store');
const { munge }     = require('./munger');
const { tagAtoms }  = require('./tagger');
const { batchEmbed, callLLM, generateEmbedding } = require('../utils/llm');
const { v4: uuidv4 } = require('uuid');

const youtube = require('../ingest/youtube');

class TDEngine {
  constructor(dataDir) {
    this.store = new Store(dataDir || config.DATA_DIR);
    console.log('  TDEngine initialized');
  }

  // ── Collections ──────────────────────────────────────────────────────────────

  createCollection(id, name, description = '') {
    return this.store.createCollection(id, name, description);
  }
  getCollection(id)    { return this.store.getCollection(id); }
  listCollections()    { return this.store.listCollections(); }

  // ── Universal Ingest ─────────────────────────────────────────────────────────

  /**
   * Ingest any content type into a collection.
   * @param {string} collectionId
   * @param {string} type         — 'youtube' | 'pdf' | 'docx' | 'pptx' | 'audio' | 'text' | 'web'
   * @param {string} input        — URL, file path, or raw text depending on type
   * @param {Object} opts         — optional overrides: {title, author, context}
   */
  async ingest(collectionId, type, input, opts = {}) {
    console.log(`\n  TDE Ingest: [${type}] ${input.slice(0, 80)}${input.length > 80 ? '...' : ''}`);

    // 1. Extract raw content based on type
    let content;
    let sourceId;
    let sourceRecord;

    try {
      switch (type.toLowerCase()) {
        case 'youtube': {
          const result = await this._ingestYouTube(collectionId, input);
          return result; // YouTube has its own full pipeline
        }
        case 'pdf': {
          const { extractPDF } = require('../ingest/pdf');
          content = await extractPDF(input);
          sourceId = uuidv4().slice(0, 8) + '_pdf';
          break;
        }
        case 'docx':
        case 'word': {
          const { extractDOCX } = require('../ingest/docx');
          content = await extractDOCX(input);
          sourceId = uuidv4().slice(0, 8) + '_docx';
          break;
        }
        case 'pptx':
        case 'powerpoint': {
          const { extractPPTX } = require('../ingest/pptx');
          content = await extractPPTX(input);
          sourceId = uuidv4().slice(0, 8) + '_pptx';
          break;
        }
        case 'audio':
        case 'podcast':
        case 'mp3':
        case 'mp4': {
          const { extractAudio } = require('../ingest/audio');
          content = await extractAudio(input);
          sourceId = uuidv4().slice(0, 8) + '_audio';
          break;
        }
        case 'text':
        case 'transcript': {
          const { extractText } = require('../ingest/text');
          content = extractText(input, opts.title);
          sourceId = uuidv4().slice(0, 8) + '_text';
          break;
        }
        case 'web':
        case 'url': {
          const { extractWeb } = require('../ingest/web');
          content = await extractWeb(input);
          sourceId = uuidv4().slice(0, 8) + '_web';
          break;
        }
        default:
          throw new Error(`Unknown content type: ${type}. Valid types: youtube, pdf, docx, pptx, audio, text, web`);
      }
    } catch (err) {
      console.error(`  Extraction failed: ${err.message}`);
      throw err;
    }

    if (!content || !content.text || content.text.length < 50) {
      throw new Error(`No extractable content from: ${input}`);
    }

    // Override title/author if provided
    if (opts.title)  content.title  = opts.title;
    if (opts.author) content.author = opts.author;

    console.log(`  Extracted: "${content.title}" — ${Math.round(content.text.length / 5)} words`);

    // 2. Register source
    sourceRecord = {
      id:          sourceId,
      sourceType:  type,
      sourceUrl:   type === 'web' ? input : '',
      filePath:    ['pdf','docx','pptx','audio','text'].includes(type) ? input : '',
      title:       content.title   || opts.title  || 'Untitled',
      author:      content.author  || opts.author || '',
      publishedAt: content.publishedAt || '',
      duration:    content.duration || 0,
      pageCount:   content.pageCount || 0,
      metadata:    content.metadata  || {},
      status:      'processing',
    };
    await this.store.addSource(collectionId, sourceRecord);

    // 3. Run through pipeline
    try {
      const atoms = await this._pipeline(collectionId, sourceId, content, opts.context || '');
      sourceRecord.status = 'ready';
      sourceRecord.metadata = { ...sourceRecord.metadata, atomCount: atoms.length };
      await this.store.addSource(collectionId, sourceRecord);
      console.log(`  Done: ${atoms.length} atoms stored for "${sourceRecord.title}"`);
      return { ...sourceRecord, atomCount: atoms.length };
    } catch (err) {
      sourceRecord.status = 'error';
      sourceRecord.metadata = { ...sourceRecord.metadata, error: err.message };
      await this.store.addSource(collectionId, sourceRecord);
      throw err;
    }
  }

  // ── Core Pipeline ────────────────────────────────────────────────────────────

  async _pipeline(collectionId, sourceId, content, context = '') {
    // Step 1: Munge — extract atomic intelligence units
    console.log(`  Pipeline: munging...`);
    const atoms = await munge(content, sourceId);
    if (!atoms.length) throw new Error('Munger produced no atoms — content may be too short or low-quality');
    console.log(`  Pipeline: ${atoms.length} atoms extracted`);

    // Step 2: Tag — apply 6D metadata
    console.log(`  Pipeline: tagging 6D metadata...`);
    const tagged = await tagAtoms(atoms, context);

    // Step 3: Embed — generate vector embeddings
    console.log(`  Pipeline: embedding...`);
    const texts      = tagged.map(a => a.text);
    const embeddings = await batchEmbed(texts, 5);
    tagged.forEach((a, i) => { a.embedding = embeddings[i] || null; });
    console.log(`  Pipeline: ${embeddings.filter(Boolean).length}/${tagged.length} embedded`);

    // Step 4: Store
    await this.store.storeAtoms(collectionId, sourceId, tagged);

    return tagged;
  }

  // ── YouTube (special pipeline — needs transcript + metadata) ─────────────────

  async _ingestYouTube(collectionId, videoUrl) {
    const videoId = youtube.extractVideoId(videoUrl);
    if (!videoId) throw new Error(`Invalid YouTube URL: ${videoUrl}`);

    // Check if already ingested
    const existing = await this.store.getSource(collectionId, videoId);
    if (existing && existing.status === 'ready') {
      console.log(`  Already ingested: ${existing.title}`);
      return existing;
    }

    const meta = await youtube.getVideoMetadata(videoId);
    let comments = [];
    try { comments = await youtube.getVideoComments(videoId, 50); } catch {}

    const source = {
      id: videoId, sourceType: 'youtube', sourceUrl: videoUrl,
      title:  meta?.title      || `Video ${videoId}`,
      author: meta?.author     || '',
      publishedAt: meta?.publishedAt || '',
      duration: meta?.duration || 0,
      metadata: { ...(meta || {}), comments, commentCount: meta?.commentCount || 0, tags: meta?.tags || [] },
      status: 'processing',
    };
    await this.store.addSource(collectionId, source);
    console.log(`  YouTube: ${source.title} (${Math.round(source.duration / 60)}m)`);

    const transcript = await youtube.getTranscript(videoId);
    if (!transcript) {
      source.status = 'error';
      source.metadata.error = 'No transcript available';
      await this.store.addSource(collectionId, source);
      console.log(`  No transcript: ${source.title}`);
      return null;
    }

    const content = {
      text:     transcript.text,
      segments: transcript.segments,
      title:    source.title,
      author:   source.author,
      duration: source.duration,
      metadata: source.metadata,
    };

    const atoms = await this._pipeline(collectionId, videoId, content,
      `YouTube video: "${source.title}" by ${source.author}`);

    source.status = 'ready';
    source.metadata.atomCount = atoms.length;
    await this.store.addSource(collectionId, source);
    return source;
  }

  // ── Channel Ingest (batch YouTube) ───────────────────────────────────────────

  async ingestChannel(collectionId, channelInput, maxVideos = 50) {
    console.log(`\n  Scanning channel: ${channelInput}`);
    const videoList = await youtube.getChannelVideoIds(channelInput, maxVideos);
    const results = { total: videoList.length, ingested: 0, errors: 0, skipped: 0 };
    for (let i = 0; i < videoList.length; i++) {
      const { videoId, title } = videoList[i];
      console.log(`\n  [${i + 1}/${videoList.length}] ${title || videoId}`);
      try {
        const url    = `https://www.youtube.com/watch?v=${videoId}`;
        const result = await this._ingestYouTube(collectionId, url);
        if (result) { result.status === 'ready' ? results.ingested++ : results.skipped++; }
        else { results.errors++; }
      } catch (err) { console.error(`  Error: ${err.message}`); results.errors++; }
      if (i < videoList.length - 1) await sleep(1000);
    }
    console.log(`\n  Channel complete: ${results.ingested}/${results.total} ingested`);
    return results;
  }

  // ── Batch Ingest (list of URLs / files) ──────────────────────────────────────

  async ingestBatch(collectionId, items, context = '') {
    const results = { total: items.length, ingested: 0, errors: 0 };
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      console.log(`\n  Batch [${i + 1}/${items.length}]: ${item.type} — ${(item.input || '').slice(0, 60)}`);
      try {
        await this.ingest(collectionId, item.type, item.input, { ...item.opts, context });
        results.ingested++;
      } catch (err) {
        console.error(`  Error: ${err.message}`);
        results.errors++;
        results[`error_${i}`] = err.message;
      }
      if (i < items.length - 1) await sleep(500);
    }
    return results;
  }

  // ── Search ───────────────────────────────────────────────────────────────────

  async search(collectionId, query, topK = 10, filters = {}) {
    const queryEmb = await generateEmbedding(query);
    if (!queryEmb) return this._keywordSearch(collectionId, query, topK);
    const results  = await this.store.search(collectionId, queryEmb, topK, filters);
    return results.map(r => ({
      atomId:   r.id || r.atom_id,
      sourceId: r.source_id,
      text:     r.text,
      similarity: Math.round((r.similarity || 0) * 1000) / 10,
      atomType: r.atom_type,
      persona:  r.d_persona,
      buyingStage: r.d_buying_stage,
      emotionalDriver: r.d_emotional_driver,
      evidenceType: r.d_evidence_type,
      credibility: r.d_credibility,
      recency: r.d_recency,
      startTime: r.start_time,
      pageNumber: r.page_number,
    }));
  }

  async _keywordSearch(collectionId, query, topK) {
    const atoms = await this.store.getAtoms(collectionId);
    const terms = query.toLowerCase().split(/\s+/);
    const scored = atoms
      .map(a => ({ ...a, score: terms.filter(t => a.text.toLowerCase().includes(t)).length / terms.length }))
      .filter(a => a.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return scored.map(r => ({ atomId: r.id, sourceId: r.source_id, text: r.text, similarity: Math.round(r.score * 100), atomType: r.atom_type, persona: r.d_persona, buyingStage: r.d_buying_stage }));
  }

  // ── Ask (RAG) ────────────────────────────────────────────────────────────────

  async ask(collectionId, question, filters = {}, topK = 8) {
    const results = await this.search(collectionId, question, topK, filters);
    if (!results.length) return { answer: 'Not enough content to answer this question.', atoms: [] };

    const col     = await this.store.getCollection(collectionId);
    const context = results.map((r, i) => `[${i + 1}] ${r.text}`).join('\n\n');
    const filterStr = Object.entries(filters).filter(([,v]) => v).map(([k,v]) => `${k}: ${v}`).join(', ');

    const answer = await callLLM(
      `Answer this question using ONLY the content below:\n\nQUESTION: ${question}${filterStr ? '\nFILTER CONTEXT: ' + filterStr : ''}\n\nCONTENT ATOMS:\n${context}\n\nBe specific, cite the atoms, and be concise.`,
      { model: config.CONTENT_MODEL, system: `You answer questions using only provided content from the knowledge base "${col?.name || collectionId}". Be accurate and cite specific atoms.`, maxTokens: 1500, temperature: 0.3 }
    );

    return { answer: answer || 'Error generating response.', atoms: results.slice(0, 5) };
  }

  // ── Stats & Intelligence ──────────────────────────────────────────────────────

  async getStats(collectionId)               { return this.store.getStats(collectionId); }
  async getIntelligence(collectionId, type)  { return this.store.getIntelligence(collectionId, type); }
  async getSources(collectionId)             { return this.store.getSources(collectionId); }
  async getAtoms(collectionId, sourceId, filters) { return this.store.getAtoms(collectionId, sourceId, filters); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = TDEngine;
