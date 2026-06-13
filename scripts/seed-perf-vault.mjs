#!/usr/bin/env node
// scripts/seed-perf-vault.mjs — 100k-scale graph perf fixture.
//
// Seeds source='perf_test' memories + fake vault_files rows + relationships +
// fake embeddings directly into the real DB so the app can be measured at
// 100k+ nodes. Everything is namespaced (perf-m-*/perf-f-*, source perf_test,
// filepath C:\fake\perf\...) so --wipe removes it surgically.
//
// USAGE (from project root, app CLOSED):
//   node scripts/run-as-node.cjs scripts/seed-perf-vault.mjs [memories] [files]
//   node scripts/run-as-node.cjs scripts/seed-perf-vault.mjs --wipe
//
// Design notes:
//  - Relationships are seeded WITH sourceId = each memory and signal_type
//    'auto:keyword', so the startup edge backfill (which only processes
//    memories with no auto-edges) skips every perf row.
//  - memory_vectors rows are random unit vectors so the embedding seeder
//    reports "already embedded" instead of hammering Ollama during runs.
//  - ~5% of files get single-word stems from the same word pool as memory
//    text, so the main-process mention builder produces a realistic edge set.
//  - Content contains no '[[' — wiki backfill no-ops.

import { existsSync } from 'node:fs'
import process from 'node:process'

const APPDATA = process.env.APPDATA
const DB_PATH = `${APPDATA}\\Cortex\\memories.db`
if (!existsSync(DB_PATH)) { console.error('[perf] DB not found:', DB_PATH); process.exit(1) }

const Database = (await import('better-sqlite3')).default
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

// ── Wipe mode ─────────────────────────────────────────────────────────────────

if (process.argv.includes('--wipe')) {
  db.pragma('foreign_keys = OFF')
  try {
    const r1 = db.prepare("DELETE FROM memory_relationships WHERE id LIKE 'perf-%'").run()
    const r2 = db.prepare("DELETE FROM memories_fts WHERE memory_id LIKE 'perf-m-%'").run()
    let vec = 0
    try { vec = db.prepare("DELETE FROM memory_vectors WHERE memory_id LIKE 'perf-m-%'").run().changes } catch { /* vec table absent */ }
    const r3 = db.prepare("DELETE FROM memories WHERE source = 'perf_test'").run()
    const r4 = db.prepare("DELETE FROM vault_files WHERE filepath LIKE 'C:\\fake\\perf\\%'").run()
    console.log(`[perf] wiped: ${r3.changes} memories, ${r4.changes} files, ${r1.changes} rels, ${r2.changes} fts, ${vec} vectors`)
  } finally {
    db.pragma('foreign_keys = ON')
  }
  db.exec('VACUUM')
  console.log('[perf] VACUUM done')
  db.close()
  process.exit(0)
}

// ── Seed mode ─────────────────────────────────────────────────────────────────

const MEM_COUNT = parseInt(process.argv[2] ?? '60000', 10)
const FILE_COUNT = parseInt(process.argv[3] ?? '60000', 10)

// sqlite-vec for fake embeddings (best-effort; named export, not default).
let hasVec = false
try {
  const vecModule = await import('sqlite-vec')
  const getLoadablePath = vecModule.getLoadablePath ?? vecModule.default?.getLoadablePath
  db.loadExtension(getLoadablePath())
  hasVec = true
} catch (e) {
  console.warn('[perf] sqlite-vec unavailable — skipping fake embeddings:', e.message)
}

const WORDS = [
  'electron', 'renderer', 'quadtree', 'simulation', 'embedding', 'pipeline',
  'capture', 'vault', 'memory', 'graph', 'cluster', 'viewport', 'culling',
  'typescript', 'react', 'sqlite', 'ollama', 'fastify', 'worker', 'canvas',
  'physics', 'layout', 'zoom', 'panning', 'search', 'keyword', 'semantic',
  'tagging', 'wiki', 'backlink', 'snapshot', 'migration', 'schema', 'index',
  'transaction', 'extension', 'chrome', 'conversation', 'claude', 'gemini',
  'project', 'roadmap', 'release', 'performance', 'profiling', 'telemetry',
  'frontend', 'backend', 'database', 'protocol',
]
const TAGS = WORDS.slice(0, 30)
const SOURCES_DIST = ['perf_test'] // single source keeps wipe surgical

