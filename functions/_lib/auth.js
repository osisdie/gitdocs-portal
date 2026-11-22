// Identity: Access JWT → email → D1 user + memberships (DESIGN.md → Identity).
import { verifyAccessJwt } from './jwt.js';
import { ownerEmails } from './roles.js';
import { normEmail } from './http.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Email of the caller, or { error, status }.
 * DEV_USER_EMAIL is honoured only without a JWT and only on a local host name, so a stray production variable
 * cannot open the site. (`request.cf` is no signal: `wrangler pages dev` fills it in locally too.)
 */
export async function callerEmail(request, env, deps = {}) {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (token) {
    try {
      const payload = await verifyAccessJwt(token, { teamDomain: env.TEAM_DOMAIN, aud: env.ACCESS_AUD, fetch: deps.fetch, now: deps.now?.() });
      const email = normEmail(payload.email);
      return email ? { email } : { error: 'token has no email (service tokens are not users)', status: 403 };
    } catch (e) {
      return { error: `invalid access token: ${e.message}`, status: 403 };
    }
  }
  if (env.DEV_USER_EMAIL && LOCAL_HOSTS.has(new URL(request.url).hostname)) return { email: normEmail(env.DEV_USER_EMAIL) };
  return { error: 'missing access token', status: 403 };
}

/** { email, name, owner, disabled, roles } or null when the email is neither an owner nor an enabled user. */
export async function loadUser(db, env, email) {
  const owner = ownerEmails(env).has(email);
  const row = await db.prepare('SELECT email, name, disabled FROM users WHERE email = ?').bind(email).first();
  if (!owner && (!row || row.disabled)) return null;
  const { results } = await db.prepare('SELECT project, role FROM memberships WHERE email = ?').bind(email).all();
  const roles = Object.fromEntries(results.map((r) => [r.project, r.role]));
  return { email, name: row?.name || '', owner, roles, known: !!row };
}
