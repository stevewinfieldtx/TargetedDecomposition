# TDE — Targeted Decomposition Engine

**Ingest anything. Atomize everything. Synthesize on demand.**

The core knowledge processing engine behind WinTech Partners' product stack.
Powered by the Targeted Decomposition™ methodology.

Built by Steve Winfield / WinTech Partners.

## What It Does

TDE takes any content — YouTube videos, PDFs, Word docs, PowerPoints, audio files, web pages, raw text — and breaks it into **atomic intelligence units** (not dumb 500-word chunks). Each atom is tagged across 6 dimensions and stored for surgical-precision retrieval.

## The Pipeline

```
ANY CONTENT → Ingestor → The Munger → 6D Tagger → Embeddings → Store → Search/Synthesize
```

## Templates (Vertical Instantiations)

| Template | Brand Name | Use Case |
|----------|-----------|----------|
| church | TrueTeachings | Sermons, pastors, faith leaders |
| influencer | TrueInfluence | Content creators, influencers |
| food | TrueFood | Food influencers, restaurant reviews |
| influencereats | InfluencerEats | Food discovery map pins |
| business | TrueComms | Sales intelligence, competitive intel |
| couple | TrueCouple | Couple creators (speaker separation) |
| education | TrueTeach | Educational content |
| default | TDE | General content intelligence |

## Quick Start

```bash
npm install
node src/cli.js create my-collection influencer "My Collection"
node src/cli.js ingest my-collection youtube https://youtube.com/watch?v=...
node src/cli.js ingest my-collection pdf /path/to/document.pdf
node src/cli.js ingest my-collection web https://example.com/article
node src/cli.js search my-collection "what topics did they cover"
node src/cli.js ask my-collection "What products were recommended?"
```

## API Server

```bash
npm start
# http://localhost:8400/health
# http://localhost:8400/admin
```

## Supported Content Types

- **YouTube** — videos + channels (captions → Groq Whisper fallback)
- **PDF** — text extraction with page structure
- **DOCX** — Word document extraction
- **PPTX** — PowerPoint slide extraction
- **Audio** — MP3, MP4, M4A, WAV, FLAC, OGG, WEBM (via Groq Whisper)
- **Text** — raw text or .txt files
- **Web** — any URL (article extraction via cheerio)

## The 6 Dimensions

Every atom is tagged across:
1. **Persona** — Who cares about this?
2. **Buying Stage** — Where in the journey?
3. **Emotional Driver** — What emotion does it appeal to?
4. **Evidence Type** — What kind of proof is this?
5. **Credibility** — How authoritative? (1-5)
6. **Recency** — How time-sensitive?

## Railway Deployment

1. Push to GitHub
2. Connect repo in Railway
3. Set env vars (see .env.example)
4. Deploy

Required: `OPENROUTER_API_KEY`, `YOUTUBE_API_KEY`
Optional: `GROQ_API_KEY`, `API_SECRET_KEY`, `ELEVENLABS_API_KEY`, `DATABASE_URL`, `QDRANT_URL`
