// http.ts integration tests using Fastify's inject() — no real socket,
// no real DB, no real Ollama. db.ts and embeddings.ts are mocked so the
// tests run in plain Node and exercise routing/auth/validation logic only.
//
// Coverage at the live HTTP layer (with real SQLite + real Ollama) lives in
// scripts/integration-tests.mjs which the Electron app drives.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

const TOKEN = 'a'.repeat(64)
const VALID_AUTH = { authorization: `Bearer ${TOKEN}` }
const EXT_ORIGIN = { origin: 'chrome-extension://test' }

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('./extension-config', () => ({
  getToken: () => TOKEN
}))

// Stateful in-memory fake DB. Behaves enough like the real db.ts surface
// for the HTTP layer to exercise create / read / search / delete paths.
type FakeRow = {
  id: string; title: string; content: string
  timestamp: number; updatedAt: number; source: string; tags: string[]
}
const store = new Map<string, FakeRow>()
const vectors = new Map<string, number[]>()
let vectorSearchEnabled = true

vi.mock('./db', () => ({
  hasVectorSearch: () => vectorSearchEnabled,
  getMemory: (id: string) => store.get(id) ?? null,
  getAllMemories: () => [...store.values()].sort((a, b) => b.updatedAt - a.updatedAt),
  createMemory: (id: string, title: string, content: string, source: string, tags: string[] = [], url: string | null = null) => {
    const now = Date.now()
    const row = { id, title, content, source, tags, timestamp: now, updatedAt: now, url }
    store.set(id, row)
    return row
  },
  findMemoryByCanonicalUrl: (canon: string | null) => {
    if (!canon) return null
    for (const r of store.values()) if (r.url === canon) return r
    return null
  },
  setMemoryUrl: (id: string, url: string | null) => {
    const r = store.get(id); if (r) { r.url = url; store.set(id, r) }
  },
  upsertMemoryByUrl: (
    newId: string, title: string, content: string, source: string, tags: string[], canon: string | null,
  ) => {
    const now = Date.now()
    if (canon) {
      for (const r of store.values()) {
        if (r.url === canon) {
          const updated = { ...r, title, content, source, tags, updatedAt: now }
          store.set(r.id, updated)
          return { memory: updated, action: 'updated' as const }
        }
      }
    }
    const row = { id: newId, title, content, source, tags, timestamp: now, updatedAt: now, url: canon }
    store.set(newId, row)
    return { memory: row, action: 'created' as const }
  },
  deleteMemory: (id: string) => {
    store.delete(id)
    vectors.delete(id)
    return { success: true }
  },
  searchMemories: (q: string, source?: string, tags?: string[]) => {
    const ql = (q || '').toLowerCase()
    return [...store.values()].filter(r => {
      const matchesQ = !ql || r.title.toLowerCase().includes(ql) || r.content.toLowerCase().includes(ql)
      const matchesSource = !source || r.source === source
      const matchesTags = !tags || tags.every(t => r.tags.includes(t))
      return matchesQ && matchesSource && matchesTags
    })
  },
  storeEmbedding: (id: string, vec: number[]) => { vectors.set(id, vec) },
  vectorSearch: (_q: number[], limit: number) => {
    // Return memories with stored vectors, fake distance ascending.
    return [...vectors.keys()].slice(0, limit).map((id, i) => ({ memory_id: id, distance: i * 0.1 }))
  },
  getEmbeddedMemoryIds: () => new Set(vectors.keys()),
  countEmbeddings: () => vectors.size,
  // v0.3.0 auto-tagging: the POST route reads the tag vocabulary for
  // heuristic suggestions. Empty vocab = suggestions come from content only.
  getTagCounts: () => [] as Array<{ tag: string; count: number }>,
}))

vi.mock('./embeddings', () => ({
  getEmbedding: vi.fn(async (text: string) => {
    if (!text) return null
    return new Array(384).fill(0).map((_, i) => Math.sin(i + text.length))
  })
}))

// Now import the module under test (after mocks are wired).
const { buildApp, armPairing, __resetPairingForTest } = await import('./http')

beforeEach(() => {
  store.clear()
  vectors.clear()
  vectorSearchEnabled = true
  __resetPairingForTest()
})

function mkApp() {
  return buildApp({ logger: false })
}

afterEach(async () => {
  // app.close is called per-test by callers that need it
})

// ── /health (public) ───────────────────────────────────────────────────────

