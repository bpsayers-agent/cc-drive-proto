import { CLIENT_ID, API_KEY, APP_ID, REDIRECT_URI } from '../config.js';
import * as drive from './drive.js?v=3';

const D = 'https://www.googleapis.com/auth/';
const SCOPE_SETS = {
  file: { label: 'drive.file alone', scopes: [D + 'drive.file'] },
  picker: { label: 'drive.file + Picker', scopes: [D + 'drive.file'], picker: true },
  readonly: { label: 'drive.readonly + drive.file', scopes: [D + 'drive.readonly', D + 'drive.file'] },
  full: { label: 'drive (full)', scopes: [D + 'drive'] },
};
const LOG_RE = /^log-(.+)\.jsonl$/;

// ---------- storage (cache only; everything works without it) ----------
const store = {
  get(k, d = null) { try { const v = localStorage.getItem('p2.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('p2.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------- full-page redirect sign-in: the site root hands the token fragment over ----------
// state = "drive:<nonce>:<scopeSet>:<deviceId>"; the root page stores the fragment
// under "oauth.handoff" and sends the browser to drive/. Read it once, delete it.
function takeHandoff() {
  let raw = null;
  try { raw = sessionStorage.getItem('oauth.handoff'); } catch { /* ignore */ }
  if (!raw) { try { raw = localStorage.getItem('oauth.handoff'); } catch { /* ignore */ } }
  let h = null;
  try { h = JSON.parse(raw); } catch { /* ignore */ }
  if (!h || h.route !== 'drive') return null;
  try { sessionStorage.removeItem('oauth.handoff'); } catch { /* ignore */ }
  try { localStorage.removeItem('oauth.handoff'); } catch { /* ignore */ }
  if (Date.now() - h.at > 5 * 60 * 1000) return null;
  const p = new URLSearchParams(h.fragment);
  const [, nonce, scopeSet, dev] = (p.get('state') || '').split(':');
  let expected = null;
  try { expected = sessionStorage.getItem('p2.nonce') || localStorage.getItem('p2.nonce'); } catch { /* ignore */ }
  try { sessionStorage.removeItem('p2.nonce'); localStorage.removeItem('p2.nonce'); } catch { /* ignore */ }
  if (!expected || nonce !== expected) return { error: 'state mismatch: ignoring sign-in result' };
  if (dev && !new URLSearchParams(location.search).get('device')) {
    const u = new URL(location.href); u.searchParams.set('device', dev); history.replaceState(null, '', u.href);
  }
  if (p.has('error')) return { error: p.get('error'), scopeSet };
  return { access_token: p.get('access_token'), expires_in: p.get('expires_in'), scope: p.get('scope'), scopeSet };
}
const handoff = takeHandoff();

const params = new URLSearchParams(location.search);
let deviceId = params.get('device');
if (!deviceId) {
  deviceId = store.get('deviceId');
  if (!deviceId) { deviceId = crypto.randomUUID().slice(0, 8); store.set('deviceId', deviceId); }
}
deviceId = deviceId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'dev';

const state = {
  scopeSet: store.get('scopeSet', 'file'),
  token: null, expiresAt: 0, granted: [], account: null,
  folderId: store.get('folderId', ''),
  results: store.get('results', []),
};

// ---------- DOM ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function log(msg) {
  const el = $('#log');
  el.textContent = `${new Date().toLocaleTimeString()}  ${msg}\n` + el.textContent;
}

function stepLine(s) {
  return `${s.label}: ${s.ok ? 'OK' : 'FAIL'} ${s.status}${s.error ? ' ' + s.error : ''}${s.note ? ' (' + s.note + ')' : ''}`;
}

function addResult(r) {
  const full = {
    at: new Date().toISOString(), origin: location.origin, device: deviceId,
    scopeSet: state.scopeSet, account: state.account?.emailAddress || '?',
    granted: state.granted.map((s) => s.replace(D, '')).join(' '), ...r,
  };
  state.results.push(full);
  store.set('results', state.results);
  renderResults();
  log(`${r.criterion}: ${r.pass ? 'PASS' : 'FAIL'} ${r.message}`);
}

function renderResults() {
  $('#results tbody').innerHTML = state.results.map((r, i) => `
    <tr class="${r.pass ? 'pass' : 'fail'}">
      <td>${i + 1}</td><td>${esc(r.scopeSet)}</td><td>${esc(r.criterion)}</td>
      <td><b>${r.pass ? 'PASS' : 'FAIL'}</b></td><td>${esc(r.status ?? '')}</td>
      <td>${esc(r.message)}${r.steps?.length ? `<details><summary>${r.steps.length} steps</summary><pre>${esc(r.steps.map(stepLine).join('\n'))}</pre></details>` : ''}</td>
    </tr>`).join('');
  $('#md').value = toMarkdown();
}

function toMarkdown() {
  const lines = [`### Prototype 2 results`, ``,
    `- page: ${location.origin}${location.pathname}`, `- device: ${deviceId}`,
    `- browser: ${navigator.userAgent}`, `- copied: ${new Date().toISOString()}`, ``,
    `| # | time (UTC) | account | scope set | granted | criterion | result | HTTP | message |`,
    `|---|---|---|---|---|---|---|---|---|`];
  state.results.forEach((r, i) => {
    const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${i + 1} | ${r.at.slice(11, 19)} | ${cell(r.account)} | ${cell(r.scopeSet)} | ${cell(r.granted)} | ${cell(r.criterion)} | ${r.pass ? 'PASS' : 'FAIL'} | ${cell(r.status)} | ${cell(r.message)} |`);
  });
  lines.push('', '<details><summary>Steps</summary>', '', '```');
  state.results.forEach((r, i) => {
    if (r.steps?.length) { lines.push(`#${i + 1} ${r.scopeSet} ${r.criterion}`); r.steps.forEach((s) => lines.push('  ' + stepLine(s))); }
  });
  lines.push('```', '', '</details>');
  return lines.join('\n');
}

function renderAuth() {
  const set = SCOPE_SETS[state.scopeSet];
  $('#who').textContent = state.account ? `${state.account.displayName} <${state.account.emailAddress}>` : 'not signed in';
  $('#granted').textContent = state.token ? state.granted.join('\n') : '-';
  $('#expires').textContent = state.token ? new Date(state.expiresAt).toLocaleTimeString() : '-';
  $('#requested').textContent = set.scopes.join('\n');
  document.querySelectorAll('[data-needs-token]').forEach((b) => { b.disabled = !state.token; });
  $('#pickFolder').disabled = !state.token;
  $('#pickPdf').disabled = !state.token;
}

// ---------- auth ----------
function waitFor(test, what, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (test()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error(`${what} did not load`));
      setTimeout(poll, 100);
    })();
  });
}

function signInRedirect() {
  const set = SCOPE_SETS[state.scopeSet];
  const nonce = crypto.randomUUID().replace(/-/g, '');
  try { sessionStorage.setItem('p2.nonce', nonce); localStorage.setItem('p2.nonce', nonce); } catch { /* ignore */ }
  const q = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'token',
    scope: set.scopes.join(' '), include_granted_scopes: 'false',
    prompt: $('#chooseAccount').checked ? 'select_account consent' : 'consent',
    state: `drive:${nonce}:${state.scopeSet}:${deviceId}`,
  });
  log('redirecting to Google sign-in');
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
}

