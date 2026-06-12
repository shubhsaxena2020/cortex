// Tests for the Cortex MCP server's pure core (mcp/core.mjs).
//
// The core takes all environment-specific behavior (SQLite, Ollama, UUIDs)
// via an injected ctx, so these tests run under plain vitest with fakes —
// no better-sqlite3 (Electron ABI) required.

import { describe, it, expect } from 'vitest'
import {
  toFtsPhrase,
  escapeLike,
  snippet,
  TOOLS,
  callTool,
  createRpcHandler,
  PROTOCOL_VERSION,
  SERVER_INFO,
  // @ts-expect-error — plain .mjs module without type declarations
} from '../../mcp/core.mjs'

type Memory = {
  id: string
  title: string
  content: string
  timestamp: number
  updatedAt: number
  source: string
  tags: string[]
  url: string | null
}

function mem(id: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id,
    title: `Title ${id}`,
    content: `Content for ${id}`,
    timestamp: 1700000000000,
    updatedAt: 1700000000000,
    source: 'project_seed',
    tags: [],
    url: null,
    ...overrides,
  }
}

type CtxOptions = {
  memories?: Memory[]
  relationships?: Array<{ id: string; sourceId: string; targetId: string; relationship: string; strength: number; signal_type: string }>
  vecHits?: Array<{ memory_id: string; distance: number }>
  hasVec?: boolean
  embedVector?: number[] | null
}

function fakeCtx(options: CtxOptions = {}) {
  const memories = options.memories ?? []
  const byId = new Map(memories.map((m) => [m.id, m]))
  const created: Array<{ id: string; title: string; content: string; source: string; tags: string[] }> = []
  const stored: Array<{ id: string; vector: number[] }> = []

  return {
    created,
    stored,
    queries: {
      searchMemories: (query: string, source?: string, tags?: string[]) =>
        memories.filter((m) => {
          if (!(m.title.includes(query) || m.content.includes(query))) return false
          if (source && m.source !== source) return false
          if (tags && tags.length && !tags.every((t) => m.tags.includes(t))) return false
          return true
        }),
      getMemory: (id: string) => byId.get(id) ?? null,
      listMemories: ({ limit, tags, source }: { limit: number; tags?: string[]; source?: string }) =>
        memories
          .filter((m) => {
            if (source && m.source !== source) return false
            if (tags && tags.length && !tags.every((t) => m.tags.includes(t))) return false
            return true
          })
          .slice(0, limit),
      createMemory: (id: string, title: string, content: string, source: string, tags: string[]) => {
        const row = mem(id, { title, content, source, tags })
        byId.set(id, row)
        created.push({ id, title, content, source, tags })
        return row
      },
      getRelationshipsForMemory: (id: string) =>
        (options.relationships ?? []).filter((r) => r.sourceId === id || r.targetId === id),
      vectorSearch: () => options.vecHits ?? [],
      storeEmbedding: (id: string, vector: number[]) => { stored.push({ id, vector }) },
      stats: () => ({ memories: memories.length }),
    },
    embed: async () => options.embedVector ?? null,
    hasVec: () => options.hasVec ?? false,
    newId: () => 'fixed-uuid',
  }
}

