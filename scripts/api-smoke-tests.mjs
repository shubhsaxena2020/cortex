// HTTP endpoint smoke tests for the Cortex API.
// Reads the live app's extension-config.json, hits all 5 endpoints with valid
// + invalid auth, validates response shapes. Cleans up any memory it creates.
//
// Run standalone:  node scripts/api-smoke-tests.mjs
// Imported by:     scripts/final-phase3-report.mjs

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_PREFIX = '[TEST-SMOKE] '

export async function run() {
  const results = []

  const cfgPath = join(process.env.APPDATA || '', 'Cortex', 'extension-config.json')
  if (!existsSync(cfgPath)) {
    return { name: 'api-smoke', error: 'extension-config.json missing — start the app first (npm run dev)', results: [], passed: 0, failed: 0 }
  }
  let cfg
  try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) }
  catch (e) { return { name: 'api-smoke', error: `bad config: ${e.message}`, results: [], passed: 0, failed: 0 } }

  const base = `http://127.0.0.1:${cfg.port}`

  async function call(method, path, opts = {}) {
    const init = { method, headers: { ...(opts.headers || {}) } }
    if (opts.body) {
      init.body = JSON.stringify(opts.body)
      init.headers['Content-Type'] = 'application/json'
    }
    if (opts.auth !== false && !init.headers['Authorization']) {
      init.headers['Authorization'] = `Bearer ${cfg.token}`
    }
    try {
      const r = await fetch(base + path, { ...init, signal: AbortSignal.timeout(10_000) })
      let body = null
      try { body = await r.json() } catch {}
      return { status: r.status, body }
    } catch (e) {
      return { status: 0, body: null, err: e.message }
    }
  }

  function check(name, cond, detail = '') {
    results.push({ name, ok: !!cond, detail })
  }

  // 1. /health (public)
  let r = await call('GET', '/health', { auth: false })
  check('GET /health → 200', r.status === 200, `status=${r.status}`)
  check('/health body has ok=true and app=cortex',
    r.body?.ok === true && r.body?.app === 'cortex',
    JSON.stringify(r.body))
  check('/health body has version + apiVersion',
    typeof r.body?.version === 'string' && typeof r.body?.apiVersion === 'number')

  // 2. Auth: missing token → 401
  r = await call('GET', '/api/recent', { auth: false })
  check('Missing token on /api/recent → 401', r.status === 401, `status=${r.status}`)

  // 3. Auth: bad token → 401 with INVALID_TOKEN
  r = await call('GET', '/api/recent', {
    headers: { 'Authorization': 'Bearer ' + '0'.repeat(64) }
  })
  check('Invalid token on /api/recent → 401', r.status === 401, `status=${r.status}`)
  check('Invalid token response includes code=INVALID_TOKEN',
    r.body?.code === 'INVALID_TOKEN',
    JSON.stringify(r.body))

  // 4. /api/recent with valid token
  r = await call('GET', '/api/recent?limit=5')
  check('GET /api/recent?limit=5 → 200', r.status === 200, `status=${r.status}`)
  check('/api/recent returns results[]', Array.isArray(r.body?.results))
  if (Array.isArray(r.body?.results)) {
    check('/api/recent respects limit', r.body.results.length <= 5, `got ${r.body.results.length}`)
  }

  // 5. /api/search
  r = await call('GET', '/api/search?q=' + encodeURIComponent('a'))
  check('GET /api/search?q=a → 200', r.status === 200, `status=${r.status}`)
  check('/api/search returns results[]', Array.isArray(r.body?.results))

  // 6. /api/related (semantic)
  r = await call('GET', '/api/related?context=' + encodeURIComponent('artificial intelligence and machine learning'))
  check('GET /api/related → 200', r.status === 200, `status=${r.status}`)
  check('/api/related returns results[] and keywords[]',
    Array.isArray(r.body?.results) && Array.isArray(r.body?.keywords))

  // 7. POST /api/memories — round-trip
  const created = await call('POST', '/api/memories', {
    body: {
      title: TEST_PREFIX + 'smoke memory',
      content: 'transient memory created by api-smoke-tests; will be deleted',
      source: 'manual',
      tags: ['smoke', 'phase3']
    }
  })
  check('POST /api/memories → 201', created.status === 201, `status=${created.status}`)
  check('POST returns the created memory with an id',
    typeof created.body?.memory?.id === 'string',
    JSON.stringify(created.body).slice(0, 100))

  // 8. Cleanup the test memory via DELETE endpoint
  if (created.body?.memory?.id) {
    const del = await call('DELETE', `/api/memories/${created.body.memory.id}`)
    check('DELETE /api/memories/:id → 204', del.status === 204, `status=${del.status}`)

    // Verify it's actually gone — recent shouldn't include it
    const after = await call('GET', '/api/recent?limit=50')
    const stillThere = (after.body?.results || []).some(m => m.id === created.body.memory.id)
    check('Deleted memory no longer appears in /api/recent', !stillThere)
  }

  return {
    name: 'api-smoke',
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
