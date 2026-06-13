#!/usr/bin/env node
// cortex CLI — terminal companion for the second brain (v0.4 thesis #1).
//
// Runs under Electron-as-Node (better-sqlite3 ABI) — same launch pattern as
// mcp/server.mjs. Installed as `cortex` on PATH via npm scripts.
//
// Commands:
//   cortex search <query> [--mode auto|keyword|semantic] [--limit N] [--tag T] [--source S]
//   cortex recent [--tag T] [--source S] [--limit N]
//   cortex digest [--week]
//   cortex export <id> [--format md|json]
//   cortex stats
//   cortex tags
//   cortex pinned
//   cortex pin <id>
//   cortex unpin <id>
//   cortex help

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import process from 'node:process'

const DB_PATH = process.env.CORTEX_DB_PATH || `${process.env.APPDATA}\\Cortex\\memories.db`
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const EMBED_MODEL = process.env.CORTEX_EMBED_MODEL || 'all-minilm'
const EMBEDDING_DIM = 384

// ── ANSI colors (skipped on non-TTY for clean piping into less, grep, etc.) ─
const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const C = useColor
  ? { dim: (s) => `\x1b[2m${s}\x1b[22m`, bold: (s) => `\x1b[1m${s}\x1b[22m`, cyan: (s) => `\x1b[36m${s}\x1b[39m`, yellow: (s) => `\x1b[33m${s}\x1b[39m`, red: (s) => `\x1b[31m${s}\x1b[39m`, green: (s) => `\x1b[32m${s}\x1b[39m` }
  : { dim: (s) => s, bold: (s) => s, cyan: (s) => s, yellow: (s) => s, red: (s) => s, green: (s) => s }

function die(msg, code = 1) { process.stderr.write(`${C.red('error:')} ${msg}\n`); process.exit(code) }

// ── Argument parsing — tiny, no library. Order: positional cmd, then flags ──
function parseArgs(argv) {
  const out = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next == null || next.startsWith('--')) { out.flags[key] = true } else { out.flags[key] = next; i++ }
    } else {
      out._.push(a)
    }
  }
  return out
}

// ── DB setup ────────────────────────────────────────────────────────────────
if (!existsSync(DB_PATH)) die(`Cortex DB not found at ${DB_PATH}\nLaunch the Cortex app once to create it.`)

const Database = (await import('better-sqlite3')).default
const db = new Database(DB_PATH, { readonly: false })
db.pragma('busy_timeout = 3000')
db.pragma('journal_mode = WAL')

let hasVec = false
try {
  const vecModule = await import('sqlite-vec')
  const getLoadablePath = vecModule.getLoadablePath ?? vecModule.default?.getLoadablePath
  db.loadExtension(getLoadablePath())
  hasVec = true
} catch { /* keyword-only fallback */ }

// ── Reused query helpers (mirror mcp/server.mjs) ────────────────────────────
function escapeLike(s) { return String(s).replace(/[\\%_]/g, (m) => '\\' + m) }
function toFtsPhrase(query) {
  const t = String(query ?? '').trim()
  if (!t || !/[\p{L}\p{N}]/u.test(t)) return null
  return `"${t.replace(/"/g, '""')}"`
}
function mapMemory(r) {
  return {
    id: r.id, title: r.title, content: r.content ?? '',
    timestamp: r.timestamp, updatedAt: r.updatedAt, source: r.source,
    tags: JSON.parse(r.tags || '[]'), url: r.url ?? null, pinned: !!(r.pinned ?? 0),
  }
}
function getSummary(id) {
  try {
    const r = db.prepare('SELECT one_line, paragraph FROM memory_summaries WHERE memory_id = ?').get(id)
    return r ?? null
  } catch { return null }
}

function searchMemories(query, opts = {}) {
  const phrase = toFtsPhrase(query)
  const params = []
  let sql
  if (phrase) {
    sql = `SELECT m.* FROM memories m JOIN memories_fts f ON f.memory_id = m.id WHERE memories_fts MATCH ?`
    params.push(phrase)
  } else {
    const esc = escapeLike(query)
    sql = `SELECT * FROM memories WHERE (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')`
    params.push(`%${esc}%`, `%${esc}%`)
  }
  if (opts.source) { sql += ' AND ' + (phrase ? 'm.' : '') + 'source = ?'; params.push(opts.source) }
  if (opts.tag) { sql += ` AND ${phrase ? 'm.' : ''}tags LIKE ? ESCAPE '\\'`; params.push(`%"${escapeLike(opts.tag)}"%`) }
  sql += ` ORDER BY ${phrase ? 'm.' : ''}updatedAt DESC LIMIT ?`
  params.push(opts.limit ?? 10)
  try {
    return db.prepare(sql).all(...params).map(mapMemory)
  } catch (err) {
    process.stderr.write(C.dim(`FTS5 error, fell back to LIKE: ${err.message}\n`))
    return []
  }
}

