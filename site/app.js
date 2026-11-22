// gitdocs portal — hash-routed SPA over catalog.json + search-index.json (+ vault.json for masked fields).
// Routes: #/home (default)  #/list  #/summary  #/timeline  #/graph  #/project/<name>  #/doc/<id>  #/admin
// Every route accepts ?p=<project[/sub]> as the global scope.
// Server mode (GET /api/me → 200): workflow state from D1 is merged into the docs, editors change it inline,
// notes and an audit trail appear on doc pages, and the vault is revealed by the server per role.
// UI text goes through site/i18n.js (t / th); stored enum values are displayed through label().
import { parseQuery, matchDoc, needsBody, queryHelp, SENSITIVITIES, sensRank } from './query.js';
import { mask as vaultMask, lock as vaultLock, isUnlocked as vaultUnlocked, revealDialog, revealSecretDialog, useServer as vaultUseServer, noRole } from './vault.js';
import { NAME_RE } from './vault-core.js';
import {
  WORKFLOW, LEGACY_STATUS, statusVar, statusList, shortName, initials, canEdit, isManager, rolesSummary,
  mergeState, homeSections, focusDocs, patchDiff,
  addPeople, setName, displayName, personChoice, resolvePerson, peopleEmails, NAME_MAX,
  isPublicProject, sourceOfProject, roleFor, atLeast,
} from './model.js';
import { detectMe, api, getPrefs, setPrefs } from './api.js';
import { t, th, raw, esc, label, getLang, setLang, normLang, LANGS, LANG_KEY, DEFAULT_LANG, fmtDateTime, joinList } from './i18n.js';

const $ = (s, el = document) => el.querySelector(s);
const pad = (n) => String(n).padStart(7, '0');
const stStyle = (s) => `--st: var(${statusVar(s)})`;
const LOCK = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="2.5" y="7" width="11" height="7.5" rx="1.5" fill="currentColor"/></svg>';
const L = { st: (s) => label('status', s), sv: (s) => label('sens', s), cat: (c) => label('cat', c), proj: (p) => label('project', p) };
const sensBadge = (s) => `<span class="sens sv${sensRank(s)}" title="${th('badge.sens', { level: L.sv(s) })}">${sensRank(s) > 0 ? LOCK : ''}${esc(L.sv(s))}</span>`;
const statusChip = (s) => `<span class="chip status" style="${stStyle(s)}"${LEGACY_STATUS[s] ? ` title="${th('badge.legacy', { status: L.st(LEGACY_STATUS[s]) })}"` : ''}>${esc(L.st(s))}</span>`;
const app = $('#app');
const qInput = $('#q');
const LS_KEY = 'gitdocs:filters';

let DATA = null;
let ME = null;          // GET /api/me in server mode, null in static mode
let BODY = null;
let bodyLoading = null;
let graphMod = null;    // ./graph.js once the graph route has been opened
let renderSeq = 0;      // guards async views against a newer navigation
let stateError = '';    // server state failed to load (shown in the footer)