describe('http — /health', () => {
  it('returns ok=true and shape without auth', async () => {
    const app = mkApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/health' })
      expect(r.statusCode).toBe(200)
      const body = r.json()
      expect(body.ok).toBe(true)
      expect(body.app).toBe('cortex')
      expect(typeof body.version).toBe('string')
      expect(body.apiVersion).toBe(1)
    } finally { await app.close() }
  })
})

// ── Auth (all /api/*) ──────────────────────────────────────────────────────

describe('http — auth', () => {
  it('rejects missing token with 401 + MISSING_TOKEN code', async () => {
    const app = mkApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/recent' })
      expect(r.statusCode).toBe(401)
      expect(r.json().code).toBe('MISSING_TOKEN')
    } finally { await app.close() }
  })

  it('rejects bad token with 401 + INVALID_TOKEN code', async () => {
    const app = mkApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: '/api/recent',
        headers: { authorization: 'Bearer ' + '0'.repeat(64) }
      })
      expect(r.statusCode).toBe(401)
      expect(r.json().code).toBe('INVALID_TOKEN')
    } finally { await app.close() }
  })

  it('rejects non-extension Origin with 401 + INVALID_ORIGIN code', async () => {
    const app = mkApp()
    try {
      const r = await app.inject({
        method: 'GET',
        url: '/api/recent',
        headers: { ...VALID_AUTH, origin: 'https://evil.example' }
      })
      expect(r.statusCode).toBe(401)
      expect(r.json().code).toBe('INVALID_ORIGIN')
    } finally { await app.close() }
  })

  it('accepts valid token with missing Origin (Chrome quirk allowance)', async () => {
    const app = mkApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/recent', headers: VALID_AUTH })
      expect(r.statusCode).toBe(200)
    } finally { await app.close() }
  })

  it('responds to OPTIONS preflight with 204 + CORS headers when Origin is chrome-extension', async () => {
    const app = mkApp()
    try {
      const r = await app.inject({
        method: 'OPTIONS',
        url: '/api/memories',
        headers: EXT_ORIGIN
      })
      expect(r.statusCode).toBe(204)
      expect(r.headers['access-control-allow-origin']).toBe('chrome-extension://test')
      expect(r.headers['access-control-allow-methods']).toContain('POST')
    } finally { await app.close() }
  })
})

// ── /api/recent ────────────────────────────────────────────────────────────

describe('http — /api/recent', () => {
  it('returns empty when no memories exist', async () => {
    const app = mkApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/recent', headers: VALID_AUTH })
      expect(r.statusCode).toBe(200)
      expect(r.json().results).toEqual([])
    } finally { await app.close() }
  })

  it('respects ?limit', async () => {
    const app = mkApp()
    try {
      for (let i = 0; i < 8; i++) {
        await app.inject({
          method: 'POST',
          url: '/api/memories',
          headers: { ...VALID_AUTH, 'content-type': 'application/json' },
          payload: { title: `m${i}`, content: '', source: 'manual', tags: [] }
        })
      }
      const r = await app.inject({ method: 'GET', url: '/api/recent?limit=3', headers: VALID_AUTH })
      expect(r.statusCode).toBe(200)
      expect(r.json().results).toHaveLength(3)
    } finally { await app.close() }
  })

  it('clamps absurd limits into [1, 50]', async () => {
    const app = mkApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/recent?limit=99999', headers: VALID_AUTH })
      expect(r.statusCode).toBe(200)
      // empty store but the limit clamp itself didn't error
    } finally { await app.close() }
  })
})

// ── /api/search ────────────────────────────────────────────────────────────

describe('http — /api/search', () => {
  it('returns LIKE matches with highlight snippet on the matched substring', async () => {
    const app = mkApp()
    try {
      await app.inject({
        method: 'POST', url: '/api/memories',
        headers: { ...VALID_AUTH, 'content-type': 'application/json' },
        payload: { title: 'test', content: 'yo its working fine', source: 'manual', tags: [] }
      })
      const r = await app.inject({ method: 'GET', url: '/api/search?q=working', headers: VALID_AUTH })
      expect(r.statusCode).toBe(200)
      const results = r.json().results
      expect(results).toHaveLength(1)
      expect(results[0].highlight).toContain('<mark>')
      expect(results[0].highlight).toContain('working')
    } finally { await app.close() }
  })

  it('ignores unknown source values (silently treats as no filter)', async () => {
    const app = mkApp()
    try {
      await app.inject({
        method: 'POST', url: '/api/memories',
        headers: { ...VALID_AUTH, 'content-type': 'application/json' },
        payload: { title: 'x', content: 'y', source: 'manual', tags: [] }
      })
      const r = await app.inject({ method: 'GET', url: '/api/search?q=&source=bogus', headers: VALID_AUTH })
      expect(r.statusCode).toBe(200)
      expect(r.json().results).toHaveLength(1)
    } finally { await app.close() }
  })
})

