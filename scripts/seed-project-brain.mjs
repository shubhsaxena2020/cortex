#!/usr/bin/env node
// scripts/seed-project-brain.mjs
//
// Phase 2: Seed Cortex with foundational project knowledge about itself.
// Inserts structured memories across five categories (architecture, current state,
// open issues, roadmap, tech-debt), generates Ollama embeddings if available,
// and runs an inline auto-edge backfill to wire up the knowledge graph.
//
// USAGE (from project root):
//   node scripts/run-as-node.cjs scripts/seed-project-brain.mjs
//
// Run AFTER: node scripts/run-as-node.cjs scripts/purge-test-data.mjs

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import process from 'node:process'

const APPDATA      = process.env.APPDATA || ''
const dbPath       = join(APPDATA, 'Cortex', 'memories.db')
const OLLAMA_URL   = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const EMBED_MODEL  = 'all-minilm'
const EMBEDDING_DIM = 384

if (!existsSync(dbPath)) {
  console.error(`[seed] DB not found: ${dbPath}`)
  process.exit(1)
}
console.log(`[seed] DB: ${dbPath}`)

// ── Load better-sqlite3 ───────────────────────────────────────────────────────

let Database
try {
  Database = (await import('better-sqlite3')).default
} catch (e) {
  console.error(`[seed] Failed to load better-sqlite3: ${e.message}`)
  process.exit(1)
}

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// ── Try to load sqlite-vec (optional) ────────────────────────────────────────

let vectorSearchEnabled = false
try {
  // sqlite-vec exports getLoadablePath as a named export (import * as sqliteVec),
  // not a default export — match how db.ts imports it.
  const sqliteVecModule = await import('sqlite-vec')
  const getLoadablePath = sqliteVecModule.getLoadablePath ?? sqliteVecModule.default?.getLoadablePath
  if (!getLoadablePath) throw new Error('getLoadablePath not found in sqlite-vec exports')
  db.loadExtension(getLoadablePath())
  vectorSearchEnabled = true
  console.log(`[seed] sqlite-vec loaded — vector storage enabled`)
} catch (e) {
  console.log(`[seed] sqlite-vec not loaded (${e.message.slice(0, 80)}) — embedding storage will be skipped`)
}

// ── Check schema version ──────────────────────────────────────────────────────

const ver = db.prepare('SELECT version FROM schema_version').get()
const schemaVersion = ver?.version ?? 0
if (schemaVersion < 4) {
  console.error(`[seed] Schema v${schemaVersion} is too old (need v4+ for memories_fts). Launch the app once to migrate.`)
  db.close()
  process.exit(1)
}
console.log(`[seed] Schema v${schemaVersion} — OK`)

// ── 2A: Memory definitions ────────────────────────────────────────────────────

const NOW = Date.now()

// 13 memories across 5 categories. Content mirrors what an engineer would write
// in a project wiki — specific enough to generate meaningful auto-edges via tag
// Jaccard and FTS5 keyword overlap.

