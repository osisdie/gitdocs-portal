-- Project-shared saved filters (DESIGN.md → Saved filters and CSV export). Personal filters live in prefs.json.
-- params: the list view's URL query (URLSearchParams string, no page), always scoped to `project` (p=<project[/sub]>).
CREATE TABLE shared_filters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project    TEXT NOT NULL,                    -- top-level project key
  name       TEXT NOT NULL,
  params     TEXT NOT NULL,
  created_by TEXT NOT NULL,                    -- email; never sent to clients (display name only)
  created_at TEXT NOT NULL,
  UNIQUE (project, name)
);
