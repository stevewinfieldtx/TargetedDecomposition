#!/usr/bin/env node
/**
 * TDE — Targeted Decomposition Engine CLI
 * ═══════════════════════════════════════════════════════════════════
 * node src/cli.js create <id> <template> [name]
 * node src/cli.js ingest <collectionId> <type> <input>
 * node src/cli.js channel <collectionId> <channelUrl> [maxVideos]
 * node src/cli.js analyze <collectionId>
 * node src/cli.js search <collectionId> <query>
 * node src/cli.js ask <collectionId> <question>
 * node src/cli.js stats <collectionId>
 * node src/cli.js collections
 */
const TDEngine = require('./core/engine');
const config = require('./config');
const engine = new TDEngine();
const [,, command, ...args] = process.argv;

async function main() {
  switch (command) {
    case 'create': {
      const [id, template, ...rest] = args;
      const name = rest.join(' ') || id;
      if (!id) { console.log('Usage: create <id> <template> [name]'); return; }
      engine.createCollection(id, name, template ? `Template: ${template}` : '');
      console.log(`Created: ${id} (${template || 'default'})`);
      break;
    }
    case 'ingest': {
      const [colId, type, input] = args;
      if (!colId || !type || !input) { console.log('Usage: ingest <collectionId> <type> <input>\nTypes: youtube, pdf, docx, pptx, audio, text, web'); return; }
      await engine.ingest(colId, type, input);
      break;
    }
    case 'channel': {
      const [colId, channelUrl, maxStr] = args;
      if (!colId || !channelUrl) { console.log('Usage: channel <collectionId> <channelUrl> [maxVideos]'); return; }
      await engine.ingestChannel(colId, channelUrl, parseInt(maxStr) || 50);
      break;
    }
    case 'analyze': {
      const [colId] = args;
      if (!colId) { console.log('Usage: analyze <collectionId>'); return; }
      if (engine.analyzeCollection) {
        await engine.analyzeCollection(colId);
      } else {
        console.log('Analysis layer not yet integrated. Coming in next update.');
      }
      break;
    }
    case 'search': {
      const [colId, ...qParts] = args;
      const query = qParts.join(' ');
      if (!colId || !query) { console.log('Usage: search <collectionId> <query>'); return; }
      const results = await engine.search(colId, query);
      console.log(`\nSearch: "${query}" (${results.length} results)\n`);
      for (const r of results) {
        console.log(`  [${r.similarity}%] ${r.text.slice(0, 150)}...`);
      }
      break;
    }
    case 'ask': {
      const [colId, ...qParts] = args;
      const question = qParts.join(' ');
      if (!colId || !question) { console.log('Usage: ask <collectionId> <question>'); return; }
      const result = await engine.ask(colId, question);
      console.log(`\nQ: ${question}\nA: ${result.answer}\n`);
      if (result.atoms?.length) {
        console.log('Sources:');
        result.atoms.forEach(a => console.log(`  [${a.similarity}%] ${a.text.slice(0, 100)}...`));
      }
      break;
    }
    case 'stats': {
      const [colId] = args;
      if (!colId) { console.log('Usage: stats <collectionId>'); return; }
      const stats = await engine.getStats(colId);
      console.log(`\nStats: ${colId}`);
      console.log(JSON.stringify(stats, null, 2));
      break;
    }
    case 'collections': {
      const cols = await engine.listCollections();
      if (!cols.length) { console.log('No collections yet.'); return; }
      for (const c of cols) { console.log(`  ${c.id} — ${c.name}`); }
      break;
    }
    default:
      console.log(`
TDE — Targeted Decomposition Engine CLI
════════════════════════════════════════
Commands:
  create <id> <template> [name]        Create collection (templates: ${Object.keys(config.TEMPLATES).join(', ')})
  ingest <collectionId> <type> <input> Ingest content (types: youtube, pdf, docx, pptx, audio, text, web)
  channel <colId> <channelUrl> [max]   Ingest YouTube channel
  analyze <collectionId>               Run template-specific analysis
  search <collectionId> <query>        Search atoms (6D filtered)
  ask <collectionId> <question>        RAG Q&A
  stats <collectionId>                 Show stats
  collections                          List all collections`);
  }
}
main().catch(err => { console.error('Fatal:', err); process.exit(1); });
