// 關聯圖 — knowledge-graph view: documents, projects and keywords as a force-directed network.
//
// Libraries are loaded lazily, only when the view opens:
//   graphology 0.26.0 and Sigma.js 3.0.3 — UMD builds from cdnjs (globals `graphology` / `Sigma`), pinned + SRI.
//   graphology-layout-forceatlas2 0.10.1 — cdnjs does not host it, so it comes from jsDelivr's `+esm` build, which
//     rewrites the CommonJS package into a browser ES module and pins its only dependency (graphology-utils@2.5.2).
//     SRI is not possible for `+esm` (generated files), hence exact versions in the URL.
//
// The top of this file (buildGraphData and helpers) is pure: Node can import it without a DOM or network.
import { sensRank } from './query.js';

const LIBS = {
  graphology: ['https://cdnjs.cloudflare.com/ajax/libs/graphology/0.26.0/graphology.umd.min.js',
    'sha512-Hqa5FKQ53pYDWaRnytoNvRT3JXRac7dcH+kB3RUCX69CGNrnz5LE76Mp0z186qDv0LBWrwx5QipEoenZB5CE4w=='],
  sigma: ['https://cdnjs.cloudflare.com/ajax/libs/sigma.js/3.0.3/sigma.min.js',
    'sha512-Pl31Mn3QNmO8wHTaB9fdt/0YGpGtHHqcvT8SuwSK4/E1VLgkiPoluigM5BxlC3irGAzfLjSv9/L1m9dyVEl4Bw=='],
  fa2: 'https://cdn.jsdelivr.net/npm/graphology-layout-forceatlas2@0.10.1/+esm',
  fa2Worker: 'https://cdn.jsdelivr.net/npm/graphology-layout-forceatlas2@0.10.1/worker/+esm',
};

// Mid-luminance hues: the light set stays readable on #f4f6f7-ish backgrounds, the dark set on #12171a-ish.
const PALETTE_LIGHT = ['#2f6fb0', '#d1600f', '#16897a', '#7b5cc4', '#c23b7a', '#5f8a12', '#a8741a', '#0e8fa8', '#b83c3c', '#4a5fc1', '#8a6a00', '#3d7d4f'];
const PALETTE_DARK = ['#7fb3ec', '#f29a5a', '#5fd0bd', '#b39cf0', '#f08ab8', '#a6d057', '#e2b35c', '#5cc7e0', '#f08a84', '#97a6ff', '#d9c15a', '#7fcf96'];

export const EDGE_KINDS = ['project', 'keyword', 'related', 'supersedes', 'similar'];
const EDGE_STYLE = { // weight drives ForceAtlas2 attraction; size is the drawn thickness
  hub: { weight: 2, size: 1 },
  project: { weight: 1, size: 0.6 },
  keyword: { weight: 0.3, size: 0.4 },
  related: { weight: 2, size: 2 },
  supersedes: { weight: 2, size: 1.8 },
};
const LABEL_MAX = 22;
const LOCK = '🔒 ';

