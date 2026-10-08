// Phone token test: does Google sign-in and hourly token renewal work on an
// iPhone, in a Safari tab and as a home-screen app? Two methods:
//   popup    - Google Identity Services token client; renewal via prompt ''.
//   redirect - full-page implicit flow; renewal tries prompt=none first and
//              falls back to an interactive redirect once.
// The access token lives in memory only, as it would in the real app, so a
// cold start from the home screen always needs a renewal.

import { CLIENT_ID, REDIRECT_URI } from '../config.js';
import { appendEvent, readLog, clearLog, displayMode, maskEmail, formatDuration, formatEvent } from './log.js';

const SCOPES = {
  'drive.file': 'https://www.googleapis.com/auth/drive.file',
  'drive.readonly': 'https://www.googleapis.com/auth/drive.readonly',
  'drive': 'https://www.googleapis.com/auth/drive',
};
const RENEW_MARGIN_MS = 5 * 60 * 1000;
const AUTO_RETRY_PAUSE_MS = 10 * 60 * 1000;
const REDIRECT_COUNTDOWN_MS = 2000;
const ATTEMPT_TIMEOUT_MS = 120 * 1000;

// ---------- small storage helpers (no tokens are ever stored) ----------
const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem('p3.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { if (value === null || value === undefined) localStorage.removeItem('p3.' + key); else localStorage.setItem('p3.' + key, JSON.stringify(value)); } catch {}
  },
};

const settings = {
  get method() { return store.get('method', 'popup'); },
  get scopeKey() { const s = store.get('scope', 'drive.file'); return SCOPES[s] ? s : 'drive.file'; },
  get scope() { return SCOPES[this.scopeKey]; },
  get hint() { return store.get('hint', ''); },
};

// ---------- in-memory token ----------
let token = null; // { value, expiresAt, scope, obtainedAt, method }
let pendingAttempt = null; // popup attempt in flight
let redirectTimer = null;

function now() { return Date.now(); }
function sinceLastToken() {
  const t = store.get('lastTokenAt');
  return t ? formatDuration(now() - t) : 'never';
}
function base() { return { method: settings.method, scope: settings.scopeKey }; }
function log(kind, details = {}) { const e = appendEvent(kind, { ...base(), ...details }); renderLog(); return e; }

function tokenNeed() {
  if (!token) return 'no-token';
  const left = token.expiresAt - now();
  if (left <= 0) return 'expired';
  if (left < RENEW_MARGIN_MS) return 'near-expiry';
  return null;
}

function signedInWith(method) { return !!store.get('signedIn', {})[method]; }
function markSignedIn(method) { const s = store.get('signedIn', {}); s[method] = true; store.set('signedIn', s); }

// ---------- renewal cycles: from "token missing" to "token in hand" ----------
// Persisted so a redirect round trip, which reloads the page, stays one cycle.
function currentCycle() { return store.get('cycle'); }
// A tap after a failed automatic attempt continues the same cycle, so the
// outcome reads "1 tap" rather than hiding the failed silent try.
function startCycle(reason, trigger, gesture = false) {
  const existing = currentCycle();
  if (existing && existing.method === settings.method && (!existing.failedAt || gesture)) {
    if (existing.failedAt) updateCycle((c) => { delete c.failedAt; });
    return currentCycle();
  }
  if (existing) log('renewal-cycle-abandoned', { cycle: existing.id, reason: existing.reason, attempts: existing.attempts, taps: existing.taps });
  const cycle = { id: Math.random().toString(36).slice(2, 8), method: settings.method, reason, trigger, startedAt: now(), taps: 0, attempts: 0, stages: [] };
  store.set('cycle', cycle);
  log('renewal-cycle-start', { cycle: cycle.id, reason, trigger, sinceLastToken: sinceLastToken() });
  return cycle;
}
function updateCycle(fn) { const c = currentCycle(); if (!c) return null; fn(c); store.set('cycle', c); return c; }

