-- Web vault (DESIGN.md → Tenant vaults): secrets edited in the portal, ciphertext only (AES-256-GCM, AAD = name,
-- key = VAULT_KEY). vault_versions is append-only history of every change.
CREATE TABLE vault_secrets (
  name       TEXT PRIMARY KEY,
  iv         TEXT NOT NULL,
  ct         TEXT NOT NULL,
  note       TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE vault_versions (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  iv     TEXT,
  ct     TEXT,
  note   TEXT,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  actor  TEXT NOT NULL,
  at     TEXT NOT NULL
);
CREATE INDEX vault_versions_name ON vault_versions (name, id);

-- reveals from the vault page have no document: vault_audit.path becomes nullable (SQLite: rebuild the table)
CREATE TABLE vault_audit_new (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  email  TEXT NOT NULL,
  name   TEXT NOT NULL,
  path   TEXT,
  action TEXT NOT NULL CHECK (action IN ('show', 'copy')),
  at     TEXT NOT NULL
);
INSERT INTO vault_audit_new (id, email, name, path, action, at) SELECT id, email, name, path, action, at FROM vault_audit;
DROP TABLE vault_audit;
ALTER TABLE vault_audit_new RENAME TO vault_audit;
CREATE INDEX vault_audit_at ON vault_audit (at);
