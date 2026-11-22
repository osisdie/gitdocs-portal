// List view state: advanced filter panel ⇄ query tokens, legacy URL params, multi-column sort and paging.
// Pure ES module (no DOM), so the helpers are unit-tested in Node (test/liststate.test.mjs).
//
// URL of the list view:  #/list?p=<project>&q=<query>&sort=<key:dir,key:dir>&per=<25|50|100|all>&page=<n>
// The panel writes canonical tokens into q= (shareable, and the CLI understands the same string):
//   s:open,in-review  cat:plan  sens:internal,confidential  type:md  tag:a,b (any) | tag:a+b (all)
//   reporter:/assignee:/reviewer:me,none,<email>  date|created|updated >=-7d | >=-30d | :this-month | >=from <=to
// Tokens the panel cannot show (negations, partial values, other fields, free text) are kept verbatim in `rest`.
// No q param at all → DEFAULT_Q (last 7 days); an explicit empty `q=` is "any time" and stays empty.
import { tokenize, valueGroups, PEOPLE_KEYS } from './query.js';
import { ENUMS, enumValue } from './i18n.js';

export const ENUM_KEYS = ['status', 'cat', 'sens', 'type'];
export const PANEL_PEOPLE = PEOPLE_KEYS;
export const DATE_FIELDS = ['date', 'created', 'updated'];
export const DATE_PRESETS = { '7d': '-7d', '30d': '-30d' };
const PREFIX = { status: 's', cat: 'cat', sens: 'sens', type: 'type', tag: 'tag', reporter: 'reporter', assignee: 'assignee', reviewer: 'reviewer' };
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Quote a value when it holds characters the query grammar would split on; quotes inside are dropped. */
export function quoteVal(v) {
  const s = String(v ?? '').replace(/"/g, '').trim();
  return /[\s,+]/.test(s) || s === '' ? `"${s}"` : s;
}
/** Canonical spelling of a stored enum value in a query: its slug when it has one (ASCII, exact), else the value. */
const emitEnum = (kind, stored) => (kind === 'type' ? stored : ENUMS[kind]?.[stored] || stored);

export const emptyPanel = () => ({
  status: [], cat: [], sens: [], type: [], tag: [], tagMode: 'any', reporter: [], assignee: [], reviewer: [],
  dateField: 'date', datePreset: '', from: '', to: '', rest: '',
});

/** Panel state of a query. Enum values come back as stored values, people lower-cased (me / none / email). */
export function panelFromQuery(q = '') {
  const st = emptyPanel();
  const rest = [];
  const seen = new Set();
  for (const tok of tokenize(q)) {
    if (!tok.key || tok.neg || !takeToken(st, tok, seen)) rest.push(tok.raw);
  }
  st.rest = rest.join(' ');
  return st;
}
function takeToken(st, tok, seen) {
  const { key, op } = tok;
  const isDate = DATE_FIELDS.includes(key) || key === 'after' || key === 'before';
  if (!isDate && op !== ':') return false;
  if (ENUM_KEYS.includes(key)) {
    if (seen.has(key)) return false;
    const groups = valueGroups(tok.value, key);
    const vals = groups.map((g) => (key === 'type' ? g[0].toLowerCase() : enumValue(key, g[0])));
    if (!vals.length || vals.some((v) => !v)) return false;
    st[key] = [...new Set(vals)];
    seen.add(key);
    return true;
  }
  if (PANEL_PEOPLE.includes(key)) {
    if (seen.has(key)) return false;
    const vals = valueGroups(tok.value, key).map((g) => g[0].toLowerCase());
    if (!vals.length || vals.some((v) => v !== 'me' && v !== 'none' && !/^[^\s@<>]+@[^\s@<>]+$/.test(v))) return false;
    st[key] = [...new Set(vals)];
    seen.add(key);
    return true;
  }
  if (key === 'tag') {
    const groups = valueGroups(tok.value, 'tag');
    if (!groups.length) return false;
    if (!st.tag.length) {
      if (groups.length === 1) { st.tag = [...groups[0]]; st.tagMode = groups[0].length > 1 ? 'all' : 'any'; return true; }
      if (groups.every((g) => g.length === 1)) { st.tag = groups.map((g) => g[0]); st.tagMode = 'any'; return true; }
      return false;
    }
    // a further single tag token ANDs with the first: representable while the panel holds an all-list (or one tag)
    if (groups.length === 1 && (st.tagMode === 'all' || st.tag.length === 1)) {
      st.tag.push(...groups[0].filter((x) => !st.tag.includes(x)));
      st.tagMode = 'all';
      return true;
    }
    return false;
  }
  if (isDate) return takeDate(st, tok);
  return false;
}
function takeDate(st, tok) {
  let { key, op } = tok;
  const v = tok.value.replace(/"/g, '').toLowerCase();
  if (key === 'after') { key = 'date'; op = '>='; }
  if (key === 'before') { key = 'date'; op = '<='; }
  const fresh = !st.datePreset && !st.from && !st.to;
  if (!fresh && st.dateField !== key) return false;
  if (op === '>=' && (v === '-7d' || v === '-30d')) {
    if (!fresh) return false;
    Object.assign(st, { dateField: key, datePreset: v === '-7d' ? '7d' : '30d' });
    return true;
  }
  if (op === ':' && (v === 'this-month' || v === 'thismonth')) {
    if (!fresh) return false;
    Object.assign(st, { dateField: key, datePreset: 'month' });
    return true;
  }
  if (!ISO_DAY.test(v) || (st.datePreset && st.datePreset !== 'custom')) return false;
  if (op === '>=' && !st.from) { Object.assign(st, { dateField: key, datePreset: 'custom', from: v }); return true; }
  if (op === '<=' && !st.to) { Object.assign(st, { dateField: key, datePreset: 'custom', to: v }); return true; }
  return false;
}
/** Canonical query of a panel state: panel tokens first (fixed order), then `rest` unchanged. */
export function queryFromPanel(st) {
  const out = [];
  for (const k of ENUM_KEYS) if (st[k]?.length) out.push(`${PREFIX[k]}:${st[k].map((v) => quoteVal(emitEnum(k, v))).join(',')}`);
  if (st.tag?.length) out.push(`tag:${st.tag.map(quoteVal).join(st.tagMode === 'all' ? '+' : ',')}`);
  for (const k of PANEL_PEOPLE) if (st[k]?.length) out.push(`${PREFIX[k]}:${st[k].map(quoteVal).join(',')}`);
  const f = DATE_FIELDS.includes(st.dateField) ? st.dateField : 'date';
  if (DATE_PRESETS[st.datePreset]) out.push(`${f}>=${DATE_PRESETS[st.datePreset]}`);
  else if (st.datePreset === 'month') out.push(`${f}:this-month`);
  else {
    if (ISO_DAY.test(st.from || '')) out.push(`${f}>=${st.from}`);
    if (ISO_DAY.test(st.to || '')) out.push(`${f}<=${st.to}`);
  }
  if (st.rest?.trim()) out.push(st.rest.trim());
  return out.join(' ');
}
/** Number of panel fields with a value (shown on the collapsed panel). */
export const panelCount = (st) => [...ENUM_KEYS, 'tag', ...PANEL_PEOPLE].filter((k) => st[k]?.length).length
  + (st.datePreset || st.from || st.to ? 1 : 0);

// ---------- simple search row: time presets, default query ----------
/**
 * #/list opened without a q param at all gets this query (history.replaceState). An explicit empty `q=` means
 * "any time / no filter" and is kept as such, so the default is not applied again.
 */
export const DEFAULT_Q = 'updated>=-7d';
/** Time select of the simple row → the date token it writes ('' = no date condition). */
export const TIME_PRESETS = { '7d': 'updated>=-7d', '30d': 'updated>=-30d', month: 'updated:this-month', any: '' };
export const TIME_OPTIONS = ['7d', '30d', 'month', 'any'];
const isDateTok = (tok) => Boolean(tok.key) && (DATE_FIELDS.includes(tok.key) || tok.key === 'after' || tok.key === 'before');
/**
 * The time option a query shows in the simple row: '7d' | '30d' | 'month' (one `updated` preset and no other date
 * condition), 'any' (no date condition at all) or 'custom' (any other date condition, left untouched).
 */
export function timeOfQuery(q = '') {
  const st = panelFromQuery(q);
  const inRest = tokenize(st.rest).some(isDateTok);
  if (!st.datePreset && !st.from && !st.to) return inRest ? 'custom' : 'any';
  if (!inRest && st.dateField === 'updated' && ['7d', '30d', 'month'].includes(st.datePreset)) return st.datePreset;
  return 'custom';
}
/** `q` with every date condition (panel or free text, negated too) replaced by the preset's token; the rest is kept. */
export function withTime(q = '', preset = 'any') {
  const st = panelFromQuery(q);
  Object.assign(st, { dateField: 'updated', datePreset: TIME_PRESETS[preset] ? preset : '', from: '', to: '' });
  st.rest = tokenize(st.rest).filter((tok) => !isDateTok(tok)).map((tok) => tok.raw).join(' ');
  return queryFromPanel(st);
}
/** `q` with its free text (the panel's `rest`) replaced by `text`; panel tokens stay. */
export function withKeywords(q = '', text = '') {
  const st = panelFromQuery(q);
  st.rest = String(text ?? '').trim();
  return queryFromPanel(st);
}
/** List params with the default query added, or null when the URL already says what it wants (q present, even empty). */
export function withDefaultQuery(params) {
  const sp = new URLSearchParams(params);
  if (sp.has('q')) return null;
  sp.set('q', DEFAULT_Q);
  return sp;
}

// ---------- query size ----------
/** Longest search text the list view works with (saved filters are capped at 1000 server-side; a crafted link is not). */
export const Q_MAX = 2000;
/** `q` cut to Q_MAX at the last space before the limit → { q, cut }. */
export function capQuery(q = '') {
  if (q.length <= Q_MAX) return { q, cut: false };
  const head = q.slice(0, Q_MAX);
  const sp = head.lastIndexOf(' ');
  return { q: (sp > 0 ? head.slice(0, sp) : head).trimEnd(), cut: true };
}

/** Add or remove one tag in a query (the tag chips in the list rows); keeps the any / all mode and everything else. */
export function toggleTag(q, tag) {
  const st = panelFromQuery(q);
  const has = st.tag.some((x) => x.toLowerCase() === String(tag).toLowerCase());
  st.tag = has ? st.tag.filter((x) => x.toLowerCase() !== String(tag).toLowerCase()) : [...st.tag, tag];
  return queryFromPanel(st);
}
export const hasTag = (q, tag) => panelFromQuery(q).tag.some((x) => x.toLowerCase() === String(tag).toLowerCase());

// ---------- legacy URL params ----------
const LEGACY = { c: 'cat', s: 's', sv: 'sens', ty: 'type', k: 'tag' };
/**
 * Old list URLs (?c=&s=&sv=&ty=&k=…&sort=x&dir=y) → URLSearchParams with those folded into q= and sort=x:y.
 * Returns null when there is nothing to translate. Repeated k= stay separate tag tokens (AND, as before).
 */
export function translateLegacy(params) {
  const sp = new URLSearchParams(params);
  const legacyKeys = Object.keys(LEGACY).filter((k) => sp.has(k));
  const oldDir = sp.has('dir');
  if (!legacyKeys.length && !oldDir) return null;
  const tokens = [];
  for (const k of Object.keys(LEGACY)) {
    for (const v of sp.getAll(k)) {
      if (!v) continue;
      const kind = { c: 'cat', s: 'status', sv: 'sens' }[k];
      tokens.push(`${LEGACY[k]}:${quoteVal(kind ? emitEnum(kind, v) : v)}`);
    }
    sp.delete(k);
  }
  if (tokens.length) {
    const q = [sp.get('q') || '', ...tokens].filter(Boolean).join(' ');
    sp.set('q', q);
  }
  if (oldDir) {
    const key = sp.get('sort');
    const dir = sp.get('dir') === 'asc' ? 'asc' : 'desc';
    if (key && !key.includes(':')) sp.set('sort', `${key}:${dir}`);
    sp.delete('dir');
  }
  sp.delete('page');
  return sp;
}

// ---------- sorting ----------
export const SORT_KEYS = ['id', 'date', 'created', 'updated', 'title', 'project', 'category', 'status', 'sens', 'score', 'reporter', 'assignee', 'reviewer', 'type'];
const ASC_KEYS = ['title', 'project', 'category', 'reporter', 'assignee', 'reviewer', 'type'];
export const defaultDir = (key) => (ASC_KEYS.includes(key) ? 'asc' : 'desc');
/** `status:asc,date:desc` → [{ key, dir }] (at most two, known keys, no repeats); empty → [fallback, default dir]. */
export function parseSort(str, fallback = 'date') {
  const out = [];
  for (const part of String(str || '').split(',')) {
    const [key, d] = part.trim().split(':');
    if (!SORT_KEYS.includes(key) || out.some((s) => s.key === key)) continue;
    out.push({ key, dir: d === 'asc' || d === 'desc' ? d : defaultDir(key) });
    if (out.length === 2) break;
  }
  return out.length ? out : [{ key: fallback, dir: defaultDir(fallback) }];
}
export const sortString = (spec) => spec.map((s) => `${s.key}:${s.dir}`).join(',');
const flip = (d) => (d === 'asc' ? 'desc' : 'asc');
/**
 * Header click. Plain: sort by `key` (again → flip it, the secondary stays). Shift: the primary flips when it is `key`;
 * otherwise `key` becomes the secondary sort, a second Shift+click flips it and a third removes it.
 */
export function clickSort(spec, key, shift = false) {
  const [a, b] = spec;
  if (a?.key === key) return [{ key, dir: flip(a.dir) }, ...(b ? [b] : [])];
  if (!shift) return [{ key, dir: defaultDir(key) }];
  if (b?.key === key) return b.dir === defaultDir(key) ? [a, { key, dir: flip(b.dir) }] : [a];
  return [a, { key, dir: defaultDir(key) }];
}
/** Comparator over `spec` given key functions { key: (row) => number | string }. */
export function sortComparator(spec, keys, locale = 'zh-Hant') {
  const fns = spec.map((s) => ({ fn: keys[s.key] || keys.date, sign: s.dir === 'asc' ? 1 : -1 }));
  return (x, y) => {
    for (const { fn, sign } of fns) {
      const a = fn(x), b = fn(y);
      const c = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), locale);
      if (c) return c * sign;
    }
    return 0;
  };
}

