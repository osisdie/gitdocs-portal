// Shared catalog logic for scripts/build.mjs, scripts/doc.mjs and scripts/vault.mjs.
// docs/catalog.json is the only hand-edited metadata file; everything else is derived from the files on disk.
//
// Engine vs. content: ROOT is this engine checkout (site/, scripts/, dist/). CONTENT is the folder that holds
// docs/ (+ vault/). It is $CONTENT_DIR when set, else ROOT when ROOT/docs exists (a content repo that vendors
// the engine), else ROOT/examples (the engine repo's own demo content).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SENSITIVITIES, sensRank } from '../../site/query.js';
import { refsIn } from '../../site/vault-core.js';

export { SENSITIVITIES, sensRank };
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const CONTENT = process.env.CONTENT_DIR ? path.resolve(process.env.CONTENT_DIR)
  : fs.existsSync(path.join(ROOT, 'docs')) ? ROOT : path.join(ROOT, 'examples');
export const DOCS = path.join(CONTENT, 'docs');
export const CATALOG = path.join(DOCS, 'catalog.json');
export const VAULT_FILE = path.join(CONTENT, 'vault', 'vault.json');
const EXTS = new Set(['.html', '.md', '.sh', '.json']);
const isPostman = (name) => /\.postman_(collection|environment)\.json$/i.test(name);

export const CATEGORIES = ['計畫', '評估', '比較', '稽核', '設計／UX', '表單', 'API', '技能手冊', '劇本／文案', '腳本', '索引', '報告'];
export const STATUSES = ['草稿', '審查中', '本機', '已發布', '封存'];
/** Fields the README index can overwrite; changing one by hand locks the entry. */
export const README_FIELDS = ['title', 'desc', 'url', 'date'];

// Keyword registry seed: { Keyword: [alias regex, ...] } — case-insensitive. Use \b only around Latin words.
export const DEFAULT_KEYWORDS = {
  'API': ['\bapi\b', 'postman', 'openapi', 'swagger'],
  'CI': ['\bci\b', 'github actions', 'gitlab ci'],
  '測試': ['測試', '\btests?\b', '\bcoverage\b'],
  '成本': ['成本', '\bcosts?\b', '\bpricing\b'],
  '登入／OAuth': ['\boauth\b', '登入', '\bsso\b'],
  'UX': ['\bux\b', '\bmockups?\b'],
  'GDPR／隱私': ['\bgdpr\b', '隱私', '個資'],
  'Prompt': ['\bprompts?\b'],
};

export const DEFAULT_FILTERS = [
  { name: '最近 30 天', query: 'after:-30d' },
  { name: '已發布', query: 's:已發布' },
  { name: '機密以上', query: 'sens>=機密' },
  { name: '計畫', query: 'cat:計畫' },
];

/** Instance settings kept in catalog.json → "site". All optional. */
export const DEFAULT_SITE = {
  title: 'gitdocs portal',  // portal name (header + <title>)
  projectRoot: '',          // folder under docs/ whose children are projects ('' = docs/ itself)
  readmeIndex: '',          // markdown index table that overrides title/desc/url/date, relative to docs/
};

// ---------- text helpers ----------
export function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (EXTS.has(path.extname(e.name)) && !e.name.includes(':') && p !== CATALOG) out.push(p);
  }
  return out;
}

const decode = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

const stripDataUris = (s) => s.replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+/g, ' ');

