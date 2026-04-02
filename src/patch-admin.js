// Run this with: node src/patch-admin.js
// Patches admin.html to use cookie-based auth

const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, 'public', 'admin.html');
let html = fs.readFileSync(adminPath, 'utf-8');

// 1. Add credentials to api() fetch
const oldApi = `const r = await fetch(\`\${API}\${path}\`, { ...opts, headers: { ...h, ...(opts.headers || {}) } });`;
const newApi = `const r = await fetch(\`\${API}\${path}\`, { ...opts, headers: { ...h, ...(opts.headers || {}) }, credentials: 'same-origin' });`;
html = html.replace(oldApi, newApi);

// 2. Add credentials to apiForm() fetch
const oldForm = `const r = await fetch(\`\${API}\${path}\`, { method: 'POST', headers: h, body: formData });`;
const newForm = `const r = await fetch(\`\${API}\${path}\`, { method: 'POST', headers: h, body: formData, credentials: 'same-origin' });`;
html = html.replace(oldForm, newForm);

// 3. Replace saveKey to use POST /admin/auth for cookie
const oldSave = `function saveKey() { KEY = val('key-inp'); localStorage.setItem('tde_key', KEY); toast('API key saved', 'success'); loadAll(); }`;
const newSave = `async function saveKey() { KEY = val('key-inp'); localStorage.setItem('tde_key', KEY); try { const r = await fetch(API+'/admin/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:KEY}),credentials:'same-origin'}); if(r.ok){toast('Authenticated! Cookie set.','success');loadAll();}else{toast('Invalid key','error');}} catch(e){toast('Auth failed: '+e.message,'error');}}`;
html = html.replace(oldSave, newSave);

// Verify
const checks = [
  ['api() credentials', html.includes("credentials: 'same-origin'")],
  ['saveKey /admin/auth', html.includes('/admin/auth')],
];
checks.forEach(([name, ok]) => console.log(`  ${ok ? 'OK' : 'MISS'}: ${name}`));

fs.writeFileSync(adminPath, html, 'utf-8');
console.log('\nPatched: ' + adminPath);
