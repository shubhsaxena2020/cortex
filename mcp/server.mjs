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
  }
}

function buildQueries(d) {
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
        semanticSearch: hasVec,
        topTags,
      }
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

  const handle = createRpcHandler({
    queries,
    embed,
    hasVec: () => hasVec,
    newId: () => randomUUID(),
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