// ---------- paging ----------
export const PER_OPTIONS = [25, 50, 100, 0]; // 0 = all
export const DEFAULT_PER = 50;
/** per= value (or the saved preference) → 25 / 50 / 100 / 0 (all). */
export function parsePer(v, pref) {
  for (const x of [v, pref]) {
    if (x === undefined || x === null || x === '') continue;
    if (x === 'all' || Number(x) === 0) return 0;
    if (PER_OPTIONS.includes(Number(x))) return Number(x);
  }
  return DEFAULT_PER;
}
export const perParam = (per) => (per === 0 ? 'all' : String(per));
/** { page, pages, start, end } for n rows (page is clamped to 1…pages; per 0 = everything on one page). */
export function paginate(n, page, per) {
  const pages = per > 0 ? Math.max(1, Math.ceil(n / per)) : 1;
  const p = Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages);
  const start = per > 0 ? (p - 1) * per : 0;
  return { page: p, pages, start, end: per > 0 ? Math.min(n, start + per) : n };
}
/** Page numbers to show: first, last, current ±1, with '…' for gaps — e.g. [1, '…', 4, 5, 6, '…', 10]. */
export function pageList(page, pages) {
  const want = new Set([1, pages, page - 1, page, page + 1].filter((x) => x >= 1 && x <= pages));
  const nums = [...want].sort((a, b) => a - b);
  const out = [];
  nums.forEach((x, i) => {
    if (i && x - nums[i - 1] === 2) out.push(x - 1);
    else if (i && x - nums[i - 1] > 2) out.push('…');
    out.push(x);
  });
  return out;
}
