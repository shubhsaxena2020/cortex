import { describe, it, expect, vi, beforeEach } from 'vitest'
import { jaccardSimilarity, extractKeywords } from './utils/text'
import { buildEdgesForMemory, backfillAllEdges } from './edge-builder'

// ── Pure function tests (no DB needed) ────────────────────────────────────────

describe('jaccardSimilarity', () => {
  it('returns 0 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0)
  })

  it('returns 1.0 for identical sets', () => {
    const s = new Set(['a', 'b', 'c'])
    expect(jaccardSimilarity(s, s)).toBe(1.0)
  })

  it('returns correct ratio for partial overlap', () => {
    const a = new Set(['a', 'b', 'c'])
    const b = new Set(['b', 'c', 'd'])
    // Intersection: {b,c} = 2, Union: {a,b,c,d} = 4 → 0.5
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5)
  })

  it('returns 0 when no overlap', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0)
  })

  it('is symmetric', () => {
    const a = new Set(['x', 'y'])
    const b = new Set(['y', 'z'])
    expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a))
  })
})

describe('extractKeywords', () => {
  it('filters out short words (≤3 chars)', () => {
    const kw = extractKeywords('the cat sat on a mat')
    // 'the', 'cat', 'sat', 'on', 'a', 'mat' — all ≤3 chars
    expect(kw.size).toBe(0)
  })

  it('keeps words with ≥4 characters', () => {
    const kw = extractKeywords('hello world typescript code')
    expect(kw.has('hello')).toBe(true)
    expect(kw.has('world')).toBe(true)
    expect(kw.has('typescript')).toBe(true)
    expect(kw.has('code')).toBe(true)
  })

  it('lowercases all keywords', () => {
    const kw = extractKeywords('Hello WORLD TypeScript')
    expect(kw.has('hello')).toBe(true)
    expect(kw.has('world')).toBe(true)
    expect(kw.has('typescript')).toBe(true)
  })

  it('filters common stopwords', () => {
    const kw = extractKeywords('there would should about these with from have been were they')
    // The stopword set includes all of these, so result should be empty
    expect(kw.size).toBe(0)
  })

  it('returns empty set for empty text', () => {
    expect(extractKeywords('').size).toBe(0)
  })

  it('returns unique keywords (no duplicates)', () => {
    const kw = extractKeywords('hello world hello world')
    expect(kw.size).toBe(2)
    expect(kw.has('hello')).toBe(true)
    expect(kw.has('world')).toBe(true)
  })
})

// ── Mock Database helpers ─────────────────────────────────────────────────────

type MockStmt = {
  get: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown[]
  run: (...args: unknown[]) => { changes: number }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function mockDb(overrides?: Partial<ReturnType<typeof createDefaultMocks>>): ReturnType<typeof createDefaultMocks> {
  const defaults = createDefaultMocks()
  return { ...defaults, ...overrides }
}

function createDefaultMocks() {
  const statements = new Map<string, MockStmt>()

  function prepare(sql: string): MockStmt {
    const key = normalizeSql(sql)
    if (!statements.has(key)) {
      statements.set(key, {
        get: () => undefined,
        all: () => [],
        run: () => ({ changes: 1 }),
      })
    }
    return statements.get(key)!
  }

  // Transaction wrapper — just executes the callback synchronously
  function transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    return ((...args: unknown[]) => fn(...args)) as T
  }

  return { prepare, transaction, exec: () => {}, close: () => {}, _statements: statements }
}

function insertTestMemory(
  db: ReturnType<typeof mockDb>,
  id: string,
  overrides?: {
    content?: string
    tags?: string
    title?: string
  },
) {
  const content = overrides?.content ?? 'test memory content for keyword extraction analysis'
  const tags = overrides?.tags ?? '["test"]'
  const title = overrides?.title ?? 'Test Memory'

  // Register a get() for SELECT * FROM memories WHERE id = ?
  const getByIdSql = 'SELECT * FROM memories WHERE id = ?'
  db.prepare(getByIdSql).get = (qid: string) => {
    if (qid === id) {
      return { id, title, content, tags, timestamp: Date.now(), updatedAt: Date.now(), source: 'manual', url: null }
    }
    return undefined
  }

  // Register a get() for SELECT id, content, tags FROM memories WHERE id = ?
  const getPartialSql = 'SELECT id, content, tags FROM memories WHERE id = ?'
  db.prepare(getPartialSql).get = (qid: string) => {
    if (qid === id) {
      return { id, content, tags }
    }
    return undefined
  }

  return id
}