function classify(cycle) {
  const sawGoogle = cycle.stages.some((s) => s === 'interactive' || s === 'signin');
  if (cycle.reason === 'sign-in') return 'sign-in';
  if (cycle.taps === 0 && !sawGoogle) return cycle.method === 'popup' ? 'no-tap (popup opened; screen unknown)' : 'silent';
  if (cycle.taps === 0) return 'no-tap but Google screen shown';
  return `${cycle.taps} tap${cycle.taps > 1 ? 's' : ''}`;
}

// ---------- success / failure ----------
function onToken({ accessToken, expiresIn, grantedScope, stage, ms, trigger, channel }) {
  token = { value: accessToken, expiresAt: now() + Number(expiresIn) * 1000, scope: grantedScope, obtainedAt: now(), method: settings.method };
  const prev = sinceLastToken();
  store.set('lastTokenAt', now());
  markSignedIn(settings.method);
  log('token-ok', { stage, trigger, ms, expiresIn: Number(expiresIn), granted: shortScopes(grantedScope), sinceLastToken: prev, channel });
  const cycle = currentCycle();
  if (cycle) {
    const outcome = classify(cycle);
    const summary = `${outcome}, ${formatDuration(now() - cycle.startedAt)} (${cycle.attempts} attempt${cycle.attempts > 1 ? 's' : ''}: ${cycle.stages.join(' > ')})`;
    log('renewal-cycle-done', { cycle: cycle.id, reason: cycle.reason, outcome, taps: cycle.taps, attempts: cycle.attempts, stages: cycle.stages.join('>'), ms: now() - cycle.startedAt });
    store.set('lastOutcome', { at: now(), ok: true, text: summary, reason: cycle.reason });
    store.set('cycle', null);
    showNotePrompt(true);
  }
  hideBanner();
  render();
  checkToken('after-token');
}

function onFailure({ stage, trigger, ms, error, detail }) {
  log('token-failed', { stage, trigger, ms, error, detail, sinceLastToken: sinceLastToken() });
  const cycle = updateCycle((c) => { c.failedAt = now(); c.lastError = error; });
  store.set('lastOutcome', { at: now(), ok: false, text: `failed at ${stage}: ${error}${cycle ? ` (${cycle.attempts} attempts, ${cycle.taps} taps)` : ''}` });
  showNotePrompt(false);
  render();
}

function shortScopes(scope) {
  return (scope || '').split(' ').filter(Boolean).map((s) => s.replace('https://www.googleapis.com/auth/', '')).join(',');
}

// ---------- method (a): GIS token client popup ----------
let gisReady = null;
function loadGis() {
  if (gisReady) return gisReady;
  const started = now();
  gisReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => { log('gis-loaded', { ms: now() - started }); resolve(); };
    s.onerror = () => { log('gis-load-failed', { ms: now() - started }); reject(new Error('GIS failed to load')); };
    document.head.appendChild(s);
  });
  return gisReady;
}

