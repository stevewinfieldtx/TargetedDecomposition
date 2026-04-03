/**
 * TDE — REST API Server v2.0
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

const app    = express();
const engine = new TDEngine();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// File upload config
const uploadDir = path.join(config.DATA_DIR, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 100 * 1024 * 1024 } });

// Auth disabled — re-enable later for external API callers
function auth(req, res, next) { next(); }

// ── Health ──────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: 'TDE — Targeted Decomposition Engine',
    version: '2.0.1',
    hasOpenRouter: !!config.OPENROUTER_API_KEY,
    hasYouTubeAPI: !!config.YOUTUBE_API_KEY,
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
  try { res.json(await engine.listCollections()); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
    const { collectionId, type, input, opts } = req.body;
    if (!collectionId || !type || !input)
      return res.status(400).json({ error: 'collectionId, type, and input required' });
    res.json({ ok: true, status: 'ingestion_started', collectionId, type, input: input.slice(0, 100) });
    engine.ingest(collectionId, type, input, opts || {})
      .then(r => console.log(`  Ingest complete: ${r?.title}`))
      .catch(err => console.error(`  Ingest error: ${err.message}`));
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
    const { collectionId, channelUrl, maxVideos } = req.body;
    if (!collectionId || !channelUrl)
      return res.status(400).json({ error: 'collectionId and channelUrl required' });
    res.json({ ok: true, status: 'channel_ingest_started', collectionId, channelUrl, maxVideos: maxVideos || 50 });
    engine.ingestChannel(collectionId, channelUrl, maxVideos || 50)
      .then(r => console.log(`  Channel complete:`, r))
      .catch(err => console.error(`  Channel error: ${err.message}`));
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
    const { q, top_k, persona, buying_stage, evidence_type } = req.query;
    if (!q) return res.status(400).json({ error: 'q (query) required' });
    const filters = {};
    if (persona) filters.persona = persona;
    if (buying_stage) filters.buying_stage = buying_stage;
    if (evidence_type) filters.evidence_type = evidence_type;
    const results = await engine.search(req.params.collectionId, q, parseInt(top_k) || 10, filters);
    res.json({ query: q, filters, count: results.length, results });
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

// ── Admin UI ─────────────────────────────────────────────────────────────────

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Fallback
app.use((req, res) => { res.status(404).json({ error: 'Not found', hint: 'See /health for available endpoints' }); });

app.listen(config.PORT, '0.0.0.0', () => {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  TDE — Targeted Decomposition Engine v2.0.1`);
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