// ── POST /api/memories ─────────────────────────────────────────────────────

describe('http — POST /api/memories', () => {
  it('creates with 201 and returns the new memory', async () => {
    const app = mkApp()
    const onCreated = vi.fn()
    const a = buildApp({ logger: false, onMemoryCreated: onCreated })
    try {
      const r = await a.inject({
        method: 'POST', url: '/api/memories',
        headers: { ...VALID_AUTH, 'content-type': 'application/json' },
        payload: { title: 'New', content: 'Hi', source: 'claude', tags: ['t'] }
      })
      expect(r.statusCode).toBe(201)
      const body = r.json()
      expect(body.memory.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(body.memory.title).toBe('New')
      expect(body.memory.source).toBe('claude')
      expect(onCreated).toHaveBeenCalledTimes(1)
    } finally { await a.close(); await app.close() }
  })

  it('defaults title to "Untitled" and source to "manual" when missing', async () => {
    const app = mkApp()
    try {
      const r = await app.inject({
        method: 'POST', url: '/api/memories',
        headers: { ...VALID_AUTH, 'content-type': 'application/json' },
        payload: { content: 'just content' }
      })
      expect(r.statusCode).toBe(201)
      expect(r.json().memory.title).toBe('Untitled')
      expect(r.json().memory.source).toBe('manual')
    } finally { await app.close() }
  })

  it('coerces invalid source to "manual"', async () => {
    const app = mkApp()
    try {
      const r = await app.inject({
        method: 'POST', url: '/api/memories',
        headers: { ...VALID_AUTH, 'content-type': 'application/json' },
        payload: { title: 't', content: 'c', source: 'not-a-real-source' }
      })
      expect(r.json().memory.source).toBe('manual')
    } finally { await app.close() }
  })

  it('passes url to onMemoryCreated callback', async () => {
    const onCreated = vi.fn()
    const a = buildApp({ logger: false, onMemoryCreated: onCreated })
    try {
      await a.inject({
        method: 'POST', url: '/api/memories',
        headers: { ...VALID_AUTH, 'content-type': 'application/json' },
        payload: { title: 'Link', content: 'body', source: 'claude', url: 'https://claude.ai/chat/123' }
      })
      expect(onCreated).toHaveBeenCalledOnce()
      const [, urlArg] = onCreated.mock.calls[0] as [unknown, string]
      expect(urlArg).toBe('https://claude.ai/chat/123')
    } finally { await a.close() }
  })

  it('passes undefined url when url field omitted', async () => {
    const onCreated = vi.fn()
    const a = buildApp({ logger: false, onMemoryCreated: onCreated })
    try {
      await a.inject({
        method: 'POST', url: '/api/memories',
        headers: { ...VALID_AUTH, 'content-type': 'application/json' },
        payload: { title: 'No URL', content: 'body' }
      })
      expect(onCreated).toHaveBeenCalledOnce()
      const [, urlArg] = onCreated.mock.calls[0] as [unknown, unknown]
      expect(urlArg).toBeUndefined()
    } finally { await a.close() }
  })
})

// ── DELETE /api/memories/:id ───────────────────────────────────────────────

describe('http — DELETE /api/memories/:id', () => {
  it('returns 204 and fires onMemoryDeleted', async () => {
    const onDeleted = vi.fn()
    const a = buildApp({ logger: false, onMemoryDeleted: onDeleted })
    try {
      // Seed one
      const created = await a.inject({
        method: 'POST', url: '/api/memories',
        headers: { ...VALID_AUTH, 'content-type': 'application/json' },
        payload: { title: 'x', content: 'y' }
      })
      const id = created.json().memory.id
      const r = await a.inject({ method: 'DELETE', url: `/api/memories/${id}`, headers: VALID_AUTH })
      expect(r.statusCode).toBe(204)
      expect(onDeleted).toHaveBeenCalledTimes(1)
    } finally { await a.close() }
  })

  it('returns 404 NOT_FOUND for unknown id', async () => {
    const app = mkApp()
    try {
      const r = await app.inject({ method: 'DELETE', url: '/api/memories/does-not-exist', headers: VALID_AUTH })
      expect(r.statusCode).toBe(404)
      expect(r.json().code).toBe('NOT_FOUND')
    } finally { await app.close() }
  })
})

// ── /api/related ───────────────────────────────────────────────────────────

describe('http — /api/related', () => {
  it('returns empty results + keywords for empty context', async () => {
    const app = mkApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/api/related?context=', headers: VALID_AUTH })
      expect(r.statusCode).toBe(200)
      expect(r.json()).toEqual({ results: [], keywords: [] })
    } finally { await app.close() }
  })

  it('uses vector path when vector search enabled + Ollama returns a vector', async () => {
    const app = mkApp()
    try {
      // Seed a memory + manually stash its vector so vectorSearch returns it.
      const created = await app.inject({
        method: 'POST', url: '/api/memories',
        headers: { ...VALID_AUTH, 'content-type': 'application/json' },
        payload: { title: 'neural networks', content: 'machine learning content' }
      })
      const id = created.json().memory.id
      vectors.set(id, new Array(384).fill(0.1))

      const r = await app.inject({
        method: 'GET',
        url: '/api/related?context=' + encodeURIComponent('artificial intelligence'),
        headers: VALID_AUTH
      })
      expect(r.statusCode).toBe(200)
      const body = r.json()
      expect(body.results).toHaveLength(1)
      expect(body.results[0].id).toBe(id)
      expect(Array.isArray(body.keywords)).toBe(true)
    } finally { await app.close() }
  })

  it('falls back to keyword search when vector search disabled', async () => {
    vectorSearchEnabled = false
    const app = mkApp()
    try {
      await app.inject({
        method: 'POST', url: '/api/memories',
        headers: { ...VALID_AUTH, 'content-type': 'application/json' },
        payload: { title: 'about machines', content: 'lots of machine learning' }
      })
      const r = await app.inject({
        method: 'GET',
        url: '/api/related?context=' + encodeURIComponent('tell me about machines'),
        headers: VALID_AUTH
      })
      expect(r.statusCode).toBe(200)
      const body = r.json()
      expect(body.results.length).toBeGreaterThan(0)
      expect(body.keywords).toContain('machines')
    } finally { await app.close() }
  })
})

