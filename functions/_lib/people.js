// Display names instead of emails (MantisBT "show realname"; DESIGN.md → People and display names).
//
// A caller may learn the name of an email only when there is a relation: the email is referenced by a doc the caller
// can see (reporter / assignee / reviewer in the catalog or doc_state, note authors, history actors), or the person is
// an enabled user with a membership in a project the caller can see (owners and '*' members count as members of every
// project they cover). Two tenants that share nothing — or only see the same public project without being members of
// it — never discover each other's people.
import { canSee, ownerEmails, INDEX_PROJECT, topProject } from './roles.js';
import { publicOf } from './assets.js';

export const NAME_MAX = 80;
// Unicode Cc (control), Cf (format: bidi overrides / isolates, U+061C, zero-width U+200B–U+200F, U+FEFF …), Zl, Zp:
// a name must not reorder or hide the text around it, nor break lines
const BAD_NAME_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// something@domain.tld anywhere: a name must not pass for (another person's) email address
const EMAIL_LIKE_RE = /[^\s@]@[^\s@]+\.[^\s@]/;
// characters that render as nothing although they are letters / marks / symbols: combining grapheme joiner, Hangul
// fillers, Khmer inherent vowels, braille blank, Mongolian vowel separator
const FILLER_RE = /[\u034f\u115f\u1160\u17b4\u17b5\u180e\u2800\u3164\uffa0]/u;
// a name needs something visible to read: a letter, digit or symbol (a run of combining marks is not)
const VISIBLE_RE = /[\p{L}\p{N}\p{S}]/u;
// simple confusable guard: Latin, Cyrillic and Greek letters look alike, so one name uses at most one of them
const LOOKALIKE_SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u];

export const localPart = (email) => String(email ?? '').split('@')[0];
const domainOf = (email) => String(email ?? '').split('@')[1] || '';

