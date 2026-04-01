/**
 * TDE — PPTX Ingestor
 * Extracts text from PowerPoint files by unzipping and parsing slide XML.
 * No external dependency needed — PPTX is just a ZIP of XML files.
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { execSync } = require('child_process');

async function extractPPTX(filePath) {
  // Unzip to a temp directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tde_pptx_'));
  try {
    // Use Node's built-in or system unzip
    try {
      execSync(`cd "${tmpDir}" && unzip -q "${filePath}"`, { stdio: 'pipe' });
    } catch {
      // fallback: try PowerShell on Windows
      execSync(`powershell -command "Expand-Archive -Path '${filePath}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'pipe' });
    }

    const slidesDir = path.join(tmpDir, 'ppt', 'slides');
    if (!fs.existsSync(slidesDir)) {
      throw new Error('Could not find slides directory in PPTX — file may be corrupted');
    }

    const slideFiles = fs.readdirSync(slidesDir)
      .filter(f => f.match(/^slide\d+\.xml$/))
      .sort((a, b) => {
        const na = parseInt(a.match(/\d+/)[0]);
        const nb = parseInt(b.match(/\d+/)[0]);
        return na - nb;
      });

    const segments = [];
    let fullText = '';

    for (let i = 0; i < slideFiles.length; i++) {
      const xmlPath = path.join(slidesDir, slideFiles[i]);
      const xml     = fs.readFileSync(xmlPath, 'utf-8');
      // Extract all text runs from the XML
      const textNodes = [...xml.matchAll(/<a:t[^>]*>(.*?)<\/a:t>/gs)];
      const slideText = textNodes.map(m => m[1].trim()).filter(Boolean).join(' ');
      if (slideText.length > 5) {
        segments.push({ pageNumber: i + 1, slideNumber: i + 1, text: slideText });
        fullText += slideText + '\n';
      }
    }

    const title = path.basename(filePath, path.extname(filePath));
    return {
      text: fullText.trim(),
      segments,
      pageCount: slideFiles.length,
      title,
      author: '',
      metadata: { slideCount: slideFiles.length },
    };
  } finally {
    // Cleanup temp dir
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { extractPPTX };