async function signIn() {
  if ($('#useRedirect').checked) return signInRedirect();
  await waitFor(() => window.google?.accounts?.oauth2, 'Google Identity Services');
  const set = SCOPE_SETS[state.scopeSet];
  const prompt = $('#chooseAccount').checked ? 'select_account consent' : 'consent';
  log(`requesting ${set.scopes.join(' ')} (include_granted_scopes=false, prompt=${prompt})`);
  const client = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: set.scopes.join(' '),
    include_granted_scopes: false,
    prompt,
    callback: onToken,
    error_callback: (err) => {
      addResult({ criterion: 'sign-in', pass: false, status: err.type, message: `GIS error: ${err.type} ${err.message || ''}` });
    },
  });
  client.requestAccessToken();
}

async function onToken(resp) {
  if (resp.error) {
    addResult({ criterion: 'sign-in', pass: false, status: resp.error, message: `${resp.error}: ${resp.error_description || ''}` });
    return;
  }
  state.token = resp.access_token;
  state.expiresAt = Date.now() + Number(resp.expires_in) * 1000;
  state.granted = (resp.scope || '').split(' ').filter(Boolean).sort();
  drive.setToken(state.token);
  const who = await drive.about();
  state.account = who.ok ? who.data.user : null;
  const info = await drive.tokenInfo(state.token);
  const infoScopes = info.ok ? (info.data.scope || '').split(' ').sort() : [];
  renderAuth();
  const want = SCOPE_SETS[state.scopeSet].scopes;
  const missing = want.filter((s) => !state.granted.includes(s));
  const extra = state.granted.filter((s) => !want.includes(s));
  addResult({
    criterion: 'sign-in', pass: missing.length === 0, status: who.status,
    message: `granted: ${state.granted.map((s) => s.replace(D, '')).join(', ') || '(none)'}` +
      (missing.length ? `; MISSING ${missing.join(', ')}` : '') + (extra.length ? `; EXTRA ${extra.join(', ')}` : '') +
      `; tokeninfo scopes: ${infoScopes.map((s) => s.replace(D, '')).join(', ')}` +
      (who.ok ? '' : `; about.get failed ${who.status} ${who.error}`),
    steps: [who, { label: 'tokeninfo', ok: info.ok, status: info.status, error: info.error }],
  });
}

