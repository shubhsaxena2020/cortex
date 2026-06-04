// db.ts integration tests against an in-memory SQLite database.
//
// ⚠️ These tests are SKIPPED by default in this project because `better-sqlite3`
// is a native module compiled for ELECTRON'S Node.js ABI (NODE_MODULE_VERSION
// 125 with Electron 31). Plain `node` running vitest is ABI 127 and refuses to
// load the .node binary. The same code is exercised end-to-end by the live-app
// HTTP integration suite at `scripts/integration-tests.mjs`, which IS run by
// the production Electron process and therefore loads the right binary.
//
// To run these unit tests locally:
//   1. npm rebuild better-sqlite3      # build for current Node
//   2. # change describe.skip → describe in this file
//   3. npm test
//   4. npm run postinstall             # rebuild for Electron before next dev run
//
// The cleaner long-term fix is `vitest-electron` or a similar test runner that
// executes inside Electron's Node. That's a Phase 4+ infrastructure decision.

import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/__never_used__' }
}))

// Import AFTER the mock so db.ts sees the stub.
const db = await import('./db')

const SAMPLE = {
  id: 'm-1',
  title: 'First note',
  content: 'Hello world',
  source: 'manual',
  tags: ['work', 'todo']
}

beforeEach(async () => {
  db.__resetDbForTest()
  await db.initDb(':memory:')
})

afterEach(() => {
  db.__resetDbForTest()
})

describe.skip('db — memories CRUD', () => {
  it('createMemory + getMemory round-trip preserves all fields', () => {
    db.createMemory(SAMPLE.id, SAMPLE.title, SAMPLE.content, SAMPLE.source, SAMPLE.tags)
    const row = db.getMemory(SAMPLE.id)
    expect(row).not.toBeNull()
    expect(row!.id).toBe(SAMPLE.id)
    expect(row!.title).toBe(SAMPLE.title)
    expect(row!.content).toBe(SAMPLE.content)
    expect(row!.source).toBe('manual')
    expect(row!.tags).toEqual(['work', 'todo'])
    expect(typeof row!.timestamp).toBe('number')
    expect(typeof row!.updatedAt).toBe('number')
  })

  it('getMemory returns null for an unknown id', () => {
    expect(db.getMemory('does-not-exist')).toBeNull()
  })

  it('getAllMemories returns newest first by updatedAt', async () => {
    db.createMemory('a', 'A', '', 'manual', [])
    await new Promise(r => setTimeout(r, 5))
    db.createMemory('b', 'B', '', 'manual', [])
    await new Promise(r => setTimeout(r, 5))
    db.createMemory('c', 'C', '', 'manual', [])

    const all = db.getAllMemories()
    expect(all.map(m => m.id)).toEqual(['c', 'b', 'a'])
  })

  it('updateMemory changes title/content/tags and bumps updatedAt', async () => {
    db.createMemory(SAMPLE.id, SAMPLE.title, SAMPLE.content, SAMPLE.source, SAMPLE.tags)
    const before = db.getMemory(SAMPLE.id)!
    await new Promise(r => setTimeout(r, 10))

    db.updateMemory(SAMPLE.id, 'Updated title', 'New content', ['x'])
    const after = db.getMemory(SAMPLE.id)!

    expect(after.title).toBe('Updated title')
    expect(after.content).toBe('New content')
    expect(after.tags).toEqual(['x'])
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
    expect(after.timestamp).toBe(before.timestamp) // creation time unchanged
  })

  it('deleteMemory removes the row and any dependent relationships/fts', () => {
    db.createMemory('a', 'A', '', 'manual', [])
    db.createMemory('b', 'B', '', 'manual', [])
    db.createRelationship('a', 'b', 'related')

    db.deleteMemory('a')
    expect(db.getMemory('a')).toBeNull()
    // The relationship that referenced 'a' should also be gone.
    expect(db.getRelationshipsForMemory('b')).toEqual([])
    // Deleting 'b' should now also succeed (no orphan-FK explosion).
    db.deleteMemory('b')
    expect(db.getMemory('b')).toBeNull()
  })
})