// Must be called synchronously inside a tap handler for Safari to allow the popup.
function popupRequest(stage, trigger, prompt) {
  if (!window.google?.accounts?.oauth2) { onFailure({ stage, trigger, ms: 0, error: 'gis-not-loaded' }); return; }
  const attempt = { id: Math.random().toString(36).slice(2, 8), stage, trigger, startedAt: now(), done: false };
  pendingAttempt = attempt;
  const finish = () => { if (attempt.done) return false; attempt.done = true; clearTimeout(attempt.timer); if (pendingAttempt === attempt) pendingAttempt = null; return true; };
  const config = {
    client_id: CLIENT_ID,
    scope: settings.scope,
    include_granted_scopes: true,
    callback: (resp) => {
      if (!finish()) return;
      const ms = now() - attempt.startedAt;
      if (resp.error) onFailure({ stage, trigger, ms, error: resp.error, detail: resp.error_description });
      else onToken({ accessToken: resp.access_token, expiresIn: resp.expires_in, grantedScope: resp.scope, stage, ms, trigger });
    },
    error_callback: (err) => {
      if (!finish()) return;
      onFailure({ stage, trigger, ms: now() - attempt.startedAt, error: err?.type || 'unknown', detail: err?.message });
    },
  };
  if (settings.hint) config.login_hint = settings.hint;
  updateCycle((c) => { c.attempts++; c.stages.push(stage); });
  log('attempt-start', { stage, trigger, prompt: prompt === '' ? "''" : prompt });
  attempt.timer = setTimeout(() => { if (finish()) onFailure({ stage, trigger, ms: ATTEMPT_TIMEOUT_MS, error: 'no-response-120s' }); }, ATTEMPT_TIMEOUT_MS);
  try {
    const client = google.accounts.oauth2.initTokenClient(config);
    const override = { prompt };
    if (settings.hint) override.login_hint = settings.hint;
    client.requestAccessToken(override);
  } catch (e) {
    if (finish()) onFailure({ stage, trigger, ms: now() - attempt.startedAt, error: 'exception', detail: String(e && e.message || e) });
  }
}

// ---------- method (b): full-page redirect implicit flow ----------
function buildRedirectUrl(stage, nonce) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'token',
    scope: settings.scope,
    state: `phone:${nonce}`,
    include_granted_scopes: 'true',
  });
  if (settings.hint && stage !== 'signin') p.set('login_hint', settings.hint);
  if (stage === 'silent') p.set('prompt', 'none');
  if (stage === 'signin') p.set('prompt', 'select_account');
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

function redirectRequest(stage, trigger) {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  store.set('pendingRedirect', { nonce, stage, trigger, startedAt: now(), scope: settings.scopeKey });
  updateCycle((c) => { c.attempts++; c.stages.push(stage); });
  log('attempt-start', { stage, trigger, prompt: stage === 'silent' ? 'none' : stage === 'signin' ? 'select_account' : '(default)' });
  location.assign(buildRedirectUrl(stage, nonce));
}

// Shows a short countdown so the person sees what is about to happen and can stop it.
function redirectAfterCountdown(stage, trigger) {
  hideBanner();
  const until = now() + REDIRECT_COUNTDOWN_MS;
  showBanner(`Going to Google (${stage === 'silent' ? 'silent try' : 'sign-in screen'})...`, true);
  redirectTimer = setInterval(() => {
    if (now() >= until) { hideBanner(); redirectRequest(stage, trigger); }
  }, 200);
}

function takeHandoff() {
  let raw = null, channel = null;
  try { raw = sessionStorage.getItem('oauth.handoff'); if (raw) channel = 'sessionStorage'; } catch {}
  if (!raw) { try { raw = localStorage.getItem('oauth.handoff'); if (raw) channel = 'localStorage'; } catch {} }
  if (!raw) return null;
  let handoff;
  try { handoff = JSON.parse(raw); } catch { handoff = null; }
  if (!handoff || handoff.route !== 'phone') return null; // not ours: leave it for its page
  try { sessionStorage.removeItem('oauth.handoff'); } catch {}
  try { localStorage.removeItem('oauth.handoff'); } catch {}
  if (now() - handoff.at > 5 * 60 * 1000) { log('redirect-handoff-stale', { ageMs: now() - handoff.at }); return null; }
  return { params: new URLSearchParams(handoff.fragment), channel };
}

