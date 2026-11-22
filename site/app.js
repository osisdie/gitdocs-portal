// gitdocs portal — hash-routed SPA over catalog.json + search-index.json (+ vault.json for masked fields).
// Routes: #/list  #/summary  #/timeline  #/project/<name>  #/doc/<id>   — every route accepts ?p=<project[/sub]> as the global scope.
import { parseQuery, matchDoc, needsBody, QUERY_HELP, SENSITIVITIES, sensRank } from './query.js';
import { mask as vaultMask, lock as vaultLock, isUnlocked as vaultUnlocked } from './vault.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(7, '0');
const STATUS_VAR = { '草稿': '--st-draft', '審查中': '--st-review', '本機': '--st-local', '已發布': '--st-published', '封存': '--st-archived' };
const stStyle = (s) => `--st: var(${STATUS_VAR[s] || '--st-local'})`;
const LOCK = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="2.5" y="7" width="11" height="7.5" rx="1.5" fill="currentColor"/></svg>';
const sensBadge = (s) => `<span class="sens sv${sensRank(s)}" title="機敏性：${esc(s)}">${sensRank(s) > 0 ? LOCK : ''}${esc(s)}</span>`;
const app = $('#app');
const qInput = $('#q');
const LS_KEY = 'gitdocs:filters';

let DATA = null;
let BODY = null;
let bodyLoading = null;

// ---------- small utils ----------
const uniq = (arr) => [...new Set(arr)].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
const opt = (v, cur, label = v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
const projOf = (d) => d.project + (d.subproject ? `/${d.subproject}` : '');
const inScope = (d, p) => !p || d.project === p || projOf(d) === p;
const scoped = (p) => DATA.docs.filter((d) => inScope(d, p));
const byId = (id) => DATA.docs.find((d) => d.id === Number(id));
const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } };
const lsSet = (v) => { try { localStorage.setItem(LS_KEY, JSON.stringify(v)); return true; } catch { return false; } };
function link(view, params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x)); else if (v) sp.set(k, v);
  }
  const qs = sp.toString();
  return `#/${view}${qs ? '?' + qs : ''}`;
}
const scopeLink = (view, p, extra = {}) => link(view, { p, ...extra });

// ---------- theme ----------
const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
try { applyTheme(localStorage.getItem('theme')); } catch { /* storage blocked */ }
$('#theme').addEventListener('click', () => {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const cur = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('theme', next); } catch { /* ignore */ }
});

// ---------- routing ----------
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '') || 'list';
  const qi = h.indexOf('?');
  const route = qi < 0 ? h : h.slice(0, qi);
  const params = new URLSearchParams(qi < 0 ? '' : h.slice(qi + 1));
  const slash = route.indexOf('/');
  const view = slash < 0 ? route : route.slice(0, slash);
  const arg = slash < 0 ? '' : decodeURIComponent(route.slice(slash + 1));
  return { view, arg, params };
}
function go(view, params, replace = false) {
  const qs = params.toString();
  const h = `#/${view}${qs ? '?' + qs : ''}`;
  if (replace) { history.replaceState(null, '', h); render(); } else location.hash = h;
}

