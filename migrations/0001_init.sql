-- gitdocs-portal server mode: live workflow state, users and audit (see DESIGN.md → D1 schema).
-- Apply with: npx --yes wrangler@4.166.0 d1 migrations apply <database_name> --remote
-- Timestamps are ISO-8601 UTC strings, so text comparison orders them.

CREATE TABLE users (
  email      TEXT PRIMARY KEY,                 -- lower-cased
  name       TEXT,
  disabled   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE memberships (
  email   TEXT NOT NULL,
  project TEXT NOT NULL,                       -- top-level project key, or '*' for every project
  role    TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'manager')),
  PRIMARY KEY (email, project)
);
CREATE INDEX memberships_project ON memberships (project);

CREATE TABLE doc_state (
  path       TEXT PRIMARY KEY,                 -- catalog path, e.g. docs/handbook/a.md
  status     TEXT,
  assignee   TEXT,
  reviewer   TEXT,
  tags       TEXT,                             -- JSON array or NULL
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX doc_state_updated_at ON doc_state (updated_at);

CREATE TABLE notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX notes_path ON notes (path, created_at);
CREATE INDEX notes_created_at ON notes (created_at);

-- doc edits, notes, membership changes, logins
CREATE TABLE history (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  path   TEXT,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  field  TEXT,
  old    TEXT,
  new    TEXT,
  at     TEXT NOT NULL
);
CREATE INDEX history_path ON history (path, at);
CREATE INDEX history_at ON history (at);
CREATE INDEX history_actor_action ON history (actor, action, at);

CREATE TABLE vault_audit (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  email  TEXT NOT NULL,
  name   TEXT NOT NULL,
  path   TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('show', 'copy')),
  at     TEXT NOT NULL
);
CREATE INDEX vault_audit_at ON vault_audit (at);

CREATE TABLE prefs (
  email TEXT PRIMARY KEY,
  json  TEXT NOT NULL
);

-- last doc_state / notes timestamp per path exported to git by `npm run state:pull`
CREATE TABLE synced (
  path TEXT PRIMARY KEY,
  at   TEXT NOT NULL
);
