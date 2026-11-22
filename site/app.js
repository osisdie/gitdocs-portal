// gitdocs portal — hash-routed SPA over catalog.json + search-index.json (+ vault.json for masked fields).
// Routes: #/home (default)  #/list  #/summary  #/timeline  #/graph  #/project/<name>  #/doc/<id>  #/admin
// Every route accepts ?p=<project[/sub]> as the global scope.
// Server mode (GET /api/me → 200): workflow state from D1 is merged into the docs, editors change it inline,
// notes and an audit trail appear on doc pages, and the vault is revealed by the server per role.
import { parseQuery, matchDoc, needsBody, QUERY_HELP, SENSITIVITIES, sensRank } from './query.js';
import { mask as vaultMask, lock as vaultLock, isUnlocked as vaultUnlocked, revealDialog, useServer as vaultUseServer, NO_ROLE } from './vault.js';
import {
  WORKFLOW, LEGACY_STATUS, statusVar, statusList, shortName, initials, canEdit, isManager, rolesSummary,
  mergeState, homeSections, focusDocs, patchDiff,
} from './model.js';
import { detectMe, api, getPrefs, setPrefs } from './api.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(7, '0');
const stStyle = (s) => `--st: var(${statusVar(s)})`;
const LOCK = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="2.5" y="7" width="11" height="7.5" rx="1.5" fill="currentColor"/></svg>';
const sensBadge = (s) => `<span class="sens sv${sensRank(s)}" title="機敏性：${esc(s)}">${sensRank(s) > 0 ? LOCK : ''}${esc(s)}</span>`;
const statusChip = (s) => `<span class="chip status" style="${stStyle(s)}"${LEGACY_STATUS[s] ? ` title="舊狀態，對應「${esc(LEGACY_STATUS[s])}」"` : ''}>${esc(s)}</span>`;
const app = $('#app');
const qInput = $('#q');
const LS_KEY = 'gitdocs:filters';

let DATA = null;
let ME = null;          // GET /api/me in server mode, null in static mode
let BODY = null;
let bodyLoading = null;
let graphMod = null;    // ./graph.js once the graph route has been opened
let renderSeq = 0;      // guards async views against a newer navigation

// ---------- small utils ----------
const uniq = (arr) => [...new Set(arr)].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
const opt = (v, cur, label = v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
const projOf = (d) => d.project + (d.subproject ? `/${d.subproject}` : '');
const inScope = (d, p) => !p || d.project === p || projOf(d) === p;
const scoped = (p) => DATA.docs.filter((d) => inScope(d, p));
const byId = (id) => DATA.docs.find((d) => d.id === Number(id));
const topProjects = () => Object.entries(DATA.projects).filter(([, v]) => !v.parent).map(([k]) => k).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } };
const lsSet = (v) => { try { localStorage.setItem(LS_KEY, JSON.stringify(v)); return true; } catch { return false; } };
const fmtTime = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? esc(iso) : esc(t.toLocaleString('zh-TW', { hour12: false })); };
const who = (email) => (email ? `<span class="who" title="${esc(email)}">${esc(shortName(email))}</span>` : '<span class="dim">—</span>');
function link(view, params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x)); else if (v) sp.set(k, v);
  }
  const qs = sp.toString();
  return `#/${view}${qs ? '?' + qs : ''}`;
}
const scopeLink = (view, p, extra = {}) => link(view, { p, ...extra });
const SCOPED_VIEWS = ['home', 'list', 'summary', 'timeline', 'graph'];

// ---------- theme ----------
const THEMES = [['light', '淺色'], ['dark', '深色'], ['system', '跟隨系統']];
const THEME_COLOR = { light: '#245c73', dark: '#192126' };
function currentTheme() { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } }
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  // the two theme-color metas follow the OS; a pinned theme overrides both
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.content = THEME_COLOR[t] || (m.media.includes('dark') ? THEME_COLOR.dark : THEME_COLOR.light);
  });
}
function setTheme(t) {
  applyTheme(t);
  try { localStorage.setItem('theme', t); } catch { /* storage blocked */ }
  setPrefs({ theme: t }).catch(() => { /* kept locally; the server copy catches up next time */ });
}
applyTheme(currentTheme());

// ---------- routing ----------
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '') || 'home';
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
const noteCount = (d) => (d.notes ? ` <span class="note-n" title="${d.notes} 則留言">💬${d.notes}</span>` : '');