// ---------- pure helpers ----------
const projOf = (d) => d.project + (d.subproject ? `/${d.subproject}` : '');
const inScope = (d, p) => !p || d.project === p || projOf(d) === p;
const termsOf = (d) => [...new Set([...(d.tags || []), ...(d.keywords || [])].filter(Boolean))];
const clip = (s, n = LABEL_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isLocked = (d) => sensRank(d.sensitivity) >= sensRank('機密');
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// Seeded so the same catalog always starts from the same layout (stable screenshots, predictable relayouts).
function seeded(key, salt) {
  let a = hashString(`${salt}:${key}`);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Palette slot per top-level project, from the whole registry so colours do not shift when the scope changes. */
export function paletteOrder(projects = {}, docs = []) {
  const tops = new Set(Object.entries(projects).filter(([, v]) => !v?.parent).map(([k]) => k));
  docs.forEach((d) => d.project && tops.add(d.project));
  return new Map([...tops].sort((a, b) => a.localeCompare(b)).map((k, i) => [k, i % PALETTE_LIGHT.length]));
}

/**
 * Doc–doc similarity from shared terms (keywords ∪ tags): Jaccard weight, at least `minShared` common terms, and at
 * most `cap` similar edges per document. Pairs are counted from an inverted index, so cost follows co-occurrences
 * rather than N². Terms carried by more than `maxDf` of the docs (and > 50 docs) are skipped: they say nothing about
 * which docs belong together, and they are what makes the pair count explode.
 */
export function similarPairs(docs, { cap = 5, minShared = 2, exclude = new Set(), maxDf = 0.25 } = {}) {
  const n = docs.length;
  if (n < 2 || cap <= 0) return [];
  const all = docs.map(termsOf);
  const df = new Map();
  all.forEach((ts) => ts.forEach((t) => df.set(t, (df.get(t) || 0) + 1)));
  const limit = Math.max(50, Math.ceil(n * maxDf));
  const termId = new Map();
  const terms = all.map((ts) => ts.filter((t) => df.get(t) >= 2 && df.get(t) <= limit)
    .map((t) => { if (!termId.has(t)) termId.set(t, termId.size); return termId.get(t); }));
  const postings = Array.from({ length: termId.size }, () => []);
  terms.forEach((ts, i) => ts.forEach((t) => postings[t].push(i))); // ascending doc index
  const index = new Map(docs.map((d, i) => [String(d.id), i]));
  const banned = new Set();
  for (const key of exclude) {
    const [a, b] = String(key).split('|').map((x) => index.get(x));
    if (a !== undefined && b !== undefined) banned.add(Math.min(a, b) * n + Math.max(a, b));
  }
  const keep = cap * 2; // spare candidates so a doc whose favourites are already full still finds partners
  const tops = Array.from({ length: n }, () => []);
  const cursor = new Int32Array(termId.size); // postings[t][cursor[t]] is the doc being processed
  const count = new Int32Array(n);
  const touched = new Int32Array(n);
  const probe = { i: 0, j: 0, w: 0, shared: 0, h: 0 }; // reused so rejected pairs allocate nothing
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const t of terms[i]) {
      const p = postings[t];
      for (let x = ++cursor[t]; x < p.length; x++) if (count[p[x]]++ === 0) touched[m++] = p[x];
    }
    for (let q = 0; q < m; q++) {
      const j = touched[q];
      const shared = count[j];
      count[j] = 0;
      if (shared < minShared || banned.has(i * n + j)) continue;
      probe.i = i; probe.j = j; probe.shared = shared; probe.h = pairHash(i, j);
      probe.w = shared / (terms[i].length + terms[j].length - shared);
      if (!fits(tops[i], probe, keep) && !fits(tops[j], probe, keep)) continue;
      const c = { ...probe };
      offer(tops[i], c, keep);
      offer(tops[j], c, keep);
    }
  }
  // Greedy by weight with a hard per-node cap: the strongest pairs are kept first.
  const seen = new Set();
  const cands = [];
  for (const top of tops) for (const c of top) { const k = c.i * n + c.j; if (!seen.has(k)) { seen.add(k); cands.push(c); } }
  cands.sort((x, y) => (better(x, y) ? -1 : better(y, x) ? 1 : 0));
  const deg = new Int32Array(n);
  const out = [];
  for (const c of cands) {
    if (deg[c.i] >= cap || deg[c.j] >= cap) continue;
    deg[c.i]++; deg[c.j]++;
    out.push({ a: docs[c.i].id, b: docs[c.j].id, weight: c.w, shared: c.shared });
  }
  return out;
}
const fits = (top, c, keep) => top.length < keep || better(c, top[keep - 1]);
function offer(top, c, keep) {
  if (!fits(top, c, keep)) return;
  let k = top.length;
  while (k > 0 && better(c, top[k - 1])) k--;
  top.splice(k, 0, c);
  if (top.length > keep) top.pop();
}
// Ties fall back to a hash of the pair, not to ids: id order would make every doc pick the same few partners.
const pairHash = (i, j) => Math.imul(Math.imul(i, 0x9e3779b1) ^ Math.imul(j, 0x85ebca6b), 0xc2b2ae35) >>> 0;
function better(x, y) {
  if (x.w !== y.w) return x.w > y.w;
  if (x.shared !== y.shared) return x.shared > y.shared;
  if (x.h !== y.h) return x.h < y.h;
  return x.i !== y.i ? x.i < y.i : x.j < y.j;
}

/**
 * docs (catalog records) → { nodes, edges, projects, stats }.
 * Node keys: `d:<id>`, `p:<project>` / `p:<project>/<sub>`, `k:<term>`. Positions are seeded, ready for ForceAtlas2.
 */