async function revoke() {
  if (!state.token) { log('no token to revoke'); return; }
  await waitFor(() => window.google?.accounts?.oauth2, 'Google Identity Services');
  const t = state.token;
  google.accounts.oauth2.revoke(t, (r) => {
    addResult({ criterion: 'revoke', pass: !!r.successful, status: r.error || 'ok', message: r.successful ? 'token and grant revoked' : `revoke failed: ${r.error} ${r.error_description || ''}` });
  });
  state.token = null; state.granted = []; state.account = null;
  drive.setToken(null);
  renderAuth();
}

// ---------- folder ----------
function parseFolderId(s) {
  s = (s || '').trim();
  const m = s.match(/folders\/([A-Za-z0-9_-]+)/) || s.match(/[?&]id=([A-Za-z0-9_-]+)/);
  return m ? m[1] : s.replace(/[^A-Za-z0-9_-]/g, '');
}

function setFolder(id) {
  state.folderId = id;
  store.set('folderId', id);
  $('#folderId').value = id;
  log(`folder set to ${id || '(none)'}`);
}

// ---------- Picker ----------
let pickerReady = null;
function loadPicker() {
  if (!pickerReady) {
    pickerReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://apis.google.com/js/api.js';
      s.onload = () => window.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('picker load failed')) });
      s.onerror = () => reject(new Error('api.js load failed'));
      document.head.appendChild(s);
    });
  }
  return pickerReady;
}

async function openPicker(kind) {
  await loadPicker();
  const P = google.picker;
  const b = new P.PickerBuilder()
    .setOAuthToken(state.token).setDeveloperKey(API_KEY).setAppId(APP_ID)
    .enableFeature(P.Feature.SUPPORT_DRIVES);
  if (kind === 'folder') {
    const mine = new P.DocsView(P.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true)
      .setMimeTypes('application/vnd.google-apps.folder');
    const shared = new P.DocsView(P.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true)
      .setMimeTypes('application/vnd.google-apps.folder').setOwnedByMe(false);
    b.addView(mine).addView(shared).setTitle('Pick the shared folder');
  } else {
    const pdfs = new P.DocsView(P.ViewId.DOCS).setMimeTypes('application/pdf').setIncludeFolders(true);
    b.addView(pdfs).enableFeature(P.Feature.MULTISELECT_ENABLED).setTitle('Pick statement PDF(s)');
  }
  b.setCallback((data) => {
    const action = data[P.Response.ACTION];
    if (action === P.Action.CANCEL) { addResult({ criterion: `picker ${kind}`, pass: false, status: 'cancel', message: 'picker cancelled' }); return; }
    if (action !== P.Action.PICKED) return;
    const docs = data[P.Response.DOCUMENTS];
    if (kind === 'folder') setFolder(docs[0][P.Document.ID]);
    else {
      const picked = store.get('pickedPdfs', []);
      docs.forEach((d) => picked.push(d[P.Document.ID]));
      store.set('pickedPdfs', [...new Set(picked)]);
    }
    addResult({ criterion: `picker ${kind}`, pass: true, status: 'picked', message: `picked ${docs.length}: ${docs.map((d) => `${d[P.Document.NAME]} (${d[P.Document.MIME_TYPE]})`).join(', ')}` });
  });
  b.build().setVisible(true);
}

// ---------- known ids (remembered at runtime so narrower scopes can probe them directly) ----------
function remember(kind, files) {
  const k = store.get('known', {});
  const key = state.folderId;
  k[key] = k[key] || {};
  files.forEach((f) => { k[key][f.id] = { kind, name: f.name }; });
  store.set('known', k);
}
const known = () => (store.get('known', {})[state.folderId] || {});