// ---------- small utils ----------
const uniq = (arr) => [...new Set(arr)].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
const opt = (v, cur, text = v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(text)}</option>`;
const projOf = (d) => d.project + (d.subproject ? `/${d.subproject}` : '');
const projName = (d) => L.proj(d.project) + (d.subproject ? `/${d.subproject}` : '');
const projTitle = (k) => L.proj(DATA.projects[k]?.title || k);
const inScope = (d, p) => !p || d.project === p || projOf(d) === p;
const scoped = (p) => DATA.docs.filter((d) => inScope(d, p));
const byId = (id) => DATA.docs.find((d) => d.id === Number(id));
// top-level projects: the (server-trimmed) registry plus public projects from GET /api/me that have documents
const topProjects = () => uniq([...Object.entries(DATA.projects).filter(([, v]) => !v.parent).map(([k]) => k),
  ...(ME?.publicProjects || []).filter((k) => DATA.docs.some((d) => d.project === k))]);
const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } };
const lsSet = (v) => { try { localStorage.setItem(LS_KEY, JSON.stringify(v)); return true; } catch { return false; } };
const fmtTime = (iso) => esc(fmtDateTime(iso));
// People are shown by display name only (model.js displayName); the email appears only in the admin users table and
// in the signed-in user's own profile menu.
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+$/; // audit values that are a person (assignee / reviewer changes)
const who = (email) => (email ? `<span class="who">${esc(displayName(email))}</span>` : '<span class="dim">—</span>');
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

// ---------- language ----------
// Precedence: the user's choice (server prefs.lang, mirrored in localStorage) → ?lang= in the URL (not persisted) →
// English. The inline script in index.html applies the same order to <html lang> before first paint.
const storedLang = () => { try { return normLang(localStorage.getItem(LANG_KEY)); } catch { return null; } };
function urlLang() {
  try { return normLang(new URLSearchParams(location.search).get('lang') || parseHash().params.get('lang')); } catch { return null; }
}
setLang(storedLang() || urlLang() || DEFAULT_LANG);
function chooseLang(l) {
  const next = setLang(l);
  try { localStorage.setItem(LANG_KEY, next); } catch { /* storage blocked: this page only */ }
  setPrefs({ lang: next }).catch(() => { /* kept locally; the server copy catches up next time */ });
  relocalize();
}
/** Re-apply every piece of UI text after a language change, without a reload. */
function relocalize() {
  translateStatic();
  renderHelp();
  if (!DATA) { renderProfile(); return; }
  renderChrome();
  render().then(() => { if (!meMenu.hidden) meMenu.querySelector('input[name="lang"]:checked')?.focus(); });
}
/** Static text in index.html: data-i18n="key" sets textContent; data-i18n-attr="attr:key;attr:key" sets attributes. */
function translateStatic() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-attr]').forEach((el) => el.dataset.i18nAttr.split(';').forEach((pair) => {
    const [a, k] = pair.split(':').map((s) => s.trim());
    if (a && k) el.setAttribute(a, t(k));
  }));
}

// ---------- theme ----------
const THEMES = ['light', 'dark', 'system'];
const THEME_COLOR = { light: '#245c73', dark: '#192126' };
function currentTheme() { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } }
function applyTheme(v) {
  const root = document.documentElement;
  if (v === 'light' || v === 'dark') root.dataset.theme = v; else delete root.dataset.theme;
  // the two theme-color metas follow the OS; a pinned theme overrides both
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.content = THEME_COLOR[v] || (m.media.includes('dark') ? THEME_COLOR.dark : THEME_COLOR.light);
  });
}
function setTheme(v) {
  applyTheme(v);
  try { localStorage.setItem('theme', v); } catch { /* storage blocked */ }
  setPrefs({ theme: v }).catch(() => { /* kept locally; the server copy catches up next time */ });
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
  for (const term of ts) {
    const re = new RegExp(esc(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return out;
}

// ---------- shared fragments ----------
function chips(d, params, max = 8) {
  const ks = new Set(params ? params.getAll('k') : []);
  const mk = (term, cls) => {
    const p = new URLSearchParams(params || ''); if (!ks.has(term)) p.append('k', term);
    return `<a class="chip ${cls}${ks.has(term) ? ' on' : ''}" href="#/list?${p}">${cls === 'tag' ? '#' : ''}${esc(term)}</a>`;
  };
  const all = [...(d.tags || []).map((x) => mk(x, 'tag')), ...(d.keywords || []).map((x) => mk(x, 'kw'))];
  return all.length ? `<div class="chips">${all.slice(0, max).join('')}${all.length > max ? `<span class="dim">+${all.length - max}</span>` : ''}</div>` : '';
}
const docLink = (d) => `<a href="#/doc/${d.id}">${esc(d.title)}</a>`;
const GLOBE = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1.5 8h13M8 1.5c-2.2 2.2-2.2 10.8 0 13M8 1.5c2.2 2.2 2.2 10.8 0 13" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
/** "Public" badge for a project whose catalog entry has visibility: public (subprojects inherit). */
const pubBadge = (k) => (isPublicProject(DATA.projects, k) ? ` <span class="chip vis-pub" title="${th('vis.hint')}">${GLOBE}${th('vis.public')}</span>` : '');
const projectCell = (d) => `<a href="#/project/${encodeURIComponent(d.project)}">${esc(L.proj(d.project))}</a>${d.subproject ? ` / <a href="#/project/${encodeURIComponent(projOf(d))}">${esc(d.subproject)}</a>` : ''}${pubBadge(d.project)}`;
/** Notice for a project or document that comes from an external content source. */
const sourceNote = (name) => (name ? `<div class="banner src">${th('src.external', { name })}</div>` : '');
const noteCount = (d) => (d.notes ? ` <span class="note-n" title="${th('notes.count', { n: d.notes })}">💬${d.notes}</span>` : '');
const tocNav = (items) => `<nav class="toc" aria-label="${th('toc')}"><b>${th('toc')}</b>${items.join('')}</nav>`;

// ---------- home ----------
const HOME_LIMIT = 10;
function focusPicker(focus) {
  const tops = topProjects();
  const text = focus.length ? joinList(focus.map(projTitle)) : t('home.allProjects');
  return `<details class="focus" id="focus"><summary><span class="dim">${th('home.focusLabel')}</span><b>${esc(text)}</b></summary>
    <div class="focus-pop" role="group" aria-label="${th('home.focus')}">
      <label><input type="checkbox" value=""${focus.length ? '' : ' checked'}> ${th('home.allProjects')}</label>
      ${tops.map((k) => `<label><input type="checkbox" value="${esc(k)}"${focus.includes(k) ? ' checked' : ''}> ${esc(projTitle(k))}${pubBadge(k)}</label>`).join('')}
    </div></details>`;
}
function homeTable(rows) {
  if (!rows.length) return `<p class="dim">${th('home.none')}</p>`;
  const people = Boolean(ME);
  return `<table class="docs compact"><thead><tr><th>${th('col.id')}</th><th>${th('col.status')}</th><th>${th('col.title')}</th>${people ? `<th class="c-who">${th('col.assignee')}</th>` : ''}<th class="c-date">${th(ME ? 'col.updated' : 'col.date')}</th></tr></thead><tbody>
    ${rows.map((d) => `<tr class="st" style="${stStyle(d.status)}">
      <td class="id"><a href="#/doc/${d.id}">${pad(d.id)}</a></td>
      <td class="c-st">${statusChip(d.status)}</td>
      <td class="title">${docLink(d)} ${sensBadge(d.sensitivity)}${noteCount(d)}<div class="dim small">${esc(projName(d))}${pubBadge(d.project)}</div></td>
      ${people ? `<td class="c-who" data-label="${th('col.assignee')}">${who(d.assignee)}</td>` : ''}
      <td class="c-date nowrap dim">${esc((d.updated_at || d.date || '').slice(0, 10))}</td></tr>`).join('')}</tbody></table>`;
}
function viewHome(params) {
  const p = params.get('p') || '';
  const focus = (getPrefs().focusProjects || []).filter((x) => DATA.projects[x]);
  const docs = p ? scoped(p) : focusDocs(DATA.docs, focus);
  const secs = homeSections(docs, ME?.email || null);
  const only = secs.find((s) => s.key === params.get('sec'));
  const card = (s, all) => `<section class="card home-sec" id="h-${s.key}"><h2>${esc(s.title)} <span class="count">${s.total}</span>
      ${!all && s.total > HOME_LIMIT ? `<a class="more" href="${scopeLink('home', p, { sec: s.key })}">${th('home.all')}</a>` : ''}</h2>
    ${homeTable(all ? s.rows : s.rows.slice(0, HOME_LIMIT))}</section>`;
  app.innerHTML = `
    <div class="home-head">
      <h1>${only ? `<a href="${scopeLink('home', p)}">${th('nav.home')}</a> › ${esc(only.title)}` : th('nav.home')}</h1>
      ${p ? `<span class="dim">${th('home.scope', { project: projTitle(p) })}</span>` : focusPicker(focus)}
    </div>
    ${ME ? '' : `<p class="dim small">${th('home.staticNote')}</p>`}
    ${only ? card(only, true) : `${tocNav(secs.map((s) => `<button type="button" data-jump="h-${s.key}">${esc(s.title)} <span class="dim">${s.total}</span></button>`))}
    <div class="grid2 home">${secs.map((s) => card(s, false)).join('')}</div>`}`;
  widenCards();
  bindJumps();
  const box = $('#focus');
  box?.addEventListener('change', (e) => {
    const all = box.querySelector('input[value=""]');
    if (e.target === all) box.querySelectorAll('input[value]:not([value=""])').forEach((c) => { c.checked = false; });
    const picked = [...box.querySelectorAll('input:checked')].map((c) => c.value).filter(Boolean);
    setPrefs({ focusProjects: picked }).catch((x) => alert(t('err.prefsNotSaved', { msg: x.message }))).finally(() => {
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
    assignee: (r) => (r.d.assignee ? displayName(r.d.assignee) : '￿'), reviewer: (r) => (r.d.reviewer ? displayName(r.d.reviewer) : '￿'),
  }[sort] || ((r) => r.d.date);
  rows.sort((a, b) => { const x = key(a), y = key(b); const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-Hant'); return dir === 'asc' ? c : -c; });

  const showAssignee = base.some((d) => d.assignee), showReviewer = base.some((d) => d.reviewer);
  const sel = (name, text, values, cur, lab = (v) => v) => `<label>${text}<select data-f="${name}">${opt('', cur, t('list.any'))}${values.map((v) => opt(v, cur, lab(v))).join('')}</select></label>`;
  const thSort = (k, text, cls = '') => `<th class="${cls}" data-sort="${k}"${sort === k ? ` aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"` : ''}>${text}</th>`;
  const anyFilter = q || ks.length || Object.values(f).some(Boolean);
  const kwOptions = uniq(base.flatMap((d) => [...(d.tags || []), ...(d.keywords || [])])).filter((k) => !ks.includes(k));
  const local = lsGet();
  const curQs = (() => { const c = new URLSearchParams(params); c.delete('sort'); c.delete('dir'); return c.toString(); })();
  const SORTS = [['date', 'col.date'], ['id', 'col.id'], ['title', 'col.title'], ['status', 'col.status'], ['sens', 'col.sens'], ['project', 'col.project'],
    ...(pq.terms.length ? [['score', 'col.score']] : []), ...(showAssignee ? [['assignee', 'col.assignee']] : [])];
  const scopeNote = (p ? th('list.inProject', { project: projTitle(p) }) : '') + (q ? th('list.forQuery', { q }) : '');

  app.innerHTML = `
    <section class="saved" aria-label="${th('list.savedFilters')}">
      <span class="dim">${th('list.filtersLabel')}</span>
      ${DATA.filters.map((sf) => `<a class="chip saved-chip${q === sf.query && !ks.length ? ' on' : ''}" href="${scopeLink('list', p, { q: sf.query })}">${esc(sf.name)}</a>`).join('')}
      ${local.map((sf, i) => `<span class="chip saved-chip local${curQs === sf.params ? ' on' : ''}"><a href="#/list?${esc(sf.params)}">${esc(sf.name)}</a><button type="button" data-del="${i}" aria-label="${th('list.deleteFilter', { name: sf.name })}">×</button></span>`).join('')}
      ${anyFilter ? `<button type="button" id="save" class="linkish">${th('list.saveFilter')}</button>` : ''}
    </section>
    <section class="filters" aria-label="${th('list.filters')}">
      ${sel('c', th('col.category'), DATA.categories.filter((c) => base.some((d) => d.category === c)), f.c, L.cat)}
      ${sel('s', th('col.status'), DATA.statuses.filter((s) => base.some((d) => d.status === s)), f.s, L.st)}
      ${sel('sv', th('col.sens'), SENSITIVITIES.filter((s) => base.some((d) => d.sensitivity === s)), f.sv, L.sv)}
      ${sel('ty', th('col.type'), uniq(base.map((d) => d.type)), f.ty)}
      <label>${th('list.kwTag')}<select id="addk">${opt('', '', ks.length ? t('list.addAnother') : t('list.any'))}${kwOptions.map((k) => opt(k, '')).join('')}</select></label>
      <label class="m-sort">${th('list.sort')}<select id="msort">${SORTS.flatMap(([k, l]) => [opt(`${k}:desc`, `${sort}:${dir}`, `${t(l)} ↓`), opt(`${k}:asc`, `${sort}:${dir}`, `${t(l)} ↑`)]).join('')}</select></label>
    </section>
    ${ks.length ? `<div class="chips active">${ks.map((k) => { const n = new URLSearchParams(params); const rest = ks.filter((x) => x !== k); n.delete('k'); rest.forEach((x) => n.append('k', x)); return `<a class="chip kw on" href="#/list?${n}" title="${th('list.remove')}">${esc(k)} ×</a>`; }).join('')}</div>` : ''}
    <div class="bar">
      <span>${th('list.showing', { shown: rows.length, n: base.length })}${scopeNote}</span>
      ${anyFilter ? `<button type="button" id="reset">${th('list.reset')}</button>` : ''}
    </div>
    ${rows.length ? `<div class="tbl-wrap"><table class="docs">
      <thead><tr>${thSort('id', th('col.id'))}${thSort('status', th('col.status'), 'c-st')}${thSort('sens', th('col.sens'), 'c-sens')}${thSort('project', th('col.project'), 'c-proj')}${thSort('category', th('col.category'), 'c-cat')}${thSort('title', th('col.title'))}${showAssignee ? thSort('assignee', th('col.assignee'), 'c-who') : ''}${showReviewer ? thSort('reviewer', th('col.reviewer'), 'c-who') : ''}${thSort('date', th(ME ? 'col.updated' : 'col.date'), 'c-date')}<th class="c-type">${th('col.type')}</th></tr></thead>
      <tbody>${rows.map(({ d, m }) => `
        <tr class="st" style="${stStyle(d.status)}">
          <td class="id"><a href="#/doc/${d.id}">${pad(d.id)}</a></td>
          <td class="c-st">${statusChip(d.status)}</td>
          <td class="c-sens">${sensBadge(d.sensitivity)}</td>
          <td class="c-proj nowrap">${projectCell(d)}</td>
          <td class="c-cat nowrap">${esc(L.cat(d.category))}</td>
          <td class="title"><a href="#/doc/${d.id}">${highlight(d.title, highlightTerms)}</a>${noteCount(d)}${d.offline ? ` <span class="offline">${th('doc.offlineChip')}</span>` : ''}
            ${d.desc ? `<div class="desc">${highlight(d.desc, highlightTerms)}</div>` : ''}
            ${m.snip ? `<div class="snip">${highlight(m.snip, highlightTerms)}</div>` : ''}
            ${chips(d, params, 6)}</td>
          ${showAssignee ? `<td class="c-who" data-label="${th('col.assignee')}">${who(d.assignee)}</td>` : ''}
          ${showReviewer ? `<td class="c-who" data-label="${th('col.reviewer')}">${who(d.reviewer)}</td>` : ''}
          <td class="c-date nowrap dim">${esc((d.updated_at || d.date || '').slice(0, 10))}</td>
          <td class="c-type type">${esc(d.type)}</td>
        </tr>`).join('')}</tbody></table></div>` : `<p class="empty">${th('list.empty')}</p>`}`;

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
    const name = (prompt(t('list.filterName'), q || ks.join(' ') || t('list.myFilter')) || '').trim();
    if (!name) return;
    const list = lsGet().filter((x) => x.name !== name).concat({ name, params: curQs });
    if (!lsSet(list)) alert(t('err.storage'));
    render();
  });
  app.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', () => {
    const list = lsGet(); list.splice(Number(b.dataset.del), 1); lsSet(list); render();
  }));
}

// ---------- summary ----------
const SELF = '\u0000self'; // summary row for docs directly in the scoped top-level project (no subproject)
function countTable(docs, rowsOf, cols, field, colKey, rowLabel, rowLink, colLabel = (c) => c) {
  const rows = uniq(docs.map(rowsOf));
  const rowName = (r) => (r === SELF ? t('sum.thisProject') : L.proj(r));
  const cell = (n, params) => n ? `<a href="${link('list', params)}">${n}</a>` : '<span class="zero">0</span>';
  return `<table class="matrix"><thead><tr><th>${esc(rowLabel)}</th>${cols.map((c) => `<th>${esc(colLabel(c))}</th>`).join('')}<th>${th('sum.total')}</th></tr></thead>
    <tbody>${rows.map((r) => {
      const rd = docs.filter((d) => rowsOf(d) === r);
      return `<tr><td><a href="${link('list', rowLink(r))}">${esc(rowName(r))}</a></td>${cols.map((c) => `<td>${cell(rd.filter((d) => d[field] === c).length, { ...rowLink(r), [colKey]: c })}</td>`).join('')}<td>${cell(rd.length, rowLink(r))}</td></tr>`;
    }).join('')}</tbody>
    <tfoot><tr><td>${th('sum.total')}</td>${cols.map((c) => `<td>${docs.filter((d) => d[field] === c).length}</td>`).join('')}<td>${docs.length}</td></tr></tfoot></table>`;
}
function kwCloud(docs, p) {
  const counts = {};
  docs.forEach((d) => [...(d.tags || []), ...(d.keywords || [])].forEach((k) => { counts[k] = (counts[k] || 0) + 1; }));
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hant'));
  if (!entries.length) return `<p class="dim">${th('sum.noKeywords')}</p>`;
  const max = entries[0][1];
  return `<div class="cloud">${entries.map(([k, n]) => `<a href="${scopeLink('list', p, { k })}" style="font-size:${(12 + 10 * (n / max)).toFixed(1)}px">${esc(k)}<sup>${n}</sup></a>`).join('')}</div>`;
}
function viewSummary(params) {
  const p = params.get('p') || '';
  const docs = scoped(p);
  const isTop = p && !p.includes('/');
  const rowsOf = p ? (isTop ? (d) => d.subproject || SELF : () => p) : (d) => d.project;
  const rowLink = (r) => ({ p: p ? (isTop && r !== SELF ? `${p}/${r}` : p) : r });
  const cats = DATA.categories.filter((c) => docs.some((d) => d.category === c));
  const sts = DATA.statuses.filter((s) => docs.some((d) => d.status === s));
  const svs = SENSITIVITIES.filter((s) => docs.some((d) => d.sensitivity === s));
  const rowLabel = t(p && isTop ? 'sum.subproject' : 'col.project');
  const byMonth = {};
  docs.forEach((d) => { const m = d.date.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; });
  const heads = ['sum.byCategory', 'sum.byStatus', 'sum.bySens', 'sum.cloud', 'sum.byMonth'];
  app.innerHTML = `
    ${tocNav(heads.map((k, i) => `<button type="button" data-jump="sec${i}">${th(k)}</button>`))}
    <div class="grid2 dense">
      <section class="card" id="sec0"><h2>${th(heads[0])}</h2>${countTable(docs, rowsOf, cats, 'category', 'c', rowLabel, rowLink, L.cat)}</section>
      <section class="card" id="sec1"><h2>${th(heads[1])}</h2>${countTable(docs, rowsOf, sts, 'status', 's', rowLabel, rowLink, L.st)}</section>
      <section class="card" id="sec2"><h2>${th(heads[2])}</h2>${countTable(docs, rowsOf, svs, 'sensitivity', 'sv', rowLabel, rowLink, L.sv)}</section>
      <section class="card" id="sec3"><h2>${th(heads[3])}</h2>${kwCloud(docs, p)}</section>
      <section class="card" id="sec4"><h2>${th(heads[4])}</h2><table class="matrix"><thead><tr><th>${th('sum.month')}</th><th>${th('sum.docs')}</th></tr></thead><tbody>
        ${Object.keys(byMonth).sort().reverse().map((m) => `<tr><td>${m}</td><td><a href="${scopeLink('list', p, { q: `date:${m}` })}">${byMonth[m]}</a></td></tr>`).join('')}</tbody></table></section>
    </div>`;
  widenCards();
  bindJumps();
}
/** Cards whose table does not fit their grid column (e.g. a category matrix with many columns) span the full row. */
function widenCards() {
  const cards = [...app.querySelectorAll('.grid2 > .card')];
  cards.forEach((c) => c.classList.remove('wide'));
  cards.filter((c) => c.scrollWidth > c.clientWidth + 1).forEach((c) => c.classList.add('wide'));
}
let widenTimer;
window.addEventListener('resize', () => {
  clearTimeout(widenTimer);
  widenTimer = setTimeout(() => {
    document.documentElement.style.setProperty('--top-h', `${$('.topbar').offsetHeight}px`);
    if (['summary', 'home'].includes(document.body.dataset.view)) widenCards();
  }, 120);
});
function bindJumps() {
  app.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
    const el = document.getElementById(b.dataset.jump);
    if (el?.tagName === 'DETAILS') el.open = true; // folded sections on the doc page
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
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
      <div class="tl-body">${docLink(d)} ${sensBadge(d.sensitivity)} <span class="chip">${esc(projName(d))}</span>${pubBadge(d.project)} <span class="chip">${esc(L.cat(d.category))}</span>
      ${d.desc ? `<div class="desc">${esc(d.desc)}</div>` : ''}</div></div>`;
  }).join('') : `<p class="empty">${th('empty.scope')}</p>`;
}