const MEMORIES = [

  // ── Architecture decisions (4) ─────────────────────────────────────────────

  {
    title: 'Cortex architecture: Electron 31 + React 18 + TypeScript 5 three-process stack',
    content:
      'Electron desktop app with three isolated processes.\n' +
      'Main (src/main/index.ts): Node.js runtime, better-sqlite3 DB, all IPC handlers, Fastify HTTP server for the Chrome extension API.\n' +
      'Preload (src/preload/index.ts): context bridge only — wires ipcRenderer.invoke to window.electron, typed as ElectronAPI in src/types/index.ts.\n' +
      'Renderer (src/renderer/src/main.tsx): React 18, Zustand 4 store, D3 7 graph, Tailwind 3.\n' +
      'Shared types live in src/types/index.ts and are imported by all three processes.',
    tags: ['architecture', 'electron', 'react', 'typescript', 'stack'],
  },

  {
    title: 'Local-first, privacy-first: no cloud sync, vault at cortex_brain, DB at %APPDATA%/Cortex',
    content:
      'Privacy-first by design. Zero cloud sync, no telemetry by default.\n' +
      'Vault: C:\\Users\\shubh\\cortex_brain — intentionally OUTSIDE the git repo to prevent AI conversations leaking to GitHub.\n' +
      'DB: %APPDATA%\\Cortex\\memories.db (better-sqlite3, WAL mode, foreign_keys ON).\n' +
      'Vault path persisted in %APPDATA%\\Cortex\\vault-config.json.\n' +
      'Extension config (token + port) at %APPDATA%\\Cortex\\extension-config.json.\n' +
      'v0.2.0 shipped opt-in local-only telemetry: daily JSONL, PII-blocklist redaction, vault path hashed, never leaves the machine.',
    tags: ['architecture', 'privacy', 'local-first', 'vault', 'database'],
  },

  {
    title: 'IPC-only data flow: renderer → ipcRenderer → main → db.ts → SQLite (no HTTP)',
    content:
      'The renderer has zero direct DB or Node.js access. Every operation flows:\n' +
      '  window.electron.*() → ipcRenderer.invoke (preload bridge) → IPC handler in src/main/index.ts → db.ts function → better-sqlite3 sync query.\n' +
      'The Fastify HTTP server (src/main/http.ts) runs on 127.0.0.1 exclusively for the Chrome extension API.\n' +
      'It is NOT used for renderer↔main communication.\n' +
      'Graph data is pushed from main to renderer via memories:changed events so captures from the extension appear in real-time without polling.',
    tags: ['architecture', 'ipc', 'data-flow', 'security', 'fastify'],
  },

  {
    title: 'Auto-edges: three-signal cascade — tag Jaccard, FTS5 keyword, sqlite-vec KNN',
    content:
      'src/main/edge-builder.ts implements three signals in order:\n' +
      '  Signal 1 (auto:tag, blue): tag Jaccard similarity — any overlap qualifies as a candidate.\n' +
      '  Signal 2 (auto:keyword, yellow): keyword Jaccard via FTS5 MATCH, threshold 0.15.\n' +
      '  Signal 3 (auto:embedding, purple): embedding cosine via sqlite-vec KNN, threshold 0.50 weak / 0.70 strong.\n' +
      'Cap: 5 edges per memory (prevents hairball graph).\n' +
      'Runs on every new memory (via buildEdgesForMemory) and as a startup backfill (backfillAllEdges) for memories with no existing auto-edges.\n' +
      'Tag candidate cache self-invalidates on COUNT(*) + MAX(updatedAt) fingerprint change.',
    tags: ['architecture', 'auto-edges', 'embeddings', 'graph', 'fts5', 'sqlite-vec'],
  },

  // ── Current state (v0.2.0) (4) ─────────────────────────────────────────────

  {
    title: 'v0.2.0 shipped 2026-06-05: 264/264 tests green, all five P0 items landed',
    content:
      'Five P0 items shipped:\n' +
      '(1) Conversation dedup — upsertMemoryByUrl canonical-URL upsert; same chat captured twice updates one memory in place instead of forking the graph.\n' +
      '(2) Smart capture filtering — content-script skips empty, single-message, and system+tool-only chats before they reach the app.\n' +
      '(3) Graph LOD + quadtree viewport culling + Obsidian-style canvas redesign. Bonus: D3 force simulation moved to a Web Worker (required at 10k+ nodes).\n' +
      '(4) FTS5 MATCH search — p95 86.6ms on 10k memories, well under the 200ms target.\n' +
      '(5) In-app feedback + opt-in local-only telemetry (JSONL, PII-blocklist, OFF by default).\n' +
      'Bonus: embedding seed parallelization via batch /api/embed (~2.1× throughput).',
    tags: ['v0.2.0', 'release', 'milestone', 'tests', 'p0'],
  },

  {
    title: 'Schema v6: memories columns, memory_relationships v5+ columns, FTS5 + sqlite-vec tables',
    content:
      'memories table: id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT, timestamp INTEGER (epoch ms), updatedAt INTEGER, source TEXT, tags TEXT (JSON array string), url TEXT.\n' +
      'memory_relationships table: id TEXT PK (composite "sourceId-targetId"), sourceId TEXT NOT NULL, targetId TEXT NOT NULL, relationship TEXT, strength REAL DEFAULT 0.0 (added v5), signal_type TEXT DEFAULT \'manual\' (added v5).\n' +
      'Virtual tables: memories_fts (FTS5, added v4 — replaced fts_memories), memory_vectors (sqlite-vec, EMBEDDING_DIM=384).\n' +
      'v6 added: idx_memories_source index + ANALYZE for query planner cardinality stats.',
    tags: ['schema', 'database', 'sqlite', 'v6', 'architecture'],
  },

  {
    title: 'Chrome extension captures Claude.ai + ChatGPT, MV3, Fastify pairing handshake',
    content:
      'MV3 Chrome extension. Pairs with app via /pair endpoint (no token required, time-limited window opened by Settings "Pair Extension" button — closes after first successful pair).\n' +
      'Bearer token auth on all routes except /health and /pair. Port probed in range 48729–48738, falls back to ephemeral OS port.\n' +
      'Content-script filtering (before data reaches app): skips empty chats, single-message chats, system+tool-only message streams.\n' +
      'Dedup: upsertMemoryByUrl with canonical URL (src/main/url-canon.ts strips tracking params, normalises path).\n' +
      'Dual-export pattern: globalThis for runtime, module.exports for vitest compatibility.',
    tags: ['chrome-extension', 'capture', 'dedup', 'authentication', 'fastify'],
  },

  {
    title: 'Graph rendering: hover labels, focus mode, radial fills, hub glow, neon edges by signal type',
    content:
      'Canvas-based D3 renderer (not SVG). Force simulation in a Web Worker.\n' +
      'Visual details: hover-only node labels (smooth LOD), focus mode fades non-adjacent nodes to 8% opacity, radial gradient fills on nodes, hub glow for high-degree nodes.\n' +
      'Edge colours by signal_type: auto:tag → blue, auto:keyword → yellow, auto:embedding → purple, manual → white/gray.\n' +
      'Quadtree viewport culling prevents rendering off-screen nodes (critical for 10k+ node performance).\n' +
      'An O(memories×files) mention-edge explosion bug was root-caused via DevTools-protocol inspection (inverted word→memory index fixed it: ~1k edges vs 1.35M).',
    tags: ['graph', 'd3', 'rendering', 'performance', 'v0.2.0', 'web-worker'],
  },

  // ── Known open issues (2) ──────────────────────────────────────────────────

  {
    title: 'OPEN P1 #4: startup auto-edge backfill completion log never confirmed',
    content:
      'The log line "[edge-builder] backfill: complete — X memories processed" from backfillAllEdges() in src/main/edge-builder.ts was never observed in electron-log output during testing.\n' +
      'It is unconfirmed whether auto-edges are actually created at startup.\n' +
      'Investigation steps:\n' +
      '  1. Query: SELECT COUNT(*) FROM memory_relationships WHERE signal_type LIKE \'auto:%\';\n' +
      '  2. Confirm backfillAllEdges() is called in the app-ready handler in src/main/index.ts.\n' +
      '  3. Check electron-log output path: %APPDATA%\\Cortex\\logs\\main.log.\n' +
      '  4. Verify sqlite-vec is loading correctly (hasVectorSearch() returning true).',
    tags: ['bug', 'open-issue', 'auto-edges', 'startup', 'p1', 'electron-log'],
  },

  {
    title: 'OPEN: Windows 11 clean-VM smoke test of v0.2.0 NSIS installer still pending',
    content:
      'Third-party Windows 11 clean-VM smoke test of the v0.2.0 installer has not been completed.\n' +
      'Carry-over from v0.1.0-beta. See SMOKE-TEST-INSTRUCTIONS.md in repo root for full checklist.\n' +
      'Requirements: fresh Windows 11 VM (no existing Cortex install), install via NSIS installer, verify no SmartScreen false positive, test Chrome extension pairing flow, verify graph renders with test data, test vault scanning with a sample markdown file.',
    tags: ['open-issue', 'smoke-test', 'installer', 'windows', 'v0.2.0'],
  },

  // ── v0.2.1 sprint scope (1) ────────────────────────────────────────────────

  {
    title: 'ROADMAP: no v0.2.1 section — next version is v0.3.0 "It feels smart"',
    content:
      'ROADMAP.md has no v0.2.1 section. Version sequence: v0.2.0 (shipped 2026-06-05) → v0.3.0 (next).\n' +
      'v0.3.0 scope (ship at most 5 of 8 — kill criterion):\n' +
      '  1. Bidirectional [[wiki]] links + backlinks panel (promoted from v0.4).\n' +
      '  2. Conversation summarization via Ollama llama3.2:3b — one-line + paragraph summaries.\n' +
      '  3. Auto-tagging from content; user can edit/lock tags.\n' +
      '  4. Multi-model Ollama picker (swap embedding + summarization models in Settings).\n' +
      '  5. Embedding backfill UI — visible progress, pause/resume.\n' +
      '  6. Saved searches / smart folders.\n' +
      '  7. db.test.disabled.ts → vitest-electron — CI-green DB integration tests.\n' +
      'Items already shipped as v0.2.0 bonus: force simulation Web Worker.',
    tags: ['roadmap', 'v0.3.0', 'planning', 'next-sprint', 'wiki-links', 'summarization'],
  },

  // ── Tech debt / constraints (2) ────────────────────────────────────────────

  {
    title: 'CONSTRAINT: Never run npm audit fix --force — broke Electron 31→42 upgrade once',
    content:
      'Running `npm audit fix --force` silently upgraded Electron from 31 to 42, breaking the entire application. Recovery required `git checkout`.\n' +
      'Safe practice: read npm audit output manually, identify the specific CVE, apply a targeted version pin.\n' +
      'Any Electron major version upgrade requires:\n' +
      '  1. Rebuilding better-sqlite3 against the new Electron Node MODULE_VERSION.\n' +
      '  2. Verifying sqlite-vec ABI compatibility.\n' +
      '  3. Full Vitest run (264 tests) and manual smoke test.\n' +
      'Never use --force; never blindly accept automated dependency upgrades.',
    tags: ['tech-debt', 'constraint', 'npm', 'electron', 'warning', 'better-sqlite3'],
  },

  {
    title: 'CONSTRAINT: Vault stays outside repo (cortex_brain) + Chrome extension dual-export pattern',
    content:
      'Vault: C:\\Users\\shubh\\cortex_brain is intentionally OUTSIDE the git repository. Never move the vault inside the repo — AI conversation markdown files must not end up on GitHub.\n' +
      'Chrome extension dual-export pattern: shared modules assign to globalThis for the runtime environment (Chrome MV3 service worker / content script), AND export via module.exports for vitest (which runs in Node/CommonJS). Both exports are required — removing either breaks runtime capture or the test suite.\n' +
      'These two constraints are not documented elsewhere in the codebase.',
    tags: ['tech-debt', 'constraint', 'vault', 'privacy', 'chrome-extension', 'vitest'],
  },
]

