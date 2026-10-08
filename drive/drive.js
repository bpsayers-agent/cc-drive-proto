// Thin Drive v3 REST helpers. Every call returns a step record:
// { ok, status, label, error, data } so the UI can show exactly what happened.

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const ALL = 'supportsAllDrives=true';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const LOG_MIME = 'text/plain';

let token = null;
export function setToken(t) { token = t; }

async function call(label, url, init = {}, as = 'json') {
  const headers = { Authorization: `Bearer ${token}`, ...(init.headers || {}) };
  let res;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (e) {
    return { ok: false, status: 0, label, error: `network: ${e.message}` };
  }
  if (!res.ok) {
    let error = res.statusText;
    try {
      const j = await res.json();
      const reason = j.error?.errors?.[0]?.reason;
      error = (j.error?.message || error) + (reason ? ` [${reason}]` : '');
    } catch { /* body not JSON */ }
    return { ok: false, status: res.status, label, error };
  }
  let data;
  if (as === 'json') data = await res.json();
  else if (as === 'text') data = await res.text();
  else data = new Uint8Array(await res.arrayBuffer());
  return { ok: true, status: res.status, label, data };
}

const enc = encodeURIComponent;

export function about() {
  return call('about.get', `${API}/about?fields=user(emailAddress,displayName,permissionId)`);
}

export function getMeta(id, label = 'files.get') {
  const fields = 'id,name,mimeType,owners(emailAddress,me),capabilities(canAddChildren,canListChildren,canEdit,canDownload),appProperties';
  return call(label, `${API}/files/${enc(id)}?fields=${enc(fields)}&${ALL}`);
}

export async function list(q, label = 'files.list') {
  const fields = 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,owners(emailAddress,me),parents)';
  const out = [];
  let pageToken = '';
  for (let i = 0; i < 20; i++) {
    const url = `${API}/files?q=${enc(q)}&fields=${enc(fields)}&pageSize=200&includeItemsFromAllDrives=true&${ALL}` +
      (pageToken ? `&pageToken=${enc(pageToken)}` : '');
    const r = await call(label, url);
    if (!r.ok) return r;
    out.push(...r.data.files);
    if (!r.data.nextPageToken) break;
    pageToken = r.data.nextPageToken;
  }
  return { ok: true, status: 200, label, data: out };
}

export function downloadText(id, label = 'files.get alt=media') {
  return call(label, `${API}/files/${enc(id)}?alt=media&${ALL}`, {}, 'text');
}

export function downloadBytes(id, label = 'files.get alt=media') {
  return call(label, `${API}/files/${enc(id)}?alt=media&${ALL}`, {}, 'bytes');
}

export function exportPdf(id, label = 'files.export pdf') {
  return call(label, `${API}/files/${enc(id)}/export?mimeType=${enc('application/pdf')}`, {}, 'bytes');
}

export function createText(name, parentId, text, appProperties, label = 'files.create multipart') {
  const b = 'p2b' + Math.random().toString(36).slice(2);
  const meta = { name, parents: [parentId], mimeType: LOG_MIME, appProperties };
  const body = new Blob([
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${b}\r\nContent-Type: ${LOG_MIME}\r\n\r\n`, text, `\r\n--${b}--`,
  ]);
  return call(label, `${UPLOAD}/files?uploadType=multipart&fields=id,name&${ALL}`, {
    method: 'POST', body, headers: { 'Content-Type': `multipart/related; boundary=${b}` },
  });
}

export function updateText(id, text, label = 'files.update media') {
  return call(label, `${UPLOAD}/files/${enc(id)}?uploadType=media&fields=id,modifiedTime&${ALL}`, {
    method: 'PATCH', body: text, headers: { 'Content-Type': LOG_MIME },
  });
}

export async function tokenInfo(accessToken) {
  try {
    const res = await fetch('https://oauth2.googleapis.com/tokeninfo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `access_token=${enc(accessToken)}`,
    });
    return { ok: res.ok, status: res.status, data: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

// Share a file or folder as editor WITHOUT Google's notification email.
export function shareSilently(id, email, label = 'permissions.create (no email)') {
  return call(label, `${API}/files/${enc(id)}/permissions?sendNotificationEmail=false&fields=id,role,emailAddress&${ALL}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: email }),
  });
}

export function listPermissions(id, label = 'permissions.list') {
  return call(label, `${API}/files/${enc(id)}/permissions?fields=permissions(id,role,type,emailAddress)&${ALL}`);
}