// ---------- graph (site/graph.js; it loads graph.css itself) ----------
async function viewGraph(params, seq) {
  const p = params.get('p') || '';
  app.innerHTML = `<p class="loading">${th('graph.loading')}</p>`;
  try {
    const m = await import('./graph.js');
    graphMod = m;
    if (seq !== renderSeq) return;
    app.innerHTML = '';
    await m.renderGraph(app, { docs: scoped(p), projects: DATA.projects, site: DATA.site, scope: p, go: (hash) => { location.hash = hash; } });
  } catch (e) {
    console.error(e);
    if (seq === renderSeq) app.innerHTML = `<p class="empty">${th('graph.failed')}</p>`;
  }
}

// ---------- admin (site/admin.js) ----------
async function viewAdmin(params, seq) {
  if (!ME) { app.innerHTML = `<p class="empty">${th('admin.needServer')}</p>`; return; }
  if (!isManager(ME)) { app.innerHTML = `<p class="empty">${th('admin.noRight')}</p>`; return; }
  app.innerHTML = `<p class="loading">${th('admin.loading')}</p>`;
  try {
    const m = await import('./admin.js');
    if (seq !== renderSeq) return;
    await m.renderAdmin(app, { me: ME, api, esc, projects: topProjects(), registry: DATA.projects, tab: params.get('tab') || '', link });
  } catch (e) {
    if (seq === renderSeq) app.innerHTML = `<p class="empty">${th('admin.loadFailed', { msg: e.message })}</p>`;
  }
}

