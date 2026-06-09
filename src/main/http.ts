import Fastify, { FastifyInstance, FastifyServerOptions } from 'fastify'
import { timingSafeEqual, randomUUID } from 'crypto'
import { version } from '../../package.json'
import { getToken } from './extension-config'
import * as db from './db'
import { toMemory, makeHighlight } from './transformers'
import { getEmbedding } from './embeddings'
import { canonicalUrl } from './url-canon'
import { extractKeywords as extractKeywordsFromText, jaccardSimilarity } from './utils/text'

const APP_NAME = 'cortex'
const API_VERSION = 1
const BODY_LIMIT = 10 * 1024 * 1024
const HOST = '127.0.0.1'

const VALID_SOURCES = ['claude', 'chatgpt', 'gemini', 'manual'] as const
type Source = typeof VALID_SOURCES[number]

let server: FastifyInstance | null = null

// Click-to-pair state: epoch-ms deadline; 0 means disarmed.
// Single-use within the window — set back to 0 the moment /pair returns the token.
let pairingArmedUntil = 0

export function armPairing(durationMs: number = 60_000): number {
  pairingArmedUntil = Date.now() + durationMs
  return pairingArmedUntil
}

export function isPairingArmed(): boolean {
  return Date.now() < pairingArmedUntil
}

// Test-only reset hook. Pairing state is module-level so tests need a way
// to start from a clean slate (disarmed) between cases. Never call from prod.
export function __resetPairingForTest(): void {
  pairingArmedUntil = 0
}

function isValidSource(s: unknown): s is Source {
  return typeof s === 'string' && (VALID_SOURCES as readonly string[]).includes(s)
}

export interface BuildAppOptions {
  onMemoryCreated?: (memory: ReturnType<typeof toMemory>, url?: string) => void
  onMemoryDeleted?: (memory: ReturnType<typeof toMemory>) => void
  onExtensionPaired?: () => void
  saveVaultFile?: (filename: string, content: string, source: string) => Promise<{ success: boolean; path?: string }>
  /**
   * Override the Fastify logger. Tests typically pass `false` for silent runs.
   * Production uses `{ level: 'info', redact: ['req.headers.authorization'] }`.
   */
  logger?: FastifyServerOptions['logger']
}

export interface HttpServerOptions extends BuildAppOptions {
  port: number
}

/**
 * Build a configured Fastify instance with all routes + middleware registered,
 * but DO NOT call listen(). Used by both production (`startHttpServer`) and
 * tests (which call `app.inject(...)` directly with no socket).
 */