// ---------- home ----------
const HOME_LIMIT = 10;
function focusPicker(focus) {
  const tops = topProjects();
  const label = focus.length ? focus.join('、') : '全部專案';
  return `<details class="focus" id="focus"><summary><span class="dim">關注的專案：</span><b>${esc(label)}</b></summary>
    <div class="focus-pop" role="group" aria-label="關注的專案">
      <label><input type="checkbox" value=""${focus.length ? '' : ' checked'}> 全部專案</label>
      ${tops.map((t) => `<label><input type="checkbox" value="${esc(t)}"${focus.includes(t) ? ' checked' : ''}> ${esc(DATA.projects[t]?.title || t)}</label>`).join('')}
    </div></details>`;
}
function homeTable(rows) {
  if (!rows.length) return '<p class="dim">（沒有）</p>';
  const people = Boolean(ME);
  return `<table class="docs compact"><thead><tr><th>編號</th><th>狀態</th><th>標題</th>${people ? '<th class="c-who">負責人</th>' : ''}<th class="c-date">${ME ? '更新' : '日期'}</th></tr></thead><tbody>
    ${rows.map((d) => `<tr class="st" style="${stStyle(d.status)}">
      <td class="id"><a href="#/doc/${d.id}">${pad(d.id)}</a></td>
      <td class="c-st">${statusChip(d.status)}</td>
      <td class="title">${docLink(d)} ${sensBadge(d.sensitivity)}${noteCount(d)}<div class="dim small">${esc(projOf(d))}</div></td>
      ${people ? `<td class="c-who" data-label="負責人">${who(d.assignee)}</td>` : ''}
      <td class="c-date nowrap dim">${esc((d.updated_at || d.date || '').slice(0, 10))}</td></tr>`).join('')}</tbody></table>`;
}
function viewHome(params) {
  const p = params.get('p') || '';
  const focus = (getPrefs().focusProjects || []).filter((x) => DATA.projects[x]);
  const docs = p ? scoped(p) : focusDocs(DATA.docs, focus);
  const secs = homeSections(docs, ME?.email || null);
  const only = secs.find((s) => s.key === params.get('sec'));
  const card = (s, all) => `<section class="card home-sec" id="h-${s.key}"><h2>${esc(s.title)} <span class="count">${s.total}</span>
      ${!all && s.total > HOME_LIMIT ? `<a class="more" href="${scopeLink('home', p, { sec: s.key })}">全部 ›</a>` : ''}</h2>
    ${homeTable(all ? s.rows : s.rows.slice(0, HOME_LIMIT))}</section>`;
  app.innerHTML = `
    <div class="home-head">
      <h1>${only ? `<a href="${scopeLink('home', p)}">首頁</a> › ${esc(only.title)}` : '首頁'}</h1>
      ${p ? `<span class="dim">範圍：專案 ${esc(p)}（由上方專案選單決定）</span>` : focusPicker(focus)}
    </div>
    ${ME ? '' : '<p class="dim small">靜態模式：「指派給我」「待我確認」「我建立的」需要伺服器模式（登入後才知道「我」是誰）。</p>'}
    ${only ? card(only, true) : `<nav class="toc" aria-label="目錄"><b>目錄</b>${secs.map((s) => `<button type="button" data-jump="h-${s.key}">${esc(s.title)} <span class="dim">${s.total}</span></button>`).join('')}</nav>
    <div class="grid2 home">${secs.map((s) => card(s, false)).join('')}</div>`}`;
  bindJumps();
  const box = $('#focus');
  box?.addEventListener('change', (e) => {
    const all = box.querySelector('input[value=""]');
    if (e.target === all) box.querySelectorAll('input[value]:not([value=""])').forEach((c) => { c.checked = false; });
    const picked = [...box.querySelectorAll('input:checked')].map((c) => c.value).filter(Boolean);
    setPrefs({ focusProjects: picked }).catch((x) => alert(`偏好設定沒有存到伺服器：${x.message}`)).finally(() => {
      render().then(() => { const b = $('#focus'); if (b) b.open = true; });
    });
  });
}

