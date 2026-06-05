#!/usr/bin/env node
// scripts/seed-10k-vault.mjs
//
// v0.2 P0 #4 — search-latency benchmark fixture.
//
// Generates N synthetic memories (default 10000) directly in the live cortex
// SQLite DB so we can profile search performance at realistic scale. Optional
// `--embed` pass fills memory_vectors via local Ollama (all-minilm, 384-dim).
//
// IDEMPOTENT: row ids are deterministic (`seed-<sha1>`), so re-running won't
// produce duplicates. `--clear` removes all `seed-%` rows + their vectors.
//
// RUNTIME: this script must run under Electron's bundled Node (NODE_MODULE_VERSION
// 125) because better-sqlite3 + sqlite-vec native binaries are built for that
// ABI. Use the npm wrapper script (`npm run seed-10k`) which sets the env var.
//
// USAGE
//   npm run seed-10k -- --dry-run             # count what would be inserted
//   npm run seed-10k                          # insert 10000 rows, skip embeddings
//   npm run seed-10k -- --embed               # insert + compute embeddings
//   npm run seed-10k -- --count=1000          # smaller fixture
//   npm run seed-10k -- --clear               # remove all seeded rows
//
// FLAGS
//   --dry-run    no DB writes; reports planned counts
//   --count=N    number of memories to generate (default 10000)
//   --embed      also compute + store embeddings via Ollama
//   --clear      delete all seed-* rows + their vectors (then exit)
//   --concurrency=N  Ollama concurrency (default 8)

import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { createHash } from 'crypto'
import { join } from 'path'

const args = parseArgs(process.argv.slice(2))
const DRY_RUN = args.has('dry-run')
const DO_EMBED = args.has('embed')
const DO_CLEAR = args.has('clear')
const COUNT = parseInt(args.get('count') ?? '10000', 10)
const CONCURRENCY = parseInt(args.get('concurrency') ?? '8', 10)

const APPDATA = process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
const DB_PATH = process.env.CORTEX_DB || join(APPDATA, 'Cortex', 'memories.db')
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const EMBED_MODEL = process.env.CORTEX_EMBED_MODEL || 'all-minilm'
const EMBED_DIM = 384

console.log(`[seed] DB:    ${DB_PATH}`)
console.log(`[seed] Mode:  ${DRY_RUN ? 'DRY-RUN' : DO_CLEAR ? 'CLEAR' : `INSERT (count=${COUNT})`}${DO_EMBED ? ' +EMBED' : ''}`)

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

let vecEnabled = false
try {
  db.loadExtension(sqliteVec.getLoadablePath())
  vecEnabled = true
} catch (err) {
  console.warn('[seed] sqlite-vec unavailable:', err.message)
}

if (DO_CLEAR) {
  const beforeMem = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id LIKE 'seed-%'").get().n
  const beforeVec = vecEnabled
    ? db.prepare("SELECT COUNT(*) AS n FROM memory_vectors WHERE memory_id LIKE 'seed-%'").get().n
    : 0
  if (DRY_RUN) {
    console.log(`[seed] DRY-RUN would delete ${beforeMem} memories + ${beforeVec} vectors`)
  } else {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM fts_memories WHERE memory_id LIKE 'seed-%'").run()
      if (vecEnabled) db.prepare("DELETE FROM memory_vectors WHERE memory_id LIKE 'seed-%'").run()
      db.prepare("DELETE FROM memory_relationships WHERE sourceId LIKE 'seed-%' OR targetId LIKE 'seed-%'").run()
      db.prepare("DELETE FROM memories WHERE id LIKE 'seed-%'").run()
    })
    tx()
    console.log(`[seed] cleared ${beforeMem} memories + ${beforeVec} vectors`)
  }
  db.close()
  process.exit(0)
}

// Deterministic content generation. Mulberry32 PRNG seeded from a fixed string
// so re-runs produce identical rows (idempotent), yet content has enough
// variation to exercise both common and rare-term search paths.
function mulberry32(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)] }

