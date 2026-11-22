# Design: home page, workflow, multi-user, server vault

Status: accepted 2026-11-22. This is the contract the UI (`site/`) and the server (`functions/`, `migrations/`,
`scripts/`) are built against. Change it here first.

## Contents

- [Modes](#modes)
- [Workflow](#workflow)
- [Roles and permissions](#roles-and-permissions)
- [Project visibility](#project-visibility)
- [External content sources](#external-content-sources)
- [Identity](#identity)
- [People and display names](#people-and-display-names)
- [D1 schema](#d1-schema)
- [HTTP API](#http-api)
- [Access control on static files](#access-control-on-static-files)
- [Server vault](#server-vault)
- [Tenant vaults](#tenant-vaults)
- [Confidential documents](#confidential-documents)
- [Home page](#home-page)
- [Document page](#document-page)
- [Saved filters and CSV export](#saved-filters-and-csv-export)
- [Profile menu, theme, PWA, RWD](#profile-menu-theme-pwa-rwd)
- [Admin page](#admin-page)
- [i18n](#i18n)
- [State back to git](#state-back-to-git)
- [Configuration](#configuration)

## Modes

| | static mode | server mode |
|---|---|---|
| Hosting | any static host | Cloudflare Pages + Functions + D1, behind Cloudflare Access |
| Detected by | `GET /api/me` → 404 / network error | `GET /api/me` → 200 |
| Users | one (whoever passes the auth proxy) | many, per-project roles |
| Workflow edits | CLI + commit | web (D1), synced back to git by CLI |
| Vault | passphrase, decrypted in the browser | role-based, decrypted by the server, audited |
| Preferences | `localStorage` | D1 per user (`localStorage` fallback) |

Everything in static mode keeps working unchanged; server mode is additive.

## Workflow

Statuses (Mantis-style), stored in `catalog.json` → `docs[path].status` and overridden by D1 `doc_state` in server mode:

| Status | Meaning | Mantis analogue |
|---|---|---|
| `待處理` | new, needs work | new / assigned |
| `待確認` | waiting for review / sign-off | feedback / resolved |
| `已確認` | reviewed, final | confirmed |
| `已發布` | published / shared | closed (published) |
| `封存` | archived / superseded | closed |

Migration of old values (applied by `syncCatalog`, idempotent): `草稿 → 待處理`, `審查中 → 待確認`, `本機 → 已確認`.
New files default to `待處理`, or `已發布` when they carry an origin URL.

People fields on a doc (emails; optional): `reporter` (who added it; default: first git author email),
`assignee` (who must act), `reviewer` (who must confirm). `pending for X` means
`(status = 待處理 and assignee = X) or (status = 待確認 and reviewer = X)`.

## Roles and permissions

`owner` is global (set by `OWNER_EMAILS`, cannot be removed from the UI). Everything else is per project
(`project` = top-level project key, e.g. `handbook`; membership of a project covers its subprojects).
A membership with project `*` applies to every project.

| Capability | viewer | editor | manager | owner |
|---|:-:|:-:|:-:|:-:|
| see project docs, search, catalog | ✓ | ✓ | ✓ | ✓ |
| add notes | ✓ | ✓ | ✓ | ✓ |
| change status / assignee / reviewer / tags | | ✓ | ✓ | ✓ |
| reveal / copy vault fields | | ✓ | ✓ | ✓ |
| read `機密`+ document bodies ([Confidential documents](#confidential-documents)) | | ✓ | ✓ | ✓ |
| list the project's vault names | | ✓ | ✓ | ✓ |
| add / replace / delete / reveal the project's vault secrets on the vault page ([Tenant vaults](#tenant-vaults)) | | | ✓ | ✓ |
| manage members of the project (invite, change role, remove) | | | ✓ | ✓ |
| create / disable users, global settings, all projects | | | | ✓ |
| docs in index project `（索引）` | owner-only unless a membership names it |

Sensitivity still applies on top: `機密` bodies are never in the search index; `極機密` files are never deployed.
A **public** project (next section) makes every known user a viewer of it; it never grants more than viewer.

## Project visibility

MantisBT's "View Status". `catalog.json → projects[<top-level key>].visibility` is `private` (default; the key is
omitted) or `public`. Set it with `npm run doc -- project <name> visibility=public|private` (top-level projects
only; the CLI refuses subprojects and `（索引）`).

- A public project is visible to **every known user** (an owner or an enabled D1 user, even one without any
  membership) with the **viewer** role: its docs, catalog entries, search rows, saved filters, notes (read + add) and
  history. Status / assignee / reviewer / tags, the vault and member management still need a membership
  (`canEdit` / `canManage` ignore visibility).
- Subprojects inherit the top-level value; a `visibility` on a subproject entry is ignored. `（索引）` and `*` can
  never be public, whatever the catalog says (`publicProjectsOf` in `functions/_lib/roles.js`).
- The server reads visibility from the **deployed** `catalog.json` (host repo; a mounted source cannot change it).
  The build emits the effective `visibility` on every `projects` entry, subprojects included, so the UI need not
  compute inheritance. `GET /api/me` adds `publicProjects: [<top-level key>, …]`.
- Static mode and share builds are unaffected (static mode has one audience anyway).
- With the Access group sync, the group only contains users that have at least one membership (plus owners), so a
  user with no membership cannot pass Access unless another Access rule lets them in. Normally the other
  organisation's people are members of their own project and see public projects on top of it.

## External content sources

Another organisation keeps its documents in **its own git repo** (it can push there; it cannot touch the host repo)
and the portal shows them as one top-level project.

```json
"site": { "sources": [{ "name": "acme", "repo": "https://git.example.com/acme/docs.git", "ref": "main", "path": "docs" }] }
```

| Field | Rule |
|---|---|
| `name` | mount = project key, `[a-z0-9][a-z0-9-]*` (≤ 63), unique, not `notes` or `previous` (nor any name whose `VAULT_KEY_<NAME>` is a deployment setting: `VAULT_KEY_PREVIOUS` is the web vault key before a rekey); must not collide with a local `docs/<projectRoot>/<name>` (the scan refuses) |
| `repo` | `https://`, `ssh://`, `git@host:path`, `file://` or an absolute path; overridden by the env / CI variable `SOURCE_<NAME>_URL` (`-` → `_`), which is where credentials go — in the userinfo (`https://deploy-token:<token>@host/…`) or a git credential helper; a URL with a query string or fragment is refused (`sources:pull` masks userinfo, query strings and fragments in everything it prints). No credentials in `catalog.json` |
| `ref` | branch, tag or commit (default `main`) |
| `path` | folder inside the source repo (default: repo root); relative, no `..`, no dot-folders |
| `depth` | optional: shallow fetch of N commits (per-file history then stops there) |

- **Pull**: `npm run sources:pull [-- <name>…]` (`scripts/sources.mjs`) fetches the ref with its history (one ref,
  no tags; `execFileSync`, no shell) into `<content>/.sources/<name>/` and checks it out detached. The URL goes on the
  command line only — no remote in `.git/config`, no `FETCH_HEAD`, no reflog — and printed git errors have URL
  credentials masked. `.sources/` is gitignored in the engine; **content repos must ignore it too** (the command
  warns when they do not). A failed pull exits 1, so CI never deploys without a source.
- **Mount**: the scan treats `.sources/<name>/<path>/…` as `docs/<projectRoot>/<name>/…`: catalog keys, paths and
  URLs look local (`docs/acme/guide.md`), subfolders become subprojects, ids and metadata live in the host
  `catalog.json`, per-file history and reporter come from the source repo. Records carry `source: "<name>"`; the
  dist registry entry of the mount carries `source` too. `site.sources` itself is not deployed.
- **Build**: mounted files are copied to `dist/docs/<projectRoot>/<name>/` with the local rules (`極機密` never
  deployed, `hidden` / `--max-sensitivity` dropped, non-doc assets copied like local ones).
- **Missing checkout rule**: when `.sources/<name>` is not a checkout or its `path` folder is missing, the build
  warns and its catalog entries are **kept but not deployed** (ids, workflow state and hand-edited metadata survive a
  CI job without credentials or a transient failure). Entries are deleted only when a checkout is present and the file
  is gone from it. Removing a source from `site.sources` deletes its entries on the next build like deleted files.
- **Security** — a source writer controls file contents only:
  1. *No escape*: symlinks are never followed or copied (files and folders), dot-entries (`.git`, `.gitlab-ci.yml`,
     …) and names with control characters, `\`, `%` or `:` are skipped, the mount root must be a real folder inside
     the checkout (no symlink on the way, `realpath` checked), `path` / `name` are validated in the host config.
  2. *Vault namespace*: a doc from source `X` may only reference `{{vault:X/…}}`. The build drops other names from
     the record (`vault`), adds `vaultBlocked: <count>`, rewrites them to `{{vault-blocked}}` in the deployed file and
     the search text, and warns. `POST /api/vault/reveal` refuses a name outside `X/` for a doc whose record (or
     project registry entry) has `source: X` — even for owners (defence in depth). The secrets themselves live in the
     host's `vault/vault.json`, sealed by the host.
  3. *No metadata control*: ids, status, sensitivity overrides, visibility and memberships are in the host repo / D1.
  4. *No script on the portal origin*: mounted docs are served from `/docs/*` like local ones (sandbox CSP, nosniff).
  5. Sensitivity detection runs on source files; `npm run vault -- check` / `scan` read mounted files and report
     their problems as **warnings** (a source writer must not be able to fail the host's pipeline; the build already
     keeps them safe); `scan --fix`, `mv` and `postman` never modify files under `.sources/`.
- **Redeploy on push**: the source repo's CI triggers the host pipeline (GitLab pipeline trigger token; GitHub
  `repository_dispatch`) — see `templates/gitlab-ci.yml` / `templates/github-actions.yml`.
- Not supported: submodules and Git LFS content inside a source.

## Identity

- Cloudflare Access sits in front of everything and sends `Cf-Access-Jwt-Assertion`.
- The middleware verifies the JWT (RS256) against `https://<TEAM_DOMAIN>/cdn-cgi/access/certs` (cache the JWKS
  ~10 min), checks `aud` = `ACCESS_AUD` and `exp`, and uses the `email` claim (lower-cased).
- Unknown or disabled email → 403 "尚未開通，請聯絡管理員" (JSON for `/api/*`; for navigations a small HTML page,
  English first, then 繁體中文 — all middleware error pages are bilingual).
- Local development: if `DEV_USER_EMAIL` is set and the request has no JWT, use it (never in production: it is
  honoured only when the request host is `localhost` / `127.0.0.1` / `[::1]`, and an invalid JWT never falls back).
- No D1 binding (`env.DB` missing) → the middleware passes everything through and `/api/*` returns 404 (static mode),
  so content repos that vendor `functions/` but do not use server mode keep working. If any of `ACCESS_AUD`,
  `TEAM_DOMAIN`, `OWNER_EMAILS` is set without the binding, the deployment is misconfigured: every request gets
  503 "server mode misconfigured" (HTML for navigations, JSON for `/api/*`) instead of an unfiltered static site.

## People and display names

MantisBT's "show realname": the UI shows names, not emails (emails only in the admin users table).

- Name of an email = `users.name`, else its local part. Users set their own with `PATCH /api/me { name }`; managers
  and owners through `POST` / `PATCH /api/users`. One validator (`checkName`) for all three: trimmed, NFC, ≤ 80
  characters, no Unicode `Cc` / `Cf` (bidi overrides and isolates, U+061C, zero-width U+200B–U+200F, U+FEFF, …) /
  `Zl` / `Zp` characters, not email-like (`x@host.tld` anywhere), no blank fillers (U+034F, U+115F, U+1160, U+17B4,
  U+17B5, U+180E, U+2800, U+3164, U+FFA0), at least one letter / digit / symbol and not starting with a combining mark,
  and not mixing Latin, Cyrillic and Greek letters (a simple confusable guard); `''` clears it. **Unique**: a name whose NFKC +
  case-folded form equals another enabled user's display name (their name, or their local part when they have none;
  `OWNER_EMAILS` included) → 409. Names stored before that rule that still collide are told apart wherever names are
  served (`people`, `author_name`, `actor_name`, `updated_by_name`): ` (domain)` is appended, ` (email)` when the
  domains are the same too, computed among the people the caller can see. An owner listed only in `OWNER_EMAILS`
  gets a `users` row (no memberships) on the first save. Static mode: `catalog.json → site.people { email: name }` is
  passed through by the build (lower-cased keys, ≤ 80 characters; share builds drop it).
- **Who may learn a name** (`functions/_lib/people.js` → `visiblePeople`): the caller; every email referenced by a doc
  the caller can see (catalog `reporter` / `assignee` / `reviewer`, `doc_state` `assignee` / `reviewer` /
  `updated_by`, note authors, history actors of that doc); and enabled users with a **membership** in a project the
  caller can see (a `*` membership covers every non-index project; owners cover every project; owners see everyone).
  Seeing the same public project without being a member of it is not a relation, so two tenants never discover each
  other's people unless one of them writes on a doc the other can see.
- Server mode rewrites `site.people` in `/catalog.json` to that same set. `GET /api/state` returns it as
  `people: { email: name }`; note rows carry `author_name`, history and audit rows `actor_name`.

## D1 schema

```sql
users        (email TEXT PRIMARY KEY, name TEXT, disabled INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL, created_by TEXT)
memberships  (email TEXT NOT NULL, project TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('viewer','editor','manager')),
              PRIMARY KEY (email, project))
doc_state    (path TEXT PRIMARY KEY, status TEXT, assignee TEXT, reviewer TEXT, tags TEXT /* JSON array or NULL */,
              updated_by TEXT NOT NULL, updated_at TEXT NOT NULL)
notes        (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL,
              created_at TEXT NOT NULL)
history      (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, actor TEXT NOT NULL, action TEXT NOT NULL,
              field TEXT, old TEXT, new TEXT, at TEXT NOT NULL)      -- doc edits, notes, membership changes, logins
vault_audit  (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, name TEXT NOT NULL, path TEXT /* NULL: vault page */,
              action TEXT NOT NULL /* show|copy */, at TEXT NOT NULL)
prefs        (email TEXT PRIMARY KEY, json TEXT NOT NULL)
synced       (path TEXT PRIMARY KEY, at TEXT NOT NULL)               -- last doc_state row exported to git
-- 0002_vault.sql (DESIGN.md → Tenant vaults)
vault_secrets  (name TEXT PRIMARY KEY, iv TEXT NOT NULL, ct TEXT NOT NULL, note TEXT, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL)
vault_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, iv TEXT, ct TEXT, note TEXT,
                action TEXT NOT NULL /* create|update|delete */, actor TEXT NOT NULL, at TEXT NOT NULL)   -- append-only
-- 0003_filters.sql (DESIGN.md → Saved filters and CSV export)
shared_filters (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL /* top-level */, name TEXT NOT NULL,
                params TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (project, name))
```

Migrations live in `migrations/NNNN_*.sql` (wrangler D1 migrations format): `0001_init`, `0002_vault`,
`0003_filters`. `npm run deploy` (scripts/deploy.sh) applies pending ones before the new functions go live; tests
apply every file in order. Timestamps are ISO-8601 UTC.

## HTTP API

All JSON. Errors: `{ "error": "<message>" }` with 400 / 403 / 404 / 409. Every mutating call writes `history`.
CSRF: every non-GET/HEAD `/api` request needs `Content-Type: application/json` (parameters allowed) and either
`Sec-Fetch-Site: same-origin` or an `Origin` equal to the request origin, else 403. Bodies are capped per route
(Content-Length checked before reading; chunked bodies cut off while reading).

| Method & path | Who | Body / result |
|---|---|---|
| `GET /api/me` | any user | `{ email, name, owner, roles: { "<project>": "viewer"\|"editor"\|"manager", "*"?: … }, publicProjects: ["<project>", …], prefs }` — `roles` are memberships only; public projects add viewer access on top |
| `PATCH /api/me` | any user | body `{ name }` (see [People](#people-and-display-names)) → `{ email, name }`; writes history `user.update` |
| `PUT /api/me/prefs` | any user | body: prefs object (≤ 8 KB) → `{ ok: true }` |
| `GET /api/state` | any user | `{ docs: { "<path>": { status, assignee, reviewer, tags, updated_by, updated_at, notes: <count> } } }` — only visible projects; docs that only have notes carry their catalog values and `updated_at: null`; plus `people: { "<email>": "<name>" }` scoped as in [People](#people-and-display-names) |
| `PATCH /api/docs/:id` | editor+ of the doc's project | body: any of `{ status, assignee, reviewer, tags }` (`''` or `null` clears a person; stored as `''` = explicitly nobody) → `{ id, path, …state }`; the first edit copies the catalog values into the `doc_state` row, so a row is always the full state |
| `GET /api/docs/:id/notes` | can see doc | `[{ id, author, author_name, body, created_at }]` |
| `POST /api/docs/:id/notes` | can see doc | body `{ body }` (≤ 4000 chars) → created note |
| `GET /api/docs/:id/history` | can see doc | `[{ actor, actor_name, action, field, old, new, at }]` |
| `POST /api/vault/reveal` | editor+ of the doc's project (page form: manager+ of the namespace) | body `{ id, name, action: "show"\|"copy" }`; `name` must be referenced by that doc, and start with `<source>/` when the doc comes from an external source → `{ value, origin }`; audited. Without `id`: the vault-page form, see [Tenant vaults](#tenant-vaults) |
| `GET` / `PUT /api/vault/secrets`, `DELETE /api/vault/secrets/<name>` | editor+ / manager+ of the namespace | see [Tenant vaults](#tenant-vaults) |
| `GET /api/users` | manager+ | owner: all users with memberships; manager: users in projects they manage |
| `POST /api/users` | manager+ | body `{ email, name?, memberships: [{ project, role }] }` — managers only for their projects, only owners grant `*`; adds the email to the Access group; an existing account gets the rows merged. Owner → 201 `{ user }` (new) / 200 `{ user, existing: true }`. **Manager → always 201 `{ user: { email, memberships } }`** (their own rows only), so an invite never tells whether the account existed; a given name is applied only to an account without one |
| `PATCH /api/users/:email` | manager+ / owner | body `{ name?, disabled? (owner only), memberships? }` — `memberships` is the desired set within the caller's reach: listed rows are upserted (`role: null` removes), rows the caller manages but did not list are removed, rows of other projects are untouched (managers: only rows for their projects) → `{ user }`. A manager gets the same 404 for a user without a membership they manage (owners included) as for a missing one; to add such a user, invite them |
| `DELETE /api/users/:email` | owner | disables the user and removes the email from the Access group (a `PATCH` that removes a user's last membership also removes them from the group; adding one back re-adds them) |
| `GET /api/filters[?project=]` | can view the project | project-shared saved filters of one project (a subproject means its top level; 404 for a project the caller cannot view or that does not exist) or, without `project`, of every project the caller can view (owners: all rows) → `[{ id, project, name, params, created_at, created_by_name, mine, canDelete }]`; never the creator's email |
| `POST /api/filters` | manager+ of the project / owner | body `{ project, name, params }` (≤ 4 KB; name 1–60 chars; params ≤ 1000 chars, scoped with `p=<project[/sub]>`, may not name another project in `q`, no `page`) → 201 new / 200 replaced (same project + name); ≤ 100 per project; history `filter.create` / `filter.update` |
| `DELETE /api/filters/:id` | manager+ of the filter's project / owner | → `{ ok: true }`; history `filter.delete`; 404 when the caller cannot view the project |
| `GET /api/audit?limit=` | owner | `{ history: [...], vault: [...] }` — newest first, `limit` ≤ 500 (default 100) |
| `GET /api/export/state?since=` | owner | `{ at, docs: [doc_state rows], notes: [...] }` changed since an ISO time |

Access group sync (optional) is full-set: after any change to users, memberships or `disabled`, the group's email
rules are rewritten to every enabled D1 user with at least one membership plus `OWNER_EMAILS` (non-email rules kept;
D1 is read after the GET and re-read after the PUT, syncing again if it changed meanwhile, at most 3 rounds), so
concurrent edits converge instead of losing updates. It never PUTs an empty include list.
Mutations that can fail half-way outside D1 (Access group sync) keep the D1 change and add `"warning": "<message>"` to
the response. A user object is `{ email, name, disabled, owner, created_at, created_by, last_seen, memberships: [{ project, role }] }`
(`last_seen` = latest hourly `login` history row; managers see only memberships of projects they manage, `created_at` /
`created_by` only when the creator is someone they can see ([People](#people-and-display-names)), and `last_seen`
only for sign-ins since the user first got a membership they manage — nothing about the account from another tenant).

`:id` is the catalog id; the server resolves id → path → project from the deployed `catalog.json` (read through
`env.ASSETS`).

## Access control on static files

`functions/_middleware.js` runs for every request. Every rule is evaluated on the **normalised** path: the URL path is
decoded once (as the Pages asset server does before its lookup; a malformed escape → 400), repeated slashes are
collapsed, and a path that still contains `%`, a backslash, a control character, or a `.` / `..` segment → 404.
Allowed requests are forwarded with the path re-encoded canonically, so the file served is the file checked.
The rules are **default-deny**:

| Path | Rule |
|---|---|
| `SHELL_FILES` in `functions/_lib/gate.js`: `/`, `/index.html`, `/app.js`, `/app.css`, `/query.js`, `/model.js`, `/api.js`, `/admin.js`, `/graph.js`, `/graph.css`, `/vault.js`, `/vault-core.js`, `/vault-frame.js`, `/sw.js`, `/manifest.webmanifest`, `/robots.txt`, `/i18n.js`, `/filters.js`, `/liststate.js`, `/icons/<file>`, `/i18n/<file>` | any known user (`/` and `/index.html` also get the shell CSP) |
| `/catalog.json` | rewritten: `site.people` trimmed to the caller's visible people; only docs in visible projects (memberships + public projects); `projects` and `filters` trimmed accordingly; `related` / `supersedes` links to invisible docs removed; adds `"server": true` |
| `/search-index.json` | rewritten: only rows whose doc is visible |
| `/docs/<path>` (also the extensionless and `…/index.html` forms) | 403 unless **every** file the Pages asset server could answer the URL with is readable: `/x/` → `x/index.html`; `/x/index` → itself; otherwise `x`, then `x.html` (wrangler `generateHandler`, auto-trailing-slash; forms that only redirect come back through the gate). A doc is readable when its project is visible, and for `機密`+ docs when editor+ ([Confidential documents](#confidential-documents)); unknown files under `/docs/` → owner only, including an extensionless `x` that would be served ahead of doc `x.html` (the gate asks the asset server: `/x.html` is served only when such a file exists, otherwise it redirects to `/x`) and a file at the path of an `offline` doc; the middleware sets `Content-Security-Policy: sandbox …`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-cache` itself (`_headers` rules match the raw path and are only a static-mode fallback) |
| `/vault.json`, `/_vaults/*` | 404 in server mode (the server vault replaces them) |
| `/api/*` | handled by the API (the raw path must start with `/api/` too) |
| anything else | 404 — a file the build adds to `site/` stays unreachable until it is added to `SHELL_FILES`; `test/server.test.mjs` fails while the list and `site/` differ |

Paths are case-sensitive (as on Pages): `/Docs/…`, `/VAULT.json` match nothing and fall into "anything else".

The `/docs/` rule models the **Cloudflare Pages** asset server (wrangler `generateHandler`, its auto-trailing-slash
behaviour: `/x/` → `x/index.html`, `/x.html` → 308 to `/x`, `/x` → `x` then `x.html`). Workers static assets with
another `html_handling` mode (`force-trailing-slash`, `drop-trailing-slash`, `none`) resolve paths differently and
are **not supported**: the gate could authorise one file while another is served. `offline` (極機密, not deployed)
catalog entries are not candidates — a file at such a path is an unknown file (owner only).

Headers (`site/_headers`): the shell CSP `object-src 'none'; base-uri 'self'; frame-ancestors 'none'` is attached
to `/` and `/index.html` only, not `/*`: Pages joins duplicate headers from overlapping rules, which would add a
second policy (with `frame-ancestors 'none'`) to `/docs/*` and block the preview iframe. Remaining risk: `script-src`
is not restricted yet (`index.html` has an inline theme script, `graph.js` imports an ESM module from jsDelivr), so
an XSS in the shell is not contained by CSP; the marked / DOMPurify loads from cdnjs carry SRI hashes, the jsDelivr
import does not.

## Server vault

- Secret `VAULT_KEY` (Pages secret): the raw AES-256 key printed by `npm run vault -- key` (base64; re-set it after
  `vault rekey`). The server imports it once per isolate with the same `site/vault-core.js` and decrypts `vault.json`
  read through `env.ASSETS` (still deployed, never served). Deriving from `VAULT_PASSPHRASE` is a fallback only:
  Workers' WebCrypto rejects PBKDF2 above 100,000 iterations (the vault uses 600,000), and the derivation would cost
  hundreds of ms of CPU per cold start.
- `POST /api/vault/reveal` checks role and that the doc references the name (and, for a doc mounted from source `X`,
  that the name starts with `X/`), writes `vault_audit`, returns the value with `Cache-Control: no-store`.
- UI: in server mode the masked widgets and the HTML-doc dialog call this endpoint instead of asking for a
  passphrase; viewers see the mask with a disabled button ("需要 editor 權限").
- A sandboxed HTML doc's `postMessage` only opens the portal dialog **masked** (secret name + doc title); the
  reveal (server call, or decryption in static mode) happens only when the user clicks 顯示 / 複製 in that dialog.
  While one dialog is open, further requests are ignored.

## Tenant vaults

Each top-level project is a vault **namespace**: secret names start with `<project>/` (`acme/smtp/password`). Names use
`A-Z a-z 0-9 _ . / -` (`NAME_RE`), so a project whose key has other characters (e.g. Chinese) has no namespace;
segments must be non-empty, ≤ 200 characters in all. Secrets can live in three stores, looked up in this order:

| Order | Store (`origin`) | Where | Who writes | Key |
|---|---|---|---|---|
| 1 | `web` | D1 `vault_secrets` | managers of the namespace project in the portal (owners: any top-level project) | `VAULT_KEY` |
| 2 | `git` | a mounted source's own `vault/vault.json` → deployed as `/_vaults/<source>.json` (never served) | the source repo (tenant) | Pages secret `VAULT_KEY_<SOURCE>` (`-` → `_`, upper-case) |
| 3 | `host` | the host's `vault/vault.json` → `/vault.json` (never served in server mode) | the host operator | `VAULT_KEY` |

- Namespace rules apply to every store: a `git` vault only answers names under `<source>/` (others in that file are
  ignored and warned about by the build); a doc mounted from source `X` only reveals `X/…` (any store); the vault page
  only manages / reveals names of projects the caller manages.
- Ciphertext only, everywhere: AES-256-GCM with the name as AAD (same as `site/vault-core.js`). Values never reach
  logs, history, the search index or responses other than a reveal.
- **D1** (migration `0002_vault.sql`): `vault_secrets (name PK, iv, ct, note, updated_by, updated_at)` and the
  append-only `vault_versions (id PK, name, iv, ct, note, action 'create'|'update'|'delete', actor, at)` (a delete
  keeps earlier ciphertexts; purge by hand if a leaked value must go). `vault_audit.path` becomes nullable.
  Web secrets are encrypted with `VAULT_KEY`; after `vault rekey` set the old key as `VAULT_KEY_PREVIOUS` so web
  secrets stay readable (each save re-encrypts with the new key). No `VAULT_KEY` → web vault calls answer 503.
- **Tenant git vault**: the tenant clones gitdocs-portal and runs it against their own repo:
  `CONTENT_DIR=../acme-docs node scripts/vault.mjs init`, `… set acme/smtp/password`, commits
  `acme-docs/vault/vault.json` (own passphrase), and gives the host operator `node scripts/vault.mjs key` once over a
  secure channel → `npx --yes wrangler@4.166.0 pages secret put VAULT_KEY_ACME`. `vault set` warns when a name leaves
  the vault's namespace (from `--namespace=` / `$VAULT_NAMESPACE`, else the first segment all existing names share).
  The file must sit at `vault/vault.json` in the source repo (never a symlink); it is never scanned as a document.
  Share builds and `--no-vault` deploy no vaults; neither does a build that is not for server mode (no
  `[[d1_databases]]` in `wrangler.toml` and no `--server`): only the server keeps `/_vaults/*` private.
- **No silent override**: the web store is looked up first, so a new web row would replace a `git` / `host` secret of
  the same name for every doc. `PUT` of a name that exists in the `git` or `host` store and has no web row → 409 for
  managers (change it in its repo); an owner may override it, recorded as history `vault.override` (old = the stores
  it shadows). Once a web row exists its managers keep it up to date; `DELETE` only ever touches the web store.

API (CSRF rules apply; values only in reveal responses, which are `no-store`):

| Method & path | Who | Body / result |
|---|---|---|
| `GET /api/vault/secrets?project=P` | editor+ of `P` (owner: any) | `[{ name, note, origin, stores: ['web'\|'git'\|'host', …], updated_by, updated_by_name, updated_at }]` for names under `P/`, one row per name (`origin` = the store that answers it; `updated_by` only for `web`, `updated_at` = date for git / host) |
| `PUT /api/vault/secrets` | manager+ of the name's first segment (owner: any); for everyone the segment must be a top-level project of the deployed catalog (400 for an owner otherwise) | `{ name, value, note? }` (value ≤ 16 KB; `note` ≤ 200, kept when omitted) → `{ name, note, origin: 'web', updated_by, updated_at }`, 201 when new; 409 when the name is in the git / host store without a web row (owner: allowed, history `vault.override`); writes `vault_versions` + history `vault.set` (name only) |
| `DELETE /api/vault/secrets/<name>` | same | the name may be `%2F`-encoded or plain (`/api/vault/secrets/acme/key`); removes the web secret only (404 if none) → `{ ok: true }`; version row `delete`, history `vault.delete` |
| `POST /api/vault/reveal` | doc form: editor+ of the doc's project; page form: manager+ of the namespace project (owner: any) | doc form `{ id, name, action }` (doc must reference the name; source rule) · page form `{ name, action }` → `{ value, origin }`; both audited in `vault_audit` (`path` NULL for the page form) |

## Confidential documents

Server mode only (static mode has one audience):

- A doc with sensitivity **`機密` or higher** is readable only by **editor+** of its project (owners included):
  `/docs/*` answers 403 to viewers and public-project visitors. Their catalog record stays (title and metadata) with
  `restricted: true` and without `vault`; the body is never in the search index anyway. Notes and history stay open
  to everyone who can see the doc. `極機密` files are still never deployed.
- **Declared sensitivity** (local and mounted docs): Markdown front matter `sensitivity: 機密` or HTML
  `<meta name="sensitivity" content="機密">`; values are the stored names or `public` / `internal` / `confidential` /
  `secret` (also the query aliases, e.g. `private`). Raise-only: effective = max(catalog, declared, detected) —
  detected is skipped once `sensitivityReviewed` is set, the declaration never is, so a doc is lowered only by removing
  the declaration from the file. The record carries `declaredSensitivity`; an unknown value warns at build time.

## Home page

Route `#/home` is the default when `#` is empty. Sections (each a compact table, newest first, max 10 + "全部"):

1. **指派給我** — status `待處理`, assignee = me
2. **待我確認** — status `待確認`, reviewer = me
3. **待處理（未指派）** — status `待處理`, no assignee
4. **待確認** — all `待確認`
5. **我建立的** — reporter = me, not `封存`
6. **最近更新** — by `updated_at` (server) or date (static)
7. **機敏性待複核** — sensitivity raised automatically and not reviewed (from catalog)

A "關注的專案" selector (multi-select, "全部專案" default) scopes the whole page; stored in prefs
(`prefs.focusProjects: string[]`). In static mode "me" is unknown: sections 1, 2, 5 are hidden.

## Document page

Route `#/doc/<id>`, MantisBT-style with the content as the main thing:

- ≥ 1200 px: two columns. Main = the content (`#d-pv`), then folded `<details>` sections: notes (`#d-notes`, open),
  activity (`#d-audit`), relations (`#d-rel`), git history (`#d-hist`). Sidebar (320 px, sticky) = compact metadata
  (`#d-info`: id, status, sensitivity, project, category, date, people as display names, tags / keywords, origin,
  vault fields, file type / size) and, for editors, the workflow form (`#d-edit`).
- Narrower: content first, then the metadata as a collapsible block (closed), then the rest. The ToC jump buttons
  keep the same anchors and open a folded target.
- Preview: never lazy. HTML in the sandboxed iframe (sandbox attributes unchanged), height
  `max(480px, 100vh − header − 150px)`; Markdown as a sanitized article at full height (no inner scroll); other
  types as escaped text. Toolbar: Preview / Source toggle for `md` and `html` (source = fetched text in an escaped
  `<pre>`), Full screen (CSS overlay over the viewport; Esc or the button exits), Open in new tab.
- `機密` docs show the click-to-reveal gate where the content goes (choosing Preview / Source counts as the click);
  `極機密` docs show the offline banner there.
- External sources: the project page and the doc page show "External source: <name>" (registry / record `source`);
  a record with `vaultBlocked > 0` gets a notice "N vault references outside <name>/ were disabled", and
  `{{vault-blocked}}` in Markdown / text / source views renders as a disabled mask. Public projects
  (`visibility: public`) carry a "Public" badge wherever the project is named (list, home, timeline, switcher, focus
  selector, project page, doc sidebar, admin); without a membership the UI treats the user as viewer there.
- `restricted: true` records (Confidential documents) keep title and metadata; the content area says the content
  needs editor+ and nothing under `/docs/` is fetched or framed.
- Project vault (server mode, [Tenant vaults](#tenant-vaults)): a "Vault" card at the end of `#/project/<P>` for editor+
  of `P` (top-level keys that match `NAME_RE` only); `#/project/<P>?sec=vault` scrolls to it and the admin "Projects"
  table links there. Editors see the list (name, note, origin badge + other stores, updated by name / at); managers+
  add (`P/` pre-filled, password field with show toggle) and replace / delete `web` rows (`git` rows: "managed in the
  source repo", `host` rows: "managed by the operator") and reveal any row through the masked dialog (page form of
  `POST /api/vault/reveal`). A value lives only in the open form (cleared and re-masked on save / cancel) and in the
  dialog (dropped on close).

## Saved filters and CSV export

The list view's saved-filters bar (`site/filters.js`) shows three kinds of filters; a filter is the list's URL query
(`URLSearchParams` string, without `page`), and the chip of the one matching the current list is highlighted
(`aria-current`; a filter saved without a sort matches any sort).

| Kind | Stored in | Who saves / deletes | Seen by |
|---|---|---|---|
| Catalog | `catalog.json` `filters` (`{ name, query }`, in git) | maintainers, by editing the catalog | everyone (server mode: only filters whose `p:` conditions name visible projects) |
| Personal | static: `localStorage['gitdocs:filters']`; server: `prefs.savedFilters` (`PUT /api/me/prefs`) only | the user | the user, on every device in server mode |
| Shared | D1 `shared_filters` (`/api/filters`) | managers of the project, owners | everyone who can view the project; the whole-portal list shows the shared filters of every visible project, labelled with the project |

- Personal limits (the prefs object is capped at 8 KB on the server): ≤ 30 filters, name ≤ 60 characters, params ≤
  1000 characters, and the whole prefs object must still fit; the save dialog says which limit was hit. A name that
  exists already replaces that filter. Older entries beyond the limits stay readable.
- First server-mode load of an account (`prefs.savedFilters` not set yet): this browser's static-mode filters are
  copied into prefs once (server copy first, no duplicate names, invalid entries dropped) and then removed from
  localStorage, so a second identity on the same browser does not inherit them.
- localStorage is shared by every Access identity on a browser and is not keyed by account, so in server mode it only
  mirrors UI-only prefs (`theme`, `lang`, `listPer`): saved filters and focus projects name projects and people of a
  tenant and live in the server copy alone (`site/api.js` `LOCAL_SAFE`).
- Shared filter params may only carry list state (`p`, `q`, `sort`, `per`); `p` must be the filter's project and no
  comma alternative of a `project:` condition in `q` may name another project. A creator the caller may not see
  (removed from the project, another tenant) is listed with `created_by_name: null`.
- Saving opens a dialog (name; for managers of the project in scope also "just me / everyone in <project>"). Sharing
  needs a project in scope, so the stored params are always scoped to it. Results are announced in a polite live region
  and shown in the bar.
- **CSV export** downloads every filtered and sorted row (all pages), with the columns the list shows: RFC 4180, UTF-8
  BOM (Excel opens CJK text correctly), CRLF; fields with `,` `"` CR LF are quoted, inner quotes doubled, and cells
  starting with `=` `+` `-` `@` TAB or CR get a leading `'` (spreadsheet formula injection). Values: padded id, status /
  category / sensitivity as labels in the UI language, people as display names, dates as `YYYY-MM-DD`, project path,
  keywords joined with `; `. The export holds nothing the list does not show: unknown column keys pass through only
  for unrestricted docs and vault fields never appear. Filename `docs-<project|all>-<YYYYMMDD>.csv`.

## Document list: search, filters, sort, paging

- One query language for the search box, the advanced filter panel and `npm run doc -- ls` (`site/query.js`; the
  full syntax is in its header comment and the `?` help). Beyond words / phrases / `-exclude` / fields:
  people `reporter:` (`rep:`), `assignee:` (`asg:`, `a:`), `reviewer:` (`rev:`) take an email, `@domain`, part of a
  display name, `me` or `none`; a comma means any of (`s:open,in-review`, `assignee:me,none`), repeating a field
  means AND; `tag:a,b` = any, `tag:a+b` = all; `created…` / `updated…` take the date operators
  (`created>=-7d`, `updated:this-month`; also `today`, `this-year`). An enum value that names a stored value, slug or
  English label matches exactly, anything else partially. created = `created`, else the oldest of the (≤ 20) listed
  commits, else the doc date; updated = the newer of server `updated_at` and the last commit. The CLI resolves `me`
  from `git config user.email` and reads git history only when the query uses created / updated.
- The **simple search row** is always shown above the panel: a keyword box (the free text of `q=`, the same text as
  the panel's text box; the two mirror each other while typing; applied on Enter only — no re-render on blur or
  after a pause, which could swallow a click — and any other list control (time, project, panel, sort, page size)
  carries the pending text along), a time select (Last 7 days / Last 30 days / This month / Any
  time → `updated>=-7d`, `updated>=-30d`, `updated:this-month`, no date token; any other date condition shows
  "Custom (advanced)" and is left alone until a preset is picked, which then replaces every date token), a project
  select (the header selector's options with "All accessible projects"; both set `p=` and stay in sync) and the
  advanced toggle with the active-condition count. Everything it writes is canonical tokens in `q=`
  (`site/liststate.js` `timeOfQuery` / `withTime` / `withKeywords`).
- **Default: last 7 days.** `#/list` without a `q` param at all (nav tab, crumbs, a link with only `p=`) gets
  `q=updated>=-7d` through `history.replaceState`. An **explicit empty `q=`** is the "any time / no filter" marker
  and is never replaced: "Any time", clearing the keyword / header search on the list, removing the last tag chip
  and panel edits that end empty all write `q=`; `link()` keeps `q: ''`. Links that carry a count over all dates
  (summary row totals, the project page's "list N documents") pass `q=`; links with their own query (summary cells,
  saved / shared filters, tag chips, legacy params, which `translateLegacy` folds into `q` first) are unchanged.
  "Clear filters" removes `q` and so returns to the default; it and the bar's "search …" note are hidden on the
  default view. With 0 rows and the
  7-day preset as the only date condition the list says "No documents updated in the last 7 days" with a
  "Show any time" button.
- The **advanced filter panel** (collapsed by default at every width; open/closed remembered per browser in
  `localStorage` `gitdocs:adv` — renamed from `gitdocs:advOpen` so the new default reached everyone once) shows status / category / sensitivity / format as toggle chips, tags with any / all, reporter /
  assignee / reviewer (Me in server mode, (none), people in scope), a date field (doc / created / updated) with
  presets (7 / 30 days, this month) or from–to, and the remaining text. It is a view of `q=`: changing it writes
  canonical tokens (`site/liststate.js`), typing a query updates it; tokens it cannot show (negations, partial
  values, repeated fields) stay in the text box verbatim.
- URL: `#/list?p=&q=&sort=status:asc,date:desc&per=25|50|100|all&page=<n>`. Header click sorts, Shift+click (or
  Shift+Enter) adds / flips / removes a secondary sort; `aria-sort` marks only the primary. Page size defaults to 50
  and is saved in prefs `listPer`; filter or sort changes go back to page 1. Old links (`c=`, `s=`, `sv=`, `ty=`,
  `k=`, `sort=&dir=`) are translated into this form once (history `replaceState`).

## Profile menu, theme, PWA, RWD

- Top-right avatar button (initials from the email; "訪客" in static mode) opens a menu: email + roles summary,
  theme radio **淺色 / 深色 / 跟隨系統** (stored in prefs and `localStorage`, applied before first paint),
  鎖定 vault (static mode), 管理 (manager+), **切換帳號 / Switch account** and 登出 (both `/cdn-cgi/access/logout`;
  the first says that you can sign in with another email afterwards, since Access asks for an email again). Labels follow the UI language
  (see [i18n](#i18n)); the menu also has the language radio and, in server mode, an editable **Display name**
  (`PATCH /api/me` `{ name }`, ≤ 80 chars; blank = local part of the email).
- Display names (MantisBT "show realname"): people are shown by name everywhere (list / home / doc people fields,
  notes author, history actor and person values, admin audit). The full email appears only in the admin users
  table and in the signed-in user's own profile menu — not even as a tooltip. Resolution, later wins: catalog
  `site.people` `{ email: name }` → `GET /api/state` `people` → `author_name` / `actor_name` on rows → `/api/me`
  `name`; fallback: the email's local part. Assignee / reviewer inputs show the name and offer a datalist of
  `Name <email>`; the form sends the email (a typed name must match exactly one known person). The client tolerates
  every one of these fields being absent.
- PWA: installable only — `manifest.webmanifest` (name from `site.title`, SVG + PNG-less maskable icon,
  `display: standalone`), linked with `crossorigin="use-credentials"` (behind Cloudflare Access a manifest request
  without cookies is redirected to the login page). **No offline shell for now**: an earlier service worker cached a
  redirected `/index.html` (Pages answers it with a 308 to `/`) and answered navigations with it, which browsers
  reject (`net::ERR_FAILED`), so the portal could not be reloaded. `app.js` registers no worker; on load it
  unregisters the one for its scope and deletes caches named `gitdocs-*` (best effort). `sw.js` is a kill switch
  (deletes those caches, unregisters itself, no fetch handler) and stays in `SHELL_FILES` so browsers that still have
  the old worker get it on their update check. An offline shell may come back once it is tested behind the auth proxy.
- RWD: ≤ 720 px collapses the table to cards, the tabs into a menu, the search into a full-width row; touch targets
  ≥ 40 px; no horizontal page scroll at 360 px.

## Admin page

Route `#/admin` (manager+). Users table: email, name, roles per project, disabled, last seen. Invite form
(email, name, project → role rows). Inline edit of memberships; owner can disable users. An "稽核" tab shows
`/api/audit` (owner).

## i18n

- UI languages: `en` (default) and `zh-TW`. `site/i18n.js` exports `t(key, params)` (text), `th(key, params)` (HTML:
  the message is trusted markup, params are escaped unless wrapped in `raw()`), `setLang` / `getLang`, `LANGS`,
  `label(kind, value)` and `fmtDateTime` (Intl, active locale). Catalogs: `site/i18n/en.js`, `site/i18n/zh-TW.js`
  (same keys; `{name}` placeholders; plurals as `{ one, other }`). Missing keys fall back to English, then to the key.
- Precedence: the user's choice (server `prefs.lang`, mirrored to `localStorage` `gitdocs:lang`; static mode: that
  key) → `?lang=` in the URL or hash (not persisted) → `en`. The browser language is not consulted. The inline script
  in `index.html` sets `<html lang>` before first paint; static markup carries `data-i18n` / `data-i18n-attr`.
  Changing the language in the profile menu re-renders the current view without a reload.
- **Stored values are not translated.** Statuses, sensitivities, default categories and `（索引）` stay Chinese in
  `catalog.json`, D1 and the API (this document's tables still name them that way). `ENUMS` in `site/i18n.js` maps
  each stored value to a slug; the label is the catalog key `<kind>.<slug>` (zh-TW labels equal the stored values).
  Unknown values display as-is. The same slugs and English labels are query aliases in `site/query.js`
  (`s:published`, `sens>=confidential`, `cat:evaluation`); `QUERY_HELP` stays the zh-TW rows for the CLI, the UI uses
  `queryHelp(lang)`.
- Server error strings that `functions/` returns in Chinese (`需要 editor 權限`, …) are mapped client-side in
  `api.js` (`serverMessage`). The 403 HTML page of the middleware is not localized.
- `site/vault-frame.js` is inlined into sandboxed docs and cannot import modules or know the portal's language: it
  carries both locales and follows the document's own `<html lang>` (`zh*` → zh-TW, else English).

## State back to git

`npm run state:pull` (owner, local): reads `doc_state` + notes through `wrangler d1 execute <DB> --remote --json`
(or `GET /api/export/state` with a service token), writes status / assignee / reviewer / tags into
`docs/catalog.json`, appends notes to `docs/notes/<id>.md` (each after a script-written line `<!-- gitdocs-note:<id> -->`, matched as a whole line; the body is quoted with `> ` on every line so it cannot forge headings or markers), records the export time in `synced`, snapshots every project-shared filter into `docs/notes/shared-filters.json`
(sorted, without D1 ids; `GET /api/export/state` also returns them as `sharedFilters`), and prints a
suggested commit message. Git stays the long-term record; D1 is the live layer. `docs/notes/` is not scanned as
documents and never deployed (it is still checked by `vault check`). Share builds (`--max-sensitivity`) drop the
`reporter` / `assignee` / `reviewer` emails.

## Configuration

`wrangler.toml` (content repo, from `wrangler.toml.example`): D1 binding `DB`. Pages env vars / secrets:
`TEAM_DOMAIN` (e.g. `example.cloudflareaccess.com`), `ACCESS_AUD`, `OWNER_EMAILS` (comma-separated),
`ACCESS_GROUP_ID` + `CF_API_TOKEN` + `CF_ACCOUNT_ID` (Access group sync; optional), `VAULT_KEY` (server vault;
`VAULT_PASSPHRASE` as a fallback for low-iteration vaults; also the web vault's key), `VAULT_KEY_PREVIOUS` (after a
rekey: still opens web-vault rows written with the old key), `VAULT_KEY_<SOURCE>` (one per source with its own git
vault: the tenant's `vault key` output; `-` → `_`, upper-case), `SOURCE_<NAME>_URL` (CI only, for `sources:pull`),
`DEV_USER_EMAIL` (local development only).

Build size limits (environment of `scripts/build.mjs` / `doc.mjs` / `vault.mjs`; bytes): `SCAN_MAX_BYTES` (default
2 MiB, counted after inline `data:` URIs are dropped) — the email / PII heuristics, keywords and search text read only
the first part of a file, and such a file is flagged `sensitivityPending` until reviewed; credential patterns and vault
references still cover the whole file (`vault check` / `scan` read only the first part of *mounted* files, whose
findings are warnings); `SOURCE_FILE_MAX_BYTES` (default 20 MiB) — larger files of a mounted source are skipped with a warning (neither
scanned nor deployed). Titles are capped at 200 characters, descriptions at 500, git commit subjects at 200.
Keyword aliases (`catalog.json → keywords`) run over every document, so only a linear subset of regex is accepted:
literals, escapes, classes, groups, alternation, `?` and `{n}` / `{n,m}` (m ≤ 32) on a single character or class;
`*`, `+`, `{n,}`, repeat counts on groups and backreferences are refused (`doc kw add` errors, the build skips the alias
with a warning).