// ---------- criteria ----------
function needFolder() {
  if (!state.folderId) { addResult({ criterion: 'setup', pass: false, status: '-', message: 'no folder id set' }); return false; }
  return true;
}

async function c1() {
  if (!needFolder()) return;
  const steps = [];
  const F = state.folderId;
  const name = `log-${deviceId}.jsonl`;
  const meta = await drive.getMeta(F, 'folder files.get'); steps.push(meta);
  const found = await drive.list(`'${F}' in parents and name = '${name}' and trashed = false`, 'find own log'); steps.push(found);
  const ev = { v: 1, id: crypto.randomUUID(), device: deviceId, at: new Date().toISOString(), type: 'proto.ping', scopeSet: state.scopeSet };
  const line = JSON.stringify(ev) + '\n';
  let fileId, write;
  if (found.ok && found.data.length) {
    fileId = found.data[0].id;
    const cur = await drive.downloadText(fileId, 'download own log'); steps.push(cur);
    if (!cur.ok) return finish();
    const text = cur.data + (cur.data && !cur.data.endsWith('\n') ? '\n' : '') + line;
    write = await drive.updateText(fileId, text, 'append (files.update media)'); steps.push(write);
  } else {
    write = await drive.createText(name, F, line, { p2: 'log', device: deviceId }, 'create log (files.create)'); steps.push(write);
    if (write.ok) fileId = write.data.id;
  }
  if (!write.ok) return finish();
  const back = await drive.downloadText(fileId, 'read back'); steps.push(back);
  const lines = back.ok ? back.data.trim().split('\n') : [];
  const ok = back.ok && lines.length && JSON.parse(lines[lines.length - 1]).id === ev.id;
  return finish(ok, `${name} now has ${lines.length} line(s); file id ${fileId}`);

  function finish(pass = false, msg) {
    const bad = steps.find((s) => !s.ok);
    const notes = steps.filter((s) => !s.ok).map((s) => `${s.label} ${s.status}`).join(', ');
    addResult({
      criterion: 'C1 write own log', pass: !!pass, status: pass ? write.status : bad?.status,
      message: (msg || `${bad?.label} failed: ${bad?.error}`) + (pass && notes ? ` (non-fatal: ${notes})` : ''), steps,
    });
  }
}

async function c2() {
  if (!needFolder()) return;
  const steps = [];
  const F = state.folderId;
  const ls = await drive.list(`'${F}' in parents and name contains 'log-' and trashed = false`, 'list logs'); steps.push(ls);
  if (!ls.ok) return addResult({ criterion: 'C2 read other logs', pass: false, status: ls.status, message: `list failed: ${ls.error}`, steps });
  const logs = ls.data.filter((f) => LOG_RE.test(f.name));
  remember('log', logs);
  const rows = [];
  const events = [];
  for (const f of logs) {
    const dev = f.name.match(LOG_RE)[1];
    const owner = f.owners?.[0];
    const r = await drive.downloadText(f.id, `read ${f.name}`); steps.push(r);
    let n = 0;
    if (r.ok) r.data.split('\n').filter(Boolean).forEach((l) => { try { events.push(JSON.parse(l)); n++; } catch { /* skip */ } });
    rows.push({ dev, own: dev === deviceId, owner: owner ? `${owner.emailAddress}${owner.me ? ' (me)' : ''}` : '?', ownerIsMe: owner?.me, ok: r.ok, n });
  }
  // Probe logs we have seen before (under a broader scope) but which this listing did not return.
  const listed = new Set(logs.map((f) => f.id));
  const probes = Object.entries(known()).filter(([id, v]) => v.kind === 'log' && !listed.has(id));
  for (const [id, v] of probes) {
    const r = await drive.downloadText(id, `direct GET unlisted ${v.name}`); steps.push(r);
    rows.push({ dev: v.name, own: false, owner: '(unlisted, probed by id)', ok: r.ok, n: r.ok ? r.data.split('\n').filter(Boolean).length : 0, probed: true });
  }
  events.sort((a, b) => (a.at < b.at ? -1 : 1));
  const others = rows.filter((r) => !r.own && r.ok && !r.probed);
  const crossAccount = rows.some((r) => r.ok && r.ownerIsMe === false);
  const summary = rows.map((r) => `${r.dev}${r.own ? '*' : ''} owner=${r.owner} ${r.ok ? `read ${r.n} lines` : 'READ FAILED'}`).join('; ');
  addResult({
    criterion: 'C2 read other logs', pass: others.length > 0, status: ls.status,
    message: `listed ${logs.length} log(s), read ${rows.filter((r) => r.ok).length}; other-device logs read: ${others.length}; ` +
      `cross-account log read: ${crossAccount ? 'YES' : 'no'}; merged ${events.length} events. ${summary}`,
    steps,
  });
  renderMerged(events);
}

