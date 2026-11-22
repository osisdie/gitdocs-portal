// Server-mode client: mode detection, JSON API calls and user preferences.
// Static mode (no /api, or a host that answers /api/me with the SPA's index.html) keeps everything in localStorage.
import { serverMessage } from './i18n.js';

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

/** JSON request; throws Error(message from `{ error }`, in the UI language when known) on non-2xx. */
export async function api(method, path, body) {
  const init = { method, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } };
  // the server refuses mutating calls without a JSON content type (CSRF guard), even when there is no body
  if (method !== 'GET' && method !== 'HEAD') init.headers['content-type'] = 'application/json';
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(path, init);
  let j = null;
  try { j = await r.json(); } catch { /* empty or non-JSON body */ }
  if (!r.ok) throw Object.assign(new Error((j?.error && serverMessage(j.error)) || `HTTP ${r.status}`), { status: r.status });
  return j;
}

// ---------- project-shared filters (server mode) ----------
/** Shared filters of `project`, or of every project the user can view when omitted. */
export const listSharedFilters = (project = '') => api('GET', `/api/filters${project ? `?project=${encodeURIComponent(project)}` : ''}`);
/** { project, name, params } → the stored row; the same name in the same project replaces it. */
export const saveSharedFilter = (f) => api('POST', '/api/filters', f);
export const deleteSharedFilter = (id) => api('DELETE', `/api/filters/${encodeURIComponent(id)}`);

// ---------- preferences ----------
// In server mode the browser may be shared by several Access identities (other tenants included), and localStorage is
// not keyed by account. So there it only mirrors UI-only settings that say nothing about projects or people; saved
// filters, focus projects and anything else live in the server copy alone and are never merged in from local storage.
const LOCAL_SAFE = ['theme', 'lang', 'listPer'];
const pickSafe = (p) => Object.fromEntries(LOCAL_SAFE.filter((k) => Object.hasOwn(p || {}, k)).map((k) => [k, p[k]]));
function localPrefs() {
  try { const v = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function saveLocal(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage blocked */ } }
export function getPrefs() { return ME ? { ...pickSafe(localPrefs()), ...ME.prefs } : localPrefs(); }
/** Merge `patch` into prefs: mirrored to localStorage (server mode: UI-only keys), and PUT to the server in server mode. */
export async function setPrefs(patch) {
  const next = { ...getPrefs(), ...patch };
  if (!ME) { saveLocal(next); return next; }
  saveLocal(pickSafe(next));
  ME.prefs = next;
  await api('PUT', '/api/me/prefs', next);
  return next;
}
