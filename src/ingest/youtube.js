/**
 * TrueEngine - YouTube Ingestor
 * ================================
 * Strategy: captions first, Groq Whisper fallback.
 * Uses yt-dlp + Deno (for YouTube JS challenges) for audio download,
 * form-data + https for Groq upload.
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

async function getTranscript(videoId) {
  console.log(`  Trying captions...`);
  const captions = await fetchYouTubeCaptions(videoId);
  if (captions && captions.text.length > 50) {
    console.log(`  Captions OK: ${captions.text.length} chars`);
    return { ...captions, source: 'captions' };
  }
  if (config.GROQ_API_KEY) {
    console.log(`  No captions - downloading audio for Groq Whisper...`);
    const whisperResult = await downloadAndTranscribe(videoId);
    if (whisperResult && whisperResult.text.length > 20) {
      console.log(`  Groq Whisper OK: ${whisperResult.text.length} chars`);
      return { ...whisperResult, source: 'groq-whisper' };
    }
  }
  return null;
}

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

async function fetchYouTubeCaptions(videoId) {
  try {
    const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const html = await resp.text();
    const captionMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!captionMatch) return null;
    let tracks; try { tracks = JSON.parse(captionMatch[1]); } catch { return null; }
    let track = tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr') || tracks.find(t => t.languageCode === 'en') || tracks[0];
    if (!track?.baseUrl) return null;

    try {
      const jResp = await fetch(track.baseUrl + '&fmt=json3');
      if (jResp.ok) {
        const json3 = await jResp.json();
        const segments = [];
        for (const event of (json3.events || [])) {
          if (!event.segs) continue;
          const text = event.segs.map(s => s.utf8 || '').join('').trim();
          if (!text) continue;
          segments.push({ id: segments.length, start: (event.tStartMs || 0) / 1000, end: ((event.tStartMs || 0) + (event.dDurationMs || 0)) / 1000, text });
        }
        if (segments.length > 0) return { text: segments.map(s => s.text).join(' '), segments, language: 'en' };
      }
    } catch {}

    const xmlResp = await fetch(track.baseUrl); if (!xmlResp.ok) return null;
    const xml = await xmlResp.text();
    const segments = [];
    const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>(.*?)<\/text>/gs;
    let m;
    while ((m = regex.exec(xml)) !== null) {
      const text = m[3].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').trim();
      if (text) segments.push({ id: segments.length, start: parseFloat(m[1]), end: parseFloat(m[1]) + parseFloat(m[2]), text });
    }
    if (segments.length === 0) return null;
    return { text: segments.map(s => s.text).join(' '), segments, language: 'en' };
  } catch { return null; }
}

module.exports = { extractVideoId, getVideoMetadata, getChannelVideoIds, getTranscript, getVideoComments };