async function semanticSearch(query, limit) {
  if (!hasVec) return null
  // Embed via Ollama; null on failure (caller falls back to keyword).
  try {
    const r = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: query }),
      signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) return null
    const body = await r.json()
    const vec = body.embeddings?.[0]
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) return null
    const buf = Buffer.from(new Float32Array(vec).buffer)
    const hits = db.prepare(
      'SELECT memory_id, distance FROM memory_vectors WHERE embedding MATCH ? ORDER BY distance LIMIT ?'
    ).all(buf, limit * 2)
    const out = []
    for (const h of hits) {
      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(h.memory_id)
      if (row) out.push({ memory: mapMemory(row), distance: h.distance })
      if (out.length >= limit) break
    }
    return out
  } catch { return null }
}

function getPinned() {
  try { return db.prepare("SELECT * FROM memories WHERE pinned = 1 ORDER BY updatedAt DESC").all().map(mapMemory) }
  catch { return [] }
}
function setPinned(id, pinned) {
  try { db.prepare('UPDATE memories SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id); return true }
  catch (err) { process.stderr.write(C.red(`pin failed (DB on old schema?): ${err.message}\n`)); return false }
}

// ── Render helpers ──────────────────────────────────────────────────────────
function relTime(ms) {
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return `${Math.floor(d / 7)}w ago`
}
function truncate(s, n) {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= n ? flat : flat.slice(0, n - 1) + '…'
}
function renderHit(m, opts = {}) {
  const summary = getSummary(m.id)
  const sub = summary?.oneLine ?? truncate(m.content, 120)
  const idShort = m.id.slice(0, 8)
  const pin = m.pinned ? C.yellow('★ ') : ''
  const tags = m.tags.length ? C.dim(' [' + m.tags.slice(0, 3).join(' ') + ']') : ''
  process.stdout.write(`${pin}${C.bold(m.title)}  ${C.dim(idShort)} ${C.dim(relTime(m.updatedAt))}${tags}\n`)
  if (sub) process.stdout.write(`  ${C.dim(sub)}\n`)
  if (opts.showDistance && opts.distance != null) process.stdout.write(`  ${C.dim('distance: ' + opts.distance.toFixed(3))}\n`)
}

// ── Commands ─────────────────────────────────────────────────────────────────
async function cmdSearch(args) {
  const query = args._.slice(1).join(' ')
  if (!query) die('usage: cortex search <query> [--mode auto|keyword|semantic] [--limit N]')
  const mode = ['auto', 'keyword', 'semantic'].includes(args.flags.mode) ? args.flags.mode : 'auto'
  const limit = Math.min(50, Math.max(1, parseInt(args.flags.limit ?? '10', 10)))
  const opts = { limit, tag: args.flags.tag, source: args.flags.source }

  const pinned = getPinned().slice(0, 3)
  if (pinned.length) {
    process.stdout.write(C.dim('— pinned —\n'))
    for (const m of pinned) renderHit(m)
    process.stdout.write('\n')
  }

  if (mode !== 'keyword' && hasVec) {
    const hits = await semanticSearch(query, limit)
    if (hits && hits.length) {
      process.stdout.write(C.dim(`— semantic (${hits.length}) —\n`))
      for (const h of hits) {
        if (opts.tag && !h.memory.tags.includes(opts.tag)) continue
        if (opts.source && h.memory.source !== opts.source) continue
        renderHit(h.memory, { showDistance: true, distance: h.distance })
      }
      return
    }
    if (mode === 'semantic') { process.stdout.write(C.yellow('Ollama unavailable; falling back to keyword.\n')) }
  }
  const rows = searchMemories(query, opts)
  process.stdout.write(C.dim(`— keyword (${rows.length}) —\n`))
  for (const m of rows) renderHit(m)
  if (!rows.length) process.stdout.write(C.dim('no matches\n'))
}

function cmdRecent(args) {
  const limit = Math.min(50, Math.max(1, parseInt(args.flags.limit ?? '20', 10)))
  const params = []
  let sql = 'SELECT * FROM memories WHERE 1=1'
  if (args.flags.source) { sql += ' AND source = ?'; params.push(args.flags.source) }
  if (args.flags.tag) { sql += " AND tags LIKE ? ESCAPE '\\'"; params.push(`%"${escapeLike(args.flags.tag)}"%`) }
  sql += ' ORDER BY updatedAt DESC LIMIT ?'
  params.push(limit)
  const rows = db.prepare(sql).all(...params).map(mapMemory)
  for (const m of rows) renderHit(m)
  if (!rows.length) process.stdout.write(C.dim('no memories\n'))
}

function cmdStats() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n
  const rels = db.prepare('SELECT COUNT(*) AS n FROM memory_relationships').get().n
  let embedded = 0, summarized = 0, pinned = 0
  if (hasVec) try { embedded = db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get().n } catch {}
  try { summarized = db.prepare('SELECT COUNT(*) AS n FROM memory_summaries').get().n } catch {}
  try { pinned = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE pinned = 1').get().n } catch {}
  const bySource = db.prepare('SELECT source, COUNT(*) AS n FROM memories GROUP BY source').all()
  process.stdout.write(`${C.bold('Cortex stats')}\n`)
  process.stdout.write(`  memories:      ${total}\n`)
  process.stdout.write(`  relationships: ${rels}\n`)
  process.stdout.write(`  embedded:      ${embedded}${hasVec ? '' : C.dim(' (sqlite-vec unavailable)')}\n`)
  process.stdout.write(`  summarized:    ${summarized}\n`)
  process.stdout.write(`  pinned:        ${pinned}\n`)
  process.stdout.write(`  by source:     ${bySource.map((r) => `${r.source}=${r.n}`).join(', ')}\n`)
  process.stdout.write(`  db:            ${DB_PATH}\n`)
}

function cmdTags() {
  const counts = new Map()
  for (const r of db.prepare('SELECT tags FROM memories').all()) {
    for (const t of JSON.parse(r.tags || '[]')) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  if (!sorted.length) { process.stdout.write(C.dim('no tags\n')); return }
  for (const [tag, n] of sorted) process.stdout.write(`  ${C.cyan(tag.padEnd(28))} ${C.dim(n)}\n`)
}

function cmdPinned() {
  const rows = getPinned()
  if (!rows.length) { process.stdout.write(C.dim('no pinned memories\n')); return }
  for (const m of rows) renderHit(m)
}

function cmdPin(args) {
  const id = args._[1]
  if (!id) die('usage: cortex pin <id>')
  const row = db.prepare('SELECT id, title FROM memories WHERE id = ? OR id LIKE ?').get(id, id + '%')
  if (!row) die(`no memory matching "${id}"`)
  if (setPinned(row.id, true)) process.stdout.write(`${C.yellow('★ pinned')} ${C.bold(row.title)} ${C.dim(row.id.slice(0, 8))}\n`)
}
function cmdUnpin(args) {
  const id = args._[1]
  if (!id) die('usage: cortex unpin <id>')
  const row = db.prepare('SELECT id, title FROM memories WHERE id = ? OR id LIKE ?').get(id, id + '%')
  if (!row) die(`no memory matching "${id}"`)
  if (setPinned(row.id, false)) process.stdout.write(`unpinned ${C.bold(row.title)} ${C.dim(row.id.slice(0, 8))}\n`)
}

// ── v0.5: add + journal ─────────────────────────────────────────────────────
function escapeFts(s) { return s }
function cmdAdd(args) {
  // `cortex add "text" [--tag T] [--source cli]`
  // Pulls text from stdin when piped: `echo "thought" | cortex add`
  let text = args._.slice(1).join(' ')
  if (!text && !process.stdin.isTTY) {
    text = readFileSync(0, 'utf8').trim()
  }
  if (!text) die('usage: cortex add "<text>" [--tag T] [--source S]\n       or: echo "text" | cortex add')
  const id = randomUUID()
  const tags = []
  if (args.flags.tag) tags.push(args.flags.tag)
  const source = args.flags.source ?? 'cli'
  const title = text.length > 80 ? text.slice(0, 77) + '…' : text
  const content = text
  const now = Date.now()
  // Keep INSERT to v1 columns only — pinned (v7) and derived_from (v8) take
  // their DEFAULT values when the columns exist, and an INSERT that names
  // them would fail against a pre-migration DB. The Electron app runs the
  // migrations on next launch.
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO memories (id, title, content, timestamp, updatedAt, source, tags, url)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
    ).run(id, title, content, now, now, source, JSON.stringify(tags))
    db.prepare('INSERT INTO memories_fts (memory_id, title, content) VALUES (?, ?, ?)').run(id, title, content)
  })
  tx()
  process.stdout.write(`${C.green('+ added')} ${C.bold(title)} ${C.dim(id.slice(0, 8))}\n`)
}

