import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { join, sep } from 'path'
import { app } from 'electron'
import { randomUUID } from 'crypto'
import log from 'electron-log'
import { applyTagRename, applyTagDelete, countTags } from './tag-ops'

let db: Database.Database | null = null
let vectorSearchEnabled = false

const EMBEDDING_DIM = 384  // must match embeddings.ts EMBEDDING_DIM
const SCHEMA_VERSION = 6   // bump + add migration when schema changes

function defaultDbPath(): string {
  return join(app.getPath('userData'), 'memories.db')
}

type MemoryRow = {
  id: string
  title: string
  content: string
  timestamp: number
  updatedAt: number
  source: string
  tags: string
  url: string | null
}

type RelationshipRow = {
  id: string
  sourceId: string
  targetId: string
  relationship: string
}

function mapMemory(r: MemoryRow) {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    timestamp: r.timestamp,
    updatedAt: r.updatedAt,
    source: r.source,
    tags: JSON.parse(r.tags || '[]') as string[],
    url: r.url ?? null,
  }
}

function mapRelationship(r: RelationshipRow) {
  return {
    id: r.id,
    sourceId: r.sourceId,
    targetId: r.targetId,
    relationship: r.relationship,
    // Dropping these here silently degraded every auto-edge to gray
    // 'manual'/strength-0 downstream (toRelationship fills the defaults).
    strength: r.strength ?? 0,
    signal_type: r.signal_type ?? 'manual',
  }
}

function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

export { getDb }

// User input flows into LIKE patterns; without escaping, a query containing
// %  _ or \ would match wildcards. ESCAPE clause must be paired on the SQL side.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, m => '\\' + m)
}

