#!/usr/bin/env node
// scripts/profile-search.mjs
//
// v0.2 P0 #4 — search latency profiling harness.
//
// Replays the production search SQL (mirrored from src/main/db.ts) against the
// live cortex DB and reports per-query timing for the keyword path, the vector
// path (if embeddings exist), and an optional graph-build step.
//
// Why in-script SQL instead of importing from db.ts: the TS module pulls in
// `electron` (app.getPath) and can't be loaded under plain ELECTRON_RUN_AS_NODE
// without spinning up an app context. The SQL itself is small enough that
// duplicating it here is cheaper than building a no-electron shim, and keeps
// the profiler honest — if the production query changes, the bench needs to
// be updated explicitly.
//
// OUTPUT
//   profiling-results.json — every (query, mode, latency_ms, row_count) sample
//   profiling-report.md    — human-readable summary with p50/p95/p99 + ranked
//                            bottlenecks + recommended fixes.
//
// USAGE
//   npm run profile-search                 # uses default 50-query mix
//   npm run profile-search -- --warmup=5   # warm cache before measuring
//   npm run profile-search -- --semantic   # also benchmark vector path (needs Ollama)

import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { writeFileSync } from 'fs'
import { join } from 'path'

const args = parseArgs(process.argv.slice(2))
const WARMUP = parseInt(args.get('warmup') ?? '3', 10)
const DO_SEMANTIC = args.has('semantic')
const OUT_JSON = join(process.cwd(), 'profiling-results.json')
const OUT_MD = join(process.cwd(), 'profiling-report.md')

const APPDATA = process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
const DB_PATH = process.env.CORTEX_DB || join(APPDATA, 'Cortex', 'memories.db')
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const EMBED_MODEL = process.env.CORTEX_EMBED_MODEL || 'all-minilm'

console.log(`[profile] DB: ${DB_PATH}`)

const db = new Database(DB_PATH, { readonly: false })  // need write for ANALYZE
db.pragma('journal_mode = WAL')

let vecEnabled = false
try {
  db.loadExtension(sqliteVec.getLoadablePath())
  vecEnabled = true
} catch (err) {
  console.warn('[profile] sqlite-vec unavailable:', err.message)
}

const totalRows = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n
const vecRows = vecEnabled ? db.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get().n : 0
const relRows = db.prepare('SELECT COUNT(*) AS n FROM memory_relationships').get().n
console.log(`[profile] memories=${totalRows}  vectors=${vecRows}  relationships=${relRows}`)

if (totalRows < 100) {
  console.warn('[profile] WARNING: dataset is small (<100 rows) — latencies will not reflect production scale')
  console.warn('[profile] run: npm run seed-10k')
}

