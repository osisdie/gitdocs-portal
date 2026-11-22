// The deployed catalog / search index / vault, read through env.ASSETS (static files, never via the middleware).
import { canSee, canEdit, topProject, publicProjectsOf } from './roles.js';
import { parseQuery, sensRank } from '../../site/query.js';

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

/** Set of public top-level projects of a catalog (memoised on the object; DESIGN.md → Project visibility). */
export function publicOf(catalog) {
  if (!catalog._public) Object.defineProperty(catalog, '_public', { value: publicProjectsOf(catalog) });
  return catalog._public;
}

/**
 * Vault namespace of a doc mounted from an external source (DESIGN.md → External content sources), or null.
 * The build sets `source` on the record; the project registry entry of the mount carries it too (defence in depth).
 */
export function docSource(catalog, doc) {
  if (typeof doc.source === 'string' && doc.source) return doc.source;
  const reg = catalog.projects && Object.hasOwn(catalog.projects, topProject(doc.project)) ? catalog.projects[topProject(doc.project)] : null;
  return reg && typeof reg.source === 'string' && reg.source ? reg.source : null;
}

/**
 * Confidential documents (DESIGN.md → Confidential documents): 機密 and above are readable by editor+ of the project
 * only; viewers and public-project visitors get the record without the body.
 */
export const isRestricted = (user, doc) => sensRank(doc.sensitivity) >= sensRank('機密') && !canEdit(user, doc.project);

export const docById = (catalog, id) => catalog._byId.get(Number(String(id).replace(/^#/, ''))) || null;
export const docByPath = (catalog, path) => catalog._byPath.get(path) || null;

function visibleFilter(user, f, pub) {
  const q = parseQuery(f.query || '');
  return q.fields.every((x) => x.key !== 'project' || x.neg || canSee(user, x.value, pub));
}

/**
 * Catalog trimmed to the user's visible projects (DESIGN.md → Access control on static files). `people`: the emails
 * whose site.people names the caller may see (functions/_lib/people.js visiblePeople); without it only the caller
 * and the people fields of visible docs are kept.
 */
export function catalogFor(user, catalog, people = null) {
  const pub = publicOf(catalog);
  const visible = catalog.docs.filter((d) => canSee(user, d.project, pub));
  const ids = new Set(visible.map((d) => Number(d.id)));
  // links must not leak the ids of docs in hidden projects
  const docs = visible.map((d) => {
    const out = { ...d };
    if (isRestricted(user, d)) { out.restricted = true; delete out.vault; delete out.vaultBlocked; }
    if (Array.isArray(d.related)) out.related = d.related.filter((id) => ids.has(Number(id)));
    if (d.supersedes !== undefined && d.supersedes !== null && !ids.has(Number(d.supersedes))) delete out.supersedes;
    return out;
  });
  const projects = Object.fromEntries(Object.entries(catalog.projects || {})
    .filter(([key, v]) => canSee(user, v.parent || topProject(key), pub)));
  const filters = (catalog.filters || []).filter((f) => visibleFilter(user, f, pub));
  let site = catalog.site;
  if (site?.people && typeof site.people === 'object') {
    const allowed = people || new Set([user.email, ...visible.flatMap((d) => ['reporter', 'assignee', 'reviewer'].map((k) => String(d[k] || '').toLowerCase()))]);
    site = { ...site, people: Object.fromEntries(Object.entries(site.people).filter(([e]) => allowed.has(String(e).toLowerCase()))) };
  }
  return { ...catalog, site, docs, projects, filters, server: true };
}

export function searchIndexFor(user, catalog, rows) {
  const pub = publicOf(catalog);
  // restricted docs never have a body in the index (the build keeps 機密 out); dropping them is a second guard
  const ids = new Set(catalog.docs.filter((d) => canSee(user, d.project, pub) && !isRestricted(user, d)).map((d) => Number(d.id)));
  return rows.filter((r) => ids.has(Number(r.id)));
}