// ---------- list ----------
async function viewList(params) {
  const q = params.get('q') || '';
  if (qInput.value !== q && document.activeElement !== qInput) qInput.value = q;
  const p = params.get('p') || '';
  const f = { c: params.get('c') || '', s: params.get('s') || '', sv: params.get('sv') || '', ty: params.get('ty') || '' };
  const ks = params.getAll('k');
  const pq = parseQuery(q);
  const sort = params.get('sort') || (pq.terms.length ? 'score' : 'date');
  const dir = params.get('dir') || (['title', 'project', 'assignee', 'reviewer'].includes(sort) ? 'asc' : 'desc');
  if (needsBody(pq)) await ensureBody();
  const highlightTerms = pq.terms;

  const base = scoped(p);
  let rows = base.filter((d) => (!f.c || d.category === f.c) && (!f.s || d.status === f.s) && (!f.sv || d.sensitivity === f.sv)
    && (!f.ty || d.type === f.ty) && ks.every((k) => (d.tags || []).includes(k) || (d.keywords || []).includes(k)));
  rows = rows.map((d) => ({ d, m: matchDoc(d, pq, BODY ? (BODY.get(d.id) || '') : '') })).filter((r) => r.m);
  const key = {
    id: (r) => r.d.id, date: (r) => (r.d.updated_at || r.d.date) + pad(r.d.id), title: (r) => r.d.title, project: (r) => projOf(r.d),
    category: (r) => r.d.category, status: (r) => r.d.status, sens: (r) => sensRank(r.d.sensitivity), score: (r) => r.m.score * 1e8 + Number(r.d.date.replace(/-/g, '')),
    assignee: (r) => r.d.assignee || '￿', reviewer: (r) => r.d.reviewer || '￿',
  }[sort] || ((r) => r.d.date);
  rows.sort((a, b) => { const x = key(a), y = key(b); const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-Hant'); return dir === 'asc' ? c : -c; });

  const showAssignee = base.some((d) => d.assignee), showReviewer = base.some((d) => d.reviewer);
  const sel = (name, label, values, cur) => `<label>${label}<select data-f="${name}">${opt('', cur, '（全部）')}${values.map((v) => opt(v, cur)).join('')}</select></label>`;
  const th = (k, label, cls = '') => `<th class="${cls}" data-sort="${k}"${sort === k ? ` aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${label}</th>`;
  const anyFilter = q || ks.length || Object.values(f).some(Boolean);
  const kwOptions = uniq(base.flatMap((d) => [...(d.tags || []), ...(d.keywords || [])])).filter((k) => !ks.includes(k));
  const local = lsGet();
  const curQs = (() => { const c = new URLSearchParams(params); c.delete('sort'); c.delete('dir'); return c.toString(); })();
  const SORTS = [['date', '日期'], ['id', '編號'], ['title', '標題'], ['status', '狀態'], ['sens', '機敏'], ['project', '專案'], ...(pq.terms.length ? [['score', '相關度']] : []), ...(showAssignee ? [['assignee', '負責人']] : [])];

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
      <label class="m-sort">排序<select id="msort">${SORTS.flatMap(([k, l]) => [opt(`${k}:desc`, `${sort}:${dir}`, `${l} ↓`), opt(`${k}:asc`, `${sort}:${dir}`, `${l} ↑`)]).join('')}</select></label>
    </section>
    ${ks.length ? `<div class="chips active">${ks.map((k) => { const n = new URLSearchParams(params); const rest = ks.filter((x) => x !== k); n.delete('k'); rest.forEach((x) => n.append('k', x)); return `<a class="chip kw on" href="#/list?${n}" title="移除">${esc(k)} ×</a>`; }).join('')}</div>` : ''}
    <div class="bar">
      <span>顯示 <b>${rows.length}</b> / ${base.length} 份文件${p ? `（專案 ${esc(p)}）` : ''}${q ? `，搜尋「${esc(q)}」` : ''}</span>
      ${anyFilter ? '<button type="button" id="reset">清除篩選</button>' : ''}
    </div>
    ${rows.length ? `<div class="tbl-wrap"><table class="docs">
      <thead><tr>${th('id', '編號')}${th('status', '狀態', 'c-st')}${th('sens', '機敏', 'c-sens')}${th('project', '專案', 'c-proj')}${th('category', '分類', 'c-cat')}${th('title', '標題')}${showAssignee ? th('assignee', '負責人', 'c-who') : ''}${showReviewer ? th('reviewer', '確認人', 'c-who') : ''}${th('date', ME ? '更新' : '日期', 'c-date')}<th class="c-type">格式</th></tr></thead>
      <tbody>${rows.map(({ d, m }) => `
        <tr class="st" style="${stStyle(d.status)}">
          <td class="id"><a href="#/doc/${d.id}">${pad(d.id)}</a></td>
          <td class="c-st">${statusChip(d.status)}</td>
          <td class="c-sens">${sensBadge(d.sensitivity)}</td>
          <td class="c-proj nowrap">${projectCell(d)}</td>
          <td class="c-cat nowrap">${esc(d.category)}</td>
          <td class="title"><a href="#/doc/${d.id}">${highlight(d.title, highlightTerms)}</a>${noteCount(d)}${d.offline ? ' <span class="offline">僅存 git，未上傳</span>' : ''}
            ${d.desc ? `<div class="desc">${highlight(d.desc, highlightTerms)}</div>` : ''}
            ${m.snip ? `<div class="snip">${highlight(m.snip, highlightTerms)}</div>` : ''}
            ${chips(d, params, 6)}</td>
          ${showAssignee ? `<td class="c-who" data-label="負責人">${who(d.assignee)}</td>` : ''}
          ${showReviewer ? `<td class="c-who" data-label="確認人">${who(d.reviewer)}</td>` : ''}
          <td class="c-date nowrap dim">${esc((d.updated_at || d.date || '').slice(0, 10))}</td>
          <td class="c-type type">${esc(d.type)}</td>
        </tr>`).join('')}</tbody></table></div>` : '<p class="empty">沒有符合條件的文件。</p>'}`;

  app.querySelectorAll('select[data-f]').forEach((s) => s.addEventListener('change', () => {
    const n = new URLSearchParams(params); s.value ? n.set(s.dataset.f, s.value) : n.delete(s.dataset.f); go('list', n, true);
  }));
  $('#addk').addEventListener('change', (e) => { if (!e.target.value) return; const n = new URLSearchParams(params); n.append('k', e.target.value); go('list', n, true); });
  $('#msort').addEventListener('change', (e) => { const [k, dr] = e.target.value.split(':'); const n = new URLSearchParams(params); n.set('sort', k); n.set('dir', dr); go('list', n, true); });
  app.querySelectorAll('th[data-sort]').forEach((h) => h.addEventListener('click', () => {
    const n = new URLSearchParams(params); const k = h.dataset.sort;
    n.set('sort', k); n.set('dir', sort === k ? (dir === 'desc' ? 'asc' : 'desc') : (['title', 'project', 'assignee', 'reviewer'].includes(k) ? 'asc' : 'desc')); go('list', n, true);
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
    return `${head}<div class="tl-item" style="${stStyle(d.status)}"><div class="tl-when dim">${esc(d.date)} · ${pad(d.id)}</div>
      <div class="tl-body">${docLink(d)} ${sensBadge(d.sensitivity)} <span class="chip">${esc(projOf(d))}</span> <span class="chip">${esc(d.category)}</span>
      ${d.desc ? `<div class="desc">${esc(d.desc)}</div>` : ''}</div></div>`;
  }).join('') : '<p class="empty">這個範圍沒有文件。</p>';
}

// ---------- graph (site/graph.js; it loads graph.css itself) ----------
async function viewGraph(params, seq) {
  const p = params.get('p') || '';
  app.innerHTML = '<p class="loading">載入關聯圖…</p>';
  try {
    const m = await import('./graph.js');
    graphMod = m;
    if (seq !== renderSeq) return;
    app.innerHTML = '';
    await m.renderGraph(app, { docs: scoped(p), projects: DATA.projects, site: DATA.site, scope: p, go: (hash) => { location.hash = hash; } });
  } catch (e) {
    console.error(e);
    if (seq === renderSeq) app.innerHTML = '<p class="empty">關聯圖載入失敗。</p>';
  }
}

// ---------- admin (site/admin.js) ----------
async function viewAdmin(params, seq) {
  if (!ME) { app.innerHTML = '<p class="empty">管理頁需要伺服器模式。</p>'; return; }
  if (!isManager(ME)) { app.innerHTML = '<p class="empty">沒有管理權限（需要 manager 以上）。</p>'; return; }
  app.innerHTML = '<p class="loading">載入管理頁…</p>';
  try {
    const m = await import('./admin.js');
    if (seq !== renderSeq) return;
    await m.renderAdmin(app, { me: ME, api, esc, projects: topProjects(), tab: params.get('tab') || '', link });
  } catch (e) {
    if (seq === renderSeq) app.innerHTML = `<p class="empty">管理頁載入失敗：${esc(e.message)}</p>`;
  }
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
      <div class="actions"><a class="btn primary" href="${scopeLink('list', name)}">列出 ${docs.length} 份文件</a><a class="btn" href="${scopeLink('summary', name)}">摘要</a><a class="btn" href="${scopeLink('home', name)}">首頁</a></div></div>
    ${subs.length ? `<h2 class="h2">子專案</h2><div class="subgrid">${subs.map(([k, v]) => `<a class="card sub" href="#/project/${encodeURIComponent(k)}"><b>${esc(v.title)}</b><span class="dim">${scoped(k).length} 份</span>${v.desc ? `<span class="desc">${esc(v.desc)}</span>` : ''}</a>`).join('')}</div>` : ''}
    <div class="grid3">
      <section class="card"><h2>分類</h2>${miniCounts(docs, 'category', DATA.categories, 'c', name)}</section>
      <section class="card"><h2>狀態</h2>${miniCounts(docs, 'status', DATA.statuses, 's', name)}</section>
      <section class="card"><h2>機敏性</h2>${miniCounts(docs, 'sensitivity', SENSITIVITIES, 'sv', name)}</section>
    </div>
    <section class="card"><h2>關鍵字</h2>${kwCloud(docs, name)}</section>
    <h2 class="h2">最近文件</h2>
    <div class="recent">${docs.slice(0, 10).map((d) => `<div class="tl-item" style="${stStyle(d.status)}"><div class="tl-when dim">${esc(d.date)}</div><div class="tl-body">${docLink(d)} ${sensBadge(d.sensitivity)} <span class="chip">${esc(d.category)}</span></div></div>`).join('')}</div>`;
}

// ---------- doc detail ----------
const DOC_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads';
// A sandboxed HTML doc asks to show a vault field: accept only from the preview iframe of the open doc, and only for
// names that doc references. The request only opens a masked portal dialog; nothing is revealed (or audited) until the
// user clicks 顯示 / 複製 there, and the value is never sent back to the document.
window.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.type !== 'gitdocs:vault' || typeof m.name !== 'string') return;
  const frame = document.querySelector('#pv iframe.preview');
  const { view, arg } = parseHash();
  const d = view === 'doc' ? byId(arg) : null;
  if (!frame || e.source !== frame.contentWindow || !d?.vault?.includes(m.name)) return;
  revealDialog(m.name, d.title, d.id);
});
// Pinned CDN files with Subresource Integrity: a tampered copy fails to load and the preview falls back to raw text.
const MARKED = ['https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js', 'sha384-/TQbtLCAerC3jgaim+N78RZSDYV7ryeoBCVqTuzRrFec2akfBkHS7ACQ3PQhvMVi'];
const PURIFY = ['https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js', 'sha384-+VfUPEb0PdtChMwmBcBmykRMDd+v6D/oFmB3rZM/puCMDYcIvF968OimRh4KQY9a'];
const loadScript = ([src, integrity]) => new Promise((ok, fail) => {
  const s = document.createElement('script');
  s.src = src; s.integrity = integrity; s.crossOrigin = 'anonymous'; s.onload = ok; s.onerror = fail;
  document.head.appendChild(s);
});
async function renderPreview(d, pv) {
  const href = encodeURI(d.path);
  // Documents are untrusted: sandboxed without allow-same-origin (the /docs/* CSP header enforces the same).
  if (d.type === 'html') { pv.innerHTML = `<iframe class="preview" src="${href}" title="${esc(d.title)}" loading="lazy" sandbox="${DOC_SANDBOX}"></iframe>`; return; }
  pv.innerHTML = '<p class="loading">載入預覽…</p>';
  const text = await fetch(href).then((r) => r.text());
  if (d.type === 'md') {
    try {
      if (!window.marked) await loadScript(MARKED);
      if (!window.DOMPurify) await loadScript(PURIFY);
      pv.innerHTML = `<article class="md">${window.DOMPurify.sanitize(window.marked.parse(text.replace(/^---\n[\s\S]*?\n---\n/, '')))}</article>`;
      vaultMask(pv, d.id);
      return;
    } catch { /* CDN unavailable: fall through to raw text */ }
  }
  pv.innerHTML = `<pre class="raw">${esc(text)}</pre>`;
  vaultMask(pv, d.id);
}
function relList(ids, empty = '') {
  const docs = ids.map(byId).filter(Boolean);
  return docs.length ? `<ul class="rel">${docs.map((d) => `<li><span class="id">${pad(d.id)}</span> ${docLink(d)} ${sensBadge(d.sensitivity)} <span class="dim">${esc(projOf(d))} · ${esc(d.date)}</span></li>`).join('')}</ul>` : (empty ? `<p class="dim">${empty}</p>` : '');
}
const knownPeople = () => uniq([ME?.email, ...DATA.docs.flatMap((d) => [d.reporter, d.assignee, d.reviewer, d.updated_by])].map((e) => e && String(e).toLowerCase()));
function editForm(d) {
  const statuses = [...WORKFLOW, ...(WORKFLOW.includes(d.status) || !d.status ? [] : [d.status])];
  return `<section class="card" id="d-edit"><h2>工作流程</h2>
    <form class="wf" id="wf">
      <label>狀態<select name="status">${statuses.map((s) => opt(s, d.status, LEGACY_STATUS[s] ? `${s}（舊）` : s)).join('')}</select></label>
      <label>負責人<input name="assignee" type="email" list="people" value="${esc(d.assignee || '')}" placeholder="email（空白＝未指派）" autocomplete="off"></label>
      <label>確認人<input name="reviewer" type="email" list="people" value="${esc(d.reviewer || '')}" placeholder="email" autocomplete="off"></label>
      <label class="wide">標籤<input name="tags" value="${esc((d.tags || []).join(', '))}" placeholder="以逗號或空白分隔" autocomplete="off"></label>
      <div class="wf-row"><button type="submit" class="btn primary">儲存</button><span class="msg" aria-live="polite"></span></div>
      <datalist id="people">${knownPeople().map((e) => `<option value="${esc(e)}">`).join('')}</datalist>
    </form></section>`;
}
function notesHtml(notes) {
  return notes.length ? `<ol class="notes">${notes.map((n) => `<li><div class="note-meta">${who(n.author)} <span class="dim">· ${fmtTime(n.created_at)}</span></div><div class="note-body">${esc(n.body)}</div></li>`).join('')}</ol>` : '<p class="dim">還沒有留言。</p>';
}
function auditHtml(rows) {
  const change = (r) => (r.field ? `<code>${esc(r.field)}</code> ${r.old != null && r.old !== '' ? `<del>${esc(r.old)}</del> → ` : ''}${esc(r.new ?? '')}` : esc(r.new ?? ''));
  return rows.length ? `<table class="matrix hist"><thead><tr><th>時間</th><th>人員</th><th>動作</th><th>內容</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="nowrap">${fmtTime(r.at)}</td><td>${who(r.actor)}</td><td>${esc(r.action)}</td><td>${change(r)}</td></tr>`).join('')}</tbody></table>` : '<p class="dim">沒有網頁上的異動。</p>';
}
async function loadDocServer(d, seq) {
  const nBox = $('#notes-list'), hBox = $('#audit-list');
  const [notes, hist] = await Promise.allSettled([api('GET', `/api/docs/${d.id}/notes`), api('GET', `/api/docs/${d.id}/history`)]);
  if (seq !== renderSeq) return;
  nBox.innerHTML = notes.status === 'fulfilled' ? notesHtml(notes.value || []) : `<p class="err">留言載入失敗：${esc(notes.reason.message)}</p>`;
  hBox.innerHTML = hist.status === 'fulfilled' ? auditHtml(hist.value || []) : `<p class="err">異動紀錄載入失敗：${esc(hist.reason.message)}</p>`;
}
function bindDocServer(d, seq) {
  const wf = $('#wf');
  wf?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = wf.querySelector('.msg');
    const body = patchDiff(d, Object.fromEntries(new FormData(wf)));
    if (!Object.keys(body).length) { msg.textContent = '沒有變更。'; return; }
    msg.textContent = '儲存中…';
    try {
      const s = await api('PATCH', `/api/docs/${d.id}`, body);
      Object.assign(d, mergeState([d], { docs: { [d.path]: { ...body, ...(s?.state || s || {}) } } })[0]);
      DATA.statuses = statusList(DATA.statuses, DATA.docs);
      await render();
      const m = $('#wf .msg'); if (m) m.textContent = '已儲存。';
    } catch (x) { msg.textContent = `儲存失敗：${x.message}`; }
  });
  const nf = $('#note-form');
  nf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ta = nf.querySelector('textarea'), btn = nf.querySelector('button'), msg = nf.querySelector('.msg');
    const text = ta.value.trim();
    if (!text) return;
    btn.disabled = true; msg.textContent = '送出中…';
    try {
      await api('POST', `/api/docs/${d.id}/notes`, { body: text });
      ta.value = ''; msg.textContent = '';
      d.notes = (d.notes || 0) + 1;
      await loadDocServer(d, seq);
    } catch (x) { msg.textContent = `送出失敗：${x.message}`; } finally { btn.disabled = false; }
  });
}
async function viewDoc(id, seq) {
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
  const editable = ME && canEdit(ME, d);
  const sections = [['info', '資訊'], ...(editable ? [['edit', '工作流程']] : []), ['rel', '關聯'], ...(ME ? [['notes', '留言'], ['audit', '異動紀錄']] : []), ['hist', 'git 歷史'], ...(d.offline ? [] : [['pv', '內容']])];
  const vaultNote = ME ? (editable ? '（內文顯示成 ••••••••，按「顯示」由伺服器解密，每次存取都會記錄）' : `（內文顯示成 ••••••••，${NO_ROLE}）`)
    : '（內文顯示成 ••••••••，按「顯示」輸入密語才在瀏覽器解密）';
  const person = (label, email) => (email || ME ? `<tr><th>${label}</th><td>${email ? `${who(email)} <span class="dim">${esc(email)}</span>` : '<span class="dim">（未設定）</span>'}</td></tr>` : '');
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
      <tr><th>狀態</th><td>${statusChip(d.status)}${d.updated_at ? ` <span class="dim small">${who(d.updated_by)} 於 ${fmtTime(d.updated_at)} 更新</span>` : ''}</td></tr>
      ${person('回報人', d.reporter)}${person('負責人', d.assignee)}${person('確認人', d.reviewer)}
      <tr><th>機敏性</th><td>${sensBadge(d.sensitivity)}</td></tr>
      <tr><th>專案</th><td>${projectCell(d)}</td></tr>
      <tr><th>分類</th><td><a href="${link('list', { c: d.category })}">${esc(d.category)}</a></td></tr>
      <tr><th>日期</th><td>${esc(d.date)}</td></tr>
      <tr><th>標籤／關鍵字</th><td>${chips(d, null, 99) || '<span class="dim">（無）</span>'}</td></tr>
      ${d.desc ? `<tr><th>說明</th><td>${esc(d.desc)}</td></tr>` : ''}
      <tr><th>原始網址</th><td>${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a>` : '<span class="dim">無（只有這份備份）</span>'}</td></tr>
      ${d.vault ? `<tr><th>Vault 欄位</th><td>${d.vault.length} 個：${d.vault.map((n) => `<code>${esc(n)}</code>`).join(' ')} <span class="dim">${vaultNote}</span></td></tr>` : ''}
      <tr><th>檔案</th><td class="id path">${esc(d.path)} <span class="dim">· ${esc(d.type.toUpperCase())} · ${kb} KB</span></td></tr>
    </table>
    ${editable ? editForm(d) : ''}
    <section class="card" id="d-rel"><h2>關聯</h2>
      ${d.supersedes && byId(d.supersedes) ? `<h3>取代了</h3>${relList([d.supersedes])}` : ''}
      ${supersededBy.length ? `<h3>被取代</h3>${relList(supersededBy.map((x) => x.id))}` : ''}
      <h3>相關文件</h3>${relList(related, '（尚未設定：npm run doc -- relate ' + d.id + ' <編號>）')}
      <h3>相似文件 <span class="dim">（依共同關鍵字）</span></h3>${relList(similar, '（沒有共同關鍵字的文件）')}
    </section>
    ${ME ? `<section class="card" id="d-notes"><h2>留言</h2><div id="notes-list"><p class="loading">載入中…</p></div>
      <form id="note-form" class="note-form"><label class="sr" for="note-text">新增留言</label>
        <textarea id="note-text" maxlength="4000" rows="3" placeholder="新增留言（最多 4000 字）" required></textarea>
        <div class="wf-row"><button type="submit" class="btn primary">送出留言</button><span class="msg" aria-live="polite"></span></div></form></section>
    <section class="card" id="d-audit"><h2>異動紀錄 <span class="dim small">（網頁上的狀態、指派、標籤與留言）</span></h2><div id="audit-list"><p class="loading">載入中…</p></div></section>` : ''}
    <section class="card" id="d-hist"><h2>git 歷史</h2>
      ${(d.history || []).length ? `<table class="matrix hist"><thead><tr><th>日期</th><th>commit</th><th>說明</th></tr></thead><tbody>${d.history.map((h) => `<tr><td class="nowrap">${esc(h.date)}</td><td class="id">${esc(h.hash)}</td><td>${esc(h.subject)}</td></tr>`).join('')}</tbody></table>` : '<p class="dim">尚未進 git（或這次 build 沒有 git 紀錄）。</p>'}
    </section>
    ${d.offline ? '' : `<section id="d-pv"><h2 class="h2">內容</h2><div id="pv">${d.gated ? '<button type="button" class="btn primary" id="reveal">顯示內容</button>' : ''}</div></section>`}`;
  bindJumps();
  if (ME) { bindDocServer(d, seq); loadDocServer(d, seq); }
  const pv = $('#pv');
  if (!pv) return;
  if (d.gated) $('#reveal').addEventListener('click', () => renderPreview(d, pv));
  else await renderPreview(d, pv);
}

// ---------- profile menu ----------
const meBtn = $('#me-btn'), meMenu = $('#me-menu');
function renderProfile() {
  meBtn.textContent = ME ? initials(ME.email) : '訪客';
  meBtn.classList.toggle('guest', !ME);
  meBtn.title = ME ? `${ME.email}（帳號與設定）` : '訪客（靜態模式）';
  const theme = currentTheme();
  const lockable = !ME && DATA?.vault;
  meMenu.innerHTML = `
    <div class="menu-head">${ME
      ? `<b>${esc(ME.name || shortName(ME.email))}</b><div class="dim">${esc(ME.email)}</div><div class="roles">${esc(rolesSummary(ME))}</div>`
      : '<b>訪客</b><div class="dim">靜態模式：沒有帳號與權限設定</div>'}</div>
    <fieldset class="menu-theme"><legend>佈景主題</legend>
      ${THEMES.map(([v, l]) => `<label><input type="radio" name="theme" value="${v}"${v === theme ? ' checked' : ''}> ${l}</label>`).join('')}</fieldset>
    ${lockable ? `<button type="button" class="menu-item" id="m-lock"${vaultUnlocked() ? '' : ' disabled title="vault 尚未解鎖"'}>鎖定 vault</button>` : ''}
    ${isManager(ME) ? '<a class="menu-item" href="#/admin">管理</a>' : ''}
    <a class="menu-item" href="/cdn-cgi/access/logout">登出</a>`;
}
const toggleMenu = (open) => { meMenu.hidden = !open; meBtn.setAttribute('aria-expanded', String(open)); };
meBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(meMenu.hidden); if (!meMenu.hidden) meMenu.querySelector('input:checked')?.focus(); });
meMenu.addEventListener('change', (e) => { if (e.target.name === 'theme') setTheme(e.target.value); });
meMenu.addEventListener('click', (e) => {
  if (e.target.closest('#m-lock')) { vaultLock(); renderProfile(); }
  else if (e.target.closest('a')) toggleMenu(false);
});
document.addEventListener('gitdocs:vault', () => { if (DATA) renderProfile(); });