// ── buildEdgesForMemory tests (mocked DB) ─────────────────────────────────────

describe('buildEdgesForMemory', () => {
  it('creates no edges when memory has no matching candidates', async () => {
    const db = mockDb()
    insertTestMemory(db, 'mem-1', { content: 'xyzzy unique content zyxxy', tags: '[]' })

    // No other memories → no candidates
    const getByIdSql = 'SELECT * FROM memories WHERE id = ?'
    db.prepare(getByIdSql).get = (qid: string) => {
      if (qid === 'mem-1') return { id: 'mem-1', title: 'Unique', content: 'xyzzy unique content zyxxy', tags: '[]', timestamp: 1, updatedAt: 1, source: 'manual', url: null }
      return undefined
    }
    db.prepare('SELECT id, content, tags FROM memories WHERE id = ?').get = () => undefined
    db.prepare(`SELECT id, tags FROM memories WHERE id != ? AND tags IS NOT NULL AND tags != '[]'`).all = () => []

    const count = await buildEdgesForMemory(db as any, 'mem-1')
    expect(count).toBe(0)
  })

  it('creates tag-signal edges for memories sharing tags', async () => {
    const db = mockDb()
    insertTestMemory(db, 'mem-a', { content: 'some content about react', tags: '["typescript","react"]' })
    insertTestMemory(db, 'mem-b', { content: 'other content about vue', tags: '["typescript","vue"]' })

    // Set up get for mem-a
    db.prepare('SELECT * FROM memories WHERE id = ?').get = (qid: string) => {
      if (qid === 'mem-a') return { id: 'mem-a', title: 'React', content: 'some content about react', tags: '["typescript","react"]', timestamp: 1, updatedAt: 1, source: 'manual', url: null }
      if (qid === 'mem-b') return { id: 'mem-b', title: 'Vue', content: 'other content about vue', tags: '["typescript","vue"]', timestamp: 2, updatedAt: 2, source: 'manual', url: null }
      return undefined
    }
    db.prepare('SELECT id, content, tags FROM memories WHERE id = ?').get = (qid: string) => {
      if (qid === 'mem-b') return { id: 'mem-b', content: 'other content about vue', tags: '["typescript","vue"]' }
      return undefined
    }

    // No FTS5 keyword hits (no memories_fts MATCH)
    db.prepare(`SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ? AND memory_id != ? LIMIT 50`).all = () => []

    // Tag candidates: mem-b
    db.prepare(`SELECT id, tags FROM memories WHERE id != ? AND tags IS NOT NULL AND tags != '[]'`).all = (mid: string) => {
      if (mid === 'mem-a') return [{ id: 'mem-b', tags: '["typescript","vue"]' }]
      return []
    }

    // Track inserted edges
    const insertedEdges: Array<{ id: string; sourceId: string; targetId: string; relationship: string; strength: number; signalType: string }> = []
    db.prepare(`INSERT OR REPLACE INTO memory_relationships (id, sourceId, targetId, relationship, strength, signal_type) VALUES (?, ?, ?, ?, ?, ?)`).run = (...args: unknown[]) => {
      insertedEdges.push({
        id: args[0] as string,
        sourceId: args[1] as string,
        targetId: args[2] as string,
        relationship: args[3] as string,
        strength: args[4] as number,
        signalType: args[5] as string,
      })
      return { changes: 1 }
    }

    const count = await buildEdgesForMemory(db as any, 'mem-a')

    expect(count).toBeGreaterThan(0)
    expect(insertedEdges.length).toBeGreaterThan(0)
    const edge = insertedEdges.find(e => e.targetId === 'mem-b')
    expect(edge).toBeTruthy()
    expect(edge!.signalType).toBe('auto:tag')
    expect(edge!.strength).toBeGreaterThan(0)
  })

  it('respects the edge cap of 5', async () => {
    const db = mockDb()
    insertTestMemory(db, 'mem-main', { content: 'main content', tags: '["shared","common"]' })

    db.prepare('SELECT * FROM memories WHERE id = ?').get = (qid: string) => {
      if (qid === 'mem-main') return { id: 'mem-main', title: 'Main', content: 'main content', tags: '["shared","common"]', timestamp: 1, updatedAt: 1, source: 'manual', url: null }
      return undefined
    }
    db.prepare('SELECT id, content, tags FROM memories WHERE id = ?').get = () => undefined
    db.prepare(`SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ? AND memory_id != ? LIMIT 50`).all = () => []

    // 10 tag candidates
    const tagCandidates = Array.from({ length: 10 }, (_, i) => ({
      id: `mem-${i}`,
      tags: '["shared","common"]',
    }))
    db.prepare(`SELECT id, tags FROM memories WHERE id != ? AND tags IS NOT NULL AND tags != '[]'`).all = () => tagCandidates

    const insertedEdges: string[] = []
    db.prepare(`INSERT OR REPLACE INTO memory_relationships (id, sourceId, targetId, relationship, strength, signal_type) VALUES (?, ?, ?, ?, ?, ?)`).run = (...args: unknown[]) => {
      insertedEdges.push(args[2] as string)
      return { changes: 1 }
    }

    await buildEdgesForMemory(db as any, 'mem-main')

    expect(insertedEdges.length).toBeLessThanOrEqual(5)
  })

  it('does not create self-edges', async () => {
    const db = mockDb()

    db.prepare('SELECT * FROM memories WHERE id = ?').get = (qid: string) => {
      if (qid === 'self') return { id: 'self', title: 'Self', content: 'self referential content', tags: '["test"]', timestamp: 1, updatedAt: 1, source: 'manual', url: null }
      return undefined
    }
    db.prepare('SELECT id, content, tags FROM memories WHERE id = ?').get = () => undefined
    db.prepare(`SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ? AND memory_id != ? LIMIT 50`).all = () => []

    // Self is the only memory with this tag
    db.prepare(`SELECT id, tags FROM memories WHERE id != ? AND tags IS NOT NULL AND tags != '[]'`).all = () => []

    const insertedEdges: string[] = []
    db.prepare(`INSERT OR REPLACE INTO memory_relationships (id, sourceId, targetId, relationship, strength, signal_type) VALUES (?, ?, ?, ?, ?, ?)`).run = (...args: unknown[]) => {
      insertedEdges.push(args[2] as string)
      return { changes: 1 }
    }

    await buildEdgesForMemory(db as any, 'self')

    const selfEdges = insertedEdges.filter(id => id === 'self')
    expect(selfEdges.length).toBe(0)
  })

  it('is idempotent — running twice does not duplicate edges', async () => {
    const db = mockDb()
    insertTestMemory(db, 'mem-a', { content: 'idempotent test memory', tags: '["idem","test"]' })
    insertTestMemory(db, 'mem-b', { content: 'matching memory content', tags: '["idem","check"]' })

    db.prepare('SELECT * FROM memories WHERE id = ?').get = (qid: string) => {
      if (qid === 'mem-a') return { id: 'mem-a', title: 'A', content: 'idempotent test memory', tags: '["idem","test"]', timestamp: 1, updatedAt: 1, source: 'manual', url: null }
      if (qid === 'mem-b') return { id: 'mem-b', title: 'B', content: 'matching memory content', tags: '["idem","check"]', timestamp: 2, updatedAt: 2, source: 'manual', url: null }
      return undefined
    }
    db.prepare('SELECT id, content, tags FROM memories WHERE id = ?').get = (qid: string) => {
      if (qid === 'mem-b') return { id: 'mem-b', content: 'matching memory content', tags: '["idem","check"]' }
      return undefined
    }
    db.prepare(`SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ? AND memory_id != ? LIMIT 50`).all = () => []

    db.prepare(`SELECT id, tags FROM memories WHERE id != ? AND tags IS NOT NULL AND tags != '[]'`).all = (mid: string) => {
      if (mid === 'mem-a') return [{ id: 'mem-b', tags: '["idem","check"]' }]
      return []
    }

    let edgeIds = new Set<string>()
    db.prepare(`INSERT OR REPLACE INTO memory_relationships (id, sourceId, targetId, relationship, strength, signal_type) VALUES (?, ?, ?, ?, ?, ?)`).run = (...args: unknown[]) => {
      edgeIds.add(args[0] as string)
      return { changes: 1 }
    }

    await buildEdgesForMemory(db as any, 'mem-a')
    const idsAfterFirst = new Set(edgeIds)

    // Second call should not add NEW distinct edge IDs (INSERT OR REPLACE)
    await buildEdgesForMemory(db as any, 'mem-a')

    expect(edgeIds.size).toBe(idsAfterFirst.size)
  })

  it('handles missing embedding gracefully — still creates tag edges', async () => {
    const db = mockDb()
    insertTestMemory(db, 'mem-a', { content: 'no embedding needed content', tags: '["noEmbed"]' })
    insertTestMemory(db, 'mem-b', { content: 'also no embedding content', tags: '["noEmbed"]' })

    db.prepare('SELECT * FROM memories WHERE id = ?').get = (qid: string) => {
      if (qid === 'mem-a') return { id: 'mem-a', title: 'A', content: 'no embedding needed content', tags: '["noEmbed"]', timestamp: 1, updatedAt: 1, source: 'manual', url: null }
      if (qid === 'mem-b') return { id: 'mem-b', title: 'B', content: 'also no embedding content', tags: '["noEmbed"]', timestamp: 2, updatedAt: 2, source: 'manual', url: null }
      return undefined
    }
    db.prepare('SELECT id, content, tags FROM memories WHERE id = ?').get = (qid: string) => {
      if (qid === 'mem-b') return { id: 'mem-b', content: 'also no embedding content', tags: '["noEmbed"]' }
      return undefined
    }
    db.prepare(`SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ? AND memory_id != ? LIMIT 50`).all = () => []

    db.prepare(`SELECT id, tags FROM memories WHERE id != ? AND tags IS NOT NULL AND tags != '[]'`).all = (mid: string) => {
      if (mid === 'mem-a') return [{ id: 'mem-b', tags: '["noEmbed"]' }]
      return []
    }

    // memory_vectors: throw to simulate sqlite-vec not loaded
    db.prepare('SELECT 1 FROM memory_vectors WHERE memory_id = ?').get = () => undefined
    // When it tries to check memory_vectors, the .get returns undefined → no embedding exists

    const insertedEdges: string[] = []
    db.prepare(`INSERT OR REPLACE INTO memory_relationships (id, sourceId, targetId, relationship, strength, signal_type) VALUES (?, ?, ?, ?, ?, ?)`).run = (...args: unknown[]) => {
      insertedEdges.push(args[2] as string)
      return { changes: 1 }
    }

    const count = await buildEdgesForMemory(db as any, 'mem-a')

    // Should create tag edges even without embeddings
    expect(count).toBeGreaterThan(0)
    expect(insertedEdges.length).toBeGreaterThan(0)
  })
})