function renderMerged(events) {
  $('#merged').textContent = events.slice(-30).map((e) => `${e.at}  ${e.device}  ${e.type}  ${e.scopeSet || ''}`).join('\n') || '(none)';
}

async function c3() {
  if (!needFolder()) return;
  const steps = [];
  const F = state.folderId;
  const sub = await drive.list(`'${F}' in parents and mimeType = '${drive.FOLDER_MIME}' and name = 'statements' and trashed = false`, 'find statements subfolder'); steps.push(sub);
  const parents = [F];
  if (sub.ok && sub.data[0]) parents.push(sub.data[0].id);
  const q = `(${parents.map((p) => `'${p}' in parents`).join(' or ')}) and trashed = false`;
  const all = await drive.list(q, 'list folder + statements'); steps.push(all);
  if (!all.ok) return addResult({ criterion: 'C3 list+download PDF', pass: false, status: all.status, message: `list failed: ${all.error}`, steps });
  const items = all.data.filter((f) => f.mimeType !== drive.FOLDER_MIME && !LOG_RE.test(f.name));
  const pdfs = items.filter((f) => f.mimeType === 'application/pdf');
  const gdocs = items.filter((f) => f.mimeType.startsWith('application/vnd.google-apps.'));
  remember('pdf', pdfs);
  remember('gdoc', gdocs);
  const listedIds = new Set(items.map((f) => f.id));
  const tried = [];
  for (const f of pdfs.slice(0, 3)) {
    const r = await drive.downloadBytes(f.id, `download ${f.name}`); steps.push(r);
    tried.push({ name: f.name, how: 'listed', ok: r.ok && isPdf(r.data), status: r.status, bytes: r.data?.length });
  }
  // Probe PDFs seen earlier (broader scope) or picked with Picker but not returned by this listing.
  const probeIds = [
    ...Object.entries(known()).filter(([id, v]) => v.kind === 'pdf' && !listedIds.has(id)).map(([id, v]) => [id, v.name, 'known']),
    ...store.get('pickedPdfs', []).filter((id) => !listedIds.has(id)).map((id) => [id, id, 'picked']),
  ];
  for (const [id, nm, why] of probeIds) {
    const r = await drive.downloadBytes(id, `direct GET unlisted ${why} ${nm}`); steps.push(r);
    tried.push({ name: nm, how: `unlisted-${why}`, ok: r.ok && isPdf(r.data), status: r.status, bytes: r.data?.length });
  }
  const gdocProbe = Object.entries(known()).filter(([id, v]) => v.kind === 'gdoc' && !listedIds.has(id));
  if (!pdfs.length && gdocs[0]) {
    const r = await drive.exportPdf(gdocs[0].id, `export ${gdocs[0].name} as PDF`); steps.push(r);
    tried.push({ name: gdocs[0].name, how: 'gdoc-export', ok: r.ok && isPdf(r.data), status: r.status, bytes: r.data?.length });
  } else if (!pdfs.length && gdocProbe[0]) {
    const [id, v] = gdocProbe[0];
    const r = await drive.exportPdf(id, `export unlisted ${v.name}`); steps.push(r);
    tried.push({ name: v.name, how: 'unlisted-gdoc-export', ok: r.ok && isPdf(r.data), status: r.status, bytes: r.data?.length });
  }
  const real = tried.filter((t) => t.ok && (t.how === 'listed' || t.how.startsWith('unlisted-known') || t.how.startsWith('unlisted-picked')));
  const anyOk = tried.some((t) => t.ok);
  const bad = steps.find((s) => !s.ok);
  addResult({
    criterion: 'C3 list+download PDF', pass: real.some((t) => t.how === 'listed'), status: bad ? bad.status : all.status,
    message: `statements subfolder ${sub.ok && sub.data[0] ? 'found' : 'NOT visible'}; visible: ${items.length} non-log file(s) ` +
      `(${pdfs.length} PDF, ${gdocs.length} Google-native); ` +
      (tried.length ? tried.map((t) => `${t.name} [${t.how}] ${t.ok ? `OK %PDF ${t.bytes}B` : `FAIL ${t.status}`}`).join('; ') : 'nothing to download') +
      (anyOk && !real.some((t) => t.how === 'listed') ? ' (some download worked, but not a listed PDF)' : ''),
    steps,
  });
}

