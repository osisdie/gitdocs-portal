// HTTP API (DESIGN.md → HTTP API). The middleware has already authenticated the caller (ctx.data.user).
import { json, errorJson, fail, HttpError, readJson, nowIso, EMAIL_RE, normEmail } from './http.js';
import { ROLES, canSee, canEdit, canManage, canManageRow, ownerEmails, topProject } from './roles.js';
import { loadCatalog, docById, docByPath, publicOf, docSource } from './assets.js';
import { revealSecret, listSecrets, otherStores, webSeal, webVaultReady, validName, namespaceOf, VALUE_MAX } from './vault.js';
import { syncAccessGroup } from './access-group.js';
import { peopleMap, namesFor, checkName, nameTaken, visiblePeople } from './people.js';

const LOGIN_EVERY_MS = 60 * 60 * 1000; // one `login` history row per user per hour is enough for "last seen"
const PREFS_MAX = 8 * 1024;
const NOTE_MAX = 4000;
const TAGS_MAX = 50, TAG_LEN = 60;

const ROUTES = [
  ['GET', 'me', getMe],
  ['PATCH', 'me', patchMe],
  ['PUT', 'me/prefs', putPrefs],
  ['GET', 'state', getState],
  ['PATCH', 'docs/:id', patchDoc],
  ['GET', 'docs/:id/notes', listNotes],
  ['POST', 'docs/:id/notes', addNote],
  ['GET', 'docs/:id/history', docHistory],
  ['POST', 'vault/reveal', reveal],
  ['GET', 'vault/secrets', getSecrets],
  ['PUT', 'vault/secrets', putSecret],
  ['DELETE', 'vault/secrets/*name', deleteSecret],
  ['GET', 'users', listUsers],
  ['POST', 'users', createUser],
  ['PATCH', 'users/:email', patchUser],
  ['DELETE', 'users/:email', deleteUser],
  ['GET', 'audit', audit],
  ['GET', 'export/state', exportState],
];