// ── /api/admin/embed-status ────────────────────────────────────────────────

describe('http — /api/admin/embed-status', () => {
  it('reports vectorSearchEnabled + embedded/missing for given ids', async () => {
    const app = mkApp()
    try {
      vectors.set('a', new Array(384).fill(0))
      const r = await app.inject({
        method: 'GET',
        url: '/api/admin/embed-status?ids=a,b',
        headers: VALID_AUTH
      })
      expect(r.statusCode).toBe(200)
      const body = r.json()
      expect(body.vectorSearchEnabled).toBe(true)
      expect(body.embedded).toEqual(['a'])
      expect(body.missing).toEqual(['b'])
      expect(body.totalEmbedded).toBe(1)
    } finally { await app.close() }
  })

  it('with no ids, returns the global count', async () => {
    const app = mkApp()
    try {
      vectors.set('x', new Array(384).fill(0))
      vectors.set('y', new Array(384).fill(0))
      const r = await app.inject({ method: 'GET', url: '/api/admin/embed-status', headers: VALID_AUTH })
      expect(r.json().totalEmbedded).toBe(2)
      expect(r.json().embedded).toEqual([])
    } finally { await app.close() }
  })
})

// ── /pair (public, single-use within armed window) ─────────────────────────

describe('http — /pair', () => {
  it('returns 403 PAIRING_NOT_ARMED when no armed window', async () => {
    const app = mkApp()
    try {
      const r = await app.inject({ method: 'GET', url: '/pair' })
      expect(r.statusCode).toBe(403)
      expect(r.json().code).toBe('PAIRING_NOT_ARMED')
    } finally { await app.close() }
  })

  it('returns the token when armed, then disarms (single-use)', async () => {
    const onPaired = vi.fn()
    const a = buildApp({ logger: false, onExtensionPaired: onPaired })
    try {
      armPairing(60_000)
      const r1 = await a.inject({ method: 'GET', url: '/pair' })
      expect(r1.statusCode).toBe(200)
      expect(r1.json().token).toBe(TOKEN)
      expect(onPaired).toHaveBeenCalledTimes(1)

      // Second call within the window should now be disarmed.
      const r2 = await a.inject({ method: 'GET', url: '/pair' })
      expect(r2.statusCode).toBe(403)
    } finally { await a.close() }
  })

  it('expires automatically after the armed window passes', async () => {
    const app = mkApp()
    try {
      armPairing(10) // 10ms
      await new Promise(r => setTimeout(r, 30))
      const r = await app.inject({ method: 'GET', url: '/pair' })
      expect(r.statusCode).toBe(403)
    } finally { await app.close() }
  })
})
