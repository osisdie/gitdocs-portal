// HTTP API (DESIGN.md → HTTP API). The middleware has already authenticated the caller (ctx.data.user).
import { json, errorJson, fail, HttpError, readJson, nowIso, EMAIL_RE, normEmail } from './http.js';
import { ROLES, canSee, canEdit, canManage, canManageRow, ownerEmails } from './roles.js';
import { loadCatalog, docById, docByPath } from './assets.js';
import { revealSecret } from './vault.js';
import { syncAccessGroup } from './access-group.js';

const LOGIN_EVERY_MS = 60 * 60 * 1000; // one `login` history row per user per hour is enough for "last seen"
const PREFS_MAX = 8 * 1024;
const NOTE_MAX = 4000;
const TAGS_MAX = 50, TAG_LEN = 60;

const ROUTES = [
  ['GET', 'me', getMe],
  ['PUT', 'me/prefs', putPrefs],
  ['GET', 'state', getState],
  ['PATCH', 'docs/:id', patchDoc],
  ['GET', 'docs/:id/notes', listNotes],
  ['POST', 'docs/:id/notes', addNote],
  ['GET', 'docs/:id/history', docHistory],
  ['POST', 'vault/reveal', reveal],
  ['GET', 'users', listUsers],
  ['POST', 'users', createUser],
  ['PATCH', 'users/:email', patchUser],
  ['DELETE', 'users/:email', deleteUser],
  ['GET', 'audit', audit],
  ['GET', 'export/state', exportState],
];

function route(method, parts) {
  let pathMatched = false;
  for (const [m, pattern, fn] of ROUTES) {
    const segs = pattern.split('/');
    if (segs.length !== parts.length) continue;
    const params = [];
    if (!segs.every((s, i) => (s.startsWith(':') ? params.push(parts[i]) : s === parts[i]))) continue;
    pathMatched = true;
    if (m === method) return { fn, params };
  }
  return pathMatched ? { status: 405 } : null;
}

export async function handleApi(ctx, deps = {}) {
  const { request, env } = ctx;
  if (!env.DB) return errorJson(404, 'server mode is not enabled'); // the UI reads this as static mode
  const user = ctx.data?.user;
  if (!user) return errorJson(403, '尚未開通，請聯絡管理員');
  const url = new URL(request.url);
  let parts;
  try { parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent); } catch { return errorJson(400, 'bad path'); }
  const hit = route(request.method, parts);
  if (!hit) return errorJson(404, 'not found');
  if (hit.status) return errorJson(hit.status, 'method not allowed');
  const c = { request, env, user, url, db: env.DB, deps, at: nowIso(deps.now ? deps.now() : Date.now()) };
  try {
    return await hit.fn(c, ...hit.params);
  } catch (e) {
    if (e instanceof HttpError) return errorJson(e.status, e.message);
    console.error('api', e);
    return errorJson(500, 'server error');
  }
}

// ---------- helpers ----------
const str = (v) => (v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v));