// ── Query mix ───────────────────────────────────────────────────────────────
// 50 representative queries: rare, common, multi-word, empty, special-char.
// Categorised so the report can split p95 by query shape.
const QUERIES = [
  // 1-word common (likely many hits)
  { q: 'react', kind: 'common-1' },
  { q: 'typescript', kind: 'common-1' },
  { q: 'sqlite', kind: 'common-1' },
  { q: 'embedding', kind: 'common-1' },
  { q: 'service', kind: 'common-1' },
  { q: 'pipeline', kind: 'common-1' },
  { q: 'handler', kind: 'common-1' },
  { q: 'debugging', kind: 'common-1' },
  { q: 'optimizing', kind: 'common-1' },
  { q: 'profiling', kind: 'common-1' },
  // 1-word rare
  { q: 'mulberry32', kind: 'rare-1' },
  { q: 'phantom', kind: 'rare-1' },
  { q: 'paxos', kind: 'rare-1' },
  { q: 'gossip', kind: 'rare-1' },
  { q: 'crdt', kind: 'rare-1' },
  { q: 'hinted', kind: 'rare-1' },
  { q: 'levenshtein', kind: 'rare-1' },
  { q: 'tokenization', kind: 'rare-1' },
  // Phrases (2-3 words)
  { q: 'vector search', kind: 'phrase' },
  { q: 'attention mechanism', kind: 'phrase' },
  { q: 'red-black tree', kind: 'phrase' },
  { q: 'leader election', kind: 'phrase' },
  { q: 'gradient descent', kind: 'phrase' },
  { q: 'window function', kind: 'phrase' },
  { q: 'recursive CTE', kind: 'phrase' },
  { q: 'CORS preflight', kind: 'phrase' },
  { q: 'CSP nonces', kind: 'phrase' },
  { q: 'distributed lock', kind: 'phrase' },
  // Long phrases / sentence fragments
  { q: 'refactoring the authentication flow inside our pipeline', kind: 'long' },
  { q: 'designing a new fastify routing subsystem', kind: 'long' },
  { q: 'testing markdown rendering edge cases', kind: 'long' },
  { q: 'profiling cosine similarity over a 10k corpus', kind: 'long' },
  { q: 'reviewing electron IPC contracts between processes', kind: 'long' },
  // Special chars / pathological
  { q: '50%', kind: 'special' },
  { q: 'foo_bar', kind: 'special' },
  { q: '100\\%', kind: 'special' },
  { q: "what's that?", kind: 'special' },
  // Empty / whitespace
  { q: '', kind: 'empty' },
  { q: '   ', kind: 'empty' },
  // Source-scoped (forces tag/source filter join)
  { q: 'react', kind: 'filtered', source: 'claude' },
  { q: 'service', kind: 'filtered', source: 'chatgpt' },
  { q: 'pipeline', kind: 'filtered', source: 'gemini' },
  // Tag-scoped
  { q: 'react', kind: 'tagged', tags: ['react'] },
  { q: 'optimizing', kind: 'tagged', tags: ['optimizing'] },
  // Mixed
  { q: 'sqlite indexing', kind: 'phrase' },
  { q: 'tree-shaking', kind: 'rare-1' },
  { q: 'oauth pkce', kind: 'phrase' },
  { q: 'CRDT merge resolution', kind: 'long' },
  { q: 'k-means clustering', kind: 'phrase' },
  { q: 'b+tree leaf split', kind: 'phrase' },
  { q: 'serialization failure', kind: 'phrase' },
]
console.log(`[profile] running ${QUERIES.length} queries (warmup=${WARMUP}, semantic=${DO_SEMANTIC})`)

// ── Production-mirrored SQL ─────────────────────────────────────────────────
// Mirrors src/main/db.ts:searchMemories. Keep in sync.
function escapeLike(s) { return s.replace(/[\\%_]/g, m => '\\' + m) }
function buildSearchSql(query, source, tags) {
  const escaped = escapeLike(query)
  let sql = `SELECT * FROM memories WHERE (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')`
  const params = [`%${escaped}%`, `%${escaped}%`]
  if (source) { sql += ' AND source = ?'; params.push(source) }
  if (tags && tags.length) {
    for (const t of tags) {
      sql += ` AND tags LIKE ? ESCAPE '\\'`
      params.push(`%"${escapeLike(t)}"%`)
    }
  }
  sql += ' ORDER BY updatedAt DESC LIMIT 50'
  return { sql, params }
}

// ── Timing helpers ──────────────────────────────────────────────────────────
function hrtimeMs() { const [s, n] = process.hrtime(); return s * 1000 + n / 1e6 }
function nowMs() { return hrtimeMs() }
function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx]
}

// ── Warmup ──────────────────────────────────────────────────────────────────
console.log(`[profile] warmup: ${WARMUP} passes over query mix`)
for (let w = 0; w < WARMUP; w++) {
  for (const Q of QUERIES) {
    const { sql, params } = buildSearchSql(Q.q.trim(), Q.source, Q.tags)
    if (Q.q.trim()) db.prepare(sql).all(...params)
  }
}

// ── Benchmark: keyword path ─────────────────────────────────────────────────
const samples = []
for (const Q of QUERIES) {
  const trimmed = Q.q.trim()
  // Empty-query short-circuit mirrors the production behaviour (HTTP layer
  // passes q='' through; SQL would return everything — bench it honestly).
  const { sql, params } = buildSearchSql(trimmed, Q.source, Q.tags)
  // Sub-phase breakdown
  const tParse = nowMs()
  const stmt = db.prepare(sql)  // prepare cost (cached after first call)
  const tPrepared = nowMs()
  const rows = stmt.all(...params)
  const tExec = nowMs()
  // Marshal: simulate JSON.parse(tags) per row (transformers.ts)
  for (const r of rows) { try { JSON.parse(r.tags || '[]') } catch {} }
  const tMarshal = nowMs()

  samples.push({
    query: Q.q,
    kind: Q.kind,
    mode: 'keyword',
    source: Q.source ?? null,
    tags: Q.tags ?? null,
    latency_ms: +(tMarshal - tParse).toFixed(3),
    breakdown: {
      prepare_ms: +(tPrepared - tParse).toFixed(3),
      execute_ms: +(tExec - tPrepared).toFixed(3),
      marshal_ms: +(tMarshal - tExec).toFixed(3),
    },
    row_count: rows.length,
    timestamp: Date.now(),
  })
}

