// Server-mode client: mode detection, JSON API calls and user preferences.
// Static mode (no /api, or a host that answers /api/me with the SPA's index.html) keeps everything in localStorage.

const PREFS_KEY = 'gitdocs:prefs';
let ME = null;

/** GET /api/me once. Returns the user, or null for static mode (404, network error, non-JSON, unexpected shape). */
export async function detectMe() {
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!r.ok || !/json/i.test(r.headers.get('content-type') || '')) return null;
    const me = await r.json();
    if (!me || typeof me.email !== 'string') return null;
    me.email = me.email.toLowerCase();
    me.roles ||= {};
    me.prefs ||= {};
    ME = me;
    return me;
  } catch { return null; }
}
export const me = () => ME;
export const isServer = () => Boolean(ME);

/** JSON request; throws Error(message from `{ error }`) on non-2xx. */
export async function api(method, path, body) {
  const init = { method, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } };
  // the server refuses mutating calls without a JSON content type (CSRF guard), even when there is no body
  if (method !== 'GET' && method !== 'HEAD') init.headers['content-type'] = 'application/json';
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(path, init);
  let j = null;
  try { j = await r.json(); } catch { /* empty or non-JSON body */ }
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
}

// ---------- preferences ----------
function localPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; } }
function saveLocal(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage blocked */ } }
export function getPrefs() { return ME ? { ...localPrefs(), ...ME.prefs } : localPrefs(); }
/** Merge `patch` into prefs: always mirrored to localStorage, and PUT to the server in server mode. */
export async function setPrefs(patch) {
  const next = { ...getPrefs(), ...patch };
  saveLocal(next);
  if (!ME) return next;
  ME.prefs = next;
  await api('PUT', '/api/me/prefs', next);
  return next;
}