// ── 2A: Insert memories + FTS5 sync ──────────────────────────────────────────

console.log(`\n[seed] Phase 2A: inserting ${MEMORIES.length} memories (source: project_seed)...`)

const insertMemory = db.prepare(
  'INSERT INTO memories (id, title, content, timestamp, updatedAt, source, tags, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
)

const seededIds = []

const doInsert = db.transaction(() => {
  for (const m of MEMORIES) {
    const id = randomUUID()
    const tagsJson = JSON.stringify(m.tags)
    insertMemory.run(id, m.title, m.content, NOW, NOW, 'project_seed', tagsJson, null)
    // FTS5 upsert pattern from db.ts: DELETE then INSERT (INSERT OR REPLACE not supported by FTS5)
    db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id)
    db.prepare(
      'INSERT INTO memories_fts (memory_id, title, content) VALUES (?, ?, ?)'
    ).run(id, m.title, m.content)
    seededIds.push(id)
  }
})

doInsert()
console.log(`[seed] Inserted ${seededIds.length} memories and synced FTS5 index`)

// ── 2B: Embeddings via Ollama ─────────────────────────────────────────────────

console.log(`\n[seed] Phase 2B: checking Ollama at ${OLLAMA_URL}...`)

let ollamaRunning = false
try {
  const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
  ollamaRunning = r.ok
} catch {
  ollamaRunning = false
}