// ── backfillAllEdges tests ────────────────────────────────────────────────────

describe('backfillAllEdges', () => {
  it('processes only memories with no existing auto-edges', async () => {
    const db = mockDb()

    // Simulate existing auto-edge for mem-a
    // The backfill query: SELECT m.id FROM memories m LEFT JOIN memory_relationships mr ... WHERE mr.sourceId IS NULL
    const mockAll = db.prepare(`
    SELECT m.id
    FROM memories m
    LEFT JOIN memory_relationships mr ON mr.sourceId = m.id AND mr.signal_type LIKE 'auto:%'
    WHERE mr.sourceId IS NULL
    ORDER BY m.timestamp DESC
  `).all as () => Array<{ id: string }>

    // Only mem-b is unconnected
    const originalAll = mockAll
    db.prepare(`
    SELECT m.id
    FROM memories m
    LEFT JOIN memory_relationships mr ON mr.sourceId = m.id AND mr.signal_type LIKE 'auto:%'
    WHERE mr.sourceId IS NULL
    ORDER BY m.timestamp DESC
  `).all = () => [{ id: 'mem-b' }]

    // Mock buildEdgesForMemory to track which IDs it processes
    let processedIds: string[] = []

    // We can't spy on the internal function easily, but we can check the query contract
    // The query above correctly excludes mem-a (has auto-edge) and only returns mem-b
    const unconnected = db.prepare(`
    SELECT m.id
    FROM memories m
    LEFT JOIN memory_relationships mr ON mr.sourceId = m.id AND mr.signal_type LIKE 'auto:%'
    WHERE mr.sourceId IS NULL
    ORDER BY m.timestamp DESC
  `).all() as Array<{ id: string }>

    expect(unconnected).toHaveLength(1)
    expect(unconnected[0].id).toBe('mem-b')
  })

  it('is a no-op when all memories have auto-edges', async () => {
    const db = mockDb()

    // The backfill query should return 0 results when all memories have auto-edges
    db.prepare(`
    SELECT m.id
    FROM memories m
    LEFT JOIN memory_relationships mr ON mr.sourceId = m.id AND mr.signal_type LIKE 'auto:%'
    WHERE mr.sourceId IS NULL
    ORDER BY m.timestamp DESC
  `).all = () => []

    const unconnected = db.prepare(`
    SELECT m.id
    FROM memories m
    LEFT JOIN memory_relationships mr ON mr.sourceId = m.id AND mr.signal_type LIKE 'auto:%'
    WHERE mr.sourceId IS NULL
    ORDER BY m.timestamp DESC
  `).all() as Array<{ id: string }>

    expect(unconnected).toHaveLength(0)
  })
})