// ---------- nav (collapses into a menu on narrow screens) ----------
const navBtn = $('#nav-btn'), tabs = $('#tabs');
const toggleNav = (open) => { tabs.classList.toggle('open', open); navBtn.setAttribute('aria-expanded', String(open)); };
navBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleNav(!tabs.classList.contains('open')); });

// ---------- shell ----------
function renderProjectSelect(p) {
  const sel = $('#proj');
  sel.innerHTML = opt('', p, '所有專案') + topProjects().map((t) => opt(t, p, t) + Object.entries(DATA.projects).filter(([, v]) => v.parent === t)
    .map(([k, v]) => opt(k, p, `　» ${v.title}`)).join('')).join('');
}
async function render() {
  if (!DATA) return;
  const seq = ++renderSeq;
  const { view, arg, params } = parseHash();
  const p = view === 'project' ? arg : (params.get('p') || '');
  try { graphMod?.disposeGraph?.(); } catch { /* a failing dispose must not block navigation */ }
  toggleNav(false);
  renderProjectSelect(p);
  const cur = view === 'project' || view === 'doc' || view === 'admin' ? view : (SCOPED_VIEWS.includes(view) ? view : 'list');
  document.querySelectorAll('.tabs a').forEach((a) => {
    a.classList.toggle('on', a.dataset.view === cur);
    if (a.dataset.view === cur) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    a.setAttribute('href', scopeLink(a.dataset.view, view === 'doc' ? '' : p));
  });
  document.body.dataset.view = cur;
  if (view === 'home') viewHome(params);
  else if (view === 'summary') viewSummary(params);
  else if (view === 'timeline') viewTimeline(params);
  else if (view === 'graph') await viewGraph(params, seq);
  else if (view === 'project') viewProject(arg);
  else if (view === 'doc') await viewDoc(arg, seq);
  else if (view === 'admin') await viewAdmin(params, seq);
  else await viewList(params);
}

