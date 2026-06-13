#!/usr/bin/env node
// mcp/server.mjs — Cortex MCP server (stdio transport).
//
// Wraps %APPDATA%\Cortex\memories.db so MCP clients (Claude Code, Claude
// Desktop) can query the second brain as native tool calls.
//
// MUST run under Electron-as-Node — better-sqlite3 in this repo is compiled
// for Electron's ABI and will not load under system Node:
//
//   command: node_modules\electron\dist\electron.exe
//   args:    ["mcp/server.mjs"]
//   env:     { "ELECTRON_RUN_AS_NODE": "1" }
//
// Protocol: newline-delimited JSON-RPC 2.0 on stdio (see mcp/core.mjs).
// stdout carries ONLY protocol frames; all logging goes to stderr.

import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { createRpcHandler, toFtsPhrase, escapeLike } from './core.mjs'
// Inlined to keep server.mjs the single MCP runtime entry — duplicating the
// 30-line digest grouper here is preferable to a third file the MCP server
// has to import, and the pure version lives in src/main/digest.ts for tests.
function buildDigestPure(window, memories, now) {
  const ms = window === 'week' ? 7 * 24 * 3600_000 : 24 * 3600_000
  const since = now - ms
  const tagCounts = new Map()
  for (const m of memories) for (const t of m.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([tag, count]) => ({ tag, count }))
  const topSet = new Set(topTags.map((t) => t.tag))
  const groupsMap = new Map()
  for (const t of topTags) groupsMap.set(t.tag, [])
  const untagged = []
  for (const m of memories) {
    const primary = m.tags.find((t) => topSet.has(t))
    if (primary) groupsMap.get(primary).push(m)
    else if (m.tags.length === 0) untagged.push(m)
    else {
      const other = m.tags[0]
      let arr = groupsMap.get(other); if (!arr) { arr = []; groupsMap.set(other, arr) }
      arr.push(m)
    }
  }
  const groups = []
  for (const t of topTags) {
    const arr = groupsMap.get(t.tag) ?? []
    if (arr.length) groups.push({ label: t.tag, memories: arr.slice(0, 5) })
  }
  const tail = []
  for (const [tag, arr] of groupsMap) { if (!topSet.has(tag)) tail.push(...arr) }
  if (tail.length) groups.push({ label: 'other', memories: tail.slice(0, 5) })
  if (untagged.length) groups.push({ label: '(untagged)', memories: untagged.slice(0, 5) })
  return { window, since, until: now, totalMemories: memories.length, groups, topTags, untaggedCount: untagged.length }
}

const DB_PATH = process.env.CORTEX_DB_PATH || `${process.env.APPDATA}\\Cortex\\memories.db`
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const EMBED_MODEL = process.env.CORTEX_EMBED_MODEL || 'all-minilm'
const EMBEDDING_DIM = 384
const MAX_INPUT_CHARS = 4000
const EMBED_TIMEOUT_MS = 5000

const logErr = (...parts) => console.error('[cortex-mcp]', ...parts)

// ── DB setup ──────────────────────────────────────────────────────────────────

let db = null
let hasVec = false

async function openDb() {
  if (db) return db
  if (!existsSync(DB_PATH)) {
    throw new Error(`Cortex DB not found at ${DB_PATH} — launch the Cortex app once to create it`)
  }
  const Database = (await import('better-sqlite3')).default
  db = new Database(DB_PATH)
  // The Cortex app may hold the WAL write lock; wait briefly instead of
  // throwing SQLITE_BUSY at the MCP client.
  db.pragma('busy_timeout = 3000')
  db.pragma('journal_mode = WAL')

  try {
    const vecModule = await import('sqlite-vec')
    // Named export, not default — db.ts imports it as a namespace.
    const getLoadablePath = vecModule.getLoadablePath ?? vecModule.default?.getLoadablePath
    if (!getLoadablePath) throw new Error('getLoadablePath missing from sqlite-vec exports')
    db.loadExtension(getLoadablePath())
    hasVec = true
    logErr('sqlite-vec loaded — semantic search enabled')
  } catch (err) {
    hasVec = false
    logErr('sqlite-vec unavailable — keyword search only:', err.message)
  }
  return db
}

// ── Query layer (mirrors src/main/db.ts row shapes) ──────────────────────────

