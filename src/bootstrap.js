#!/usr/bin/env node
/**
 * TDE — Startup Bootstrap
 * Downloads yt-dlp binary if not available, then starts the server.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const YT_DLP_PATH = '/usr/local/bin/yt-dlp';
const YT_DLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

async function ensureYtDlp() {
  // Check if yt-dlp is already available
  try {
    execSync('yt-dlp --version', { stdio: ['pipe', 'pipe', 'pipe'] });
    console.log('  yt-dlp: already installed');
    return;
  } catch {}

  // Download yt-dlp binary
  console.log('  yt-dlp: not found — downloading...');
  try {
    execSync(`curl -L "${YT_DLP_URL}" -o "${YT_DLP_PATH}" && chmod +x "${YT_DLP_PATH}"`, {
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Verify
    const version = execSync('yt-dlp --version', { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    console.log(`  yt-dlp: installed (${version})`);
  } catch (err) {
    // Try alternate location if /usr/local/bin isn't writable
    const altPath = path.join(process.cwd(), 'yt-dlp');
    try {
      execSync(`curl -L "${YT_DLP_URL}" -o "${altPath}" && chmod +x "${altPath}"`, {
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Add to PATH
      process.env.PATH = process.cwd() + ':' + process.env.PATH;
      const version = execSync(`${altPath} --version`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
      console.log(`  yt-dlp: installed to ${altPath} (${version})`);
    } catch (err2) {
      console.log(`  yt-dlp: download failed — ${err2.message}`);
      console.log('  yt-dlp: YouTube audio fallback will not be available');
    }
  }
}

async function main() {
  console.log('\n  TDE Bootstrap...');
  await ensureYtDlp();
  console.log('  Starting server...\n');
  require('./server');
}

main();