function cmdJournal(args) {
  // No arg: print today's entry or open $EDITOR on it.
  // With text: replace today's content with the given text.
  const today = new Date()
  const dayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const end = start + 86_400_000

  const provided = args._.slice(1).join(' ').trim()
  // Stdin pipe support: `cat thoughts.md | cortex journal`
  let textFromStdin = ''
  if (!provided && !args.flags.edit && !process.stdin.isTTY) {
    textFromStdin = readFileSync(0, 'utf8').trim()
  }
  const text = provided || textFromStdin

  const existing = db.prepare(
    "SELECT * FROM memories WHERE source = 'journal' AND timestamp >= ? AND timestamp < ? ORDER BY timestamp DESC LIMIT 1"
  ).get(start, end)

  // Pure-read path: no text, no --edit flag → show today's entry.
  if (!text && !args.flags.edit) {
    if (!existing) {
      process.stdout.write(C.dim(`No journal entry for ${dayKey}. Write one with:\n`))
      process.stdout.write(`  cortex journal "what you've been thinking"\n`)
      process.stdout.write(`  cortex journal --edit\n`)
      return
    }
    process.stdout.write(`${C.bold(`Journal — ${dayKey}`)}\n\n${existing.content}\n`)
    return
  }

  // --edit flag → open $EDITOR on a temp file seeded with the current entry.
  let content = text
  if (args.flags.edit) {
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano')
    const tmpDir = mkdtempSync(join(tmpdir(), 'cortex-journal-'))
    const tmpFile = join(tmpDir, `${dayKey}.md`)
    writeFileSync(tmpFile, existing?.content ?? `# Journal — ${dayKey}\n\n`, 'utf8')
    const r = spawnSync(editor, [tmpFile], { stdio: 'inherit' })
    if (r.status !== 0) {
      rmSync(tmpDir, { recursive: true, force: true })
      die(`editor "${editor}" returned ${r.status}`)
    }
    content = readFileSync(tmpFile, 'utf8').trim()
    rmSync(tmpDir, { recursive: true, force: true })
    if (!content) { process.stdout.write(C.dim('Empty journal entry — nothing saved.\n')); return }
  }

  const title = `Journal — ${dayKey}`
  const now = Date.now()
  if (existing) {
    const tx = db.transaction(() => {
      db.prepare("UPDATE memories SET content = ?, updatedAt = ? WHERE id = ?").run(content, now, existing.id)
      db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(existing.id)
      db.prepare('INSERT INTO memories_fts (memory_id, title, content) VALUES (?, ?, ?)').run(existing.id, title, content)
    })
    tx()
    process.stdout.write(`${C.green('✓ updated')} journal for ${dayKey}\n`)
  } else {
    const id = randomUUID()
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO memories (id, title, content, timestamp, updatedAt, source, tags, url)
         VALUES (?, ?, ?, ?, ?, 'journal', ?, NULL)`
      ).run(id, title, content, start, now, JSON.stringify(['journal']))
      db.prepare('INSERT INTO memories_fts (memory_id, title, content) VALUES (?, ?, ?)').run(id, title, content)
    })
    tx()
    process.stdout.write(`${C.green('+ journal')} ${dayKey}  ${C.dim(id.slice(0, 8))}\n`)
  }
}

function cmdExport(args) {
  const id = args._[1]
  if (!id) die('usage: cortex export <id> [--format md|json]')
  const row = db.prepare('SELECT * FROM memories WHERE id = ? OR id LIKE ?').get(id, id + '%')
  if (!row) die(`no memory matching "${id}"`)
  const m = mapMemory(row)
  const fmt = args.flags.format ?? 'md'
  if (fmt === 'json') {
    process.stdout.write(JSON.stringify(m, null, 2) + '\n')
  } else {
    process.stdout.write(`# ${m.title}\n\n`)
    process.stdout.write(`> source: ${m.source} · captured ${new Date(m.timestamp).toISOString()}`)
    if (m.tags.length) process.stdout.write(` · tags: ${m.tags.join(', ')}`)
    process.stdout.write('\n\n')
    if (m.url) process.stdout.write(`Original: ${m.url}\n\n`)
    process.stdout.write(`${m.content}\n`)
  }
}