if (!ollamaRunning) {
  console.warn(`[seed] WARNING: Ollama not running — start it and re-run to get embedding-based edges`)
  console.warn(`[seed]   Start:      ollama serve`)
  console.warn(`[seed]   Pull model: ollama pull all-minilm`)
} else if (!vectorSearchEnabled) {
  console.warn(`[seed] WARNING: Ollama is running but sqlite-vec failed to load — embeddings cannot be stored`)
} else {
  console.log(`[seed] Ollama running — generating embeddings for ${seededIds.length} memories...`)

  const BATCH_SIZE = 5
  let embedded = 0

  const storeEmbedding = db.transaction((pairs) => {
    for (const [memId, vec] of pairs) {
      if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) continue
      const buf = Buffer.from(new Float32Array(vec).buffer)
      // sqlite-vec vec0: DELETE + INSERT (same as db.ts storeEmbedding)
      db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(memId)
      db.prepare('INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)').run(memId, buf)
    }
  })

  for (let i = 0; i < MEMORIES.length; i += BATCH_SIZE) {
    const batchMems = MEMORIES.slice(i, i + BATCH_SIZE)
    const batchIds  = seededIds.slice(i, i + BATCH_SIZE)
    const texts = batchMems.map(m => `${m.title}\n\n${m.content}`.trim())

    try {
      const r = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
        signal: AbortSignal.timeout(30000),
      })

      if (!r.ok) {
        console.warn(`[seed]   batch ${i}–${i + BATCH_SIZE}: Ollama responded ${r.status}, skipping`)
        continue
      }

      const body = await r.json()
      const vecs = body.embeddings ?? []
      const pairs = batchIds.map((id, j) => [id, vecs[j]])
      storeEmbedding(pairs)
      const stored = pairs.filter(([, v]) => Array.isArray(v) && v.length === EMBEDDING_DIM).length
      embedded += stored
      console.log(`[seed]   batch ${i}–${i + batchMems.length}: ${stored} vectors stored`)
    } catch (e) {
      console.warn(`[seed]   batch ${i}–${i + BATCH_SIZE} failed: ${e.message}`)
    }
  }

  console.log(`[seed] Embedded ${embedded}/${MEMORIES.length} memories`)
}

