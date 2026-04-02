/**
 * TDE — YouTube Ingestor
 * ================================
 * Strategy:
 *   1. YouTube Innertube API (player endpoint — no auth needed)
 *   2. YouTube Data API v3 for metadata, channels, comments
 *   3. Groq Whisper fallback for videos with no captions
 *
 * Captures: views, likes, comments count + top comments text.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const FormData = require('form-data');
const config = require('../config');

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
  // Strategy 1: Innertube API (YouTube's internal player API — no auth needed)
  console.log(`  Trying Innertube API for captions...`);
  const innertube = await fetchInnertubeTranscript(videoId);
  if (innertube && innertube.text.length > 50) {
    console.log(`  Innertube captions OK: ${innertube.text.length} chars`);
    return { ...innertube, source: 'innertube' };
  }

  // Strategy 2: Groq Whisper fallback (audio download + transcription)
  if (config.GROQ_API_KEY) {
    console.log(`  No captions via Innertube — downloading audio for Groq Whisper...`);
    const whisperResult = await downloadAndTranscribe(videoId);
    if (whisperResult && whisperResult.text.length > 20) {
      console.log(`  Groq Whisper OK: ${whisperResult.text.length} chars`);
      return { ...whisperResult, source: 'groq-whisper' };
    }
  }

  return null;
}

/**
 * Fetch transcript via YouTube's Innertube API.
 * This is the same API the YouTube web player calls internally.
 * No OAuth or API key required — it's a public endpoint.
 */
async function fetchInnertubeTranscript(videoId) {
  try {
    // Step 1: Get the player response to find caption track URLs
    const playerResp = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId,
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: '2.20240101.00.00',
            hl: 'en',
            gl: 'US',
          },
        },
      }),
    });

    if (!playerResp.ok) {
      console.log(`  Innertube player error: ${playerResp.status}`);
      return null;
    }

    const playerData = await playerResp.json();
    const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!captionTracks || captionTracks.length === 0) {
      console.log(`  No caption tracks found via Innertube`);
      return null;
    }

    // Pick best track: prefer manual English, then any English, then first available
    let track = captionTracks.find(t => t.languageCode === 'en' && t.kind !== 'asr')
             || captionTracks.find(t => t.languageCode === 'en')
             || captionTracks[0];

    if (!track?.baseUrl) {
      console.log(`  No baseUrl on caption track`);
      return null;
    }

    const lang = track.languageCode || 'en';
    console.log(`  Found caption track: ${track.name?.simpleText || lang} (${track.kind === 'asr' ? 'auto' : 'manual'})`);

    // Step 2: Try JSON3 format first (structured with timestamps)
    try {
      const j3Resp = await fetch(track.baseUrl + '&fmt=json3');
      if (j3Resp.ok) {
        const json3 = await j3Resp.json();
        const segments = [];
        for (const event of (json3.events || [])) {
          if (!event.segs) continue;
          const text = event.segs.map(s => s.utf8 || '').join('').trim();
          if (!text || text === '\n') continue;
          segments.push({
            id: segments.length,
            start: (event.tStartMs || 0) / 1000,
            end: ((event.tStartMs || 0) + (event.dDurationMs || 0)) / 1000,
            text,
          });
        }
        if (segments.length > 0) {
          return { text: segments.map(s => s.text).join(' '), segments, language: lang };
        }
      }
    } catch (e) { console.log(`  JSON3 parse failed: ${e.message}`); }

    // Step 3: Fall back to XML format
    const xmlResp = await fetch(track.baseUrl);
    if (!xmlResp.ok) return null;
    const xml = await xmlResp.text();
    const segments = [];
    const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>(.*?)<\/text>/gs;
    let m;
    while ((m = regex.exec(xml)) !== null) {
      const text = m[3]
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').trim();
      if (text) {
        segments.push({
          id: segments.length,
          start: parseFloat(m[1]),
          end: parseFloat(m[1]) + parseFloat(m[2]),
          text,
        });
      }
    }
    if (segments.length === 0) return null;
    return { text: segments.map(s => s.text).join(' '), segments, language: lang };

  } catch (err) {
    console.log(`  Innertube error: ${err.message}`);
    return null;
  }
}

// ── Groq Whisper Fallback ────────────────────────────────────────────────────

async function downloadAndTranscribe(videoId) {
  const audioDir = path.join(config.DATA_DIR, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const audioPath = path.join(audioDir, `${videoId}.m4a`);

  try {
    if (!fs.existsSync(audioPath)) {
      const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
      try {
        execSync(`yt-dlp -f "ba[ext=m4a]/ba" --no-playlist -o "${audioPath}" "${ytUrl}"`, { timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        try {
          execSync(`yt-dlp -x --audio-format m4a --no-playlist -o "${audioPath}" "${ytUrl}"`, { timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch { console.log(`  Audio download failed (yt-dlp not available or blocked)`); return null; }
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