// ---------- project ----------
function miniCounts(docs, field, values, colKey, p, lab = (v) => esc(v)) {
  return `<table class="matrix"><tbody>${values.filter((v) => docs.some((d) => d[field] === v)).map((v) =>
    `<tr><td>${lab(v)}</td><td><a href="${scopeLink('list', p, { [colKey]: v })}">${docs.filter((d) => d[field] === v).length}</a></td></tr>`).join('')}</tbody></table>`;
}
function viewProject(name, params = new URLSearchParams(), seq = renderSeq) {
  const info = DATA.projects[name];
  const docs = scoped(name);
  if (!info && !docs.length) { app.innerHTML = `<p class="empty">${th('prj.notFound')}</p>`; return; }
  const subs = Object.entries(DATA.projects).filter(([, v]) => v.parent === name);
  const parent = info?.parent;
  const title = projTitle(name);
  app.innerHTML = `
    <div class="crumbs"><a href="#/list">${th('nav.list')}</a>${parent ? ` › <a href="#/project/${encodeURIComponent(parent)}">${esc(L.proj(parent))}</a>` : ''} › ${esc(title)}</div>
    <div class="detail-head"><div><h1>${esc(title)}${pubBadge(name)}</h1>${info?.desc ? `<p class="lead">${esc(info.desc)}</p>` : `<p class="lead dim">${th('prj.noDesc', { name })}</p>`}</div>
      <div class="actions"><a class="btn primary" href="${scopeLink('list', name)}">${th('prj.listN', { n: docs.length })}</a><a class="btn" href="${scopeLink('summary', name)}">${th('nav.summary')}</a><a class="btn" href="${scopeLink('home', name)}">${th('nav.home')}</a></div></div>
    ${sourceNote(sourceOfProject(DATA.projects, name))}
    ${subs.length ? `<h2 class="h2">${th('prj.subprojects')}</h2><div class="subgrid">${subs.map(([k, v]) => `<a class="card sub" href="#/project/${encodeURIComponent(k)}"><b>${esc(v.title)}${pubBadge(k)}</b><span class="dim">${th('prj.subCount', { n: scoped(k).length })}</span>${v.desc ? `<span class="desc">${esc(v.desc)}</span>` : ''}</a>`).join('')}</div>` : ''}
    <div class="grid3">
      <section class="card"><h2>${th('col.category')}</h2>${miniCounts(docs, 'category', DATA.categories, 'c', name, (v) => esc(L.cat(v)))}</section>
      <section class="card"><h2>${th('col.status')}</h2>${miniCounts(docs, 'status', DATA.statuses, 's', name, (v) => esc(L.st(v)))}</section>
      <section class="card"><h2>${th('col.sensitivity')}</h2>${miniCounts(docs, 'sensitivity', SENSITIVITIES, 'sv', name, sensBadge)}</section>
    </div>
    <section class="card"><h2>${th('prj.keywords')}</h2>${kwCloud(docs, name)}</section>
    <h2 class="h2">${th('prj.recent')}</h2>
    <div class="recent">${docs.slice(0, 10).map((d) => `<div class="tl-item" style="${stStyle(d.status)}"><div class="tl-when dim">${esc(d.date)}</div><div class="tl-body">${docLink(d)} ${sensBadge(d.sensitivity)} <span class="chip">${esc(L.cat(d.category))}</span></div></div>`).join('')}</div>
    ${vaultSectionHtml(name)}`;
  if ($('#p-vault')) loadProjectVault(name, seq).then(() => { if (params.get('sec') === 'vault' && seq === renderSeq) $('#p-vault')?.scrollIntoView({ block: 'start' }); });
}

// ---------- project vault (server mode; DESIGN.md → Tenant vaults) ----------
// Namespace `<project>/`: editors list, managers (owners: any) add / replace / delete web secrets and reveal any
// origin. Values only ever exist in the masked reveal dialog and in the password field while a form is open.
const VALUE_MAX = 16 * 1024;
/** 503 = the server has no VAULT_KEY: say so instead of a bare status. */
const vaultMsg = (x) => (x.status === 503 ? t('pv.noKey') : x.message);
/** Top-level project whose key can be a vault namespace and whose vault `ME` may see (editor+). */
const vaultProject = (name) => Boolean(ME) && !DATA.projects[name]?.parent && NAME_RE.test(name) && !name.includes('/') && atLeast(roleFor(ME, name), 'editor');
const vaultManager = (name) => atLeast(roleFor(ME, name), 'manager');
function vaultSectionHtml(name) {
  if (!vaultProject(name)) return '';
  const manage = vaultManager(name);
  return `<section class="card" id="p-vault"><h2>${th('pv.title')} <code>${esc(name)}/</code></h2>
    <p class="dim small">${th(manage ? 'pv.introManager' : 'pv.introEditor')}</p>
    <div id="pv-list"><p class="loading">${th('loading')}</p></div>
    ${manage ? `<button type="button" class="linkish" id="pv-add">${th('pv.add')}</button>
    <form id="pv-form" class="uedit pv-form" hidden autocomplete="off">
      <h3 class="pv-form-title"></h3>
      <label>${th('pv.name')}<input name="name" required spellcheck="false" autocapitalize="off" maxlength="200"></label>
      <label>${th('pv.value')}<span class="pw"><input name="value" type="password" autocomplete="new-password" spellcheck="false" required><button type="button" class="btn small" data-peek aria-pressed="false">${th('vault.show')}</button></span></label>
      <label>${th('pv.note')}<input name="note" maxlength="200" placeholder="${th('pv.notePh')}"></label>
      <div class="wf-row"><button type="submit" class="btn primary">${th('btn.save')}</button><button type="button" class="btn" data-cancel>${th('btn.cancel')}</button><span class="msg" aria-live="polite"></span></div>
    </form>` : ''}</section>`;
}
const ORIGIN_KEYS = { web: 'pv.originWeb', git: 'pv.originGit', host: 'pv.originHost' };
const ORIGIN_HINTS = { web: 'pv.originWebHint', git: 'pv.originGitHint', host: 'pv.originHostHint' };
function vaultTable(rows, manage) {
  if (!rows.length) return `<p class="dim">${th('pv.empty')}</p>`;
  // One format for every store (git/host rows only know the day); the exact time of web edits stays in the tooltip.
  const date = (v) => (!v ? '<span class="dim">—</span>' : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? esc(v) : `<span title="${fmtTime(v)}">${esc(String(v).slice(0, 10))}</span>`);
  return `<div class="tbl-wrap"><table class="docs compact pv-table"><thead><tr><th>${th('pv.name')}</th><th>${th('pv.note')}</th><th>${th('pv.origin')}</th><th>${th('pv.updatedBy')}</th><th class="c-date">${th('col.updated')}</th><th></th></tr></thead><tbody>
    ${rows.map((r, i) => {
      const origin = ORIGIN_KEYS[r.origin] ? r.origin : 'host';
      const also = (r.stores || []).filter((x) => x !== origin && ORIGIN_KEYS[x]);
      const actions = [
        `<button type="button" class="btn small" data-open="${i}"${manage ? '' : ` disabled title="${th('srv.needManager')}"`}>${th('pv.reveal')}</button>`,
        (r.stores || [r.origin]).includes('web') // edit / delete touch the web copy only
          ? (manage ? `<button type="button" class="btn small" data-edit="${i}">${th('pv.replace')}</button><button type="button" class="btn small danger" data-del="${i}">${th('pv.delete')}</button>` : '')
          : `<span class="dim small">${th(origin === 'git' ? 'pv.managedGit' : 'pv.managedHost')}</span>`,
      ].join(' ');
      return `<tr><td class="pv-name"><code>${esc(r.name)}</code></td><td>${esc(r.note || '')}</td>
        <td><span class="chip pv-origin o-${origin}" title="${th(ORIGIN_HINTS[origin])}">${th(ORIGIN_KEYS[origin])}</span>${also.length ? ` <span class="dim small">${th('pv.alsoIn', { list: joinList(also.map((x) => t(ORIGIN_KEYS[x]))) })}</span>` : ''}</td>
        <td data-label="${th('pv.updatedBy')}">${who(r.updated_by)}</td><td class="c-date nowrap dim">${date(r.updated_at)}</td>
        <td class="pv-actions">${actions}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}