// ── 2C: Auto-edge backfill (inline — mirrors edge-builder.ts logic) ───────────
//
// Cannot import edge-builder.ts directly (it imports electron-log which is
// unavailable outside Electron). The algorithm below is a faithful port of
// buildEdgesForMemory + backfillAllEdges.

console.log(`\n[seed] Phase 2C: building auto-edges for seeded memories...`)

const STOP_WORDS = new Set([
  'the','this','that','with','from','have','been','were','they','their',
  'will','would','should','could','about','into','than','then','when',
  'what','which','where','while','your','just','because','these','those',
  'them','also','more','most','some','such','only','very','here','there',
  'make','made','like','want','need','take','says','said',
])

function extractKeywords(text) {
  const words = text.toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
  return new Set(words)
}

function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a]
  smaller.forEach(item => { if (larger.has(item)) intersection++ })
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

const KW_THRESHOLD       = 0.15
const EMBED_WEAK         = 0.50
const MAX_EDGES_PER_MEM  = 5

const insertEdge = db.prepare(
  'INSERT OR REPLACE INTO memory_relationships (id, sourceId, targetId, relationship, strength, signal_type) VALUES (?, ?, ?, ?, ?, ?)'
)

async function buildEdgesForMemory(memoryId) {
  const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId)
  if (!memory) return 0

  const memoryTags     = JSON.parse(memory.tags || '[]')
  const memoryKeywords = extractKeywords(`${memory.title} ${memory.content || ''}`)
  const candidateMap   = new Map()   // targetId → { targetId, score, signalType }

  // --- Signal 2: FTS5 keyword candidates ---
  const kwList = Array.from(memoryKeywords).slice(0, 10)
  if (kwList.length > 0) {
    const ftsQuery = kwList.map(k => `"${k.replace(/"/g, '""')}"`).join(' OR ')
    try {
      const ftsRows = db.prepare(`
        SELECT memory_id FROM memories_fts
        WHERE memories_fts MATCH ? AND memory_id != ?
        LIMIT 50
      `).all(ftsQuery, memoryId)

      for (const { memory_id: otherId } of ftsRows) {
        const other = db.prepare('SELECT id, title, content, tags FROM memories WHERE id = ?').get(otherId)
        if (!other) continue

        const otherKeywords = extractKeywords(`${other.title} ${other.content || ''}`)
        const kwScore = jaccardSimilarity(memoryKeywords, otherKeywords)

        if (kwScore >= KW_THRESHOLD) {
          const otherTags = JSON.parse(other.tags || '[]')
          const tScore    = jaccardSimilarity(new Set(memoryTags), new Set(otherTags))
          if (tScore > kwScore && tScore > 0) {
            candidateMap.set(otherId, { targetId: otherId, score: tScore, signalType: 'auto:tag' })
          } else {
            candidateMap.set(otherId, { targetId: otherId, score: kwScore, signalType: 'auto:keyword' })
          }
        }
      }
    } catch {
      // FTS5 parse error — skip signal 2
    }
  }

  // --- Signal 1: Tag candidates (scan, only when memory has tags) ---
  if (memoryTags.length > 0) {
    const tagRows = db.prepare(
      "SELECT id, tags FROM memories WHERE tags IS NOT NULL AND tags != '[]' AND id != ?"
    ).all(memoryId)

    for (const other of tagRows) {
      if (candidateMap.has(other.id)) continue
      try {
        const otherTags = JSON.parse(other.tags || '[]')
        const score     = jaccardSimilarity(new Set(memoryTags), new Set(otherTags))
        if (score > 0) {
          candidateMap.set(other.id, { targetId: other.id, score, signalType: 'auto:tag' })
        }
      } catch {}
    }
  }

  // --- Signal 3: Embedding KNN (only if sqlite-vec loaded and vector exists) ---
  if (vectorSearchEnabled) {
    try {
      const vecRow = db.prepare('SELECT embedding FROM memory_vectors WHERE memory_id = ?').get(memoryId)
      if (vecRow) {
        const knnRows = db.prepare(`
          SELECT memory_id, distance FROM memory_vectors
          WHERE embedding MATCH ? AND memory_id != ?
          ORDER BY distance LIMIT 20
        `).all(vecRow.embedding, memoryId)

        for (const c of knnRows) {
          const similarity = 1 - (c.distance / 2)
          if (similarity >= EMBED_WEAK) {
            const existing = candidateMap.get(c.memory_id)
            if (!existing || similarity > existing.score) {
              candidateMap.set(c.memory_id, {
                targetId: c.memory_id,
                score: similarity,
                signalType: 'auto:embedding',
              })
            }
          }
        }
      }
    } catch {
      // sqlite-vec query failed — skip signal 3
    }
  }

  // --- Top 5 by score, insert ---
  const top5 = Array.from(candidateMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_EDGES_PER_MEM)

  if (top5.length === 0) return 0

  const writeEdges = db.transaction((edges) => {
    for (const edge of edges) {
      insertEdge.run(
        `${memoryId}-${edge.targetId}`,
        memoryId,
        edge.targetId,
        edge.signalType,
        edge.score,
        edge.signalType,
      )
    }
  })
  writeEdges(top5)
  return top5.length
}

