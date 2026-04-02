/**
 * TDE — Admin Dashboard
 * ═══════════════════════════════════════════════════════════════════
 * Serves the admin dashboard HTML from src/public/admin.html.
 * Falls back to a "file not found" message if the HTML is missing.
 */

const fs = require('fs');
const path = require('path');

let _cachedHTML = null;

function getAdminHTML() {
  if (_cachedHTML) return _cachedHTML;

  const htmlPath = path.join(__dirname, '..', 'public', 'admin.html');
  if (fs.existsSync(htmlPath)) {
    _cachedHTML = fs.readFileSync(htmlPath, 'utf-8');
    return _cachedHTML;
  }

  return `<!DOCTYPE html>
<html><head><title>TDE Admin</title></head>
<body style="background:#0a0b0f;color:#e8eaf0;font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh">
<div style="text-align:center">
<h1>TDE — Targeted Decomposition Engine</h1>
<p style="color:#8b8fa4">Admin dashboard HTML not found at src/public/admin.html</p>
<p style="color:#8b8fa4">Copy from TrueEngine or build a new one.</p>
</div></body></html>`;
}

module.exports = { getAdminHTML };