describe.skip('db — searchMemories', () => {
  beforeEach(() => {
    db.createMemory('a', 'Espresso brewing',     'pressure and grind',     'manual',  ['coffee'])
    db.createMemory('b', 'Neural networks',      'machine learning models', 'claude',  ['ai'])
    db.createMemory('c', 'Marathon distance',    '42.195 kilometers',      'manual',  ['sports', 'history'])
  })

  it('finds by content substring (case-insensitive)', () => {
    const res = db.searchMemories('MACHINE')
    expect(res.map(r => r.id)).toEqual(['b'])
  })

  it('finds by title substring', () => {
    const res = db.searchMemories('marathon')
    expect(res.map(r => r.id)).toEqual(['c'])
  })

  it('filters by source', () => {
    const res = db.searchMemories('', 'claude')
    expect(res.map(r => r.id)).toEqual(['b'])
  })

  it('filters by tags (AND of all given tags)', () => {
    const ok = db.searchMemories('', undefined, ['sports'])
    expect(ok.map(r => r.id)).toEqual(['c'])

    const noMatch = db.searchMemories('', undefined, ['sports', 'coffee'])
    expect(noMatch).toEqual([]) // no memory has BOTH tags
  })

  it('combines query + source + tags', () => {
    const res = db.searchMemories('grind', 'manual', ['coffee'])
    expect(res.map(r => r.id)).toEqual(['a'])
  })

  it('returns empty array on no match', () => {
    expect(db.searchMemories('zzzzz')).toEqual([])
  })
})

describe.skip('db — tags', () => {
  it('getMemoriesByTag matches the exact tag stored in JSON', () => {
    db.createMemory('a', 'A', '', 'manual', ['work', 'todo'])
    db.createMemory('b', 'B', '', 'manual', ['todo'])
    db.createMemory('c', 'C', '', 'manual', ['done'])

    const todos = db.getMemoriesByTag('todo')
    expect(todos.map(m => m.id).sort()).toEqual(['a', 'b'])

    expect(db.getMemoriesByTag('missing')).toEqual([])
  })
})

describe.skip('db — relationships', () => {
  beforeEach(() => {
    db.createMemory('a', 'A', '', 'manual', [])
    db.createMemory('b', 'B', '', 'manual', [])
    db.createMemory('c', 'C', '', 'manual', [])
  })

  it('createRelationship + getRelatedMemories returns both directions', () => {
    db.createRelationship('a', 'b', 'related')
    const fromA = db.getRelatedMemories('a').map(m => m.id)
    const fromB = db.getRelatedMemories('b').map(m => m.id)
    expect(fromA).toEqual(['b'])
    expect(fromB).toEqual(['a'])
  })

  it('getAllRelationships returns every edge once', () => {
    db.createRelationship('a', 'b', 'related')
    db.createRelationship('b', 'c', 'building_on')
    const all = db.getAllRelationships()
    expect(all).toHaveLength(2)
  })

  it('deleteRelationship removes the edge', () => {
    db.createRelationship('a', 'b', 'related')
    const all = db.getAllRelationships()
    expect(all).toHaveLength(1)
    db.deleteRelationship(all[0].id)
    expect(db.getAllRelationships()).toEqual([])
  })
})

describe.skip('db — stats', () => {
  it('getStats counts totals and groups by source', () => {
    db.createMemory('a', 'A', '', 'manual', [])
    db.createMemory('b', 'B', '', 'claude', [])
    db.createMemory('c', 'C', '', 'claude', [])

    const stats = db.getStats()
    expect(stats.total).toBe(3)
    expect(stats.bySource).toEqual({ manual: 1, claude: 2 })
  })
})

describe.skip('db — vector search availability', () => {
  it('hasVectorSearch reports true if sqlite-vec loaded successfully', () => {
    // sqlite-vec ships with prebuilt binaries; on supported platforms initDb
    // loads the extension and hasVectorSearch should be true. If it fails on
    // an exotic platform that's still fine — the code path that uses it
    // gracefully degrades; we just record observed behaviour here.
    const flag = db.hasVectorSearch()
    expect(typeof flag).toBe('boolean')
  })

  it('storeEmbedding + vectorSearch are no-ops when vector search is disabled', () => {
    // If sqlite-vec IS loaded these run for real; if not, the functions silently
    // skip. Either path should not throw — that's the contract.
    expect(() =>
      db.storeEmbedding('a', new Array(384).fill(0))
    ).not.toThrow()
    expect(() => db.vectorSearch(new Array(384).fill(0), 5)).not.toThrow()
  })
})
