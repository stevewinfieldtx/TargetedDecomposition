/**
 * TDE — YouTube Ingestor
 * ================================
 * Strategy:
 *   1. yt-dlp subtitle-only extraction (via residential proxy if configured)
 *   2. Watch page caption scraping (via proxy if configured)
 *   3. Groq Whisper fallback (audio download via yt-dlp + proxy)
 *   4. YouTube Data API v3 for metadata, channels, comments
 *
 * Captures: views, likes, comments count + top comments text.
 */
const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const FormData = require('form-data');
const config = require('../config');

// Proxy URL for YouTube requests (residential proxy bypasses datacenter IP blocks)
const PROXY_URL = process.env.WEBSHARE_PROXY_URL || '';

function extractVideoId(url) {
  if (url.includes('youtube.com') && url.includes('v=')) return url.split('v=')[1].split('&')[0];
  if (url.includes('youtu.be/')) return url.split('youtu.be/')[1].split('?')[0];
  if (url.includes('/shorts/')) return url.split('/shorts/')[1].split('?')[0];
  return null;
}

async function getVideoMetadata(videoId) {
  if (!config.YOUTUBE_API_KEY) return null;
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoId}&key=${config.YOUTUBE_API_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const item = data.items?.[0];
    if (!item) return null;
    const dur = item.contentDetails?.duration || '';
    const hours = parseInt((dur.match(/(\d+)H/) || [0, 0])[1]) * 3600;
    const mins = parseInt((dur.match(/(\d+)M/) || [0, 0])[1]) * 60;
    const secs = parseInt((dur.match(/(\d+)S/) || [0, 0])[1]);
    return {
      id: videoId, title: item.snippet?.title || '', author: item.snippet?.channelTitle || '',
      description: item.snippet?.description || '', publishedAt: item.snippet?.publishedAt || '',
      duration: hours + mins + secs,
      viewCount: parseInt(item.statistics?.viewCount || '0'),
      likeCount: parseInt(item.statistics?.likeCount || '0'),
      commentCount: parseInt(item.statistics?.commentCount || '0'),
      thumbnail: item.snippet?.thumbnails?.high?.url || '',
      tags: item.snippet?.tags || [],
    };
  } catch (err) { console.error(`  YouTube API error: ${err.message}`); return null; }
}

async function getVideoComments(videoId, maxResults = 50) {
  if (!config.YOUTUBE_API_KEY) return [];
  try {
    const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=${Math.min(maxResults, 100)}&order=relevance&textFormat=plainText&key=${config.YOUTUBE_API_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) { return []; }
    const data = await resp.json();
    return (data.items || []).map(item => {
      const snippet = item.snippet?.topLevelComment?.snippet;
      if (!snippet) return null;
      return {
        author: snippet.authorDisplayName || '',
        text: (snippet.textDisplay || '').trim(),
        likeCount: snippet.likeCount || 0,
        publishedAt: snippet.publishedAt || '',
        replyCount: item.snippet?.totalReplyCount || 0,
      };
    }).filter(Boolean);
  } catch (err) {
    console.error(`  Comments fetch error: ${err.message}`);
    return [];
  }
}

async function getChannelVideoIds(channelInput, maxVideos = 100) {
  if (!config.YOUTUBE_API_KEY) return [];
  try {
    let channelId = channelInput, handle = channelInput;
    if (handle.includes('/@')) handle = handle.split('/@')[1].split('/')[0];
    else if (handle.startsWith('@')) handle = handle.slice(1);
    else if (handle.includes('/channel/')) { channelId = handle.split('/channel/')[1].split('/')[0]; handle = null; }
    if (handle && !channelId.startsWith('UC')) {
      const hResp = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${handle}&key=${config.YOUTUBE_API_KEY}`);
      const hData = await hResp.json();
      channelId = hData.items?.[0]?.id;
      if (!channelId) return [];
    }
    const uploadsId = 'UU' + channelId.slice(2);
    const videos = [];
    let pageToken = '';
    while (videos.length < maxVideos) {
      const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails,snippet&playlistId=${uploadsId}&maxResults=50&key=${config.YOUTUBE_API_KEY}${pageToken ? '&pageToken=' + pageToken : ''}`;
      const resp = await fetch(url); if (!resp.ok) break;
      const data = await resp.json();
      for (const item of (data.items || [])) {
        videos.push({ videoId: item.contentDetails?.videoId, title: item.snippet?.title, publishedAt: item.snippet?.publishedAt });
      }
      pageToken = data.nextPageToken; if (!pageToken) break;
    }
    console.log(`  Found ${videos.length} videos`);
    return videos.slice(0, maxVideos);
  } catch (err) { console.error(`  Channel scan error: ${err.message}`); return []; }
}