async function loadProjectVault(name, seq) {
  const box = $('#pv-list');
  if (!box) return;
  let rows;
  try {
    const r = await api('GET', `/api/vault/secrets?project=${encodeURIComponent(name)}`);
    rows = (Array.isArray(r) ? r : r?.secrets || []).filter((x) => x && typeof x.name === 'string').sort((a, b) => a.name.localeCompare(b.name));
  } catch (x) {
    if (seq === renderSeq) box.innerHTML = `<p class="err">${th('err.loadFailed', { msg: vaultMsg(x) })}</p>`;
    return;
  }
  if (seq !== renderSeq || !box.isConnected) return;
  rows.forEach((r) => addPeople({ [r.updated_by]: r.updated_by_name }));
  const manage = vaultManager(name);
  box.innerHTML = vaultTable(rows, manage);
  box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => revealSecretDialog(rows[b.dataset.open].name, { allowed: manage, denied: t('srv.needManager') })));
  box.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openVaultForm(name, rows[b.dataset.edit], seq)));
  box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const r = rows[b.dataset.del];
    if (!confirm(t('pv.confirmDelete', { name: r.name }))) return;
    b.disabled = true;
    try { await api('DELETE', `/api/vault/secrets/${encodeURIComponent(r.name)}`); await loadProjectVault(name, seq); }
    catch (x) { b.disabled = false; alert(t('err.failed', { msg: vaultMsg(x) })); }
  }));
  const add = $('#pv-add');
  if (add && !add.dataset.bound) { add.dataset.bound = '1'; add.addEventListener('click', () => openVaultForm(name, null, seq)); }
}
/** Add (row = null) or replace a web secret. Closing the form always clears the value field. */
function openVaultForm(project, row, seq) {
  const f = $('#pv-form');
  if (!f) return;
  const val = f.elements.value, peek = f.querySelector('[data-peek]'), msg = f.querySelector('.msg');
  const reset = () => { val.value = ''; val.type = 'password'; peek.setAttribute('aria-pressed', 'false'); peek.textContent = t('vault.show'); msg.textContent = ''; };
  reset();
  f.querySelector('.pv-form-title').textContent = row ? t('pv.replaceTitle', { name: row.name }) : t('pv.addTitle');
  f.elements.name.value = row ? row.name : `${project}/`;
  f.elements.name.readOnly = Boolean(row);
  f.elements.note.value = row?.note || '';
  f.hidden = false;
  (row ? val : f.elements.name).focus();
  if (f.dataset.bound) return;
  f.dataset.bound = '1';
  peek.addEventListener('click', () => {
    const show = val.type === 'password';
    val.type = show ? 'text' : 'password';
    peek.setAttribute('aria-pressed', String(show));
    peek.textContent = t(show ? 'vault.hide' : 'vault.show');
  });
  f.querySelector('[data-cancel]').addEventListener('click', () => { reset(); f.hidden = true; });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = f.elements.name.value.trim(), value = val.value, note = f.elements.note.value.trim();
    const okName = name.startsWith(`${project}/`) && NAME_RE.test(name) && name.length <= 200 && !name.split('/').some((seg) => !seg);
    if (!okName) { msg.textContent = t('pv.badName', { prefix: `${project}/` }); f.elements.name.focus(); return; }
    if (!value) { msg.textContent = t('pv.valueRequired'); val.focus(); return; }
    if (new TextEncoder().encode(value).length > VALUE_MAX) { msg.textContent = t('pv.valueTooLong', { n: VALUE_MAX / 1024 }); return; }
    msg.textContent = t('wf.saving');
    try {
      await api('PUT', '/api/vault/secrets', { name, value, note });
      reset(); f.hidden = true;
      await loadProjectVault(project, seq);
      const m = $('#pv-list'); if (m) m.insertAdjacentHTML('afterbegin', `<p class="dim small pv-saved" role="status">${th('pv.saved', { name })}</p>`);
    } catch (x) { msg.textContent = t('wf.saveFailed', { msg: vaultMsg(x) }); }
  });
}

// ---------- doc detail ----------
const DOC_SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads';
// A sandboxed HTML doc asks to show a vault field: accept only from the preview iframe of the open doc, and only for
// names that doc references. The request only opens a masked portal dialog; nothing is revealed (or audited) until the
// user clicks Show / Copy there, and the value is never sent back to the document.
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
/** URL of a doc path with every segment encoded: encodeURI leaves '?' and '#', so a file name with one would load
 *  a different file (the part before it) or drop the rest of the path. */
