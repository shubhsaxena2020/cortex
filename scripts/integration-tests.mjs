// End-to-end integration tests for Phase 3 semantic search.
// Pure HTTP — no native modules. Creates 5 diverse memories via the live API,
// polls /api/admin/embed-status until vectors land, validates semantic ranking
// via /api/related, and cleans up via DELETE /api/memories/:id.
//
// Test memories use the prefix [TEST-PHASE3] so leftover rows from a crashed
// run can be safely swept on the next run.
//
// Run standalone:  node scripts/integration-tests.mjs
// Imported by:     scripts/final-phase3-report.mjs

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_PREFIX = '[TEST-PHASE3] '

const CASES = [
  { topic: 'ai',      text: 'Machine learning models are trained on labeled datasets using gradient descent and backpropagation' },
  { topic: 'ai',      text: 'Neural networks with attention mechanisms revolutionized natural language processing tasks' },
  { topic: 'coffee',  text: 'Espresso extraction requires fine-ground beans and approximately 9 bars of pump pressure' },
  { topic: 'sports',  text: 'The marathon distance of 42.195 kilometers was standardized at the 1908 London Olympic Games' },
  { topic: 'food',    text: 'Sourdough fermentation uses wild yeast and lactic acid bacteria to develop complex flavor compounds' }
]

const EMBED_WAIT_MAX_MS = 15_000
const EMBED_POLL_INTERVAL_MS = 500