const SOURCES = ['claude', 'chatgpt', 'gemini', 'manual']
const TOPICS = [
  'TypeScript generics', 'React hooks', 'SQLite indexing', 'vector search',
  'embeddings', 'fastify routing', 'electron IPC', 'PostgreSQL JSONB',
  'Rust borrow checker', 'Go concurrency', 'Python asyncio', 'Docker volumes',
  'Kubernetes ingress', 'GraphQL resolvers', 'Tailwind utilities', 'Vite plugins',
  'Webpack tree-shaking', 'authentication flow', 'OAuth PKCE', 'JWT validation',
  'CORS preflight', 'CSP nonces', 'WebSocket reconnect', 'Server-sent events',
  'CRDT merge', 'operational transform', 'Levenshtein distance', 'BM25 ranking',
  'cosine similarity', 'k-means clustering', 'gradient descent', 'backpropagation',
  'attention mechanism', 'tokenization', 'Markov chains', 'Bayesian inference',
  'A* pathfinding', 'red-black tree', 'B+tree leaf split', 'hash join',
  'window function', 'recursive CTE', 'WAL checkpoint', 'MVCC snapshot',
  'phantom read', 'serialization failure', 'distributed lock', 'leader election',
  'Raft consensus', 'Paxos rounds', 'gossip protocol', 'hinted handoff',
]
const VERBS = ['debugging', 'optimizing', 'refactoring', 'designing', 'testing', 'profiling', 'documenting', 'reviewing']
const NOUNS = ['pipeline', 'service', 'module', 'subsystem', 'workflow', 'handler', 'adapter', 'facade']

function genMemory(i) {
  const rng = mulberry32(i * 2654435761)
  const topic = pick(rng, TOPICS)
  const verb = pick(rng, VERBS)
  const noun = pick(rng, NOUNS)
  const source = SOURCES[i % SOURCES.length]
  const title = `${verb[0].toUpperCase()}${verb.slice(1)} ${topic} in our ${noun}`
  // Content: 4-12 paragraphs, each 80-200 words, with topic terms repeated
  // enough that LIKE will hit common queries but not so much that a 1-word
  // query returns 9k rows.
  const paraCount = 4 + Math.floor(rng() * 9)
  const paras = []
  for (let p = 0; p < paraCount; p++) {
    const sents = []
    const sentCount = 3 + Math.floor(rng() * 4)
    for (let s = 0; s < sentCount; s++) {
      const t1 = pick(rng, TOPICS)
      const t2 = pick(rng, TOPICS)
      const v = pick(rng, VERBS)
      const n = pick(rng, NOUNS)
      sents.push(`We tried ${v} the ${t1} approach but ran into ${t2} edge cases inside the ${n}.`)
    }
    paras.push(sents.join(' '))
  }
  const content = `# ${title}\n\n${paras.join('\n\n')}`
  const id = 'seed-' + createHash('sha1').update(`${i}|${title}|${source}`).digest('hex').slice(0, 16)
  const tags = [topic.split(' ')[0].toLowerCase(), verb]
  const url = `https://example.com/${source}/${id}`
  return { id, title, content, source, tags, url }
}

// Idempotent insert via INSERT OR IGNORE (NOT REPLACE — REPLACE would bump
// updatedAt every run and invalidate "skipped (dup)" telemetry).
const insertMem = db.prepare(
  'INSERT OR IGNORE INTO memories (id, title, content, timestamp, updatedAt, source, tags, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
)
const insertFts = db.prepare(
  'INSERT OR IGNORE INTO fts_memories (memory_id, title, content) VALUES (?, ?, ?)'
)

const before = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n
const t0 = Date.now()
let inserted = 0
let skipped = 0

const BATCH = 1000
const tx = db.transaction((rows) => {
  const now = Date.now()
  for (const m of rows) {
    const r = insertMem.run(m.id, m.title, m.content, now, now, m.source, JSON.stringify(m.tags), m.url)
    insertFts.run(m.id, m.title, m.content)
    if (r.changes > 0) inserted++; else skipped++
  }
})

