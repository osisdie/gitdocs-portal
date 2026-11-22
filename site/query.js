// Shared query language for the portal search box and the `npm run doc -- ls` CLI.
// Pure ES module, no DOM / Node APIs, so the browser (app.js) and Node (scripts/) import the same file.
//
//   free terms (AND)      api 成本
//   "quoted phrase"       "release notes"
//   exclude               -封存  -"draft copy"  -status:封存
//   fields                project:/p:  sub:  cat:/c:  status:/s:  sens:  tag:/k:  type:  id:
//   people                reporter:/rep:  assignee:/asg:/a:  reviewer:/rev:
//                         value = an email, @domain, part of a display name (case-insensitive), me, none (unset)
//                         `me` needs a current user: matchDoc(doc, q, body, { me, name }); the CLI uses git user.email
//   any of (OR)           s:open,in-review  cat:plan,audit  assignee:me,none  — commas inside one field
//                         repeating a field keeps AND: tag:a tag:b
//   all tags              tag:a+b  (= tag:a tag:b); tag:a+b,c = (a and b) or c; quote a value to keep , and + literal
//   dates                 date:2026-11  date>=2026-11-01  date<=2026-11-30  after:2026-11-15  before:2026-11-20
//                         created… / updated… take the same operators (created>=-7d  updated:2026-11)
//                         created = `created` field, else the oldest commit in `history` (last 20), else date
//                         updated = the newest of server updated_at and the last commit, else date
//   relative dates        after:-30d  date>=-2w  (d / w / m); today, this-month, this-year
//   sensitivity range     sens>=機密  sens<=內部
//   English aliases       enum values can also be written as their slug or English label (site/i18n.js ENUMS):
//                         s:open|in-review|confirmed|published|archived  sens:public|internal|confidential|secret
//                         sens>=confidential  cat:plan|evaluation|comparison|audit|design-ux|form|api|playbook|…
//                         a value that names an enum value matches it exactly; anything else is a partial match

import { tl, enumValue, enumNames } from './i18n.js';

export const SENSITIVITIES = ['公開', '內部', '機密', '極機密'];
export const sensRank = (s) => { const i = SENSITIVITIES.indexOf(s); return i < 0 ? 1 : i; };

const FIELD_ALIASES = {
  project: 'project', p: 'project', proj: 'project',
  sub: 'sub', subproject: 'sub',
  cat: 'cat', c: 'cat', category: 'cat',
  status: 'status', s: 'status',
  sens: 'sens', sensitivity: 'sens',
  tag: 'tag', tags: 'tag', k: 'tag', kw: 'tag', keyword: 'tag',
  type: 'type', ext: 'type',
  id: 'id',
  reporter: 'reporter', rep: 'reporter',
  assignee: 'assignee', asg: 'assignee', a: 'assignee',
  reviewer: 'reviewer', rev: 'reviewer',
  date: 'date', before: 'before', after: 'after',
  created: 'created', updated: 'updated',
};
export const PEOPLE_KEYS = ['reporter', 'assignee', 'reviewer'];
export const DATE_KEYS = ['date', 'before', 'after', 'created', 'updated'];

// Help rows ([example, explanation]) in a UI language; the messages live in the i18n catalogs (qhelp.<n>.k / .v).
const HELP_ROWS = 16;
export const queryHelp = (lang = 'en') => Array.from({ length: HELP_ROWS }, (_, i) => [tl(lang, `qhelp.${i + 1}.k`), tl(lang, `qhelp.${i + 1}.v`)]);
// Kept for the CLI (scripts/doc.mjs prints it under its Chinese usage text).
export const QUERY_HELP = queryHelp('zh-TW');

const ymd = (d) => d.toISOString().slice(0, 10);
/** Relative date value → absolute: -7d / -2w / -3m, today, this-month (YYYY-MM), this-year (YYYY). Others unchanged. */
export function resolveDate(v, today = new Date()) {
  const d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const w = String(v).toLowerCase();
  if (w === 'today') return ymd(d);
  if (w === 'this-month' || w === 'thismonth') return ymd(d).slice(0, 7);
  if (w === 'this-year' || w === 'thisyear') return ymd(d).slice(0, 4);
  const m = /^-(\d+)([dwm])$/.exec(w);
  if (!m) return v;
  const n = +m[1];
  if (m[2] === 'd') d.setUTCDate(d.getUTCDate() - n);
  else if (m[2] === 'w') d.setUTCDate(d.getUTCDate() - n * 7);
  else d.setUTCMonth(d.getUTCMonth() - n);
  return ymd(d);
}

