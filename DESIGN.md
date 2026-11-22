# Design: home page, workflow, multi-user, server vault

Status: accepted 2026-11-22. This is the contract the UI (`site/`) and the server (`functions/`, `migrations/`,
`scripts/`) are built against. Change it here first.

## Contents

- [Modes](#modes)
- [Workflow](#workflow)
- [Roles and permissions](#roles-and-permissions)
- [Identity](#identity)
- [D1 schema](#d1-schema)
- [HTTP API](#http-api)
- [Access control on static files](#access-control-on-static-files)
- [Server vault](#server-vault)
- [Home page](#home-page)
- [Profile menu, theme, PWA, RWD](#profile-menu-theme-pwa-rwd)
- [Admin page](#admin-page)
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
| manage members of the project (invite, change role, remove) | | | ✓ | ✓ |
| create / disable users, global settings, all projects | | | | ✓ |
| docs in index project `（索引）` | owner-only unless a membership names it |

Sensitivity still applies on top: `機密` bodies are never in the search index; `極機密` files are never deployed.

## Identity

- Cloudflare Access sits in front of everything and sends `Cf-Access-Jwt-Assertion`.
- The middleware verifies the JWT (RS256) against `https://<TEAM_DOMAIN>/cdn-cgi/access/certs` (cache the JWKS
  ~10 min), checks `aud` = `ACCESS_AUD` and `exp`, and uses the `email` claim (lower-cased).
- Unknown or disabled email → 403 page "尚未開通，請聯絡管理員" (HTML for navigations, JSON for `/api/*`).
- Local development: if `DEV_USER_EMAIL` is set and the request has no JWT, use it (never in production: it is
  honoured only when the request host is `localhost` / `127.0.0.1` / `[::1]`, and an invalid JWT never falls back).
- No D1 binding (`env.DB` missing) → the middleware passes everything through and `/api/*` returns 404 (static mode),
  so content repos that vendor `functions/` but do not use server mode keep working. If any of `ACCESS_AUD`,
  `TEAM_DOMAIN`, `OWNER_EMAILS` is set without the binding, the deployment is misconfigured: every request gets
  503 "server mode misconfigured" (HTML for navigations, JSON for `/api/*`) instead of an unfiltered static site.

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
vault_audit  (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
              action TEXT NOT NULL /* show|copy */, at TEXT NOT NULL)
prefs        (email TEXT PRIMARY KEY, json TEXT NOT NULL)
synced       (path TEXT PRIMARY KEY, at TEXT NOT NULL)               -- last doc_state row exported to git
```

Migrations live in `migrations/NNNN_*.sql` (wrangler D1 migrations format). Timestamps are ISO-8601 UTC.

## HTTP API

All JSON. Errors: `{ "error": "<message>" }` with 400 / 403 / 404 / 409. Every mutating call writes `history`.
CSRF: every non-GET/HEAD `/api` request needs `Content-Type: application/json` (parameters allowed) and either
`Sec-Fetch-Site: same-origin` or an `Origin` equal to the request origin, else 403. Bodies are capped per route
(Content-Length checked before reading; chunked bodies cut off while reading).

| Method & path | Who | Body / result |
|---|---|---|
| `GET /api/me` | any user | `{ email, name, owner, roles: { "<project>": "viewer"\|"editor"\|"manager", "*"?: … }, prefs }` |
| `PUT /api/me/prefs` | any user | body: prefs object (≤ 8 KB) → `{ ok: true }` |
| `GET /api/state` | any user | `{ docs: { "<path>": { status, assignee, reviewer, tags, updated_by, updated_at, notes: <count> } } }` — only visible projects; docs that only have notes carry their catalog values and `updated_at: null` |
| `PATCH /api/docs/:id` | editor+ of the doc's project | body: any of `{ status, assignee, reviewer, tags }` (`''` or `null` clears a person; stored as `''` = explicitly nobody) → `{ id, path, …state }`; the first edit copies the catalog values into the `doc_state` row, so a row is always the full state |
| `GET /api/docs/:id/notes` | can see doc | `[{ id, author, body, created_at }]` |
| `POST /api/docs/:id/notes` | can see doc | body `{ body }` (≤ 4000 chars) → created note |
| `GET /api/docs/:id/history` | can see doc | `[{ actor, action, field, old, new, at }]` |
| `POST /api/vault/reveal` | editor+ of the doc's project | body `{ id, name, action: "show"\|"copy" }`; `name` must be referenced by that doc → `{ value }`; audited |
| `GET /api/users` | manager+ | owner: all users with memberships; manager: users in projects they manage |
| `POST /api/users` | manager+ | body `{ email, name?, memberships: [{ project, role }] }` — managers only for their projects, only owners grant `*`; adds the email to the Access group. New user → 201 `{ user }`; existing user → 200 `{ user, existing: true }` with the rows merged |
| `PATCH /api/users/:email` | manager+ / owner | body `{ name?, disabled? (owner only), memberships? }` — `memberships` is the desired set within the caller's reach: listed rows are upserted (`role: null` removes), rows the caller manages but did not list are removed, rows of other projects are untouched (managers: only rows for their projects) → `{ user }` |
| `DELETE /api/users/:email` | owner | disables the user and removes the email from the Access group (a `PATCH` that removes a user's last membership also removes them from the group; adding one back re-adds them) |
| `GET /api/audit?limit=` | owner | `{ history: [...], vault: [...] }` — newest first, `limit` ≤ 500 (default 100) |
| `GET /api/export/state?since=` | owner | `{ at, docs: [doc_state rows], notes: [...] }` changed since an ISO time |

Access group sync (optional) is full-set: after any change to users, memberships or `disabled`, the group's email
rules are rewritten to every enabled D1 user with at least one membership plus `OWNER_EMAILS` (non-email rules kept;
D1 is read after the GET and re-read after the PUT, syncing again if it changed meanwhile, at most 3 rounds), so
concurrent edits converge instead of losing updates. It never PUTs an empty include list.
Mutations that can fail half-way outside D1 (Access group sync) keep the D1 change and add `"warning": "<message>"` to
the response. A user object is `{ email, name, disabled, owner, created_at, created_by, last_seen, memberships: [{ project, role }] }`
(`last_seen` = latest hourly `login` history row; managers see only memberships of projects they manage).

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
| `SHELL_FILES` in `functions/_lib/gate.js`: `/`, `/index.html`, `/app.js`, `/app.css`, `/query.js`, `/model.js`, `/api.js`, `/admin.js`, `/graph.js`, `/graph.css`, `/vault.js`, `/vault-core.js`, `/vault-frame.js`, `/sw.js`, `/manifest.webmanifest`, `/robots.txt`, `/icons/<file>` | any known user (`/` and `/index.html` also get the shell CSP) |
| `/catalog.json` | rewritten: only docs in visible projects; `projects` and `filters` trimmed accordingly; `related` / `supersedes` links to invisible docs removed; adds `"server": true` |
| `/search-index.json` | rewritten: only rows whose doc is visible |
| `/docs/<path>` (also the extensionless and `…/index.html` forms) | 403 unless the doc's project is visible (unknown files under `/docs/` → owner only); the middleware sets `Content-Security-Policy: sandbox …`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-cache` itself (`_headers` rules match the raw path and are only a static-mode fallback) |
| `/vault.json` | 404 in server mode (the server vault replaces it) |
| `/api/*` | handled by the API (the raw path must start with `/api/` too) |
| anything else | 404 — a file the build adds to `site/` stays unreachable until it is added to `SHELL_FILES`; `test/server.test.mjs` fails while the list and `site/` differ |

Paths are case-sensitive (as on Pages): `/Docs/…`, `/VAULT.json` match nothing and fall into "anything else".

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
- `POST /api/vault/reveal` checks role and that the doc references the name, writes `vault_audit`, returns the value
  with `Cache-Control: no-store`.
- UI: in server mode the masked widgets and the HTML-doc dialog call this endpoint instead of asking for a
  passphrase; viewers see the mask with a disabled button ("需要 editor 權限").
- A sandboxed HTML doc's `postMessage` only opens the portal dialog **masked** (secret name + doc title); the
  reveal (server call, or decryption in static mode) happens only when the user clicks 顯示 / 複製 in that dialog.
  While one dialog is open, further requests are ignored.

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

## Profile menu, theme, PWA, RWD

- Top-right avatar button (initials from the email; "訪客" in static mode) opens a menu: email + roles summary,
  theme radio **淺色 / 深色 / 跟隨系統** (stored in prefs and `localStorage`, applied before first paint),
  鎖定 vault (static mode), 管理 (manager+), 登出 (`/cdn-cgi/access/logout`).
- PWA: `manifest.webmanifest` (name from `site.title`, SVG + PNG-less maskable icon, `display: standalone`),
  `sw.js` caches only the app shell (cache-first, versioned by build time); `catalog.json`, `search-index.json`,
  `/api/*`, `/docs/*`, `/vault.json` are network-only (never cached — access can be revoked).
- RWD: ≤ 720 px collapses the table to cards, the tabs into a menu, the search into a full-width row; touch targets
  ≥ 40 px; no horizontal page scroll at 360 px.

## Admin page

Route `#/admin` (manager+). Users table: email, name, roles per project, disabled, last seen. Invite form
(email, name, project → role rows). Inline edit of memberships; owner can disable users. An "稽核" tab shows
`/api/audit` (owner).

## State back to git

`npm run state:pull` (owner, local): reads `doc_state` + notes through `wrangler d1 execute <DB> --remote --json`
(or `GET /api/export/state` with a service token), writes status / assignee / reviewer / tags into
`docs/catalog.json`, appends notes to `docs/notes/<id>.md` (each after a script-written line `<!-- gitdocs-note:<id> -->`, matched as a whole line; the body is quoted with `> ` on every line so it cannot forge headings or markers), records the export time in `synced`, and prints a
suggested commit message. Git stays the long-term record; D1 is the live layer. `docs/notes/` is not scanned as
documents and never deployed (it is still checked by `vault check`). Share builds (`--max-sensitivity`) drop the
`reporter` / `assignee` / `reviewer` emails.

## Configuration

`wrangler.toml` (content repo, from `wrangler.toml.example`): D1 binding `DB`. Pages env vars / secrets:
`TEAM_DOMAIN` (e.g. `example.cloudflareaccess.com`), `ACCESS_AUD`, `OWNER_EMAILS` (comma-separated),
`ACCESS_GROUP_ID` + `CF_API_TOKEN` + `CF_ACCOUNT_ID` (Access group sync; optional), `VAULT_KEY` (server vault;
`VAULT_PASSPHRASE` as a fallback for low-iteration vaults), `DEV_USER_EMAIL` (local development only).
