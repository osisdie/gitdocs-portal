// Pure portal logic shared by the UI views (no DOM, no fetch), so it can be tested in Node.
// Workflow statuses, legacy status mapping, roles, "pending for me" and the home-page sections.
import { sensRank } from './query.js';

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
  const roles = me.roles || {};
  const named = roles[project];
  // The index project is owner-only unless a membership names it explicitly: '*' does not cover it.
  const wild = project === INDEX_PROJECT ? null : roles['*'];
  return [named, wild].filter((r) => ROLE_RANK[r]).sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0] || null;
}
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
  const rows = Object.entries(me.roles || {}).map(([p, r]) => `${p === '*' ? '所有專案' : p}：${r}`);
  return [me.owner ? 'owner（全部權限）' : '', ...rows].filter(Boolean).join('、') || '尚無專案權限';
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

export const HOME_SECTIONS = [
  { key: 'mine', title: '指派給我', needsMe: true, test: (d, me) => normStatus(d.status) === '待處理' && sameEmail(d.assignee, me) },
  { key: 'review', title: '待我確認', needsMe: true, test: (d, me) => normStatus(d.status) === '待確認' && sameEmail(d.reviewer, me) },
  { key: 'unassigned', title: '待處理（未指派）', test: (d) => normStatus(d.status) === '待處理' && !d.assignee },
  { key: 'confirm', title: '待確認', test: (d) => normStatus(d.status) === '待確認' },
  { key: 'reported', title: '我建立的', needsMe: true, test: (d, me) => sameEmail(d.reporter, me) && normStatus(d.status) !== '封存' },
  { key: 'recent', title: '最近更新', test: () => true },
  { key: 'sens', title: '機敏性待複核', test: (d) => sensitivityPending(d) },
];

/** Restrict docs to the 關注的專案 selection (empty = all projects). */
export const focusDocs = (docs, focus = []) => (focus?.length ? docs.filter((d) => focus.includes(d.project)) : docs);

/** Home sections for `me` (email or null in static mode): [{ key, title, rows (all, newest first), total }]. */
export function homeSections(docs, me) {
  return HOME_SECTIONS.filter((s) => me || !s.needsMe).map((s) => {
    const rows = docs.filter((d) => s.test(d, me)).sort(byRecency);
    return { key: s.key, title: s.title, rows, total: rows.length };
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