if (DRY_RUN) {
  // Just count what's already there vs what would be added.
  const existing = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id LIKE 'seed-%'").get().n
  console.log(`[seed] DRY-RUN: would generate ${COUNT}; ${existing} seed rows already present`)
  console.log(`[seed] N=${COUNT}`)
  db.close()
  process.exit(0)
}

console.log(`[seed] inserting ${COUNT} memories (batch=${BATCH})...`)
for (let i = 0; i < COUNT; i += BATCH) {
  const batch = []
  for (let j = i; j < Math.min(i + BATCH, COUNT); j++) batch.push(genMemory(j))
  tx(batch)
  if ((i + BATCH) % 5000 === 0 || i + BATCH >= COUNT) {
    process.stdout.write(`  ${Math.min(i + BATCH, COUNT)}/${COUNT}\r`)
  }
}
console.log()
const after = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n
const tSeed = ((Date.now() - t0) / 1000).toFixed(2)
console.log(`[seed] before=${before} after=${after} inserted=${inserted} skipped=${skipped} in ${tSeed}s`)

if (DO_EMBED) {
  if (!vecEnabled) {
    console.warn('[seed] --embed requested but sqlite-vec unavailable; skipping')
  } else {
    await embedAllMissing()
  }
}

db.close()
console.log(`[seed] Seeded ${inserted} memories, skipped ${skipped} (dups), completed in ${((Date.now() - t0) / 1000).toFixed(2)} seconds`)

async function embedAllMissing() {
  const targets = db.prepare(`
    SELECT id, title, content FROM memories
    WHERE id LIKE 'seed-%'
      AND id NOT IN (SELECT memory_id FROM memory_vectors)
  `).all()
  if (targets.length === 0) {
    console.log('[seed] embeddings: all seed rows already embedded')
    return
  }
  console.log(`[seed] embeddings: ${targets.length} pending; concurrency=${CONCURRENCY}`)

  // Quick Ollama health check.
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) })
    if (!r.ok) throw new Error(`status ${r.status}`)
  } catch (err) {
    console.warn(`[seed] Ollama unreachable (${err.message}); skipping embeddings`)
    return
  }

  const tE = Date.now()
  let done = 0
  let failed = 0

  const upsertVec = db.transaction((id, buf) => {
    db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(id)
    db.prepare('INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)').run(id, buf)
  })

  // Cap input size like the production code (embeddings.ts MAX_INPUT_CHARS=4000).
  async function embedOne(row) {
    const input = `${row.title}\n\n${row.content}`.slice(0, 4000)
    try {
      const r = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!r.ok) { failed++; return }
      const body = await r.json()
      const vec = body.embeddings?.[0]
      if (!Array.isArray(vec) || vec.length !== EMBED_DIM) { failed++; return }
      const buf = Buffer.from(new Float32Array(vec).buffer)
      upsertVec(row.id, buf)
      done++
    } catch {
      failed++
    }
  }

  // Bounded concurrency: a sliding window of in-flight requests, refilled on
  // settle. Prevents N=10k from creating 10k simultaneous fetches.
  let idx = 0
  const inFlight = new Set()
  const next = () => {
    while (inFlight.size < CONCURRENCY && idx < targets.length) {
      const row = targets[idx++]
      const p = embedOne(row).finally(() => {
        inFlight.delete(p)
        if (done % 100 === 0) process.stdout.write(`  embedded ${done}/${targets.length}\r`)
      })
      inFlight.add(p)
    }
  }
  next()
  while (inFlight.size > 0) {
    await Promise.race(inFlight)
    next()
  }
  console.log()
  console.log(`[seed] embeddings: done=${done} failed=${failed} in ${((Date.now() - tE) / 1000).toFixed(2)}s`)
}

function parseArgs(argv) {
  const flags = new Set()
  const kv = new Map()
  for (const a of argv) {
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq >= 0) kv.set(a.slice(2, eq), a.slice(eq + 1))
    else flags.add(a.slice(2))
  }
  return Object.assign(flags, { get: k => kv.get(k) })
}