// ── Transcript Retrieval ─────────────────────────────────────────────────────

async function getTranscript(videoId) {
  // Strategy 1: yt-dlp subtitle-only extraction (same approach as TrueInfluence)
  // This is the fastest and most reliable — no audio download needed
  console.log(`  Trying yt-dlp subtitle extraction...`);
  const ytdlpResult = await extractSubtitlesViaYtdlp(videoId);
  if (ytdlpResult && ytdlpResult.text.length > 100 && ytdlpResult.segments.length >= 5) {
    console.log(`  yt-dlp subtitles OK: ${ytdlpResult.text.length} chars`);
    return { ...ytdlpResult, source: 'yt-dlp-subs' };
  }

  // Strategy 2: Watch page caption scraping (via proxy if available)
  console.log(`  Trying watch page captions...`);
  const captions = await fetchCaptionsFromWatchPage(videoId);
  if (captions && captions.text.length > 100 && captions.segments.length >= 5) {
    console.log(`  Watch page captions OK: ${captions.text.length} chars`);
    return { ...captions, source: 'watch-page' };
  }

  // Strategy 3: Groq Whisper fallback (audio download + transcription)
  if (config.GROQ_API_KEY) {
    console.log(`  No subtitles found — trying Groq Whisper fallback...`);
    const whisperResult = await downloadAndTranscribe(videoId);
    if (whisperResult && whisperResult.text.length > 20) {
      console.log(`  Groq Whisper OK: ${whisperResult.text.length} chars`);
      return { ...whisperResult, source: 'groq-whisper' };
    }
  }

  return null;
}

/**
 * Extract subtitles via yt-dlp --skip-download (no audio needed).
 * This is the same approach TrueInfluence uses successfully.
 * Routes through residential proxy if WEBSHARE_PROXY_URL is set.
 */