// Deterministic PRNG (mulberry32) — reproducible fixtures.
let prngState = 0xC0FFEE
function rand() {
  prngState |= 0; prngState = (prngState + 0x6D2B79F5) | 0
  let t = Math.imul(prngState ^ (prngState >>> 15), 1 | prngState)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = arr => arr[Math.floor(rand() * arr.length)]

function sentence(words) {
  const parts = []
  for (let i = 0; i < words; i++) parts.push(pick(WORDS))
  return parts.join(' ')
}

console.log(`[perf] seeding ${MEM_COUNT} memories + ${FILE_COUNT} files into ${DB_PATH}`)
const t0 = Date.now()

// Clear any previous perf rows ONCE up front so the hot loop is pure INSERTs.
// (First version did `DELETE FROM memories_fts WHERE memory_id = ?` per row —
// memory_id is UNINDEXED in FTS5, so that's a full-table scan per call and
// the 60k-row loop went O(n²): killed after 20+ CPU-minutes.)
db.pragma('foreign_keys = OFF')
db.prepare("DELETE FROM memory_relationships WHERE id LIKE 'perf-%'").run()
db.prepare("DELETE FROM memories_fts WHERE memory_id LIKE 'perf-m-%'").run()
try { db.prepare("DELETE FROM memory_vectors WHERE memory_id LIKE 'perf-m-%'").run() } catch { /* vec absent */ }
db.prepare("DELETE FROM memories WHERE source = 'perf_test'").run()
db.prepare("DELETE FROM vault_files WHERE filepath LIKE 'C:\\fake\\perf\\%'").run()
db.pragma('foreign_keys = ON')
console.log(`[perf] cleared previous perf rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

const insMem = db.prepare(
  'INSERT INTO memories (id, title, content, timestamp, updatedAt, source, tags, url) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)'
)
const insFts = db.prepare('INSERT INTO memories_fts (memory_id, title, content) VALUES (?, ?, ?)')
const insRel = db.prepare(
  "INSERT INTO memory_relationships (id, sourceId, targetId, relationship, strength, signal_type) VALUES (?, ?, ?, 'auto:keyword', ?, 'auto:keyword')"
)
const insVec = hasVec ? db.prepare('INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)') : null

function fakeVector() {
  const v = new Float32Array(384)
  let norm = 0
  for (let i = 0; i < 384; i++) { v[i] = rand() * 2 - 1; norm += v[i] * v[i] }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < 384; i++) v[i] /= norm
  return Buffer.from(v.buffer)
}

const BATCH = 5000
const now = Date.now()

for (let start = 0; start < MEM_COUNT; start += BATCH) {
  const end = Math.min(start + BATCH, MEM_COUNT)
  const tx = db.transaction(() => {
    for (let i = start; i < end; i++) {
      const id = `perf-m-${i}`
      const title = `${sentence(3)} ${i}`
      const content = `${sentence(40)}. ${sentence(30)}.`
      const ts = now - Math.floor(rand() * 180 * 86400_000)
      const tags = JSON.stringify([pick(TAGS), pick(TAGS)])
      insMem.run(id, title, content, ts, ts, pick(SOURCES_DIST), tags)
      insFts.run(id, title, content)
      // 2-3 edges back to earlier rows (skips i=0..2 fan-in noise)
      if (i > 3) {
        const edges = 2 + Math.floor(rand() * 2)
        for (let e = 0; e < edges; e++) {
          const j = Math.floor(rand() * i)
          insRel.run(`perf-${i}-${j}-${e}`, id, `perf-m-${j}`, 0.3 + rand() * 0.6)
        }
      }
      if (insVec) insVec.run(id, fakeVector())
    }
  })
  tx()
  console.log(`[perf] memories ${end}/${MEM_COUNT}`)
}

const insFile = db.prepare(
  'INSERT INTO vault_files (id, filepath, filename, extension, content, size, last_modified, indexed_at, frontmatter_url, linked_memory_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)'
)
for (let start = 0; start < FILE_COUNT; start += BATCH) {
  const end = Math.min(start + BATCH, FILE_COUNT)
  const tx = db.transaction(() => {
    for (let i = start; i < end; i++) {
      const id = `perf-f-${i}`
      // ~5% single-word stems → mention edges via the main-process builder.
      const filename = rand() < 0.05 ? `${pick(WORDS)}.md` : `${pick(WORDS)}-${pick(WORDS)}-${i}.md`
      insFile.run(
        id, `C:\\fake\\perf\\d${i}\\${filename}`, filename, '.md',
        sentence(15), 1200, now, now,
      )
    }
  })
  tx()
  console.log(`[perf] files ${end}/${FILE_COUNT}`)
}

const mems = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE source='perf_test'").get().n
const files = db.prepare("SELECT COUNT(*) AS n FROM vault_files WHERE filepath LIKE 'C:\\fake\\perf\\%'").get().n
const rels = db.prepare("SELECT COUNT(*) AS n FROM memory_relationships WHERE id LIKE 'perf-%'").get().n
console.log(`[perf] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${mems} memories, ${files} files, ${rels} relationships`)
db.close()
