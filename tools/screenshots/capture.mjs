#!/usr/bin/env node
// Feature screenshots of the portal: builds the demo content, serves dist/ to headless Chromium through request
// interception (no server, no port), fakes the server-mode API, and writes assets/screenshots/<nn>-<name>.png.
//
//   node tools/screenshots/capture.mjs [--plain] [--out=<dir>] [--only=home,graph] [--no-build]
//   --plain writes shots without highlight rings to <tmp>/gitdocs-screenshots-plain/ (regenerable, kept out of the
//   repo); pass --out=<dir> to put them elsewhere.
//
// Browser: playwright-core (pinned below) is fetched with `npm exec`, so the repo gains no dependency. Chromium is
// taken from $CHROME_PATH, else Playwright's own build for that version (`npx --yes playwright@1.64.1 install
// chromium`), else an installed Google Chrome. The pages still load marked / DOMPurify / Sigma from their CDNs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createMockApi } from './mock-api.mjs';
import { SHOTS } from './shots.mjs';

const PLAYWRIGHT = 'playwright-core@1.64.1';
const ORIGIN = 'https://docs.northwind.example';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DIST = path.join(ROOT, 'dist');
const CONTENT = process.env.CONTENT_DIR ? path.resolve(process.env.CONTENT_DIR) : path.join(ROOT, 'examples');

const argv = process.argv.slice(2);
/** --name → true, --name=value → 'value', absent → undefined */
const flag = (name) => {
  const a = argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  return a === undefined ? undefined : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
};
const plain = Boolean(flag('plain'));
const outDir = path.resolve(typeof flag('out') === 'string' ? flag('out') : (plain ? path.join(os.tmpdir(), 'gitdocs-screenshots-plain') : path.join(ROOT, 'assets', 'screenshots')));
// Any <repo>/docs turns the engine repo into a content repo for scripts/lib/catalog.mjs (it would scan docs/, not examples/).
const ROOT_DOCS = path.join(ROOT, 'docs');
if (outDir === ROOT_DOCS || outDir.startsWith(ROOT_DOCS + path.sep)) {
  console.error(`refusing to write under ${ROOT_DOCS}: a docs/ folder in the engine repo makes the build treat it as a content repo`);
  process.exit(2);
}
const only = typeof flag('only') === 'string' ? flag('only').split(',') : null;

// ---------- playwright-core via npm exec ----------
function loadPlaywright() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (path.basename(dir) !== '.bin' || path.basename(path.dirname(dir)) !== 'node_modules') continue;
    const nm = path.dirname(dir);
    if (fs.existsSync(path.join(nm, 'playwright-core', 'package.json'))) return createRequire(path.join(nm, 'noop.js'))('playwright-core');
  }
  return null;
}
let pw = loadPlaywright();
if (!pw) {
  if (process.env.GITDOCS_SHOTS_EXEC) { console.error(`could not load ${PLAYWRIGHT}`); process.exit(1); }
  const r = spawnSync('npm', ['exec', '--yes', `--package=${PLAYWRIGHT}`, '--', 'node', fileURLToPath(import.meta.url), ...argv],
    { stdio: 'inherit', cwd: ROOT, env: { ...process.env, GITDOCS_SHOTS_EXEC: '1' } });
  process.exit(r.status ?? 1);
}

async function launch() {
  // SwiftShader gives headless Chromium a software WebGL context, which the knowledge graph (Sigma.js) needs.
  const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--font-render-hinting=none'];
  const tries = [
    process.env.CHROME_PATH && { executablePath: process.env.CHROME_PATH },
    fs.existsSync(pw.chromium.executablePath()) && {},
    { channel: 'chrome' },
  ].filter(Boolean);
  let last;
  for (const opts of tries) {
    try {
      const b = await pw.chromium.launch({ headless: true, args, ...opts });
      console.log(`browser: ${opts.executablePath || opts.channel || 'playwright chromium'} ${b.version()}`);
      return b;
    } catch (e) { last = e; }
  }
  throw new Error(`no Chromium found (set CHROME_PATH or run: npx --yes ${PLAYWRIGHT.replace('-core', '')} install chromium)\n${last?.message || ''}`);
}

// ---------- static files from dist/ ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.md': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
/** site/_headers rules ([pattern, {header: value}]), applied the way Pages does: every matching rule, joined. */
function readHeaders() {
  const f = path.join(DIST, '_headers');
  const rules = [];
  if (!fs.existsSync(f)) return rules;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) rules.push([line.trim(), {}]);
    else if (rules.length) { const i = line.indexOf(':'); rules.at(-1)[1][line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
  }
  return rules;
}
function headersFor(rules, pathname) {
  const out = {};
  for (const [pat, hs] of rules) {
    const hit = pat.endsWith('*') ? pathname.startsWith(pat.slice(0, -1)) : pathname === pat;
    if (hit) for (const [k, v] of Object.entries(hs)) out[k] = out[k] ? `${out[k]}, ${v}` : v;
  }
  return out;
}

