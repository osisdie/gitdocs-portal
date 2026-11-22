// Saved filters and CSV export for the list view (DESIGN.md → Saved filters and CSV export).
//
//   catalog filters   catalog.json `filters` ({ name, query }), defined in git, read-only here
//   personal filters  static mode: localStorage 'gitdocs:filters'; server mode: prefs.savedFilters (follows the user
//                     across devices; localStorage is only a mirror). Entries: { name, params }.
//   shared filters    server mode: D1 shared_filters through /api/filters, saved by managers of a project for everyone
//                     who can view it
//
// Usage from the list view:  initFilters({ data }) once after catalog.json loads; then per render
// savedFiltersHtml({ project, curQuery }) + bindSavedFilters(root, { project, curQuery, onApply }), and
// exportCsvButtonHtml() + bindExportCsv(root, getRows). curQuery = canonical list-state query string without `page`.
// Pure helpers (canonParams, upsertPersonal, mergeFilters, toCsv, …) are exported for tests; nothing touches the
// DOM at import time.
import { t, th, esc, label } from './i18n.js';
import { me, isServer, getPrefs, setPrefs, listSharedFilters, saveSharedFilter, deleteSharedFilter } from './api.js';
import { displayName, roleFor, atLeast, topOf, isManager } from './model.js';

export const LS_KEY = 'gitdocs:filters';
// prefs.json is capped at 8 KB by the server (PUT /api/me/prefs); every other preference shares that budget
export const LIMITS = { count: 30, name: 60, params: 1000, prefsBytes: 8 * 1024 };
// list-state keys that only change how results are shown, not which documents match
const VIEW_KEYS = new Set(['p', 'sort', 'dir', 'page', 'per']);
const SHARED_TTL_MS = 60 * 1000;

// ---------- pure helpers ----------
const isEntry = (f) => f !== null && typeof f === 'object' && typeof f.name === 'string' && f.name.trim() !== '' && typeof f.params === 'string';
const bytes = (s) => new TextEncoder().encode(s).length;

/** Readable personal entries (older ones beyond today's limits stay readable; limits apply when saving). */
export const readableList = (list) => (Array.isArray(list) ? list.filter(isEntry).map((f) => ({ name: f.name.trim(), params: f.params })) : []);

/**
 * Canonical form of a list query string: no `page`, no empty values, keys sorted (repeated keys keep their order).
 * dropSort also removes sort / dir.
 */