/** Comparison key of a display name: compatibility-normalised, case-folded, inner whitespace collapsed. */
export const nameKey = (n) => String(n ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The one display-name validator (PATCH /api/me, POST /api/users, PATCH /api/users): trimmed, NFC, at most NAME_MAX
 * characters, no Cc / Cf / Zl / Zp characters, not email-like, no blank fillers, something visible (not only
 * combining marks, not starting with one), not mixing Latin / Cyrillic / Greek letters. Returns { name } ('' means "clear": the UI then shows
 * the local part) or { error }.
 */
export function checkName(v) {
  if (typeof v !== 'string') return { error: 'name must be a string' };
  const name = v.trim().normalize('NFC').trim();
  if ([...name].length > NAME_MAX) return { error: `name must be at most ${NAME_MAX} characters` };
  if (BAD_NAME_RE.test(name)) return { error: 'name must not contain control, invisible or text-direction characters' };
  if (EMAIL_LIKE_RE.test(name)) return { error: 'name must not look like an email address' };
  if (name && (FILLER_RE.test(name) || !VISIBLE_RE.test(name) || /^\p{M}/u.test(name))) {
    return { error: 'name must not contain blank filler characters or consist of combining marks only' };
  }
  if (LOOKALIKE_SCRIPTS.filter((re) => re.test(name)).length > 1) return { error: 'name must not mix Latin, Cyrillic and Greek letters' };
  return { name };
}

/**
 * Whether `name` would read the same as another enabled user's display name (their name, or their email's local
 * part when they have none; owners from OWNER_EMAILS included). `email` is the user being named.
 */
export async function nameTaken(db, env, name, email) {
  if (!name) return false;
  const key = nameKey(name);
  const { results } = await db.prepare('SELECT email, name FROM users WHERE disabled = 0').all();
  const shown = new Map(results.map((r) => [r.email, r.name || localPart(r.email)]));
  for (const o of ownerEmails(env)) if (!shown.has(o)) shown.set(o, localPart(o));
  shown.delete(String(email).toLowerCase());
  return [...shown.values()].some((n) => nameKey(n) === key);
}

/** { email: users.name } for every D1 user with a name, and every stored email. */
async function storedNames(db) {
  const { results } = await db.prepare('SELECT email, name FROM users').all();
  return { names: new Map(results.filter((r) => r.name).map((r) => [r.email, r.name])), all: results.map((r) => r.email) };
}

/**
 * Display names: users.name, else the local part. A name that reads the same as another person's within `among`
 * (the caller's visible people; every stored user when omitted) gets ' (domain)' appended — ' (email)' when the
 * domains are the same too — so two people never look alike (names stored before the uniqueness check).
 */
export async function namesFor(db, among = null) {
  const { names, all } = await storedNames(db);
  const raw = (e) => names.get(e) || localPart(e);
  const byKey = new Map();
  for (const e of among ? [...among] : all) {
    const k = nameKey(raw(e));
    byKey.set(k, [...(byKey.get(k) || []), e]);
  }
  return (e) => {
    if (!e) return null;
    const email = String(e).toLowerCase();
    const n = raw(email);
    const others = (byKey.get(nameKey(n)) || []).filter((x) => x !== email);
    if (!others.length) return n;
    return `${n} (${others.some((x) => domainOf(x) === domainOf(email)) ? email : domainOf(email)})`;
  };
}

const PEOPLE_FIELDS = ['reporter', 'assignee', 'reviewer'];
const isEmail = (v) => typeof v === 'string' && v.includes('@');

/** The set of emails a caller may see a name for (see the header). */
export async function visiblePeople(db, env, user, catalog) {
  const pub = publicOf(catalog);
  const docs = catalog.docs.filter((d) => canSee(user, d.project, pub));
  const paths = new Set(docs.map((d) => d.path));
  const out = new Set([user.email]);
  for (const d of docs) for (const k of PEOPLE_FIELDS) if (isEmail(d[k])) out.add(d[k].toLowerCase());

  // references in D1: workflow overrides, note authors, history actors of visible docs
  const state = (await db.prepare('SELECT path, assignee, reviewer, updated_by FROM doc_state').all()).results;
  for (const r of state) if (paths.has(r.path)) for (const e of [r.assignee, r.reviewer, r.updated_by]) if (isEmail(e)) out.add(e);
  const authors = (await db.prepare('SELECT DISTINCT path, author FROM notes').all()).results;
  for (const r of authors) if (paths.has(r.path)) out.add(r.author);
  const actors = (await db.prepare('SELECT DISTINCT path, actor FROM history WHERE path IS NOT NULL').all()).results;
  for (const r of actors) if (paths.has(r.path)) out.add(r.actor);

  // members of projects the caller can see
  const seen = new Set([...Object.keys(catalog.projects || {}).map(topProject), ...catalog.docs.map((d) => topProject(d.project))]
    .filter((p) => canSee(user, p, pub)));
  const seesNonIndex = [...seen].some((p) => p !== INDEX_PROJECT);
  const owners = ownerEmails(env);
  const enabled = (await db.prepare('SELECT email FROM users WHERE disabled = 0').all()).results.map((r) => r.email);
  const members = (await db.prepare('SELECT email, project FROM memberships').all()).results;
  const enabledSet = new Set(enabled);
  if (user.owner) for (const e of enabled) out.add(e);
  if (seen.size) for (const o of owners) out.add(o); // owners can see every project
  for (const m of members) {
    if (!enabledSet.has(m.email)) continue;
    if (m.project === '*' ? seesNonIndex : seen.has(m.project)) out.add(m.email);
  }
  return out;
}

/** { email: display name } for GET /api/state. */
export async function peopleMap(db, env, user, catalog) {
  const emails = await visiblePeople(db, env, user, catalog);
  const name = await namesFor(db, emails);
  return Object.fromEntries([...emails].sort().map((e) => [e, name(e)]));
}
