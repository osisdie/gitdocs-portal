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
 * Effective role of a user in a project: 'owner' | 'manager' | 'editor' | 'viewer' | null.
 * user: { owner, roles: { <project>|'*': role } }. The index project needs a membership that names it.
 */
export function roleIn(user, project) {
  if (!user) return null;
  if (user.owner) return 'owner';
  const p = topProject(project);
  const mine = rank(own(user.roles, p)) ? own(user.roles, p) : null;
  const all = p !== INDEX_PROJECT && rank(own(user.roles, '*')) ? own(user.roles, '*') : null;
  return rank(mine) >= rank(all) ? mine : all;
}

export const canSee = (user, project) => roleIn(user, project) !== null;
export const canEdit = (user, project) => atLeast(roleIn(user, project), 'editor');
export const canManage = (user, project) => atLeast(roleIn(user, project), 'manager');

/** Managers may manage rows of projects they manage; only owners grant '*'. */
export const canManageRow = (user, project) => (project === '*' ? !!user.owner : canManage(user, project));