// ':x' = one segment; a trailing '*x' = the rest of the path joined with '/' (at least one segment)
function route(method, parts) {
  let pathMatched = false;
  for (const [m, pattern, fn] of ROUTES) {
    const segs = pattern.split('/');
    const rest = segs[segs.length - 1].startsWith('*');
    if (rest ? parts.length < segs.length : segs.length !== parts.length) continue;
    const params = [];
    if (!segs.every((s, i) => (s.startsWith('*') ? params.push(parts.slice(i).join('/')) : s.startsWith(':') ? params.push(parts[i]) : s === parts[i]))) continue;
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
  if (!doc || !canSee(c.user, doc.project, publicOf(catalog))) fail(404, 'document not found');
  return { catalog, doc };
}

const parseTags = (t) => { try { return t === null || t === undefined ? null : JSON.parse(t); } catch { return null; } };

function stateFromRow(row, doc, notes = 0) {
  if (!row) return { status: doc.status ?? null, assignee: doc.assignee ?? null, reviewer: doc.reviewer ?? null, tags: doc.tags ?? [], updated_by: null, updated_at: null, notes };
  return { status: row.status, assignee: row.assignee, reviewer: row.reviewer, tags: parseTags(row.tags), updated_by: row.updated_by, updated_at: row.updated_at, notes };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Display names as the caller sees them: collisions are told apart among the caller's visible people only. */
const namerFor = async (c, catalog) => namesFor(c.db, await visiblePeople(c.db, c.env, c.user, catalog));

/** A display name from a request body for user `email`: validated, and not another enabled user's (409). */
async function newName(c, v, email) {
  const { name, error } = checkName(v);
  if (error) fail(400, error);
  if (await nameTaken(c.db, c.env, name, email)) fail(409, 'that display name is already used by another user; choose a different one');
  return name;
}
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
  let publicProjects = [];
  try { publicProjects = [...publicOf(await loadCatalog(c.env, c.request))].sort(); } catch (e) { console.error('me: catalog', e); }
  return json({ email: user.email, name: user.name, owner: user.owner, roles: user.roles, publicProjects, prefs });
}

async function patchMe(c) {
  const body = await readJson(c.request, 4096);
  if (!isObject(body)) fail(400, 'body must be a JSON object');
  const bad = Object.keys(body).filter((k) => k !== 'name');
  if (bad.length || !('name' in body)) fail(400, bad.length ? `cannot change: ${bad.join(', ')}` : 'nothing to change');
  const name = await newName(c, body.name, c.user.email);
  const row = await c.db.prepare('SELECT name FROM users WHERE email = ?').bind(c.user.email).first();
  const old = row?.name || '';
  if (row && old === name) return json({ email: c.user.email, name });
  await c.db.batch([
    // owners listed only in OWNER_EMAILS get their users row here (no memberships)
    row
      ? c.db.prepare('UPDATE users SET name = ? WHERE email = ?').bind(name || null, c.user.email)
      : c.db.prepare('INSERT INTO users (email, name, disabled, created_at, created_by) VALUES (?, ?, 0, ?, ?)').bind(c.user.email, name || null, c.at, 'OWNER_EMAILS'),
    history(c, { action: 'user.update', field: `${c.user.email} name`, old: old || null, value: name || null }),
  ]);
  return json({ email: c.user.email, name });
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
  const pub = publicOf(catalog);
  const docs = {};
  for (const path of new Set([...rows.keys(), ...counts.keys()])) {
    const doc = docByPath(catalog, path);
    if (doc && canSee(c.user, doc.project, pub)) docs[path] = stateFromRow(rows.get(path), doc, counts.get(path) || 0);
  }
  return json({ docs, people: await peopleMap(c.db, c.env, c.user, catalog) });
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
  const { catalog, doc } = await visibleDoc(c, id);
  const { results } = await c.db.prepare('SELECT id, author, body, created_at FROM notes WHERE path = ? ORDER BY id').bind(doc.path).all();
  const name = await namerFor(c, catalog);
  return json(results.map((n) => ({ ...n, author_name: name(n.author) })));
}

async function addNote(c, id) {
  const { catalog, doc } = await visibleDoc(c, id);
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
  const name = await namerFor(c, catalog);
  return json({ id: ins.meta.last_row_id, author: c.user.email, author_name: name(c.user.email), body: text, created_at: c.at }, 201);
}

async function docHistory(c, id) {
  const { catalog, doc } = await visibleDoc(c, id);
  const { results } = await c.db.prepare('SELECT actor, action, field, old, new, at FROM history WHERE path = ? ORDER BY id DESC LIMIT 500').bind(doc.path).all();
  const name = await namerFor(c, catalog);
  return json(results.map((h) => ({ ...h, actor_name: name(h.actor) })));
}

// ---------- vault ----------
/**
 * Namespace project of a secret name the caller may manage (vault page: list / write / reveal without a doc).
 * Owners: any namespace; others: manager+ of a top-level project of the deployed catalog.
 */
async function managedNamespace(c, name, { min = 'manager', write = false } = {}) {
  const ns = namespaceOf(name);
  if (c.user.owner && !write) return ns; // owners may still read / delete names of a project that is gone
  const catalog = await loadCatalog(c.env, c.request);
  const known = Object.hasOwn(catalog.projects || {}, ns) && !catalog.projects[ns]?.parent;
  if (c.user.owner) {
    if (!known) fail(400, `${ns} is not a top-level project of the deployed catalog`);
    return ns;
  }
  const ok = min === 'editor' ? canEdit(c.user, ns) : canManage(c.user, ns);
  if (!known || !ok) fail(403, min === 'editor' ? '需要 editor 權限' : '需要 manager 權限');
  return ns;
}

async function reveal(c) {
  const body = await readJson(c.request);
  if (!isObject(body)) fail(400, 'body must be a JSON object');
  const { id, name, action } = body;
  if (!['show', 'copy'].includes(action)) fail(400, 'action must be show or copy');
  if (typeof name !== 'string' || !name) fail(400, 'name is required');
  let path = null, catalog;
  if (id === undefined || id === null) {
    // vault page: no document, so the caller must manage the namespace
    if (!validName(name)) fail(400, 'invalid secret name');
    await managedNamespace(c, name);
    catalog = await loadCatalog(c.env, c.request);
  } else {
    const hit = await visibleDoc(c, id);
    catalog = hit.catalog;
    const { doc } = hit;
    if (!canEdit(c.user, doc.project)) fail(403, '需要 editor 權限');
    if (!(doc.vault || []).includes(name)) fail(403, 'this document does not reference that secret');
    // a doc mounted from an external source may only open secrets in its own namespace (the build strips other
    // references already; this holds even if a catalog was built without that check)
    const source = docSource(catalog, doc);
    if (source && !name.startsWith(`${source}/`)) fail(403, `documents from source ${source} can only reveal ${source}/… secrets`);
    path = doc.path;
  }
  let hit;
  try { hit = await revealSecret(c.env, c.request, name, { db: c.db, catalog }); } catch (e) { console.error('vault', e); fail(500, 'server vault is not configured correctly'); }
  if (hit === null) fail(404, 'secret not found in the deployed vault');
  await c.db.prepare('INSERT INTO vault_audit (email, name, path, action, at) VALUES (?, ?, ?, ?, ?)')
    .bind(c.user.email, name, path, action, c.at).run();
  return json({ value: hit.value, origin: hit.origin }, 200, { 'cache-control': 'no-store' });
}

const PROJECT_RE = /^[A-Za-z0-9_.-]+$/;

async function getSecrets(c) {
  const project = c.url.searchParams.get('project') || '';
  if (!PROJECT_RE.test(project) || topProject(project) !== project) fail(400, 'project must be a top-level project key (A-Z a-z 0-9 _ . -)');
  await managedNamespace(c, `${project}/x`, { min: 'editor' });
  const catalog = await loadCatalog(c.env, c.request);
  const rows = await listSecrets(c.env, c.request, { db: c.db, catalog, project });
  const name = await namerFor(c, catalog);
  return json(rows.map((r) => ({ ...r, updated_by_name: r.updated_by ? name(r.updated_by) : null })));
}

async function putSecret(c) {
  const body = await readJson(c.request, VALUE_MAX * 2 + 4096);
  if (!isObject(body)) fail(400, 'body must be a JSON object');
  const bad = Object.keys(body).filter((k) => !['name', 'value', 'note'].includes(k));
  if (bad.length) fail(400, `unknown fields: ${bad.join(', ')}`);
  const { name, value } = body;
  if (!validName(name)) fail(400, 'name must look like <project>/<name> (A-Z a-z 0-9 _ . / -, ≤ 200 characters)');
  await managedNamespace(c, name, { write: true });
  if (typeof value !== 'string' || !value) fail(400, 'value is required');
  if (new TextEncoder().encode(value).length > VALUE_MAX) fail(400, 'value larger than 16 KB');
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 200)) fail(400, 'note must be a string of at most 200 characters');
  if (!webVaultReady(c.env)) fail(503, 'web vault not configured (VAULT_KEY)');
  const cur = await c.db.prepare('SELECT note FROM vault_secrets WHERE name = ?').bind(name).first();
  // a web row is looked up first, so a new one would silently replace what the git / host vault holds for every doc
  const shadowed = cur ? [] : await otherStores(c.env, c.request, name, await loadCatalog(c.env, c.request));
  if (shadowed.length && !c.user.owner) fail(409, `${name} is kept in the ${shadowed.join(' / ')} vault; change it there (an owner can override it here)`);
  const note = body.note !== undefined ? body.note.trim() : (cur?.note || '');
  const box = await webSeal(c.env, name, value);
  const action = cur ? 'update' : 'create';
  await c.db.batch([
    c.db.prepare(`INSERT INTO vault_secrets (name, iv, ct, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET iv = excluded.iv, ct = excluded.ct, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(name, box.iv, box.ct, note, c.user.email, c.at),
    c.db.prepare('INSERT INTO vault_versions (name, iv, ct, note, action, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(name, box.iv, box.ct, note, action, c.user.email, c.at),
    history(c, { action: 'vault.set', field: name }), // the name only: never the value
    ...(shadowed.length ? [history(c, { action: 'vault.override', field: name, old: shadowed.join(','), value: 'web' })] : []),
  ]);
  return json({ name, note, origin: 'web', updated_by: c.user.email, updated_at: c.at }, cur ? 200 : 201);
}

async function deleteSecret(c, name) {
  if (!validName(name)) fail(400, 'invalid secret name');
  await managedNamespace(c, name);
  const cur = await c.db.prepare('SELECT note FROM vault_secrets WHERE name = ?').bind(name).first();
  if (!cur) fail(404, 'no web vault secret with that name (git and host secrets are changed in their repos)');
  await c.db.batch([
    c.db.prepare('DELETE FROM vault_secrets WHERE name = ?').bind(name),
    c.db.prepare("INSERT INTO vault_versions (name, iv, ct, note, action, actor, at) VALUES (?, NULL, NULL, ?, 'delete', ?, ?)")
      .bind(name, cur.note, c.user.email, c.at),
    history(c, { action: 'vault.delete', field: name }),
  ]);
  return json({ ok: true });
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

/** Membership rows of `email` the caller manages (owners: all rows). */
async function managedRows(c, email) {
  const { results } = await c.db.prepare('SELECT project, role FROM memberships WHERE email = ?').bind(email).all();
  return results.filter((m) => c.user.owner || canManageRow(c.user, m.project));
}

/**
 * Users as the caller may see them. Managers see only users with a membership in a project they manage, and nothing
 * about the account from outside their reach (DESIGN.md → Admin page): `created_at` / `created_by` only when the
 * creator is someone they can see, `last_seen` only for sign-ins since the user joined one of their projects.
 */
async function userViews(c, filterEmail = null) {
  const owners = ownerEmails(c.env);
  const users = (await c.db.prepare('SELECT email, name, disabled, created_at, created_by FROM users').all()).results;
  const members = (await c.db.prepare('SELECT email, project, role FROM memberships').all()).results;
  const logins = (await c.db.prepare("SELECT actor, at FROM history WHERE action = 'login'").all()).results;
  const byEmail = new Map(users.map((u) => [u.email, u]));
  for (const o of owners) if (!byEmail.has(o)) byEmail.set(o, { email: o, name: null, disabled: 0, created_at: null, created_by: 'OWNER_EMAILS' });
  let visible = null, joined = null;
  if (!c.user.owner) {
    visible = await visiblePeople(c.db, c.env, c.user, await loadCatalog(c.env, c.request));
    // first time each user got a membership the caller manages ('' = before history was kept: no limit)
    const grants = (await c.db.prepare("SELECT field, MIN(at) AS at FROM history WHERE action = 'membership' AND new IS NOT NULL GROUP BY field").all()).results;
    joined = new Map();
    for (const g of grants) {
      const [email, project] = String(g.field).split(' ');
      if (!canManageRow(c.user, project)) continue;
      if (!joined.has(email) || g.at < joined.get(email)) joined.set(email, g.at);
    }
  }
  const out = [];
  for (const u of byEmail.values()) {
    if (filterEmail && u.email !== filterEmail) continue;
    const rows = members.filter((m) => m.email === u.email && (c.user.owner || canManageRow(c.user, m.project)));
    if (!c.user.owner && !rows.length) continue; // managers only see users of projects they manage
    const since = c.user.owner ? '' : joined.get(u.email) || '';
    const seen = logins.filter((l) => l.actor === u.email && l.at >= since).reduce((m, l) => (m === null || l.at > m ? l.at : m), null);
    const creatorVisible = c.user.owner || !String(u.created_by || '').includes('@') || visible.has(String(u.created_by).toLowerCase());
    out.push({
      email: u.email, name: u.name || '', disabled: !!u.disabled, owner: owners.has(u.email),
      created_at: creatorVisible ? u.created_at : null, created_by: creatorVisible ? u.created_by : null, last_seen: seen,
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
  const name = body.name === undefined || body.name === null ? '' : await newName(c, body.name, email);
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
  if (c.user.owner && existing?.disabled) warnings.push(`${email} is disabled; enable the account first`);
  const w = await syncAccessGroup(c.env, c.db, c.deps.fetch);
  if (w) warnings.push(w);
  const warning = warnings.length ? { warning: warnings.join('; ') } : {};
  if (!c.user.owner) {
    // a manager's invite answers the same whether or not the account existed: the email and the caller's own rows
    const mine = (await managedRows(c, email)).map(({ project, role }) => ({ project, role })).sort((a, b) => a.project.localeCompare(b.project));
    return json({ user: { email, memberships: mine }, ...warning }, 201);
  }
  const [user] = await userViews(c, email);
  return json({ user: user || null, existing: !!existing, ...warning }, existing ? 200 : 201);
}

async function patchUser(c, rawEmail) {
  if (!managesAny(c.user)) fail(403, '需要 manager 權限');
  const email = normEmail(rawEmail);
  const owners = ownerEmails(c.env);
  const target = await c.db.prepare('SELECT email, name, disabled FROM users WHERE email = ?').bind(email).first();
  // managers get the same 404 for a user they do not manage as for one that does not exist (no tenant discovery)
  if (!c.user.owner && (!target || owners.has(email) || !(await managedRows(c, email)).length)) fail(404, 'user not found');
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
    const name = body.name === null ? '' : await newName(c, body.name, email);
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
  const name = await namesFor(c.db);
  return json({ history: h.results.map((r) => ({ ...r, actor_name: name(r.actor) })), vault: v.results.map((r) => ({ ...r, actor_name: name(r.email) })) });
}

async function exportState(c) {
  if (!c.user.owner) fail(403, '需要 owner 權限');
  const since = c.url.searchParams.get('since') || '';
  const docs = await c.db.prepare('SELECT * FROM doc_state WHERE updated_at > ? ORDER BY updated_at').bind(since).all();
  const notes = await c.db.prepare('SELECT id, path, author, body, created_at FROM notes WHERE created_at > ? ORDER BY id').bind(since).all();
  return json({ at: c.at, docs: docs.results.map((r) => ({ ...r, tags: parseTags(r.tags) })), notes: notes.results });
}
