// Admin page (#/admin, manager+): users and per-project memberships, plus the audit log for owners.
// Loaded on demand by app.js; every write goes through the API, which re-checks the caller's rights.
import { managedProjects, ROLE_RANK, addPeople, displayName, isPublicProject, sourceOfProject, INDEX_PROJECT } from './model.js';
import { t, th, label, fmtDateTime, joinList } from './i18n.js';
import { NAME_RE } from './vault-core.js';

const ROLES = ['viewer', 'editor', 'manager'];
const ALL = '*';

/** Normalise GET /api/users (array or { users }). */
const usersOf = (r) => (Array.isArray(r) ? r : r?.users || []);
/** Normalise GET /api/audit (array, or { history, vault }) into one list, newest first. */
function auditRows(r) {
  const rows = Array.isArray(r) ? r : [
    ...(r?.history || []).map((x) => ({ ...x, kind: 'history' })),
    ...(r?.vault || r?.vault_audit || []).map((x) => ({ ...x, kind: 'vault' })),
  ];
  return rows.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

export async function renderAdmin(app, { me, api, esc, projects, registry = {}, tab, link }) {
  const scope = managedProjects(me);
  const all = scope.includes(ALL);
  const mine = all ? projects : projects.filter((p) => scope.includes(p));
  const grantable = me.owner ? [ALL, ...mine] : mine;
  const canManage = (project) => all || scope.includes(project);
  const pLabel = (p) => (p === ALL ? t('admin.allProjects') : label('project', p));
  const opt = (v, cur, label = v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const fmt = (iso) => (iso ? esc(fmtDateTime(iso)) : '<span class="dim">—</span>');
  const showAudit = me.owner && tab === 'audit';

  const tabs = `<nav class="subtabs" aria-label="${th('nav.admin')}">
    <a href="${link('admin')}"${showAudit ? '' : ' class="on" aria-current="page"'}>${th('admin.users')}</a>
    ${me.owner ? `<a href="${link('admin', { tab: 'audit' })}"${showAudit ? ' class="on" aria-current="page"' : ''}>${th('admin.audit')}</a>` : ''}</nav>`;

  if (showAudit) {
    app.innerHTML = `<h1 class="page-h">${th('nav.admin')}</h1>${tabs}<p class="loading">${th('admin.loadingAudit')}</p>`;
    let rows;
    try { rows = auditRows(await api('GET', '/api/audit?limit=300')); } catch (x) { app.querySelector('.loading').outerHTML = `<p class="err">${th('err.loadFailed', { msg: x.message })}</p>`; return; }
    const val = (r, v) => esc(r.field === 'status' ? label('status', v) : /^[^\s@<>]+@[^\s@<>]+$/.test(String(v)) ? displayName(v) : v);
    const what = (r) => (r.kind === 'vault' || (r.name && !r.actor)
      ? `vault <code>${esc(r.name)}</code> ${esc(r.action)}${r.path ? ` <span class="dim">${esc(r.path)}</span>` : ''}`
      : `${esc(r.action)}${r.path ? ` <span class="dim">${esc(r.path)}</span>` : ''}${r.field ? ` <code>${esc(r.field)}</code> ${r.old != null && r.old !== '' ? `<del>${val(r, r.old)}</del> → ` : ''}${val(r, r.new ?? '')}` : ''}`);
    rows.forEach((r) => addPeople({ [r.actor || r.email]: r.actor_name }));
    app.querySelector('.loading').outerHTML = rows.length ? `<div class="tbl-wrap"><table class="docs compact audit"><thead><tr><th>${th('col.time')}</th><th>${th('col.who')}</th><th>${th('col.change')}</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="nowrap dim">${fmt(r.at)}</td><td>${esc(displayName(r.actor || r.email || ''))}</td><td>${what(r)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="empty">${th('admin.noRecords')}</p>`;
    return;
  }

  app.innerHTML = `<h1 class="page-h">${th('nav.admin')}</h1>${tabs}<p class="loading">${th('admin.loadingUsers')}</p>`;
  let users;
  try { users = usersOf(await api('GET', '/api/users')); } catch (x) { app.querySelector('.loading').outerHTML = `<p class="err">${th('err.loadFailed', { msg: x.message })}</p>`; return; }
  users.sort((a, b) => String(a.email).localeCompare(String(b.email)));
  addPeople(Object.fromEntries(users.map((u) => [u.email, u.name])));

  const roleChips = (u) => {
    const ms = u.memberships || [];
    const owner = u.owner ? '<span class="chip role owner">owner</span>' : '';
    return owner + (ms.length ? ms.map((m) => `<span class="chip role r-${esc(m.role)}">${th('admin.membership', { project: pLabel(m.project), role: m.role })}</span>`).join('') : (owner ? '' : `<span class="dim">${th('doc.none')}</span>`));
  };
  const memberRow = (m = { project: mine[0] || '', role: 'viewer' }) => `<div class="mrow">
      <select name="project" aria-label="${th('col.project')}">${(grantable.includes(m.project) || !m.project ? grantable : [m.project, ...grantable]).map((p) => opt(p, m.project, pLabel(p))).join('')}</select>
      <select name="role" aria-label="${th('admin.role')}">${ROLES.map((r) => opt(r, m.role)).join('')}</select>
      <button type="button" class="linkish" data-rm aria-label="${th('admin.removeRow')}">${th('admin.remove')}</button></div>`;
  const editor = (u) => {
    const ms = u.memberships || [];
    const fixed = ms.filter((m) => !canManage(m.project));
    return `<form class="uedit" data-email="${esc(u.email)}">
      ${me.owner ? `<label>${th('admin.name')}<input name="name" value="${esc(u.name || '')}" autocomplete="off"></label>` : ''}
      <div class="mrows">${ms.filter((m) => canManage(m.project)).map(memberRow).join('')}</div>
      <button type="button" class="linkish" data-add>${th('admin.addProject')}</button>
      ${fixed.length ? `<p class="dim small">${th('admin.otherProjects', { list: joinList(fixed.map((m) => t('admin.membership', { project: pLabel(m.project), role: m.role }))) })}</p>` : ''}
      ${me.owner && !u.owner ? `<label class="check"><input type="checkbox" name="disabled"${u.disabled ? ' checked' : ''}> ${th('admin.disable')}</label>` : ''}
      <div class="wf-row"><button type="submit" class="btn primary">${th('btn.save')}</button><button type="button" class="btn" data-cancel>${th('btn.cancel')}</button>
        ${me.owner && !u.owner ? `<button type="button" class="btn danger" data-del>${th('admin.disableRemove')}</button>` : ''}<span class="msg" aria-live="polite"></span></div></form>`;
  };

  app.querySelector('.loading').outerHTML = `
    <nav class="toc" aria-label="${th('toc')}"><b>${th('toc')}</b><button type="button" data-jump="a-users">${th('admin.users')}</button><button type="button" data-jump="a-invite">${th('admin.invite')}</button><button type="button" data-jump="a-projects">${th('admin.projects')}</button></nav>
    <section class="card" id="a-users"><h2>${th('admin.users')} <span class="dim">${users.length}</span></h2>
    ${!me.owner ? `<p class="dim small">${th('admin.youManage', { list: joinList(mine.map(pLabel)) || t('doc.none') })}</p>` : ''}
    <div class="tbl-wrap"><table class="docs compact users"><thead><tr><th>${th('admin.email')}</th><th>${th('admin.name')}</th><th>${th('admin.projectRoles')}</th><th>${th('col.status')}</th><th class="c-date">${th('admin.lastSeen')}</th><th></th></tr></thead><tbody>
    ${users.map((u, i) => `<tr${u.disabled ? ' class="disabled"' : ''}><td class="email">${esc(u.email)}</td><td>${esc(u.name || '')}</td><td>${roleChips(u)}</td>
      <td>${u.disabled ? `<span class="chip">${th('admin.disabled')}</span>` : `<span class="dim">${th('admin.enabled')}</span>`}</td><td class="c-date nowrap dim">${fmt(u.last_seen || u.lastSeen)}</td>
      <td><button type="button" class="btn small" data-edit="${i}">${th('admin.edit')}</button></td></tr>
      <tr class="edit-row" id="edit-${i}" hidden><td colspan="6"></td></tr>`).join('')}</tbody></table></div></section>
    <section class="card" id="a-invite"><h2>${th('admin.inviteTitle')}</h2>
      <form class="uedit invite" id="invite">
        <label>${th('admin.email')}<input name="email" type="email" required autocomplete="off"></label>
        <label>${th('admin.name')}<input name="name" autocomplete="off"></label>
        <div class="mrows">${mine.length || me.owner ? memberRow() : ''}</div>
        <button type="button" class="linkish" data-add>${th('admin.addProject')}</button>
        <div class="wf-row"><button type="submit" class="btn primary">${th('admin.inviteBtn')}</button><span class="msg" aria-live="polite"></span></div>
      </form></section>
    <section class="card" id="a-projects"><h2>${th('admin.projects')}</h2>
      <p class="dim small">${th('admin.visIntro')}</p>
      <div class="tbl-wrap"><table class="docs compact projects"><thead><tr><th>${th('col.project')}</th><th>${th('admin.visibility')}</th><th>${th('admin.visChange')}</th><th>${th('pv.title')}</th></tr></thead><tbody>
      ${mine.map((k) => {
        const pub = isPublicProject(registry, k), src = sourceOfProject(registry, k);
        const cmd = `npm run doc -- project ${/^[\w./-]+$/.test(k) ? k : `'${k}'`} visibility=${pub ? 'private' : 'public'}`;
        return `<tr><td>${esc(pLabel(k))}${src ? ` <span class="dim small">${th('src.short', { name: src })}</span>` : ''}</td>
          <td>${pub ? `<span class="chip vis-pub">${th('vis.public')}</span>` : `<span class="dim">${th('vis.private')}</span>`}</td>
          <td>${k === INDEX_PROJECT ? `<span class="dim small">${th('admin.visIndex')}</span>` : `<code>${esc(cmd)}</code>`}</td>
          <td>${NAME_RE.test(k) && !k.includes('/') ? `<a href="${link(`project/${encodeURIComponent(k)}`, { sec: 'vault' })}">${th('admin.vaultLink')}</a>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div></section>`;

  app.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
  const rerender = () => renderAdmin(app, { me, api, esc, projects, registry, tab, link });
  const collect = (form) => {
    const rows = [...form.querySelectorAll('.mrow')].map((r) => ({ project: r.querySelector('[name=project]').value, role: r.querySelector('[name=role]').value }));
    // one row per project; the higher role wins if a project was picked twice
    const by = new Map();
    for (const m of rows) if (m.project && (!by.has(m.project) || ROLE_RANK[m.role] > ROLE_RANK[by.get(m.project)])) by.set(m.project, m.role);
    return [...by].map(([project, role]) => ({ project, role }));
  };
  const bindForm = (form) => {
    form.addEventListener('click', (e) => {
      if (e.target.closest('[data-add]')) form.querySelector('.mrows').insertAdjacentHTML('beforeend', memberRow());
      if (e.target.closest('[data-rm]')) e.target.closest('.mrow').remove();
    });
  };

  app.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const i = Number(b.dataset.edit), u = users[i], row = app.querySelector(`#edit-${i}`);
    if (!row.hidden) { row.hidden = true; return; }
    row.firstElementChild.innerHTML = editor(u);
    row.hidden = false;
    const form = row.querySelector('form');
    bindForm(form);
    form.querySelector('[data-cancel]').addEventListener('click', () => { row.hidden = true; });
    form.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!confirm(t('admin.confirmDisable', { email: u.email }))) return;
      try { await api('DELETE', `/api/users/${encodeURIComponent(u.email)}`); rerender(); } catch (x) { form.querySelector('.msg').textContent = t('err.failed', { msg: x.message }); }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { memberships: collect(form) };
      if (me.owner) body.name = form.querySelector('[name=name]').value.trim();
      const dis = form.querySelector('[name=disabled]');
      if (dis && dis.checked !== Boolean(u.disabled)) body.disabled = dis.checked;
      form.querySelector('.msg').textContent = t('wf.saving');
      try { await api('PATCH', `/api/users/${encodeURIComponent(u.email)}`, body); rerender(); } catch (x) { form.querySelector('.msg').textContent = t('wf.saveFailed', { msg: x.message }); }
    });
  }));

  const inv = app.querySelector('#invite');
  bindForm(inv);
  inv.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = inv.querySelector('[name=email]').value.trim().toLowerCase();
    const memberships = collect(inv);
    if (!me.owner && !memberships.length) { inv.querySelector('.msg').textContent = t('admin.needProject'); return; }
    inv.querySelector('.msg').textContent = t('admin.inviting');
    try {
      await api('POST', '/api/users', { email, name: inv.querySelector('[name=name]').value.trim() || undefined, memberships });
      rerender();
    } catch (x) { inv.querySelector('.msg').textContent = t('admin.inviteFailed', { msg: x.message }); }
  });
}