function extractSubtitlesViaYtdlp(videoId) {
  const tmpDir = path.join(config.DATA_DIR, 'tmp_subs');
  fs.mkdirSync(tmpDir, { recursive: true });
  const outTemplate = path.join(tmpDir, videoId);

  // Clean any previous files for this video
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.startsWith(videoId)) fs.unlinkSync(path.join(tmpDir, f));
    }
  } catch {}

  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const proxyArgs = PROXY_URL ? ['--proxy', PROXY_URL] : [];

  try {
    // Try to get subtitles (auto + manual, English preferred)
    const cmd = [
      'yt-dlp',
      '--skip-download',
      '--write-auto-sub',
      '--write-sub',
      '--sub-lang', 'en',
      '--sub-format', 'json3',
      '--no-warnings',
      '--quiet',
      ...proxyArgs,
      '-o', outTemplate,
      ytUrl,
    ];
    execFileSync(cmd[0], cmd.slice(1), { timeout: 45000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    // Retry with vtt format
    try {
      const cmd2 = [
        'yt-dlp',
        '--skip-download',
        '--write-auto-sub',
        '--write-sub',
        '--sub-lang', 'en',
        '--sub-format', 'vtt',
        '--no-warnings',
        '--quiet',
        ...proxyArgs,
        '-o', outTemplate,
        ytUrl,
      ];
      execFileSync(cmd2[0], cmd2.slice(1), { timeout: 45000, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      console.log(`  yt-dlp subtitle extraction failed`);
      return null;
    }
  }

  // Find the subtitle file
  let subFile = null;
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.startsWith(videoId) && (f.endsWith('.json3') || f.endsWith('.vtt'))) {
        subFile = path.join(tmpDir, f);
        break;
      }
    }
  } catch {}

  if (!subFile) return null;

  try {
    const content = fs.readFileSync(subFile, 'utf-8');
    const segments = [];

    if (subFile.endsWith('.json3')) {
      const data = JSON.parse(content);
      for (const ev of (data.events || [])) {
        if (!ev.segs) continue;
        const text = ev.segs.map(s => s.utf8 || '').join('').trim();
        if (!text || text === '\n') continue;
        segments.push({
          id: segments.length,
          start: (ev.tStartMs || 0) / 1000,
          end: ((ev.tStartMs || 0) + (ev.dDurationMs || 0)) / 1000,
          text: text.replace(/\n/g, ' '),
        });
      }
    } else {
      // Parse VTT with deduplication (rolling captions repeat lines across cues)
      const seenLines = new Set();
      const blocks = content.split('\n\n');
      for (const block of blocks) {
        const lines = block.trim().split('\n');
        const tsLine = lines.find(l => l.includes('-->'));
        if (!tsLine) continue;
        const textLines = lines.filter(l => !l.includes('-->') && !/^\d+$/.test(l.trim()) && !l.startsWith('WEBVTT'));
        let text = textLines.join(' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
        if (!text) continue;
        // Dedup: skip lines we've already seen
        const dedupKey = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        if (seenLines.has(dedupKey)) continue;
        seenLines.add(dedupKey);
        const [startStr] = tsLine.split('-->');
        const parts = startStr.trim().split(':');
        let start = 0;
        if (parts.length === 3) start = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
        else if (parts.length === 2) start = parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
        segments.push({ id: segments.length, start, end: start + 5, text });
      }
    }

    // Clean up
    try { fs.unlinkSync(subFile); } catch {}

    if (segments.length === 0) return null;
    return { text: segments.map(s => s.text).join(' '), segments, language: 'en' };
  } catch (err) {
    console.log(`  Subtitle parse error: ${err.message}`);
    try { fs.unlinkSync(subFile); } catch {}
    return null;
  }
}

/**
 * Fetch captions by extracting ytInitialPlayerResponse from the watch page.
 * Uses residential proxy if available, plus CONSENT=YES+ cookie.
 */
async function fetchCaptionsFromWatchPage(videoId) {
  try {
    // If we have a proxy, use it via the https module
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    let html;

    if (PROXY_URL) {
      // Use yt-dlp to dump the page (it handles proxy + cookies better than raw fetch)
      try {
        const result = execFileSync('yt-dlp', [
          '--dump-json', '--skip-download', '--proxy', PROXY_URL, watchUrl
        ], { timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
        const videoData = JSON.parse(result.toString());
        // yt-dlp --dump-json includes subtitle info
        const subs = videoData.subtitles || videoData.automatic_captions || {};
        const enSubs = subs.en || subs['en-orig'] || Object.values(subs)[0];
        if (enSubs && enSubs.length > 0) {
          // Find json3 format
          const json3 = enSubs.find(s => s.ext === 'json3') || enSubs[0];
          if (json3 && json3.url) {
            const subResp = await fetch(json3.url);
            if (subResp.ok) {
              const subData = await subResp.json();
              const segments = [];
              for (const ev of (subData.events || [])) {
                if (!ev.segs) continue;
                const text = ev.segs.map(s => s.utf8 || '').join('').trim();
                if (!text || text === '\n') continue;
                segments.push({ id: segments.length, start: (ev.tStartMs || 0) / 1000, end: ((ev.tStartMs || 0) + (ev.dDurationMs || 0)) / 1000, text });
              }
              if (segments.length > 0) {
                return { text: segments.map(s => s.text).join(' '), segments, language: 'en' };
              }
            }
          }
        }
      } catch (e) {
        console.log(`  yt-dlp dump-json failed: ${e.message}`);
      }
    }

    // Fallback: direct fetch with CONSENT cookie
    const resp = await fetch(watchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': 'CONSENT=YES+',
      },
    });
    if (!resp.ok) { console.log(`  Watch page fetch error: ${resp.status}`); return null; }
    html = await resp.text();

    const match = html.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});/)
               || html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/);
    if (!match) { console.log(`  No ytInitialPlayerResponse found`); return null; }

    let playerData;
    try { playerData = JSON.parse(match[1]); }
    catch (e) { console.log(`  Failed to parse player response`); return null; }

    const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks || captionTracks.length === 0) { console.log(`  No caption tracks in player response`); return null; }

    let track = captionTracks.find(t => t.languageCode === 'en' && t.kind !== 'asr')
             || captionTracks.find(t => t.languageCode === 'en')
             || captionTracks[0];
    if (!track?.baseUrl) return null;

    const lang = track.languageCode || 'en';

    // Try JSON3 format
    try {
      const j3Resp = await fetch(track.baseUrl + '&fmt=json3');
      if (j3Resp.ok) {
        const json3 = await j3Resp.json();
        const segments = [];
        for (const event of (json3.events || [])) {
          if (!event.segs) continue;
          const text = event.segs.map(s => s.utf8 || '').join('').trim();
          if (!text || text === '\n') continue;
          segments.push({ id: segments.length, start: (event.tStartMs || 0) / 1000, end: ((event.tStartMs || 0) + (event.dDurationMs || 0)) / 1000, text });
        }
        if (segments.length > 0) return { text: segments.map(s => s.text).join(' '), segments, language: lang };
      }
    } catch {}

    // XML fallback
    const xmlResp = await fetch(track.baseUrl);
    if (!xmlResp.ok) return null;
    const xml = await xmlResp.text();
    const segments = [];
    const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>(.*?)<\/text>/gs;
    let m;
    while ((m = regex.exec(xml)) !== null) {
      const text = m[3].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').trim();
      if (text) segments.push({ id: segments.length, start: parseFloat(m[1]), end: parseFloat(m[1]) + parseFloat(m[2]), text });
    }
    if (segments.length === 0) return null;
    return { text: segments.map(s => s.text).join(' '), segments, language: lang };
  } catch (err) {
    console.log(`  Watch page error: ${err.message}`);
    return null;
  }
}