async function serve(context, { server, api }) {
  const rules = readHeaders();
  await context.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.startsWith('/api/')) {
      let body;
      try { body = req.postDataJSON(); } catch { body = undefined; }
      const res = server ? await api(req.method(), url, body) : null;
      const [status, json] = res || [404, { error: 'not found' }];
      return route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(json) });
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(DIST, rel);
    if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile() || rel === '/_headers') {
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    }
    return route.fulfill({
      status: 200,
      headers: { ...headersFor(rules, url.pathname), 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' },
      body: fs.readFileSync(file),
    });
  });
}

// ---------- highlights (DOM/CSS injected into the page, never into site/) ----------
function addHighlights(marks) {
  const css = document.createElement('style');
  css.id = 'shot-hl';
  css.textContent = `
    .shot-ring{position:absolute;pointer-events:none;z-index:2147483000;border:3px solid #f59f00;border-radius:10px;
      box-shadow:0 0 0 5px rgba(245,159,0,.16),0 0 22px 6px rgba(245,159,0,.32)}
    .shot-cap{position:absolute;pointer-events:none;z-index:2147483001;display:flex;align-items:center;gap:8px;
      font:600 13px/1.25 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.01em;color:#fff;
      background:rgba(17,24,39,.94);padding:7px 13px;border-radius:999px;box-shadow:0 6px 18px rgba(0,0,0,.28);white-space:nowrap}
    .shot-cap::before{content:"";width:8px;height:8px;border-radius:50%;background:#f59f00;flex:none}`;
  document.head.appendChild(css);
  const vw = document.documentElement.clientWidth;
  const missing = [];
  for (const { sel, caption, pad = 6, place, dx = 0, ring: drawRing = true } of marks) {
    const els = [sel].flat().flatMap((s) => [...document.querySelectorAll(s)].slice(0, 1)).filter((e) => e.getClientRects().length);
    if (!els.length) { missing.push(String(sel)); continue; }
    const rs = els.map((e) => e.getBoundingClientRect());
    const box = {
      l: Math.min(...rs.map((r) => r.left)) - pad + scrollX, t: Math.min(...rs.map((r) => r.top)) - pad + scrollY,
      r: Math.max(...rs.map((r) => r.right)) + pad + scrollX, b: Math.max(...rs.map((r) => r.bottom)) + pad + scrollY,
    };
    box.l = Math.max(box.l, scrollX + 3); box.r = Math.min(box.r, scrollX + vw - 3);
    if (drawRing) { // ring: false only anchors a caption (e.g. between two cards of one ring)
      const ring = document.createElement('div');
      ring.className = 'shot-ring';
      Object.assign(ring.style, { left: `${box.l}px`, top: `${box.t}px`, width: `${box.r - box.l}px`, height: `${box.b - box.t}px` });
      document.body.appendChild(ring);
    }
    if (!caption) continue;
    const cap = document.createElement('div');
    cap.className = 'shot-cap';
    cap.textContent = caption;
    document.body.appendChild(cap);
    const h = cap.offsetHeight, w = Math.min(cap.offsetWidth, vw - 16);
    cap.style.maxWidth = `${vw - 16}px`;
    // above / below the ring, inside its bottom corner (inside-start / inside-end), or straddling its top border
    // (edge-start / edge-end) — whichever leaves the featured content readable
    const where = place || (box.t - scrollY > h + 14 ? 'above' : 'below');
    const end = where.endsWith('-end');
    const x = (end ? box.r - w - 16 : where.includes('-') ? box.l + 16 : box.l) + dx;
    const left = Math.min(Math.max(x, scrollX + 8), scrollX + vw - w - 8);
    const top = { above: box.t - h - 8, below: box.b + 8 }[where] ?? (where.startsWith('inside') ? box.b - h - 14 : box.t - h / 2);
    Object.assign(cap.style, { left: `${left}px`, top: `${top}px` });
  }
  return missing;
}

/** Visible email addresses outside the places the product shows them (admin users table, own profile menu). */
function visibleEmails(allowed) {
  const RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
  const ok = (el) => !el || allowed.some((s) => el.closest(s));
  const shown = (el) => el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const hits = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode, el = n.parentElement;
    if (RE.test(n.nodeValue) && shown(el) && !ok(el) && !el.closest('script,style,datalist,template')) hits.push(n.nodeValue.trim().slice(0, 80));
  }
  for (const el of document.querySelectorAll('[title],input,textarea')) {
    const v = [el.title, el.value, el.placeholder].filter(Boolean).join(' ');
    if (RE.test(v) && shown(el) && !ok(el)) hits.push(`${el.tagName.toLowerCase()}: ${v.slice(0, 80)}`);
  }
  return hits;
}

