// Ollama embeddings client. Embedding model runs as a separate process on the
// user's machine (privacy intact, no cloud calls). If Ollama isn't reachable
// or the model isn't pulled, every function here resolves to null gracefully
// so callers can fall back to keyword-based search.

import log from 'electron-log'

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const EMBED_MODEL = process.env.CORTEX_EMBED_MODEL || 'all-minilm'

export const EMBEDDING_DIM = 384  // all-minilm output dimension
const MAX_INPUT_CHARS = 4000      // long inputs get truncated to avoid token blowups
const CACHE_LIMIT = 1000
const HEALTH_TIMEOUT_MS = 2000

const cache = new Map<string, number[]>()

export async function isOllamaAvailable(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    })
    return r.ok
  } catch {
    return false
  }
}

export async function isEmbedModelAvailable(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    })
    if (!r.ok) return false
    const body = await r.json() as { models?: Array<{ name?: string }> }
    return (body.models ?? []).some(m =>
      typeof m.name === 'string' && m.name.startsWith(EMBED_MODEL)
    )
  } catch {
    return false
  }
}

export async function getEmbedding(text: string): Promise<number[] | null> {
  const trimmed = text.trim().slice(0, MAX_INPUT_CHARS)
  if (!trimmed) return null

  const cached = cache.get(trimmed)
  if (cached) return cached

  try {
    const r = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: trimmed })
    })
    if (!r.ok) {
      log.warn(`[embeddings] ollama responded ${r.status}`)
      return null
    }
    const body = await r.json() as { embeddings?: number[][] }
    const vec = body.embeddings?.[0]
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
      log.warn(`[embeddings] unexpected vector shape (got ${vec?.length}, want ${EMBEDDING_DIM})`)
      return null
    }

    // Tiny LRU: drop oldest entry when full.
    if (cache.size >= CACHE_LIMIT) {
      const firstKey = cache.keys().next().value
      if (firstKey !== undefined) cache.delete(firstKey)
    }
    cache.set(trimmed, vec)
    return vec
  } catch (err) {
    log.warn('[embeddings] request failed:', err)
    return null
  }
}

export function clearEmbeddingCache(): void {
  cache.clear()
}