// ── Groq Whisper Fallback ────────────────────────────────────────────────────

async function downloadAndTranscribe(videoId) {
  const audioDir = path.join(config.DATA_DIR, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const audioPath = path.join(audioDir, `${videoId}.m4a`);
  const proxyArgs = PROXY_URL ? ['--proxy', PROXY_URL] : [];

  try {
    if (!fs.existsSync(audioPath)) {
      const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
      try {
        execFileSync('yt-dlp', ['-f', 'ba[ext=m4a]/ba', '--no-playlist', ...proxyArgs, '-o', audioPath, ytUrl], { timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        try {
          execFileSync('yt-dlp', ['-x', '--audio-format', 'm4a', '--no-playlist', ...proxyArgs, '-o', audioPath, ytUrl], { timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch { console.log(`  Audio download failed`); return null; }
      }
    }
    if (!fs.existsSync(audioPath)) return null;

    const fileSize = fs.statSync(audioPath).size;
    if (fileSize < 100) { try { fs.unlinkSync(audioPath); } catch {} return null; }
    if (fileSize > 25 * 1024 * 1024) { console.log(`  Too large for Groq`); try { fs.unlinkSync(audioPath); } catch {} return null; }
    console.log(`  Audio: ${Math.round(fileSize / 1024)}KB - sending to Groq...`);

    const result = await groqWhisperTranscribe(audioPath, videoId);
    try { fs.unlinkSync(audioPath); } catch {}
    return result;
  } catch (err) {
    console.log(`  Transcription failed: ${err.message}`);
    try { fs.unlinkSync(audioPath); } catch {}
    return null;
  }
}

function groqWhisperTranscribe(audioPath, videoId) {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath), { filename: `${videoId}.m4a`, contentType: 'audio/mp4' });
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'verbose_json');
    form.append('language', 'en');

    const req = https.request({
      hostname: 'api.groq.com', path: '/openai/v1/audio/transcriptions', method: 'POST',
      headers: { 'Authorization': `Bearer ${config.GROQ_API_KEY}`, ...form.getHeaders() },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) { console.log(`  Groq error ${res.statusCode}: ${body.slice(0, 150)}`); resolve(null); return; }
        try {
          const data = JSON.parse(body);
          const segments = (data.segments || []).map((seg, i) => ({ id: i, start: seg.start || 0, end: seg.end || 0, text: (seg.text || '').trim() }));
          resolve({ text: (data.text || '').trim(), segments, language: data.language || 'en' });
        } catch (e) { console.log(`  Groq parse error: ${e.message}`); resolve(null); }
      });
    });
    req.on('error', (err) => { console.log(`  Groq request error: ${err.message}`); resolve(null); });
    form.pipe(req);
  });
}

module.exports = { extractVideoId, getVideoMetadata, getChannelVideoIds, getTranscript, getVideoComments };