export async function run() {
  const results = []

  // ── Preflight ────────────────────────────────────────────────────────────
  const cfgPath = join(process.env.APPDATA || '', 'Cortex', 'extension-config.json')
  if (!existsSync(cfgPath)) {
    return { name: 'integration', error: 'extension-config.json missing — start the app first', results: [], passed: 0, failed: 0 }
  }
  let cfg
  try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) }
  catch (e) { return { name: 'integration', error: `bad config: ${e.message}`, results: [], passed: 0, failed: 0 } }

  const base = `http://127.0.0.1:${cfg.port}`
  const authHeaders = { 'Authorization': `Bearer ${cfg.token}` }
  const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' }

  // App reachable?
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) throw new Error(`/health ${r.status}`)
  } catch (e) {
    return { name: 'integration', error: `app unreachable at ${base}: ${e.message}`, results: [], passed: 0, failed: 0 }
  }

  // Pre-cleanup: sweep any leftover [TEST-PHASE3] memories from a previous run.
  // We use /api/search with the prefix to find them, then DELETE each.
  try {
    const r = await fetch(`${base}/api/search?q=${encodeURIComponent(TEST_PREFIX)}`, { headers: authHeaders })
    const body = await r.json()
    for (const mem of (body.results || [])) {
      if (mem.title?.startsWith(TEST_PREFIX)) {
        await fetch(`${base}/api/memories/${mem.id}`, { method: 'DELETE', headers: authHeaders })
      }
    }
  } catch { /* best-effort */ }

  const createdIds = []

  try {
    // ── 1. Create 5 memories via HTTP ──────────────────────────────────────
    for (const c of CASES) {
      const r = await fetch(`${base}/api/memories`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          title: `${TEST_PREFIX}${c.topic}`,
          content: c.text,
          source: 'manual',
          tags: ['test', 'phase3', c.topic]
        })
      })
      if (!r.ok) throw new Error(`POST /api/memories ${r.status} for topic=${c.topic}`)
      const body = await r.json()
      createdIds.push({ id: body.memory.id, topic: c.topic, text: c.text })
    }
    results.push({ name: 'Create 5 diverse memories via HTTP', ok: true, detail: `${createdIds.length}/5` })

    // ── 2. Poll /api/admin/embed-status until all 5 have vectors ───────────
    let waited = 0
    let embeddedCount = 0
    let vectorSearchEnabled = false
    let lastStatus = null
    const idsParam = createdIds.map(c => c.id).join(',')
    while (waited <= EMBED_WAIT_MAX_MS) {
      const r = await fetch(`${base}/api/admin/embed-status?ids=${idsParam}`, { headers: authHeaders })
      lastStatus = await r.json()
      vectorSearchEnabled = !!lastStatus.vectorSearchEnabled
      embeddedCount = (lastStatus.embedded || []).length
      if (embeddedCount === createdIds.length) break
      await new Promise(r => setTimeout(r, EMBED_POLL_INTERVAL_MS))
      waited += EMBED_POLL_INTERVAL_MS
    }

    if (!vectorSearchEnabled) {
      results.push({
        name: 'sqlite-vec extension is loaded (vectorSearchEnabled)',
        ok: false,
        detail: 'Server reports vector search disabled — check `npm run postinstall` and that sqlite-vec is installed'
      })
    } else {
      results.push({ name: 'sqlite-vec extension is loaded (vectorSearchEnabled)', ok: true })
    }

    results.push({
      name: 'All 5 memories have vector embeddings within 15s',
      ok: embeddedCount === createdIds.length,
      detail: `${embeddedCount}/${createdIds.length} after ${waited}ms` + (lastStatus?.missing?.length ? ` (missing ${lastStatus.missing.length})` : '')
    })

    // ── 3. Semantic ranking: ML query should surface AI memories ───────────
    const aiTitles = new Set(createdIds.filter(c => c.topic === 'ai').map(c => `${TEST_PREFIX}${c.topic}`))
    const offTopicTitles = new Set(createdIds.filter(c => c.topic !== 'ai').map(c => `${TEST_PREFIX}${c.topic}`))
    {
      const r = await fetch(`${base}/api/related?context=${encodeURIComponent('artificial intelligence and neural networks for prediction')}`, { headers: authHeaders })
      const body = await r.json()
      const top3 = (body.results || []).slice(0, 3)
      const aiHits = top3.filter(m => aiTitles.has(m.title)).length
      const offHits = top3.filter(m => offTopicTitles.has(m.title)).length
      const ok = aiHits >= 1 && aiHits >= offHits
      results.push({
        name: '/api/related ranks AI ≥ off-topic for ML query',
        ok,
        detail: `top3 AI=${aiHits} off-topic=${offHits} — ${top3.map(m => m.title).join(' | ')}`
      })
    }

    // ── 4. Reverse query: coffee query should surface the coffee memory ────
    const coffeeTitles = new Set(createdIds.filter(c => c.topic === 'coffee').map(c => `${TEST_PREFIX}${c.topic}`))
    {
      const r = await fetch(`${base}/api/related?context=${encodeURIComponent('espresso machine pressure and grind size')}`, { headers: authHeaders })
      const body = await r.json()
      const top3 = (body.results || []).slice(0, 3)
      const coffeeHits = top3.filter(m => coffeeTitles.has(m.title)).length
      const aiHits = top3.filter(m => aiTitles.has(m.title)).length
      const ok = coffeeHits >= 1 && coffeeHits >= aiHits
      results.push({
        name: '/api/related ranks coffee ≥ AI for espresso query',
        ok,
        detail: `top3 coffee=${coffeeHits} AI=${aiHits} — ${top3.map(m => m.title).join(' | ')}`
      })
    }

    // ── 5. keywords[] still returned for UI ────────────────────────────────
    {
      const r = await fetch(`${base}/api/related?context=${encodeURIComponent('machine learning')}`, { headers: authHeaders })
      const body = await r.json()
      const ok = Array.isArray(body.keywords) && body.keywords.length > 0
      results.push({
        name: '/api/related returns keywords[] for UI display',
        ok,
        detail: ok ? body.keywords.join(', ') : JSON.stringify(body)
      })
    }

    // ── 6. /api/search (LIKE) still works on the new test memories ─────────
    {
      const r = await fetch(`${base}/api/search?q=${encodeURIComponent('espresso')}`, { headers: authHeaders })
      const body = await r.json()
      const titles = (body.results || []).map(m => m.title)
      const ok = titles.some(t => coffeeTitles.has(t))
      results.push({
        name: '/api/search (LIKE) finds the coffee test memory',
        ok,
        detail: `matched titles: ${titles.join(', ').slice(0, 200)}`
      })
    }

    // ── 7. DELETE removes vectors too ──────────────────────────────────────
    if (vectorSearchEnabled && createdIds.length > 0) {
      const victim = createdIds[0]
      const del = await fetch(`${base}/api/memories/${victim.id}`, { method: 'DELETE', headers: authHeaders })
      const delOk = del.status === 204
      // Re-check embed status — victim.id should no longer be in `embedded`
      const r = await fetch(`${base}/api/admin/embed-status?ids=${victim.id}`, { headers: authHeaders })
      const body = await r.json()
      const stillEmbedded = (body.embedded || []).includes(victim.id)
      results.push({
        name: 'DELETE /api/memories/:id removes the embedding too',
        ok: delOk && !stillEmbedded,
        detail: `delete=${del.status} stillEmbedded=${stillEmbedded}`
      })
      // Remove from cleanup list (already deleted)
      if (delOk) createdIds.splice(0, 1)
    }

  } catch (e) {
    results.push({ name: 'Test run reached the end without throwing', ok: false, detail: e.message })
  } finally {
    // ── Cleanup ────────────────────────────────────────────────────────────
    for (const c of createdIds) {
      try {
        await fetch(`${base}/api/memories/${c.id}`, { method: 'DELETE', headers: authHeaders })
      } catch { /* best-effort */ }
    }
  }

  return {
    name: 'integration',
    passed: results.filter(x => x.ok).length,
    failed: results.filter(x => !x.ok).length,
    results
  }
}

// Standalone runner
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await run()
  console.log(JSON.stringify(r, null, 2))
  process.exit(r.failed === 0 && !r.error ? 0 : 1)
}