export function buildGraphData(docs = [], { projects = {}, scope = '', similarCap = 5, minShared = 2, salt = 0 } = {}) {
  const shown = docs.filter((d) => d && Number.isFinite(Number(d.id)) && inScope(d, scope));
  const slot = paletteOrder(projects, docs);
  const byId = new Map(shown.map((d) => [Number(d.id), d]));
  const nodes = new Map();
  const edges = [];
  const edgeSeen = new Set();
  const addEdge = (kind, source, target, extra = {}) => {
    if (source === target) return;
    const directed = kind === 'supersedes';
    const key = `${kind}:${directed ? `${source}>${target}` : pairKey(source, target)}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ key, kind, source, target, directed, ...EDGE_STYLE[kind === 'project' && source.startsWith('p:') ? 'hub' : kind], ...extra });
  };
  const hub = (key, title, top, parent) => {
    if (!nodes.has(`p:${key}`)) {
      nodes.set(`p:${key}`, { key: `p:${key}`, kind: 'project', label: clip(title), fullLabel: title, pi: slot.get(top) ?? 0,
        sub: Boolean(parent), href: `#/project/${encodeURIComponent(key)}`, docs: 0 });
    }
    return nodes.get(`p:${key}`);
  };

  for (const d of shown) {
    const top = hub(d.project, projects[d.project]?.title || d.project, d.project);
    let home = top;
    if (d.subproject) {
      const subKey = projOf(d);
      home = hub(subKey, projects[subKey]?.title || d.subproject, d.project, top.key);
      addEdge('project', home.key, top.key);
    }
    top.docs++;
    if (home !== top) home.docs++;
    const title = String(d.title || `#${d.id}`);
    const locked = isLocked(d);
    const key = `d:${d.id}`;
    nodes.set(key, { key, kind: 'doc', docId: Number(d.id), label: (locked ? LOCK : '') + clip(title), fullLabel: (locked ? LOCK : '') + title,
      pi: slot.get(d.project) ?? 0, locked, href: `#/doc/${d.id}`, home: home.key });
    addEdge('project', key, home.key);
    for (const t of termsOf(d)) {
      const kk = `k:${t}`;
      if (!nodes.has(kk)) {
        nodes.set(kk, { key: kk, kind: 'keyword', label: clip(t), fullLabel: t, pi: -1, docs: 0,
          href: `#/list?k=${encodeURIComponent(t)}${scope ? `&p=${encodeURIComponent(scope)}` : ''}` });
      }
      nodes.get(kk).docs++;
      addEdge('keyword', key, kk);
    }
  }
  const linked = new Set();
  for (const d of shown) {
    for (const r of d.related || []) {
      if (!byId.has(Number(r))) continue;
      addEdge('related', `d:${d.id}`, `d:${Number(r)}`);
      linked.add(pairKey(Number(d.id), Number(r)));
    }
    if (d.supersedes != null && byId.has(Number(d.supersedes))) {
      addEdge('supersedes', `d:${d.id}`, `d:${Number(d.supersedes)}`); // arrow: newer → the doc it replaces
      linked.add(pairKey(Number(d.id), Number(d.supersedes)));
    }
  }
  const sims = similarPairs(shown, { cap: similarCap, minShared, exclude: linked });
  for (const s of sims) addEdge('similar', `d:${s.a}`, `d:${s.b}`, { weight: 0.5 + s.weight, size: 0.5 + 1.5 * s.weight, jaccard: s.weight, shared: s.shared });

  const degree = new Map();
  for (const e of edges) { degree.set(e.source, (degree.get(e.source) || 0) + 1); degree.set(e.target, (degree.get(e.target) || 0) + 1); }
  const list = [...nodes.values()];
  // Sigma sizes are screen pixels: shrink nodes as the graph grows so thousands of docs do not merge into one blob.
  const scale = list.length > 300 ? Math.max(0.4, Math.sqrt(300 / list.length)) : 1;
  for (const n of list) {
    n.degree = degree.get(n.key) || 0;
    n.size = n.kind === 'doc' ? scale * Math.min(14, 3.5 + 1.6 * Math.sqrt(n.degree))
      : n.kind === 'project' ? Math.sqrt(scale) * Math.min(n.sub ? 16 : 22, (n.sub ? 6 : 8) + 2 * Math.sqrt(n.docs))
        : scale * Math.min(7, 2.5 + 0.8 * Math.sqrt(n.docs));
  }
  seedPositions(list, slot.size || 1, salt);
  const shownTops = [...new Set(shown.map((d) => d.project))].sort((a, b) => a.localeCompare(b));
  return {
    nodes: list,
    edges,
    projects: shownTops.map((k) => ({ key: k, title: projects[k]?.title || k, pi: slot.get(k) ?? 0 })),
    slots: slot.size || 1,
    stats: { docs: shown.length, nodes: list.length, edges: edges.length, similar: sims.length,
      keywords: list.filter((n) => n.kind === 'keyword').length },
  };
}

