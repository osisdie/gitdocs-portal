// Pure portal logic shared by the UI views (no DOM, no fetch), so it can be tested in Node.
// Workflow statuses, legacy status mapping, roles, "pending for me" and the home-page sections.
import { sensRank } from './query.js';
import { t, joinList, label } from './i18n.js';

export const WORKFLOW = ['待處理', '待確認', '已確認', '已發布', '封存'];
// Catalogs built before the workflow change still carry these; syncCatalog migrates them on the next build.
export const LEGACY_STATUS = { '草稿': '待處理', '審查中': '待確認', '本機': '已確認' };
export const STATUS_VAR = {
  '待處理': '--st-todo', '待確認': '--st-review', '已確認': '--st-confirmed', '已發布': '--st-published', '封存': '--st-archived',
};
export const normStatus = (s) => LEGACY_STATUS[s] || s || '';
export const statusVar = (s) => STATUS_VAR[normStatus(s)] || '--st-confirmed';

/** Workflow order first, then any other status a catalog still uses (old or custom), in catalog order. */
export function statusList(catalogStatuses = [], docs = []) {
  const used = new Set(docs.map((d) => d.status));
  const extra = [...catalogStatuses, ...used].filter((s) => s && !WORKFLOW.includes(s));
  return [...WORKFLOW, ...new Set(extra)];
}

// ---------- people ----------
export const sameEmail = (a, b) => Boolean(a && b) && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
export const shortName = (email) => String(email || '').split('@')[0];

// Display names (MantisBT "show realname"): a person is shown by name, never by email, except in the admin users
// table and the signed-in user's own profile menu. Sources, later wins: catalog `site.people` { email: name }
// (static mode) → server `/api/state` `people`, `author_name` / `actor_name` on rows, and `/api/me` `name`.
// Without a name the email's local part is shown.
export const NAME_MAX = 80;
const PEOPLE = new Map();
const normEmail = (e) => String(e ?? '').trim().toLowerCase();
/** Merge { email: name } into the registry; empty names are ignored (use setName to clear one). */
export function addPeople(map) {
  for (const [e, n] of Object.entries(map || {})) {
    const k = normEmail(e), v = typeof n === 'string' ? n.trim().slice(0, NAME_MAX) : '';
    if (k && v) PEOPLE.set(k, v);
  }
}
/** Set or clear (empty name) one person's display name. */
export function setName(email, name) {
  const k = normEmail(email), v = String(name ?? '').trim().slice(0, NAME_MAX);
  if (!k) return;
  if (v) PEOPLE.set(k, v); else PEOPLE.delete(k);
}
export const clearPeople = () => PEOPLE.clear();
export const peopleEmails = () => [...PEOPLE.keys()];
/** Display name of an email: registered name, else the local part ('' for no email). */
export const displayName = (email) => (email ? PEOPLE.get(normEmail(email)) || shortName(email) : '');
/** 'Name <email>' — the datalist choice for a person field. */
export const personChoice = (email) => `${displayName(email)} <${normEmail(email)}>`;
/**
 * Text typed in a person field → { email } ('' = nobody) or { error: 'unknown' | 'ambiguous' }.
 * Accepts '', 'Name <email>', a bare email, or a display name known for exactly one of `emails`.
 * `current` (the field's stored email) wins when the text is still its display name.
 */
export function resolvePerson(text, emails = [], current = '') {
  const v = String(text ?? '').trim();
  if (!v) return { email: '' };
  const angle = /<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(v);
  if (angle) return { email: normEmail(angle[1]) };
  if (/^[^\s@<>]+@[^\s@<>]+$/.test(v)) return { email: normEmail(v) };
  if (current && displayName(current) === v) return { email: normEmail(current) };
  const want = v.toLowerCase();
  const hits = [...new Set(emails.map(normEmail).filter(Boolean))].filter((e) => displayName(e).toLowerCase() === want);
  return hits.length === 1 ? { email: hits[0] } : { error: hits.length ? 'ambiguous' : 'unknown' };
}
export function initials(email) {
  const local = shortName(email).replace(/[^\p{L}\p{N}._-]/gu, '');
  if (!local) return '?';
  const parts = local.split(/[._-]+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return s.toUpperCase();
}

// ---------- roles ----------
export const ROLE_RANK = { viewer: 1, editor: 2, manager: 3, owner: 4 };
export const INDEX_PROJECT = '（索引）';

/** Effective role of `me` (GET /api/me) on a top-level project: owner > named membership / '*' (higher wins). */
export function roleFor(me, project) {
  if (!me) return null;
  if (me.owner) return 'owner';
  const top = topOf(project);
  const roles = me.roles || {};
  const named = roles[top];
  // The index project is owner-only unless a membership names it explicitly: '*' does not cover it.
  const wild = top === INDEX_PROJECT ? null : roles['*'];
  const member = [named, wild].filter((r) => ROLE_RANK[r]).sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0] || null;
  // A public project (GET /api/me publicProjects) gives every known user the viewer role, never more.
  return member || (top !== INDEX_PROJECT && (me.publicProjects || []).includes(top) ? 'viewer' : null);
}
/** Top-level key of a project or subproject key ('a/b' → 'a'). */
export const topOf = (p) => String(p ?? '').split('/')[0];
/** catalog.projects[k].visibility === 'public' (the build puts the effective value on every entry; a missing
 *  subproject entry falls back to its top level). The index project is never public. */
