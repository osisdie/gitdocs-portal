// Per-project roles (DESIGN.md → Roles and permissions).

export const ROLES = ['viewer', 'editor', 'manager'];
export const INDEX_PROJECT = '（索引）';
const RANK = { viewer: 1, editor: 2, manager: 3, owner: 4 };

// own-property lookups only: project keys come from catalogs and requests ('constructor', '__proto__', 'toString')
const own = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : null);

export const rank = (role) => (typeof role === 'string' && own(RANK, role)) || 0;
export const atLeast = (role, min) => rank(role) >= rank(min);

export const ownerEmails = (env) => new Set(String(env.OWNER_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

/** Top-level project key of a catalog project or registry key ('a/b' → 'a'). */
export const topProject = (p) => String(p ?? '').split('/')[0];

/**
 * Top-level projects every known user may view (MantisBT "View Status: public"): catalog.projects[<top>].visibility
 * === 'public'. Subproject entries never count (they inherit), and the index project and '*' can never be public.
 */
export function publicProjectsOf(catalog) {
  const out = new Set();
  for (const [key, v] of Object.entries(catalog?.projects || {})) {
    if (v && v.visibility === 'public' && !key.includes('/') && key !== INDEX_PROJECT && key !== '*' && !v.parent) out.add(key);
  }
  return out;
}

/**
 * Effective role of a user in a project: 'owner' | 'manager' | 'editor' | 'viewer' | null.
 * user: { owner, roles: { <project>|'*': role } }. The index project needs a membership that names it.
 * pub: optional Set of public top-level projects (publicProjectsOf): without a membership they give 'viewer'.
 */
export function roleIn(user, project, pub = null) {
  if (!user) return null;
  if (user.owner) return 'owner';
  const p = topProject(project);
  const mine = rank(own(user.roles, p)) ? own(user.roles, p) : null;
  const all = p !== INDEX_PROJECT && rank(own(user.roles, '*')) ? own(user.roles, '*') : null;
  const role = rank(mine) >= rank(all) ? mine : all;
  if (role) return role;
  return pub && p !== INDEX_PROJECT && p !== '*' && pub.has(p) ? 'viewer' : null;
}

export const canSee = (user, project, pub = null) => roleIn(user, project, pub) !== null;
// editing, the vault and member management always need a membership: public visibility never grants more than viewer
export const canEdit = (user, project) => atLeast(roleIn(user, project), 'editor');
export const canManage = (user, project) => atLeast(roleIn(user, project), 'manager');

/** Managers may manage rows of projects they manage; only owners grant '*'. */
export const canManageRow = (user, project) => (project === '*' ? !!user.owner : canManage(user, project));