function isPdf(bytes) {
  return bytes && bytes.length > 4 && String.fromCharCode(...bytes.slice(0, 4)) === '%PDF';
}

async function runAll() { await c1(); await c2(); await c3(); }

// ---------- wiring ----------
function init() {
  $('#device').textContent = deviceId;
  $('#origin').textContent = location.origin;
  $('#switchDevice').onclick = () => {
    const next = ($('#newDevice').value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    if (!next) return;
    deviceId = next;
    const u = new URL(location.href); u.searchParams.set('device', next); history.replaceState(null, '', u.href);
    $('#device').textContent = deviceId;
    log(`now simulating device ${deviceId} (token kept)`);
  };
  $('#scopes').innerHTML = Object.entries(SCOPE_SETS).map(([k, v]) =>
    `<label><input type="radio" name="scope" value="${k}" ${k === state.scopeSet ? 'checked' : ''}> ${esc(v.label)}</label>`).join('');
  $('#scopes').addEventListener('change', (e) => {
    state.scopeSet = e.target.value; store.set('scopeSet', state.scopeSet);
    if (state.token) log('scope set changed: revoke and sign in again for it to take effect');
    renderAuth();
  });
  $('#folderId').value = state.folderId;
  $('#saveFolder').onclick = () => setFolder(parseFolderId($('#folderId').value));
  $('#signIn').onclick = () => signIn().catch((e) => log('sign-in error: ' + e.message));
  $('#revoke').onclick = () => revoke().catch((e) => log('revoke error: ' + e.message));
  $('#pickFolder').onclick = () => openPicker('folder').catch((e) => log('picker error: ' + e.message));
  $('#pickPdf').onclick = () => openPicker('pdf').catch((e) => log('picker error: ' + e.message));
  const guard = (fn) => async () => {
    document.querySelectorAll('[data-needs-token]').forEach((b) => { b.disabled = true; });
    try { await fn(); } catch (e) { addResult({ criterion: 'error', pass: false, status: 'exception', message: e.message }); }
    renderAuth();
  };
  $('#share').onclick = guard(async () => {
    if (!needFolder()) return;
    const email = $('#shareEmail').value.trim();
    if (!email.includes('@')) { log('enter an email address first'); return; }
    const r = await drive.shareSilently(state.folderId, email);
    addResult({ criterion: 'setup share', pass: r.ok, status: r.status, message: r.ok ? `shared as ${r.data.role} with ${r.data.emailAddress}, no email sent` : r.error, steps: [r] });
  });
  $('#perms').onclick = guard(async () => {
    if (!needFolder()) return;
    const r = await drive.listPermissions(state.folderId);
    addResult({ criterion: 'setup who has access', pass: r.ok, status: r.status, message: r.ok ? r.data.permissions.map((p) => `${p.emailAddress || p.type}=${p.role}`).join(', ') : r.error, steps: [r] });
  });
  $('#c1').onclick = guard(c1);
  $('#c2').onclick = guard(c2);
  $('#c3').onclick = guard(c3);
  $('#all').onclick = guard(runAll);
  $('#copy').onclick = async () => {
    try { await navigator.clipboard.writeText(toMarkdown()); log('results copied to clipboard'); }
    catch { $('#md').select(); log('clipboard blocked: the text box is selected, press Cmd+C'); }
  };
  $('#clear').onclick = () => { if (confirm('Clear all results on this device?')) { state.results = []; store.set('results', []); renderResults(); } };
  $('#forget').onclick = () => { store.set('known', {}); store.set('pickedPdfs', []); log('forgot remembered file ids'); };
  const canRedirect = REDIRECT_URI.startsWith(location.origin);
  $('#useRedirect').disabled = !canRedirect;
  $('#useRedirect').checked = canRedirect && store.get('useRedirect', false);
  $('#useRedirect').onchange = () => store.set('useRedirect', $('#useRedirect').checked);
  renderAuth();
  renderResults();
  if (handoff) {
    if (handoff.scopeSet && SCOPE_SETS[handoff.scopeSet]) {
      state.scopeSet = handoff.scopeSet; store.set('scopeSet', state.scopeSet);
      document.querySelector(`input[name=scope][value=${state.scopeSet}]`).checked = true;
    }
    if (handoff.error) addResult({ criterion: 'sign-in', pass: false, status: handoff.error, message: `redirect sign-in: ${handoff.error}` });
    else onToken(handoff);
  }
}

init();