function history(c, { path = null, action, field = null, old = null, value = null }) {
  return c.db.prepare('INSERT INTO history (path, actor, action, field, old, new, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(path, c.user.email, action, field, str(old), str(value), c.at);
}

/** The doc for :id when the caller can see it; 404 otherwise (do not reveal that it exists). */
async function visibleDoc(c, id) {
  const catalog = await loadCatalog(c.env, c.request);
  const doc = docById(catalog, id);
  if (!doc || !canSee(c.user, doc.project)) fail(404, 'document not found');
  return { catalog, doc };
}

const parseTags = (t) => { try { return t === null || t === undefined ? null : JSON.parse(t); } catch { return null; } };

function stateFromRow(row, doc, notes = 0) {
  if (!row) return { status: doc.status ?? null, assignee: doc.assignee ?? null, reviewer: doc.reviewer ?? null, tags: doc.tags ?? [], updated_by: null, updated_at: null, notes };
  return { status: row.status, assignee: row.assignee, reviewer: row.reviewer, tags: parseTags(row.tags), updated_by: row.updated_by, updated_at: row.updated_at, notes };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const managesAny = (user) => user.owner || Object.values(user.roles).includes('manager');

// A cleared person is stored as '' (explicitly nobody), never null: clients may read null as "use the catalog value".
function personField(name, v) {
  if (v === null || v === '') return '';
  const e = normEmail(v);
  if (typeof v !== 'string' || !EMAIL_RE.test(e)) fail(400, `${name} must be an email or null`);
  return e;
}

function tagList(v) {
  if (v === null) return null;
  if (!Array.isArray(v) || v.length > TAGS_MAX) fail(400, `tags must be an array of at most ${TAGS_MAX} strings`);
  const out = [];
  for (const t of v) {
    if (typeof t !== 'string' || !t.trim() || t.trim().length > TAG_LEN) fail(400, `each tag must be a non-empty string of at most ${TAG_LEN} characters`);
    if (!out.includes(t.trim())) out.push(t.trim());
  }
  return out;
}

// ---------- me ----------
async function getMe(c) {
  const { user, db } = c;
  const writes = [];
  if (user.owner && !user.known) {
    writes.push(db.prepare('INSERT OR IGNORE INTO users (email, name, disabled, created_at, created_by) VALUES (?, ?, 0, ?, ?)')
      .bind(user.email, null, c.at, 'OWNER_EMAILS'));
  }
  const last = await db.prepare("SELECT at FROM history WHERE actor = ? AND action = 'login' ORDER BY at DESC LIMIT 1").bind(user.email).first();
  if (!last || Date.parse(c.at) - Date.parse(last.at) > LOGIN_EVERY_MS) writes.push(history(c, { action: 'login' }));
  if (writes.length) await db.batch(writes);
  const p = await db.prepare('SELECT json FROM prefs WHERE email = ?').bind(user.email).first();
  let prefs = {};
  try { prefs = p ? JSON.parse(p.json) : {}; } catch { /* corrupt prefs: start over */ }
  return json({ email: user.email, name: user.name, owner: user.owner, roles: user.roles, prefs });
}

async function putPrefs(c) {
  const body = await readJson(c.request, PREFS_MAX);
  if (!isObject(body)) fail(400, 'prefs must be a JSON object');
  const text = JSON.stringify(body);
  if (new TextEncoder().encode(text).length > PREFS_MAX) fail(400, 'prefs larger than 8 KB');
  await c.db.batch([
    c.db.prepare('INSERT INTO prefs (email, json) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET json = excluded.json').bind(c.user.email, text),
    history(c, { action: 'prefs' }),
  ]);
  return json({ ok: true });
}

// ---------- docs ----------
async function noteCounts(db, path) {
  const sql = path ? 'SELECT path, COUNT(*) AS n FROM notes WHERE path = ? GROUP BY path' : 'SELECT path, COUNT(*) AS n FROM notes GROUP BY path';
  const stmt = path ? db.prepare(sql).bind(path) : db.prepare(sql);
  return new Map((await stmt.all()).results.map((r) => [r.path, r.n]));
}

async function getState(c) {
  const catalog = await loadCatalog(c.env, c.request);
  const rows = new Map((await c.db.prepare('SELECT * FROM doc_state').all()).results.map((r) => [r.path, r]));
  const counts = await noteCounts(c.db);
  const docs = {};
  for (const path of new Set([...rows.keys(), ...counts.keys()])) {
    const doc = docByPath(catalog, path);
    if (doc && canSee(c.user, doc.project)) docs[path] = stateFromRow(rows.get(path), doc, counts.get(path) || 0);
  }
  return json({ docs });
}

async function patchDoc(c, id) {
  const { catalog, doc } = await visibleDoc(c, id);
  if (!canEdit(c.user, doc.project)) fail(403, '需要 editor 權限');
  const body = await readJson(c.request);
  if (!isObject(body)) fail(400, 'body must be a JSON object');
  const keys = Object.keys(body);
  const bad = keys.filter((k) => !['status', 'assignee', 'reviewer', 'tags'].includes(k));
  if (bad.length) fail(400, `cannot change: ${bad.join(', ')}`);
  if (!keys.length) fail(400, 'nothing to change');
  const patch = {};
  if ('status' in body) {
    if (!(catalog.statuses || []).includes(body.status)) fail(400, `status must be one of: ${(catalog.statuses || []).join(' / ')}`);
    patch.status = body.status;
  }
  if ('assignee' in body) patch.assignee = personField('assignee', body.assignee);
  if ('reviewer' in body) patch.reviewer = personField('reviewer', body.reviewer);
  if ('tags' in body) patch.tags = tagList(body.tags);

  const row = await c.db.prepare('SELECT * FROM doc_state WHERE path = ?').bind(doc.path).first();
  const cur = stateFromRow(row, doc);
  const changed = Object.keys(patch).filter((k) => str(patch[k]) !== str(cur[k]));
  const notes = (await noteCounts(c.db, doc.path)).get(doc.path) || 0;
  if (!changed.length) return json({ id: doc.id, path: doc.path, ...cur, notes });
  const next = { ...cur, ...patch, updated_by: c.user.email, updated_at: c.at };
  await c.db.batch([
    c.db.prepare(`INSERT INTO doc_state (path, status, assignee, reviewer, tags, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (path) DO UPDATE SET status = excluded.status, assignee = excluded.assignee, reviewer = excluded.reviewer,
      tags = excluded.tags, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(doc.path, next.status, next.assignee, next.reviewer, str(next.tags), next.updated_by, next.updated_at),
    ...changed.map((k) => history(c, { path: doc.path, action: 'update', field: k, old: cur[k], value: next[k] })),
  ]);
  return json({ id: doc.id, path: doc.path, ...next, notes });
}

async function listNotes(c, id) {
  const { doc } = await visibleDoc(c, id);
  const { results } = await c.db.prepare('SELECT id, author, body, created_at FROM notes WHERE path = ? ORDER BY id').bind(doc.path).all();
  return json(results);
}

async function addNote(c, id) {
  const { doc } = await visibleDoc(c, id);
  const body = await readJson(c.request);
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!text) fail(400, 'body is required');
  if (text.length > NOTE_MAX) fail(400, `note longer than ${NOTE_MAX} characters`);
  const [ins] = await c.db.batch([
    c.db.prepare('INSERT INTO notes (path, author, body, created_at) VALUES (?, ?, ?, ?)').bind(doc.path, c.user.email, text, c.at),
    // same transaction: last_insert_rowid() is the note just inserted
    c.db.prepare("INSERT INTO history (path, actor, action, field, old, new, at) VALUES (?, ?, 'note', NULL, NULL, CAST(last_insert_rowid() AS TEXT), ?)")
      .bind(doc.path, c.user.email, c.at),
  ]);
  return json({ id: ins.meta.last_row_id, author: c.user.email, body: text, created_at: c.at }, 201);
}

async function docHistory(c, id) {
  const { doc } = await visibleDoc(c, id);
  const { results } = await c.db.prepare('SELECT actor, action, field, old, new, at FROM history WHERE path = ? ORDER BY id DESC LIMIT 500').bind(doc.path).all();
  return json(results);
}

// ---------- vault ----------
async function reveal(c) {
  const body = await readJson(c.request);
  if (!isObject(body)) fail(400, 'body must be a JSON object');
  const { id, name, action } = body;
  if (!['show', 'copy'].includes(action)) fail(400, 'action must be show or copy');
  if (typeof name !== 'string' || !name) fail(400, 'name is required');
  const { doc } = await visibleDoc(c, id);
  if (!canEdit(c.user, doc.project)) fail(403, '需要 editor 權限');
  if (!(doc.vault || []).includes(name)) fail(403, 'this document does not reference that secret');
  let value;
  try { value = await revealSecret(c.env, c.request, name); } catch (e) { console.error('vault', e); fail(500, 'server vault is not configured correctly'); }
  if (value === null) fail(404, 'secret not found in the deployed vault');
  await c.db.prepare('INSERT INTO vault_audit (email, name, path, action, at) VALUES (?, ?, ?, ?, ?)')
    .bind(c.user.email, name, doc.path, action, c.at).run();
  return json({ value }, 200, { 'cache-control': 'no-store' });
}

// ---------- users ----------
function membershipRows(c, rows, { allowRemove }) {
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) fail(400, 'memberships must be an array');
  const seen = new Set();
  return rows.map((r) => {
    const project = typeof r?.project === 'string' ? r.project.trim() : '';
    if (!project || project.length > 200 || (project !== '*' && project.includes('/'))) fail(400, `invalid project: ${r?.project}`);
    if (seen.has(project)) fail(400, `duplicate project: ${project}`);
    seen.add(project);
    const role = r.role ?? null;
    if (role === null ? !allowRemove : !ROLES.includes(role)) fail(400, `role must be one of: ${ROLES.join(' / ')}${allowRemove ? ' (or null to remove)' : ''}`);
    if (!canManageRow(c.user, project)) fail(403, project === '*' ? 'only owners grant access to every project' : `you do not manage ${project}`);
    return { project, role };
  });
}

/** Apply membership rows (role null = remove); returns statements incl. history. */
async function membershipWrites(c, email, rows) {
  const { results } = await c.db.prepare('SELECT project, role FROM memberships WHERE email = ?').bind(email).all();
  const cur = new Map(results.map((r) => [r.project, r.role]));
  const out = [];
  for (const { project, role } of rows) {
    const old = cur.get(project) ?? null;
    if (old === role) continue;
    out.push(role === null
      ? c.db.prepare('DELETE FROM memberships WHERE email = ? AND project = ?').bind(email, project)
      : c.db.prepare('INSERT INTO memberships (email, project, role) VALUES (?, ?, ?) ON CONFLICT (email, project) DO UPDATE SET role = excluded.role').bind(email, project, role));
    out.push(history(c, { action: 'membership', field: `${email} ${project}`, old, value: role }));
  }
  return out;
}

async function userViews(c, filterEmail = null) {
  const owners = ownerEmails(c.env);
  const users = (await c.db.prepare('SELECT email, name, disabled, created_at, created_by FROM users').all()).results;
  const members = (await c.db.prepare('SELECT email, project, role FROM memberships').all()).results;
  const seen = new Map((await c.db.prepare("SELECT actor, MAX(at) AS at FROM history WHERE action = 'login' GROUP BY actor").all()).results.map((r) => [r.actor, r.at]));
  const byEmail = new Map(users.map((u) => [u.email, u]));
  for (const o of owners) if (!byEmail.has(o)) byEmail.set(o, { email: o, name: null, disabled: 0, created_at: null, created_by: 'OWNER_EMAILS' });
  const out = [];
  for (const u of byEmail.values()) {
    if (filterEmail && u.email !== filterEmail) continue;
    const rows = members.filter((m) => m.email === u.email && (c.user.owner || canManageRow(c.user, m.project) || (m.project === '*' && canManage(c.user, '*'))));
    if (!c.user.owner && !rows.length) continue; // managers only see users of projects they manage
    out.push({
      email: u.email, name: u.name || '', disabled: !!u.disabled, owner: owners.has(u.email),
      created_at: u.created_at, created_by: u.created_by, last_seen: seen.get(u.email) || null,
      memberships: rows.map(({ project, role }) => ({ project, role })).sort((a, b) => a.project.localeCompare(b.project)),
    });
  }
  return out.sort((a, b) => a.email.localeCompare(b.email));
}

async function listUsers(c) {
  if (!managesAny(c.user)) fail(403, '需要 manager 權限');
  return json(await userViews(c));
}

async function createUser(c) {
  if (!managesAny(c.user)) fail(403, '需要 manager 權限');
  const body = await readJson(c.request);
  if (!isObject(body)) fail(400, 'body must be a JSON object');
  const email = normEmail(body.email);
  if (!EMAIL_RE.test(email)) fail(400, 'invalid email');
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
  const rows = membershipRows(c, body.memberships, { allowRemove: false });
  if (!c.user.owner && !rows.length) fail(400, 'memberships are required');
  const existing = await c.db.prepare('SELECT email, name, disabled FROM users WHERE email = ?').bind(email).first();
  const writes = [];
  if (!existing) {
    writes.push(c.db.prepare('INSERT INTO users (email, name, disabled, created_at, created_by) VALUES (?, ?, 0, ?, ?)').bind(email, name || null, c.at, c.user.email));
    writes.push(history(c, { action: 'user.create', field: email, value: name || null }));
  } else if (name && (c.user.owner || !existing.name) && name !== existing.name) {
    writes.push(c.db.prepare('UPDATE users SET name = ? WHERE email = ?').bind(name, email));
    writes.push(history(c, { action: 'user.update', field: `${email} name`, old: existing.name, value: name }));
  }
  writes.push(...(await membershipWrites(c, email, rows)));
  if (writes.length) await c.db.batch(writes);
  const warnings = [];
  if (existing?.disabled) warnings.push(`${email} is disabled; an owner must enable the account`);
  const w = await syncAccessGroup(c.env, c.db, c.deps.fetch);
  if (w) warnings.push(w);
  const [user] = await userViews(c, email);
  return json({ user: user || null, existing: !!existing, ...(warnings.length ? { warning: warnings.join('; ') } : {}) }, existing ? 200 : 201);
}

async function patchUser(c, rawEmail) {
  if (!managesAny(c.user)) fail(403, '需要 manager 權限');
  const email = normEmail(rawEmail);
  const owners = ownerEmails(c.env);
  if (!c.user.owner && owners.has(email)) fail(403, 'owners are managed through OWNER_EMAILS');
  const target = await c.db.prepare('SELECT email, name, disabled FROM users WHERE email = ?').bind(email).first();
  if (!target) fail(404, 'user not found');
  const body = await readJson(c.request);
  if (!isObject(body)) fail(400, 'body must be a JSON object');
  const bad = Object.keys(body).filter((k) => !['name', 'disabled', 'memberships'].includes(k));
  if (bad.length) fail(400, `cannot change: ${bad.join(', ')}`);
  if (!Object.keys(body).length) fail(400, 'nothing to change');
  if (!c.user.owner && 'disabled' in body) fail(403, 'only owners can disable or enable users');
  const rows = membershipRows(c, body.memberships, { allowRemove: true });
  if (body.memberships !== undefined) {
    // the list is the desired set within the caller's reach: rows the caller manages but did not list are removed
    const listed = new Set(rows.map((r) => r.project));
    const { results } = await c.db.prepare('SELECT project FROM memberships WHERE email = ?').bind(email).all();
    for (const r of results) if (!listed.has(r.project) && canManageRow(c.user, r.project)) rows.push({ project: r.project, role: null });
  }
  const writes = [];
  if ('name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';
    if (!c.user.owner) {
      const { results } = await c.db.prepare('SELECT project FROM memberships WHERE email = ?').bind(email).all();
      if (!results.some((r) => canManageRow(c.user, r.project))) fail(403, 'you do not manage this user');
    }
    if (name !== (target.name || '')) {
      writes.push(c.db.prepare('UPDATE users SET name = ? WHERE email = ?').bind(name || null, email));
      writes.push(history(c, { action: 'user.update', field: `${email} name`, old: target.name, value: name || null }));
    }
  }
  let accessChanged = false;
  if ('disabled' in body) {
    if (typeof body.disabled !== 'boolean') fail(400, 'disabled must be true or false');
    if (body.disabled && owners.has(email)) fail(400, 'owners cannot be disabled (remove them from OWNER_EMAILS)');
    if (body.disabled !== !!target.disabled) {
      writes.push(c.db.prepare('UPDATE users SET disabled = ? WHERE email = ?').bind(body.disabled ? 1 : 0, email));
      writes.push(history(c, { action: body.disabled ? 'user.disable' : 'user.enable', field: email }));
      accessChanged = true;
    }
  }
  const memberWrites = await membershipWrites(c, email, rows);
  if (memberWrites.length) accessChanged = true;
  writes.push(...memberWrites);
  if (writes.length) await c.db.batch(writes);
  const warning = accessChanged ? await syncAccessGroup(c.env, c.db, c.deps.fetch) : null;
  const [user] = await userViews(c, email);
  return json({ user: user || null, ...(warning ? { warning } : {}) });
}

async function deleteUser(c, rawEmail) {
  if (!c.user.owner) fail(403, '需要 owner 權限');
  const email = normEmail(rawEmail);
  if (ownerEmails(c.env).has(email)) fail(400, 'owners cannot be removed here (edit OWNER_EMAILS)');
  const target = await c.db.prepare('SELECT disabled FROM users WHERE email = ?').bind(email).first();
  if (!target) fail(404, 'user not found');
  if (!target.disabled) {
    await c.db.batch([
      c.db.prepare('UPDATE users SET disabled = 1 WHERE email = ?').bind(email),
      history(c, { action: 'user.disable', field: email }),
    ]);
  }
  const warning = await syncAccessGroup(c.env, c.db, c.deps.fetch);
  return json({ ok: true, ...(warning ? { warning } : {}) });
}

// ---------- owner tools ----------
async function audit(c) {
  if (!c.user.owner) fail(403, '需要 owner 權限');
  const limit = Math.min(500, Math.max(1, Number.parseInt(c.url.searchParams.get('limit') || '100', 10) || 100));
  const h = await c.db.prepare('SELECT id, path, actor, action, field, old, new, at FROM history ORDER BY id DESC LIMIT ?').bind(limit).all();
  const v = await c.db.prepare('SELECT id, email, name, path, action, at FROM vault_audit ORDER BY id DESC LIMIT ?').bind(limit).all();
  return json({ history: h.results, vault: v.results });
}

async function exportState(c) {
  if (!c.user.owner) fail(403, '需要 owner 權限');
  const since = c.url.searchParams.get('since') || '';
  const docs = await c.db.prepare('SELECT * FROM doc_state WHERE updated_at > ? ORDER BY updated_at').bind(since).all();
  const notes = await c.db.prepare('SELECT id, path, author, body, created_at FROM notes WHERE created_at > ? ORDER BY id').bind(since).all();
  return json({ at: c.at, docs: docs.results.map((r) => ({ ...r, tags: parseTags(r.tags) })), notes: notes.results });
}