let totalEdgesBuilt = 0
for (const id of seededIds) {
  const n = await buildEdgesForMemory(id)
  totalEdgesBuilt += n
}
console.log(`[seed] Auto-edge pass complete — ${totalEdgesBuilt} edge writes across ${seededIds.length} memories`)

// ── 2D: Verify graph connectivity ─────────────────────────────────────────────

console.log(`\n[seed] Phase 2D: verifying graph connectivity...`)

// Count distinct edges that touch at least one seeded memory
let edgesTouching = 0
const seededSet = new Set(seededIds)
const allEdges = db.prepare('SELECT sourceId, targetId FROM memory_relationships').all()
for (const e of allEdges) {
  if (seededSet.has(e.sourceId) || seededSet.has(e.targetId)) edgesTouching++
}

console.log(`[seed] Edges involving seeded memories: ${edgesTouching}`)

if (edgesTouching === 0) {
  console.warn(`\n[seed] WARNING: No edges formed. Diagnostics:`)
  const ftsCount = db.prepare('SELECT COUNT(*) as n FROM memories_fts').get().n
  console.warn(`[seed]   memories_fts rows: ${ftsCount} (expected ${MEMORIES.length})`)
  console.warn(`[seed]   Ollama running:    ${ollamaRunning}`)
  console.warn(`[seed]   sqlite-vec loaded: ${vectorSearchEnabled}`)
  console.warn(`[seed]   Tag Jaccard and keyword Jaccard should form edges even without Ollama.`)
  console.warn(`[seed]   Check that memories_fts was populated (FTS5 index built correctly).`)
}

