/**
 * TDE — REST API Server v2.2
 * ═══════════════════════════════════════════════════════════════════
 * Deploy on Railway. Port 8400 by default.
 */

const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
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

// ── API Key Auth with Collection Scoping ──────────────────────────────────
// Keys are stored in PostgreSQL. Each key has an allowed_collections array.
// If allowed_collections is NULL or empty, the key has access to ALL collections.
// The master admin key (API_SECRET_KEY env var) bypasses all checks.

const _apiKeysReady = (async () => {
  // Wait for PG to be ready, then create the api_keys table
  if (engine.store._pgInitPromise) await engine.store._pgInitPromise;
  if (engine.store.pg && engine.store.pgReady) {
    await engine.store.pg.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        team TEXT DEFAULT '',
        allowed_collections TEXT[] DEFAULT '{}',
        is_admin BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      );
    `);
    console.log('  Auth: api_keys table ready');
  }
})();

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateApiKey() {
  return 'tde_' + crypto.randomBytes(24).toString('hex');
}

// Extract collectionId(s) from the request — works for URL params and body
function getRequestedCollections(req) {
  // From URL param (covers /search/:collectionId, /atoms/:collectionId, etc.)
  if (req.params.collectionId) {
    return req.params.collectionId.split(',').map(s => s.trim()).filter(Boolean);
  }
  // From body (covers POST /ingest, etc.)
  if (req.body.collectionId) return [req.body.collectionId];
  if (req.body.collectionIds) return req.body.collectionIds;
  return [];
}

async function auth(req, res, next) {
  // Master admin key from env — full access to everything
  if (config.API_SECRET_KEY) {
    const provided = req.headers['x-api-key'] || req.query.api_key;
    if (provided === config.API_SECRET_KEY) {
      req.authScope = { admin: true, collections: null }; // null = unrestricted
      return next();
    }
  }

  // If no API_SECRET_KEY is set AND no api_keys in DB, run open (backwards compatible)
  if (!config.API_SECRET_KEY) {
    // Check if any api_keys exist in the database
    if (engine.store.pg && engine.store.pgReady) {
      const { rows } = await engine.store.pg.query('SELECT COUNT(*) as cnt FROM api_keys WHERE is_active = true');
      if (parseInt(rows[0].cnt) === 0) {
        req.authScope = { admin: true, collections: null };
        return next();
      }
    } else {
      // No PG, no keys — run open
      req.authScope = { admin: true, collections: null };
      return next();
    }
  }

  // Require a key
  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (!provided) {
    return res.status(401).json({ error: 'API key required. Pass via x-api-key header.' });
  }

  // Look up the key
  if (!engine.store.pg || !engine.store.pgReady) {
    return res.status(503).json({ error: 'Auth service unavailable — database not connected' });
  }

  const hash = hashKey(provided);
  const { rows } = await engine.store.pg.query(
    'SELECT id, name, team, allowed_collections, is_admin, is_active FROM api_keys WHERE key_hash = $1',
    [hash]
  );

  if (!rows.length || !rows[0].is_active) {
    return res.status(401).json({ error: 'Invalid or revoked API key' });
  }

  const keyRecord = rows[0];

  // Update last_used_at (fire and forget)
  engine.store.pg.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [keyRecord.id]).catch(() => {});

  // Admin keys get full access
  if (keyRecord.is_admin) {
    req.authScope = { admin: true, collections: null, team: keyRecord.team, keyName: keyRecord.name };
    return next();
  }

  // Check collection scoping
  const allowed = keyRecord.allowed_collections || [];
  if (allowed.length === 0) {
    // Empty array = access to all collections
    req.authScope = { admin: false, collections: null, team: keyRecord.team, keyName: keyRecord.name };
    return next();
  }

  // Validate requested collections against allowed list
  const requested = getRequestedCollections(req);
  if (requested.length > 0) {
    const denied = requested.filter(c => !allowed.includes(c));
    if (denied.length > 0) {
      return res.status(403).json({
        error: 'Access denied to collection(s): ' + denied.join(', '),
        hint: 'This API key is scoped to: ' + allowed.join(', '),
      });
    }
  }

  req.authScope = { admin: false, collections: allowed, team: keyRecord.team, keyName: keyRecord.name };
  next();
}

// Collection-list filtering: non-admin scoped keys only see their allowed collections
function filterCollections(collections, authScope) {
  if (!authScope || !authScope.collections) return collections; // unrestricted
  return collections.filter(c => authScope.collections.includes(c.id));
}

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

// ── Intel Cache (Company + Industry Knowledge Persistence) ──────────────
// Mounts /intel/company, /intel/industry, /intel/stats endpoints
// Tables auto-created on startup. TTL configurable via INTEL_TTL_DAYS env var.
(async () => {
  if (engine.store._pgInitPromise) await engine.store._pgInitPromise;
  if (engine.store.pg && engine.store.pgReady) {
    require('./routes/intel-cache-routes')(app, auth, engine.store.pg);
  } else {
    console.log('  Intel Cache: SKIPPED (no PostgreSQL)');
  }
})();

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
    const visible = filterCollections(collections, req.authScope);
    const withStats = await Promise.all(visible.map(async (col) => {
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

app.delete('/sources/:collectionId/:sourceId', auth, async (req, res) => {
  try {
    await engine.deleteSource(req.params.collectionId, req.params.sourceId);
    res.json({ ok: true, deleted: req.params.sourceId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

// ── API Key Management (admin only) ────────────────────────────────────────

// Create a new API key
app.post('/admin/api-keys', auth, async (req, res) => {
  try {
    if (!req.authScope?.admin) return res.status(403).json({ error: 'Admin access required' });
    const { name, team, allowed_collections, is_admin } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const key = generateApiKey();
    const id = crypto.randomUUID();
    const hash = hashKey(key);
    const cols = Array.isArray(allowed_collections) ? allowed_collections : [];

    await engine.store.pg.query(
      `INSERT INTO api_keys (id, key_hash, name, team, allowed_collections, is_admin)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, hash, name, team || '', cols, is_admin || false]
    );

    // Return the key ONCE — it cannot be retrieved again
    res.json({
      ok: true, id, name, team: team || '', key,
      allowed_collections: cols,
      is_admin: is_admin || false,
      warning: 'Save this key now. It cannot be retrieved again.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List all API keys (without the actual key — just metadata)
app.get('/admin/api-keys', auth, async (req, res) => {
  try {
    if (!req.authScope?.admin) return res.status(403).json({ error: 'Admin access required' });
    const { rows } = await engine.store.pg.query(
      `SELECT id, name, team, allowed_collections, is_admin, is_active, created_at, last_used_at
       FROM api_keys ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update a key (change collections, deactivate, etc.)
app.patch('/admin/api-keys/:keyId', auth, async (req, res) => {
  try {
    if (!req.authScope?.admin) return res.status(403).json({ error: 'Admin access required' });
    const { allowed_collections, is_active, name, team } = req.body;
    const updates = []; const vals = []; let idx = 1;

    if (allowed_collections !== undefined) { updates.push(`allowed_collections = $${idx++}`); vals.push(allowed_collections); }
    if (is_active !== undefined)           { updates.push(`is_active = $${idx++}`); vals.push(is_active); }
    if (name !== undefined)                { updates.push(`name = $${idx++}`); vals.push(name); }
    if (team !== undefined)                { updates.push(`team = $${idx++}`); vals.push(team); }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.keyId);

    const { rowCount } = await engine.store.pg.query(
      `UPDATE api_keys SET ${updates.join(', ')} WHERE id = $${idx}`, vals
    );
    if (!rowCount) return res.status(404).json({ error: 'Key not found' });
    res.json({ ok: true, updated: req.params.keyId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Revoke a key (soft delete — sets is_active = false)
app.delete('/admin/api-keys/:keyId', auth, async (req, res) => {
  try {
    if (!req.authScope?.admin) return res.status(403).json({ error: 'Admin access required' });
    const { rowCount } = await engine.store.pg.query(
      'UPDATE api_keys SET is_active = false WHERE id = $1', [req.params.keyId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Key not found' });
    res.json({ ok: true, revoked: req.params.keyId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Retry (single source) ─────────────────────────────────────────────────────

app.post('/retry/:collectionId/:sourceId', auth, async (req, res) => {
  const { collectionId, sourceId } = req.params;
  try {
    const sources = await engine.getSources(collectionId);
    const source = sources.find(s => s.id === sourceId);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    if (source.status !== 'error') return res.status(400).json({ error: `Source is "${source.status}", not "error"` });

    const meta = typeof source.metadata === 'string' ? JSON.parse(source.metadata) : (source.metadata || {});
    const retryCount = (meta.retryCount || 0) + 1;

    console.log(`\n  [RETRY] ${sourceId} in ${collectionId} (attempt ${retryCount}) — ${source.source_type}: ${source.source_url || source.file_path}`);

    // Reset to processing with retry metadata
    meta.retryCount = retryCount;
    meta.lastRetryAt = new Date().toISOString();
    delete meta.error;
    delete meta.retriesExhausted;
    await engine.store.addSource(collectionId, { ...source, status: 'processing', metadata: meta, sourceType: source.source_type, sourceUrl: source.source_url, filePath: source.file_path });

    // Re-run ingestion async
    const input = source.source_url || source.file_path;
    const type = source.source_type;
    engine.ingest(collectionId, type, input, { _retrySourceId: sourceId, _retryCount: retryCount })
      .then(r => console.log(`  [RETRY] Success: ${sourceId} — ${r?.title || 'done'}`))
      .catch(err => console.error(`  [RETRY] Failed: ${sourceId} — ${err.message}`));

    res.json({ ok: true, sourceId, retryCount, status: 'requeued' });
  } catch (err) {
    console.error('[RETRY ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Retry (all failed in collection) ──────────────────────────────────────────

app.post('/retry/:collectionId', auth, async (req, res) => {
  const { collectionId } = req.params;
  try {
    const sources = await engine.getSources(collectionId);
    const errors = sources.filter(s => s.status === 'error');
    if (!errors.length) return res.json({ ok: true, retried: 0, message: 'No failed sources to retry' });

    let queued = 0;
    for (const source of errors) {
      const meta = typeof source.metadata === 'string' ? JSON.parse(source.metadata) : (source.metadata || {});
      const retryCount = (meta.retryCount || 0) + 1;
      meta.retryCount = retryCount;
      meta.lastRetryAt = new Date().toISOString();
      delete meta.error;
      delete meta.retriesExhausted;

      await engine.store.addSource(collectionId, { ...source, status: 'processing', metadata: meta, sourceType: source.source_type, sourceUrl: source.source_url, filePath: source.file_path });

      const input = source.source_url || source.file_path;
      const type = source.source_type;

      // Stagger to avoid hammering YouTube
      const delay = queued * 3000;
      setTimeout(() => {
        console.log(`  [RETRY-ALL] ${source.id} (attempt ${retryCount})`);
        engine.ingest(collectionId, type, input, { _retrySourceId: source.id, _retryCount: retryCount })
          .then(r => console.log(`  [RETRY-ALL] Success: ${source.id}`))
          .catch(err => console.error(`  [RETRY-ALL] Failed: ${source.id} — ${err.message}`));
      }, delay);

      queued++;
    }

    res.json({ ok: true, retried: queued, message: `${queued} sources requeued (staggered 3s apart)` });
  } catch (err) {
    console.error('[RETRY-ALL ERROR]', err);
    res.status(500).json({ error: err.message });
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
  console.log(`  Auth:        ${config.API_SECRET_KEY ? 'MASTER KEY SET' : 'OPEN until first API key is created'}`);
  console.log(`  Admin UI:    http://localhost:${config.PORT}/admin`);
  console.log(`${'═'.repeat(60)}\n`);
});

module.exports = app;
