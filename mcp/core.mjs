// mcp/core.mjs — pure MCP protocol + tool logic for the Cortex MCP server.
//
// No Node/Electron/native imports. Everything environment-specific (SQLite,
// Ollama, UUIDs) is injected via `ctx` so this module is unit-testable under
// plain vitest — better-sqlite3 in this repo is compiled for Electron's ABI
// and cannot load in the system-Node test runner.
//
// ctx shape (provided by server.mjs, faked in tests):
//   {
//     queries: {
//       searchMemories(query, source?, tags?)      -> Memory[]
//       getMemory(id)                              -> Memory | null
//       listMemories({ limit, tags, source })      -> Memory[]
//       createMemory(id, title, content, source, tags) -> Memory
//       getRelationshipsForMemory(id)              -> Relationship[]
//       vectorSearch(vector, limit)                -> [{ memory_id, distance }]
//       storeEmbedding(id, vector)                 -> void
//       stats()                                    -> { ... }
//     },
//     embed(text)  -> Promise<number[] | null>   (null = Ollama unavailable)
//     hasVec()     -> boolean                     (sqlite-vec loaded?)
//     newId()      -> string                      (UUID)
//   }

export const SERVER_INFO = { name: 'cortex', version: '0.3.0' }
export const PROTOCOL_VERSION = '2025-06-18'

const SNIPPET_LEN = 240
const MAX_LIMIT = 50

// ── Pure helpers (mirrors db.ts semantics; covered by unit tests) ────────────

/** FTS5 phrase-quote. Returns null when the query has no tokenizable content. */
export function toFtsPhrase(query) {
  const trimmed = String(query ?? '').trim()
  if (!trimmed) return null
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null
  return `"${trimmed.replace(/"/g, '""')}"`
}

/** Escape LIKE wildcards; pair with ESCAPE '\' on the SQL side. */
export function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m)
}

/** First N chars of content, whitespace-collapsed, with ellipsis. */
export function snippet(content, n = SNIPPET_LEN) {
  const flat = String(content ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= n ? flat : flat.slice(0, n - 1) + '…'
}

function clampLimit(raw, fallback) {
  const n = Number.isFinite(Number(raw)) ? Math.floor(Number(raw)) : fallback
  return Math.min(Math.max(n > 0 ? n : fallback, 1), MAX_LIMIT)
}

function summarize(memory, extra = {}) {
  return {
    id: memory.id,
    title: memory.title,
    snippet: snippet(memory.content),
    tags: memory.tags,
    source: memory.source,
    updatedAt: new Date(memory.updatedAt).toISOString(),
    ...(memory.url ? { url: memory.url } : {}),
    ...extra,
  }
}

function matchesFilters(memory, tags, source) {
  if (source && memory.source !== source) return false
  if (tags && tags.length && !tags.every((t) => memory.tags.includes(t))) return false
  return true
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const TOOLS = [
  {
    name: 'cortex_search',
    description:
      'Search the Cortex second-brain memories. mode "keyword" uses FTS5 full-text match; ' +
      '"semantic" embeds the query via local Ollama and runs sqlite-vec KNN; "auto" (default) ' +
      'prefers semantic when available and falls back to keyword. Returns ranked summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text' },
        mode: { type: 'string', enum: ['auto', 'keyword', 'semantic'], description: 'Search strategy (default auto)' },
        limit: { type: 'number', description: `Max results, 1-${MAX_LIMIT} (default 10)` },
        tags: { type: 'array', items: { type: 'string' }, description: 'Only memories carrying ALL of these tags' },
        source: { type: 'string', description: 'Only memories from this source (e.g. claude, chatgpt, project_seed)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'cortex_get_memory',
    description: 'Fetch one Cortex memory by id — full content plus its graph relationships.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Memory id' } },
      required: ['id'],
    },
  },
  {
    name: 'cortex_list_memories',
    description: 'List Cortex memories ordered by most recently updated. Filterable by tags and source.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: `Max results, 1-${MAX_LIMIT} (default 20)` },
        tags: { type: 'array', items: { type: 'string' }, description: 'Only memories carrying ALL of these tags' },
        source: { type: 'string', description: 'Only memories from this source' },
      },
    },
  },
  {
    name: 'cortex_create_memory',
    description:
      'Save a new memory into the Cortex second brain (source "mcp"). Embeds it for semantic ' +
      'search when Ollama is running. Auto-edges are built by the Cortex app on next startup.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title' },
        content: { type: 'string', description: 'Memory body (markdown welcome)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'cortex_related',
    description: 'Graph neighbors of a memory — related memories with edge strength and signal type (tag / keyword / embedding / manual).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory id' },
        limit: { type: 'number', description: `Max neighbors, 1-${MAX_LIMIT} (default 10)` },
      },
      required: ['id'],
    },
  },
  {
    name: 'cortex_stats',
    description: 'Overview of the Cortex DB: memory counts by source, relationship counts by signal, embedding coverage, top tags.',
    inputSchema: { type: 'object', properties: {} },
  },
]

// ── Tool results ──────────────────────────────────────────────────────────────

export function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