// Returns true if it started another redirect (so the caller should do nothing else).
function processRedirectReturn() {
  const pending = store.get('pendingRedirect');
  const handoff = takeHandoff();
  if (!handoff) {
    if (pending) {
      store.set('pendingRedirect', null);
      if (now() - pending.startedAt < 30 * 60 * 1000) {
        onFailure({ stage: pending.stage, trigger: pending.trigger, ms: now() - pending.startedAt, error: 'came-back-without-result', detail: 'page opened again before Google returned a token' });
      }
    }
    return false;
  }
  const { params, channel } = handoff;
  const nonce = (params.get('state') || '').split(':')[1];
  if (!pending || pending.nonce !== nonce) {
    log('redirect-state-mismatch', { channel, hadPending: !!pending });
    store.set('pendingRedirect', null);
    return false;
  }
  store.set('pendingRedirect', null);
  const ms = now() - pending.startedAt;
  if (params.get('access_token')) {
    onToken({ accessToken: params.get('access_token'), expiresIn: params.get('expires_in'), grantedScope: params.get('scope'), stage: pending.stage, ms, trigger: pending.trigger, channel });
    return false;
  }
  const error = params.get('error');
  const cycle = currentCycle();
  const triedInteractive = cycle && cycle.stages.includes('interactive');
  if (pending.stage === 'silent' && !triedInteractive) {
    log('token-failed', { stage: 'silent', trigger: pending.trigger, ms, error, channel, next: 'interactive' });
    redirectAfterCountdown('interactive', 'fallback');
    return true;
  }
  onFailure({ stage: pending.stage, trigger: pending.trigger, ms, error, detail: params.get('error_subtype') || undefined });
  return false;
}

// ---------- the renewal decision ----------
// gesture: true when called synchronously from a tap (popups allowed).
function ensureToken(trigger, gesture) {
  const need = tokenNeed();
  if (!need) { checkToken(trigger); return; }
  const method = settings.method;
  if (!signedInWith(method)) {
    if (trigger !== 'open' && trigger !== 'visible') log('renewal-skipped', { trigger, why: 'not signed in with this method yet' });
    render();
    return;
  }
  if (!gesture) {
    const cycle = currentCycle();
    if (cycle && cycle.method === method && cycle.failedAt && now() - cycle.failedAt < AUTO_RETRY_PAUSE_MS) {
      if (trigger === 'open' || trigger === 'visible') log('auto-renewal-paused', { trigger, why: 'last attempt failed recently; tap Renew' });
      render();
      return;
    }
    if (pendingAttempt || redirectTimer) return;
  }
  const cycle = startCycle(need, trigger, gesture);
  if (gesture) updateCycle((c) => { c.taps++; });
  if (method === 'popup') {
    popupRequest(gesture ? 'tap' : 'auto', trigger, '');
  } else if (gesture) {
    const triedSilent = cycle.stages.includes('silent');
    redirectRequest(triedSilent ? 'interactive' : 'silent', trigger);
  } else {
    redirectAfterCountdown('silent', trigger);
  }
}

function signIn() {
  const method = settings.method;
  const existing = currentCycle();
  if (existing) { log('renewal-cycle-abandoned', { cycle: existing.id, reason: existing.reason, attempts: existing.attempts, taps: existing.taps }); store.set('cycle', null); }
  startCycle('sign-in', 'sign-in-button');
  updateCycle((c) => { c.taps++; });
  if (method === 'popup') popupRequest('signin', 'sign-in-button', 'select_account');
  else redirectRequest('signin', 'sign-in-button');
}

// ---------- token check: Drive about.get proves the token works ----------
let lastCheck = null;
async function checkToken(trigger) {
  if (!token) return;
  const t = token;
  const started = now();
  try {
    const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)', { headers: { Authorization: 'Bearer ' + t.value } });
    const ms = now() - started;
    if (r.status === 401) {
      if (token === t) token = null;
      log('check-401', { trigger, ms, note: 'token rejected; dropped' });
      lastCheck = { ok: false, at: now(), text: 'Token rejected by Drive (401)' };
      render();
      ensureToken('after-401', false);
      return;
    }
    if (!r.ok) {
      const body = await r.text();
      log('check-failed', { trigger, ms, status: r.status, detail: body.slice(0, 200).replace(/\s+/g, ' ') });
      lastCheck = { ok: false, at: now(), text: `Drive said ${r.status}` };
      render();
      return;
    }
    const { user } = await r.json();
    const email = user?.emailAddress || '';
    if (email && email !== settings.hint) store.set('hint', email);
    const secondsLeft = Math.round((t.expiresAt - now()) / 1000);
    log('check-ok', { trigger, ms, account: maskEmail(email), secondsLeft });
    lastCheck = { ok: true, at: now(), text: `Drive OK as ${user?.displayName || ''} (${email})` };
  } catch (e) {
    log('check-error', { trigger, ms: now() - started, detail: String(e && e.message || e) });
    lastCheck = { ok: false, at: now(), text: 'Network error calling Drive' };
  }
  render();
}