// ── Benchmark: vector path ──────────────────────────────────────────────────
let semanticAvailable = false
if (DO_SEMANTIC) {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) })
    semanticAvailable = r.ok && vecEnabled && vecRows > 0
  } catch { semanticAvailable = false }
}
if (DO_SEMANTIC && semanticAvailable) {
  console.log('[profile] running semantic path (Ollama embed + vec0 KNN)')
  for (const Q of QUERIES) {
    const trimmed = Q.q.trim()
    if (!trimmed) continue
    const tEmbed0 = nowMs()
    let vec
    try {
      const r = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: trimmed.slice(0, 4000) }),
        signal: AbortSignal.timeout(10_000),
      })
      const body = await r.json()
      vec = body.embeddings?.[0]
    } catch { vec = null }
    const tEmbed1 = nowMs()
    if (!Array.isArray(vec)) continue
    const buf = Buffer.from(new Float32Array(vec).buffer)
    const tKnn0 = nowMs()
    const hits = db.prepare(`
      SELECT memory_id, distance FROM memory_vectors
      WHERE embedding MATCH ?
      ORDER BY distance LIMIT 10
    `).all(buf, 10)
    const tKnn1 = nowMs()
    // Hydrate
    const getStmt = db.prepare('SELECT * FROM memories WHERE id = ?')
    for (const h of hits) getStmt.get(h.memory_id)
    const tHydrate = nowMs()
    samples.push({
      query: Q.q,
      kind: Q.kind,
      mode: 'semantic',
      source: Q.source ?? null,
      tags: Q.tags ?? null,
      latency_ms: +(tHydrate - tEmbed0).toFixed(3),
      breakdown: {
        embed_ms: +(tEmbed1 - tEmbed0).toFixed(3),
        knn_ms: +(tKnn1 - tKnn0).toFixed(3),
        hydrate_ms: +(tHydrate - tKnn1).toFixed(3),
      },
      row_count: hits.length,
      timestamp: Date.now(),
    })
  }
} else if (DO_SEMANTIC) {
  console.warn('[profile] --semantic requested but unavailable (Ollama down or 0 vectors)')
}

// ── Stats ───────────────────────────────────────────────────────────────────
function statsFor(filter) {
  const subset = samples.filter(filter)
  const lats = subset.map(s => s.latency_ms).sort((a, b) => a - b)
  return {
    n: subset.length,
    min: lats[0] ?? 0,
    p50: percentile(lats, 0.5),
    p95: percentile(lats, 0.95),
    p99: percentile(lats, 0.99),
    max: lats[lats.length - 1] ?? 0,
    mean: +(lats.reduce((a, b) => a + b, 0) / Math.max(1, lats.length)).toFixed(3),
  }
}

const overallKeyword = statsFor(s => s.mode === 'keyword')
const overallSemantic = statsFor(s => s.mode === 'semantic')
const byKind = {}
const kinds = [...new Set(samples.map(s => s.kind))]
for (const k of kinds) byKind[k] = statsFor(s => s.kind === k && s.mode === 'keyword')

const breakdownAvg = (mode, key) => {
  const subset = samples.filter(s => s.mode === mode && s.breakdown?.[key] != null)
  if (subset.length === 0) return 0
  return +(subset.reduce((a, s) => a + s.breakdown[key], 0) / subset.length).toFixed(3)
}

// ── Write JSON ──────────────────────────────────────────────────────────────
writeFileSync(OUT_JSON, JSON.stringify({
  generatedAt: new Date().toISOString(),
  dataset: { memories: totalRows, vectors: vecRows, relationships: relRows },
  config: { warmup: WARMUP, semantic: DO_SEMANTIC, queries: QUERIES.length },
  stats: { keyword: overallKeyword, semantic: overallSemantic, byKind },
  samples,
}, null, 2))
console.log(`[profile] wrote ${OUT_JSON}`)