export function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true }
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function toolSearch(args, ctx) {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return errorResult('cortex_search: "query" must be a non-empty string')
  const mode = ['auto', 'keyword', 'semantic'].includes(args.mode) ? args.mode : 'auto'
  const limit = clampLimit(args.limit, 10)
  const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string') : undefined
  const source = typeof args.source === 'string' && args.source ? args.source : undefined

  let note
  if (mode !== 'keyword' && ctx.hasVec()) {
    const vector = await ctx.embed(query)
    if (vector) {
      const hits = ctx.queries.vectorSearch(vector, limit * 2) // overfetch: post-filters may drop rows
      const results = []
      for (const hit of hits) {
        const memory = ctx.queries.getMemory(hit.memory_id)
        if (!memory || !matchesFilters(memory, tags, source)) continue
        results.push(summarize(memory, { distance: Math.round(hit.distance * 1000) / 1000 }))
        if (results.length >= limit) break
      }
      return jsonResult({ mode: 'semantic', count: results.length, results })
    }
    note = 'Ollama unreachable — fell back to keyword search'
  } else if (mode === 'semantic' && !ctx.hasVec()) {
    note = 'sqlite-vec unavailable — fell back to keyword search'
  }

  const rows = ctx.queries.searchMemories(query, source, tags)
  const results = rows.slice(0, limit).map((m) => summarize(m))
  return jsonResult({ mode: 'keyword', ...(note ? { note } : {}), count: results.length, results })
}

function toolGetMemory(args, ctx) {
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  if (!id) return errorResult('cortex_get_memory: "id" must be a non-empty string')
  const memory = ctx.queries.getMemory(id)
  if (!memory) return errorResult(`cortex_get_memory: no memory with id "${id}"`)

  const relationships = ctx.queries.getRelationshipsForMemory(id).map((r) => {
    const otherId = r.sourceId === id ? r.targetId : r.sourceId
    const other = ctx.queries.getMemory(otherId)
    return {
      id: otherId,
      title: other?.title ?? '(deleted)',
      signal: r.signal_type,
      strength: r.strength,
    }
  })

  return jsonResult({
    ...memory,
    timestamp: new Date(memory.timestamp).toISOString(),
    updatedAt: new Date(memory.updatedAt).toISOString(),
    relationships,
  })
}

function toolListMemories(args, ctx) {
  const limit = clampLimit(args.limit, 20)
  const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string') : undefined
  const source = typeof args.source === 'string' && args.source ? args.source : undefined
  const rows = ctx.queries.listMemories({ limit, tags, source })
  return jsonResult({ count: rows.length, results: rows.map((m) => summarize(m)) })
}

async function toolCreateMemory(args, ctx) {
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  const content = typeof args.content === 'string' ? args.content : ''
  if (!title) return errorResult('cortex_create_memory: "title" must be a non-empty string')
  if (!content.trim()) return errorResult('cortex_create_memory: "content" must be a non-empty string')
  const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string') : []

  const id = ctx.newId()
  ctx.queries.createMemory(id, title, content, 'mcp', tags)

  let embedded = false
  if (ctx.hasVec()) {
    const vector = await ctx.embed(`${title}\n\n${content}`)
    if (vector) {
      ctx.queries.storeEmbedding(id, vector)
      embedded = true
    }
  }

  return jsonResult({
    id,
    created: true,
    embedded,
    note: 'Auto-edges for this memory are built by the Cortex app at next startup.',
  })
}

function toolRelated(args, ctx) {
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  if (!id) return errorResult('cortex_related: "id" must be a non-empty string')
  if (!ctx.queries.getMemory(id)) return errorResult(`cortex_related: no memory with id "${id}"`)
  const limit = clampLimit(args.limit, 10)

  const neighbors = ctx.queries
    .getRelationshipsForMemory(id)
    .map((r) => {
      const otherId = r.sourceId === id ? r.targetId : r.sourceId
      const other = ctx.queries.getMemory(otherId)
      if (!other) return null
      return summarize(other, { signal: r.signal_type, strength: r.strength })
    })
    .filter(Boolean)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, limit)

  return jsonResult({ count: neighbors.length, results: neighbors })
}

function toolStats(_args, ctx) {
  return jsonResult(ctx.queries.stats())
}

export async function callTool(name, args, ctx) {
  const a = args && typeof args === 'object' ? args : {}
  switch (name) {
    case 'cortex_search': return toolSearch(a, ctx)
    case 'cortex_get_memory': return toolGetMemory(a, ctx)
    case 'cortex_list_memories': return toolListMemories(a, ctx)
    case 'cortex_create_memory': return toolCreateMemory(a, ctx)
    case 'cortex_related': return toolRelated(a, ctx)
    case 'cortex_stats': return toolStats(a, ctx)
    default: return null // caller maps to JSON-RPC -32602
  }
}

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────────
//
// MCP stdio transport: one JSON-RPC 2.0 message per line. Requests carry an
// id and get exactly one response; notifications (no id) get none. Returns
// the response object to write, or null for "no response".

export function createRpcHandler(ctx) {
  return async function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return null
    const { id, method, params } = msg
    const isRequest = id !== undefined && id !== null

    try {
      if (method === 'initialize') {
        if (!isRequest) return null
        const requested = params?.protocolVersion
        return {
          jsonrpc: '2.0',
          id,
          result: {
            // Echo the client's version (we have no version-specific behavior);
            // advertise ours when the client didn't send one.
            protocolVersion: typeof requested === 'string' && requested ? requested : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          },
        }
      }

      if (method === 'ping') {
        return isRequest ? { jsonrpc: '2.0', id, result: {} } : null
      }

      if (method === 'tools/list') {
        if (!isRequest) return null
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
      }

      if (method === 'tools/call') {
        if (!isRequest) return null
        const result = await callTool(params?.name, params?.arguments, ctx)
        if (result === null) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `Unknown tool: ${params?.name}` },
          }
        }
        return { jsonrpc: '2.0', id, result }
      }

      // Notifications we don't act on (notifications/initialized, cancelled, …)
      if (!isRequest) return null
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
    } catch (err) {
      if (!isRequest) return null
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: `Internal error: ${err instanceof Error ? err.message : String(err)}` },
      }
    }
  }
}
