/**
 * TDE — Audio Ingestor
 * Transcribes local audio/video files using Groq Whisper.
 * Supports: MP3, MP4, M4A, WAV, FLAC, OGG, WEBM
 * Max file size: 25MB (Groq limit)
 */

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const FormData = require('form-data');
const config  = require('../config');

const SUPPORTED = ['.mp3', '.mp4', '.m4a', '.wav', '.flac', '.ogg', '.webm'];
const MAX_BYTES = 25 * 1024 * 1024; // 25MB

async function extractAudio(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED.includes(ext)) throw new Error(`Unsupported audio format: ${ext}. Supported: ${SUPPORTED.join(', ')}`);
  if (!config.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set — required for audio transcription');

  const stat = fs.statSync(filePath);
  if (stat.size > MAX_BYTES) throw new Error(`File too large (${Math.round(stat.size / 1024 / 1024)}MB). Groq limit is 25MB.`);

  console.log(`  Transcribing audio: ${path.basename(filePath)} (${Math.round(stat.size / 1024)}KB)...`);
  const result = await groqTranscribe(filePath);
  if (!result) throw new Error('Transcription failed — check Groq API key and file format');

  const title = path.basename(filePath, ext);
  return {
    text: result.text,
    segments: result.segments || [],
    pageCount: 0,
    title,
    author: '',
    duration: result.duration || estimateDuration(result.segments),
    metadata: { language: result.language, transcriptionSource: 'groq-whisper' },
  };
}

function groqTranscribe(filePath) {
  return new Promise((resolve) => {
    const ext      = path.extname(filePath).toLowerCase();
    const mimeMap  = { '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.webm': 'audio/webm' };
    const mimeType = mimeMap[ext] || 'audio/mpeg';
    const form     = new FormData();
    form.append('file', fs.createReadStream(filePath), { filename: path.basename(filePath), contentType: mimeType });
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'verbose_json');
    form.append('language', 'en');

    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/audio/transcriptions',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.GROQ_API_KEY}`, ...form.getHeaders() },
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) { console.log(`  Groq error ${res.statusCode}: ${body.slice(0, 200)}`); resolve(null); return; }
        try {
          const data = JSON.parse(body);
          const segments = (data.segments || []).map((seg, i) => ({
            id: i, start: seg.start || 0, end: seg.end || 0, text: (seg.text || '').trim(),
          }));
          resolve({ text: (data.text || '').trim(), segments, language: data.language || 'en', duration: data.duration || 0 });
        } catch (e) { console.log(`  Groq parse error: ${e.message}`); resolve(null); }
      });
    });
    req.on('error', err => { console.log(`  Groq request error: ${err.message}`); resolve(null); });
    form.pipe(req);
  });
}

function estimateDuration(segments) {
  if (!segments || !segments.length) return 0;
  return Math.round(segments[segments.length - 1].end || 0);
}

module.exports = { extractAudio };