// Projects on a ring by palette slot, subprojects and docs scattered near their hub, keywords anywhere.
export function seedPositions(list, slots, salt = 0) {
  const R = 100;
  const nodes = new Map(list.map((n) => [n.key, n]));
  const place = (n, cx, cy, r) => { const rnd = seeded(n.key, salt); const a = rnd() * Math.PI * 2; const d = r * Math.sqrt(rnd()); n.x = cx + Math.cos(a) * d; n.y = cy + Math.sin(a) * d; };
  for (const n of list) {
    if (n.kind !== 'project' || n.sub) continue;
    const a = (2 * Math.PI * n.pi) / slots + seeded(n.key, salt)() * 0.4;
    n.x = Math.cos(a) * R; n.y = Math.sin(a) * R;
  }
  const parentOf = (n) => nodes.get(n.key.slice(0, n.key.lastIndexOf('/'))) || { x: 0, y: 0 };
  for (const n of list) if (n.kind === 'project' && n.sub) { const p = parentOf(n); place(n, p.x, p.y, 25); }
  for (const n of list) if (n.kind === 'doc') { const h = nodes.get(n.home) || { x: 0, y: 0 }; place(n, h.x, h.y, 35); }
  for (const n of list) if (n.kind === 'keyword') place(n, 0, 0, R * 1.3);
}