// ---------- rendering ----------
const $ = (id) => document.getElementById(id);
let bannerEl = null;

function showBanner(text, cancellable) {
  const b = $('banner');
  b.querySelector('span').textContent = text;
  $('banner-cancel').hidden = !cancellable;
  b.hidden = false;
  bannerEl = b;
}
function hideBanner() {
  if (redirectTimer) { clearInterval(redirectTimer); redirectTimer = null; }
  if (bannerEl) bannerEl.hidden = true;
}

function showNotePrompt(ok) {
  $('note-box').hidden = false;
  $('note-title').textContent = ok ? 'Got a token. What did you see?' : 'That failed. What did you see?';
}

function render() {
  const mode = displayMode();
  const badge = $('mode');
  badge.textContent = mode === 'standalone' ? 'Home-screen app' : 'Safari tab';
  badge.className = 'badge ' + mode;

  const need = tokenNeed();
  const tokenEl = $('token-state');
  if (!token) tokenEl.textContent = signedInWith(settings.method) ? 'No token in memory' : 'Not signed in with this method yet';
  else if (need === 'expired') tokenEl.textContent = 'Expired';
  else tokenEl.textContent = `Valid for ${formatDuration(token.expiresAt - now())}` + (need === 'near-expiry' ? ' (renewing soon)' : '');
  tokenEl.className = token && !need ? 'ok' : 'warn';

  $('account').textContent = lastCheck ? lastCheck.text : (settings.hint ? `Last account: ${settings.hint}` : '-');
  $('account').className = lastCheck ? (lastCheck.ok ? 'ok' : 'warn') : '';
  $('since').textContent = sinceLastToken() === 'never' ? 'never' : sinceLastToken() + ' ago';
  const outcome = store.get('lastOutcome');
  $('outcome').textContent = outcome ? `${outcome.text} (${formatDuration(now() - outcome.at)} ago)` : '-';
  $('outcome').className = outcome ? (outcome.ok ? 'ok' : 'warn') : '';

  const signedIn = signedInWith(settings.method);
  const cycle = currentCycle();
  $('renew').hidden = !(signedIn && (!token || need) && (!cycle || cycle.failedAt || settings.method === 'popup'));
  $('signin').textContent = signedIn ? 'Sign in again / switch account' : 'Sign in';
  $('signin').className = signedIn ? 'secondary' : 'primary';

  for (const r of document.querySelectorAll('input[name=method]')) r.checked = r.value === settings.method;
  $('scope').value = settings.scopeKey;
}

function renderLog() {
  const list = $('log');
  if (!list) return;
  const events = readLog().slice().reverse();
  $('log-count').textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;
  list.textContent = events.slice(0, 200).map(formatEvent).join('\n') || '(empty)';
}

function logAsText() {
  const lines = readLog().slice().reverse().map(formatEvent);
  return [
    'Phone token test log',
    `phone: ${store.get('label', '') || '(no label set)'}`,
    `copied: ${new Date().toISOString()}`,
    `mode now: ${displayMode()}, method: ${settings.method}, scope: ${settings.scopeKey}`,
    `browser: ${navigator.userAgent}`,
    `--- ${lines.length} events, newest first ---`,
    ...lines,
  ].join('\n');
}