function parseResult(result: { content: Array<{ text: string }>; isError?: boolean }) {
  return JSON.parse(result.content[0].text)
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('toFtsPhrase', () => {
  it('wraps a plain query in phrase quotes', () => {
    expect(toFtsPhrase('auto edges')).toBe('"auto edges"')
  })

  it('doubles embedded double quotes', () => {
    expect(toFtsPhrase('say "hi"')).toBe('"say ""hi"""')
  })

  it('returns null for empty or whitespace-only input', () => {
    expect(toFtsPhrase('')).toBeNull()
    expect(toFtsPhrase('   ')).toBeNull()
  })

  it('returns null when no alphanumeric content exists', () => {
    expect(toFtsPhrase('%%% !!!')).toBeNull()
  })
})

describe('escapeLike', () => {
  it('escapes LIKE wildcards and backslash', () => {
    expect(escapeLike('50%_a\\b')).toBe('50\\%\\_a\\\\b')
  })
})

describe('snippet', () => {
  it('collapses whitespace', () => {
    expect(snippet('a\n\n  b\tc')).toBe('a b c')
  })

  it('truncates long content with ellipsis', () => {
    const out = snippet('x'.repeat(500))
    expect(out.length).toBe(240)
    expect(out.endsWith('…')).toBe(true)
  })
})

// ── Tool routing + validation ─────────────────────────────────────────────────

describe('callTool', () => {
  it('returns null for unknown tool names', async () => {
    expect(await callTool('nope', {}, fakeCtx())).toBeNull()
  })

  it('rejects empty search query', async () => {
    const result = await callTool('cortex_search', { query: '  ' }, fakeCtx())
    expect(result.isError).toBe(true)
  })

  it('rejects get_memory without id', async () => {
    const result = await callTool('cortex_get_memory', {}, fakeCtx())
    expect(result.isError).toBe(true)
  })

  it('errors cleanly on missing memory id', async () => {
    const result = await callTool('cortex_get_memory', { id: 'ghost' }, fakeCtx())
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('ghost')
  })

  it('rejects create_memory without title or content', async () => {
    const ctx = fakeCtx()
    expect((await callTool('cortex_create_memory', { content: 'x' }, ctx)).isError).toBe(true)
    expect((await callTool('cortex_create_memory', { title: 'x' }, ctx)).isError).toBe(true)
    expect(ctx.created.length).toBe(0)
  })
})

describe('cortex_search', () => {
  it('keyword mode returns matching summaries', async () => {
    const ctx = fakeCtx({ memories: [mem('a', { content: 'sqlite wisdom' }), mem('b')] })
    const out = parseResult(await callTool('cortex_search', { query: 'sqlite', mode: 'keyword' }, ctx))
    expect(out.mode).toBe('keyword')
    expect(out.count).toBe(1)
    expect(out.results[0].id).toBe('a')
    // Summaries carry a snippet, never full content
    expect(out.results[0].snippet).toContain('sqlite wisdom')
  })

  it('semantic mode uses vector hits and joins memory rows', async () => {
    const ctx = fakeCtx({
      memories: [mem('a'), mem('b')],
      hasVec: true,
      embedVector: [0.1, 0.2],
      vecHits: [
        { memory_id: 'b', distance: 0.12345 },
        { memory_id: 'a', distance: 0.5 },
      ],
    })
    const out = parseResult(await callTool('cortex_search', { query: 'anything', mode: 'semantic' }, ctx))
    expect(out.mode).toBe('semantic')
    expect(out.results.map((r: { id: string }) => r.id)).toEqual(['b', 'a'])
    expect(out.results[0].distance).toBe(0.123)
  })

  it('falls back to keyword with a note when Ollama is down', async () => {
    const ctx = fakeCtx({
      memories: [mem('a', { content: 'fallback target' })],
      hasVec: true,
      embedVector: null, // Ollama unreachable
    })
    const out = parseResult(await callTool('cortex_search', { query: 'fallback', mode: 'auto' }, ctx))
    expect(out.mode).toBe('keyword')
    expect(out.note).toContain('Ollama')
    expect(out.count).toBe(1)
  })

  it('semantic hits respect tag and source filters', async () => {
    const ctx = fakeCtx({
      memories: [mem('a', { source: 'mcp' }), mem('b', { source: 'project_seed' })],
      hasVec: true,
      embedVector: [0.1],
      vecHits: [
        { memory_id: 'a', distance: 0.1 },
        { memory_id: 'b', distance: 0.2 },
      ],
    })
    const out = parseResult(
      await callTool('cortex_search', { query: 'q', mode: 'semantic', source: 'project_seed' }, ctx)
    )
    expect(out.results.map((r: { id: string }) => r.id)).toEqual(['b'])
  })

  it('clamps limit into the 1-50 range', async () => {
    const memories = Array.from({ length: 60 }, (_, i) => mem(`m${i}`, { content: 'common' }))
    const ctx = fakeCtx({ memories })
    const out = parseResult(await callTool('cortex_search', { query: 'common', limit: 9999 }, ctx))
    expect(out.count).toBeLessThanOrEqual(50)
  })
})

describe('cortex_get_memory', () => {
  it('returns full content plus mapped relationships', async () => {
    const ctx = fakeCtx({
      memories: [mem('a'), mem('b', { title: 'Neighbor' })],
      relationships: [
        { id: 'a-b', sourceId: 'a', targetId: 'b', relationship: 'related', strength: 0.7, signal_type: 'auto:tag' },
      ],
    })
    const out = parseResult(await callTool('cortex_get_memory', { id: 'a' }, ctx))
    expect(out.content).toBe('Content for a')
    expect(out.relationships).toEqual([
      { id: 'b', title: 'Neighbor', signal: 'auto:tag', strength: 0.7 },
    ])
  })
})

describe('cortex_create_memory', () => {
  it('creates with source mcp and reports embedding state', async () => {
    const ctx = fakeCtx({ hasVec: true, embedVector: [1, 2, 3] })
    const out = parseResult(
      await callTool('cortex_create_memory', { title: 'T', content: 'C', tags: ['x'] }, ctx)
    )
    expect(out).toMatchObject({ id: 'fixed-uuid', created: true, embedded: true })
    expect(ctx.created[0]).toMatchObject({ source: 'mcp', tags: ['x'] })
    expect(ctx.stored[0]).toMatchObject({ id: 'fixed-uuid' })
  })

  it('reports embedded false when Ollama is unavailable', async () => {
    const ctx = fakeCtx({ hasVec: true, embedVector: null })
    const out = parseResult(await callTool('cortex_create_memory', { title: 'T', content: 'C' }, ctx))
    expect(out.embedded).toBe(false)
    expect(ctx.stored.length).toBe(0)
  })
})

describe('cortex_related', () => {
  it('sorts neighbors by strength descending and skips deleted rows', async () => {
    const ctx = fakeCtx({
      memories: [mem('a'), mem('b'), mem('c')],
      relationships: [
        { id: 'a-b', sourceId: 'a', targetId: 'b', relationship: 'related', strength: 0.3, signal_type: 'auto:keyword' },
        { id: 'c-a', sourceId: 'c', targetId: 'a', relationship: 'related', strength: 0.9, signal_type: 'auto:embedding' },
        { id: 'a-ghost', sourceId: 'a', targetId: 'ghost', relationship: 'related', strength: 1.0, signal_type: 'manual' },
      ],
    })
    const out = parseResult(await callTool('cortex_related', { id: 'a' }, ctx))
    expect(out.results.map((r: { id: string }) => r.id)).toEqual(['c', 'b'])
  })
})

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────────

describe('createRpcHandler', () => {
  const handle = createRpcHandler(fakeCtx({ memories: [mem('a')] }))

  it('answers initialize with capabilities and server info', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    expect(res.result.protocolVersion).toBe('2024-11-05') // echoes client version
    expect(res.result.serverInfo).toEqual(SERVER_INFO)
    expect(res.result.capabilities.tools).toBeDefined()
  })

  it('advertises its own protocol version when client sends none', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })
    expect(res.result.protocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('lists all six tools with schemas', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect(res.result.tools).toHaveLength(6)
    expect(res.result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t: { name: string }) => t.name))
    for (const tool of res.result.tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.description.length).toBeGreaterThan(20)
    }
  })

  it('dispatches tools/call to the tool implementation', async () => {
    const res = await handle({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'cortex_get_memory', arguments: { id: 'a' } },
    })
    expect(JSON.parse(res.result.content[0].text).id).toBe('a')
  })

  it('returns -32602 for unknown tools', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bogus' } })
    expect(res.error.code).toBe(-32602)
  })

  it('returns -32601 for unknown methods', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 6, method: 'resources/list' })
    expect(res.error.code).toBe(-32601)
  })

  it('ignores notifications entirely', async () => {
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/cancelled' })).toBeNull()
  })

  it('ignores frames that are not JSON-RPC 2.0', async () => {
    expect(await handle({ id: 1, method: 'initialize' })).toBeNull()
    expect(await handle(null)).toBeNull()
  })

  it('answers ping', async () => {
    const res = await handle({ jsonrpc: '2.0', id: 7, method: 'ping' })
    expect(res.result).toEqual({})
  })

  it('wraps tool exceptions as -32603 instead of crashing', async () => {
    const broken = fakeCtx()
    broken.queries.stats = () => { throw new Error('db exploded') }
    const h = createRpcHandler(broken)
    const res = await h({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'cortex_stats' } })
    expect(res.error.code).toBe(-32603)
    expect(res.error.message).toContain('db exploded')
  })
})
