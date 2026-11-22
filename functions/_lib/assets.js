// The deployed catalog / search index / vault, read through env.ASSETS (static files, never via the middleware).
import { canSee, topProject } from './roles.js';
import { parseQuery } from '../../site/query.js';

const TTL_MS = 60 * 1000; // a new deployment starts new isolates anyway; this only bounds staleness within one
const cache = new Map(); // path → { at, value }

export const clearAssetCache = () => cache.clear();

export async function assetJson(env, request, path, { now = Date.now(), optional = false } = {}) {
  const hit = cache.get(path);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`${path}: ${res.status}`);
  }
  const value = await res.json();
  cache.set(path, { at: now, value });
  return value;
}

/** Catalog plus lookup maps. Records: { id, path, project, vault?, … } (see scripts/build.mjs). */
export async function loadCatalog(env, request, opts) {
  const catalog = await assetJson(env, request, '/catalog.json', opts);
  if (!catalog._byId) {
    Object.defineProperty(catalog, '_byId', { value: new Map(catalog.docs.map((d) => [Number(d.id), d])) });
    Object.defineProperty(catalog, '_byPath', { value: new Map(catalog.docs.map((d) => [d.path, d])) });
  }
  return catalog;
}

export const docById = (catalog, id) => catalog._byId.get(Number(String(id).replace(/^#/, ''))) || null;
export const docByPath = (catalog, path) => catalog._byPath.get(path) || null;

function visibleFilter(user, f) {
  const q = parseQuery(f.query || '');
  return q.fields.every((x) => x.key !== 'project' || x.neg || canSee(user, x.value));
}

/** Catalog trimmed to the user's visible projects (DESIGN.md → Access control on static files). */
export function catalogFor(user, catalog) {
  const visible = catalog.docs.filter((d) => canSee(user, d.project));
  const ids = new Set(visible.map((d) => Number(d.id)));
  // links must not leak the ids of docs in hidden projects
  const docs = visible.map((d) => {
    const out = { ...d };
    if (Array.isArray(d.related)) out.related = d.related.filter((id) => ids.has(Number(id)));
    if (d.supersedes !== undefined && d.supersedes !== null && !ids.has(Number(d.supersedes))) delete out.supersedes;
    return out;
  });
  const projects = Object.fromEntries(Object.entries(catalog.projects || {})
    .filter(([key, v]) => canSee(user, v.parent || topProject(key))));
  const filters = (catalog.filters || []).filter((f) => visibleFilter(user, f));
  return { ...catalog, docs, projects, filters, server: true };
}

export function searchIndexFor(user, catalog, rows) {
  const ids = new Set(catalog.docs.filter((d) => canSee(user, d.project)).map((d) => Number(d.id)));
  return rows.filter((r) => ids.has(Number(r.id)));
}