export function canonParams(qs, { dropSort = false } = {}) {
  const sp = new URLSearchParams(String(qs ?? '').replace(/^[?#]+/, ''));
  const out = [...sp].filter(([k, v]) => v !== '' && k !== 'page' && !(dropSort && (k === 'sort' || k === 'dir')));
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return new URLSearchParams(out).toString();
}

/** Whether saved params describe the current list state. A filter saved without a sort matches any sort. */
export function isActive(saved, cur) {
  const s = new URLSearchParams(String(saved ?? '').replace(/^[?#]+/, ''));
  const dropSort = !s.has('sort') && !s.has('dir');
  return canonParams(saved, { dropSort }) === canonParams(cur, { dropSort });
}

/** Params of a catalog filter ({ name, query }) within the current scope. */
export const catalogParams = (query, project = '') => canonParams(new URLSearchParams({ ...(project ? { p: project } : {}), q: query }).toString());

/** Whether the list state filters anything (scope, sort and paging alone do not count). */
export const hasFilter = (cur) => [...new URLSearchParams(String(cur ?? ''))].some(([k, v]) => v !== '' && !VIEW_KEYS.has(k));

/** Add, or replace by name. → { list, replaced } or { error: <i18n key>, max }. */
export function upsertPersonal(list, entry) {
  const name = String(entry?.name ?? '').trim();
  if (!name || name.length > LIMITS.name || /[\u0000-\u001f\u007f]/.test(name)) return { error: 'sf.errName', max: LIMITS.name };
  const params = canonParams(entry?.params);
  if (params.length > LIMITS.params) return { error: 'sf.errTooLong', max: LIMITS.params };
  const cur = readableList(list);
  const i = cur.findIndex((f) => f.name === name);
  if (i < 0 && cur.length >= LIMITS.count) return { error: 'sf.errTooMany', max: LIMITS.count };
  const next = cur.slice();
  if (i < 0) next.push({ name, params }); else next[i] = { name, params };
  return { list: next, replaced: i >= 0 };
}

/** Whether prefs with `list` as savedFilters stay within the server's prefs size cap. */
export const fitsPrefs = (prefs, list) => bytes(JSON.stringify({ ...(prefs || {}), savedFilters: list })) <= LIMITS.prefsBytes;

/**
 * First server-mode load: the server list plus local entries whose name it does not have yet, keeping only entries
 * within today's limits, at most LIMITS.count, and dropping from the end until the prefs fit.
 */
export function mergeFilters(server, local, prefs = {}) {
  let out = [];
  for (const f of [...readableList(server), ...readableList(local)]) {
    if (out.some((x) => x.name === f.name)) continue;
    const r = upsertPersonal(out, f);
    if (r.list) out = r.list;
  }
  while (out.length && !fitsPrefs(prefs, out)) out = out.slice(0, -1);
  return out;
}

// ---------- CSV ----------
const FORMULA_START = /^[=+\-@\t\r]/;
/** One RFC 4180 field: spreadsheet formulas neutralised with a leading ', quoted when it holds , " CR or LF. */
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** UTF-8 BOM (Excel then reads CJK text correctly) + CRLF-terminated records. */
export const toCsv = (header, rows) => `﻿${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

const pad = (n) => String(n).padStart(7, '0');
const day = (s) => String(s || '').slice(0, 10);
const person = (e) => (e ? displayName(e) : '');
const words = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' || typeof x === 'number').join('; ') : '');
/** Column key → cell text, as the list shows it (labels in the current language, people by display name). */
export const CSV_FORMAT = {
  id: (d) => pad(d.id),
  status: (d) => label('status', d.status),
  sens: (d) => label('sens', d.sensitivity),
  sensitivity: (d) => label('sens', d.sensitivity),
  category: (d) => label('cat', d.category),
  project: (d) => label('project', d.project) + (d.subproject ? `/${d.subproject}` : ''),
  title: (d) => d.title,
  desc: (d) => d.desc,
  keywords: (d) => words(d.keywords),
  tags: (d) => words(d.tags),
  assignee: (d) => person(d.assignee),
  reviewer: (d) => person(d.reviewer),
  reporter: (d) => person(d.reporter),
  date: (d) => day(d.date),
  updated: (d) => day(d.updated_at || d.date),
  type: (d) => d.type,
  notes: (d) => d.notes || 0,
};
const NEVER = new Set(['vault', 'vaultBlocked', 'restricted', 'offline']);

/** Cell for a column key; unknown keys pass primitive values through, except for restricted (confidential) docs. */
export function csvValue(d, key) {
  if (Object.hasOwn(CSV_FORMAT, key)) return CSV_FORMAT[key](d) ?? '';
  if (d.restricted || NEVER.has(key) || !Object.hasOwn(d, key)) return '';
  const v = d[key];
  if (Array.isArray(v)) return words(v);
  return ['string', 'number', 'boolean'].includes(typeof v) ? v : '';
}

/** { rows: doc records, columns: [{ key, label }] } → CSV text. */
export const docsCsv = ({ rows = [], columns = [] }) => toCsv(columns.map((c) => c.label ?? c.key), rows.map((d) => columns.map((c) => csvValue(d, c.key))));

/** docs-<project|all>-<YYYYMMDD>.csv (local date); characters file systems dislike become '_'. */
export function csvFilename(project, now = new Date()) {
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const p = String(project || '').replace(/[\\/:*?"<>|\s\u0000-\u001f\u007f]+/g, '_').replace(/^[._]+|_+$/g, '').slice(0, 80);
  return `docs-${p || 'all'}-${ymd}.csv`;
}

// ---------- state ----------
let DATA = null;
let SHARED = null;      // rows from GET /api/filters (server mode)
let sharedAt = 0;
let sharedLoad = null;
let sharedErr = '';
let migrating = null;

const lsGet = () => { try { return readableList(JSON.parse(localStorage.getItem(LS_KEY) || '[]')); } catch { return []; } };
const lsSet = (v) => { try { localStorage.setItem(LS_KEY, JSON.stringify(v)); return true; } catch { return false; } };
const projTitle = (k) => label('project', DATA?.projects?.[k]?.title || k);

/** Call once after catalog.json is loaded (and after GET /api/me in server mode). */
export function initFilters({ data } = {}) {
  DATA = data || DATA;
  if (isServer() && !migrating) migrating = migrateLocal().catch(() => { migrating = null; /* retried on the next init */ });
}

/**
 * Server mode, once: hand this browser's static-mode filters to the first account that signs in here, then clear them,
 * so a second identity on the same browser (possibly another tenant) never inherits them.
 */
async function migrateLocal() {
  const m = me();
  if (!m || Array.isArray(m.prefs?.savedFilters)) return;
  await setPrefs({ savedFilters: mergeFilters([], lsGet(), getPrefs()) });
  try { localStorage.removeItem(LS_KEY); } catch { /* storage blocked */ }
}

function personal() {
  const m = me();
  return m && Array.isArray(m.prefs?.savedFilters) ? readableList(m.prefs.savedFilters) : lsGet();
}

async function storePersonal(list) {
  if (!isServer()) {
    if (!lsSet(list)) throw new Error(t('sf.errStorage'));
    return;
  }
  if (!fitsPrefs(getPrefs(), list)) throw new Error(t('sf.errTooBig'));
  await setPrefs({ savedFilters: list }); // server copy only: localStorage is shared by every account on this browser
}

const validRow = (r) => r && Number.isFinite(Number(r.id)) && typeof r.project === 'string' && typeof r.name === 'string' && typeof r.params === 'string';
function loadShared(force = false) {
  if (!isServer()) return Promise.resolve([]);
  if (!force && SHARED && Date.now() - sharedAt < SHARED_TTL_MS) return Promise.resolve(SHARED);
  sharedLoad ||= listSharedFilters()
    .then((rows) => { SHARED = Array.isArray(rows) ? rows.filter(validRow) : []; sharedErr = ''; return SHARED; })
    .catch((e) => { sharedErr = e.message; SHARED ||= []; return SHARED; })
    .finally(() => { sharedAt = Date.now(); sharedLoad = null; });
  return sharedLoad;
}
const sharedFor = (project) => (SHARED || []).filter((r) => !project || r.project === topOf(project));

// ---------- rendering ----------
const PEOPLE_ICON = '<svg class="sf-ico" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><circle cx="5.5" cy="5" r="2.5" fill="currentColor"/><circle cx="11.5" cy="5.5" r="2" fill="currentColor"/><path d="M1 14c0-2.8 2-4.5 4.5-4.5S10 11.2 10 14zM10.6 14c0-1.6-.5-2.9-1.4-3.8 2.7-.7 5.8.5 5.8 3.8z" fill="currentColor"/></svg>';
const onAttr = (on) => (on ? ' aria-current="true"' : '');

/** The saved-filters bar (`<section class="saved" data-sf>`). */
export function savedFiltersHtml({ project = '', curQuery = '' } = {}) {
  const catalog = (DATA?.filters || []).filter((f) => f && typeof f.name === 'string' && typeof f.query === 'string');
  const mine = personal();
  const shared = sharedFor(project);
  const chip = (cls, key, params, text, title, del = '') => {
    const on = isActive(params, curQuery);
    return `<span class="chip saved-chip ${cls}${on ? ' on' : ''}"><a href="#/list?${esc(params)}" data-sf-apply="${esc(params)}" data-sf-key="${esc(key)}" title="${esc(title)}"${onAttr(on)}>${text}</a>${del}</span>`;
  };
  const delBtn = (attrs, name) => `<button type="button" ${attrs} aria-label="${th('sf.delete', { name })}">×</button>`;
  return `<section class="saved" data-sf aria-label="${th('sf.region')}">
    <span class="dim">${th('sf.label')}</span>
    ${catalog.map((f, i) => chip('cat', `cat:${i}`, catalogParams(f.query, project), esc(f.name), t('sf.fromCatalog'))).join('')}
    ${mine.map((f, i) => chip('local', `me:${f.name}`, f.params, esc(f.name), t('sf.personal'), delBtn(`data-sf-del="me" data-i="${i}"`, f.name))).join('')}
    ${shared.map((r) => chip('local shared', `sh:${r.id}`, r.params,
      `${PEOPLE_ICON}${esc(r.name)}${project ? '' : ` <span class="sf-proj">· ${esc(projTitle(r.project))}</span>`}`,
      t(r.created_by_name ? 'sf.sharedBy' : 'sf.sharedWith', { project: projTitle(r.project), name: r.created_by_name || '' }),
      r.canDelete ? delBtn(`data-sf-del="sh" data-id="${esc(r.id)}"`, r.name) : '')).join('')}
    ${hasFilter(curQuery) ? `<button type="button" class="linkish" data-sf-save>${th('sf.save')}</button>` : ''}
    <span class="sf-msg${sharedErr ? ' err' : ''}" data-sf-msg>${sharedErr ? th('sf.errLoad', { msg: sharedErr }) : ''}</span>
  </section>`;
}

let stylesAdded = false;
function addStyles() {
  if (stylesAdded || typeof document === 'undefined') return;
  stylesAdded = true;
  const s = document.createElement('style');
  s.textContent = `.saved-chip{display:inline-flex;gap:4px;align-items:center}
.saved-chip a{color:inherit;text-decoration:none}
.saved-chip a:hover{text-decoration:underline}
.saved-chip.shared{border-style:solid}
.saved-chip .sf-ico{vertical-align:-1px;margin-right:4px}
.saved-chip .sf-proj{opacity:.75;font-size:11px}
.saved-chip a:focus-visible,.saved-chip button:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.saved .sf-msg{flex-basis:100%;font-size:12.5px;color:var(--muted)}
.saved .sf-msg:empty{display:none}
.saved .sf-msg.err{color:var(--sv3-fg)}
.sf-csv{white-space:nowrap}
.sf-dlg{border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--fg);padding:18px 20px;width:min(26rem,calc(100vw - 32px));box-sizing:border-box}
.sf-dlg::backdrop{background:rgb(0 0 0 / .45)}
.sf-dlg h2{margin:0 0 12px;font-size:17px}
.sf-dlg .sf-field{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
.sf-dlg input[type=text]{padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit;font-size:14px}
.sf-dlg fieldset{border:1px solid var(--line);border-radius:6px;margin:12px 0 0;padding:6px 12px 8px;display:flex;flex-direction:column;gap:2px}
.sf-dlg legend{font-size:13px;color:var(--muted);padding:0 4px}
.sf-dlg fieldset label{display:flex;gap:8px;align-items:center;min-height:36px}
.sf-dlg .sf-note{font-size:12.5px;color:var(--muted);margin:10px 0 0}
.sf-dlg .sf-err{color:var(--sv3-fg);min-height:1.2em;margin:10px 0 0;font-size:13px}
.sf-dlg .sf-row{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;flex-wrap:wrap}
.sf-dlg button{cursor:pointer;font:inherit}`;
  document.head.appendChild(s);
}

/** Screen-reader announcement (one polite live region for the page) plus the visible note in the bar. */
function announce(msg, sec, isError = false) {
  let live = document.getElementById('sf-live');
  if (!live) {
    live = Object.assign(document.createElement('div'), { id: 'sf-live', className: 'sr' });
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);
  }
  live.textContent = '';
  setTimeout(() => { live.textContent = msg; }, 60);
  const note = sec?.querySelector('[data-sf-msg]');
  if (note) { note.textContent = msg; note.classList.toggle('err', isError); }
}

/** Replace a bar with a fresh render (same opts), keep or move focus, and return the new element. */
function rerender(sec, opts, focusKey = null) {
  if (!sec?.isConnected) return null;
  const focusables = () => [...sec.querySelectorAll('a,button')];
  const had = focusables().indexOf(document.activeElement);
  const tpl = document.createElement('template');
  tpl.innerHTML = savedFiltersHtml(opts).trim();
  const next = tpl.content.firstElementChild;
  sec.replaceWith(next);
  wire(next, opts);
  const all = [...next.querySelectorAll('a,button')];
  const target = (focusKey && all.find((el) => el.dataset.sfKey === focusKey)) || (had >= 0 ? all[Math.min(had, all.length - 1)] : null);
  if (focusKey === '' || (had >= 0 && !target)) next.querySelector('a,button')?.focus();
  else target?.focus();
  return next;
}

/** Wire save / apply / delete on a rendered bar. onApply(query) navigates; without it the links navigate. */
export function bindSavedFilters(root, opts = {}) {
  addStyles();
  const sec = root?.querySelector('[data-sf]');
  if (!sec) return;
  wire(sec, opts);
  if (isServer() && (!SHARED || Date.now() - sharedAt >= SHARED_TTL_MS)) {
    loadShared().then(() => { if (sec.isConnected) rerender(sec, opts); });
  }
}

function wire(sec, opts) {
  sec.addEventListener('click', async (e) => {
    const a = e.target.closest('a[data-sf-apply]');
    if (a && opts.onApply && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      opts.onApply(a.dataset.sfApply);
      return;
    }
    const del = e.target.closest('button[data-sf-del]');
    if (del) { await removeFilter(sec, opts, del); return; }
    if (e.target.closest('button[data-sf-save]')) openSaveDialog(sec, opts);
  });
}

async function removeFilter(sec, opts, btn) {
  if (btn.dataset.sfDel === 'me') {
    const list = personal();
    const f = list[Number(btn.dataset.i)];
    if (!f) return;
    try {
      await storePersonal(list.filter((_, i) => i !== Number(btn.dataset.i)));
      announce(t('sf.deleted', { name: f.name }), rerender(sec, opts, ''));
    } catch (x) { announce(t('sf.errDelete', { msg: x.message }), sec, true); }
    return;
  }
  const row = (SHARED || []).find((r) => String(r.id) === btn.dataset.id);
  if (!row || !confirm(t('sf.confirmDeleteShared', { name: row.name, project: projTitle(row.project) }))) return;
  try {
    await deleteSharedFilter(row.id);
    SHARED = SHARED.filter((r) => r !== row);
    announce(t('sf.deleted', { name: row.name }), rerender(sec, opts, ''));
  } catch (x) { announce(t('sf.errDelete', { msg: x.message }), sec, true); }
}

function suggestName(curQuery) {
  const sp = new URLSearchParams(curQuery);
  return (sp.get('q') || sp.getAll('k').join(' ') || t('sf.myFilter')).trim().slice(0, LIMITS.name);
}

function openSaveDialog(sec, opts) {
  const m = me();
  const top = opts.project ? topOf(opts.project) : '';
  const canShare = Boolean(m && top && atLeast(roleFor(m, top), 'manager'));
  const dlg = document.createElement('dialog');
  dlg.className = 'sf-dlg';
  dlg.setAttribute('aria-labelledby', 'sf-dlg-h');
  dlg.innerHTML = `<form novalidate>
    <h2 id="sf-dlg-h">${th('sf.dlgTitle')}</h2>
    <label class="sf-field">${th('sf.name')}<input type="text" name="name" maxlength="${LIMITS.name}" required autocomplete="off" spellcheck="false" value="${esc(suggestName(opts.curQuery))}"></label>
    ${canShare ? `<fieldset><legend>${th('sf.scope')}</legend>
      <label><input type="radio" name="scope" value="me" checked> ${th('sf.scopeMe')}</label>
      <label><input type="radio" name="scope" value="project"> ${th('sf.scopeProject', { project: projTitle(top) })}</label></fieldset>`
    : (m && !top && isManager(m) ? `<p class="sf-note">${th('sf.shareNeedsProject')}</p>` : '')}
    <p class="sf-err" role="alert"></p>
    <div class="sf-row"><button type="button" class="btn" data-cancel>${th('btn.cancel')}</button><button type="submit" class="btn primary">${th('btn.save')}</button></div>
  </form>`;
  document.body.appendChild(dlg);
  const form = dlg.querySelector('form');
  const input = form.elements.name;
  const err = form.querySelector('.sf-err');
  const prev = document.activeElement;
  let savedKey = null;
  dlg.addEventListener('close', () => {
    dlg.remove();
    if (savedKey === null) { if (prev?.isConnected) prev.focus(); }
  });
  form.querySelector('[data-cancel]').addEventListener('click', () => dlg.close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const shared = canShare && form.elements.scope?.value === 'project';
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true;
    err.textContent = '';
    try {
      let msg;
      if (shared) {
        const name = input.value.trim();
        if (!name || name.length > LIMITS.name) throw new Error(t('sf.errName', { max: LIMITS.name }));
        const row = await saveSharedFilter({ project: top, name, params: canonParams(opts.curQuery) });
        if (!validRow(row)) throw new Error(t('sf.errSave', { msg: '?' }));
        SHARED = [...(SHARED || []).filter((r) => r.id !== row.id && !(r.project === row.project && r.name === row.name)), row]
          .sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
        savedKey = `sh:${row.id}`;
        msg = t('sf.sharedSaved', { name: row.name, project: projTitle(row.project) });
      } else {
        const r = upsertPersonal(personal(), { name: input.value, params: opts.curQuery });
        if (r.error) throw new Error(t(r.error, { max: r.max }));
        await storePersonal(r.list);
        const name = input.value.trim();
        savedKey = `me:${name}`;
        msg = t(r.replaced ? 'sf.replaced' : 'sf.saved', { name });
      }
      dlg.close();
      announce(msg, rerender(sec, opts, savedKey));
    } catch (x) {
      err.textContent = x.message;
      submit.disabled = false;
      input.focus();
    }
  });
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  input.select();
}

// ---------- CSV export ----------
export const exportCsvButtonHtml = () => `<button type="button" class="linkish sf-csv" data-csv title="${th('csv.title')}">${th('csv.export')}</button>`;

/** getRows() → { rows, columns, project? }: every filtered + sorted row (not only the visible page). */
export function bindExportCsv(root, getRows) {
  addStyles();
  const btn = root?.querySelector('[data-csv]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    try {
      const data = getRows() || {};
      const rows = Array.isArray(data.rows) ? data.rows : [];
      if (!rows.length) { announce(t('csv.empty')); return; }
      const project = data.project ?? new URLSearchParams(location.hash.split('?')[1] || '').get('p') ?? '';
      download(csvFilename(project), docsCsv({ rows, columns: data.columns || [] }));
      announce(t('csv.done', { n: rows.length }));
    } catch (x) { announce(t('csv.failed', { msg: x.message })); }
  });
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name, hidden: true });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