// ── Final summary ──────────────────────────────────────────────────────────────

const finalMemCount = db.prepare('SELECT COUNT(*) as n FROM memories').get().n
const finalRelCount = db.prepare('SELECT COUNT(*) as n FROM memory_relationships').get().n
const autoEdgeCount = db.prepare(
  "SELECT COUNT(*) as n FROM memory_relationships WHERE signal_type LIKE 'auto:%'"
).get().n

console.log(`\n[seed] ── Final Summary ─────────────────────────────────────────────`)
console.log(`[seed]   Total memories in DB:       ${finalMemCount}`)
console.log(`[seed]   Total relationships in DB:  ${finalRelCount}`)
console.log(`[seed]   Auto-edges (signal auto:*): ${autoEdgeCount}`)
console.log(`[seed]   Memories seeded this run:   ${seededIds.length}`)
console.log(`[seed]   Edge writes this run:       ${totalEdgesBuilt}`)
console.log(`[seed]   Edges touching seeded IDs:  ${edgesTouching}`)
console.log(`[seed]   Ollama available:           ${ollamaRunning}`)
console.log(`[seed]   Vector search enabled:      ${vectorSearchEnabled}`)

if (!ollamaRunning || !vectorSearchEnabled) {
  console.log(`\n[seed]   To add embedding-based (purple) edges later:`)
  if (!ollamaRunning) {
    console.log(`[seed]     ollama serve && ollama pull all-minilm`)
  }
  console.log(`[seed]     Re-run: node scripts/run-as-node.cjs scripts/seed-project-brain.mjs`)
  console.log(`[seed]     (The script is idempotent — it will skip already-embedded memories)`)
}

db.close()
console.log(`\n[seed] Done — Cortex is now seeded as a project second brain.`)