async function copyLog() {
  const text = logAsText();
  try {
    await navigator.clipboard.writeText(text);
    $('copy').textContent = 'Copied. Paste it into a message.';
  } catch {
    const ta = $('copy-fallback');
    ta.hidden = false;
    ta.value = text;
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    $('copy').textContent = ok ? 'Copied. Paste it into a message.' : 'Select the text below and copy it';
  }
  setTimeout(() => { $('copy').textContent = 'Copy log'; }, 4000);
}

// ---------- wiring ----------
function wire() {
  window.addEventListener('error', (e) => log('js-error', { detail: String(e.message || e.error || 'unknown').slice(0, 200) }));
  window.addEventListener('unhandledrejection', (e) => log('js-error', { detail: String(e.reason && e.reason.message || e.reason).slice(0, 200) }));
  $('signin').addEventListener('click', () => signIn());
  $('renew').addEventListener('click', () => ensureToken('renew-button', true));
  $('check').addEventListener('click', () => ensureToken('check-now', true));
  $('simulate').addEventListener('click', () => {
    if (!token) { log('simulate-skipped', { why: 'no token' }); return; }
    token.expiresAt = now() - 1000;
    log('simulated-expiry');
    render();
    ensureToken('simulated-expiry', false);
  });
  $('banner-cancel').addEventListener('click', () => {
    hideBanner();
    updateCycle((c) => { c.failedAt = now(); c.lastError = 'cancelled'; });
    log('redirect-cancelled-by-user');
    render();
  });
  for (const r of document.querySelectorAll('input[name=method]')) {
    r.addEventListener('change', () => {
      store.set('method', r.value);
      token = null;
      lastCheck = null;
      store.set('cycle', null);
      log('method-changed', { to: r.value });
      if (r.value === 'popup') loadGis().catch(() => {});
      render();
    });
  }
  $('scope').addEventListener('change', (e) => {
    store.set('scope', e.target.value);
    token = null;
    lastCheck = null;
    log('scope-changed', { to: e.target.value });
    render();
  });
  const label = $('label');
  label.value = store.get('label', '');
  label.addEventListener('change', () => { store.set('label', label.value.trim()); log('label-set'); });
  for (const b of document.querySelectorAll('#note-box button[data-note]')) {
    b.addEventListener('click', () => {
      let note = b.dataset.note;
      if (note === 'other') note = 'other: ' + (prompt('What did you see?') || '');
      log('user-note', { note });
      $('note-box').hidden = true;
    });
  }
  $('copy').addEventListener('click', copyLog);
  $('clear').addEventListener('click', () => {
    if (confirm('Clear the whole log on this phone? Copy it first if you have not sent it.')) { clearLog(); log('log-cleared'); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      log('became-visible', { tokenState: tokenNeed() || 'valid', sinceLastToken: sinceLastToken() });
      render();
      ensureToken('visible', false);
    } else {
      log('hidden');
    }
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) { log('restored-from-cache'); ensureToken('visible', false); } });
  setInterval(() => { render(); if (token && tokenNeed() && document.visibilityState === 'visible' && !pendingAttempt && !redirectTimer && !currentCycle()) ensureToken('timer', false); }, 1000);
}

async function main() {
  wire();
  const lastOpen = store.get('lastOpenAt');
  store.set('lastOpenAt', now());
  log('page-open', {
    sinceLastOpen: lastOpen ? formatDuration(now() - lastOpen) : 'first',
    sinceLastToken: sinceLastToken(),
    signedInPopup: signedInWith('popup'),
    signedInRedirect: signedInWith('redirect'),
    online: navigator.onLine,
  });
  render();
  renderLog();
  const redirecting = processRedirectReturn();
  if (redirecting || token) return;
  if (settings.method === 'popup') {
    try { await loadGis(); } catch { render(); return; }
  } else {
    loadGis().catch(() => {}); // loaded anyway so switching method is instant
  }
  ensureToken('open', false);
}

main();