// ---------- search body ----------
async function ensureBody() {
  if (BODY) return;
  bodyLoading ||= fetch('search-index.json').then((r) => r.json()).then((rows) => { BODY = new Map(rows.map((r) => [r.id, r.t])); });
  await bodyLoading;
}
function highlight(text, ts) {
  let out = esc(text);
  for (const t of ts) {
    const re = new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return out;
}

// ---------- shared fragments ----------
function chips(d, params, max = 8) {
  const ks = new Set(params ? params.getAll('k') : []);
  const mk = (t, cls) => {
    const p = new URLSearchParams(params || ''); if (!ks.has(t)) p.append('k', t);
    return `<a class="chip ${cls}${ks.has(t) ? ' on' : ''}" href="#/list?${p}">${cls === 'tag' ? '#' : ''}${esc(t)}</a>`;
  };
  const all = [...(d.tags || []).map((t) => mk(t, 'tag')), ...(d.keywords || []).map((t) => mk(t, 'kw'))];
  return all.length ? `<div class="chips">${all.slice(0, max).join('')}${all.length > max ? `<span class="dim">+${all.length - max}</span>` : ''}</div>` : '';
}
const docLink = (d) => `<a href="#/doc/${d.id}">${esc(d.title)}</a>`;
const projectCell = (d) => `<a href="#/project/${encodeURIComponent(d.project)}">${esc(d.project)}</a>${d.subproject ? ` / <a href="#/project/${encodeURIComponent(projOf(d))}">${esc(d.subproject)}</a>` : ''}`;

// ---------- list ----------
async function viewList(params) {
  const q = params.get('q') || '';
  if (qInput.value !== q && document.activeElement !== qInput) qInput.value = q;
  const p = params.get('p') || '';
  const f = { c: params.get('c') || '', s: params.get('s') || '', sv: params.get('sv') || '', ty: params.get('ty') || '' };
  const ks = params.getAll('k');
  const pq = parseQuery(q);
  const sort = params.get('sort') || (pq.terms.length ? 'score' : 'date');
  const dir = params.get('dir') || (['title', 'project'].includes(sort) ? 'asc' : 'desc');
  if (needsBody(pq)) await ensureBody();
  const highlightTerms = pq.terms;

  const base = scoped(p);
  let rows = base.filter((d) => (!f.c || d.category === f.c) && (!f.s || d.status === f.s) && (!f.sv || d.sensitivity === f.sv)
    && (!f.ty || d.type === f.ty) && ks.every((k) => (d.tags || []).includes(k) || (d.keywords || []).includes(k)));
  rows = rows.map((d) => ({ d, m: matchDoc(d, pq, BODY ? (BODY.get(d.id) || '') : '') })).filter((r) => r.m);
  const key = {
    id: (r) => r.d.id, date: (r) => r.d.date + pad(r.d.id), title: (r) => r.d.title, project: (r) => projOf(r.d),
    category: (r) => r.d.category, status: (r) => r.d.status, sens: (r) => sensRank(r.d.sensitivity), score: (r) => r.m.score * 1e8 + Number(r.d.date.replace(/-/g, '')),
  }[sort] || ((r) => r.d.date);
  rows.sort((a, b) => { const x = key(a), y = key(b); const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-Hant'); return dir === 'asc' ? c : -c; });

  const sel = (name, label, values, cur) => `<label>${label}<select data-f="${name}">${opt('', cur, '（全部）')}${values.map((v) => opt(v, cur)).join('')}</select></label>`;
  const th = (k, label, cls = '') => `<th class="${cls}" data-sort="${k}"${sort === k ? ` aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${label}</th>`;
  const anyFilter = q || ks.length || Object.values(f).some(Boolean);
  const kwOptions = uniq(base.flatMap((d) => [...(d.tags || []), ...(d.keywords || [])])).filter((k) => !ks.includes(k));
  const local = lsGet();
  const curQs = (() => { const c = new URLSearchParams(params); c.delete('sort'); c.delete('dir'); return c.toString(); })();

  app.innerHTML = `
    <section class="saved" aria-label="儲存的篩選">
      <span class="dim">篩選：</span>
      ${DATA.filters.map((sf) => `<a class="chip saved-chip${q === sf.query && !ks.length ? ' on' : ''}" href="${scopeLink('list', p, { q: sf.query })}">${esc(sf.name)}</a>`).join('')}
      ${local.map((sf, i) => `<span class="chip saved-chip local${curQs === sf.params ? ' on' : ''}"><a href="#/list?${esc(sf.params)}">${esc(sf.name)}</a><button type="button" data-del="${i}" aria-label="刪除「${esc(sf.name)}」">×</button></span>`).join('')}
      ${anyFilter ? '<button type="button" id="save" class="linkish">＋ 儲存目前篩選</button>' : ''}
    </section>
    <section class="filters" aria-label="篩選">
      ${sel('c', '分類', DATA.categories.filter((c) => base.some((d) => d.category === c)), f.c)}
      ${sel('s', '狀態', DATA.statuses.filter((s) => base.some((d) => d.status === s)), f.s)}
      ${sel('sv', '機敏', SENSITIVITIES.filter((s) => base.some((d) => d.sensitivity === s)), f.sv)}
      ${sel('ty', '格式', uniq(base.map((d) => d.type)), f.ty)}
      <label>關鍵字／標籤<select id="addk">${opt('', '', ks.length ? '再加一個…' : '（全部）')}${kwOptions.map((k) => opt(k, '')).join('')}</select></label>
    </section>
    ${ks.length ? `<div class="chips active">${ks.map((k) => { const n = new URLSearchParams(params); const rest = ks.filter((x) => x !== k); n.delete('k'); rest.forEach((x) => n.append('k', x)); return `<a class="chip kw on" href="#/list?${n}" title="移除">${esc(k)} ×</a>`; }).join('')}</div>` : ''}
    <div class="bar">
      <span>顯示 <b>${rows.length}</b> / ${base.length} 份文件${p ? `（專案 ${esc(p)}）` : ''}${q ? `，搜尋「${esc(q)}」` : ''}</span>
      ${anyFilter ? '<button type="button" id="reset">清除篩選</button>' : ''}
    </div>
    ${rows.length ? `<div class="tbl-wrap"><table class="docs">
      <thead><tr>${th('id', '編號')}${th('status', '狀態', 'c-st')}${th('sens', '機敏')}${th('project', '專案', 'c-proj')}${th('category', '分類', 'c-cat')}${th('title', '標題')}${th('date', '日期', 'c-date')}<th class="c-type">格式</th></tr></thead>
      <tbody>${rows.map(({ d, m }) => `
        <tr class="st" style="${stStyle(d.status)}">
          <td class="id"><a href="#/doc/${d.id}">${pad(d.id)}</a></td>
          <td class="c-st"><span class="chip status" style="${stStyle(d.status)}">${esc(d.status)}</span></td>
          <td>${sensBadge(d.sensitivity)}</td>
          <td class="c-proj nowrap">${projectCell(d)}</td>
          <td class="c-cat nowrap">${esc(d.category)}</td>
          <td class="title"><a href="#/doc/${d.id}">${highlight(d.title, highlightTerms)}</a>${d.offline ? ' <span class="offline">僅存 git，未上傳</span>' : ''}
            ${d.desc ? `<div class="desc">${highlight(d.desc, highlightTerms)}</div>` : ''}
            ${m.snip ? `<div class="snip">${highlight(m.snip, highlightTerms)}</div>` : ''}
            ${chips(d, params, 6)}</td>
          <td class="c-date nowrap dim">${esc(d.date)}</td>
          <td class="c-type type">${esc(d.type)}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="empty">沒有符合條件的文件。</p>'}`;

  app.querySelectorAll('select[data-f]').forEach((s) => s.addEventListener('change', () => {
    const n = new URLSearchParams(params); s.value ? n.set(s.dataset.f, s.value) : n.delete(s.dataset.f); go('list', n, true);
  }));
  $('#addk').addEventListener('change', (e) => { if (!e.target.value) return; const n = new URLSearchParams(params); n.append('k', e.target.value); go('list', n, true); });
  app.querySelectorAll('th[data-sort]').forEach((h) => h.addEventListener('click', () => {
    const n = new URLSearchParams(params); const k = h.dataset.sort;
    n.set('sort', k); n.set('dir', sort === k ? (dir === 'desc' ? 'asc' : 'desc') : (['title', 'project'].includes(k) ? 'asc' : 'desc')); go('list', n, true);
  }));
  $('#reset')?.addEventListener('click', () => { qInput.value = ''; go('list', new URLSearchParams(p ? { p } : {}), true); });
  $('#save')?.addEventListener('click', () => {
    const name = (prompt('篩選名稱：', q || ks.join(' ') || '我的篩選') || '').trim();
    if (!name) return;
    const list = lsGet().filter((x) => x.name !== name).concat({ name, params: curQs });
    if (!lsSet(list)) alert('瀏覽器不允許儲存（可能是無痕模式）。');
    render();
  });
  app.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', () => {
    const list = lsGet(); list.splice(Number(b.dataset.del), 1); lsSet(list); render();
  }));
}

// ---------- summary ----------
function countTable(docs, rowsOf, cols, field, colKey, rowLabel, rowLink) {
  const rows = uniq(docs.map(rowsOf));
  const cell = (n, params) => n ? `<a href="${link('list', params)}">${n}</a>` : '<span class="zero">0</span>';
  return `<table class="matrix"><thead><tr><th>${esc(rowLabel)}</th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}<th>合計</th></tr></thead>
    <tbody>${rows.map((r) => {
      const rd = docs.filter((d) => rowsOf(d) === r);
      return `<tr><td><a href="${link('list', rowLink(r))}">${esc(r)}</a></td>${cols.map((c) => `<td>${cell(rd.filter((d) => d[field] === c).length, { ...rowLink(r), [colKey]: c })}</td>`).join('')}<td>${cell(rd.length, rowLink(r))}</td></tr>`;
    }).join('')}</tbody>
    <tfoot><tr><td>合計</td>${cols.map((c) => `<td>${docs.filter((d) => d[field] === c).length}</td>`).join('')}<td>${docs.length}</td></tr></tfoot></table>`;
}
function kwCloud(docs, p) {
  const counts = {};
  docs.forEach((d) => [...(d.tags || []), ...(d.keywords || [])].forEach((k) => { counts[k] = (counts[k] || 0) + 1; }));
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hant'));
  if (!entries.length) return '<p class="dim">沒有關鍵字。</p>';
  const max = entries[0][1];
  return `<div class="cloud">${entries.map(([k, n]) => `<a href="${scopeLink('list', p, { k })}" style="font-size:${(12 + 10 * (n / max)).toFixed(1)}px">${esc(k)}<sup>${n}</sup></a>`).join('')}</div>`;
}
function viewSummary(params) {
  const p = params.get('p') || '';
  const docs = scoped(p);
  const isTop = p && !p.includes('/');
  const rowsOf = p ? (isTop ? (d) => d.subproject || '（本專案）' : () => p) : (d) => d.project;
  const rowLink = (r) => ({ p: p ? (isTop && r !== '（本專案）' ? `${p}/${r}` : p) : r });
  const cats = DATA.categories.filter((c) => docs.some((d) => d.category === c));
  const sts = DATA.statuses.filter((s) => docs.some((d) => d.status === s));
  const svs = SENSITIVITIES.filter((s) => docs.some((d) => d.sensitivity === s));
  const label = p ? (isTop ? '子專案' : '專案') : '專案';
  const byMonth = {};
  docs.forEach((d) => { const m = d.date.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; });
  app.innerHTML = `
    <nav class="toc" aria-label="目錄"><b>目錄</b>${['依分類', '依狀態', '依機敏性', '關鍵字雲', '依月份'].map((t, i) => `<button type="button" data-jump="sec${i}">${t}</button>`).join('')}</nav>
    <div class="grid2">
      <section class="card" id="sec0"><h2>依分類</h2>${countTable(docs, rowsOf, cats, 'category', 'c', label, rowLink)}</section>
      <section class="card" id="sec1"><h2>依狀態</h2>${countTable(docs, rowsOf, sts, 'status', 's', label, rowLink)}</section>
      <section class="card" id="sec2"><h2>依機敏性</h2>${countTable(docs, rowsOf, svs, 'sensitivity', 'sv', label, rowLink)}</section>
      <section class="card" id="sec3"><h2>關鍵字雲</h2>${kwCloud(docs, p)}</section>
      <section class="card" id="sec4"><h2>依月份</h2><table class="matrix"><thead><tr><th>月份</th><th>文件數</th></tr></thead><tbody>
        ${Object.keys(byMonth).sort().reverse().map((m) => `<tr><td>${m}</td><td><a href="${scopeLink('list', p, { q: `date:${m}` })}">${byMonth[m]}</a></td></tr>`).join('')}</tbody></table></section>
    </div>`;
  bindJumps();
}
function bindJumps() {
  app.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
}

// ---------- timeline ----------
function viewTimeline(params) {
  const docs = scoped(params.get('p') || '');
  let month = '';
  app.innerHTML = docs.length ? docs.map((d) => {
    const m = d.date.slice(0, 7);
    const head = m !== month ? `<div class="tl-month">${m}</div>` : '';
    month = m;
    return `${head}<div class="tl-item" style="${stStyle(d.status)}"><div class="dim nowrap">${esc(d.date)} · ${pad(d.id)}</div>
      <div>${docLink(d)} ${sensBadge(d.sensitivity)} <span class="chip">${esc(projOf(d))}</span> <span class="chip">${esc(d.category)}</span>
      ${d.desc ? `<div class="desc">${esc(d.desc)}</div>` : ''}</div></div>`;
  }).join('') : '<p class="empty">這個範圍沒有文件。</p>';
}

// ---------- project ----------
function miniCounts(docs, field, values, colKey, p) {
  return `<table class="matrix"><tbody>${values.filter((v) => docs.some((d) => d[field] === v)).map((v) =>
    `<tr><td>${field === 'sensitivity' ? sensBadge(v) : esc(v)}</td><td><a href="${scopeLink('list', p, { [colKey]: v })}">${docs.filter((d) => d[field] === v).length}</a></td></tr>`).join('')}</tbody></table>`;
}
function viewProject(name) {
  const info = DATA.projects[name];
  const docs = scoped(name);
  if (!info && !docs.length) { app.innerHTML = '<p class="empty">找不到這個專案。</p>'; return; }
  const subs = Object.entries(DATA.projects).filter(([, v]) => v.parent === name);
  const parent = info?.parent;
  app.innerHTML = `
    <div class="crumbs"><a href="#/list">文件列表</a>${parent ? ` › <a href="#/project/${encodeURIComponent(parent)}">${esc(parent)}</a>` : ''} › ${esc(info?.title || name)}</div>
    <div class="detail-head"><div><h1>${esc(info?.title || name)}</h1>${info?.desc ? `<p class="lead">${esc(info.desc)}</p>` : '<p class="lead dim">（尚無說明：npm run doc -- project ' + esc(name) + ' desc=…）</p>'}</div>
      <div class="actions"><a class="btn primary" href="${scopeLink('list', name)}">列出 ${docs.length} 份文件</a><a class="btn" href="${scopeLink('summary', name)}">摘要</a></div></div>
    ${subs.length ? `<h2 class="h2">子專案</h2><div class="subgrid">${subs.map(([k, v]) => `<a class="card sub" href="#/project/${encodeURIComponent(k)}"><b>${esc(v.title)}</b><span class="dim">${scoped(k).length} 份</span>${v.desc ? `<span class="desc">${esc(v.desc)}</span>` : ''}</a>`).join('')}</div>` : ''}
    <div class="grid3">
      <section class="card"><h2>分類</h2>${miniCounts(docs, 'category', DATA.categories, 'c', name)}</section>
      <section class="card"><h2>狀態</h2>${miniCounts(docs, 'status', DATA.statuses, 's', name)}</section>
      <section class="card"><h2>機敏性</h2>${miniCounts(docs, 'sensitivity', SENSITIVITIES, 'sv', name)}</section>
    </div>
    <section class="card"><h2>關鍵字</h2>${kwCloud(docs, name)}</section>
    <h2 class="h2">最近文件</h2>
    <div class="recent">${docs.slice(0, 10).map((d) => `<div class="tl-item" style="${stStyle(d.status)}"><div class="dim nowrap">${esc(d.date)}</div><div>${docLink(d)} ${sensBadge(d.sensitivity)} <span class="chip">${esc(d.category)}</span></div></div>`).join('')}</div>`;
}

// ---------- doc detail ----------
const loadScript = (src) => new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = fail; document.head.appendChild(s); });
async function renderPreview(d, pv) {
  const href = encodeURI(d.path);
  if (d.type === 'html') { pv.innerHTML = `<iframe class="preview" src="${href}" title="${esc(d.title)}" loading="lazy"></iframe>`; return; }
  pv.innerHTML = '<p class="loading">載入預覽…</p>';
  const text = await fetch(href).then((r) => r.text());
  if (d.type === 'md') {
    try {
      if (!window.marked) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js');
      if (!window.DOMPurify) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js');
      pv.innerHTML = `<article class="md">${window.DOMPurify.sanitize(window.marked.parse(text.replace(/^---\n[\s\S]*?\n---\n/, '')))}</article>`;
      vaultMask(pv);
      return;
    } catch { /* CDN unavailable: fall through to raw text */ }
  }
  pv.innerHTML = `<pre class="raw">${esc(text)}</pre>`;
  vaultMask(pv);
}
function relList(ids, empty = '') {
  const docs = ids.map(byId).filter(Boolean);
  return docs.length ? `<ul class="rel">${docs.map((d) => `<li><span class="id">${pad(d.id)}</span> ${docLink(d)} ${sensBadge(d.sensitivity)} <span class="dim">${esc(projOf(d))} · ${esc(d.date)}</span></li>`).join('')}</ul>` : (empty ? `<p class="dim">${empty}</p>` : '');
}
async function viewDoc(id) {
  const d = byId(id);
  if (!d) { app.innerHTML = '<p class="empty">找不到這份文件。</p>'; return; }
  const href = encodeURI(d.path);
  const kb = (d.size / 1024).toFixed(d.size > 1e6 ? 0 : 1);
  const related = uniq([...(d.related || []), ...DATA.docs.filter((x) => (x.related || []).includes(d.id)).map((x) => x.id)].map(String)).map(Number);
  const supersededBy = DATA.docs.filter((x) => x.supersedes === d.id);
  const exclude = new Set([d.id, ...related]);
  const mine = new Set(d.keywords || []);
  const similar = DATA.docs.filter((x) => !exclude.has(x.id))
    .map((x) => ({ x, n: (x.keywords || []).filter((k) => mine.has(k)).length, u: new Set([...(x.keywords || []), ...mine]).size }))
    .filter((s) => s.n > 0).sort((a, b) => b.n / b.u - a.n / a.u || b.n - a.n).slice(0, 5).map((s) => s.x.id);
  const banner = d.offline
    ? `<div class="banner sv3">${LOCK} <b>極機密</b>：檔案僅存 git，未上傳到入口。要看內容請到 repo 開 <code>${esc(d.path)}</code>。</div>`
    : d.gated ? `<div class="banner sv2">${LOCK} <b>機密</b>：內文不進全文搜尋，預覽需按「顯示內容」。分享或轉貼前請先確認。</div>` : '';
  const sections = [['info', '資訊'], ['rel', '關聯'], ['hist', '歷史'], ...(d.offline ? [] : [['pv', '內容']])];
  app.innerHTML = `
    <div class="crumbs"><a href="#/list">文件列表</a> › <a href="#/project/${encodeURIComponent(d.project)}">${esc(d.project)}</a>${d.subproject ? ` › <a href="#/project/${encodeURIComponent(projOf(d))}">${esc(d.subproject)}</a>` : ''} › ${pad(d.id)}</div>
    <div class="detail-head"><h1>${esc(d.title)}</h1>
      <div class="actions">${d.offline ? '' : `<a class="btn primary" href="${href}" target="_blank" rel="noopener">開新分頁</a>`}
      ${d.url ? `<a class="btn" href="${esc(d.url)}" target="_blank" rel="noopener">原始網址</a>` : ''}</div></div>
    ${banner}
    ${supersededBy.length ? `<div class="banner sv1">這份文件已被 ${supersededBy.map((x) => `<a href="#/doc/${x.id}">${pad(x.id)} ${esc(x.title)}</a>`).join('、')} 取代。</div>` : ''}
    <nav class="toc" aria-label="目錄"><b>目錄</b>${sections.map(([k, t]) => `<button type="button" data-jump="d-${k}">${t}</button>`).join('')}</nav>
    <table class="kv" id="d-info">
      <tr><th>編號</th><td class="id">${pad(d.id)}</td></tr>
      <tr><th>狀態</th><td><span class="chip status" style="${stStyle(d.status)}">${esc(d.status)}</span></td></tr>
      <tr><th>機敏性</th><td>${sensBadge(d.sensitivity)}</td></tr>
      <tr><th>專案</th><td>${projectCell(d)}</td></tr>
      <tr><th>分類</th><td><a href="${link('list', { c: d.category })}">${esc(d.category)}</a></td></tr>
      <tr><th>日期</th><td>${esc(d.date)}</td></tr>
      <tr><th>標籤／關鍵字</th><td>${chips(d, null, 99) || '<span class="dim">（無）</span>'}</td></tr>
      ${d.desc ? `<tr><th>說明</th><td>${esc(d.desc)}</td></tr>` : ''}
      <tr><th>原始網址</th><td>${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a>` : '<span class="dim">無（只有這份備份）</span>'}</td></tr>
      ${d.vault ? `<tr><th>Vault 欄位</th><td>${d.vault.length} 個：${d.vault.map((n) => `<code>${esc(n)}</code>`).join(' ')} <span class="dim">（內文顯示成 ••••••••，按「顯示」輸入密語才在瀏覽器解密）</span></td></tr>` : ''}
      <tr><th>檔案</th><td class="id">${esc(d.path)} <span class="dim">· ${d.type.toUpperCase()} · ${kb} KB</span></td></tr>
    </table>
    <section class="card" id="d-rel"><h2>關聯</h2>
      ${d.supersedes && byId(d.supersedes) ? `<h3>取代了</h3>${relList([d.supersedes])}` : ''}
      ${supersededBy.length ? `<h3>被取代</h3>${relList(supersededBy.map((x) => x.id))}` : ''}
      <h3>相關文件</h3>${relList(related, '（尚未設定：npm run doc -- relate ' + d.id + ' <編號>）')}
      <h3>相似文件 <span class="dim">（依共同關鍵字）</span></h3>${relList(similar, '（沒有共同關鍵字的文件）')}
    </section>
    <section class="card" id="d-hist"><h2>歷史</h2>
      ${(d.history || []).length ? `<table class="matrix hist"><thead><tr><th>日期</th><th>commit</th><th>說明</th></tr></thead><tbody>${d.history.map((h) => `<tr><td>${esc(h.date)}</td><td class="id">${esc(h.hash)}</td><td>${esc(h.subject)}</td></tr>`).join('')}</tbody></table>` : '<p class="dim">尚未進 git（或這次 build 沒有 git 紀錄）。</p>'}
    </section>
    ${d.offline ? '' : `<section id="d-pv"><h2 class="h2">內容</h2><div id="pv">${d.gated ? '<button type="button" class="btn primary" id="reveal">顯示內容</button>' : ''}</div></section>`}`;
  bindJumps();
  const pv = $('#pv');
  if (!pv) return;
  if (d.gated) $('#reveal').addEventListener('click', () => renderPreview(d, pv));
  else await renderPreview(d, pv);
}

// ---------- shell ----------
function renderProjectSelect(p) {
  const sel = $('#proj');
  const tops = Object.entries(DATA.projects).filter(([, v]) => !v.parent).map(([k]) => k).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  sel.innerHTML = opt('', p, '所有專案') + tops.map((t) => opt(t, p, t) + Object.entries(DATA.projects).filter(([, v]) => v.parent === t)
    .map(([k, v]) => opt(k, p, `　» ${v.title}`)).join('')).join('');
}
async function render() {
  const { view, arg, params } = parseHash();
  const p = view === 'project' ? arg : (params.get('p') || '');
  renderProjectSelect(p);
  document.querySelectorAll('.tabs a').forEach((a) => {
    a.classList.toggle('on', a.dataset.view === view);
    a.setAttribute('href', scopeLink(a.dataset.view, view === 'doc' ? '' : p));
  });
  if (view === 'summary') viewSummary(params);
  else if (view === 'timeline') viewTimeline(params);
  else if (view === 'project') viewProject(arg);
  else if (view === 'doc') await viewDoc(arg);
  else await viewList(params);
}

$('#proj').addEventListener('change', (e) => {
  const { view, params } = parseHash();
  const n = ['list', 'summary', 'timeline'].includes(view) ? new URLSearchParams(params) : new URLSearchParams();
  e.target.value ? n.set('p', e.target.value) : n.delete('p');
  go(['list', 'summary', 'timeline'].includes(view) ? view : 'list', n);
});

let qTimer;
qInput.addEventListener('input', () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    const { view, params } = parseHash();
    const n = view === 'list' ? new URLSearchParams(params) : new URLSearchParams(params.get('p') ? { p: params.get('p') } : {});
    qInput.value ? n.set('q', qInput.value) : n.delete('q');
    n.delete('sort'); n.delete('dir');
    go('list', n, view === 'list');
  }, 180);
});

const helpBtn = $('#qhelp'), helpPop = $('#helppop');
helpPop.innerHTML = `<b>搜尋語法</b><table>${QUERY_HELP.map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}</td></tr>`).join('')}</table><p class="dim">欄位條件可以和上方下拉選單一起用；全部條件都要成立。</p>`;
const toggleHelp = (open) => { helpPop.hidden = !open; helpBtn.setAttribute('aria-expanded', String(open)); };
helpBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleHelp(helpPop.hidden); });
document.addEventListener('click', (e) => { if (!helpPop.hidden && !helpPop.contains(e.target)) toggleHelp(false); });

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== qInput && !/input|select|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); qInput.focus(); }
  if (e.key === 'Escape') { if (document.activeElement === qInput) qInput.blur(); toggleHelp(false); }
});
window.addEventListener('hashchange', render);

fetch('catalog.json').then((r) => r.json()).then((data) => {
  DATA = data;
  const title = data.site?.title || 'gitdocs portal';
  document.title = title;
  $('.brand-name').textContent = title;
  if (data.vault) {
    const vb = $('#vault-lock');
    const sync = () => { vb.hidden = !vaultUnlocked(); };
    vb.addEventListener('click', () => { vaultLock(); sync(); });
    document.addEventListener('gitdocs:vault', sync);
    sync();
  }
  $('#legend').innerHTML = data.statuses.map((s) => `<span style="${stStyle(s)}">${esc(s)}</span>`).join('');
  $('#legend-sens').innerHTML = SENSITIVITIES.map((s) => sensBadge(s)).join('');
  $('#built').textContent = `${data.docs.length} 份文件${data.maxSensitivity ? `（只含 ≤ ${data.maxSensitivity}）` : ''} · 更新於 ${new Date(data.builtAt).toLocaleString('zh-TW', { hour12: false })}`;
  render();
}).catch(() => { app.innerHTML = '<p class="empty">catalog.json 載入失敗。</p>'; });
