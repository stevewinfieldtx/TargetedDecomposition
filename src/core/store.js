/**
 * TDE — Storage
 * PostgreSQL (Railway) + Qdrant (vectors) + SQLite (local fallback)
 *
 * Key difference from TrueEngine: the "chunks" table is extended with
 * 6D metadata columns so every atom carries its full dimensional tags.
 */

const path = require('path');
const fs   = require('fs');
const config = require('../config');

let Pool;    try { Pool = require('pg').Pool; }                           catch { Pool = null; }
let Database; try { Database = require('better-sqlite3'); }              catch { Database = null; }
let QdrantClient; try { QdrantClient = require('@qdrant/js-client-rest').QdrantClient; } catch { QdrantClient = null; }

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir || config.DATA_DIR;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.pg = null; this.db = null; this.qdrant = null;
    this.qdrantReady = false; this.pgReady = false; this._pgInitPromise = null;

    if (config.DATABASE_URL && Pool) {
      this.pg = new Pool({
        connectionString: config.DATABASE_URL,
        ssl: config.DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
        max: 10, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000,
      });
      this._pgInitPromise = this._initPostgres().catch(err => console.error('  PG init error:', err.message));
    } else if (Database) {
      this.db = new Database(path.join(this.dataDir, 'tde.db'));
      this.db.pragma('journal_mode = WAL');
      this._initSqliteTables();
      console.log('  Storage: SQLite (local) — set DATABASE_URL for production');
    }
    this._initQdrant();
  }

  async _initPostgres() {
    try {
      await this.pg.query('SELECT 1');
      await this.pg.query(`
        CREATE TABLE IF NOT EXISTS collections (
          id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '',
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS sources (
          id TEXT, collection_id TEXT,
          source_type TEXT DEFAULT 'unknown',
          source_url TEXT DEFAULT '', file_path TEXT DEFAULT '',
          title TEXT DEFAULT '', author TEXT DEFAULT '',
          published_at TEXT DEFAULT '', duration INTEGER DEFAULT 0,
          page_count INTEGER DEFAULT 0,
          metadata JSONB DEFAULT '{}', status TEXT DEFAULT 'pending',
          ingested_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (id, collection_id)
        );
        CREATE TABLE IF NOT EXISTS atoms (
          id TEXT PRIMARY KEY,
          source_id TEXT, collection_id TEXT,
          text TEXT,
          atom_index INTEGER DEFAULT 0,
          atom_type TEXT DEFAULT 'general',
          atom_confidence REAL DEFAULT 1.0,
          start_time REAL DEFAULT 0, end_time REAL DEFAULT 0,
          timestamp_url TEXT DEFAULT '',
          page_number INTEGER DEFAULT 0,
          speaker TEXT,
          d_persona TEXT DEFAULT '',
          d_buying_stage TEXT DEFAULT '',
          d_emotional_driver TEXT DEFAULT '',
          d_evidence_type TEXT DEFAULT '',
          d_credibility INTEGER DEFAULT 3,
          d_recency TEXT DEFAULT '',
          embedding JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS intelligence (
          id SERIAL PRIMARY KEY, collection_id TEXT, intel_type TEXT,
          data JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_sources_col   ON sources(collection_id);
        CREATE INDEX IF NOT EXISTS idx_atoms_src     ON atoms(source_id);
        CREATE INDEX IF NOT EXISTS idx_atoms_col     ON atoms(collection_id);
        CREATE INDEX IF NOT EXISTS idx_atoms_persona ON atoms(d_persona);
        CREATE INDEX IF NOT EXISTS idx_atoms_stage   ON atoms(d_buying_stage);
        CREATE INDEX IF NOT EXISTS idx_intel_col     ON intelligence(collection_id);
      `);
      await this._migratePostgres();
      this.pgReady = true;
      console.log('  Storage: PostgreSQL');
    } catch (err) {
      console.error('  PG failed, falling back to SQLite:', err.message);
      if (Database) {
        this.db = new Database(path.join(this.dataDir, 'tde.db'));
        this.db.pragma('journal_mode = WAL');
        this._initSqliteTables();
      }
    }
  }

  async _migratePostgres() {
    const migrations = [
      `ALTER TABLE sources ADD COLUMN IF NOT EXISTS file_path TEXT DEFAULT ''`,
      `ALTER TABLE sources ADD COLUMN IF NOT EXISTS page_count INTEGER DEFAULT 0`,
      `ALTER TABLE atoms ADD COLUMN IF NOT EXISTS speaker TEXT`,
      `ALTER TABLE atoms ADD COLUMN IF NOT EXISTS timestamp_url TEXT DEFAULT ''`,
      `ALTER TABLE atoms ADD COLUMN IF NOT EXISTS atom_confidence REAL DEFAULT 1.0`,
    ];
    for (const sql of migrations) {
      try { await this.pg.query(sql); }
      catch (err) { console.log(`  Migration note: ${err.message}`); }
    }
    console.log('  Migrations: checked');
  }

  _initSqliteTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '', metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS sources (id TEXT, collection_id TEXT, source_type TEXT DEFAULT 'unknown', source_url TEXT DEFAULT '', file_path TEXT DEFAULT '', title TEXT DEFAULT '', author TEXT DEFAULT '', published_at TEXT DEFAULT '', duration INTEGER DEFAULT 0, page_count INTEGER DEFAULT 0, metadata TEXT DEFAULT '{}', status TEXT DEFAULT 'pending', ingested_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (id, collection_id));
      CREATE TABLE IF NOT EXISTS atoms (id TEXT PRIMARY KEY, source_id TEXT, collection_id TEXT, text TEXT, atom_index INTEGER DEFAULT 0, atom_type TEXT DEFAULT 'general', atom_confidence REAL DEFAULT 1.0, start_time REAL DEFAULT 0, end_time REAL DEFAULT 0, page_number INTEGER DEFAULT 0, speaker TEXT, d_persona TEXT DEFAULT '', d_buying_stage TEXT DEFAULT '', d_emotional_driver TEXT DEFAULT '', d_evidence_type TEXT DEFAULT '', d_credibility INTEGER DEFAULT 3, d_recency TEXT DEFAULT '', embedding TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE IF NOT EXISTS intelligence (id INTEGER PRIMARY KEY AUTOINCREMENT, collection_id TEXT, intel_type TEXT, data TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
      CREATE INDEX IF NOT EXISTS idx_sources_col ON sources(collection_id);
      CREATE INDEX IF NOT EXISTS idx_atoms_src ON atoms(source_id);
      CREATE INDEX IF NOT EXISTS idx_atoms_col ON atoms(collection_id);
      CREATE INDEX IF NOT EXISTS idx_atoms_persona ON atoms(d_persona);
      CREATE INDEX IF NOT EXISTS idx_atoms_stage ON atoms(d_buying_stage);
    `);
  }

  async _waitReady() { if (this._pgInitPromise) await this._pgInitPromise; }
  _usePg() { return this.pgReady && this.pg; }

  // ── Qdrant ─────────────────────────────────────────────────────────────────

  async _initQdrant() {
    if (!QdrantClient || !config.QDRANT_URL) { console.log('  Qdrant: not configured (SQLite vector fallback)'); return; }
    try {
      const opts = { url: config.QDRANT_URL };
      if (config.QDRANT_API_KEY) opts.apiKey = config.QDRANT_API_KEY;
      this.qdrant = new QdrantClient(opts);
      const result = await this.qdrant.getCollections();
      this.qdrantReady = true;
      console.log(`  Qdrant: connected (${result.collections.length} collections)`);
    } catch (err) { console.log(`  Qdrant: failed (${err.message})`); }
  }

  async _ensureQdrantCollection(collectionId) {
    if (!this.qdrantReady) return false;
    const qName = this._qName(collectionId);
    try { await this.qdrant.getCollection(qName); return true; } catch {}
    try {
      await this.qdrant.createCollection(qName, { vectors: { size: config.EMBEDDING_DIMENSION, distance: 'Cosine' } });
      console.log(`  Qdrant: created "${qName}"`);
      return true;
    } catch (err) { console.error(`  Qdrant: create failed: ${err.message}`); return false; }
  }

  _qName(id) { return 'tde_' + id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200); }

  // ── Collections ────────────────────────────────────────────────────────────

  async createCollection(id, name, description = '', metadata = {}) {
    await this._waitReady();
    if (this._usePg()) {
      await this.pg.query(
        `INSERT INTO collections (id,name,description,metadata) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET name=$2,description=$3,metadata=$4,updated_at=NOW()`,
        [id, name, description, JSON.stringify(metadata)]
      );
    } else if (this.db) {
      this.db.prepare('INSERT OR REPLACE INTO collections (id,name,description,metadata) VALUES (?,?,?,?)')
        .run(id, name, description, JSON.stringify(metadata));
    }
    this._ensureQdrantCollection(id).catch(() => {});
    return { id, name, description, metadata };
  }

  async getCollection(id) {
    await this._waitReady();
    if (this._usePg()) {
      const r = await this.pg.query('SELECT * FROM collections WHERE id=$1', [id]);
      if (!r.rows[0]) return null;
      const row = r.rows[0];
      return { ...row, metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata };
    }
    if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM collections WHERE id=?').get(id);
    if (!row) return null;
    return { ...row, metadata: JSON.parse(row.metadata || '{}') };
  }

  async listCollections() {
    await this._waitReady();
    if (this._usePg()) {
      const r = await this.pg.query('SELECT * FROM collections ORDER BY created_at DESC');
      return r.rows.map(row => ({ ...row, metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata }));
    }
    if (!this.db) return [];
    return this.db.prepare('SELECT * FROM collections ORDER BY created_at DESC').all()
      .map(r => ({ ...r, metadata: JSON.parse(r.metadata || '{}') }));
  }

  async deleteCollection(id) {
    await this._waitReady();
    if (this._usePg()) {
      await this.pg.query('DELETE FROM atoms WHERE collection_id=$1', [id]);
      await this.pg.query('DELETE FROM sources WHERE collection_id=$1', [id]);
      await this.pg.query('DELETE FROM intelligence WHERE collection_id=$1', [id]);
      await this.pg.query('DELETE FROM collections WHERE id=$1', [id]);
    } else if (this.db) {
      this.db.prepare('DELETE FROM atoms WHERE collection_id=?').run(id);
      this.db.prepare('DELETE FROM sources WHERE collection_id=?').run(id);
      this.db.prepare('DELETE FROM intelligence WHERE collection_id=?').run(id);
      this.db.prepare('DELETE FROM collections WHERE id=?').run(id);
    }
    if (this.qdrantReady) {
      try { await this.qdrant.deleteCollection(this._qName(id)); console.log(`  Qdrant: deleted ${this._qName(id)}`); }
      catch (err) { console.log(`  Qdrant delete note: ${err.message}`); }
    }
    console.log(`  Deleted collection: ${id}`);
  }

  // ── Sources ────────────────────────────────────────────────────────────────

  async addSource(collectionId, source) {
    await this._waitReady();
    const meta = JSON.stringify(source.metadata || {});
    if (this._usePg()) {
      await this.pg.query(
        `INSERT INTO sources (id,collection_id,source_type,source_url,file_path,title,author,published_at,duration,page_count,metadata,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id,collection_id) DO UPDATE SET title=$6,metadata=$11,status=$12`,
        [source.id, collectionId, source.sourceType||'unknown', source.sourceUrl||'',
         source.filePath||'', source.title||'', source.author||'', source.publishedAt||'',
         source.duration||0, source.pageCount||0, meta, source.status||'ready']
      );
    } else if (this.db) {
      this.db.prepare('INSERT OR REPLACE INTO sources (id,collection_id,source_type,source_url,file_path,title,author,published_at,duration,page_count,metadata,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(source.id, collectionId, source.sourceType||'unknown', source.sourceUrl||'',
          source.filePath||'', source.title||'', source.author||'', source.publishedAt||'',
          source.duration||0, source.pageCount||0, meta, source.status||'ready');
    }
    return source;
  }

  async deleteSource(collectionId, sourceId) {
    await this._waitReady();
    if (this._usePg()) {
      await this.pg.query('DELETE FROM atoms WHERE collection_id=$1 AND source_id=$2', [collectionId, sourceId]);
      await this.pg.query('DELETE FROM sources WHERE collection_id=$1 AND id=$2', [collectionId, sourceId]);
    } else if (this.db) {
      this.db.prepare('DELETE FROM atoms WHERE collection_id=? AND source_id=?').run(collectionId, sourceId);
      this.db.prepare('DELETE FROM sources WHERE collection_id=? AND id=?').run(collectionId, sourceId);
    }
    if (this.qdrantReady) {
      try {
        await this.qdrant.delete(this._qName(collectionId), {
          filter: { must: [{ key: 'source_id', match: { value: sourceId } }] }
        });
        console.log(`  Qdrant: deleted source ${sourceId} from ${this._qName(collectionId)}`);
      } catch (err) { console.log(`  Qdrant source delete note: ${err.message}`); }
    }
    console.log(`  Deleted source ${sourceId} from collection ${collectionId}`);
  }

  async getSource(collectionId, sourceId) {
    await this._waitReady();
    if (this._usePg()) {
      const r = await this.pg.query('SELECT * FROM sources WHERE id=$1 AND collection_id=$2', [sourceId, collectionId]);
      if (!r.rows[0]) return null;
      const row = r.rows[0];
      return { ...row, metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata };
    }
    if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM sources WHERE id=? AND collection_id=?').get(sourceId, collectionId);
    if (!row) return null;
    return { ...row, metadata: JSON.parse(row.metadata || '{}') };
  }

  async getSources(collectionId) {
    await this._waitReady();
    if (this._usePg()) {
      const r = await this.pg.query('SELECT * FROM sources WHERE collection_id=$1 ORDER BY ingested_at DESC', [collectionId]);
      return r.rows.map(row => ({ ...row, metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata }));
    }
    if (!this.db) return [];
    return this.db.prepare('SELECT * FROM sources WHERE collection_id=? ORDER BY ingested_at DESC').all(collectionId)
      .map(r => ({ ...r, metadata: JSON.parse(r.metadata || '{}') }));
  }

  // ── Atoms ──────────────────────────────────────────────────────────────────

  async storeAtoms(collectionId, sourceId, atoms) {
    await this._waitReady();
    if (this._usePg()) {
      const client = await this.pg.connect();
      try {
        await client.query('BEGIN');
        for (const a of atoms) {
          await client.query(
            `INSERT INTO atoms (id,source_id,collection_id,text,atom_index,atom_type,atom_confidence,
              start_time,end_time,timestamp_url,page_number,speaker,
              d_persona,d_buying_stage,d_emotional_driver,d_evidence_type,d_credibility,d_recency,
              embedding)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
             ON CONFLICT (id) DO UPDATE SET text=$4,timestamp_url=$10,d_persona=$13,d_buying_stage=$14,
               d_emotional_driver=$15,d_evidence_type=$16,d_credibility=$17,d_recency=$18,embedding=$19`,
            [a.id, sourceId, collectionId, a.text,
             a.atomIndex||0, a.atomType||'general', a.confidence||1.0,
             a.startTime||0, a.endTime||0, a.timestampUrl||'', a.pageNumber||0, a.speaker||null,
             a.d_persona||'', a.d_buying_stage||'', a.d_emotional_driver||'',
             a.d_evidence_type||'', a.d_credibility||3, a.d_recency||'',
             a.embedding ? JSON.stringify(a.embedding) : null]
          );
        }
        await client.query('COMMIT');
      } catch (err) { await client.query('ROLLBACK'); throw err; }
      finally { client.release(); }
    } else if (this.db) {
      const stmt = this.db.prepare(`INSERT OR REPLACE INTO atoms (id,source_id,collection_id,text,atom_index,atom_type,atom_confidence,start_time,end_time,page_number,speaker,d_persona,d_buying_stage,d_emotional_driver,d_evidence_type,d_credibility,d_recency,embedding) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const tx = this.db.transaction(items => {
        for (const a of items) {
          stmt.run(a.id, sourceId, collectionId, a.text, a.atomIndex||0, a.atomType||'general', a.confidence||1.0, a.startTime||0, a.endTime||0, a.pageNumber||0, a.speaker||null, a.d_persona||'', a.d_buying_stage||'', a.d_emotional_driver||'', a.d_evidence_type||'', a.d_credibility||3, a.d_recency||'', a.embedding ? JSON.stringify(a.embedding) : null);
        }
      });
      tx(atoms);
    }
    this._upsertQdrantAtoms(collectionId, sourceId, atoms).catch(err => console.log(`  Qdrant upsert skipped: ${err.message}`));
  }

  async getAtoms(collectionId, sourceId = null, filters = {}) {
    await this._waitReady();
    let rows;
    if (this._usePg()) {
      let sql = 'SELECT * FROM atoms WHERE collection_id=$1';
      const params = [collectionId]; let i = 2;
      if (sourceId) { sql += ` AND source_id=$${i++}`; params.push(sourceId); }
      if (filters.persona) { sql += ` AND d_persona=$${i++}`; params.push(filters.persona); }
      if (filters.buying_stage) { sql += ` AND d_buying_stage=$${i++}`; params.push(filters.buying_stage); }
      if (filters.evidence_type) { sql += ` AND d_evidence_type=$${i++}`; params.push(filters.evidence_type); }
      sql += ' ORDER BY atom_index';
      const r = await this.pg.query(sql, params);
      rows = r.rows;
    } else {
      if (!this.db) return [];
      let sql = 'SELECT * FROM atoms WHERE collection_id=?';
      const params = [collectionId];
      if (sourceId) { sql += ' AND source_id=?'; params.push(sourceId); }
      if (filters.persona) { sql += ' AND d_persona=?'; params.push(filters.persona); }
      if (filters.buying_stage) { sql += ' AND d_buying_stage=?'; params.push(filters.buying_stage); }
      sql += ' ORDER BY atom_index';
      rows = this.db.prepare(sql).all(...params);
    }
    return rows.map(r => ({ ...r, embedding: r.embedding ? (typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding) : null }));
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async search(collectionId, queryEmbedding, topK = 10, filters = {}) {
    if (!queryEmbedding) return [];
    if (this.qdrantReady) {
      try { return await this._qdrantSearch(collectionId, queryEmbedding, topK, filters); }
      catch (err) { console.log(`  Qdrant search failed, fallback: ${err.message}`); }
    }
    return this._localSearch(collectionId, queryEmbedding, topK);
  }

  async _qdrantSearch(collectionId, queryEmbedding, topK, filters = {}) {
    const qName = this._qName(collectionId);
    const must = [];
    if (filters.persona) must.push({ key: 'd_persona', match: { value: filters.persona } });
    if (filters.buying_stage) must.push({ key: 'd_buying_stage', match: { value: filters.buying_stage } });
    if (filters.evidence_type) must.push({ key: 'd_evidence_type', match: { value: filters.evidence_type } });
    const queryParams = { vector: queryEmbedding, limit: topK, with_payload: true, score_threshold: 0.1 };
    if (must.length) queryParams.filter = { must };
    const results = await this.qdrant.search(qName, queryParams);
    return results.map(r => ({
      id: r.payload.atom_id, source_id: r.payload.source_id, collection_id: r.payload.collection_id,
      text: r.payload.text, atom_index: r.payload.atom_index, atom_type: r.payload.atom_type,
      start_time: r.payload.start_time, page_number: r.payload.page_number, speaker: r.payload.speaker,
      d_persona: r.payload.d_persona, d_buying_stage: r.payload.d_buying_stage,
      d_emotional_driver: r.payload.d_emotional_driver, d_evidence_type: r.payload.d_evidence_type,
      d_credibility: r.payload.d_credibility, d_recency: r.payload.d_recency,
      similarity: r.score,
    }));
  }

  async _localSearch(collectionId, queryEmbedding, topK) {
    const atoms = (await this.getAtoms(collectionId)).filter(a => a.embedding);
    const scored = atoms.map(a => ({ ...a, similarity: cosineSim(queryEmbedding, a.embedding) }));
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  async _upsertQdrantAtoms(collectionId, sourceId, atoms) {
    if (!this.qdrantReady) return;
    const ready = await this._ensureQdrantCollection(collectionId);
    if (!ready) return;
    const qName = this._qName(collectionId);
    const points = atoms.filter(a => a.embedding && Array.isArray(a.embedding)).map(a => ({
      id: this._hashToInt(a.id),
      vector: a.embedding,
      payload: {
        atom_id: a.id, source_id: sourceId, collection_id: collectionId,
        text: a.text, atom_index: a.atomIndex||0, atom_type: a.atomType||'general',
        start_time: a.startTime||0, page_number: a.pageNumber||0, speaker: a.speaker||'',
        d_persona: a.d_persona||'', d_buying_stage: a.d_buying_stage||'',
        d_emotional_driver: a.d_emotional_driver||'', d_evidence_type: a.d_evidence_type||'',
        d_credibility: a.d_credibility||3, d_recency: a.d_recency||'',
      },
    }));
    if (!points.length) return;
    for (let i = 0; i < points.length; i += 100) {
      await this.qdrant.upsert(qName, { wait: true, points: points.slice(i, i + 100) });
    }
    console.log(`  Qdrant: upserted ${points.length} atoms`);
  }

  // ── Intelligence ───────────────────────────────────────────────────────────

  async storeIntelligence(collectionId, intelType, data) {
    await this._waitReady();
    if (this._usePg()) {
      await this.pg.query('DELETE FROM intelligence WHERE collection_id=$1 AND intel_type=$2', [collectionId, intelType]);
      await this.pg.query('INSERT INTO intelligence (collection_id,intel_type,data) VALUES ($1,$2,$3)',
        [collectionId, intelType, JSON.stringify(data)]);
    } else if (this.db) {
      this.db.prepare('DELETE FROM intelligence WHERE collection_id=? AND intel_type=?').run(collectionId, intelType);
      this.db.prepare('INSERT INTO intelligence (collection_id,intel_type,data) VALUES (?,?,?)')
        .run(collectionId, intelType, JSON.stringify(data));
    }
  }

  async getIntelligence(collectionId, intelType = null) {
    await this._waitReady();
    if (this._usePg()) {
      if (intelType) {
        const r = await this.pg.query('SELECT * FROM intelligence WHERE collection_id=$1 AND intel_type=$2 ORDER BY created_at DESC LIMIT 1', [collectionId, intelType]);
        if (!r.rows[0]) return null;
        return { data: typeof r.rows[0].data === 'string' ? JSON.parse(r.rows[0].data) : r.rows[0].data };
      }
      const r = await this.pg.query('SELECT * FROM intelligence WHERE collection_id=$1 ORDER BY created_at DESC', [collectionId]);
      return r.rows.map(row => ({ type: row.intel_type, data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data }));
    }
    if (!this.db) return null;
    if (intelType) {
      const row = this.db.prepare('SELECT * FROM intelligence WHERE collection_id=? AND intel_type=? ORDER BY created_at DESC LIMIT 1').get(collectionId, intelType);
      return row ? { data: JSON.parse(row.data || '{}') } : null;
    }
    return this.db.prepare('SELECT * FROM intelligence WHERE collection_id=? ORDER BY created_at DESC').all(collectionId)
      .map(r => ({ type: r.intel_type, data: JSON.parse(r.data || '{}') }));
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  async getStats(collectionId) {
    await this._waitReady();
    if (this._usePg()) {
      const sc  = await this.pg.query('SELECT COUNT(*) as n FROM sources WHERE collection_id=$1', [collectionId]);
      const ac  = await this.pg.query('SELECT COUNT(*) as n FROM atoms   WHERE collection_id=$1', [collectionId]);
      const dur = await this.pg.query('SELECT COALESCE(SUM(duration),0) as d FROM sources WHERE collection_id=$1', [collectionId]);
      const types = await this.pg.query('SELECT source_type, COUNT(*) as n FROM sources WHERE collection_id=$1 GROUP BY source_type', [collectionId]);
      return {
        collectionId, sourceCount: parseInt(sc.rows[0].n), atomCount: parseInt(ac.rows[0].n),
        totalDurationHours: Math.round(parseInt(dur.rows[0].d) / 3600 * 10) / 10,
        vectorStore: this.qdrantReady ? 'qdrant' : 'postgres',
        sourceTypes: Object.fromEntries(types.rows.map(r => [r.source_type, parseInt(r.n)])),
      };
    }
    if (!this.db) return {};
    const sourceCount = this.db.prepare('SELECT COUNT(*) as n FROM sources WHERE collection_id=?').get(collectionId)?.n || 0;
    const atomCount   = this.db.prepare('SELECT COUNT(*) as n FROM atoms   WHERE collection_id=?').get(collectionId)?.n || 0;
    const totalDuration = this.db.prepare('SELECT SUM(duration) as d FROM sources WHERE collection_id=?').get(collectionId)?.d || 0;
    const typeRows = this.db.prepare('SELECT source_type, COUNT(*) as n FROM sources WHERE collection_id=? GROUP BY source_type').all(collectionId);
    return {
      collectionId, sourceCount, atomCount,
      totalDurationHours: Math.round(totalDuration / 3600 * 10) / 10,
      vectorStore: this.qdrantReady ? 'qdrant' : 'sqlite',
      sourceTypes: Object.fromEntries(typeRows.map(r => [r.source_type, r.n])),
    };
  }

  _hashToInt(str) { let h = 0; for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h = h & h; } return Math.abs(h); }
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; magA += a[i]*a[i]; magB += b[i]*b[i]; }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

module.exports = Store;