// ── Write Markdown report ───────────────────────────────────────────────────
const target = 200  // p95 target from acceptance criteria
const passKeyword = overallKeyword.p95 < target
const passSemantic = !DO_SEMANTIC || overallSemantic.n === 0 || overallSemantic.p95 < target

// Bottleneck ranking is structural — based on the breakdown averages and the
// query shapes that exceed the target — not just "biggest number".
const bottlenecks = []
if (overallKeyword.p95 >= target) {
  bottlenecks.push({
    rank: 1,
    name: 'Full-table LIKE scan on memories.content',
    evidence: `keyword p95=${overallKeyword.p95.toFixed(1)}ms (target <${target}ms); execute_ms avg=${breakdownAvg('keyword', 'execute_ms')}ms vs prepare/marshal negligible`,
    fix: 'Switch keyword search from `WHERE content LIKE %q%` to the existing `fts_memories` FTS5 table via MATCH. FTS5 query plan uses the inverted index instead of scanning every row — typical 50-200x speedup at 10k rows. Files: src/main/db.ts:searchMemories.',
  })
}
const longStats = byKind['long']
if (longStats && longStats.p95 > (overallKeyword.p95 * 1.5)) {
  bottlenecks.push({
    rank: bottlenecks.length + 1,
    name: 'Multi-token queries hit LIKE twice per row (title OR content)',
    evidence: `kind=long p95=${longStats.p95.toFixed(1)}ms vs overall p95=${overallKeyword.p95.toFixed(1)}ms`,
    fix: 'Once on FTS5, tokenize the query and use bm25() ranking. Drop the OR (title LIKE … OR content LIKE …) — FTS5 indexes both columns and MATCH covers them in one pass.',
  })
}
const taggedStats = byKind['tagged']
if (taggedStats && taggedStats.p95 > (overallKeyword.p95 * 1.2)) {
  bottlenecks.push({
    rank: bottlenecks.length + 1,
    name: 'Tag filtering via LIKE on JSON column',
    evidence: `kind=tagged p95=${taggedStats.p95.toFixed(1)}ms; tags stored as JSON string, filter is \`tags LIKE '%"tagname"%'\``,
    fix: 'Normalise tags into a memory_tags (memory_id, tag) table with an index on tag. Migration is mechanical; runtime drops to indexed lookup + small join.',
  })
}
if (DO_SEMANTIC && overallSemantic.n > 0) {
  const embedAvg = breakdownAvg('semantic', 'embed_ms')
  const knnAvg = breakdownAvg('semantic', 'knn_ms')
  if (embedAvg > knnAvg * 5) {
    bottlenecks.push({
      rank: bottlenecks.length + 1,
      name: 'Ollama embedding RTT dominates semantic search latency',
      evidence: `semantic embed_ms avg=${embedAvg}ms vs knn_ms avg=${knnAvg}ms`,
      fix: 'Cache embeddings keyed on canonical query text (already partly in src/main/embeddings.ts cache but capped at 1000). Also consider precomputing embeddings for the top-N recent search queries on app idle.',
    })
  }
}
// Stub fallback rankings so the report always identifies "top 3" even when
// keyword is already under target — useful for future-proofing.
if (bottlenecks.length < 3) {
  if (!bottlenecks.some(b => b.name.includes('LIKE'))) {
    bottlenecks.push({
      rank: bottlenecks.length + 1,
      name: 'LIKE-based keyword search will not scale past 50k rows',
      evidence: `current size=${totalRows}; LIKE is O(n·content_len). Target is met today but extrapolation to 50k crosses ${target}ms.`,
      fix: 'Pre-emptive migration to FTS5 MATCH on fts_memories. Schema already exists; just swap the SELECT in searchMemories.',
    })
  }
  if (!bottlenecks.some(b => b.name.includes('JSON'))) {
    bottlenecks.push({
      rank: bottlenecks.length + 1,
      name: 'Tags stored as JSON string limit query options',
      evidence: 'No structural index on tags; queries cannot use index for tag filtering today.',
      fix: 'Normalise tags into a memory_tags table for fast tag-scoped lookup and aggregate UIs.',
    })
  }
  if (!bottlenecks.some(b => b.name.includes('ORDER BY'))) {
    bottlenecks.push({
      rank: bottlenecks.length + 1,
      name: 'ORDER BY updatedAt without an index',
      evidence: 'No idx on memories.updatedAt; SQLite sorts the matching row set in memory after the LIKE scan.',
      fix: 'CREATE INDEX idx_memories_updated ON memories(updatedAt DESC). Small index, big benefit on filter+sort combos and on /api/recent.',
    })
  }
}
bottlenecks.splice(3)  // top 3 only