/** Split on `sep` outside double quotes (quotes are kept). */
function splitOutside(s, sep) {
  const out = [];
  let cur = '', quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (ch === sep && !quoted) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
const unquote = (s) => s.replace(/"/g, '').trim();
/**
 * A field value → OR-list of AND-groups. Commas separate alternatives; for tags `+` joins tags that must all be
 * present. A part that would be empty (c++) keeps the text literal; quoted text is never split.
 */
export function valueGroups(rawValue, key) {
  return splitOutside(rawValue, ',').map((item) => {
    if (key === 'tag') {
      const parts = splitOutside(item, '+');
      if (parts.length > 1 && parts.every((x) => unquote(x))) return parts.map(unquote);
    }
    return [unquote(item)];
  }).filter((g) => g[0] !== '');
}

/**
 * Split a query into tokens, keeping each token's source text:
 * { raw, neg, key, op, value } for a known field (value = raw value text, quotes included), else { raw, neg, text }.
 */
export function tokenize(input = '') {
  const out = [];
  const re = /(-?)(?:([A-Za-z]+)(>=|<=|:|>|<|=)((?:"[^"]*"|[^\s"])+)|"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(input))) {
    const neg = m[1] === '-';
    const key = m[2] && FIELD_ALIASES[m[2].toLowerCase()];
    if (key) { out.push({ raw: m[0], neg, key, op: m[3] === '=' ? ':' : m[3], value: m[4] }); continue; }
    const text = (m[5] !== undefined ? m[5] : m[2] ? `${m[2]}${m[3]}${m[4]}` : m[6] || '').trim();
    if (!text || text === '-') continue;
    out.push({ raw: m[0], neg, text });
  }
  return out;
}

/**
 * Parse a query string into { terms, not, fields }. Unknown `foo:bar` tokens stay free-text terms.
 * A field is { key, op, value, values, groups, neg }: `values` are the comma alternatives, `groups` the same with
 * tag `+` groups split out; dates are resolved to absolute values.
 */
export function parseQuery(input = '', today) {
  const q = { terms: [], not: [], fields: [] };
  for (const tok of tokenize(input)) {
    if (!tok.key) { (tok.neg ? q.not : q.terms).push(tok.text.toLowerCase()); continue; }
    const { key, op, neg } = tok;
    if (DATE_KEYS.includes(key)) {
      const value = resolveDate(unquote(tok.value), today);
      if (value !== '') q.fields.push({ key, op, value, values: [value], groups: [[value]], neg });
      continue;
    }
    const groups = valueGroups(tok.value, key);
    if (!groups.length) continue;
    const values = groups.map((g) => g.join('+'));
    q.fields.push({ key, op, value: values.join(','), values, groups, neg });
  }
  return q;
}

export const needsBody = (q) => q.terms.length > 0 || q.not.length > 0;
/** True when the query has a people field with the value `me` (callers without a current user can refuse it). */
export const usesMe = (q) => q.fields.some((f) => PEOPLE_KEYS.includes(f.key) && f.values.some((v) => v.toLowerCase() === 'me'));
export const usesHistory = (q) => q.fields.some((f) => f.key === 'created' || f.key === 'updated');

const lc = (s) => String(s ?? '').toLowerCase();
const cmp = (a, op, b) => (op === '>=' ? a >= b : op === '<=' ? a <= b : op === '>' ? a > b : op === '<' ? a < b : a === b);
const day = (s) => String(s || '').slice(0, 10);

/** First known date of a doc (YYYY-MM-DD): `created`, else its oldest listed commit, else its date. */
export const docCreated = (doc) => day(doc.created) || day(doc.history?.length ? doc.history[doc.history.length - 1].date : '') || day(doc.date);
/** Last change (YYYY-MM-DD): the newer of the server's updated_at and the last commit, else the doc date. */
export function docUpdated(doc) {
  const a = day(doc.updated_at), b = day(doc.history?.[0]?.date);
  return (a > b ? a : b) || day(doc.date);
}

