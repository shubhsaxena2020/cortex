// Phase 3 automated tests — run with: node scripts/test-embeddings.mjs
//
// Prerequisites:
//   1. ollama serve            (or Ollama desktop running)
//   2. ollama pull all-minilm
//   3. npm install sqlite-vec  (one-time, done in app already)
//
// This script uses a TEMPORARY in-memory database and the live Ollama
// instance. It does NOT touch your real memories.db.

import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const MODEL = process.env.CORTEX_EMBED_MODEL || 'all-minilm'
const DIM = 384

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM_C = '\x1b[2m'
const RESET = '\x1b[0m'

let pass = 0
let fail = 0

function ok(label, detail = '') {
  console.log(`${GREEN}[PASS]${RESET} ${label}${detail ? `  ${DIM_C}${detail}${RESET}` : ''}`)
  pass++
}
function bad(label, detail = '') {
  console.log(`${RED}[FAIL]${RESET} ${label}${detail ? `\n       ${detail}` : ''}`)
  fail++
}
function note(msg) {
  console.log(`${YELLOW}[NOTE]${RESET} ${msg}`)
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

async function embed(text) {
  const r = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: text })
  })
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`)
  const body = await r.json()
  return body.embeddings[0]
}

console.log(`\n${DIM_C}Phase 3 — automated tests${RESET}`)
console.log(`${DIM_C}Ollama URL: ${OLLAMA_URL}   Model: ${MODEL}   Dim: ${DIM}${RESET}\n`)

// ── Test 1: Model load via Ollama tags ──────────────────────────────────────
console.log('Test 1: Ollama reachable + model pulled')
let ollamaOk = false
try {
  const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
  if (!r.ok) { bad('Ollama responded but not 200', `HTTP ${r.status}`); }
  else {
    const body = await r.json()
    const found = (body.models ?? []).some(m => (m.name || '').startsWith(MODEL))
    if (!found) bad(`Model "${MODEL}" not pulled`, `Run: ollama pull ${MODEL}`)
    else { ok('Embeddings model available', MODEL); ollamaOk = true }
  }
} catch (e) {
  bad('Ollama unreachable', `Start it: 'ollama serve' or Ollama desktop. (${e.message})`)
}

if (!ollamaOk) {
  console.log(`\n${RED}Cannot continue without Ollama. Fix the above and rerun.${RESET}\n`)
  process.exit(1)
}

// ── Test 2: Semantic similarity scoring is sane ─────────────────────────────
console.log('\nTest 2: Embedding similarity (cosine A↔B > 0.5 > A↔C)')
const A = 'machine learning models trained on neural networks'
const B = 'deep learning with convolutional neural nets for image classification'
const C = 'pour-over coffee brewing temperature and grind size'
let eA, eB, eC
try {
  ;[eA, eB, eC] = await Promise.all([embed(A), embed(B), embed(C)])
  const ab = cosine(eA, eB)
  const ac = cosine(eA, eC)
  const detail = `A↔B=${ab.toFixed(3)}  A↔C=${ac.toFixed(3)}`
  if (ab > 0.5 && ab > ac + 0.15) ok('Similarity ordering is correct', detail)
  else bad('Similarity ordering is wrong', detail)
} catch (e) {
  bad('Could not generate embeddings', e.message)
}

// ── Test 3: Vector DB ranking ───────────────────────────────────────────────
console.log('\nTest 3: sqlite-vec KNN ranks semantically-similar memories first')
let tmpDir, dbPath, db
try {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-test-'))
  dbPath = join(tmpDir, 'test.db')
  db = new Database(dbPath)
  sqliteVec.load(db)
  db.exec(`CREATE VIRTUAL TABLE memory_vectors USING vec0(memory_id TEXT PRIMARY KEY, embedding FLOAT[${DIM}]);`)

  const corpus = [
    { id: randomUUID(), text: 'Machine learning is about training neural networks' },
    { id: randomUUID(), text: 'Deep learning uses convolutional networks for vision' },
    { id: randomUUID(), text: 'Coffee brewing requires hot water and filter paper' },
    { id: randomUUID(), text: 'Pizza dough needs cold fermentation for 48 hours' },
    { id: randomUUID(), text: 'Transformers and attention powering language models' }
  ]
  const corpusEmbeds = await Promise.all(corpus.map(c => embed(c.text)))
  const insert = db.prepare('INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)')
  for (let i = 0; i < corpus.length; i++) {
    insert.run(corpus[i].id, Buffer.from(new Float32Array(corpusEmbeds[i]).buffer))
  }

  const query = await embed('neural networks for machine learning')
  const rows = db.prepare(`
    SELECT memory_id, distance FROM memory_vectors
    WHERE embedding MATCH ?
    ORDER BY distance LIMIT 3
  `).all(Buffer.from(new Float32Array(query).buffer))

  const topIds = rows.map(r => r.memory_id)
  const mlIds = new Set([corpus[0].id, corpus[1].id, corpus[4].id])  // the ML/AI memories
  const offTopicIds = new Set([corpus[2].id, corpus[3].id])           // coffee + pizza

  const top3Hits = topIds.filter(id => mlIds.has(id)).length
  const offTopicInTop3 = topIds.some(id => offTopicIds.has(id))

  if (top3Hits >= 2 && !offTopicInTop3) {
    ok(`Top-3 contains ${top3Hits} ML memories, no off-topic`, `distances: ${rows.map(r => r.distance.toFixed(3)).join(', ')}`)
  } else {
    bad(`Ranking off: top3Hits=${top3Hits}, offTopic=${offTopicInTop3}`,
        rows.map(r => `${r.memory_id.slice(0,6)} d=${r.distance.toFixed(3)}`).join('\n       '))
  }
} catch (e) {
  bad('Vector DB test crashed', e.stack || e.message)
} finally {
  try { db?.close() } catch {}
  try { if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true }) } catch {}
}

// ── Test 4: Batch embed survives N parallel calls ───────────────────────────
console.log('\nTest 4: Batch embedding of 10 memories in parallel')
try {
  const texts = Array.from({ length: 10 }, (_, i) => `Test memory number ${i}: random content for embedding stress test`)
  const t0 = Date.now()
  const vecs = await Promise.all(texts.map(embed))
  const elapsed = Date.now() - t0
  const allValid = vecs.every(v => Array.isArray(v) && v.length === DIM)
  if (allValid) ok(`10 embeddings in ${elapsed}ms`)
  else bad('Some embeddings had wrong shape')
} catch (e) {
  bad('Batch embedding failed', e.message)
}

// ── Test 5: API integration (only if app is running) ────────────────────────
console.log('\nTest 5: GET /api/related against the live app (skipped if app is not running)')
try {
  const cfgPath = join(process.env.APPDATA || '', 'Cortex', 'extension-config.json')
  if (!existsSync(cfgPath)) {
    note('extension-config.json not found — skipping (start the app first to populate it)')
  } else {
    const { readFileSync } = await import('node:fs')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    const url = `http://127.0.0.1:${cfg.port}/api/related?context=${encodeURIComponent('neural networks for machine learning')}`
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${cfg.token}` } })
    if (!r.ok) bad(`/api/related returned ${r.status}`)
    else {
      const body = await r.json()
      const n = Array.isArray(body.results) ? body.results.length : 0
      ok(`/api/related responded with ${n} result(s)`,
        n > 0 ? `top: "${body.results[0].title}"` : '(empty — your memories may not be embedded yet; let the seed run)')
    }
  }
} catch (e) {
  note(`Skipped: ${e.message}`)
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${DIM_C}─────────────────────────────${RESET}`)
const color = fail === 0 ? GREEN : RED
console.log(`${color}${pass} passed, ${fail} failed${RESET}`)
process.exit(fail === 0 ? 0 : 1)