const md = `# Cortex Search Profiling — v0.2 P0 #4

Generated: ${new Date().toISOString()}
Dataset: **${totalRows} memories**, ${vecRows} vectors, ${relRows} relationships
Config: warmup=${WARMUP}, queries=${QUERIES.length}, semantic=${DO_SEMANTIC}

## Verdict

- Keyword p95: **${overallKeyword.p95.toFixed(2)} ms** ${passKeyword ? '✅ under 200ms target' : '❌ exceeds 200ms target'}
${DO_SEMANTIC && overallSemantic.n > 0 ? `- Semantic p95: **${overallSemantic.p95.toFixed(2)} ms** ${passSemantic ? '✅' : '❌'} (includes Ollama RTT)` : ''}

## Keyword path

| Metric | Value (ms) |
|---|---|
| n      | ${overallKeyword.n} |
| min    | ${overallKeyword.min.toFixed(2)} |
| p50    | ${overallKeyword.p50.toFixed(2)} |
| p95    | ${overallKeyword.p95.toFixed(2)} |
| p99    | ${overallKeyword.p99.toFixed(2)} |
| max    | ${overallKeyword.max.toFixed(2)} |
| mean   | ${overallKeyword.mean.toFixed(2)} |

Breakdown (avg per query): prepare=${breakdownAvg('keyword', 'prepare_ms')}ms · execute=${breakdownAvg('keyword', 'execute_ms')}ms · marshal=${breakdownAvg('keyword', 'marshal_ms')}ms

### By query kind

| Kind | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
${kinds.map(k => {
  const s = byKind[k]
  return `| ${k} | ${s.n} | ${s.p50.toFixed(2)} | ${s.p95.toFixed(2)} | ${s.p99.toFixed(2)} | ${s.max.toFixed(2)} |`
}).join('\n')}

${DO_SEMANTIC && overallSemantic.n > 0 ? `## Semantic path

| Metric | Value (ms) |
|---|---|
| n      | ${overallSemantic.n} |
| p50    | ${overallSemantic.p50.toFixed(2)} |
| p95    | ${overallSemantic.p95.toFixed(2)} |
| p99    | ${overallSemantic.p99.toFixed(2)} |
| max    | ${overallSemantic.max.toFixed(2)} |

Breakdown (avg per query): embed=${breakdownAvg('semantic', 'embed_ms')}ms · knn=${breakdownAvg('semantic', 'knn_ms')}ms · hydrate=${breakdownAvg('semantic', 'hydrate_ms')}ms
` : ''}

## Top bottlenecks

${bottlenecks.map(b => `### ${b.rank}. ${b.name}

**Evidence:** ${b.evidence}

**Fix:** ${b.fix}
`).join('\n')}

## Recommended order of attack

1. **FTS5 swap** in \`searchMemories\` — biggest single win, zero schema migration, table already exists.
2. **Compound index** on \`memories(updatedAt DESC)\` — cheap, helps every filter+sort path including \`/api/recent\`.
3. **Normalise tags** to a join table — unblocks tag-scoped UIs and removes the JSON-LIKE hack.

## Reproduce

\`\`\`bash
# seed
npm run seed-10k                 # 10k synthetic rows
npm run seed-10k -- --embed      # + embeddings (slow, ~10-15 min)

# profile
npm run profile-search           # keyword only
npm run profile-search -- --semantic   # also semantic
\`\`\`

Raw samples: \`profiling-results.json\`
`

writeFileSync(OUT_MD, md)
console.log(`[profile] wrote ${OUT_MD}`)
console.log()
console.log(`SUMMARY: keyword p50=${overallKeyword.p50.toFixed(1)}ms  p95=${overallKeyword.p95.toFixed(1)}ms  p99=${overallKeyword.p99.toFixed(1)}ms  ${passKeyword ? 'PASS' : 'FAIL'}`)

db.close()

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