function htmlToText(html) {
  return decode(stripDataUris(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(style|script|svg|template|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

// README index table: | date | [title](path) | repo | url | desc |   (paths relative to the README's folder)
export function readReadmeIndex(site = DEFAULT_SITE) {
  const map = {};
  if (!site.readmeIndex) return map;
  const f = path.join(DOCS, site.readmeIndex);
  const dir = path.posix.join('docs', path.posix.dirname(site.readmeIndex));
  if (!fs.existsSync(f)) return map;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*(.*)\|\s*$/);
    if (!m) continue;
    const rel = path.posix.join(dir, m[3].trim());
    const url = (m[5].match(/https?:\/\/\S+/) || [''])[0];
    map[rel] = { date: m[1], title: m[2].trim(), url, desc: m[6].trim() };
  }
  return map;
}

function git(args) {
  try { return execFileSync('git', args, { cwd: CONTENT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

function gitDate(rel) {
  const out = git(['log', '--diff-filter=A', '--format=%cs', '--', rel]).split('\n').pop();
  return out || fs.statSync(path.join(CONTENT, rel)).mtime.toISOString().slice(0, 10);
}

/** Up to `cap` commits touching the file (newest first); [] when not in git. */
export function gitHistory(rel, cap = 20) {
  const out = git(['log', '--follow', `-n${cap}`, '--format=%cs%x09%h%x09%s', '--', rel]);
  return out ? out.split('\n').map((l) => { const [date, hash, ...s] = l.split('\t'); return { date, hash, subject: s.join('\t') }; }) : [];
}

// ---------- inference ----------
export function inferCategory(rel, title, desc) {
  const name = path.basename(rel).toLowerCase();
  const hay = `${name} ${title} ${desc}`.toLowerCase();
  if (name.endsWith('.sh')) return '腳本';
  if (isPostman(name) || /openapi|swagger/.test(name)) return 'API';
  if (name.endsWith('.skill.md')) return '技能手冊';
  if (/script/.test(name) && name.endsWith('.md')) return '劇本／文案';
  if (/^(readme|token-ledger)\.md$/.test(name)) return '索引';
  if (/(^|-)form(-|\.)|表單/.test(name + title)) return '表單';
  if (/audit|稽核/.test(hay)) return '稽核';
  if (/(^|-)plan(-|\.)|計畫/.test(name + title)) return '計畫';
  if (/\bux\b|-ux|mockup|提案|對齊|align/.test(name + title)) return '設計／UX';
  if (/compare|-vs-|比較/.test(name + title)) return '比較';
  if (/評估|evaluation|analysis|分析|cost|成本|sources/.test(hay)) return '評估';
  return '報告';
}

const SECRET_PATTERNS = [
  ['credential assignment', /\b(api[_-]?key|secret|access[_-]?token|auth[_-]?token|passw(?:or)?d|private[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+.=]{16,}/i],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
// Ignore placeholders, image file names and role mailboxes (support@, affiliate@, *service@ …): those are public contacts, not PII.
const EMAIL_IGNORE = /noreply|no-reply|@example\.|\.(png|jpe?g|gif|webp|svg|avif)$|^([a-z0-9]*(service|support)|info|contact|hello|help|cs|sales|affiliate|marketing|press|media|partners?|business|admin|team|office|hr|jobs|careers|billing|privacy|legal|security|abuse|postmaster|webmaster|feedback|apple|name|user|you|someone|yourname)@/i;
const PII_PATTERNS = [
  ['phone (intl)', /(?<![\w/.-])\+\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,3}(?![\w-])/],
  ['TW mobile', /(?<!\d)09\d{2}[-\s]?\d{3}[-\s]?\d{3}(?!\d)/],
  ['registry code', /(登記編號|registry code|registration (?:no|number)|統一編號|統編)[\s:：]*\d{6,}/i],
  ['D-U-N-S', /(D-?U-?N-?S)[^\d\n]{0,12}\d{2}-?\d{3}-?\d{4}/i],
  ['VAT number', /\bVAT\b[^A-Z\n]{0,12}[A-Z]{2}\d{8,12}\b/],
  ['IBAN', /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/],
  ['TW national ID', /(?<![A-Za-z0-9])[A-Z][12]\d{8}(?!\d)/],
  ['street address', /\b[A-ZÄÖÜÕ][a-zäöüõ]+ (tn|pst|mnt|street|st\.|road|rd\.|avenue|ave\.)\s*\d+|[路街巷弄]\s*\d+\s*號/],
];

/** Returns { level, reasons } from raw file content. */
export function inferSensitivity(raw) {
  const text = stripDataUris(raw);
  const reasons = [];
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) reasons.push(name);
  if (reasons.length) return { level: '極機密', reasons };
  const emails = (text.match(EMAIL_RE) || []).filter((e) => !EMAIL_IGNORE.test(e));
  if (emails.length) reasons.push(`email ×${new Set(emails).size}`);
  for (const [name, re] of PII_PATTERNS) if (re.test(text)) reasons.push(name);
  return { level: reasons.length ? '機密' : '內部', reasons };
}

export function compileKeywords(registry) {
  return Object.entries(registry).map(([kw, aliases]) => [kw, aliases.map((a) => new RegExp(a, 'gi'))]);
}

/** Keyword applies on ≥1 hit in title/desc, or ≥2 hits in the body. */
export function computeKeywords(compiled, head, body) {
  const out = [];
  for (const [kw, res] of compiled) {
    let h = 0, b = 0;
    for (const re of res) { h += (head.match(re) || []).length; b += (body.match(re) || []).length; }
    if (h >= 1 || b >= 2) out.push(kw);
  }
  return out;
}

function extractMeta(rel, readme, site) {
  const abs = path.join(CONTENT, rel);
  const raw = fs.readFileSync(abs, 'utf8');
  const ext = path.extname(abs);
  const base = path.basename(abs, ext);
  const parts = rel.split('/');
  const rootDepth = site.projectRoot ? site.projectRoot.split('/').filter(Boolean).length : 0;
  const inRoot = rootDepth && parts.slice(1, 1 + rootDepth).join('/') === site.projectRoot.replace(/^\/|\/$/g, '');
  const under = parts.slice(inRoot ? 1 + rootDepth : 1); // path below docs/<projectRoot>
  const project = under.length > 1 ? under[0] : '（索引）';
  const subproject = under.length > 2 ? under[1] : '';
  const r = readme[rel] || {};
  let title = r.title, url = r.url || '', text;
  if (ext === '.html') {
    title ||= decode((raw.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim();
    const head = (raw.match(/^\s*<!--([\s\S]*?)-->/) || [])[1] || '';
    url ||= (head.match(/https?:\/\/[^\s<>"]+/) || [''])[0];
    text = htmlToText(raw);
  } else if (ext === '.md') {
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    const fmName = fm && (fm[1].match(/^name:\s*(.+)$/m) || [])[1];
    title ||= (raw.match(/^#\s+(.+)$/m) || [])[1] || fmName || base;
    text = raw.replace(/^---\n[\s\S]*?\n---/, '').replace(/[#*`>|_-]{1,}/g, ' ').replace(/\s+/g, ' ').trim();
  } else if (ext === '.json') {
    let j = {};
    try { j = JSON.parse(raw); } catch { /* not JSON: index as text */ }
    title ||= (j.info && j.info.name) || j.name || base;
    text = raw.replace(/\s+/g, ' ').trim();
  } else {
    title ||= base;
    text = raw.replace(/\s+/g, ' ').trim();
  }
  const dm = base.match(/^(\d{4}-\d{2}-\d{2})-/);
  const date = r.date || (dm && dm[1]) || gitDate(rel);
  const desc = r.desc || (ext === '.md' ? ((raw.match(/^description:\s*(.+)$/m) || [])[1] || '') : '');
  const sens = inferSensitivity(raw);
  return {
    inferred: {
      title: title || base, project, subproject, category: inferCategory(rel, title || '', desc),
      status: /^https?:\/\//.test(url) ? '已發布' : '本機',
      sensitivity: sens.level, date, url, desc,
    },
    sensReasons: sens.reasons,
    vaultRefs: refsIn(raw),
    text,
    size: Buffer.byteLength(raw),
    type: ext.slice(1),
  };
}

// ---------- catalog IO ----------
export function loadCatalog() {
  const c = fs.existsSync(CATALOG) ? JSON.parse(fs.readFileSync(CATALOG, 'utf8')) : {};
  c.site = { ...DEFAULT_SITE, ...(c.site || {}) };
  c.categories = [...new Set([...(c.categories || []), ...CATEGORIES])];
  c.statuses ||= STATUSES;
  c.sensitivities = SENSITIVITIES;
  c.projects ||= {};
  c.keywords ||= DEFAULT_KEYWORDS;
  c.filters ||= DEFAULT_FILTERS;
  c.docs ||= {};
  return c;
}

export function saveCatalog(c) {
  const ordered = {
    site: c.site,
    categories: c.categories, statuses: c.statuses, sensitivities: c.sensitivities,
    projects: Object.fromEntries(Object.entries(c.projects).sort(([a], [b]) => a.localeCompare(b))),
    filters: c.filters, keywords: c.keywords,
    docs: Object.fromEntries(Object.entries(c.docs).sort((a, b) => a[1].id - b[1].id)),
  };
  fs.writeFileSync(CATALOG, JSON.stringify(ordered, null, 2) + '\n');
}

export const findById = (c, id) => {
  const n = Number(String(id).replace(/^#/, ''));
  const hit = Object.entries(c.docs).find(([, d]) => d.id === n);
  return hit ? { rel: hit[0], entry: hit[1] } : null;
};

/**
 * Scan docs/, reconcile with the catalog (mutates it), and return per-doc records with derived data.
 * New files get an id + inferred metadata; existing entries keep manual edits, gain missing fields,
 * and are raised (never lowered) to a higher detected sensitivity unless `sensitivityReviewed` is set.
 */
export function syncCatalog(catalog) {
  const site = catalog.site || DEFAULT_SITE;
  const readme = readReadmeIndex(site);
  const compiled = compileKeywords(catalog.keywords);
  const files = walk(DOCS).map((a) => path.relative(CONTENT, a).split(path.sep).join('/')).sort();
  let nextId = Math.max(0, ...Object.values(catalog.docs).map((d) => d.id)) + 1;
  const added = [], raised = [], items = [];
  const metas = files.map((rel) => ({ rel, ...extractMeta(rel, readme, site) }))
    .sort((a, b) => a.inferred.date.localeCompare(b.inferred.date) || a.rel.localeCompare(b.rel));
  for (const m of metas) {
    let entry = catalog.docs[m.rel];
    if (!entry) {
      entry = catalog.docs[m.rel] = { id: nextId++, ...m.inferred, tags: [], related: [] };
      added.push(m.rel);
    }
    // schema migration: fill fields introduced after the entry was created
    for (const k of ['subproject', 'sensitivity']) if (entry[k] === undefined) entry[k] = m.inferred[k];
    entry.project = m.inferred.project;
    entry.subproject = m.inferred.subproject;
    if (!Array.isArray(entry.tags) || (entry.subproject && entry.tags.length === 1 && entry.tags[0] === entry.subproject)) entry.tags = [];
    entry.related ||= [];
    if (!entry.sensitivityReviewed && sensRank(m.inferred.sensitivity) > sensRank(entry.sensitivity)) {
      raised.push(`${m.rel}: ${entry.sensitivity} → ${m.inferred.sensitivity} (${m.sensReasons.join(', ')})`);
      entry.sensitivity = m.inferred.sensitivity;
    }
    // README is the source of truth for title/desc/url/date once it lists the doc, unless locked
    const r = readme[m.rel];
    if (r && !entry.locked) Object.assign(entry, { title: r.title, desc: r.desc, url: r.url || entry.url, date: r.date });
    if (!entry.locked && entry.url && entry.status === '本機' && /^https?:\/\//.test(entry.url)) entry.status = '已發布';
    // project registry
    if (!catalog.projects[entry.project]) catalog.projects[entry.project] = { title: entry.project, desc: '' };
    if (entry.subproject) {
      const key = `${entry.project}/${entry.subproject}`;
      if (!catalog.projects[key]) catalog.projects[key] = { title: entry.subproject, desc: '', parent: entry.project };
    }
    const keywords = computeKeywords(compiled, `${entry.title} ${entry.desc}`, m.text);
    items.push({ rel: m.rel, entry, text: m.text, keywords, size: m.size, type: m.type, sensReasons: m.sensReasons, vaultRefs: m.vaultRefs });
  }
  const missing = Object.keys(catalog.docs).filter((k) => !files.includes(k));
  for (const k of missing) delete catalog.docs[k];
  // drop auto-created registry entries whose folder no longer has docs (keep ones with a hand-written desc)
  const used = new Set(items.flatMap((it) => [it.entry.project, it.entry.subproject && `${it.entry.project}/${it.entry.subproject}`]));
  for (const [k, v] of Object.entries(catalog.projects)) if (!used.has(k) && !v.desc) delete catalog.projects[k];
  return { items, added, missing, raised };
}

/** Flat record used by the portal, the CLI and the query matcher. */
export const toRecord = (it) => ({ ...it.entry, keywords: it.keywords, path: it.rel, type: it.type, size: it.size, ...(it.vaultRefs?.length ? { vault: it.vaultRefs } : {}) });