export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const { onMemoryCreated, onMemoryDeleted, onExtensionPaired, saveVaultFile, logger } = opts

  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    logger: logger ?? {
      level: 'info',
      redact: ['req.headers.authorization']
    }
  })

  // CORS + auth (single hook)
  app.addHook('onRequest', async (req, reply) => {
    const rawOrigin = req.headers.origin
    const origin = typeof rawOrigin === 'string' ? rawOrigin : undefined
    if (origin && origin.startsWith('chrome-extension://')) {
      reply.header('Access-Control-Allow-Origin', origin)
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      reply.header('Vary', 'Origin')
    }
    if (req.method === 'OPTIONS') {
      reply.code(204).send()
      return
    }
    if (req.url === '/health'  || req.url.startsWith('/health?'))  return
    if (req.url === '/pair'    || req.url.startsWith('/pair?'))    return

    // Origin check: only enforce IF the browser sent one. Chrome omits Origin
    // for extension popup fetches to host_permissions URLs (a documented quirk),
    // so requiring it would block our own extension. The token is the security
    // boundary; the Origin check is just defense against a malicious web page
    // (browsers force-set Origin from page contexts, so they can't bypass it).
    if (origin && !origin.startsWith('chrome-extension://')) {
      reply.code(401).send({ error: 'invalid_origin', code: 'INVALID_ORIGIN' })
      return
    }
    const auth = req.headers.authorization
    if (!auth || !auth.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'missing_token', code: 'MISSING_TOKEN' })
      return
    }
    const provided = auth.slice(7)
    const expected = getToken()
    if (provided.length !== expected.length ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      reply.code(401).send({ error: 'invalid_token', code: 'INVALID_TOKEN' })
      return
    }
  })

  app.get('/health', async () => ({
    ok: true,
    app: APP_NAME,
    version,
    apiVersion: API_VERSION
  }))

  // Click-to-pair: public endpoint, returns the token only inside an explicitly-armed window.
  // Window is opened by the desktop app's Settings → "Pair Extension" button.
  // Disarms immediately on first successful pair (single-use within the window).
  app.get('/pair', async (_req, reply) => {
    if (!isPairingArmed()) {
      reply.code(403).send({ error: 'pairing_not_armed', code: 'PAIRING_NOT_ARMED' })
      return
    }
    const token = getToken()
    pairingArmedUntil = 0
    try { onExtensionPaired?.() } catch (e) { reply.log.error(e, 'onExtensionPaired callback failed') }
    return { token }
  })

  app.get<{ Querystring: { q?: string; source?: string; tags?: string } }>(
    '/api/search',
    async req => {
      const q = req.query.q ?? ''
      const source = isValidSource(req.query.source) ? req.query.source : undefined
      const tags = req.query.tags
        ? req.query.tags.split(',').map(t => t.trim()).filter(Boolean)
        : undefined
      const rows = db.searchMemories(q, source, tags)
      return {
        results: rows.map(r => ({
          ...toMemory(r),
          highlight: makeHighlight(r.content || '', q)
        }))
      }
    }
  )

  app.get<{ Querystring: { context?: string } }>(
    '/api/related',
    async req => {
      const context = (req.query.context ?? '').trim()
      if (!context) return { results: [], keywords: [] }

      // Keywords are still returned for UI display ("matched on: x, y, z")
      // even when semantic ranking is what actually drove the results.
      const keywords = extractKeywords(context, 5)

      // Vector path: embed the context, KNN-search memory_vectors, hydrate memories.
      if (db.hasVectorSearch()) {
        const vec = await getEmbedding(context)
        if (vec) {
          const hits = db.vectorSearch(vec, 10)
          const results: Array<ReturnType<typeof toMemory>> = []
          for (const h of hits) {
            const row = db.getMemory(h.memory_id)
            if (row) results.push(toMemory(row))
          }
          if (results.length > 0) return { results, keywords }
          // Empty vector hits (e.g. no memories embedded yet) falls through to keyword path
        }
      }

      // Keyword fallback (also used when Ollama is down or vector table empty)
      if (keywords.length === 0) return { results: [], keywords: [] }
      const hits = new Map<string, { mem: ReturnType<typeof toMemory>; score: number }>()
      for (const kw of keywords) {
        for (const r of db.searchMemories(kw)) {
          const m = toMemory(r)
          const cur = hits.get(m.id)
          if (cur) cur.score++
          else hits.set(m.id, { mem: m, score: 1 })
        }
      }
      const results = [...hits.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(h => h.mem)
      return { results, keywords }
    }
  )

  app.post<{ Body: { title?: string; content?: string; source?: string; tags?: string[]; url?: string } }>(
    '/api/memories',
    async (req, reply) => {
      const body = req.body ?? {}
      const title = (body.title ?? '').trim() || 'Untitled'
      const content = body.content ?? ''
      const source: Source = isValidSource(body.source) ? body.source : 'manual'
      const tags = Array.isArray(body.tags)
        ? body.tags.filter((t): t is string => typeof t === 'string')
        : []
      const url = typeof body.url === 'string' ? body.url : undefined

      // P0 #1 dedup: canonicalise the URL (if any) and route through the
      // upsert path. Two captures of the same Claude/ChatGPT/Gemini
      // conversation produce identical canonical URLs and merge into one row.
      const canonical = canonicalUrl(url)
      const newId = randomUUID()
      const { memory: row, action } = db.upsertMemoryByUrl(newId, title, content, source, tags, canonical)
      const memory = toMemory(row)

      try { onMemoryCreated?.(memory, url) } catch (e) { req.log.error(e, 'onMemoryCreated callback failed') }
      reply.code(action === 'created' ? 201 : 200)
      return { memory, action }
    }
  )

  app.get<{ Querystring: { limit?: string } }>(
    '/api/recent',
    async req => {
      const parsed = parseInt(req.query.limit ?? '10', 10)
      const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : 10
      const rows = db.getAllMemories().slice(0, limit)
      return { results: rows.map(toMemory) }
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/api/memories/:id',
    async (req, reply) => {
      const existing = db.getMemory(req.params.id)
      if (!existing) {
        reply.code(404)
        return { error: 'not_found', code: 'NOT_FOUND' }
      }
      const memory = toMemory(existing)
      db.deleteMemory(req.params.id)
      try { onMemoryDeleted?.(memory) } catch (e) { req.log.error(e, 'onMemoryDeleted callback failed') }
      reply.code(204).send()
      return undefined
    }
  )

  // Admin: which of the given ids have a stored embedding?
  // Used by integration tests; also handy as a future UI badge.
  app.get<{ Querystring: { ids?: string } }>(
    '/api/admin/embed-status',
    async req => {
      const idsParam = req.query.ids ?? ''
      const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean)
      const enabled = db.hasVectorSearch()
      if (ids.length === 0) {
        return {
          vectorSearchEnabled: enabled,
          totalEmbedded: enabled ? db.countEmbeddings() : 0,
          embedded: [],
          missing: []
        }
      }
      const all = enabled ? db.getEmbeddedMemoryIds() : new Set<string>()
      const embedded = ids.filter(id => all.has(id))
      const missing = ids.filter(id => !all.has(id))
      return {
        vectorSearchEnabled: enabled,
        totalEmbedded: enabled ? db.countEmbeddings() : 0,
        embedded,
        missing
      }
    }
  )

  app.get<{ Querystring: { url?: string } }>(
    '/api/vault/check-url',
    async (req, reply) => {
      const url = (req.query.url ?? '').trim()
      if (!url) {
        reply.code(400)
        return { error: 'url_required', code: 'URL_REQUIRED' }
      }
      const files = db.getAllVaultFiles()
      for (const f of files) {
        if (!f.content) continue
        const frontmatterEnd = f.content.indexOf('\n---\n', 4)
        if (frontmatterEnd === -1) continue
        const frontmatter = f.content.slice(0, frontmatterEnd)
        if (frontmatter.includes(`url: ${url}`)) {
          const separators = (f.content.match(/^---$/gm) ?? []).length
          const messageCount = Math.max(0, separators - 2)
          return { exists: true, path: f.filepath, messageCount }
        }
      }
      return { exists: false }
    }
  )

  app.post<{ Body: { filename?: string; content?: string; source?: string } }>(
    '/api/vault/save',
    async (req, reply) => {
      const body = req.body ?? {}
      const filename = (body.filename ?? '').trim()
      const content = body.content ?? ''
      const source: Source = isValidSource(body.source) ? body.source : 'manual'

      if (!filename) {
        reply.code(400)
        return { error: 'filename_required', code: 'FILENAME_REQUIRED' }
      }
      if (!saveVaultFile) {
        reply.code(503)
        return { error: 'vault_not_configured', code: 'VAULT_NOT_CONFIGURED' }
      }

      const result = await saveVaultFile(filename, content, source)
      if (!result.success) {
        reply.code(503)
        return { error: 'vault_write_failed', code: 'VAULT_WRITE_FAILED' }
      }
      reply.code(201)
      return { ok: true, path: result.path }
    }
  )

  return app
}

export async function startHttpServer(opts: HttpServerOptions): Promise<number> {
  if (server) throw new Error('HTTP server already running')
  const { port, ...buildOpts } = opts

  const app = buildApp(buildOpts)
  try {
    await app.listen({ port, host: HOST })
  } catch (err) {
    await app.close().catch(() => {})
    throw err
  }

  const addr = app.server.address()
  const actualPort = typeof addr === 'object' && addr ? addr.port : port
  server = app
  return actualPort
}

export async function stopHttpServer(): Promise<void> {
  if (!server) return
  const s = server
  server = null
  await s.close()
}

function extractKeywords(text: string, max: number): string[] {
  const words = Array.from(extractKeywordsFromText(text))
  const freq = new Map<string, number>()
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1)
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(e => e[0])
}