export async function initDb(customPath?: string): Promise<void> {
  if (db) return

  db = new Database(customPath ?? defaultDbPath())
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Best-effort load of sqlite-vec. If it fails (extension missing, ABI
  // mismatch, etc.) the app keeps working — /api/related just falls back to
  // keyword search.
  try {
    // In a packaged Electron build, sqlite-vec's sidecar binary lives in
    // app.asar.unpacked but require.resolve returns the app.asar path. Native
    // SQLite's LoadLibrary/dlopen bypasses Node's asar redirect, so we rewrite
    // the path here. No-op in dev where neither path segment is present.
    let loadablePath = sqliteVec.getLoadablePath()
    if (loadablePath.includes(`app.asar${sep}`)) {
      loadablePath = loadablePath.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    }
    db.loadExtension(loadablePath)
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding FLOAT[${EMBEDDING_DIM}]
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS vault_vectors USING vec0(
        file_id TEXT PRIMARY KEY,
        embedding FLOAT[${EMBEDDING_DIM}]
      );
    `)
    vectorSearchEnabled = true
    log.info('[db] sqlite-vec loaded; vector search enabled')
  } catch (err) {
    vectorSearchEnabled = false
    log.warn('[db] sqlite-vec unavailable — falling back to keyword search:', err)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      timestamp INTEGER,
      updatedAt INTEGER,
      source TEXT,
      tags TEXT,
      url TEXT
    );
    -- NOTE: idx_memories_url is created by runMigrations(), NOT here.
    -- On an existing v1 database the CREATE TABLE statement above is a no-op
    -- and the url column is not actually present yet — the migration adds it
    -- via ALTER TABLE before the index can reference it. The CREATE TABLE
    -- above only takes effect on fresh installs; runMigrations is the single
    -- source of truth for everything that depends on the v2+ schema shape.

    CREATE TABLE IF NOT EXISTS memory_relationships (
      id TEXT PRIMARY KEY,
      sourceId TEXT NOT NULL,
      targetId TEXT NOT NULL,
      relationship TEXT,
      FOREIGN KEY(sourceId) REFERENCES memories(id),
      FOREIGN KEY(targetId) REFERENCES memories(id)
    );

    CREATE TABLE IF NOT EXISTS fts_memories (
      rowid INTEGER PRIMARY KEY,
      title TEXT,
      content TEXT,
      memory_id TEXT UNIQUE,
      FOREIGN KEY(memory_id) REFERENCES memories(id)
    );

    CREATE TABLE IF NOT EXISTS vault_files (
      id TEXT PRIMARY KEY,
      filepath TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      extension TEXT NOT NULL,
      content TEXT,
      size INTEGER DEFAULT 0,
      last_modified INTEGER DEFAULT 0,
      indexed_at INTEGER DEFAULT 0,
      frontmatter_url TEXT,
      linked_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL
    );
    -- NOTE: idx_vault_frontmatter_url is created by runMigrations(), NOT here.
    -- Same reason as idx_memories_url: on an existing v1 / v2 database the
    -- CREATE TABLE statement is a no-op and the columns aren't actually
    -- present yet. The migration adds the columns via ALTER TABLE before the
    -- index can reference them. The CREATE TABLE above only takes effect on
    -- fresh installs; runMigrations is the single source of truth for
    -- everything that depends on the v3+ schema shape.

    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  `)

  // Schema-version handling. Two cases:
  //
  //   (a) Fresh install — no row in schema_version. Treat as "from version 0"
  //       and run every migration step. The CREATE TABLE statements above
  //       gave us the right columns for fresh installs, but objects that
  //       depend on the new columns (indexes, etc.) still need to be created
  //       by the migration steps — so the migration runs even when there's
  //       nothing to ALTER.
  //
  //   (b) Existing install — row present with the previous version. Run any
  //       migration steps from that version up to SCHEMA_VERSION.
  //
  // The migration runner is idempotent per step (PRAGMA checks before ALTER,
  // CREATE INDEX IF NOT EXISTS), so running steps that have already
  // effectively happened on a fresh install is a no-op.
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined
  const fromVersion = row?.version ?? 0
  if (fromVersion < SCHEMA_VERSION) {
    runMigrations(db, fromVersion, SCHEMA_VERSION)
  }

  // Reap orphaned vectors. Hot-reload, manual DB edits, and prior bugs can
  // leave embedding rows whose parent memory or vault file no longer exists.
  // Without this, /api/admin/embed-status and the Settings status panel show
  // counts higher than the actual memory count.
  if (vectorSearchEnabled) {
    try {
      db.exec(`
        DELETE FROM memory_vectors WHERE memory_id NOT IN (SELECT id FROM memories);
        DELETE FROM vault_vectors  WHERE file_id   NOT IN (SELECT id FROM vault_files);
      `)
    } catch (err) {
      log.warn('[db] orphan vector cleanup failed:', err)
    }
  }
}

// ── Migrations ────────────────────────────────────────────────────────────────
//
// Each step is idempotent and forward-only. New steps append, never edit
// existing ones — the contract is "every install runs every step from its
// current version forward exactly once." Fresh installs enter with from=0
// and run the whole chain; existing installs enter with from=<their stored
// version> and run only the deltas.
//
// Every step MUST be safe to re-run if a previous attempt half-finished:
// guard column adds with PRAGMA table_info checks, use CREATE INDEX IF NOT
// EXISTS / CREATE TABLE IF NOT EXISTS, etc. The whole batch runs inside one
// transaction so any error rolls everything back atomically.
function runMigrations(d: Database.Database, from: number, to: number): void {
  if (from >= to) return
  try {
    const m = d.transaction(() => {
      if (from < 2) {
        // v2: add memories.url + index for dedup-by-URL.
        // See docs/DEDUP-IMPLEMENTATION.md. Column is NULLable so existing rows
        // keep working; backfill is a separate offline pass via
        // scripts/backfill-source-urls.mjs.
        const cols = d.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>
        if (!cols.some(c => c.name === 'url')) {
          d.exec(`ALTER TABLE memories ADD COLUMN url TEXT`)
        }
        // Partial index — URLs are rare on legacy rows; full index would waste
        // space. Created here (NOT in the initial CREATE TABLE block) because
        // on existing v1 databases the column doesn't exist yet when the
        // initial CREATE TABLE statement runs as a no-op.
        d.exec(`CREATE INDEX IF NOT EXISTS idx_memories_url ON memories(url) WHERE url IS NOT NULL`)
      }
      if (from < 3) {
        // v3: cross-pipeline absorption (P0 #1 part 2).
        // vault_files gains frontmatter_url (parsed from .md YAML at ingest)
        // and linked_memory_id (set when frontmatter_url matches an existing
        // memory's url). getAllVaultFiles + searchVaultFiles filter by
        // linked_memory_id IS NULL so linked files disappear from the graph
        // and Files tab — the memory becomes the canonical representation.
        const vcols = d.prepare(`PRAGMA table_info(vault_files)`).all() as Array<{ name: string }>
        if (!vcols.some(c => c.name === 'frontmatter_url')) {
          d.exec(`ALTER TABLE vault_files ADD COLUMN frontmatter_url TEXT`)
        }
        if (!vcols.some(c => c.name === 'linked_memory_id')) {
          // SQLite ALTER TABLE ADD COLUMN cannot include REFERENCES — FKs on
          // ALTER are silently dropped (PRAGMA foreign_keys check_table fails
          // afterwards). For existing installs the column exists without a
          // declared FK; the JOIN integrity is maintained at the app layer
          // (we never write a linked_memory_id that doesn't exist, and we
          // null it on memory delete via vault.ts cleanup).
          d.exec(`ALTER TABLE vault_files ADD COLUMN linked_memory_id TEXT`)
        }
        d.exec(`CREATE INDEX IF NOT EXISTS idx_vault_frontmatter_url ON vault_files(frontmatter_url) WHERE frontmatter_url IS NOT NULL`)
      }
      if (from < 4) {
        // v4: search performance (P0 #4 fixes #1 + #2 from profiling report).
        //
        // Replace the regular `fts_memories` shadow table (which was never
        // actually queried — searchMemories did a full LIKE scan on memories)
        // with a real FTS5 virtual table `memories_fts`. The contentless
        // configuration would tie us to memories.rowid mapping; we use the
        // simpler "external content" pattern with an explicit memory_id
        // UNINDEXED column so app-level upsert is straightforward.
        //
        // Also add idx_memories_updated for the ORDER BY updatedAt path
        // (used by /api/recent and the post-MATCH sort in searchMemories).
        d.exec(`DROP TABLE IF EXISTS fts_memories`)
        d.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
            memory_id UNINDEXED,
            title,
            content,
            tokenize = 'unicode61 remove_diacritics 2'
          )
        `)
        // Backfill from existing memories. INSERT OR IGNORE in case the
        // migration is re-run after a partial failure.
        d.exec(`
          INSERT INTO memories_fts (memory_id, title, content)
          SELECT id, title, COALESCE(content, '') FROM memories
          WHERE id NOT IN (SELECT memory_id FROM memories_fts)
        `)
        d.exec(`CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updatedAt DESC)`)
      }
      if (from < 5) {
        // v5: add strength + signal_type to memory_relationships for P1 #4
        // auto-edge cascade. Existing manual relationships get default values.
        const rCols = d.prepare(`PRAGMA table_info(memory_relationships)`).all() as Array<{ name: string }>
        if (!rCols.some(c => c.name === 'strength')) {
          d.exec(`ALTER TABLE memory_relationships ADD COLUMN strength REAL DEFAULT 0.0`)
        }
        if (!rCols.some(c => c.name === 'signal_type')) {
          d.exec(`ALTER TABLE memory_relationships ADD COLUMN signal_type TEXT DEFAULT 'manual'`)
        }
        // Mark existing rows that have null/empty signal_type as 'manual'
        d.exec(`UPDATE memory_relationships SET signal_type = 'manual' WHERE signal_type IS NULL OR signal_type = ''`)
        // Indexes for fast edge lookup
        d.exec(`CREATE INDEX IF NOT EXISTS idx_memrel_source ON memory_relationships(sourceId)`)
        d.exec(`CREATE INDEX IF NOT EXISTS idx_memrel_target ON memory_relationships(targetId)`)
        d.exec(`CREATE INDEX IF NOT EXISTS idx_memrel_signal ON memory_relationships(signal_type)`)
        // Index on tags column for tag-based candidate queries
        d.exec(`CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories(tags)`)
      }
      if (from < 6) {
        // v6: index for the source filter in searchMemories / stats GROUP BY,
        // plus ANALYZE so the query planner has real cardinality stats for
        // the indices added in v2–v5 (it otherwise guesses, and on a 10k-row
        // table guesses wrong about tags/signal_type selectivity).
        d.exec(`CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source)`)
        d.exec(`ANALYZE`)
      }

      // Bump (or write) the stored version. UPDATE if the row exists; INSERT
      // otherwise. We can't rely on the caller to handle the fresh-install
      // INSERT because that would split state ownership across two functions
      // and risk a half-migrated row.
      const existing = d.prepare(`SELECT 1 FROM schema_version`).get() as unknown
      if (existing) {
        d.prepare(`UPDATE schema_version SET version = ?`).run(to)
      } else {
        d.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(to)
      }
    })
    m()
    log.info(`[db] migrated schema ${from} → ${to}`)
  } catch (err) {
    // Loud failure beats silent corruption. The app will keep crashing on the
    // next memories operation if the migration didn't land, so make sure the
    // root cause shows up in the log instead of just the downstream symptom.
    log.error(`[db] SCHEMA MIGRATION FAILED (from ${from} → ${to}):`, err)
    throw err
  }
}

export function hasVectorSearch(): boolean {
  return vectorSearchEnabled
}

// Test-only: close the singleton and reset state so the next initDb() spawns
// a fresh DB. Production code never needs this.
export function __resetDbForTest(): void {
  if (db) { try { db.close() } catch {} }
  db = null
  vectorSearchEnabled = false
}

export function createMemory(id: string, title: string, content: string, source: string, tags: string[] = [], url: string | null = null) {
  const d = getDb()
  const now = Date.now()
  const tagsStr = JSON.stringify(tags)

  d.prepare(
    'INSERT OR REPLACE INTO memories (id, title, content, timestamp, updatedAt, source, tags, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, title, content, now, now, source, tagsStr, url)

  // FTS5 virtual tables don't honour INSERT OR REPLACE — emulate upsert
  // (DELETE-then-INSERT). Same pattern as memory_vectors above.
  d.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id)
  d.prepare(
    'INSERT INTO memories_fts (memory_id, title, content) VALUES (?, ?, ?)'
  ).run(id, title, content)

  return { id, title, content, timestamp: now, updatedAt: now, source, tags, url }
}

/**
 * Find an existing memory by its canonical URL. Returns null if none exists
 * or if `canonicalUrl` is null. Used by the capture-pipeline dedup path —
 * callers compute the canonical URL via `src/main/url-canon.ts`.
 */
export function findMemoryByCanonicalUrl(canonicalUrl: string | null): ReturnType<typeof mapMemory> | null {
  if (!canonicalUrl) return null
  const row = getDb().prepare('SELECT * FROM memories WHERE url = ?').get(canonicalUrl) as MemoryRow | undefined
  return row ? mapMemory(row) : null
}

/**
 * UPDATE the URL of an existing memory. Used by the backfill script for
 * legacy rows captured before v0.2 (when URLs weren't persisted to the DB).
 * No-op if the row doesn't exist; idempotent if called twice with the same URL.
 */
export function setMemoryUrl(id: string, url: string | null): void {
  getDb().prepare('UPDATE memories SET url = ? WHERE id = ?').run(url, id)
}

/**
 * Capture-pipeline dedup: if a memory with the same canonical URL exists,
 * UPDATE it in place (newer content wins, updatedAt bumps, original id is
 * preserved so graph nodes stay stable). Otherwise INSERT a new row.
 *
 * Returns the resulting memory plus an action flag for telemetry / the API
 * response so callers can distinguish create from update.
 */
export function upsertMemoryByUrl(
  newId: string,
  title: string,
  content: string,
  source: string,
  tags: string[],
  canonicalUrl: string | null,
): { memory: ReturnType<typeof mapMemory>; action: 'created' | 'updated' } {
  const d = getDb()

  // No URL → no dedup possible. Fall through to plain create.
  if (!canonicalUrl) {
    const row = createMemory(newId, title, content, source, tags, null)
    return { memory: row, action: 'created' }
  }

  const existing = findMemoryByCanonicalUrl(canonicalUrl)
  if (!existing) {
    const row = createMemory(newId, title, content, source, tags, canonicalUrl)
    // P0 #1 part 2: if a vault file with this URL was indexed BEFORE this
    // memory existed, retroactively link it. Without this, the file stays
    // visible in the graph + Files tab as a duplicate of the new memory.
    try { d.prepare('UPDATE vault_files SET linked_memory_id = ? WHERE frontmatter_url = ? AND linked_memory_id IS NULL').run(newId, canonicalUrl) } catch (_) {}
    return { memory: row, action: 'created' }
  }

  // Update in place. Preserve original id + timestamp; bump updatedAt; keep
  // url unchanged (it's the key we matched on). Title and tags can change
  // between captures — the newer values win.
  const now = Date.now()
  const tagsStr = JSON.stringify(tags)
  d.prepare(
    'UPDATE memories SET title = ?, content = ?, updatedAt = ?, source = ?, tags = ? WHERE id = ?'
  ).run(title, content, now, source, tagsStr, existing.id)
  d.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(existing.id)
  d.prepare(
    'INSERT INTO memories_fts (memory_id, title, content) VALUES (?, ?, ?)'
  ).run(existing.id, title, content)

  return {
    memory: {
      id: existing.id,
      title,
      content,
      timestamp: existing.timestamp,
      updatedAt: now,
      source,
      tags,
      url: canonicalUrl,
    },
    action: 'updated',
  }
}

export function getMemory(id: string) {
  const row = getDb().prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined
  return row ? mapMemory(row) : null
}

export function getAllMemories() {
  const rows = getDb().prepare('SELECT * FROM memories ORDER BY updatedAt DESC').all() as MemoryRow[]
  return rows.map(mapMemory)
}

export function updateMemory(id: string, title: string, content: string, tags: string[] = []) {
  const d = getDb()
  const now = Date.now()
  const tagsStr = JSON.stringify(tags)

  d.prepare(
    'UPDATE memories SET title = ?, content = ?, updatedAt = ?, tags = ? WHERE id = ?'
  ).run(title, content, now, tagsStr, id)

  d.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id)
  d.prepare(
    'INSERT INTO memories_fts (memory_id, title, content) VALUES (?, ?, ?)'
  ).run(id, title, content)

  return { id, title, content, updatedAt: now, tags }
}

export function deleteMemory(id: string) {
  const d = getDb()
  // FK is enforced now; delete dependent rows before the memory itself.
  d.prepare('DELETE FROM memory_relationships WHERE sourceId = ? OR targetId = ?').run(id, id)
  d.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id)
  if (vectorSearchEnabled) {
    try { d.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(id) } catch (_) {}
  }
  // Unlink any vault_files that pointed at this memory so they reappear in
  // the graph + Files tab instead of being silently orphaned. Fresh installs
  // also have ON DELETE SET NULL declared at table level; this app-layer
  // step covers upgraded installs where ALTER TABLE ADD COLUMN couldn't
  // attach the FK constraint.
  try { d.prepare('UPDATE vault_files SET linked_memory_id = NULL WHERE linked_memory_id = ?').run(id) } catch (_) {}
  d.prepare('DELETE FROM memories WHERE id = ?').run(id)
  return { success: true }
}

// FTS5 phrase-quote: wrap the query as a single phrase and double any
// embedded `"`. Returns null when the query has no tokenizable content (only
// punctuation/whitespace) so callers fall back to LIKE / latest-50.
function toFtsPhrase(query: string): string | null {
  const trimmed = query.trim()
  if (!trimmed) return null
  // FTS5 unicode61 tokenises on non-alphanumeric. If the query has zero
  // alphanumeric chars (`50%` after stripping `%`, etc.) MATCH will throw
  // "syntax error near '...'". Detect and bail.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null
  return `"${trimmed.replace(/"/g, '""')}"`
}

export function searchMemories(query: string, source?: string, tags?: string[]) {
  const d = getDb()
  const phrase = toFtsPhrase(query)

  // Fast path: FTS5 MATCH against memories_fts, join back for full row data
  // and post-filters. ORDER BY updatedAt uses idx_memories_updated.
  if (phrase) {
    let sql = `
      SELECT m.* FROM memories m
      JOIN memories_fts f ON f.memory_id = m.id
      WHERE memories_fts MATCH ?
    `
    const params: unknown[] = [phrase]
    if (source) { sql += ' AND m.source = ?'; params.push(source) }
    if (tags && tags.length) {
      for (const t of tags) {
        // Tags are JSON-encoded; the quote literals don't need LIKE-escaping
        // but the tag value itself does. (Tag normalisation into a join
        // table is the next P0 #4 follow-up — see profiling-report.md.)
        sql += ' AND m.tags LIKE ? ESCAPE \'\\\''
        params.push(`%"${escapeLike(t)}"%`)
      }
    }
    sql += ' ORDER BY m.updatedAt DESC LIMIT 50'
    try {
      const rows = d.prepare(sql).all(...params) as MemoryRow[]
      return rows.map(mapMemory)
    } catch (err) {
      // Defensive: any FTS5 parse error (a query shape we didn't anticipate)
      // falls through to the LIKE path rather than 500-ing the search box.
      log.warn('[db] FTS5 search failed, falling back to LIKE:', err)
    }
  }

  // Fallback path: empty query, special-char-only query, or FTS5 parse error.
  // For empty queries this matches the prior behaviour (return latest 50).
  const escaped = escapeLike(query)
  let sql: string
  const params: unknown[] = []
  if (phrase === null && !query.trim()) {
    sql = 'SELECT * FROM memories WHERE 1=1'
  } else {
    sql = `SELECT * FROM memories WHERE (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')`
    params.push(`%${escaped}%`, `%${escaped}%`)
  }
  if (source) { sql += ' AND source = ?'; params.push(source) }
  if (tags && tags.length) {
    for (const t of tags) {
      sql += ' AND tags LIKE ? ESCAPE \'\\\''
      params.push(`%"${escapeLike(t)}"%`)
    }
  }
  sql += ' ORDER BY updatedAt DESC LIMIT 50'
  const rows = d.prepare(sql).all(...params) as MemoryRow[]
  return rows.map(mapMemory)
}

export function createRelationship(sourceId: string, targetId: string, relationship: string) {
  const id = `${sourceId}-${targetId}`
  getDb().prepare(
    'INSERT OR REPLACE INTO memory_relationships (id, sourceId, targetId, relationship) VALUES (?, ?, ?, ?)'
  ).run(id, sourceId, targetId, relationship)
  return { id, sourceId, targetId, relationship }
}

export function getRelatedMemories(id: string) {
  const rows = getDb().prepare(`
    SELECT DISTINCT m.* FROM memories m
    JOIN memory_relationships mr ON (mr.targetId = m.id AND mr.sourceId = ?)
                                 OR (mr.sourceId = m.id AND mr.targetId = ?)
    LIMIT 10
  `).all(id, id) as MemoryRow[]
  return rows.map(mapMemory)
}

export function getMemoriesByTag(tag: string) {
  const rows = getDb().prepare(
    'SELECT * FROM memories WHERE tags LIKE ? ORDER BY updatedAt DESC'
  ).all(`%"${tag}"%`) as MemoryRow[]
  return rows.map(mapMemory)
}

// ── Bulk tag operations (logic in tag-ops.ts) ────────────────────────────────

export function getTagCounts(): Array<{ tag: string; count: number }> {
  const rows = getDb().prepare('SELECT tags FROM memories').all() as Array<{ tags: string | null }>
  return countTags(rows.map(r => r.tags))
}

/**
 * Rename a tag across every memory that carries it. Returns the number of
 * rows changed. Renaming to an existing tag merges (the list is deduped).
 * Note: only the tags JSON is touched — updatedAt is deliberately not bumped
 * so a bulk rename doesn't shuffle the Recent ordering.
 */
export function renameTag(from: string, to: string): number {
  const d = getDb()
  // LIKE prefilter narrows the scan; applyTagRename gives the exact answer.
  const rows = d.prepare('SELECT id, tags FROM memories WHERE tags LIKE ?')
    .all(`%"${from}"%`) as Array<{ id: string; tags: string | null }>
  const update = d.prepare('UPDATE memories SET tags = ? WHERE id = ?')
  let changed = 0
  const run = d.transaction(() => {
    for (const row of rows) {
      const next = applyTagRename(row.tags, from, to)
      if (next !== null) { update.run(next, row.id); changed++ }
    }
  })
  run()
  return changed
}

/** Remove a tag from every memory that carries it. Returns rows changed. */
export function deleteTag(tag: string): number {
  const d = getDb()
  const rows = d.prepare('SELECT id, tags FROM memories WHERE tags LIKE ?')
    .all(`%"${tag}"%`) as Array<{ id: string; tags: string | null }>
  const update = d.prepare('UPDATE memories SET tags = ? WHERE id = ?')
  let changed = 0
  const run = d.transaction(() => {
    for (const row of rows) {
      const next = applyTagDelete(row.tags, tag)
      if (next !== null) { update.run(next, row.id); changed++ }
    }
  })
  run()
  return changed
}

export function getStats() {
  const d = getDb()
  const total = (d.prepare('SELECT COUNT(*) as total FROM memories').get() as { total: number }).total
  const rows = d.prepare('SELECT source, COUNT(*) as count FROM memories GROUP BY source').all() as Array<{ source: string; count: number }>
  const bySource: Record<string, number> = {}
  rows.forEach(r => { bySource[r.source] = r.count })
  return { total, bySource }
}

export function getAllRelationships() {
  const rows = getDb().prepare('SELECT * FROM memory_relationships').all() as RelationshipRow[]
  return rows.map(mapRelationship)
}

export function getRelationshipsForMemory(memoryId: string) {
  const rows = getDb().prepare(
    'SELECT * FROM memory_relationships WHERE sourceId = ? OR targetId = ?'
  ).all(memoryId, memoryId) as RelationshipRow[]
  return rows.map(mapRelationship)
}

export function deleteRelationship(id: string) {
  getDb().prepare('DELETE FROM memory_relationships WHERE id = ?').run(id)
  return { success: true }
}

// ── Vector search (sqlite-vec, optional) ─────────────────────────────────────

export function storeEmbedding(memoryId: string, vector: number[]): void {
  if (!vectorSearchEnabled) return
  if (vector.length !== EMBEDDING_DIM) {
    log.warn(`[db] embedding dim mismatch: got ${vector.length}, want ${EMBEDDING_DIM}`)
    return
  }
  const d = getDb()
  // sqlite-vec's vec0 virtual table doesn't honor INSERT OR REPLACE — the
  // conflict resolution path throws "UNIQUE constraint failed". Emulate
  // upsert manually with DELETE then INSERT. Wrapped in a transaction so the
  // row is never observably missing.
  const buf = Buffer.from(new Float32Array(vector).buffer)
  const upsert = d.transaction((id: string, b: Buffer) => {
    d.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(id)
    d.prepare('INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)').run(id, b)
  })
  upsert(memoryId, buf)
}

export function vectorSearch(queryVector: number[], limit = 10): Array<{ memory_id: string; distance: number }> {
  if (!vectorSearchEnabled) return []
  if (queryVector.length !== EMBEDDING_DIM) return []
  const d = getDb()
  const buf = Buffer.from(new Float32Array(queryVector).buffer)
  // vec0 KNN: `MATCH` triggers similarity search; ORDER BY distance + LIMIT k.
  const rows = d.prepare(`
    SELECT memory_id, distance
    FROM memory_vectors
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(buf, limit) as Array<{ memory_id: string; distance: number }>
  return rows
}

export function getEmbeddedMemoryIds(): Set<string> {
  if (!vectorSearchEnabled) return new Set()
  const rows = getDb().prepare('SELECT memory_id FROM memory_vectors').all() as Array<{ memory_id: string }>
  return new Set(rows.map(r => r.memory_id))
}

export function countEmbeddings(): number {
  if (!vectorSearchEnabled) return 0
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM memory_vectors').get() as { n: number }
  return row.n
}

// ── Vault files ───────────────────────────────────────────────────────────────

type VaultFileRow = {
  id: string
  filepath: string
  filename: string
  extension: string
  content: string | null
  size: number
  last_modified: number
  indexed_at: number
  frontmatter_url: string | null
  linked_memory_id: string | null
}

function mapVaultFile(r: VaultFileRow) {
  return {
    id: r.id,
    filepath: r.filepath,
    filename: r.filename,
    extension: r.extension,
    content: r.content ?? '',
    size: r.size,
    lastModified: r.last_modified,
    indexedAt: r.indexed_at,
    frontmatterUrl: r.frontmatter_url ?? null,
    linkedMemoryId: r.linked_memory_id ?? null,
  }
}

export function upsertVaultFile(data: {
  filepath: string
  filename: string
  extension: string
  content: string | null
  size: number
  lastModified: number
  frontmatterUrl?: string | null
  linkedMemoryId?: string | null
}): void {
  const d = getDb()
  const existing = d.prepare('SELECT id FROM vault_files WHERE filepath = ?').get(data.filepath) as { id: string } | undefined
  const id = existing?.id ?? randomUUID()
  const now = Date.now()
  d.prepare(
    'INSERT OR REPLACE INTO vault_files (id, filepath, filename, extension, content, size, last_modified, indexed_at, frontmatter_url, linked_memory_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id, data.filepath, data.filename, data.extension, data.content ?? null,
    data.size, data.lastModified, now,
    data.frontmatterUrl ?? null, data.linkedMemoryId ?? null,
  )
}

export function getVaultFileByPath(filepath: string): ReturnType<typeof mapVaultFile> | null {
  const row = getDb().prepare('SELECT * FROM vault_files WHERE filepath = ?').get(filepath) as VaultFileRow | undefined
  return row ? mapVaultFile(row) : null
}

export function getVaultFileById(id: string): ReturnType<typeof mapVaultFile> | null {
  const row = getDb().prepare('SELECT * FROM vault_files WHERE id = ?').get(id) as VaultFileRow | undefined
  return row ? mapVaultFile(row) : null
}

/**
 * List vault files for the graph / Files sidebar / search.
 *
 * Hides files whose `linked_memory_id` is set — those are the same
 * conversation as an existing memory (P0 #1 part 2 cross-pipeline absorption).
 * Showing both the memory node and the file node for one conversation is the
 * "duplicate in the graph" symptom we're solving. The memory is canonical;
 * the file is suppressed.
 *
 * Callers that genuinely need every file (admin tools, future "show linked"
 * toggle, integrity scans) should add a new function rather than passing a
 * flag through here — keeps the default safe.
 */
export function getAllVaultFiles(): ReturnType<typeof mapVaultFile>[] {
  const rows = getDb().prepare(
    'SELECT * FROM vault_files WHERE linked_memory_id IS NULL ORDER BY last_modified DESC'
  ).all() as VaultFileRow[]
  return rows.map(mapVaultFile)
}

export function deleteVaultFileByPath(filepath: string): void {
  const d = getDb()
  const row = d.prepare('SELECT id FROM vault_files WHERE filepath = ?').get(filepath) as { id: string } | undefined
  if (!row) return
  if (vectorSearchEnabled) {
    try { d.prepare('DELETE FROM vault_vectors WHERE file_id = ?').run(row.id) } catch (_) {}
  }
  d.prepare('DELETE FROM vault_files WHERE filepath = ?').run(filepath)
}

export function deleteVaultFileById(id: string): void {
  const d = getDb()
  if (vectorSearchEnabled) {
    try { d.prepare('DELETE FROM vault_vectors WHERE file_id = ?').run(id) } catch (_) {}
  }
  d.prepare('DELETE FROM vault_files WHERE id = ?').run(id)
}

export function searchVaultFiles(query: string): ReturnType<typeof mapVaultFile>[] {
  // Excludes linked files — same rationale as getAllVaultFiles. The memory
  // for that conversation will surface via searchMemories instead, so the
  // user still finds it; they just don't see two hits for the same content.
  const escaped = escapeLike(query)
  const rows = getDb().prepare(
    "SELECT * FROM vault_files WHERE linked_memory_id IS NULL AND (filename LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY last_modified DESC LIMIT 50"
  ).all(`%${escaped}%`, `%${escaped}%`) as VaultFileRow[]
  return rows.map(mapVaultFile)
}

export function storeVaultEmbedding(fileId: string, vector: number[]): void {
  if (!vectorSearchEnabled) return
  if (vector.length !== EMBEDDING_DIM) return
  const d = getDb()
  // Same vec0 limitation as storeEmbedding above — DELETE+INSERT instead of
  // INSERT OR REPLACE.
  const buf = Buffer.from(new Float32Array(vector).buffer)
  const upsert = d.transaction((id: string, b: Buffer) => {
    d.prepare('DELETE FROM vault_vectors WHERE file_id = ?').run(id)
    d.prepare('INSERT INTO vault_vectors (file_id, embedding) VALUES (?, ?)').run(id, b)
  })
  upsert(fileId, buf)
}

export function vectorSearchVaultFiles(queryVector: number[], limit = 10): Array<{ file_id: string; distance: number }> {
  if (!vectorSearchEnabled) return []
  if (queryVector.length !== EMBEDDING_DIM) return []
  const d = getDb()
  const buf = Buffer.from(new Float32Array(queryVector).buffer)
  const rows = d.prepare(
    'SELECT file_id, distance FROM vault_vectors WHERE embedding MATCH ? ORDER BY distance LIMIT ?'
  ).all(buf, limit) as Array<{ file_id: string; distance: number }>
  return rows
}

export function getEmbeddedVaultFileIds(): Set<string> {
  if (!vectorSearchEnabled) return new Set()
  const rows = getDb().prepare('SELECT file_id FROM vault_vectors').all() as Array<{ file_id: string }>
  return new Set(rows.map(r => r.file_id))
}
