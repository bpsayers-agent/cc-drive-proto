// Persistent event log for the phone token test. Shared with the root page,
// which records where an OAuth redirect landed before handing it to phone/.
// Stores no tokens. Account emails are masked before they are logged.

const LOG_KEY = 'p3.log';
const MAX_EVENTS = 1000;

export function displayMode() {
  if (window.navigator.standalone === true) return 'standalone';
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return 'standalone';
  return 'tab';
}

export function readLog() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function appendEvent(kind, details = {}) {
  const event = { t: new Date().toISOString(), kind, mode: displayMode(), ...details };
  try {
    const events = readLog();
    events.push(event);
    localStorage.setItem(LOG_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch {
    // Storage full or blocked: the on-page log will say so by not growing.
  }
  return event;
}

export function clearLog() {
  try { localStorage.removeItem(LOG_KEY); } catch {}
}

export function maskEmail(email) {
  if (!email || !email.includes('@')) return email || '';
  const [user, domain] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

export function formatDuration(ms) {
  if (ms == null || !isFinite(ms)) return '-';
  const s = Math.round(ms / 1000);
  if (Math.abs(s) < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// One line per event, newest first, readable when pasted into a message.
export function formatEvent(e) {
  const time = e.t.replace('T', ' ').slice(0, 19) + 'Z';
  const extras = Object.entries(e)
    .filter(([k, v]) => !['t', 'kind', 'mode'].includes(k) && v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');
  return `${time} [${e.mode}] ${e.kind}${extras ? ' ' + extras : ''}`;
}
