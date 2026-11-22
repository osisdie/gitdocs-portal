// Admin page (#/admin, manager+): users and per-project memberships, plus the audit log for owners.
// Loaded on demand by app.js; every write goes through the API, which re-checks the caller's rights.
import { managedProjects, ROLE_RANK } from './model.js';

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

export async function renderAdmin(app, { me, api, esc, projects, tab, link }) {
  const scope = managedProjects(me);
  const all = scope.includes(ALL);
  const mine = all ? projects : projects.filter((p) => scope.includes(p));
  const grantable = me.owner ? [ALL, ...mine] : mine;
  const canManage = (project) => all || scope.includes(project);
  const pLabel = (p) => (p === ALL ? '所有專案（*）' : p);
  const opt = (v, cur, label = v) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const fmt = (iso) => { if (!iso) return '<span class="dim">—</span>'; const t = new Date(iso); return Number.isNaN(t.getTime()) ? esc(iso) : esc(t.toLocaleString('zh-TW', { hour12: false })); };
  const showAudit = me.owner && tab === 'audit';

  const tabs = `<nav class="subtabs" aria-label="管理">
    <a href="${link('admin')}"${showAudit ? '' : ' class="on" aria-current="page"'}>使用者</a>
    ${me.owner ? `<a href="${link('admin', { tab: 'audit' })}"${showAudit ? ' class="on" aria-current="page"' : ''}>稽核</a>` : ''}</nav>`;

  if (showAudit) {
    app.innerHTML = `<h1 class="page-h">管理</h1>${tabs}<p class="loading">載入稽核紀錄…</p>`;
    let rows;
    try { rows = auditRows(await api('GET', '/api/audit?limit=300')); } catch (x) { app.querySelector('.loading').outerHTML = `<p class="err">載入失敗：${esc(x.message)}</p>`; return; }
    const what = (r) => (r.kind === 'vault' || (r.name && !r.actor)
      ? `vault <code>${esc(r.name)}</code> ${esc(r.action)}${r.path ? ` <span class="dim">${esc(r.path)}</span>` : ''}`
      : `${esc(r.action)}${r.path ? ` <span class="dim">${esc(r.path)}</span>` : ''}${r.field ? ` <code>${esc(r.field)}</code> ${r.old != null && r.old !== '' ? `<del>${esc(r.old)}</del> → ` : ''}${esc(r.new ?? '')}` : ''}`);
    app.querySelector('.loading').outerHTML = rows.length ? `<div class="tbl-wrap"><table class="docs compact audit"><thead><tr><th>時間</th><th>人員</th><th>內容</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="nowrap dim">${fmt(r.at)}</td><td>${esc(r.actor || r.email || '')}</td><td>${what(r)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">沒有紀錄。</p>';
    return;
  }

  app.innerHTML = `<h1 class="page-h">管理</h1>${tabs}<p class="loading">載入使用者…</p>`;
  let users;
  try { users = usersOf(await api('GET', '/api/users')); } catch (x) { app.querySelector('.loading').outerHTML = `<p class="err">載入失敗：${esc(x.message)}</p>`; return; }
  users.sort((a, b) => String(a.email).localeCompare(String(b.email)));

  const roleChips = (u) => {
    const ms = u.memberships || [];
    const owner = u.owner ? '<span class="chip role owner">owner</span>' : '';
    return owner + (ms.length ? ms.map((m) => `<span class="chip role r-${esc(m.role)}">${esc(pLabel(m.project))}：${esc(m.role)}</span>`).join('') : (owner ? '' : '<span class="dim">（無）</span>'));
  };
  const memberRow = (m = { project: mine[0] || '', role: 'viewer' }) => `<div class="mrow">
      <select name="project" aria-label="專案">${(grantable.includes(m.project) || !m.project ? grantable : [m.project, ...grantable]).map((p) => opt(p, m.project, pLabel(p))).join('')}</select>
      <select name="role" aria-label="角色">${ROLES.map((r) => opt(r, m.role)).join('')}</select>
      <button type="button" class="linkish" data-rm aria-label="移除這一列">移除</button></div>`;
  const editor = (u) => {
    const ms = u.memberships || [];
    const fixed = ms.filter((m) => !canManage(m.project));
    return `<form class="uedit" data-email="${esc(u.email)}">
      ${me.owner ? `<label>名稱<input name="name" value="${esc(u.name || '')}" autocomplete="off"></label>` : ''}
      <div class="mrows">${ms.filter((m) => canManage(m.project)).map(memberRow).join('')}</div>
      <button type="button" class="linkish" data-add>＋ 加一個專案</button>
      ${fixed.length ? `<p class="dim small">其他專案（不在你的管理範圍）：${fixed.map((m) => `${esc(pLabel(m.project))}：${esc(m.role)}`).join('、')}</p>` : ''}
      ${me.owner && !u.owner ? `<label class="check"><input type="checkbox" name="disabled"${u.disabled ? ' checked' : ''}> 停用這個帳號</label>` : ''}
      <div class="wf-row"><button type="submit" class="btn primary">儲存</button><button type="button" class="btn" data-cancel>取消</button>
        ${me.owner && !u.owner ? '<button type="button" class="btn danger" data-del>停用並移除存取</button>' : ''}<span class="msg" aria-live="polite"></span></div></form>`;
  };

  app.querySelector('.loading').outerHTML = `
    <nav class="toc" aria-label="目錄"><b>目錄</b><button type="button" data-jump="a-users">使用者</button><button type="button" data-jump="a-invite">邀請</button></nav>
    <section id="a-users"><h2 class="h2">使用者 <span class="dim">${users.length}</span></h2>
    ${!me.owner ? `<p class="dim small">你可以管理的專案：${esc(mine.join('、') || '（無）')}。</p>` : ''}
    <div class="tbl-wrap"><table class="docs compact users"><thead><tr><th>Email</th><th>名稱</th><th>專案角色</th><th>狀態</th><th class="c-date">最近登入</th><th></th></tr></thead><tbody>
    ${users.map((u, i) => `<tr${u.disabled ? ' class="disabled"' : ''}><td class="email">${esc(u.email)}</td><td>${esc(u.name || '')}</td><td>${roleChips(u)}</td>
      <td>${u.disabled ? '<span class="chip">已停用</span>' : '<span class="dim">啟用</span>'}</td><td class="c-date nowrap dim">${fmt(u.last_seen || u.lastSeen)}</td>
      <td><button type="button" class="btn small" data-edit="${i}">編輯</button></td></tr>
      <tr class="edit-row" id="edit-${i}" hidden><td colspan="6"></td></tr>`).join('')}</tbody></table></div></section>
    <section class="card" id="a-invite"><h2>邀請使用者</h2>
      <form class="uedit invite" id="invite">
        <label>Email<input name="email" type="email" required autocomplete="off"></label>
        <label>名稱<input name="name" autocomplete="off"></label>
        <div class="mrows">${mine.length || me.owner ? memberRow() : ''}</div>
        <button type="button" class="linkish" data-add>＋ 加一個專案</button>
        <div class="wf-row"><button type="submit" class="btn primary">邀請</button><span class="msg" aria-live="polite"></span></div>
      </form></section>`;

  app.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
  const rerender = () => renderAdmin(app, { me, api, esc, projects, tab, link });
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
      if (!confirm(`停用 ${u.email} 並從存取群組移除？`)) return;
      try { await api('DELETE', `/api/users/${encodeURIComponent(u.email)}`); rerender(); } catch (x) { form.querySelector('.msg').textContent = `失敗：${x.message}`; }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { memberships: collect(form) };
      if (me.owner) body.name = form.querySelector('[name=name]').value.trim();
      const dis = form.querySelector('[name=disabled]');
      if (dis && dis.checked !== Boolean(u.disabled)) body.disabled = dis.checked;
      form.querySelector('.msg').textContent = '儲存中…';
      try { await api('PATCH', `/api/users/${encodeURIComponent(u.email)}`, body); rerender(); } catch (x) { form.querySelector('.msg').textContent = `儲存失敗：${x.message}`; }
    });
  }));

  const inv = app.querySelector('#invite');
  bindForm(inv);
  inv.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = inv.querySelector('[name=email]').value.trim().toLowerCase();
    const memberships = collect(inv);
    if (!me.owner && !memberships.length) { inv.querySelector('.msg').textContent = '至少要指定一個專案。'; return; }
    inv.querySelector('.msg').textContent = '邀請中…';
    try {
      await api('POST', '/api/users', { email, name: inv.querySelector('[name=name]').value.trim() || undefined, memberships });
      rerender();
    } catch (x) { inv.querySelector('.msg').textContent = `邀請失敗：${x.message}`; }
  });
}
