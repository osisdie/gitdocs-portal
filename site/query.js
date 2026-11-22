// Shared query language for the portal search box and the `npm run doc -- ls` CLI.
// Pure ES module, no DOM / Node APIs, so the browser (app.js) and Node (scripts/) import the same file.
//
//   free terms (AND)      api 成本
//   "quoted phrase"       "release notes"
//   exclude               -封存  -"draft copy"  -status:封存
//   fields                project:/p:  sub:  cat:/c:  status:/s:  sens:  tag:/k:  type:  id:
//   dates                 date:2026-11  date>=2026-11-01  date<=2026-11-30  after:2026-11-15  before:2026-11-20
//   relative dates        after:-30d  date>=-2w  (d / w / m)
//   sensitivity range     sens>=機密  sens<=內部
//   English aliases       enum values can also be written as their slug or English label (site/i18n.js ENUMS):
//                         s:open|in-review|confirmed|published|archived  sens:public|internal|confidential|secret
//                         sens>=confidential  cat:plan|evaluation|comparison|audit|design-ux|form|api|playbook|…

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
  date: 'date', before: 'before', after: 'after',
};

// Help rows ([example, explanation]) in a UI language; the messages live in the i18n catalogs (qhelp.<n>.k / .v).
const HELP_ROWS = 12;
export const queryHelp = (lang = 'en') => Array.from({ length: HELP_ROWS }, (_, i) => [tl(lang, `qhelp.${i + 1}.k`), tl(lang, `qhelp.${i + 1}.v`)]);
// Kept for the CLI (scripts/doc.mjs prints it under its Chinese usage text).
export const QUERY_HELP = queryHelp('zh-TW');

function resolveDate(v, today = new Date()) {
  const m = /^-(\d+)([dwm])$/.exec(v);
  if (!m) return v;
  const d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const n = +m[1];
  if (m[2] === 'd') d.setUTCDate(d.getUTCDate() - n);
  else if (m[2] === 'w') d.setUTCDate(d.getUTCDate() - n * 7);
  else d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

/** Parse a query string into { terms, not, fields }. Unknown `foo:bar` tokens stay free-text terms. */
export function parseQuery(input = '', today) {
  const q = { terms: [], not: [], fields: [] };
  const re = /(-?)(?:([A-Za-z]+)(>=|<=|:|>|<|=)("([^"]*)"|[^\s"]+)|"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(input))) {
    const neg = m[1] === '-';
    if (m[2] && FIELD_ALIASES[m[2].toLowerCase()]) {
      const key = FIELD_ALIASES[m[2].toLowerCase()];
      let value = m[5] !== undefined ? m[5] : m[4];
      if (['date', 'before', 'after'].includes(key)) value = resolveDate(value, today);
      if (value !== '') q.fields.push({ key, op: m[3] === '=' ? ':' : m[3], value, neg });
      continue;
    }
    const text = (m[6] !== undefined ? m[6] : m[2] ? `${m[2]}${m[3]}${m[4]}` : m[7] || '').trim();
    if (!text || text === '-') continue;
    (neg ? q.not : q.terms).push(text.toLowerCase());
  }
  return q;
}

export const needsBody = (q) => q.terms.length > 0 || q.not.length > 0;

const lc = (s) => String(s ?? '').toLowerCase();
const cmp = (a, op, b) => (op === '>=' ? a >= b : op === '<=' ? a <= b : op === '>' ? a > b : op === '<' ? a < b : a === b);

function fieldMatch(doc, f) {
  const v = lc(f.value);
  switch (f.key) {
    case 'project':
      return v.includes('/') ? lc(`${doc.project}/${doc.subproject || ''}`) === v : lc(doc.project) === v;
    case 'sub': return lc(doc.subproject) === v;
    // partial match against the stored value, its slug and its English label (cat:UX, cat:eval, s:review)
    case 'cat': return enumNames('cat', doc.category).some((n) => n.includes(v));
    case 'status': return enumNames('status', doc.status).some((n) => n.includes(v));
    case 'sens': {
      const want = enumValue('sens', f.value) || f.value;
      if (f.op === ':') return doc.sensitivity === want;
      return SENSITIVITIES.includes(want) && cmp(sensRank(doc.sensitivity), f.op, sensRank(want));
    }
    case 'tag': return [...(doc.tags || []), ...(doc.keywords || [])].some((t) => lc(t) === v);
    case 'type': return lc(doc.type) === v;
    case 'id': return Number(doc.id) === Number(f.value.replace(/^#/, ''));
    case 'date': return f.op === ':' ? String(doc.date).startsWith(f.value) : cmp(String(doc.date), f.op, f.value);
    case 'after': return String(doc.date) >= f.value;
    case 'before': return String(doc.date) <= f.value;
    default: return true;
  }
}

/**
 * Test a doc against a parsed query. `body` is the doc's plain text ('' when not loaded or withheld).
 * Returns null on no match, else { score, snip } (snip = body excerpt around the first body hit).
 */
export function matchDoc(doc, q, body = '') {
  for (const f of q.fields) if (fieldMatch(doc, f) === f.neg) return null;
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