/** A stored enum value against one query item: exact when the item names an enum value, else a partial match. */
function enumMatch(kind, stored, item) {
  const want = enumValue(kind, item);
  if (want) return stored === want;
  const v = lc(item);
  return enumNames(kind, stored).some((n) => n.includes(v));
}
/** A person field (email or '') against one item: me / none / email / @domain / part of the display name. */
function personMatch(email, item, ctx) {
  const v = lc(item).trim();
  if (v === 'none') return !email;
  if (!email) return false;
  const e = lc(email).trim();
  if (v === 'me') return Boolean(ctx.me) && e === lc(ctx.me).trim();
  if (v.includes('@')) return v.startsWith('@') ? e.endsWith(v) : e === v;
  const name = lc(ctx.name ? ctx.name(email) : '');
  return name.includes(v) || e.split('@')[0].includes(v);
}
function dateMatch(value, op, want) {
  return op === ':' ? value.startsWith(want) : cmp(value, op, want);
}

function fieldMatch(doc, f, ctx) {
  const any = (fn) => f.values.some(fn);
  switch (f.key) {
    case 'project': return any((x) => { const v = lc(x); return v.includes('/') ? lc(`${doc.project}/${doc.subproject || ''}`) === v : lc(doc.project) === v; });
    case 'sub': return any((x) => lc(doc.subproject) === lc(x));
    case 'cat': return any((x) => enumMatch('cat', doc.category, x));
    case 'status': return any((x) => enumMatch('status', doc.status, x));
    case 'sens': return any((x) => {
      const want = enumValue('sens', x) || x;
      if (f.op === ':') return doc.sensitivity === want;
      return SENSITIVITIES.includes(want) && cmp(sensRank(doc.sensitivity), f.op, sensRank(want));
    });
    case 'tag': {
      const have = new Set([...(doc.tags || []), ...(doc.keywords || [])].map(lc));
      return f.groups.some((g) => g.every((x) => have.has(lc(x))));
    }
    case 'type': return any((x) => lc(doc.type) === lc(x));
    case 'id': return any((x) => Number(doc.id) === Number(x.replace(/^#/, '')));
    case 'reporter': case 'assignee': case 'reviewer': return any((x) => personMatch(doc[f.key] || '', x, ctx));
    case 'date': return dateMatch(day(doc.date), f.op, f.value);
    case 'created': return dateMatch(docCreated(doc), f.op, f.value);
    case 'updated': return dateMatch(docUpdated(doc), f.op, f.value);
    case 'after': return day(doc.date) >= f.value;
    case 'before': return day(doc.date) <= f.value;
    default: return true;
  }
}

/**
 * Test a doc against a parsed query. `body` is the doc's plain text ('' when not loaded or withheld).
 * `ctx` = { me: current user's email (for `me`), name: email → display name (for name matches) }.
 * Returns null on no match, else { score, snip } (snip = body excerpt around the first body hit).
 */
export function matchDoc(doc, q, body = '', ctx = {}) {
  for (const f of q.fields) if (fieldMatch(doc, f, ctx) === f.neg) return null;
  const title = lc(doc.title);
  const meta = lc(`${doc.desc} ${doc.project} ${doc.subproject || ''} ${doc.category} ${doc.status} ${doc.sensitivity} ${(doc.tags || []).join(' ')} ${(doc.keywords || []).join(' ')} ${doc.path} ${String(doc.id).padStart(7, '0')}`);
  const bodyLc = lc(body);
  for (const t of q.not) if (title.includes(t) || meta.includes(t) || bodyLc.includes(t)) return null;
  let score = 0, firstHit = -1;
  for (const t of q.terms) {
    const inTitle = title.includes(t), inMeta = meta.includes(t), bi = bodyLc.indexOf(t);
    if (!inTitle && !inMeta && bi < 0) return null;
    score += (inTitle ? 10 : 0) + (inMeta ? 4 : 0) + (bi >= 0 ? 1 : 0);
    if (bi >= 0 && (firstHit < 0 || bi < firstHit)) firstHit = bi;
  }
  let snip = '';
  if (firstHit >= 0) {
    const a = Math.max(0, firstHit - 50);
    snip = (a > 0 ? '…' : '') + body.slice(a, firstHit + 90) + '…';
  }
  return { score, snip };
}