export function isPublicProject(projects, key) {
  const top = topOf(key);
  if (!key || top === INDEX_PROJECT) return false;
  const v = projects?.[key]?.visibility ?? projects?.[top]?.visibility;
  return v === 'public';
}
/** External content source of a project or subproject (registry `source`), or ''. */
export const sourceOfProject = (projects, key) => projects?.[key]?.source || projects?.[topOf(key)]?.source || '';
export const atLeast = (role, min) => (ROLE_RANK[role] || 0) >= ROLE_RANK[min];
export const canEdit = (me, doc) => atLeast(roleFor(me, doc.project), 'editor');
export const isManager = (me) => Boolean(me) && (me.owner || Object.values(me.roles || {}).includes('manager'));
/** Projects whose members `me` may manage; ['*'] means all. */
export function managedProjects(me) {
  if (!me) return [];
  if (me.owner || me.roles?.['*'] === 'manager') return ['*'];
  return Object.entries(me.roles || {}).filter(([, r]) => r === 'manager').map(([p]) => p);
}
export function rolesSummary(me) {
  if (!me) return '';
  const rows = Object.entries(me.roles || {}).map(([p, r]) => t('roles.row', { project: p === '*' ? t('roles.all') : label('project', p), role: r }));
  const pub = me.owner ? [] : (me.publicProjects || []).filter((p) => !me.roles?.[p]);
  if (pub.length) rows.push(t('roles.public', { list: joinList(pub.map((p) => label('project', p))) }));
  return joinList([me.owner ? t('roles.owner') : '', ...rows].filter(Boolean)) || t('roles.none');
}

// ---------- server state ----------
/** Overlay GET /api/state rows (keyed by catalog path) onto catalog docs; returns new objects. */
export function mergeState(docs, state) {
  const rows = state?.docs || {};
  return docs.map((d) => {
    const s = rows[d.path];
    if (!s) return d;
    const m = { ...d };
    for (const k of ['status', 'assignee', 'reviewer']) if (s[k] !== undefined && s[k] !== null) m[k] = s[k];
    if (Array.isArray(s.tags)) m.tags = s.tags;
    if (s.updated_at) m.updated_at = s.updated_at;
    if (s.updated_by) m.updated_by = s.updated_by;
    if (typeof s.notes === 'number') m.notes = s.notes;
    return m;
  });
}

// ---------- workflow queries ----------
/** DESIGN.md: (status = 待處理 and assignee = X) or (status = 待確認 and reviewer = X). */
export function pendingFor(d, email) {
  const st = normStatus(d.status);
  return (st === '待處理' && sameEmail(d.assignee, email)) || (st === '待確認' && sameEmail(d.reviewer, email));
}
export const sensitivityPending = (d) => (d.sensitivityPending !== undefined ? Boolean(d.sensitivityPending) : sensRank(d.sensitivity) >= 2 && !d.sensitivityReviewed);
/** Newest-first key: server updated_at when known, else the doc date (both start with YYYY-MM-DD). */
export const recency = (d) => `${d.updated_at || d.date || ''}#${String(d.id).padStart(7, '0')}`;
export const byRecency = (a, b) => (recency(b) > recency(a) ? 1 : recency(b) < recency(a) ? -1 : 0);

// Section titles are UI text: i18n key `home.sec.<key>`.
export const HOME_SECTIONS = [
  { key: 'mine', needsMe: true, test: (d, me) => normStatus(d.status) === '待處理' && sameEmail(d.assignee, me) },
  { key: 'review', needsMe: true, test: (d, me) => normStatus(d.status) === '待確認' && sameEmail(d.reviewer, me) },
  { key: 'unassigned', test: (d) => normStatus(d.status) === '待處理' && !d.assignee },
  { key: 'confirm', test: (d) => normStatus(d.status) === '待確認' },
  { key: 'reported', needsMe: true, test: (d, me) => sameEmail(d.reporter, me) && normStatus(d.status) !== '封存' },
  { key: 'recent', test: () => true },
  { key: 'sens', test: (d) => sensitivityPending(d) },
];

/** Restrict docs to the focus-projects selection (empty = all projects). */
export const focusDocs = (docs, focus = []) => (focus?.length ? docs.filter((d) => focus.includes(d.project)) : docs);

/** Home sections for `me` (email or null in static mode): [{ key, title, rows (all, newest first), total }]. */
export function homeSections(docs, me) {
  return HOME_SECTIONS.filter((s) => me || !s.needsMe).map((s) => {
    const rows = docs.filter((d) => s.test(d, me)).sort(byRecency);
    return { key: s.key, title: t(`home.sec.${s.key}`), rows, total: rows.length };
  });
}

/** Fields of a PATCH /api/docs/:id body that differ from the doc. A cleared person is sent as '' (not null):
 *  in doc_state, null means "no web override, use the catalog value", '' means "explicitly nobody". */
export function patchDiff(d, form) {
  const out = {};
  if (form.status !== undefined && form.status !== d.status) out.status = form.status;
  for (const k of ['assignee', 'reviewer']) {
    if (form[k] === undefined) continue;
    const v = String(form[k]).trim().toLowerCase();
    if (v !== String(d[k] || '').toLowerCase()) out[k] = v;
  }
  if (form.tags !== undefined) {
    const tags = [...new Set(String(form.tags).split(/[,，\s]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean))];
    if (tags.join('\n') !== (d.tags || []).join('\n')) out.tags = tags;
  }
  return out;
}