function mapMemory(r) {
  return {
    id: r.id,
    title: r.title,
    content: r.content ?? '',
    timestamp: r.timestamp,
    updatedAt: r.updatedAt,
    source: r.source,
    tags: JSON.parse(r.tags || '[]'),
    url: r.url ?? null,
    pinned: !!(r.pinned ?? 0),
  }
}

function mapSummaryRow(r) {
  if (!r) return null
  return {
    memoryId: r.memory_id,
    oneLine: r.one_line,
    paragraph: r.paragraph,
    contentHash: r.content_hash,
    model: r.model,
    createdAt: r.created_at,
  }
}

function buildQueries(d) {
  // db reference for the journal/extract callbacks in main()
  globalThis.__cortexDb = d
  return {
    searchMemories(query, source, tags) {
      const phrase = toFtsPhrase(query)
      if (phrase) {
        let sql = `
          SELECT m.* FROM memories m
          JOIN memories_fts f ON f.memory_id = m.id
          WHERE memories_fts MATCH ?
        `
        const params = [phrase]
        if (source) { sql += ' AND m.source = ?'; params.push(source) }
        for (const t of tags ?? []) {
          sql += " AND m.tags LIKE ? ESCAPE '\\'"
          params.push(`%"${escapeLike(t)}"%`)
        }
        sql += ' ORDER BY m.updatedAt DESC LIMIT 50'
        try {
          return d.prepare(sql).all(...params).map(mapMemory)
        } catch (err) {
          logErr('FTS5 search failed, falling back to LIKE:', err.message)
        }
      }
      const escaped = escapeLike(query)
      let sql = "SELECT * FROM memories WHERE (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')"
      const params = [`%${escaped}%`, `%${escaped}%`]
      if (source) { sql += ' AND source = ?'; params.push(source) }
      for (const t of tags ?? []) {
        sql += " AND tags LIKE ? ESCAPE '\\'"
        params.push(`%"${escapeLike(t)}"%`)
      }
      sql += ' ORDER BY updatedAt DESC LIMIT 50'
      return d.prepare(sql).all(...params).map(mapMemory)
    },

    getMemory(id) {
      const row = d.prepare('SELECT * FROM memories WHERE id = ?').get(id)
      return row ? mapMemory(row) : null
    },

    listMemories({ limit, tags, source }) {
      let sql = 'SELECT * FROM memories WHERE 1=1'
      const params = []
      if (source) { sql += ' AND source = ?'; params.push(source) }
      for (const t of tags ?? []) {
        sql += " AND tags LIKE ? ESCAPE '\\'"
        params.push(`%"${escapeLike(t)}"%`)
      }
      sql += ' ORDER BY updatedAt DESC LIMIT ?'
      params.push(limit)
      return d.prepare(sql).all(...params).map(mapMemory)
    },

    createMemory(id, title, content, source, tags) {
      const now = Date.now()
      const write = d.transaction(() => {
        d.prepare(
          'INSERT OR REPLACE INTO memories (id, title, content, timestamp, updatedAt, source, tags, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(id, title, content, now, now, source, JSON.stringify(tags), null)
        // FTS5 doesn't honour INSERT OR REPLACE — DELETE+INSERT, same as db.ts.
        d.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id)
        d.prepare('INSERT INTO memories_fts (memory_id, title, content) VALUES (?, ?, ?)').run(id, title, content)
      })
      write()
      return { id, title, content, timestamp: now, updatedAt: now, source, tags, url: null }
    },

    getRelationshipsForMemory(id) {
      return d.prepare(
        'SELECT * FROM memory_relationships WHERE sourceId = ? OR targetId = ?'
      ).all(id, id).map((r) => ({
        id: r.id,
        sourceId: r.sourceId,
        targetId: r.targetId,
        relationship: r.relationship,
        strength: r.strength ?? 0,
        signal_type: r.signal_type ?? 'manual',
      }))
    },

    vectorSearch(vector, limit) {
      if (!hasVec || vector.length !== EMBEDDING_DIM) return []
      const buf = Buffer.from(new Float32Array(vector).buffer)
      return d.prepare(`
        SELECT memory_id, distance FROM memory_vectors
        WHERE embedding MATCH ? ORDER BY distance LIMIT ?
      `).all(buf, limit)
    },

    storeEmbedding(id, vector) {
      if (!hasVec || vector.length !== EMBEDDING_DIM) return
      const buf = Buffer.from(new Float32Array(vector).buffer)
      const upsert = d.transaction(() => {
        d.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(id)
        d.prepare('INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)').run(id, buf)
      })
      upsert()
    },

    stats() {
      const memories = d.prepare('SELECT COUNT(*) AS n FROM memories').get().n
      const bySource = {}
      for (const r of d.prepare('SELECT source, COUNT(*) AS n FROM memories GROUP BY source').all()) {
        bySource[r.source ?? '(none)'] = r.n
      }
      const relationships = d.prepare('SELECT COUNT(*) AS n FROM memory_relationships').get().n
      const bySignal = {}
      for (const r of d.prepare('SELECT signal_type, COUNT(*) AS n FROM memory_relationships GROUP BY signal_type').all()) {
        bySignal[r.signal_type ?? 'manual'] = r.n
      }
      let embedded = 0
      if (hasVec) {
        try { embedded = d.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get().n } catch { /* table absent */ }
      }
      let summarized = 0
      try { summarized = d.prepare('SELECT COUNT(*) AS n FROM memory_summaries').get().n } catch { /* table absent on pre-v7 */ }
      let pinned = 0
      try { pinned = d.prepare('SELECT COUNT(*) AS n FROM memories WHERE pinned = 1').get().n } catch { /* pinned column absent */ }
      const tagCounts = new Map()
      for (const r of d.prepare('SELECT tags FROM memories').all()) {
        for (const t of JSON.parse(r.tags || '[]')) {
          tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
        }
      }
      const topTags = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([tag, count]) => ({ tag, count }))
      return {
        dbPath: DB_PATH,
        memories,
        bySource,
        relationships,
        bySignal,
        embedded,
        summarized,
        pinned,
        semanticSearch: hasVec,
        topTags,
      }
    },

    // v0.4 additions
    listPinned() {
      // Pinned column missing on pre-v7 DBs — fall back to empty list instead
      // of throwing so the MCP server keeps working against an older app DB.
      try {
        return d.prepare(`SELECT * FROM memories WHERE pinned = 1 ORDER BY updatedAt DESC LIMIT 10`).all().map(mapMemory)
      } catch {
        return []
      }
    },
    setPinned(id, p) {
      try {
        d.prepare('UPDATE memories SET pinned = ? WHERE id = ?').run(p ? 1 : 0, id)
      } catch (err) {
        logErr('setPinned failed (column missing?):', err.message)
      }
    },
    getSummary(id) {
      try {
        return mapSummaryRow(d.prepare('SELECT * FROM memory_summaries WHERE memory_id = ?').get(id))
      } catch {
        return null
      }
    },
    getSummaries(ids) {
      const out = new Map()
      if (ids.length === 0) return out
      try {
        const sql = `SELECT * FROM memory_summaries WHERE memory_id IN (${ids.map(() => '?').join(',')})`
        for (const row of d.prepare(sql).all(...ids)) {
          out.set(row.memory_id, mapSummaryRow(row))
        }
      } catch { /* table absent */ }
      return out
    },
    getMemoriesSince(since, limit = 200) {
      return d.prepare(
        'SELECT * FROM memories WHERE updatedAt >= ? ORDER BY updatedAt DESC LIMIT ?'
      ).all(since, limit).map(mapMemory)
    },
    getDerived(parentId) {
      try {
        return d.prepare("SELECT * FROM memories WHERE derived_from = ? ORDER BY timestamp ASC").all(parentId).map(mapMemory)
      } catch { return [] }
    },
  }
}

