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
import { enumValue } from '../../site/i18n.js';
import { refsIn, VAULT_RE } from '../../site/vault-core.js';

export { SENSITIVITIES, sensRank };
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
export const CONTENT = process.env.CONTENT_DIR ? path.resolve(process.env.CONTENT_DIR)
  : fs.existsSync(path.join(ROOT, 'docs')) ? ROOT : path.join(ROOT, 'examples');
export const DOCS = path.join(CONTENT, 'docs');
export const CATALOG = path.join(DOCS, 'catalog.json');
export const VAULT_FILE = path.join(CONTENT, 'vault', 'vault.json');
/** Web notes exported by `npm run state:pull` (docs/notes/<id>.md): kept in git, not documents, never deployed. */
export const NOTES_DIR = path.join(DOCS, 'notes');
/** Checkouts of external content sources (`npm run sources:pull`): <content>/.sources/<name>/. Never committed. */
export const SOURCES_DIR = path.join(CONTENT, '.sources');
const EXTS = new Set(['.html', '.md', '.sh', '.json']);

// Size limits (DESIGN.md → Configuration). Detection, keywords and search text read only the first SCAN_MAX_BYTES of
// a file, so a huge or hostile file costs bounded time; vault references are still found in the whole file.
const envBytes = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt; };
export const SCAN_MAX_BYTES = envBytes('SCAN_MAX_BYTES', 2 * 1024 * 1024);
/** Mounted source files above this are skipped (warning) — neither scanned nor deployed. */
export const SOURCE_FILE_MAX_BYTES = envBytes('SOURCE_FILE_MAX_BYTES', 20 * 1024 * 1024);
export const TITLE_MAX = 200;
export const DESC_MAX = 500;
export const SUBJECT_MAX = 200;
const clip = (v, n) => String(v ?? '').slice(0, n);
const isPostman = (name) => /\.postman_(collection|environment)\.json$/i.test(name);

export const CATEGORIES = ['計畫', '評估', '比較', '稽核', '設計／UX', '表單', 'API', '技能手冊', '劇本／文案', '腳本', '索引', '報告'];
export const STATUSES = ['待處理', '待確認', '已確認', '已發布', '封存'];
/** Statuses used before the Mantis-style workflow; syncCatalog rewrites them (idempotent). */
export const STATUS_MIGRATION = { '草稿': '待處理', '審查中': '待確認', '本機': '已確認' };
export const migrateStatus = (s) => STATUS_MIGRATION[s] || s;
/** People fields on a doc (emails). Optional; `reporter` defaults to the file's first git author. */
export const PEOPLE_FIELDS = ['reporter', 'assignee', 'reviewer'];
/** Fields the README index can overwrite; changing one by hand locks the entry. */
export const README_FIELDS = ['title', 'desc', 'url', 'date'];

// Keyword registry seed: { Keyword: [alias regex, ...] } — case-insensitive. Use \b only around Latin words; in a JS
// string it is written '\\b' ('\b' would be a backspace character and never match).
export const DEFAULT_KEYWORDS = {
  'API': ['\\bapi\\b', 'postman', 'openapi', 'swagger'],
  'CI': ['\\bci\\b', 'github actions', 'gitlab ci'],
  '測試': ['測試', '\\btests?\\b', '\\bcoverage\\b'],
  '成本': ['成本', '\\bcosts?\\b', '\\bpricing\\b'],
  '登入／OAuth': ['\\boauth\\b', '登入', '\\bsso\\b'],
  'UX': ['\\bux\\b', '\\bmockups?\\b'],
  'GDPR／隱私': ['\\bgdpr\\b', '隱私', '個資'],
  'Prompt': ['\\bprompts?\\b'],
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
  // sources: [{ name, repo, ref, path, depth }] — external git repos mounted as top-level projects (see below)
};

/** The index project: files directly under docs/<projectRoot>/. Owner-only, never public. */
export const INDEX_PROJECT = '（索引）';
export const VISIBILITIES = ['private', 'public'];

// ---------- text helpers ----------
export function walk(dir, { notes = false } = {}) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (notes || p !== NOTES_DIR) out.push(...walk(p, { notes })); }
    else if (EXTS.has(path.extname(e.name)) && !e.name.includes(':') && p !== CATALOG) out.push(p);
  }
  return out;
}

