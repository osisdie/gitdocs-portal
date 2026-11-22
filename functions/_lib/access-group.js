// Optional sync of user emails into a Cloudflare Access group's include rules.
// Enabled only when ACCESS_GROUP_ID + CF_API_TOKEN + CF_ACCOUNT_ID are set. Returns a warning string or null:
// D1 stays the source of truth, a failed sync must never undo the D1 change.
// Full-set sync: every call writes the complete list of email rules computed from D1 (enabled users with at least one
// membership, plus OWNER_EMAILS), so whichever request writes last leaves the group correct; concurrent deltas cannot
// lose each other's update. The group must be dedicated to this app: email rules not in that list are dropped.
// Non-email rules (groups, IdP, etc.) are kept as they are.
import { ownerEmails } from './roles.js';

const API = 'https://api.cloudflare.com/client/v4';

export const groupSyncEnabled = (env) => !!(env.ACCESS_GROUP_ID && env.CF_API_TOKEN && env.CF_ACCOUNT_ID);

const ruleEmail = (rule) => (rule && rule.email && typeof rule.email.email === 'string' ? rule.email.email.toLowerCase() : null);

/** Sorted emails that should be in the group according to D1 and OWNER_EMAILS. */
export async function desiredEmails(env, db) {
  const { results } = await db.prepare(`SELECT u.email FROM users u WHERE u.disabled = 0
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.email = u.email)`).all();
  return [...new Set([...results.map((r) => r.email.toLowerCase()), ...ownerEmails(env)])].sort();
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const ROUNDS = 3;

export async function syncAccessGroup(env, db, fetchFn = fetch) {
  if (!groupSyncEnabled(env)) return null;
  const url = `${API}/accounts/${env.CF_ACCOUNT_ID}/access/groups/${env.ACCESS_GROUP_ID}`;
  const headers = { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' };
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const got = await fetchFn(url, { headers });
      const body = await got.json().catch(() => ({}));
      if (!got.ok || !body.success) throw new Error(`GET ${got.status} ${apiErrors(body)}`);
      const group = body.result;
      const include = group.include || [];
      // read D1 after the GET, so the list is at least as new as the group we are about to overwrite
      const emails = await desiredEmails(env, db);
      if (sameList(include.map(ruleEmail).filter(Boolean).sort(), emails)) return null;
      const next = [...include.filter((r) => ruleEmail(r) === null), ...emails.map((email) => ({ email: { email } }))];
      if (!next.length) return 'Access group sync skipped: the group would be left empty';
      const put = await fetchFn(url, {
        method: 'PUT', headers,
        body: JSON.stringify({ name: group.name, include: next, exclude: group.exclude || [], require: group.require || [] }),
      });
      const putBody = await put.json().catch(() => ({}));
      if (!put.ok || !putBody.success) throw new Error(`PUT ${put.status} ${apiErrors(putBody)}`);
      // D1 changed while this PUT was in flight: our list may have overwritten a newer one, so sync again
      if (sameList(await desiredEmails(env, db), emails)) return null;
    }
    return 'Access group sync: users kept changing during the sync; the group may lag until the next change';
  } catch (e) {
    return `Access group sync failed: ${e.message}`;
  }
}

const apiErrors = (b) => (b.errors || []).map((e) => e.message).join('; ');
