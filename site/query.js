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

export const QUERY_HELP = [
  ['api 成本', '多個詞＝全部都要出現（AND）'],
  ['"release notes"', '引號＝完整片語'],
  ['-封存', '減號＝排除；也可用在欄位：-status:封存'],
  ['p:handbook', '專案；p:handbook/onboarding 指定子專案（sub:onboarding 亦可）'],
  ['cat:評估', '分類（部分比對，cat:UX 可找到「設計／UX」）'],
  ['s:已發布', '狀態'],
  ['sens:機密  sens>=機密', '機敏性；可用 >= / <= 比較等級'],
  ['k:API', '關鍵字或標籤'],
  ['type:md', '格式 html / md / sh / json'],
  ['id:14', '編號'],
  ['date:2026-11', '日期前綴；date>=2026-11-01、date<=…'],
  ['after:-30d  before:2026-11-20', '之後／之前（含當天）；-30d、-2w、-3m 是相對今天'],
];

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
    case 'cat': return lc(doc.category).includes(v);
    case 'status': return lc(doc.status).includes(v);
    case 'sens':
      if (f.op === ':') return doc.sensitivity === f.value;
      return SENSITIVITIES.includes(f.value) && cmp(sensRank(doc.sensitivity), f.op, sensRank(f.value));
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
