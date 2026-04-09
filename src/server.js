/**
 * TDE — REST API Server v2.2
 * ═══════════════════════════════════════════════════════════════════
 * Deploy on Railway. Port 8400 by default.
 */

const path    = require('path');
const fs      = require('fs');
const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const config  = require('./config');
const TDEngine = require('./core/engine');
const { runSwarm, runDeepFill, msipToText } = require('./core/solution-research');

const app    = express();
const engine = new TDEngine();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(config.DATA_DIR, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 100 * 1024 * 1024 } });

function auth(req, res, next) { next(); }

// ── Health ──────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok', engine: 'TDE — Targeted Decomposition Engine', version: '2.2.0',
    hasOpenRouter: !!config.OPENROUTER_API_KEY, hasYouTubeAPI: !!config.YOUTUBE_API_KEY,
    hasGroq: !!config.GROQ_API_KEY,
    vectorStore: engine.store.qdrantReady ? 'qdrant' : 'sqlite',
    qdrantConnected: engine.store.qdrantReady,
    supportedTypes: ['youtube', 'pdf', 'docx', 'pptx', 'audio', 'text', 'web'],
    templates: Object.keys(config.TEMPLATES),
  });
});

// ── Templates ────────────────────────────────────────────────────────────────

app.get('/templates', auth, (req, res) => {
  const templates = Object.entries(config.TEMPLATES).map(([id, t]) => ({
    id, name: t.name, description: t.description, extractors: t.extractors,
  }));
  res.json(templates);
});

// ── Collections ─────────────────────────────────────────────────────────────

