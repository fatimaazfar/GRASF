CREATE TABLE IF NOT EXISTS nodes (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  name             TEXT NOT NULL,
  summary          TEXT,
  file_path        TEXT,
  scope            TEXT DEFAULT 'root',
  status           TEXT DEFAULT 'active',
  decay_score      REAL DEFAULT 1.0,
  access_count     INTEGER DEFAULT 0,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now')),
  last_accessed_at TEXT DEFAULT (datetime('now')),
  git_hash         TEXT,
  raw_content      TEXT,
  extraction_layer TEXT DEFAULT 'structural'
);

CREATE TABLE IF NOT EXISTS edges (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  rel        TEXT NOT NULL,
  weight     REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now')),
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  started_at       TEXT,
  ended_at         TEXT,
  goal             TEXT,
  outcome          TEXT,
  next_step        TEXT,
  scope            TEXT DEFAULT 'root',
  transcript_path  TEXT,
  extraction_layer TEXT DEFAULT 'structural',
  changed_files    TEXT
);

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name, summary, raw_content,
  content=nodes, content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS nodes_fts_insert AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, summary, raw_content)
  VALUES (new.rowid, new.name, new.summary, new.raw_content);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_update AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, summary, raw_content)
  VALUES ('delete', old.rowid, old.name, old.summary, old.raw_content);
  INSERT INTO nodes_fts(rowid, name, summary, raw_content)
  VALUES (new.rowid, new.name, new.summary, new.raw_content);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_delete AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, summary, raw_content)
  VALUES ('delete', old.rowid, old.name, old.summary, old.raw_content);
END;

CREATE INDEX IF NOT EXISTS idx_nodes_type   ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_scope  ON nodes(scope);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
CREATE INDEX IF NOT EXISTS idx_nodes_decay  ON nodes(decay_score);
CREATE INDEX IF NOT EXISTS idx_edges_from   ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to     ON edges(to_id);