// ---------- colour helpers (pure) ----------
export function parseColor(s) {
  const v = String(s || '').trim();
  let m = v.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    const h = m[1].length <= 4 ? [...m[1].slice(0, 3)].map((c) => c + c).join('') : m[1].slice(0, 6);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  return m ? [m[1], m[2], m[3]].map(Number) : null;
}
const toHex = (rgb) => `#${rgb.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
export function mix(a, b, t) {
  const x = parseColor(a), y = parseColor(b);
  if (!x || !y) return a;
  return toHex(x.map((c, i) => c + (y[i] - c) * t));
}
const luminance = (rgb) => (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;

// ---------- browser part ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const scripts = new Map();
let current = null;
let generation = 0;

function loadScript([src, integrity]) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous'; s.integrity = integrity; s.referrerPolicy = 'no-referrer';
      s.onload = ok;
      s.onerror = () => { scripts.delete(src); s.remove(); fail(new Error(`load failed: ${src}`)); };
      document.head.appendChild(s);
    }));
  }
  return scripts.get(src);
}

async function loadLibs() {
  const [, , fa2, fa2w] = await Promise.all([
    window.graphology || loadScript(LIBS.graphology),
    window.Sigma || loadScript(LIBS.sigma),
    import(LIBS.fa2),
    import(LIBS.fa2Worker).catch(() => null), // optional: the synchronous fallback covers it
  ]);
  return { Graph: window.graphology.Graph, Sigma: window.Sigma, forceAtlas2: fa2.default, FA2Layout: fa2w?.default || null };
}

function ensureCss() {
  if (document.querySelector('link[data-graph-css]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = new URL('graph.css', import.meta.url).href;
  l.dataset.graphCss = '';
  document.head.appendChild(l);
}

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
  const bg = v('--surface', '#ffffff');
  const dark = luminance(parseColor(bg) || [255, 255, 255]) < 0.45;
  const fg = v('--fg', dark ? '#e3e9ec' : '#18242b');
  const muted = v('--muted', '#5d6b73');
  const accent = v('--accent', '#245c73');
  return {
    dark, bg, fg, muted, accent,
    font: getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif',
    palette: dark ? PALETTE_DARK : PALETTE_LIGHT,
    keyword: mix(muted, bg, 0.15),
    dim: mix(muted, bg, 0.82),
    dimEdge: mix(muted, bg, 0.9),
    edge: {
      project: mix(muted, bg, 0.55),
      keyword: mix(muted, bg, 0.72),
      related: accent,
      supersedes: v('--sv2-fg', dark ? '#f3c96b' : '#7a4d00'),
      similar: mix(accent, bg, 0.5),
    },
  };
}

const nodeColor = (theme, a) => (a.kind === 'keyword' ? theme.keyword : theme.palette[a.pi] || theme.palette[0]);
const layerOf = (kind) => ({ keyword: 'keyword', project: 'project', similar: 'similar' }[kind]);

function legendHtml(data, theme) {
  const sw = (c) => `<i class="gx-dot" style="background:${esc(c)}"></i>`;
  const ln = (c, arrow) => `<i class="gx-line${arrow ? ' gx-arrow' : ''}" style="--c:${esc(c)}"></i>`;
  return `<summary>圖例</summary>
    <div class="gx-leg-row"><b>專案</b>${data.projects.map((p) => `<span>${sw(theme.palette[p.pi])}${esc(p.title)}</span>`).join('')}</div>
    <div class="gx-leg-row"><b>節點</b><span>${sw(theme.muted)}文件（越大＝關聯越多）</span><span><i class="gx-dot gx-hub" style="background:${esc(theme.muted)}"></i>專案／子專案</span><span>${sw(theme.keyword)}<small>關鍵字／標籤</small></span><span>🔒 機密／極機密</span></div>
    <div class="gx-leg-row"><b>連線</b><span>${ln(theme.edge.related)}相關</span><span>${ln(theme.edge.supersedes, true)}取代（新 → 舊）</span><span>${ln(theme.edge.similar)}相似（共同關鍵字）</span><span>${ln(theme.edge.project)}專案</span><span>${ln(theme.edge.keyword)}關鍵字</span></div>`;
}

function shellHtml(data, scope, site) {
  const docs = data.nodes.filter((n) => n.kind === 'doc');
  const where = scope ? `專案 ${scope}` : (site?.title || '全部專案');
  return `<section class="gx" aria-label="關聯圖">
    <div class="gx-bar" role="toolbar" aria-label="關聯圖工具">
      <label class="gx-search"><span class="sr">在圖中尋找</span>
        <input type="search" list="gx-names" placeholder="找文件、專案或關鍵字…" autocomplete="off" enterkeyhint="search"></label>
      <datalist id="gx-names">${[...new Set(data.nodes.map((n) => n.fullLabel.replace(LOCK, '')))].map((l) => `<option value="${esc(l)}"></option>`).join('')}</datalist>
      <fieldset class="gx-layers"><legend class="sr">圖層</legend>
        <label><input type="checkbox" data-layer="keyword" checked>關鍵字</label>
        <label><input type="checkbox" data-layer="similar" checked>相似</label>
        <label><input type="checkbox" data-layer="project" checked>專案</label>
      </fieldset>
      <div class="gx-btns">
        <button type="button" data-act="relayout">重新排列</button>
        <button type="button" data-act="in" aria-label="放大" title="放大">＋</button>
        <button type="button" data-act="out" aria-label="縮小" title="縮小">－</button>
        <button type="button" data-act="reset" aria-label="重設視角" title="重設視角">⟲</button>
      </div>
      <span class="gx-status" role="status" aria-live="polite"></span>
    </div>
    <div class="gx-stage" role="img" aria-label="關聯圖：${esc(where)}，${data.stats.docs} 份文件、${data.stats.edges} 條連線。滑鼠移到節點上會標示相鄰節點，點一下開啟。文件清單在圖下方（螢幕閱讀器可讀）。"></div>
    <details class="gx-legend"${matchMedia('(min-width: 761px)').matches ? ' open' : ''}></details>
    <nav class="sr" aria-label="圖中的文件"><ul>${docs.map((n) => `<li><a href="${esc(n.href)}">${esc(n.fullLabel.replace(LOCK, ''))}</a>${n.locked ? '（機密）' : ''}</li>`).join('')}</ul></nav>
  </section>`;
}

// Sigma's built-in hover box is always white; draw one from the theme so dark mode stays legible.
function drawHover(ctx) {
  return (c, data, settings) => {
    const theme = ctx.theme;
    const size = settings.labelSize;
    c.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
    const label = data.label || '';
    const w = label ? c.measureText(label).width + 10 : 0;
    const r = data.size + 3;
    const h = Math.max(size + 8, r * 2);
    c.save();
    c.fillStyle = theme.bg;
    c.strokeStyle = theme.muted;
    c.lineWidth = 1;
    c.shadowColor = 'rgba(0,0,0,0.25)';
    c.shadowBlur = 8;
    c.beginPath();
    if (c.roundRect) c.roundRect(data.x - r, data.y - h / 2, r * 2 + w, h, 6); else c.rect(data.x - r, data.y - h / 2, r * 2 + w, h);
    c.fill();
    c.shadowBlur = 0;
    c.stroke();
    if (label) { c.fillStyle = theme.fg; c.fillText(label, data.x + data.size + 6, data.y + size / 3); }
    c.restore();
  };
}

function focusSet(ctx, node) {
  const set = new Set([node]);
  ctx.graph.forEachEdge(node, (e, a, s, t) => { if (edgeVisible(ctx, a)) set.add(s === node ? t : s); });
  return set;
}
const nodeVisible = (ctx, a) => (a.kind === 'doc' ? true : ctx.layers[a.kind === 'keyword' ? 'keyword' : 'project']);
const edgeVisible = (ctx, a) => { const l = layerOf(a.kind); return !l || ctx.layers[l]; };
const focusOf = (ctx) => ctx.hovered || ctx.selected;

function setFocus(ctx, key, field) {
  ctx[field] = key;
  const f = focusOf(ctx);
  ctx.near = f ? focusSet(ctx, f) : null;
  ctx.sigma.refresh({ skipIndexation: true });
}

function nodeReducer(ctx) {
  return (node, a) => {
    const res = { ...a, color: nodeColor(ctx.theme, a) };
    if (!nodeVisible(ctx, a)) { res.hidden = true; return res; }
    if (a.kind === 'project' && !a.sub) res.forceLabel = true;
    const f = focusOf(ctx);
    if (!f) return res;
    if (node === f) { res.highlighted = true; res.label = a.fullLabel; res.zIndex = 2; res.forceLabel = true; } else if (ctx.near.has(node)) { res.zIndex = 1; res.forceLabel = true; } else { res.color = ctx.theme.dim; res.label = ''; res.zIndex = 0; res.forceLabel = false; }
    return res;
  };
}

function edgeReducer(ctx) {
  return (edge, a) => {
    const res = { ...a, color: ctx.theme.edge[a.kind] };
    if (!edgeVisible(ctx, a)) { res.hidden = true; return res; }
    const f = focusOf(ctx);
    if (!f) return res;
    const [s, t] = ctx.graph.extremities(edge);
    if (s === f || t === f) { res.size = a.size + 0.8; res.zIndex = 1; } else { res.color = ctx.theme.dimEdge; res.zIndex = 0; }
    return res;
  };
}

function buildGraph(Graph, data) {
  const g = new Graph({ type: 'mixed', multi: true, allowSelfLoops: false });
  for (const n of data.nodes) {
    const { key, ...attrs } = n;
    g.addNode(key, attrs);
  }
  for (const e of data.edges) {
    const attrs = { kind: e.kind, weight: e.weight, size: e.size, ...(e.directed ? { type: 'arrow' } : {}) };
    if (e.directed) g.addDirectedEdgeWithKey(e.key, e.source, e.target, attrs);
    else g.addUndirectedEdgeWithKey(e.key, e.source, e.target, attrs);
  }
  return g;
}

function status(ctx, text) {
  const el = ctx.root.querySelector('.gx-status');
  if (el) el.textContent = text;
}
const summary = (ctx) => `${ctx.data.stats.docs} 份文件 · ${ctx.data.stats.nodes} 節點 · ${ctx.data.stats.edges} 連線`;

function stopLayout(ctx) {
  if (ctx.layout) { ctx.layout.kill(); ctx.layout = null; }
  if (ctx.raf) { cancelAnimationFrame(ctx.raf); ctx.raf = 0; }
  ctx.timers.forEach(clearTimeout);
  ctx.timers.clear();
}

function finishLayout(ctx) {
  stopLayout(ctx);
  status(ctx, summary(ctx));
}

function runLayout(ctx) {
  stopLayout(ctx);
  const { graph, libs } = ctx;
  const settings = { ...libs.forceAtlas2.inferSettings(graph), edgeWeightInfluence: 1 };
  status(ctx, '排列中…');
  if (libs.FA2Layout && typeof Worker === 'function') {
    try {
      const layout = new libs.FA2Layout(graph, { settings, getEdgeWeight: 'weight' });
      // A worker that fails to boot (blocked blob: URLs, broken build) only reports through its error event.
      layout.worker?.addEventListener('error', () => { if (ctx.layout === layout) { stopLayout(ctx); runSyncLayout(ctx, settings); } });
      ctx.layout = layout;
      layout.start();
      const ms = Math.min(8000, Math.max(2000, 1500 + graph.order * 1.5));
      ctx.timers.add(setTimeout(() => finishLayout(ctx), ms));
      return;
    } catch { /* no worker available: fall through to the main-thread layout */ }
  }
  runSyncLayout(ctx, settings);
}

// Main-thread fallback: a fixed iteration budget, sliced per animation frame at ~25 ms per slice.
function runSyncLayout(ctx, settings) {
  const { graph, libs } = ctx;
  let left = Math.max(80, Math.min(400, Math.round(3e5 / Math.max(1, graph.order + graph.size))));
  let step = 1;
  const tick = () => {
    const t0 = performance.now();
    libs.forceAtlas2.assign(graph, { iterations: Math.min(step, left), settings, getEdgeWeight: 'weight' });
    left -= step;
    const dt = performance.now() - t0;
    step = Math.max(1, Math.min(50, Math.floor((step * 25) / Math.max(dt, 1))));
    if (left > 0) ctx.raf = requestAnimationFrame(tick); else finishLayout(ctx);
  };
  ctx.raf = requestAnimationFrame(tick);
}

function reseed(ctx) {
  stopLayout(ctx);
  ctx.salt++;
  const list = ctx.data.nodes.map((n) => ({ ...n }));
  seedPositions(list, ctx.data.slots, ctx.salt);
  for (const n of list) ctx.graph.mergeNodeAttributes(n.key, { x: n.x, y: n.y });
}

function findNode(ctx, text) {
  const q = text.trim().toLowerCase();
  if (!q) return null;
  let hit = null, partial = null;
  ctx.graph.forEachNode((key, a) => {
    if (hit || !nodeVisible(ctx, a)) return;
    const l = a.fullLabel.replace(LOCK, '').toLowerCase();
    if (l === q) hit = key; else if (!partial && l.includes(q)) partial = key;
  });
  return hit || partial;
}

function focusNode(ctx, key) {
  setFocus(ctx, key, 'selected');
  const pos = ctx.sigma.getNodeDisplayData(key);
  if (pos) ctx.sigma.getCamera().animate({ x: pos.x, y: pos.y, ratio: 0.35 }, { duration: 500 });
  status(ctx, ctx.graph.getNodeAttribute(key, 'fullLabel'));
}

function bindToolbar(ctx) {
  const { root, signal } = ctx;
  const input = root.querySelector('.gx-search input');
  const search = () => {
    const key = findNode(ctx, input.value);
    if (key) focusNode(ctx, key); else if (input.value.trim()) status(ctx, `找不到「${input.value.trim()}」`);
  };
  input.addEventListener('change', search, { signal });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }, { signal });
  root.querySelectorAll('input[data-layer]').forEach((cb) => cb.addEventListener('change', () => {
    ctx.layers[cb.dataset.layer] = cb.checked;
    const f = focusOf(ctx);
    if (f && !nodeVisible(ctx, ctx.graph.getNodeAttributes(f))) { ctx.hovered = null; ctx.selected = null; }
    ctx.near = focusOf(ctx) ? focusSet(ctx, focusOf(ctx)) : null;
    ctx.sigma.refresh();
  }, { signal }));
  const cam = () => ctx.sigma.getCamera();
  const acts = {
    relayout: () => { reseed(ctx); runLayout(ctx); cam().animatedReset({ duration: 300 }); },
    in: () => cam().animatedZoom({ duration: 250 }),
    out: () => cam().animatedUnzoom({ duration: 250 }),
    reset: () => { setFocus(ctx, null, 'selected'); cam().animatedReset({ duration: 300 }); },
  };
  root.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => acts[b.dataset.act](), { signal }));
}

function bindSigma(ctx, go) {
  const { sigma, stage } = ctx;
  sigma.on('enterNode', ({ node }) => { stage.style.cursor = 'pointer'; setFocus(ctx, node, 'hovered'); });
  sigma.on('leaveNode', () => { stage.style.cursor = ''; setFocus(ctx, null, 'hovered'); });
  sigma.on('clickNode', ({ node, event }) => {
    const touch = event?.original && 'touches' in event.original;
    // On touch there is no hover: the first tap shows the neighbourhood, a second tap on the same node opens it.
    if (touch && ctx.selected !== node) { focusNode(ctx, node); return; }
    const href = ctx.graph.getNodeAttribute(node, 'href');
    if (href && typeof go === 'function') go(href);
  });
  sigma.on('clickStage', () => { if (ctx.selected) setFocus(ctx, null, 'selected'); });
}

function applyTheme(ctx) {
  ctx.theme = readTheme();
  ctx.sigma.setSetting('labelColor', { color: ctx.theme.fg });
  ctx.sigma.setSetting('labelFont', ctx.theme.font);
  ctx.root.querySelector('.gx-legend').innerHTML = legendHtml(ctx.data, ctx.theme);
}

function watchTheme(ctx) {
  let pending = 0;
  const update = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(() => { if (current === ctx) applyTheme(ctx); }); };
  ctx.mo = new MutationObserver(update);
  ctx.mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  ctx.mq = matchMedia('(prefers-color-scheme: dark)');
  ctx.mq.addEventListener('change', update, { signal: ctx.signal });
}

function fitHeight(ctx) {
  const top = document.querySelector('.topbar')?.offsetHeight || 0;
  const foot = document.querySelector('.foot')?.offsetHeight || 0;
  const main = ctx.root.closest('main');
  const pad = main ? parseFloat(getComputedStyle(main).paddingTop) + parseFloat(getComputedStyle(main).paddingBottom) : 0;
  const vh = window.visualViewport?.height || window.innerHeight;
  ctx.root.style.height = `${Math.max(420, Math.floor(vh - top - foot - pad))}px`;
}

/** Render the graph into `container` (its contents are replaced). */
export async function renderGraph(container, { docs = [], projects = {}, site = null, scope = '', go } = {}) {
  disposeGraph();
  const gen = generation;
  ensureCss();
  const libsLoading = loadLibs();
  libsLoading.catch(() => {}); // handled below; avoids an unhandled rejection if disposed first
  const frame = () => new Promise((ok) => requestAnimationFrame(ok));
  container.innerHTML = '<p class="loading">載入關聯圖…</p>';
  await frame();
  if (gen !== generation) return;
  const data = buildGraphData(docs, { projects, scope });
  await frame(); // building and rendering the shell are separate tasks: each stays short on big catalogs
  if (gen !== generation) return;
  container.innerHTML = shellHtml(data, scope, site);
  const root = container.querySelector('.gx');
  const stage = root.querySelector('.gx-stage');
  const abort = new AbortController();
  const ctx = { root, stage, data, salt: 0, abort, signal: abort.signal, timers: new Set(),
    layers: { keyword: true, similar: true, project: true }, hovered: null, selected: null, near: null, raf: 0 };
  current = ctx;
  fitHeight(ctx);
  window.addEventListener('resize', () => fitHeight(ctx), { signal: ctx.signal });
  if (!data.stats.docs) { stage.innerHTML = '<p class="empty">這個範圍沒有文件。</p>'; return; }
  status(ctx, '載入圖形元件…');
  try {
    ctx.libs = await libsLoading;
  } catch {
    if (gen === generation) { stage.innerHTML = '<p class="empty">無法載入關聯圖元件（CDN 無法連線）。</p>'; status(ctx, ''); }
    return;
  }
  if (gen !== generation) return; // disposed or re-rendered while loading
  ctx.graph = buildGraph(ctx.libs.Graph, data);
  await frame();
  if (gen !== generation) return;
  ctx.theme = readTheme();
  ctx.sigma = new ctx.libs.Sigma(ctx.graph, stage, {
    allowInvalidContainer: true,
    zIndex: true,
    labelFont: ctx.theme.font,
    labelSize: 12,
    labelWeight: '500',
    labelColor: { color: ctx.theme.fg },
    labelDensity: 0.6,
    labelGridCellSize: 90,
    labelRenderedSizeThreshold: 7,
    hideEdgesOnMove: ctx.graph.order > 2000,
    minCameraRatio: 0.03,
    maxCameraRatio: 4,
    nodeReducer: nodeReducer(ctx),
    edgeReducer: edgeReducer(ctx),
    defaultDrawNodeHover: drawHover(ctx),
  });
  ctx.root.querySelector('.gx-legend').innerHTML = legendHtml(data, ctx.theme);
  bindSigma(ctx, go);
  bindToolbar(ctx);
  watchTheme(ctx);
  runLayout(ctx);
}

/** Tear down the current graph: layout worker, timers, observers, listeners and the WebGL context. */
export function disposeGraph() {
  generation++;
  const ctx = current;
  current = null;
  if (!ctx) return;
  stopLayout(ctx);
  ctx.abort.abort();
  ctx.mo?.disconnect();
  ctx.sigma?.kill();
  ctx.sigma = null;
  ctx.graph = null;
}