app.get('/collections', auth, async (req, res) => {
  try {
    const collections = await engine.listCollections();
    const withStats = await Promise.all(collections.map(async (col) => {
      try {
        const stats = await engine.getStats(col.id);
        return { ...col, stats };
      } catch {
        return { ...col, stats: { sourceCount: 0, atomCount: 0 } };
      }
    }));
    res.json(withStats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/collections', auth, async (req, res) => {
  try {
    const { id, name, description, templateId } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'id and name required' });
    const template = config.TEMPLATES[templateId] || config.TEMPLATES.default;
    const metadata = { template, templateId: template.id };
    const col = await engine.createCollection(id, name, description || '', metadata);
    res.json({ ok: true, collection: col });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/collections/:id', auth, async (req, res) => {
  try {
    const col = await engine.getCollection(req.params.id);
    if (!col) return res.status(404).json({ error: 'Collection not found' });
    const stats = await engine.getStats(req.params.id);
    res.json({ ...col, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/collections/:id', auth, async (req, res) => {
  try {
    await engine.deleteCollection(req.params.id);
    res.json({ ok: true, deleted: req.params.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/nuke', auth, async (req, res) => {
  try {
    const collections = await engine.listCollections();
    for (const col of collections) { await engine.deleteCollection(col.id); }
    res.json({ ok: true, deleted: collections.length, message: 'All collections wiped' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sources & Atoms ─────────────────────────────────────────────────────────

app.get('/sources/:collectionId', auth, async (req, res) => {
  try { res.json(await engine.getSources(req.params.collectionId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/atoms/:collectionId', auth, async (req, res) => {
  try {
    const { sourceId, persona, buying_stage, evidence_type } = req.query;
    const filters = {};
    if (persona) filters.persona = persona;
    if (buying_stage) filters.buying_stage = buying_stage;
    if (evidence_type) filters.evidence_type = evidence_type;
    const atoms = await engine.getAtoms(req.params.collectionId, sourceId || null, filters);
    res.json(atoms.map(a => { const { embedding, ...rest } = a; return rest; }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ingest ──────────────────────────────────────────────────────────────────

app.post('/ingest', auth, async (req, res) => {
  try {
    const { collectionId, collectionIds, type, input, opts } = req.body;
    const targets = collectionIds || (collectionId ? [collectionId] : []);
    if (!targets.length || !type || !input)
      return res.status(400).json({ error: 'collectionId(s), type, and input required' });
    res.json({ ok: true, status: 'ingestion_started', collectionIds: targets, type, input: input.slice(0, 100) });
    for (const colId of targets) {
      engine.ingest(colId, type, input, opts || {})
        .then(r => console.log(`  Ingest complete [${colId}]: ${r?.title}`))
        .catch(err => console.error(`  Ingest error [${colId}]: ${err.message}`));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/ingest/batch', auth, async (req, res) => {
  try {
    const { collectionId, items, context } = req.body;
    if (!collectionId || !Array.isArray(items) || !items.length)
      return res.status(400).json({ error: 'collectionId and items[] required' });
    res.json({ ok: true, status: 'batch_started', collectionId, count: items.length });
    engine.ingestBatch(collectionId, items, context || '')
      .then(r => console.log(`  Batch complete: ${r.ingested}/${r.total}`))
      .catch(err => console.error(`  Batch error: ${err.message}`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/ingest/channel', auth, async (req, res) => {
  try {
    const { collectionId, collectionIds, channelUrl, maxVideos } = req.body;
    const targets = collectionIds || (collectionId ? [collectionId] : []);
    if (!targets.length || !channelUrl)
      return res.status(400).json({ error: 'collectionId(s) and channelUrl required' });
    res.json({ ok: true, status: 'channel_ingest_started', collectionIds: targets, channelUrl, maxVideos: maxVideos || 50 });
    for (const colId of targets) {
      console.log(`  Channel ingest into: ${colId}`);
      engine.ingestChannel(colId, channelUrl, maxVideos || 50)
        .then(r => console.log(`  Channel complete [${colId}]:`, r))
        .catch(err => console.error(`  Channel error [${colId}]: ${err.message}`));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Site Crawl ──────────────────────────────────────────────────────────────

app.post('/ingest/crawl', auth, async (req, res) => {
  try {
    const { collectionId, collectionIds, url, maxPages } = req.body;
    const targets = collectionIds || (collectionId ? [collectionId] : []);
    if (!targets.length || !url)
      return res.status(400).json({ error: 'collectionId(s) and url required' });
    res.json({ ok: true, status: 'crawl_started', collectionIds: targets, url, maxPages: maxPages || 50 });
    const { crawlSite } = require('./ingest/web');
    crawlSite(url, maxPages || 50).then(async (pages) => {
      console.log('  Crawl returned ' + pages.length + ' pages');
      for (const colId of targets) {
        for (let i = 0; i < pages.length; i++) {
          const page = pages[i];
          console.log('  [' + colId + '] Ingesting page ' + (i+1) + '/' + pages.length + ': ' + page.title.slice(0,50));
          try {
            await engine.ingest(colId, 'web', page.sourceUrl, { title: page.title });
          } catch (err) { console.error('  Page error: ' + err.message); }
        }
      }
      console.log('  Crawl ingest complete: ' + pages.length + ' pages into ' + targets.length + ' collection(s)');
    }).catch(err => console.error('  Crawl error: ' + err.message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── File Upload ─────────────────────────────────────────────────────────────

app.post('/upload/:collectionId', auth, upload.array('files', 50), async (req, res) => {
  try {
    const { collectionId } = req.params;
    const context = req.body.context || '';
    if (!req.files || !req.files.length)
      return res.status(400).json({ error: 'No files uploaded' });
    const col = await engine.getCollection(collectionId);
    if (!col) return res.status(404).json({ error: 'Collection not found' });
    const items = req.files.map(file => {
      const ext = path.extname(file.originalname).toLowerCase().slice(1);
      const typeMap = { pdf: 'pdf', docx: 'docx', doc: 'docx', pptx: 'pptx', ppt: 'pptx',
        mp3: 'audio', mp4: 'audio', m4a: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio',
        txt: 'text', md: 'text' };
      const type = typeMap[ext] || 'text';
      const newPath = file.path + '.' + ext;
      fs.renameSync(file.path, newPath);
      return { type, input: newPath, opts: { title: file.originalname } };
    });
    res.json({ ok: true, status: 'upload_started', count: items.length, files: req.files.map(f => f.originalname) });
    engine.ingestBatch(collectionId, items, context)
      .then(r => console.log(`  Upload batch complete: ${r.ingested}/${r.total}`))
      .catch(err => console.error(`  Upload error: ${err.message}`));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Search & Ask ─────────────────────────────────────────────────────────────

app.get('/search/:collectionId', auth, async (req, res) => {
  try {
    const { q, top_k, persona, buying_stage, evidence_type, emotional_driver, credibility, recency } = req.query;
    if (!q) return res.status(400).json({ error: 'q (query) required' });
    const filters = {};
    if (persona) filters.persona = persona;
    if (buying_stage) filters.buying_stage = buying_stage;
    if (evidence_type) filters.evidence_type = evidence_type;
    if (emotional_driver) filters.emotional_driver = emotional_driver;
    if (credibility) filters.credibility = parseInt(credibility);
    if (recency) filters.recency = recency;
    const limit = parseInt(top_k) || 10;

    const colIds = req.params.collectionId.split(',').map(s => s.trim()).filter(Boolean);
    let allResults = [];
    for (const colId of colIds) {
      try {
        const results = await engine.search(colId, q, limit, filters);
        allResults.push(...results.map(r => ({ ...r, collectionId: colId })));
      } catch (err) { console.log('  Search failed for ' + colId + ': ' + err.message); }
    }
    allResults.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    const trimmed = allResults.slice(0, limit);
    res.json({ query: q, filters, collections: colIds, count: trimmed.length, results: trimmed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/ask/:collectionId', auth, async (req, res) => {
  try {
    const { question, filters } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });
    const result = await engine.ask(req.params.collectionId, question, filters || {});
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Reconstruct (Targeted Recomposition) ────────────────────────────────────

app.post('/reconstruct/:collectionId', auth, async (req, res) => {
  try {
    const { intent, query, filters, context, format, max_atoms, max_words } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });
    const collectionIds = req.params.collectionId.split(',').map(s => s.trim()).filter(Boolean);
    const result = await engine.reconstruct(collectionIds, {
      intent: intent || 'custom', query, filters: filters || {},
      context: context || '', format: format || 'text',
      max_atoms: parseInt(max_atoms) || 15, max_words: parseInt(max_words) || 500,
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Solution Research (Swarm + Deep Fill) ───────────────────────────────────

app.post('/research/:collectionId', auth, async (req, res) => {
  try {
    const { solutionUrl, solutionName } = req.body;
    if (!solutionUrl) return res.status(400).json({ error: 'solutionUrl is required' });
    const collectionId = req.params.collectionId;

    let col = await engine.getCollection(collectionId);
    if (!col) {
      const name = solutionName || solutionUrl.replace(/https?:\/\//, '').replace(/\/$/, '');
      col = await engine.createCollection(collectionId, name, 'Auto-created by solution research', {
        template: config.TEMPLATES.business || config.TEMPLATES.default,
        templateId: 'business', solutionUrl,
      });
      console.log('  [Research] Created collection: ' + collectionId);
    }

    const stats = await engine.getStats(collectionId);
    if (stats.atomCount > 100) {
      console.log('  [Research] Collection already has ' + stats.atomCount + ' atoms — returning enrichment');
      const enrichment = await engine.reconstruct([collectionId], {
        intent: 'enrichment', query: 'complete solution profile: capabilities, differentiators, proof points, pain points',
        format: 'json', max_atoms: 20,
      });
      return res.json({ status: 'existing', atomCount: stats.atomCount, enrichment: enrichment.output, confidence: enrichment.confidence, gaps: enrichment.gaps });
    }

    let webContent = '';
    try {
      const { extractWeb } = require('./ingest/web');
      const webData = await extractWeb(solutionUrl);
      webContent = webData.text || '';
    } catch (err) { console.log('  [Research] Web scrape failed: ' + err.message); }

    console.log('  [Research] Phase 1: Swarm starting for ' + solutionUrl);
    const swarmResult = await runSwarm(solutionUrl, solutionName, webContent);
    const msip = swarmResult.msip;

    const msipText = msipToText(msip, solutionUrl);
    if (msipText.length > 100) {
      await engine.ingest(collectionId, 'text', msipText, {
        title: (msip.product_name || solutionName || 'Solution') + ' — MSIP (Swarm Research)',
        context: 'Minimum Solution Intelligence Profile from parallel agent swarm',
      });
    }

    if (webContent.length > 200) {
      await engine.ingest(collectionId, 'web', solutionUrl, {
        title: (msip.product_name || solutionName || solutionUrl) + ' — Website',
      }).catch(err => console.log('  [Research] Web ingest error: ' + err.message));
    }

    await new Promise(r => setTimeout(r, 3000));
    let enrichment = null;
    try {
      enrichment = await engine.reconstruct([collectionId], {
        intent: 'enrichment', query: 'complete solution profile: capabilities, differentiators, proof points, pain points',
        format: 'json', max_atoms: 15,
      });
    } catch (err) { console.log('  [Research] Enrichment failed: ' + err.message); }

    res.json({
      status: 'researched', collectionId, msip,
      enrichment: enrichment ? enrichment.output : msip,
      confidence: enrichment ? enrichment.confidence : 'medium',
      gaps: enrichment ? enrichment.gaps : [],
      swarm: { agents: swarmResult.agents.length, elapsed: swarmResult.elapsed },
    });

    console.log('  [Research] Phase 2: Deep Fill starting in background...');
    runDeepFill(engine, collectionId, solutionUrl, solutionName, msip)
      .then(() => console.log('  [Research] Deep Fill complete for ' + collectionId))
      .catch(err => console.error('  [Research] Deep Fill error: ' + err.message));

  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ────────────────────────────────────────────────────────────────────

app.get('/stats/:collectionId', auth, async (req, res) => {
  try { res.json(await engine.getStats(req.params.collectionId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Analysis ────────────────────────────────────────────────────────────────

app.post('/analyze/:collectionId', auth, async (req, res) => {
  try {
    const results = await engine.analyzeCollection(req.params.collectionId);
    res.json({ ok: true, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/analyze/:collectionId/:sourceId', auth, async (req, res) => {
  try {
    const result = await engine.analyzeSource(req.params.collectionId, req.params.sourceId);
    res.json({ ok: true, result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Intelligence ────────────────────────────────────────────────────────────

app.get('/intelligence/:collectionId', auth, async (req, res) => {
  try {
    const { type } = req.query;
    res.json(await engine.getIntelligence(req.params.collectionId, type || null));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Deploy Agent (ElevenLabs) ───────────────────────────────────────────────

app.post('/deploy-agent/:collectionId', auth, async (req, res) => {
  try {
    const col = await engine.getCollection(req.params.collectionId);
    if (!col) return res.status(404).json({ error: 'Collection not found' });
    const atoms = await engine.getAtoms(req.params.collectionId);
    if (!atoms.length) return res.status(400).json({ error: 'No atoms in collection — ingest content first' });
    const colName = col.name || req.params.collectionId;
    const knowledge = atoms.map(a => a.text).filter(t => t && t.length > 30);
    const knowledgeBlock = knowledge.map(k => `- ${k}`).join('\n');
    const prompt = `You are an AI assistant for "${colName}". Professional but approachable. Use only the knowledge below. Never fabricate.\n\nKNOWLEDGE:\n${knowledgeBlock}\n\nBe specific, practical, honest, conversational.`;
    res.json({
      ok: true, collectionId: req.params.collectionId, collectionName: colName,
      atomCount: knowledge.length, promptLength: prompt.length, prompt: prompt,
      embedCode: `<!-- Add agent_id after creating the ElevenLabs agent -->\n<script src="https://elevenlabs.io/convai-widget/index.js" async data-agent-id="YOUR_AGENT_ID"></script>`,
      instructions: 'Use the prompt above as the system prompt when creating an ElevenLabs agent. The embed code goes on any website.'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Agent Webhook (ElevenLabs Server Tool) ──────────────────────────────────
// ElevenLabs agents call this endpoint as a webhook tool to query TDE collections.
// Configure in ElevenLabs: Add Tool > Webhook > POST > URL below
// URL: https://targeteddecomposition-production.up.railway.app/agent/query
// Body params: question (string, required), collections (string, optional)

app.post('/agent/query', async (req, res) => {
  try {
    var question = req.body.question || req.body.query || '';
    var collections = req.body.collections || req.body.collection || 'WinTechPartners';

    if (!question) {
      return res.json({ answer: 'I didn\'t catch a question. Could you try again?' });
    }

    var colIds = Array.isArray(collections) ? collections : collections.split(',').map(function(s) { return s.trim(); }).filter(Boolean);

    console.log('[Agent Query] Q: ' + question.slice(0, 80) + ' | Collections: ' + colIds.join(','));

    var result = await engine.reconstruct(colIds, {
      intent: 'agent_response',
      query: question,
      filters: {},
      context: 'Caller is asking a voice agent. Keep the response conversational and under 150 words.',
      format: 'text',
      max_atoms: 10,
      max_words: 150,
    });

    var answer = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);

    // Strip any GAPS section from spoken response
    var gapIdx = answer.search(/GAPS?[:\s]*\n/i);
    if (gapIdx > 0) answer = answer.slice(0, gapIdx).trim();

    console.log('[Agent Query] Answer: ' + answer.slice(0, 100) + '... (' + result.confidence + ')');

    res.json({
      answer: answer,
      confidence: result.confidence,
      atoms_used: result.atoms_used ? result.atoms_used.length : 0,
    });

  } catch (e) {
    console.error('[Agent Query] Error: ' + e.message);
    res.json({ answer: 'I\'m having trouble finding that information right now. Could you try asking in a different way?' });
  }
});

// ── Admin UI ─────────────────────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use((req, res) => { res.status(404).json({ error: 'Not found', hint: 'See /health for available endpoints' }); });

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  TDE — Targeted Decomposition Engine v2.2.0`);
  console.log(`  Port:        ${config.PORT}`);
  console.log(`  OpenRouter:  ${config.OPENROUTER_API_KEY ? 'YES' : 'NO'}`);
  console.log(`  YouTube API: ${config.YOUTUBE_API_KEY ? 'YES' : 'NO'}`);
  console.log(`  Groq:        ${config.GROQ_API_KEY ? 'YES' : 'NO'}`);
  console.log(`  Templates:   ${Object.keys(config.TEMPLATES).join(', ')}`);
  console.log(`  Auth:        OPEN (no API key required)`);
  console.log(`  Admin UI:    http://localhost:${config.PORT}/admin`);
  console.log(`${'═'.repeat(60)}\n`);
});

module.exports = app;