$('#proj').addEventListener('change', (e) => {
  const { view, params } = parseHash();
  const keep = SCOPED_VIEWS.includes(view);
  const n = keep ? new URLSearchParams(params) : new URLSearchParams();
  n.delete('sec');
  e.target.value ? n.set('p', e.target.value) : n.delete('p');
  go(keep ? view : 'list', n);
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
document.addEventListener('click', (e) => {
  if (!helpPop.hidden && !helpPop.contains(e.target)) toggleHelp(false);
  if (!meMenu.hidden && !meMenu.contains(e.target)) toggleMenu(false);
  if (tabs.classList.contains('open') && !tabs.contains(e.target)) toggleNav(false);
  const fb = $('#focus');
  if (fb?.open && !fb.contains(e.target)) fb.open = false;
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== qInput && !/input|select|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); qInput.focus(); }
  if (e.key === 'Escape') {
    if (document.activeElement === qInput) qInput.blur();
    toggleHelp(false);
    if (!meMenu.hidden) { toggleMenu(false); meBtn.focus(); }
    toggleNav(false);
  }
});
window.addEventListener('hashchange', render);

// PWA: only where service workers are allowed to matter (https, or localhost during development).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname))) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is optional */ });
}

async function boot() {
  const catalogP = fetch('catalog.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
  const [data, me] = await Promise.all([catalogP, detectMe()]);
  DATA = data;
  ME = me;
  let stateNote = '';
  if (ME) {
    vaultUseServer({ canReveal: (id) => { const d = byId(id); return Boolean(d) && canEdit(ME, d); } });
    try { DATA.docs = mergeState(DATA.docs, await api('GET', '/api/state')); } catch (x) { stateNote = ` · 伺服器狀態載入失敗（${x.message}）`; }
    const t = ME.prefs?.theme;
    if (t && t !== currentTheme()) { applyTheme(t); try { localStorage.setItem('theme', t); } catch { /* ignore */ } }
  }
  DATA.statuses = statusList((DATA.statuses || []).filter((s) => !LEGACY_STATUS[s]), DATA.docs);
  const title = data.site?.title || 'gitdocs portal';
  document.title = title;
  $('.brand-name').textContent = title;
  renderProfile();
  $('#legend').innerHTML = DATA.statuses.map((s) => `<span style="${stStyle(s)}">${esc(s)}</span>`).join('');
  $('#legend-sens').innerHTML = SENSITIVITIES.map((s) => sensBadge(s)).join('');
  $('#built').textContent = `${data.docs.length} 份文件${data.maxSensitivity ? `（只含 ≤ ${data.maxSensitivity}）` : ''} · 更新於 ${new Date(data.builtAt).toLocaleString('zh-TW', { hour12: false })}${ME ? ' · 伺服器模式' : ''}${stateNote}`;
  await render();
}
boot().catch(() => { renderProfile(); app.innerHTML = '<p class="empty">catalog.json 載入失敗（可能是登入已過期，請重新整理頁面）。</p>'; });