const docHref = (p) => String(p).split('/').map(encodeURIComponent).join('/');
let previewSeq = 0;
/** Render doc `d` into `pv`: 'preview' (sandboxed iframe / sanitized Markdown / text) or 'source' (escaped text). */
async function renderPreview(d, pv, mode = 'preview') {
  const seq = ++previewSeq;
  const href = docHref(d.path);
  pv.dataset.mode = mode;
  // Documents are untrusted: sandboxed without allow-same-origin (the /docs/* CSP header enforces the same).
  // Not lazy: the preview is the main content of the page.
  if (d.type === 'html' && mode === 'preview') { pv.innerHTML = `<iframe class="preview" src="${href}" title="${esc(d.title)}" sandbox="${DOC_SANDBOX}"></iframe>`; return; }
  pv.innerHTML = `<p class="loading">${th('doc.loadingPreview')}</p>`;
  let text;
  try {
    text = await fetch(href).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
  } catch (x) {
    if (seq === previewSeq) pv.innerHTML = `<p class="err">${th('doc.previewFailed', { msg: x.message })}</p>`;
    return;
  }
  if (seq !== previewSeq) return; // a newer mode switch or navigation took over
  if (d.type === 'md' && mode === 'preview') {
    try {
      if (!window.marked) await loadScript(MARKED);
      if (!window.DOMPurify) await loadScript(PURIFY);
      if (seq !== previewSeq) return;
      pv.innerHTML = `<article class="md">${window.DOMPurify.sanitize(window.marked.parse(text.replace(/^---\n[\s\S]*?\n---\n/, '')))}</article>`;
      vaultMask(pv, d.id);
      return;
    } catch { /* CDN unavailable: fall through to raw text */ }
  }
  pv.innerHTML = `<pre class="raw">${esc(text)}</pre>`;
  vaultMask(pv, d.id);
}
/** Full-screen toggle of the content section (CSS overlay over the viewport; Esc or the button exits). */
function setFull(sec, on) {
  if (!sec) return;
  sec.classList.toggle('pv-full', on);
  document.body.classList.toggle('pv-lock', on);
  const b = sec.querySelector('[data-full]');
  if (b) { b.setAttribute('aria-pressed', String(on)); b.textContent = t(on ? 'doc.exitFullscreen' : 'doc.fullscreen'); }
  if (on) b?.focus();
}
function relList(ids, empty = '') {
  const docs = ids.map(byId).filter(Boolean);
  return docs.length ? `<ul class="rel">${docs.map((d) => `<li><span class="id">${pad(d.id)}</span> ${docLink(d)} ${sensBadge(d.sensitivity)} <span class="dim">${esc(projName(d))} · ${esc(d.date)}</span></li>`).join('')}</ul>` : (empty ? `<p class="dim">${esc(empty)}</p>` : '');
}
const knownPeople = () => uniq([ME?.email, ...peopleEmails(), ...DATA.docs.flatMap((d) => [d.reporter, d.assignee, d.reviewer, d.updated_by])].map((e) => e && String(e).toLowerCase()));
function editForm(d) {
  const statuses = [...WORKFLOW, ...(WORKFLOW.includes(d.status) || !d.status ? [] : [d.status])];
  return `<section class="card" id="d-edit"><h2>${th('wf.title')}</h2>
    <form class="wf" id="wf">
      <label>${th('col.status')}<select name="status">${statuses.map((s) => opt(s, d.status, LEGACY_STATUS[s] ? t('wf.legacy', { status: L.st(s) }) : L.st(s))).join('')}</select></label>
      <label>${th('col.assignee')}<input name="assignee" list="people" value="${esc(displayName(d.assignee))}" placeholder="${th('wf.assigneePh')}" autocomplete="off"></label>
      <label>${th('col.reviewer')}<input name="reviewer" list="people" value="${esc(displayName(d.reviewer))}" placeholder="${th('wf.reviewerPh')}" autocomplete="off"></label>
      <label class="wide">${th('wf.tags')}<input name="tags" value="${esc((d.tags || []).join(', '))}" placeholder="${th('wf.tagsPh')}" autocomplete="off"></label>
      <div class="wf-row"><button type="submit" class="btn primary">${th('btn.save')}</button><span class="msg" aria-live="polite"></span></div>
      <datalist id="people">${knownPeople().map((e) => `<option value="${esc(personChoice(e))}">`).join('')}</datalist>
    </form></section>`;
}
function notesHtml(notes) {
  notes.forEach((n) => addPeople({ [n.author]: n.author_name }));
  return notes.length ? `<ol class="notes">${notes.map((n) => `<li><div class="note-meta">${who(n.author)} <span class="dim">· ${fmtTime(n.created_at)}</span></div><div class="note-body">${esc(n.body)}</div></li>`).join('')}</ol>` : `<p class="dim">${th('notes.none')}</p>`;
}
function auditHtml(rows) {
  const val = (r, v) => esc(r.field === 'status' ? L.st(v) : EMAIL_RE.test(String(v)) ? displayName(v) : v);
  const change = (r) => (r.field ? `<code>${esc(r.field)}</code> ${r.old != null && r.old !== '' ? `<del>${val(r, r.old)}</del> → ` : ''}${val(r, r.new ?? '')}` : esc(r.new ?? ''));
  rows.forEach((r) => addPeople({ [r.actor]: r.actor_name }));
  return rows.length ? `<table class="matrix hist"><thead><tr><th>${th('col.time')}</th><th>${th('col.who')}</th><th>${th('col.action')}</th><th>${th('col.change')}</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="nowrap">${fmtTime(r.at)}</td><td>${who(r.actor)}</td><td>${esc(r.action)}</td><td>${change(r)}</td></tr>`).join('')}</tbody></table>` : `<p class="dim">${th('audit.none')}</p>`;
}
async function loadDocServer(d, seq) {
  const nBox = $('#notes-list'), hBox = $('#audit-list');
  const [notes, hist] = await Promise.allSettled([api('GET', `/api/docs/${d.id}/notes`), api('GET', `/api/docs/${d.id}/history`)]);
  if (seq !== renderSeq) return;
  nBox.innerHTML = notes.status === 'fulfilled' ? notesHtml(notes.value || []) : `<p class="err">${th('notes.loadFailed', { msg: notes.reason.message })}</p>`;
  hBox.innerHTML = hist.status === 'fulfilled' ? auditHtml(hist.value || []) : `<p class="err">${th('audit.loadFailed', { msg: hist.reason.message })}</p>`;
}
function bindDocServer(d, seq) {
  const wf = $('#wf');
  wf?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = wf.querySelector('.msg');
    const form = Object.fromEntries(new FormData(wf));
    // person fields show names; turn what was typed ('Name <email>', an email or a known name) back into an email
    for (const k of ['assignee', 'reviewer']) {
      // untouched field: keep the stored email even if that person's display name changed since the form was drawn
      if (String(form[k]).trim() === wf.elements[k].defaultValue.trim()) { form[k] = d[k] || ''; continue; }
      const r = resolvePerson(form[k], knownPeople(), d[k]);
      if (r.error) { msg.textContent = t(r.error === 'ambiguous' ? 'wf.ambiguousPerson' : 'wf.unknownPerson', { name: String(form[k]).trim() }); wf.elements[k].focus(); return; }
      form[k] = r.email;
    }
    const body = patchDiff(d, form);
    if (!Object.keys(body).length) { msg.textContent = t('wf.noChange'); return; }
    msg.textContent = t('wf.saving');
    try {
      const s = await api('PATCH', `/api/docs/${d.id}`, body);
      Object.assign(d, mergeState([d], { docs: { [d.path]: { ...body, ...(s?.state || s || {}) } } })[0]);
      DATA.statuses = statusList(DATA.statuses, DATA.docs);
      await render();
      const m = $('#wf .msg'); if (m) m.textContent = t('wf.saved');
    } catch (x) { msg.textContent = t('wf.saveFailed', { msg: x.message }); }
  });
  const nf = $('#note-form');
  nf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ta = nf.querySelector('textarea'), btn = nf.querySelector('button'), msg = nf.querySelector('.msg');
    const text = ta.value.trim();
    if (!text) return;
    btn.disabled = true; msg.textContent = t('notes.sending');
    try {
      await api('POST', `/api/docs/${d.id}/notes`, { body: text });
      ta.value = ''; msg.textContent = '';
      d.notes = (d.notes || 0) + 1;
      await loadDocServer(d, seq);
    } catch (x) { msg.textContent = t('notes.sendFailed', { msg: x.message }); } finally { btn.disabled = false; }
  });
}
async function viewDoc(id, seq) {
  const d = byId(id);
  if (!d) { app.innerHTML = `<p class="empty">${th('doc.notFound')}</p>`; return; }
  const href = docHref(d.path);
  const kb = (d.size / 1024).toFixed(d.size > 1e6 ? 0 : 1);
  const related = uniq([...(d.related || []), ...DATA.docs.filter((x) => (x.related || []).includes(d.id)).map((x) => x.id)].map(String)).map(Number);
  const supersededBy = DATA.docs.filter((x) => x.supersedes === d.id);
  const exclude = new Set([d.id, ...related]);
  const mine = new Set(d.keywords || []);
  const similar = DATA.docs.filter((x) => !exclude.has(x.id))
    .map((x) => ({ x, n: (x.keywords || []).filter((k) => mine.has(k)).length, u: new Set([...(x.keywords || []), ...mine]).size }))
    .filter((s) => s.n > 0).sort((a, b) => b.n / b.u - a.n / a.u || b.n - a.n).slice(0, 5).map((s) => s.x.id);
  const editable = ME && canEdit(ME, d);
  const docSource = d.source || sourceOfProject(DATA.projects, projOf(d));
  const wide = matchMedia('(min-width: 1200px)').matches;
  const noContent = d.offline || d.restricted; // 極機密: not deployed; restricted: the server refuses /docs/* to this user
  const canToggle = !noContent && (d.type === 'html' || d.type === 'md');
  // content first; the sidebar (info, workflow) and the folded sections follow in the ToC
  const sections = [['pv', 'doc.content'], ['info', 'doc.info'], ...(editable ? [['edit', 'wf.title']] : []), ...(ME ? [['notes', 'notes.title'], ['audit', 'audit.title']] : []), ['rel', 'doc.relations'], ['hist', 'doc.gitHistory']];
  const vaultNote = ME ? (editable ? th('doc.vaultNoteServer') : th('doc.vaultNoteNoRole', { reason: noRole() })) : th('doc.vaultNoteStatic');
  const person = (key, email) => (email || ME ? `<tr><th>${th(key)}</th><td>${email ? who(email) : `<span class="dim">${th('doc.unset')}</span>`}</td></tr>` : '');
  const supersededLinks = supersededBy.map((x) => `<a href="#/doc/${x.id}">${pad(x.id)} ${esc(x.title)}</a>`);
  const fold = (id, key, body, open = false, hint = '') => `<details class="card fold" id="${id}"${open ? ' open' : ''}><summary><h2>${th(key)}${hint ? ` <span class="dim small">${hint}</span>` : ''}</h2></summary>${body}</details>`;
  const content = d.offline
    ? `<div class="banner sv3">${LOCK} ${th('doc.bannerOffline', { level: L.sv(SENSITIVITIES[3]), path: d.path })}</div>`
    : d.restricted ? `<div class="pv-gate pv-restricted"><div class="banner sv2">${LOCK} ${th('doc.restricted')}</div></div>`
    : `<div id="pv">${d.gated ? `<div class="pv-gate"><div class="banner sv2">${LOCK} ${th('doc.bannerGated', { level: L.sv(SENSITIVITIES[2]) })}</div><button type="button" class="btn primary" id="reveal">${th('doc.reveal')}</button></div>` : ''}</div>`;
  const tools = noContent ? '' : `<div class="pv-tools">
      ${canToggle ? `<div class="seg" role="group" aria-label="${th('doc.view')}"><button type="button" data-mode="preview" aria-pressed="true">${th('doc.viewPreview')}</button><button type="button" data-mode="source" aria-pressed="false">${th('doc.viewSource')}</button></div>` : ''}
      <button type="button" class="btn small" data-full aria-pressed="false">${th('doc.fullscreen')}</button>
      <a class="btn small" href="${href}" target="_blank" rel="noopener">${th('doc.openTab')}</a></div>`;
  app.innerHTML = `
    <div class="crumbs"><a href="#/list">${th('nav.list')}</a> › <a href="#/project/${encodeURIComponent(d.project)}">${esc(L.proj(d.project))}</a>${d.subproject ? ` › <a href="#/project/${encodeURIComponent(projOf(d))}">${esc(d.subproject)}</a>` : ''} › ${pad(d.id)}</div>
    <div class="detail-head"><h1>${esc(d.title)}</h1>
      <div class="actions">${statusChip(d.status)} ${sensBadge(d.sensitivity)}
      ${d.url ? `<a class="btn" href="${esc(d.url)}" target="_blank" rel="noopener">${th('doc.origin')}</a>` : ''}</div></div>
    ${supersededBy.length ? `<div class="banner sv1">${th('doc.supersededBy', { links: raw(joinList(supersededLinks)) })}</div>` : ''}
    ${sourceNote(docSource)}
    ${d.vaultBlocked > 0 ? `<div class="banner sv2">${LOCK} ${th('src.vaultBlocked', { n: d.vaultBlocked, name: docSource || '?' })}</div>` : ''}
    ${tocNav(sections.map(([k, key]) => `<button type="button" data-jump="d-${k}">${th(key)}</button>`))}
    <div class="doc-layout">
      <section class="doc-content" id="d-pv" aria-label="${th('doc.content')}">
        <div class="pv-bar"><h2>${th('doc.content')} <span class="dim small">${esc(d.type.toUpperCase())} · ${kb} KB</span></h2>${tools}</div>
        ${content}
      </section>
      <aside class="doc-side" aria-label="${th('doc.info')}">
        <details class="side-info" id="d-info"${wide ? ' open' : ''}><summary><h2>${th('doc.info')}</h2> <span class="side-peek">${statusChip(d.status)} ${sensBadge(d.sensitivity)}</span></summary>
        <table class="kv">
          <tr><th>${th('col.id')}</th><td class="id">${pad(d.id)}</td></tr>
          <tr><th>${th('col.status')}</th><td>${statusChip(d.status)}${d.updated_at ? `<div class="dim small">${th('doc.updatedBy', { who: raw(who(d.updated_by)), time: raw(fmtTime(d.updated_at)) })}</div>` : ''}</td></tr>
          <tr><th>${th('col.sensitivity')}</th><td>${sensBadge(d.sensitivity)}${d.declaredSensitivity ? ` <span class="dim small" title="${th('doc.declaredHint')}">${th('doc.declared', { level: L.sv(d.declaredSensitivity) })}</span>` : ''}</td></tr>
          <tr><th>${th('col.project')}</th><td>${projectCell(d)}</td></tr>
          ${docSource ? `<tr><th>${th('doc.source')}</th><td>${th('src.short', { name: docSource })}</td></tr>` : ''}
          <tr><th>${th('col.category')}</th><td><a href="${link('list', { c: d.category })}">${esc(L.cat(d.category))}</a></td></tr>
          <tr><th>${th('col.date')}</th><td>${esc(d.date)}</td></tr>
          ${person('col.reporter', d.reporter)}${person('col.assignee', d.assignee)}${person('col.reviewer', d.reviewer)}
          <tr><th>${th('doc.tagsKw')}</th><td>${chips(d, null, 99) || `<span class="dim">${th('doc.none')}</span>`}</td></tr>
          ${d.desc ? `<tr><th>${th('doc.desc')}</th><td>${esc(d.desc)}</td></tr>` : ''}
          <tr><th>${th('doc.origin')}</th><td>${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a>` : `<span class="dim">${th('doc.noOrigin')}</span>`}</td></tr>
          ${d.vault ? `<tr><th>${th('doc.vaultFields')}</th><td>${th('doc.vaultCount', { n: d.vault.length })} ${d.vault.map((n) => `<code>${esc(n)}</code>`).join(' ')} <span class="dim">${vaultNote}</span></td></tr>` : ''}
          <tr><th>${th('doc.file')}</th><td class="id path">${esc(d.path)} <span class="dim">· ${esc(d.type.toUpperCase())} · ${kb} KB</span></td></tr>
        </table></details>
        ${editable ? editForm(d) : ''}
      </aside>
      <div class="doc-rest">
        ${ME ? fold('d-notes', 'notes.title', `<div id="notes-list"><p class="loading">${th('loading')}</p></div>
          <form id="note-form" class="note-form"><label class="sr" for="note-text">${th('notes.add')}</label>
            <textarea id="note-text" maxlength="4000" rows="3" placeholder="${th('notes.ph', { n: 4000 })}" required></textarea>
            <div class="wf-row"><button type="submit" class="btn primary">${th('notes.submit')}</button><span class="msg" aria-live="polite"></span></div></form>`, true)
          + fold('d-audit', 'audit.title', `<div id="audit-list"><p class="loading">${th('loading')}</p></div>`, false, th('audit.hint')) : ''}
        ${fold('d-rel', 'doc.relations', `
          ${d.supersedes && byId(d.supersedes) ? `<h3>${th('doc.supersedes')}</h3>${relList([d.supersedes])}` : ''}
          ${supersededBy.length ? `<h3>${th('doc.supersededByH')}</h3>${relList(supersededBy.map((x) => x.id))}` : ''}
          <h3>${th('doc.related')}</h3>${relList(related, t('doc.relatedNone', { id: d.id }))}
          <h3>${th('doc.similar')} <span class="dim">${th('doc.similarHint')}</span></h3>${relList(similar, t('doc.similarNone'))}`, !ME)}
        ${fold('d-hist', 'doc.gitHistory', (d.history || []).length ? `<table class="matrix hist"><thead><tr><th>${th('col.date')}</th><th>${th('col.commit')}</th><th>${th('col.subject')}</th></tr></thead><tbody>${d.history.map((h) => `<tr><td class="nowrap">${esc(h.date)}</td><td class="id">${esc(h.hash)}</td><td>${esc(h.subject)}</td></tr>`).join('')}</tbody></table>` : `<p class="dim">${th('doc.noGit')}</p>`)}
      </div>
    </div>`;
  bindJumps();
  if (ME) { bindDocServer(d, seq); loadDocServer(d, seq); }
  const sec = $('#d-pv'), pv = $('#pv');
  if (!pv) return;
  let revealed = !d.gated;
  sec.querySelector('[data-full]')?.addEventListener('click', () => setFull(sec, !sec.classList.contains('pv-full')));
  sec.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    sec.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    revealed = true; // choosing a view is a deliberate click, like 'Show content'
    renderPreview(d, pv, b.dataset.mode);
  }));
  if (!revealed) $('#reveal').addEventListener('click', () => { revealed = true; renderPreview(d, pv, sec.querySelector('[data-mode][aria-pressed="true"]')?.dataset.mode || 'preview'); });
  else await renderPreview(d, pv);
}