const codePoint = (n, all) => (n <= 0x10ffff ? String.fromCodePoint(n) : all); // fromCodePoint throws above U+10FFFF
const decode = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d{1,8});/g, (all, n) => codePoint(+n, all))
  .replace(/&#x([0-9a-f]{1,8});/gi, (all, n) => codePoint(parseInt(n, 16), all))
  .replace(/&amp;/g, '&');

const stripDataUris = (s) => s.replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]+/g, ' ');

/**
 * Remove every span from a match of `openRe` to the next `close(match)` literal (case-insensitive), like
 * `.replace(/open[\s\S]*?close/gi, ' ')` but in one forward pass: the regex rescans to the end for every opener
 * that has no closer (quadratic on hostile input). As with the regex, an opener without a closer stays as text.
 */
function dropSpans(s, openRe, close) {
  const open = new RegExp(openRe.source, 'gi');
  const unclosed = new Set(); // a closer missing after one opener is missing after every later one too
  let out = '', at = 0, m;
  while ((m = open.exec(s))) {
    const lit = close(m).toLowerCase();
    if (unclosed.has(lit)) continue;
    const end = new RegExp(lit.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'gi');
    end.lastIndex = open.lastIndex;
    if (!end.exec(s)) { unclosed.add(lit); continue; }
    out += s.slice(at, m.index) + ' ';
    at = open.lastIndex = end.lastIndex;
  }
  return out + s.slice(at);
}

/** `<…>` tags → ' ', linear: stops at the first '<' that has no later '>' (the rest stays text, as before). */
function dropTags(s) {
  let out = '', at = 0;
  for (let i = s.indexOf('<'); i >= 0; i = s.indexOf('<', i + 1)) {
    const j = s.indexOf('>', i + 1);
    if (j < 0) break;
    if (j === i + 1) continue; // '<>' is not a tag
    out += s.slice(at, i) + ' ';
    at = j + 1;
    i = j;
  }
  return out + s.slice(at);
}

export function htmlToText(html) {
  // the <head> (title, meta, styles) is not body text: the title is indexed as the title already
  let s = dropSpans(stripDataUris(html), /<!--/, () => '-->');
  s = dropSpans(s, /<head\b/, () => '</head>');
  s = dropSpans(s, /<title\b/, () => '</title>');
  s = dropSpans(s, /<(style|script|svg|template|noscript)\b/, (m) => `</${m[1]}>`);
  return decode(dropTags(s)).replace(/\s+/g, ' ').trim();
}

// README index table: | date | [title](path) | repo | url | desc |   (paths relative to the README's folder)
export function readReadmeIndex(site = DEFAULT_SITE) {
  const map = {};
  if (!site.readmeIndex) return map;
  const f = path.join(DOCS, site.readmeIndex);
  const dir = path.posix.join('docs', path.posix.dirname(site.readmeIndex));
  if (!fs.existsSync(f)) return map;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (line.length > 4000) continue; // the row regex backtracks polynomially on long lines; real rows are short
    const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*(.*)\|\s*$/);
    if (!m) continue;
    const rel = path.posix.join(dir, m[3].trim());
    const url = (m[5].match(/https?:\/\/\S+/) || [''])[0];
    map[rel] = { date: m[1], title: clip(m[2].trim(), TITLE_MAX), url, desc: clip(m[6].trim(), DESC_MAX) };
  }
  return map;
}