// ── Ollama embedding (mirrors src/main/embeddings.ts; null on any failure) ───

async function embed(text) {
  const trimmed = String(text ?? '').trim().slice(0, MAX_INPUT_CHARS)
  if (!trimmed) return null
  try {
    const r = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: trimmed }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    })
    if (!r.ok) return null
    const body = await r.json()
    const vec = body.embeddings?.[0]
    return Array.isArray(vec) && vec.length === EMBEDDING_DIM ? vec : null
  } catch {
    return null
  }
}

// ── Stdio loop ────────────────────────────────────────────────────────────────

async function main() {
  let queries
  try {
    queries = buildQueries(await openDb())
  } catch (err) {
    // Start anyway: a server that answers initialize and reports the problem
    // per-call beats one that crash-loops the client's connection UI.
    logErr('DB open failed:', err.message)
    const failure = () => { throw new Error(err.message) }
    queries = new Proxy({}, { get: () => failure })
  }

  // Digest, extract, journal wired here (not in core.mjs) so the pure core
  // stays DB-free. Extract is a stub in the MCP server — actual extraction
  // happens in the Electron app via the IPC bridge. The MCP server CAN'T
  // run Ollama generation safely from a child process (long blocking call,
  // unbounded duration, would tie up the MCP connection). So we surface a
  // helpful error here when the tool's called outside the app context.
  const handle = createRpcHandler({
    queries,
    embed,
    hasVec: () => hasVec,
    newId: () => randomUUID(),
    extract: async (parentId) => {
      // Stub: the MCP server has no Ollama-bound runner. Instead, advise
      // the caller to either run the in-app extraction or wait for the
      // app's startup backfill.
      const existing = queries.getDerived?.(parentId) ?? []
      logErr(`extract requested for ${parentId.slice(0, 8)}: returning ${existing.length} cached learnings`)
      return existing.map((m) => m.id)
    },
    journal: {
      today: () => {
        const db = globalThis.__cortexDb
        if (!db) return null
        try {
          const now = Date.now()
          const date = new Date(now)
          const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
          const end = start + 86_400_000
          const row = db.prepare(
            "SELECT * FROM memories WHERE source = 'journal' AND timestamp >= ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 1"
          ).get(start, end)
          return row ? mapMemory(row) : null
        } catch { return null }
      },
      upsert: (content) => {
        const db = globalThis.__cortexDb
        if (!db) return null
        const id = randomUUID()
        const now = Date.now()
        const date = new Date(now)
        const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
        const end = start + 86_400_000
        const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        const title = `Journal — ${dayKey}`
        try {
          const existing = db.prepare(
            "SELECT id FROM memories WHERE source = 'journal' AND timestamp >= ? AND timestamp < ? LIMIT 1"
          ).get(start, end)
          if (existing) {
            const tx = db.transaction(() => {
              db.prepare("UPDATE memories SET content = ?, updatedAt = ? WHERE id = ?").run(content, now, existing.id)
              db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(existing.id)
              db.prepare('INSERT INTO memories_fts (memory_id, title, content) VALUES (?, ?, ?)').run(existing.id, title, content)
            })
            tx()
            return { id: existing.id, title, content, source: 'journal', tags: ['journal'], updatedAt: now }
          }
          const tx = db.transaction(() => {
            db.prepare(
              `INSERT INTO memories (id, title, content, timestamp, updatedAt, source, tags, url, pinned, derived_from)
               VALUES (?, ?, ?, ?, ?, 'journal', ?, NULL, 0, NULL)`
            ).run(id, title, content, start, now, JSON.stringify(['journal']))
            db.prepare('INSERT INTO memories_fts (memory_id, title, content) VALUES (?, ?, ?)').run(id, title, content)
          })
          tx()
          return { id, title, content, source: 'journal', tags: ['journal'], updatedAt: now }
        } catch (err) {
          logErr('journal upsert failed:', err.message)
          return null
        }
      },
    },
    digest(window) {
      const ms = window === 'week' ? 7 * 24 * 3600_000 : 24 * 3600_000
      const since = Date.now() - ms
      const memories = queries.getMemoriesSince(since)
      const summaryMap = queries.getSummaries(memories.map((m) => m.id))
      const slim = memories.map((m) => ({
        id: m.id,
        title: m.title,
        source: m.source,
        tags: m.tags,
        updatedAt: m.updatedAt,
        oneLine: summaryMap.get(m.id)?.oneLine ?? null,
      }))
      return buildDigestPure(window, slim, Date.now())
    },
  })

  const rl = createInterface({ input: process.stdin, terminal: false })
  rl.on('line', async (line) => {
    const text = line.trim()
    if (!text) return
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' },
      }) + '\n')
      return
    }
    const response = await handle(msg)
    if (response) process.stdout.write(JSON.stringify(response) + '\n')
  })

  rl.on('close', () => {
    try { db?.close() } catch { /* already closed */ }
    process.exit(0)
  })

  logErr(`ready — db=${DB_PATH} vec=${hasVec} ollama=${OLLAMA_URL}`)
}

main().catch((err) => {
  logErr('fatal:', err)
  process.exit(1)
})