// ---------- waiting ----------
async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  });
  await page.waitForTimeout(250);
}
/** The graph reports progress in .gx-status ("…" while loading / laying out); done when it stops changing. */
async function graphSettled(page, timeout = 20000) {
  const end = Date.now() + timeout;
  let prev = '', same = 0;
  while (Date.now() < end) {
    const t = await page.locator('.gx-status').textContent().catch(() => '') || '';
    same = t && t === prev && !t.trim().endsWith('…') ? same + 1 : 0;
    if (same >= 3) return true;
    prev = t;
    await page.waitForTimeout(400);
  }
  return false;
}

// ---------- run ----------
if (!flag('no-build')) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], { stdio: 'inherit', cwd: ROOT });
  if (r.status) process.exit(r.status);
}
const api = createMockApi(DIST, CONTENT);
fs.mkdirSync(outDir, { recursive: true });
const browser = await launch();
const done = [];
let failed = 0;
const shots = SHOTS.map((s, i) => ({ ...s, file: `${String(i + 1).padStart(2, '0')}-${s.name}.png` })).filter((s) => !only || only.includes(s.name));
for (const shot of shots) {
  const t0 = Date.now();
  const { width = 1440, height = 900, mobile = false, theme = 'light', locale = 'en-US', server = true } = shot;
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile,
    colorScheme: theme === 'dark' ? 'dark' : 'light', locale, timezoneId: 'UTC',
    serviceWorkers: 'block', // a service worker would answer requests before page.route() sees them
  });
  await context.addInitScript((t) => { try { localStorage.setItem('theme', t); } catch { /* ignore */ } }, theme);
  await serve(context, { server, api });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  try {
    await page.goto(`${ORIGIN}/${shot.query || ''}#/${shot.route}`, { waitUntil: 'load' });
    await page.locator('#app > :not(.loading)').first().waitFor({ timeout: 15000 });
    if (shot.ready) await page.locator(shot.ready).first().waitFor({ timeout: 20000 });
    if (shot.graph && !(await graphSettled(page))) console.warn(`  ${shot.name}: graph layout did not settle, capturing anyway`);
    if (shot.prep) await shot.prep(page);
    await settle(page);
    const leaks = await page.evaluate(visibleEmails, ['table.users', '#me-menu']);
    if (leaks.length) { failed++; console.error(`  ${shot.name}: email visible: ${leaks.join(' | ')}`); }
    if (!plain && shot.marks?.length) {
      const missing = await page.evaluate(addHighlights, shot.marks);
      if (missing.length) console.warn(`  ${shot.name}: highlight target not found: ${missing.join(', ')}`);
    }
    await page.screenshot({ path: path.join(outDir, shot.file), fullPage: Boolean(shot.fullPage), animations: 'disabled' });
    done.push(shot);
    console.log(`✓ ${shot.file}  ${((Date.now() - t0) / 1000).toFixed(1)} s${errors.length ? `  (page errors: ${errors.length})` : ''}`);
    for (const e of errors) console.log(`    page: ${e.slice(0, 200)}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${shot.file}: ${e.message.split('\n')[0]}`);
    for (const x of errors) console.error(`    page: ${x.slice(0, 200)}`);
  } finally {
    await context.close();
  }
}
await browser.close();

if (!only) {
  const cmd = `npm run screenshots${plain ? ' -- --plain' : ''}`;
  const readme = (file, title, intro, key) => fs.writeFileSync(path.join(outDir, file),
    [title, '', ...intro, '', ...done.flatMap((s) => [`**${s[key] || s.title}**`, '', `![${s[key] || s.title}](${s.file})`, ''])].join('\n'));
  readme('README.md', '# Screenshots', [`Generated by \`${cmd}\` (tools/screenshots/capture.mjs) from the demo`,
    'content in `examples/` with a mocked server-mode API. Do not edit by hand. [繁體中文](README.zh-TW.md)'], 'title');
  readme('README.zh-TW.md', '# 畫面截圖', [`由 \`${cmd}\`（tools/screenshots/capture.mjs）以 \`examples/\` 的示範內容和模擬的`,
    '伺服器模式 API 產生，請勿手動修改。[English](README.md)'], 'titleZh');
}
console.log(`${done.length}/${shots.length} screenshots → ${path.relative(process.cwd(), outDir) || '.'}${plain ? ' (plain)' : ''}`);
process.exit(failed ? 1 : 0);