// GIT_TERMINAL_PROMPT=0: a scan must never hang on a credential prompt (e.g. a lazy fetch in a partial clone)
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
function git(args, cwd = CONTENT) {
  try { return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

// Demo content in the engine repo must not publish committer emails.
const INFER_REPORTER = CONTENT !== path.join(ROOT, 'examples');

/**
 * Where a catalog path lives on disk: { abs, cwd, gitRel, source? }. Local docs: <content>/<rel>, history from the
 * content repo. Mounted docs: .sources/<name>/<path>/…, history from the source repo (see mountsOf).
 */
const localLoc = (rel) => ({ abs: path.join(CONTENT, rel), cwd: CONTENT, gitRel: rel });

/** Email of the commit that added the file ('' when not in git). */
function gitReporter(loc) {
  if (!INFER_REPORTER) return '';
  return git(['log', '--diff-filter=A', '--format=%ae', '--', loc.gitRel], loc.cwd).split('\n').pop().toLowerCase();
}

function gitDate(loc) {
  const out = git(['log', '--diff-filter=A', '--format=%cs', '--', loc.gitRel], loc.cwd).split('\n').pop();
  return out || fs.statSync(loc.abs).mtime.toISOString().slice(0, 10);
}

/** Up to `cap` commits touching the file (newest first); [] when not in git. `loc` defaults to a local doc. */
export function gitHistory(rel, cap = 20, loc = localLoc(rel)) {
  const out = git(['log', '--follow', `-n${cap}`, '--format=%cs%x09%h%x09%s', '--', loc.gitRel], loc.cwd);
  return out ? out.split('\n').map((l) => { const [date, hash, ...s] = l.split('\t'); return { date, hash, subject: clip(s.join('\t'), SUBJECT_MAX) }; }) : [];
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
// starts only at the beginning of a local-part run and caps it at 64 (RFC 5321): the unanchored form rescans a long
// run from every position (quadratic on a large file)
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
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

/**
 * Returns { level, reasons } from raw file content. `whole` (default: `raw`) is the complete file: credentials are
 * looked for in all of it (those patterns are linear), the email / PII heuristics only in `raw` (the scanned part).
 */
export function inferSensitivity(raw, whole = raw) {
  const text = stripDataUris(raw);
  const all = whole === raw ? text : stripDataUris(whole);
  const reasons = [];
  for (const [name, re] of SECRET_PATTERNS) if (re.test(all)) reasons.push(name);
  if (reasons.length) return { level: '極機密', reasons };
  const emails = (text.match(EMAIL_RE) || []).filter((e) => !EMAIL_IGNORE.test(e));
  if (emails.length) reasons.push(`email ×${new Set(emails).size}`);
  for (const [name, re] of PII_PATTERNS) if (re.test(text)) reasons.push(name);
  return { level: reasons.length ? '機密' : '內部', reasons };
}

/**
 * Aliases saved by older versions contain a backspace (U+0008) where the seed meant the regex word boundary \b
 * (a '\b' in a single-quoted JS string). Rewrite it to '\\b'; idempotent.
 */
export function migrateKeywords(registry) {
  return Object.fromEntries(Object.entries(registry).map(([kw, aliases]) => [kw,
    (Array.isArray(aliases) ? aliases : []).map((a) => String(a).replaceAll('\u0008', '\\b'))]));
}

export const ALIAS_MAX = 200;
const ALIAS_REPEAT_MAX = 32;

/**
 * Why a keyword alias (catalog.json → keywords, author-supplied) is refused, or null. Aliases run over every document,
 * so only a subset whose cost stays linear is accepted: literals, escapes, classes, groups, alternation, `?`, and
 * `{n}` / `{n,m}` (m ≤ 32) on a single character or class. Unbounded repeats (`*`, `+`, `{n,}`) rescan from every
 * position on a long run; repeats of groups and backreferences can backtrack exponentially.
 */
export function aliasProblem(src) {
  if (typeof src !== 'string' || !src) return 'not a non-empty string';
  if (src.length > ALIAS_MAX) return `longer than ${ALIAS_MAX} characters`;
  try { new RegExp(src, 'gi'); } catch (e) { return `invalid regex (${e.message})`; }
  let prev = null; // kind of the last atom: 'char' | 'group' | 'quant' | null
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      if (/[1-9k]/.test(src[i + 1] || '')) return 'backreferences are not allowed';
      i++; prev = 'char'; continue;
    }
    if (ch === '[') {
      for (i++; i < src.length && src[i] !== ']'; i++) if (src[i] === '\\') i++;
      prev = 'char'; continue;
    }
    if (ch === '(') { prev = null; continue; }
    if (ch === ')') { prev = 'group'; continue; }
    if (ch === '|') { prev = null; continue; }
    if (ch === '*' || ch === '+') return `unbounded repeat "${ch}" is not allowed (use {n,m}, m ≤ ${ALIAS_REPEAT_MAX})`;
    if (ch === '?') { prev = prev === 'quant' ? 'char' : 'quant'; continue; } // after a quantifier: lazy marker
    if (ch === '{') {
      const q = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (!q) { prev = 'char'; continue; } // a literal '{' outside unicode mode
      if (q[2] && q[3] === '') return 'unbounded repeat "{n,}" is not allowed';
      if (Number(q[3] ?? q[1]) > ALIAS_REPEAT_MAX) return `repeat count above ${ALIAS_REPEAT_MAX}`;
      if (prev === 'group') return 'a repeat count on a group is not allowed (only "?")';
      i += q[0].length - 1; prev = 'quant'; continue;
    }
    prev = 'char';
  }
  return null;
}

/** [[keyword, [RegExp…]]]; refused aliases are left out and reported through onSkip(keyword, alias, why). */
export function compileKeywords(registry, onSkip = () => {}) {
  return Object.entries(registry).map(([kw, aliases]) => [kw, (Array.isArray(aliases) ? aliases : []).flatMap((a) => {
    const why = aliasProblem(a);
    if (why) { onSkip(kw, a, why); return []; }
    return [new RegExp(a, 'gi')];
  })]);
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

/**
 * Sensitivity a document declares about itself: Markdown front matter `sensitivity: 機密` or HTML
 * `<meta name="sensitivity" content="機密">`; stored names or English slugs / aliases (site/i18n.js ENUMS.sens).
 * Returns { declared } (a stored value), { invalid } (the unknown text) or {}.
 */
export function declaredSensitivity(raw, ext) {
  let v = null;
  if (ext === '.md') {
    const fm = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
    // (.*) then trim: a lazy (.*?) before [ \t]*$ is quadratic on a long run of blanks
    v = fm && (fm[1].match(/^sensitivity:(.*)$/m) || [])[1];
    if (v !== null && v !== undefined) v = v.replace(/^[ \t]+|[ \t]+$/g, '').replace(/^(['"])(.*)\1$/, '$2');
  } else if (ext === '.html') {
    // [^<>]: an unclosed '<meta' stops at the next tag instead of rescanning to the end of the file
    for (const [tag] of raw.matchAll(/<meta\b[^<>]*>/gi)) {
      const attr = (n) => (tag.match(new RegExp(`(?:^|\\s)${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')) || []).slice(1).find((x) => x !== undefined);
      if (String(attr('name') || '').toLowerCase() === 'sensitivity') { v = attr('content') ?? ''; break; }
    }
  }
  if (v === null || v === undefined) return {};
  const stored = enumValue('sens', v);
  return stored && SENSITIVITIES.includes(stored) ? { declared: stored } : { invalid: String(v).slice(0, 40) };
}

function extractMeta(rel, readme, site, loc = localLoc(rel)) {
  const abs = loc.abs;
  const buf = fs.readFileSync(abs);
  const full = buf.toString('utf8');
  // Detection heuristics / keywords / search text see the first SCAN_MAX_BYTES only (a cut multi-byte character
  // decodes as U+FFFD), counted after inline data: URIs are dropped so a big embedded image cannot push the text out.
  // Credentials and vault references are still looked for in the whole file.
  let raw = full, truncated = false;
  if (buf.length > SCAN_MAX_BYTES) {
    const clean = Buffer.from(stripDataUris(full));
    truncated = clean.length > SCAN_MAX_BYTES;
    raw = (truncated ? clean.subarray(0, SCAN_MAX_BYTES) : clean).toString('utf8');
  }
  const ext = path.extname(abs);
  const base = path.basename(abs, ext);
  const parts = rel.split('/');
  const rootDepth = site.projectRoot ? site.projectRoot.split('/').filter(Boolean).length : 0;
  const inRoot = rootDepth && parts.slice(1, 1 + rootDepth).join('/') === site.projectRoot.replace(/^\/|\/$/g, '');
  const under = parts.slice(inRoot ? 1 + rootDepth : 1); // path below docs/<projectRoot>
  const project = under.length > 1 ? under[0] : INDEX_PROJECT;
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
  const date = r.date || (dm && dm[1]) || gitDate(loc);
  const desc = clip(r.desc || (ext === '.md' ? ((raw.match(/^description:\s*(.+)$/m) || [])[1] || '') : ''), DESC_MAX);
  title = clip(String(title || base).trim() || base, TITLE_MAX);
  const sens = inferSensitivity(raw, full);
  const decl = declaredSensitivity(raw, ext);
  const effective = decl.declared && sensRank(decl.declared) > sensRank(sens.level) ? decl.declared : sens.level;
  return {
    inferred: {
      title, project, subproject, category: inferCategory(rel, title, desc),
      status: /^https?:\/\//.test(url) ? '已發布' : '待處理',
      sensitivity: effective, date, url, desc,
    },
    sensReasons: sens.reasons,
    detected: sens.level,
    declared: decl.declared || null,
    declaredInvalid: decl.invalid ?? null,
    // the whole file: a reference past the scan limit must still be listed (and blocked for a foreign source)
    vaultRefs: refsIn(full),
    truncated,
    text,
    size: buf.length,
    type: ext.slice(1),
  };
}

// ---------- external content sources ("mounts") ----------
// catalog.json → site.sources: [{ name, repo, ref = 'main', path = '' (repo root), depth? }]. `npm run sources:pull`
// checks each one out into .sources/<name>/; the scan mounts .sources/<name>/<path>/ at docs/<projectRoot>/<name>/
// as if the files were local, so catalog keys, ids and metadata stay in the host catalog.json. Source writers control
// only file contents: symlinks, dot-files and names a URL cannot address are skipped, the mount root must be a real
// folder inside the checkout, and their docs may only reference vault names under `<name>/`.
const SOURCE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SOURCE_REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._\/-]{0,199}$/;
// file names a mount skips: control characters, '\\' and '%' (the server-mode gate refuses such paths), ':' (Zone.Identifier)
const BAD_NAME_RE = /[\u0000-\u001f\u007f\\%:]/;

// Source names that would collide with a deployment setting: 'notes' (docs/notes/ holds exported web notes),
// 'previous' (its key VAULT_KEY_PREVIOUS is the web vault's key from before a rekey).
const RESERVED_SOURCES = { notes: 'docs/notes/ holds exported web notes', previous: 'VAULT_KEY_PREVIOUS is the web vault key before a rekey' };
/** Pages secrets the deployment uses for itself; a source's VAULT_KEY_<NAME> must not be one of them. */
const RESERVED_KEYS = new Set(['VAULT_KEY', 'VAULT_KEY_PREVIOUS', 'VAULT_PASSPHRASE']);
/** Pages secret holding a source's vault key (same rule as functions/_lib/vault.js tenantKeyName). */
export const sourceKeyName = (name) => `VAULT_KEY_${name.toUpperCase().replace(/-/g, '_')}`;

/** Name of the CI / environment variable that overrides a source's repo URL (credentials go there, not in git). */
export const sourceEnvName = (name) => `SOURCE_${name.toUpperCase().replace(/-/g, '_')}_URL`;

function sourcePath(p, where) {
  if (p === undefined || p === null || p === '' || p === '.') return '';
  if (typeof p !== 'string' || p.startsWith('/') || /^[A-Za-z]:/.test(p) || BAD_NAME_RE.test(p)) throw new Error(`${where}.path must be a relative folder inside the source repo: ${JSON.stringify(p)}`);
  const parts = p.split('/').filter((x) => x && x !== '.');
  if (parts.some((x) => x === '..' || x.startsWith('.'))) throw new Error(`${where}.path must not contain '..' or dot-folders: ${JSON.stringify(p)}`);
  return parts.join('/');
}

/** site.sources validated and normalised; throws a readable Error on bad config. */
export function sourceList(site = {}) {
  const list = site.sources ?? [];
  if (!Array.isArray(list)) throw new Error('site.sources must be an array');
  const seen = new Set();
  return list.map((s, i) => {
    const where = `site.sources[${i}]`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error(`${where} must be an object`);
    const { name } = s;
    if (typeof name !== 'string' || !SOURCE_NAME_RE.test(name)) throw new Error(`${where}.name must match [a-z0-9][a-z0-9-]* (≤ 63 chars): ${JSON.stringify(name)}`);
    if (Object.hasOwn(RESERVED_SOURCES, name)) throw new Error(`${where}.name "${name}" is reserved (${RESERVED_SOURCES[name]})`);
    const key = sourceKeyName(name);
    if (RESERVED_KEYS.has(key)) throw new Error(`${where}.name "${name}" is reserved (its vault key ${key} is a deployment setting)`);
    if (seen.has(name) || seen.has(key)) throw new Error(`duplicate source name: ${name}${seen.has(key) ? ` (vault key ${key} is taken)` : ''}`);
    seen.add(name).add(key);
    const ref = s.ref ?? 'main';
    if (typeof ref !== 'string' || !SOURCE_REF_RE.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) throw new Error(`${where}.ref is not a valid branch / tag / commit: ${JSON.stringify(ref)}`);
    const repo = s.repo ?? '';
    if (typeof repo !== 'string') throw new Error(`${where}.repo must be a string`);
    const depth = s.depth ?? null;
    if (depth !== null && !(Number.isInteger(depth) && depth > 0)) throw new Error(`${where}.depth must be a positive integer`);
    return { name, repo, ref, path: sourcePath(s.path, where), depth };
  });
}

const lstat = (p) => { try { return fs.lstatSync(p); } catch { return null; } };

/** True when `dir` is a real folder (no symlink anywhere from `repoDir` down) inside a git checkout at `repoDir`. */
function mountAvailable(repoDir, sub) {
  const top = lstat(repoDir);
  if (!top?.isDirectory() || !lstat(path.join(repoDir, '.git'))) return false;
  let cur = repoDir;
  for (const part of sub ? sub.split('/') : []) {
    cur = path.join(cur, part);
    if (!lstat(cur)?.isDirectory()) return false; // missing, a file, or a symlink (lstat does not follow it)
  }
  const real = fs.realpathSync(cur), base = fs.realpathSync(repoDir);
  return real === base || real.startsWith(base + path.sep);
}

/**
 * Mounts of a catalog's site settings: [{ name, repo, ref, path, depth, prefix, repoDir, dir, available }].
 * prefix = virtual catalog folder (docs/<projectRoot>/<name>); dir = the folder read from disk.
 * Throws when a source would shadow a local folder or file.
 */
export function mountsOf(site = DEFAULT_SITE) {
  const root = String(site.projectRoot || '').replace(/^\/+|\/+$/g, '');
  return sourceList(site).map((s) => {
    const prefix = ['docs', root, s.name].filter(Boolean).join('/');
    if (lstat(path.join(CONTENT, ...prefix.split('/')))) throw new Error(`source "${s.name}" collides with the local ${prefix}/ — rename the source or the folder`);
    const repoDir = path.join(SOURCES_DIR, s.name);
    const dir = s.path ? path.join(repoDir, ...s.path.split('/')) : repoDir;
    return { ...s, prefix, repoDir, dir, available: mountAvailable(repoDir, s.path) };
  });
}

/**
 * Regular files of an available mount: [{ rel (virtual catalog path), abs, cwd, gitRel, source, doc }].
 * Never follows or returns symlinks; skips dot-entries (.git, .gitlab-ci.yml …) and names a URL cannot address.
 * `doc` marks files the catalog scans (same extensions as local docs); others are only copied by the build.
 */
export function mountFiles(m, { onSkip = () => {} } = {}) {
  const out = [];
  const visit = (dir, inner) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relInner = inner ? `${inner}/${e.name}` : e.name;
      if (e.name.startsWith('.')) continue;
      if (BAD_NAME_RE.test(e.name)) { onSkip(`${m.prefix}/${relInner}`, 'unsupported characters in name'); continue; }
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) { onSkip(`${m.prefix}/${relInner}`, 'symlink'); continue; }
      if (e.isDirectory()) visit(abs, relInner);
      else if (abs === path.join(m.repoDir, 'vault', 'vault.json')) continue; // the source's vault is not a document
      else if (e.isFile()) {
        const size = fs.statSync(abs).size;
        if (size > SOURCE_FILE_MAX_BYTES) { onSkip(`${m.prefix}/${relInner}`, `${(size / 1048576).toFixed(1)} MB is above SOURCE_FILE_MAX_BYTES (${(SOURCE_FILE_MAX_BYTES / 1048576).toFixed(1)} MB) — not scanned or deployed`); continue; }
        out.push({
          rel: `${m.prefix}/${relInner}`, abs, cwd: m.repoDir, gitRel: m.path ? `${m.path}/${relInner}` : relInner,
          source: m.name, doc: EXTS.has(path.extname(e.name)),
        });
      }
    }
  };
  if (m.available) visit(m.dir, '');
  return out;
}

/**
 * A mounted source's own vault: <checkout>/vault/vault.json when it is a real file (no symlink on the way), else null.
 * It is never a document (mountFiles skips it) and only names under `<source>/` are ever used from it.
 */
export function tenantVaultFile(m) {
  if (!m.available) return null;
  const dir = path.join(m.repoDir, 'vault'), file = path.join(dir, 'vault.json');
  if (!lstat(dir)?.isDirectory() || !lstat(file)?.isFile()) return null;
  const real = fs.realpathSync(file), base = fs.realpathSync(m.repoDir);
  return real.startsWith(base + path.sep) ? file : null;
}

/** Docs of every available mount (see mountFiles). */
export const mountedDocs = (mounts, opts) => mounts.flatMap((m) => mountFiles(m, opts).filter((f) => f.doc));

/** A doc from source X may only reference vault names under X/; local docs (source null) may reference any. */
export const vaultRefAllowed = (source, name) => !source || name.startsWith(`${source}/`);

/** The catalog path's mount when it sits under one: the mount object or null. */
export const mountOfRel = (mounts, rel) => mounts.find((m) => rel.startsWith(`${m.prefix}/`)) || null;

/** Effective visibility of a registry key: top-level value, inherited by subprojects; the index project is private. */
export function visibilityOf(projects, key) {
  const top = String(key).split('/')[0];
  const v = projects?.[top];
  return v && v.visibility === 'public' && top !== INDEX_PROJECT && top !== '*' ? 'public' : 'private';
}

// ---------- catalog IO ----------
/** Old names → new, then any missing workflow status appended; custom statuses are kept. */
export function migrateStatusList(list) {
  const out = [...new Set((Array.isArray(list) && list.length ? list : STATUSES).map(migrateStatus))];
  for (const s of STATUSES) if (!out.includes(s)) out.push(s);
  return out;
}

/** Rewrite `s:草稿` / `status:本機` … in saved filter queries. */
const migrateFilterQuery = (q) => String(q).replace(/(^|\s)(-?)(s|status)([:=])("?)(草稿|審查中|本機)\5(?=\s|$)/g,
  (_, sp, neg, k, op, qt, v) => `${sp}${neg}${k}${op}${qt}${STATUS_MIGRATION[v]}${qt}`);

const isUrl = (u) => /^https?:\/\//.test(u || '');

/** Old status values on one entry. A `本機` doc with an origin URL was shown as published, so it becomes 已發布. */
function migrateEntryStatus(entry) {
  if (entry.status === '本機' && !entry.locked && isUrl(entry.url)) entry.status = '已發布';
  else entry.status = migrateStatus(entry.status);
}

export function loadCatalog() {
  const c = fs.existsSync(CATALOG) ? JSON.parse(fs.readFileSync(CATALOG, 'utf8')) : {};
  c.site = { ...DEFAULT_SITE, ...(c.site || {}) };
  c.categories = [...new Set([...(c.categories || []), ...CATEGORIES])];
  c.statuses = migrateStatusList(c.statuses);
  c.sensitivities = SENSITIVITIES;
  c.projects ||= {};
  c.keywords = migrateKeywords(c.keywords || DEFAULT_KEYWORDS);
  c.filters = (c.filters || DEFAULT_FILTERS).map((f) => ({ ...f, query: migrateFilterQuery(f.query) }));
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
export function syncCatalog(catalog, { onSkip } = {}) {
  const site = catalog.site || DEFAULT_SITE;
  const readme = readReadmeIndex(site);
  const added = [], raised = [], items = [], warnings = [];
  const compiled = compileKeywords(catalog.keywords, (kw, a, why) => warnings.push(`keyword "${kw}": alias ${JSON.stringify(a)} ignored — ${why}`));
  const mounts = mountsOf(site);
  const locs = new Map(walk(DOCS).map((a) => { const rel = path.relative(CONTENT, a).split(path.sep).join('/'); return [rel, localLoc(rel)]; }));
  for (const f of mountedDocs(mounts, { onSkip })) locs.set(f.rel, f);
  const files = [...locs.keys()].sort();
  let nextId = Math.max(0, ...Object.values(catalog.docs).map((d) => d.id)) + 1;
  const metas = files.map((rel) => ({ rel, ...extractMeta(rel, readme, site, locs.get(rel)) }))
    .sort((a, b) => a.inferred.date.localeCompare(b.inferred.date) || a.rel.localeCompare(b.rel));
  for (const m of metas) {
    let entry = catalog.docs[m.rel];
    if (!entry) {
      entry = catalog.docs[m.rel] = { id: nextId++, ...m.inferred, tags: [], related: [] };
      added.push(m.rel);
    }
    // schema migration: fill fields introduced after the entry was created
    for (const k of ['subproject', 'sensitivity']) if (entry[k] === undefined) entry[k] = m.inferred[k];
    migrateEntryStatus(entry);
    const loc = locs.get(m.rel);
    if (!entry.reporter) { const r = gitReporter(loc); if (r) entry.reporter = r; }
    entry.project = m.inferred.project;
    entry.subproject = m.inferred.subproject;
    if (!Array.isArray(entry.tags) || (entry.subproject && entry.tags.length === 1 && entry.tags[0] === entry.subproject)) entry.tags = [];
    entry.related ||= [];
    if (!entry.sensitivityReviewed && sensRank(m.detected) > sensRank(entry.sensitivity)) {
      raised.push(`${m.rel}: ${entry.sensitivity} → ${m.detected} (${m.sensReasons.join(', ')})`);
      entry.sensitivity = m.detected;
    }
    // a declaration in the file is a floor even after review: it is lowered only by editing the file
    if (m.declared && sensRank(m.declared) > sensRank(entry.sensitivity)) {
      raised.push(`${m.rel}: ${entry.sensitivity} → ${m.declared} (declared in the file)`);
      entry.sensitivity = m.declared;
    }
    if (m.declaredInvalid !== null) warnings.push(`${m.rel}: unknown declared sensitivity "${m.declaredInvalid}" (use ${SENSITIVITIES.join(' / ')} or public / internal / confidential / secret)`);
    // README is the source of truth for title/desc/url/date once it lists the doc, unless locked
    const r = readme[m.rel];
    if (r && !entry.locked) Object.assign(entry, { title: r.title, desc: r.desc, url: r.url || entry.url, date: r.date });
    // the README index is the publication record: listing an origin URL publishes a doc that is still 待處理
    if (r && !entry.locked && entry.status === '待處理' && isUrl(r.url)) entry.status = '已發布';
    // project registry
    if (!catalog.projects[entry.project]) catalog.projects[entry.project] = { title: entry.project, desc: '' };
    if (entry.subproject) {
      const key = `${entry.project}/${entry.subproject}`;
      if (!catalog.projects[key]) catalog.projects[key] = { title: entry.subproject, desc: '', parent: entry.project };
    }
    // vault namespace: a mounted doc's references outside <source>/ are never exposed (build warns, server refuses)
    const source = loc.source || null;
    const vaultRefs = m.vaultRefs.filter((n) => vaultRefAllowed(source, n));
    const blockedRefs = m.vaultRefs.filter((n) => !vaultRefAllowed(source, n));
    const text = blockedRefs.length ? stripBlockedRefs(m.text, source) : m.text;
    const keywords = computeKeywords(compiled, `${entry.title} ${entry.desc}`, text);
    items.push({ rel: m.rel, entry, text, keywords, size: m.size, type: m.type, sensReasons: m.sensReasons, vaultRefs, blockedRefs, source, loc, declared: m.declared, truncated: m.truncated });
  }
  // A mount that is not checked out (never pulled, or the folder vanished) keeps its catalog entries — ids, workflow
  // state and hand-edited metadata survive — but they are not in `items`, so nothing of them is deployed. Entries
  // are deleted only when a checkout is present and the file is gone from it.
  const unavailable = mounts.filter((m) => !m.available);
  const held = Object.keys(catalog.docs).filter((k) => !locs.has(k) && mountOfRel(unavailable, k));
  const heldSet = new Set(held);
  const missing = Object.keys(catalog.docs).filter((k) => !locs.has(k) && !heldSet.has(k));
  for (const k of missing) delete catalog.docs[k];
  // drop auto-created registry entries whose folder no longer has docs (keep ones with a hand-written desc, a
  // visibility setting, or whose docs are held back with an unavailable mount)
  const used = new Set([...items.map((it) => it.entry), ...held.map((k) => catalog.docs[k])]
    .flatMap((e) => [e.project, e.subproject && `${e.project}/${e.subproject}`]));
  for (const [k, v] of Object.entries(catalog.projects)) if (!used.has(k) && !v.desc && !v.visibility) delete catalog.projects[k];
  return { items, added, missing, raised, held, mounts, unavailable: unavailable.map((m) => m.name), warnings };
}

/** Text with every {{vault:…}} reference outside the source's namespace replaced (see vaultRefAllowed). */
export const BLOCKED_REF = '{{vault-blocked}}';
export const stripBlockedRefs = (text, source) => String(text).replace(VAULT_RE, (all, name) => (vaultRefAllowed(source, name) ? all : BLOCKED_REF));

/** Flat record used by the portal, the CLI and the query matcher. */
export function toRecord(it) {
  const rec = { ...it.entry, keywords: it.keywords, path: it.rel, type: it.type, size: it.size, ...(it.vaultRefs?.length ? { vault: it.vaultRefs } : {}) };
  delete rec.source; // derived from the mount, never taken from catalog.json
  if (it.source) rec.source = it.source;
  if (it.blockedRefs?.length) rec.vaultBlocked = it.blockedRefs.length;
  if (it.declared) rec.declaredSensitivity = it.declared;
  return rec;
}
