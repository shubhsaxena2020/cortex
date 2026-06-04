-- Memories table
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  source TEXT DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  importance INTEGER DEFAULT 3,
  tags TEXT DEFAULT '[]'
);

-- Relationships between memories
CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  memory_a_id TEXT NOT NULL,
  memory_b_id TEXT NOT NULL,
  relationship_type TEXT DEFAULT 'related',
  FOREIGN KEY (memory_a_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (memory_b_id) REFERENCES memories(id) ON DELETE CASCADE
);

-- Full-text search virtual table
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  title,
  content,
  source,
  tags,
  content=memories,
  content_rowid=rowid
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, id, title, content, source, tags)
  VALUES (new.rowid, new.id, new.title, new.content, new.source, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, id, title, content, source, tags)
  VALUES ('delete', old.rowid, old.id, old.title, old.content, old.source, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, id, title, content, source, tags)
  VALUES ('delete', old.rowid, old.id, old.title, old.content, old.source, old.tags);
  INSERT INTO memories_fts(rowid, id, title, content, source, tags)
  VALUES (new.rowid, new.id, new.title, new.content, new.source, new.tags);
END;
