/**
 * TDE Intelligence Cache — Company & Industry Knowledge Persistence
 * ═══════════════════════════════════════════════════════════════════
 * Mount: require('./routes/intel-cache-routes')(app, auth, pg);
 */

const TTL_DAYS = parseInt(process.env.INTEL_TTL_DAYS) || 30;

module.exports = function mountIntelCache(app, auth, pg) {
  if (!pg) {
    console.log('  Intel Cache: SKIPPED (no PostgreSQL connection)');
    return;
  }

  const init = async () => {
    await pg.query(`
      CREATE TABLE IF NOT EXISTS company_intel (
        domain          TEXT PRIMARY KEY,
        company_name    TEXT NOT NULL,
        website         TEXT,
        industry        TEXT,
        sub_industry    TEXT,
        sic_code        TEXT,
        naics_code      TEXT,
        local_code      TEXT,
        local_code_system TEXT,
        country         TEXT,
        address         TEXT,
        classification_confidence TEXT,
        classification_source     TEXT,
        industry_data   JSONB DEFAULT '{}',
        painpoints_data JSONB DEFAULT '{}',
        company_pain_data JSONB DEFAULT '{}',
        customer_data   JSONB DEFAULT '{}',
        compete_data    JSONB DEFAULT '{}',
        solution_context JSONB DEFAULT '{}',
        contacts        JSONB DEFAULT '[]',
        leadership      JSONB DEFAULT '[]',
        industry_researched_at    TIMESTAMPTZ,
        painpoints_researched_at  TIMESTAMPTZ,
        company_pain_researched_at TIMESTAMPTZ,
        customer_researched_at    TIMESTAMPTZ,
        compete_researched_at     TIMESTAMPTZ,
        contacts_researched_at    TIMESTAMPTZ,
        leadership_researched_at  TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        ttl_days        INT DEFAULT ${TTL_DAYS},
        source          TEXT DEFAULT 'lead_hydration',
        tags            TEXT[] DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_company_intel_industry ON company_intel(industry);
      CREATE INDEX IF NOT EXISTS idx_company_intel_country ON company_intel(country);
      CREATE INDEX IF NOT EXISTS idx_company_intel_updated ON company_intel(updated_at);
    `);

    await pg.query(`
      CREATE TABLE IF NOT EXISTS industry_intel (
        industry_key    TEXT PRIMARY KEY,
        industry_name   TEXT NOT NULL,
        sub_industries  TEXT[] DEFAULT '{}',
        sic_codes       TEXT[] DEFAULT '{}',
        naics_codes     TEXT[] DEFAULT '{}',
        pain_points     JSONB DEFAULT '[]',
        trends          JSONB DEFAULT '[]',
        regulations     JSONB DEFAULT '[]',
        tech_landscape  JSONB DEFAULT '{}',
        observations    JSONB DEFAULT '[]',
        solution_pains  JSONB DEFAULT '{}',
        pain_points_researched_at  TIMESTAMPTZ,
        trends_researched_at       TIMESTAMPTZ,
        regulations_researched_at  TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        ttl_days        INT DEFAULT ${TTL_DAYS},
        company_count   INT DEFAULT 0,
        tags            TEXT[] DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_industry_intel_name ON industry_intel(industry_name);
    `);

    console.log('  Intel Cache: company_intel + industry_intel tables ready');
  };

  init().catch(err => console.error('  Intel Cache init error:', err.message));

  function slugify(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 120);
  }

  function domainFromUrl(url) {
    return (url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase().trim();
  }

  function isFresh(timestamp, ttlDays) {
    if (!timestamp) return false;
    const age = Date.now() - new Date(timestamp).getTime();
    return age < (ttlDays || TTL_DAYS) * 24 * 60 * 60 * 1000;
  }

  function freshnessReport(row) {
    const ttl = row.ttl_days || TTL_DAYS;
    const sections = {
      industry:     { researched_at: row.industry_researched_at,     fresh: isFresh(row.industry_researched_at, ttl) },
      painpoints:   { researched_at: row.painpoints_researched_at,   fresh: isFresh(row.painpoints_researched_at, ttl) },
      company_pain: { researched_at: row.company_pain_researched_at, fresh: isFresh(row.company_pain_researched_at, ttl) },
      customer:     { researched_at: row.customer_researched_at,     fresh: isFresh(row.customer_researched_at, ttl) },
      compete:      { researched_at: row.compete_researched_at,      fresh: isFresh(row.compete_researched_at, ttl) },
      contacts:     { researched_at: row.contacts_researched_at,     fresh: isFresh(row.contacts_researched_at, ttl) },
      leadership:   { researched_at: row.leadership_researched_at,   fresh: isFresh(row.leadership_researched_at, ttl) },
    };
    const allFresh = Object.values(sections).every(s => s.fresh);
    const staleSections = Object.entries(sections).filter(([, s]) => !s.fresh).map(([k]) => k);
    return { ttl_days: ttl, all_fresh: allFresh, stale_sections: staleSections, sections };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // COMPANY INTEL ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/intel/company/:domain', auth, async (req, res) => {
    try {
      const domain = domainFromUrl(req.params.domain);
      const { rows } = await pg.query('SELECT * FROM company_intel WHERE domain = $1', [domain]);
      if (!rows.length) {
        return res.json({ found: false, domain, message: 'No cached intelligence for this company' });
      }
      const row = rows[0];
      const freshness = freshnessReport(row);
      const requestedSections = req.query.sections ? req.query.sections.split(',').map(s => s.trim()) : null;

      const intel = {
        found: true, domain: row.domain, company_name: row.company_name, website: row.website,
        industry: row.industry, sub_industry: row.sub_industry, sic_code: row.sic_code,
        naics_code: row.naics_code, local_code: row.local_code, local_code_system: row.local_code_system,
        country: row.country, address: row.address, classification_confidence: row.classification_confidence,
        freshness, tags: row.tags, created_at: row.created_at, updated_at: row.updated_at,
      };

      const sectionMap = {
        industry:     { data: row.industry_data,       ts: row.industry_researched_at },
        painpoints:   { data: row.painpoints_data,     ts: row.painpoints_researched_at },
        company_pain: { data: row.company_pain_data,   ts: row.company_pain_researched_at },
        customer:     { data: row.customer_data,        ts: row.customer_researched_at },
        compete:      { data: row.compete_data,         ts: row.compete_researched_at },
        contacts:     { data: row.contacts,             ts: row.contacts_researched_at },
        leadership:   { data: row.leadership,           ts: row.leadership_researched_at },
      };

      intel.sections = {};
      for (const [key, val] of Object.entries(sectionMap)) {
        if (requestedSections && !requestedSections.includes(key)) continue;
        intel.sections[key] = { data: val.data, researched_at: val.ts, fresh: isFresh(val.ts, row.ttl_days || TTL_DAYS) };
      }
      res.json(intel);
    } catch (e) {
      console.error('[Intel Cache] Company lookup error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/intel/company/:domain', auth, async (req, res) => {
    try {
      const domain = domainFromUrl(req.params.domain);
      const { company_name, website, industry, sub_industry, sic_code, naics_code, local_code, local_code_system,
              country, address, classification_confidence, classification_source, sections, tags, solution_context } = req.body;
      if (!company_name) return res.status(400).json({ error: 'company_name is required' });

      const now = new Date().toISOString();
      const updates = [];
      const values = [domain, company_name, website || domain, now];
      let paramIdx = 5;

      const baseFields = { industry, sub_industry, sic_code, naics_code, local_code, local_code_system, country, address, classification_confidence, classification_source };
      for (const [key, val] of Object.entries(baseFields)) {
        if (val !== undefined) { updates.push(`${key} = $${paramIdx}`); values.push(val); paramIdx++; }
      }
      if (solution_context) { updates.push(`solution_context = $${paramIdx}`); values.push(JSON.stringify(solution_context)); paramIdx++; }
      if (tags) { updates.push(`tags = $${paramIdx}`); values.push(tags); paramIdx++; }

      if (sections) {
        const sectionCols = {
          industry: { dataCol: 'industry_data', tsCol: 'industry_researched_at' },
          painpoints: { dataCol: 'painpoints_data', tsCol: 'painpoints_researched_at' },
          company_pain: { dataCol: 'company_pain_data', tsCol: 'company_pain_researched_at' },
          customer: { dataCol: 'customer_data', tsCol: 'customer_researched_at' },
          compete: { dataCol: 'compete_data', tsCol: 'compete_researched_at' },
          contacts: { dataCol: 'contacts', tsCol: 'contacts_researched_at' },
          leadership: { dataCol: 'leadership', tsCol: 'leadership_researched_at' },
        };
        for (const [sectionKey, { dataCol, tsCol }] of Object.entries(sectionCols)) {
          if (sections[sectionKey] !== undefined) {
            updates.push(`${dataCol} = $${paramIdx}`); values.push(JSON.stringify(sections[sectionKey])); paramIdx++;
            updates.push(`${tsCol} = $${paramIdx}`); values.push(now); paramIdx++;
          }
        }
      }
      updates.push(`updated_at = $4`);

      const sql = `
        INSERT INTO company_intel (domain, company_name, website, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (domain) DO UPDATE SET
          company_name = COALESCE($2, company_intel.company_name),
          website = COALESCE($3, company_intel.website),
          ${updates.join(', ')}
        RETURNING domain, company_name, updated_at`;

      const { rows } = await pg.query(sql, values);
      console.log(`[Intel Cache] Company stored: ${domain} (${company_name})`);
      res.json({ ok: true, domain, company_name, updated_at: rows[0]?.updated_at });
    } catch (e) {
      console.error('[Intel Cache] Company store error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/intel/company', auth, async (req, res) => {
    try {
      const { industry, country, stale, limit, offset } = req.query;
      let where = [], params = [], idx = 1;
      if (industry) { where.push(`industry ILIKE $${idx}`); params.push(`%${industry}%`); idx++; }
      if (country)  { where.push(`country = $${idx}`); params.push(country); idx++; }
      const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const lim = Math.min(parseInt(limit) || 100, 500);
      const off = parseInt(offset) || 0;

      const { rows } = await pg.query(
        `SELECT domain, company_name, industry, sub_industry, country, sic_code, naics_code,
                updated_at, industry_researched_at, painpoints_researched_at, company_pain_researched_at,
                contacts_researched_at, tags
         FROM company_intel ${whereClause} ORDER BY updated_at DESC LIMIT ${lim} OFFSET ${off}`, params);

      const companies = rows.map(r => ({
        ...r, freshness: {
          industry: isFresh(r.industry_researched_at, TTL_DAYS), painpoints: isFresh(r.painpoints_researched_at, TTL_DAYS),
          company_pain: isFresh(r.company_pain_researched_at, TTL_DAYS), contacts: isFresh(r.contacts_researched_at, TTL_DAYS),
        }
      }));
      const filtered = stale === 'true' ? companies.filter(c => !Object.values(c.freshness).every(Boolean)) : companies;
      const { rows: countRows } = await pg.query(`SELECT COUNT(*) as total FROM company_intel ${whereClause}`, params);
      res.json({ companies: filtered, total: parseInt(countRows[0].total), limit: lim, offset: off });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // INDUSTRY INTEL ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/intel/industry/:key', auth, async (req, res) => {
    try {
      const key = slugify(req.params.key);
      const { rows } = await pg.query('SELECT * FROM industry_intel WHERE industry_key = $1', [key]);
      if (!rows.length) return res.json({ found: false, industry_key: key, message: 'No cached intelligence for this industry' });

      const row = rows[0];
      const ttl = row.ttl_days || TTL_DAYS;
      const freshness = {
        pain_points: { researched_at: row.pain_points_researched_at, fresh: isFresh(row.pain_points_researched_at, ttl) },
        trends:      { researched_at: row.trends_researched_at,      fresh: isFresh(row.trends_researched_at, ttl) },
        regulations: { researched_at: row.regulations_researched_at, fresh: isFresh(row.regulations_researched_at, ttl) },
      };

      const result = {
        found: true, industry_key: row.industry_key, industry_name: row.industry_name,
        sub_industries: row.sub_industries, sic_codes: row.sic_codes, naics_codes: row.naics_codes,
        pain_points: row.pain_points, trends: row.trends, regulations: row.regulations,
        tech_landscape: row.tech_landscape, observations: row.observations,
        company_count: row.company_count, freshness, created_at: row.created_at, updated_at: row.updated_at,
      };

      const solutionKey = req.query.solution_key;
      if (solutionKey) {
        const cached = (row.solution_pains || {})[solutionKey];
        result.solution_pain_cache = cached
          ? { found: true, solution_key: solutionKey, ...cached, fresh: isFresh(cached.researched_at, ttl) }
          : { found: false, solution_key: solutionKey };
      }
      res.json(result);
    } catch (e) {
      console.error('[Intel Cache] Industry lookup error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.put('/intel/industry/:key', auth, async (req, res) => {
    try {
      const key = slugify(req.params.key);
      const { industry_name, sub_industries, sic_codes, naics_codes, pain_points, trends, regulations,
              tech_landscape, observations, solution_pains, tags } = req.body;
      if (!industry_name) return res.status(400).json({ error: 'industry_name is required' });

      const now = new Date().toISOString();
      let mergedSolutionPains = '{}';
      if (solution_pains) {
        const { rows: existing } = await pg.query('SELECT solution_pains FROM industry_intel WHERE industry_key = $1', [key]);
        const current = existing.length ? (existing[0].solution_pains || {}) : {};
        for (const [solKey, solData] of Object.entries(solution_pains)) { current[solKey] = { ...solData, researched_at: now }; }
        mergedSolutionPains = JSON.stringify(current);
      }

      const sql = `
        INSERT INTO industry_intel (
          industry_key, industry_name, sub_industries, sic_codes, naics_codes,
          pain_points, trends, regulations, tech_landscape, observations,
          solution_pains, tags,
          pain_points_researched_at, trends_researched_at, regulations_researched_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          ${pain_points ? `'${now}'` : 'NULL'}, ${trends ? `'${now}'` : 'NULL'},
          ${regulations ? `'${now}'` : 'NULL'}, '${now}')
        ON CONFLICT (industry_key) DO UPDATE SET
          industry_name = COALESCE($2, industry_intel.industry_name),
          sub_industries = COALESCE($3, industry_intel.sub_industries),
          sic_codes = COALESCE($4, industry_intel.sic_codes),
          naics_codes = COALESCE($5, industry_intel.naics_codes),
          ${pain_points ? `pain_points = $6, pain_points_researched_at = '${now}',` : ''}
          ${trends ? `trends = $7, trends_researched_at = '${now}',` : ''}
          ${regulations ? `regulations = $8, regulations_researched_at = '${now}',` : ''}
          tech_landscape = COALESCE($9, industry_intel.tech_landscape),
          observations = CASE WHEN $10::jsonb != '[]'::jsonb THEN industry_intel.observations || $10::jsonb ELSE industry_intel.observations END,
          solution_pains = $11::jsonb, tags = COALESCE($12, industry_intel.tags), updated_at = '${now}'
        RETURNING industry_key, industry_name, updated_at`;

      const { rows } = await pg.query(sql, [
        key, industry_name, sub_industries || '{}', sic_codes || '{}', naics_codes || '{}',
        JSON.stringify(pain_points || []), JSON.stringify(trends || []), JSON.stringify(regulations || []),
        JSON.stringify(tech_landscape || {}), JSON.stringify(observations || []), mergedSolutionPains, tags || '{}',
      ]);

      const { rows: countRows } = await pg.query(`SELECT COUNT(*) as cnt FROM company_intel WHERE industry ILIKE $1`, [`%${industry_name}%`]);
      await pg.query('UPDATE industry_intel SET company_count = $1 WHERE industry_key = $2', [parseInt(countRows[0].cnt), key]);

      console.log(`[Intel Cache] Industry stored: ${key} (${industry_name})`);
      res.json({ ok: true, industry_key: key, industry_name, updated_at: rows[0]?.updated_at });
    } catch (e) {
      console.error('[Intel Cache] Industry store error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/intel/industry', auth, async (req, res) => {
    try {
      const { rows } = await pg.query(
        `SELECT industry_key, industry_name, sub_industries, sic_codes, naics_codes,
                company_count, pain_points_researched_at, trends_researched_at, updated_at, tags
         FROM industry_intel ORDER BY company_count DESC, updated_at DESC`);
      const industries = rows.map(r => ({
        ...r, freshness: { pain_points: isFresh(r.pain_points_researched_at, TTL_DAYS), trends: isFresh(r.trends_researched_at, TTL_DAYS) }
      }));
      res.json({ industries, total: industries.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CACHE STATS & MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  app.get('/intel/stats', auth, async (req, res) => {
    try {
      const [companies, industries, staleCompanies, staleIndustries] = await Promise.all([
        pg.query('SELECT COUNT(*) as cnt FROM company_intel'),
        pg.query('SELECT COUNT(*) as cnt FROM industry_intel'),
        pg.query(`SELECT COUNT(*) as cnt FROM company_intel WHERE updated_at < NOW() - INTERVAL '${TTL_DAYS} days'`),
        pg.query(`SELECT COUNT(*) as cnt FROM industry_intel WHERE updated_at < NOW() - INTERVAL '${TTL_DAYS} days'`),
      ]);
      const topIndustries = await pg.query(`SELECT industry, COUNT(*) as cnt FROM company_intel WHERE industry IS NOT NULL GROUP BY industry ORDER BY cnt DESC LIMIT 10`);
      const topCountries = await pg.query(`SELECT country, COUNT(*) as cnt FROM company_intel WHERE country IS NOT NULL GROUP BY country ORDER BY cnt DESC LIMIT 10`);
      res.json({
        ttl_days: TTL_DAYS,
        companies: { total: parseInt(companies.rows[0].cnt), stale: parseInt(staleCompanies.rows[0].cnt), fresh: parseInt(companies.rows[0].cnt) - parseInt(staleCompanies.rows[0].cnt) },
        industries: { total: parseInt(industries.rows[0].cnt), stale: parseInt(staleIndustries.rows[0].cnt), fresh: parseInt(industries.rows[0].cnt) - parseInt(staleIndustries.rows[0].cnt) },
        top_industries: topIndustries.rows, top_countries: topCountries.rows,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/intel/invalidate', auth, async (req, res) => {
    try {
      const { type, domain, key, section } = req.body;
      const past = new Date(Date.now() - (TTL_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
      if (type === 'company' && domain) {
        const cleanDomain = domainFromUrl(domain);
        if (section) {
          const tsCol = { industry: 'industry_researched_at', painpoints: 'painpoints_researched_at', company_pain: 'company_pain_researched_at',
            customer: 'customer_researched_at', compete: 'compete_researched_at', contacts: 'contacts_researched_at', leadership: 'leadership_researched_at' }[section];
          if (tsCol) { await pg.query(`UPDATE company_intel SET ${tsCol} = $1 WHERE domain = $2`, [past, cleanDomain]); return res.json({ ok: true, invalidated: `${cleanDomain}:${section}` }); }
        }
        await pg.query('UPDATE company_intel SET updated_at = $1 WHERE domain = $2', [past, cleanDomain]);
        res.json({ ok: true, invalidated: cleanDomain });
      } else if (type === 'industry' && key) {
        const cleanKey = slugify(key);
        await pg.query('UPDATE industry_intel SET updated_at = $1 WHERE industry_key = $2', [past, cleanKey]);
        res.json({ ok: true, invalidated: cleanKey });
      } else { res.status(400).json({ error: 'type (company/industry) and domain/key required' }); }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log('  Intel Cache: routes mounted (/intel/company, /intel/industry, /intel/stats)');
};