// ---------- profile menu ----------
const meBtn = $('#me-btn'), meMenu = $('#me-menu');
function renderProfile() {
  meBtn.textContent = ME ? initials(ME.email) : t('me.guest');
  meBtn.classList.toggle('guest', !ME);
  meBtn.title = ME ? t('me.title', { name: displayName(ME.email) }) : t('me.guestTitle');
  const theme = currentTheme();
  const lang = getLang();
  const lockable = !ME && DATA?.vault;
  meMenu.innerHTML = `
    <div class="menu-head">${ME
      ? `<b>${esc(displayName(ME.email))}</b><div class="dim">${esc(ME.email)}</div><div class="roles">${esc(rolesSummary(ME))}</div>`
      : `<b>${th('me.guest')}</b><div class="dim">${th('me.staticNote')}</div>`}</div>
    ${ME ? `<form class="menu-name" id="m-name"><label>${th('me.displayName')}<input name="name" maxlength="${NAME_MAX}" value="${esc(ME.name || '')}" placeholder="${esc(shortName(ME.email))}" autocomplete="name"></label>
      <div class="wf-row"><button type="submit" class="btn small">${th('btn.save')}</button><span class="msg dim small" aria-live="polite"></span></div>
      <p class="dim small">${th('me.displayNameHint')}</p></form>` : ''}
    <fieldset class="menu-theme"><legend>${th('me.theme')}</legend>
      ${THEMES.map((v) => `<label><input type="radio" name="theme" value="${v}"${v === theme ? ' checked' : ''}> ${th(`theme.${v}`)}</label>`).join('')}</fieldset>
    <fieldset class="menu-theme menu-lang"><legend>${th('me.language')}</legend>
      ${Object.entries(LANGS).map(([v, l]) => `<label lang="${v}"><input type="radio" name="lang" value="${v}"${v === lang ? ' checked' : ''}> ${esc(l)}</label>`).join('')}</fieldset>
    ${lockable ? `<button type="button" class="menu-item" id="m-lock"${vaultUnlocked() ? '' : ` disabled title="${th('me.vaultLocked')}"`}>${th('me.lockVault')}</button>` : ''}
    ${isManager(ME) ? `<a class="menu-item" href="#/admin">${th('nav.admin')}</a>` : ''}
    <a class="menu-item" href="/cdn-cgi/access/logout" title="${th('me.switchAccountHint')}">${th('me.switchAccount')}<span class="dim small menu-hint">${th('me.switchAccountHint')}</span></a>
    <a class="menu-item" href="/cdn-cgi/access/logout">${th('me.logout')}</a>`;
}
const toggleMenu = (open) => { meMenu.hidden = !open; meBtn.setAttribute('aria-expanded', String(open)); };
meBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(meMenu.hidden); if (!meMenu.hidden) meMenu.querySelector('input:checked')?.focus(); });
meMenu.addEventListener('change', (e) => {
  if (e.target.name === 'theme') setTheme(e.target.value);
  else if (e.target.name === 'lang' && e.target.value !== getLang()) chooseLang(e.target.value);
});
meMenu.addEventListener('submit', async (e) => {
  if (e.target.id !== 'm-name' || !ME) return;
  e.preventDefault();
  const f = e.target, msg = f.querySelector('.msg'), btn = f.querySelector('button');
  const name = f.elements.name.value.trim().slice(0, NAME_MAX);
  if (name === (ME.name || '')) { msg.textContent = t('wf.noChange'); return; }
  btn.disabled = true; msg.textContent = t('wf.saving');
  try {
    const r = await api('PATCH', '/api/me', { name });
    ME.name = typeof r?.name === 'string' ? r.name : name;
    setName(ME.email, ME.name);
    renderChrome();
    await render();
    meMenu.querySelector('#m-name .msg').textContent = t('wf.saved');
    meMenu.querySelector('#m-name input').focus();
  } catch (x) { msg.textContent = t('wf.saveFailed', { msg: x.message }); btn.disabled = false; }
});
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
  const pubMark = (k) => (isPublicProject(DATA.projects, k) ? ` · ${t('vis.public')}` : '');
  sel.innerHTML = opt('', p, t('nav.allProjects')) + topProjects().map((k) => opt(k, p, L.proj(k) + pubMark(k)) + Object.entries(DATA.projects).filter(([, v]) => v.parent === k)
    .map(([sk, v]) => opt(sk, p, `　» ${v.title}`)).join('')).join('');
}
/** Profile menu, footer legends and build line: everything outside #app that depends on data and language. */
function renderChrome() {
  renderProfile();
  $('#legend').innerHTML = DATA.statuses.map((s) => `<span style="${stStyle(s)}">${esc(L.st(s))}</span>`).join('');
  $('#legend-sens').innerHTML = SENSITIVITIES.map((s) => sensBadge(s)).join('');
  $('#built').textContent = [
    t('foot.docs', { n: DATA.docs.length }) + (DATA.maxSensitivity ? t('foot.max', { level: L.sv(DATA.maxSensitivity) }) : ''),
    t('foot.built', { time: fmtDateTime(DATA.builtAt) }),
    ...(ME ? [t('foot.server')] : []),
    ...(stateError ? [t('foot.stateFailed', { msg: stateError })] : []),
  ].join(' · ');
}
async function render() {
  if (!DATA) return;
  const seq = ++renderSeq;
  const { view, arg, params } = parseHash();
  const p = view === 'project' ? arg : (params.get('p') || '');
  try { graphMod?.disposeGraph?.(); } catch { /* a failing dispose must not block navigation */ }
  document.body.classList.remove('pv-lock');
  document.documentElement.style.setProperty('--top-h', `${$('.topbar').offsetHeight}px`);
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
  else if (view === 'project') viewProject(arg, params, seq);
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
function renderHelp() {
  helpPop.innerHTML = `<b>${th('search.help')}</b><table>${queryHelp(getLang()).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}</td></tr>`).join('')}</table><p class="dim">${th('search.helpNote')}</p>`;
}
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
    const full = document.querySelector('.pv-full');
    if (full) { setFull(full, false); return; }
    if (document.activeElement === qInput) qInput.blur();
    toggleHelp(false);
    if (!meMenu.hidden) { toggleMenu(false); meBtn.focus(); }
    toggleNav(false);
  }
});
window.addEventListener('hashchange', render);

// PWA: installable (manifest) but no offline shell for now (DESIGN.md → Profile menu, theme, PWA, RWD). An earlier
// worker cached a redirected /index.html and broke reloads; remove any that is still installed and its caches.
// sw.js stays deployed as a kill switch for browsers that update it before running this.
(async () => {
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null; // this page's scope
    if (reg) await reg.unregister();
    if ('caches' in window) for (const k of await caches.keys()) if (k.startsWith('gitdocs-')) await caches.delete(k);
  } catch { /* best effort */ }
})();

translateStatic();
renderHelp();
renderProfile();

async function boot() {
  const catalogP = fetch('catalog.json', { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
  const [data, me] = await Promise.all([catalogP, detectMe()]);
  DATA = data;
  ME = me;
  addPeople(DATA.site?.people);
  if (ME) {
    vaultUseServer({ canReveal: (id) => { const d = byId(id); return Boolean(d) && canEdit(ME, d); } });
    try {
      const state = await api('GET', '/api/state');
      DATA.docs = mergeState(DATA.docs, state);
      addPeople(state?.people); // server names win over the catalog's site.people
    } catch (x) { stateError = x.message; }
    if (ME.name) setName(ME.email, ME.name);
    const th0 = ME.prefs?.theme;
    if (th0 && th0 !== currentTheme()) { applyTheme(th0); try { localStorage.setItem('theme', th0); } catch { /* ignore */ } }
    // the server copy of the language choice wins; mirror it locally so the next first paint matches
    const l = normLang(ME.prefs?.lang);
    if (l) {
      try { localStorage.setItem(LANG_KEY, l); } catch { /* ignore */ }
      if (l !== getLang()) { setLang(l); translateStatic(); renderHelp(); }
    }
  }
  DATA.statuses = statusList((DATA.statuses || []).filter((s) => !LEGACY_STATUS[s]), DATA.docs);
  const title = data.site?.title || 'gitdocs portal';
  document.title = title;
  $('.brand-name').textContent = title;
  renderChrome();
  await render();
}
boot().catch(() => { renderProfile(); app.innerHTML = `<p class="empty">${th('err.catalog')}</p>`; });