function cmdDigest(args) {
  const window = args.flags.week ? 'week' : 'day'
  const ms = window === 'week' ? 7 * 86_400_000 : 86_400_000
  const since = Date.now() - ms
  const memories = db.prepare(
    'SELECT * FROM memories WHERE updatedAt >= ? ORDER BY updatedAt DESC LIMIT 200'
  ).all(since).map(mapMemory)
  if (!memories.length) { process.stdout.write(C.dim(`nothing captured in the last ${window}\n`)); return }
  const wLabel = window === 'day' ? 'today' : 'this week'
  process.stdout.write(`${C.bold(`Cortex digest — ${wLabel}`)}\n`)
  process.stdout.write(`${memories.length} memories\n\n`)
  // Group by top tag (matches digest.ts logic).
  const tagCounts = new Map()
  for (const m of memories) for (const t of m.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  const topSet = new Set(topTags.map(([t]) => t))
  const groups = new Map(topTags.map(([t]) => [t, []]))
  const untagged = []
  for (const m of memories) {
    const primary = m.tags.find((t) => topSet.has(t))
    if (primary) groups.get(primary).push(m)
    else if (m.tags.length === 0) untagged.push(m)
  }
  for (const [tag, arr] of groups) {
    if (!arr.length) continue
    process.stdout.write(`${C.cyan(tag)} ${C.dim('(' + arr.length + ')')}\n`)
    for (const m of arr.slice(0, 5)) {
      const summary = getSummary(m.id)
      process.stdout.write(`  • ${summary?.oneLine ?? truncate(m.title, 80)}  ${C.dim(m.id.slice(0, 8))}\n`)
    }
    process.stdout.write('\n')
  }
  if (untagged.length) {
    process.stdout.write(`${C.dim('(untagged)')} ${C.dim('(' + untagged.length + ')')}\n`)
    for (const m of untagged.slice(0, 5)) process.stdout.write(`  • ${truncate(m.title, 80)}  ${C.dim(m.id.slice(0, 8))}\n`)
  }
}

function cmdHelp() {
  process.stdout.write(`${C.bold('cortex')} — terminal companion for the second brain

Read / search:
  cortex search <query> [--mode auto|keyword|semantic] [--limit N] [--tag T] [--source S]
  cortex recent [--limit N] [--tag T] [--source S]
  cortex digest [--week]
  cortex stats
  cortex tags
  cortex pinned

Write:
  cortex add "<text>" [--tag T] [--source S]
  cortex journal ["<text>"] [--edit]
  cortex pin <id>
  cortex unpin <id>

Export:
  cortex export <id> [--format md|json]
  cortex help

Memory ids can be abbreviated (first 8 chars are usually enough).
DB: ${C.dim(DB_PATH)}
`)
}

// ── Dispatch ────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2))
const cmd = args._[0] ?? 'help'
const COMMANDS = {
  search: cmdSearch, s: cmdSearch,
  recent: cmdRecent, r: cmdRecent,
  digest: cmdDigest, d: cmdDigest,
  stats: cmdStats,
  tags: cmdTags,
  pinned: cmdPinned,
  pin: cmdPin,
  unpin: cmdUnpin,
  export: cmdExport,
  add: cmdAdd, a: cmdAdd,
  journal: cmdJournal, j: cmdJournal,
  help: cmdHelp, '-h': cmdHelp, '--help': cmdHelp,
}
const fn = COMMANDS[cmd]
if (!fn) die(`unknown command: ${cmd}\nrun "cortex help" for the list`)
try { await fn(args) }
catch (err) { die(err.message ?? String(err)) }
finally { try { db.close() } catch {} }
