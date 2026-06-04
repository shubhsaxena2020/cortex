// embeddings.ts — Ollama client tests. Pure-node, no native deps.
// All tests stub global.fetch to control Ollama responses without a network.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

const DIM = 384
const TOKEN_LENGTH = 64
void TOKEN_LENGTH  // silence unused; kept for shape parity with other tests

function makeVec(seed = 1): number[] {
  return Array.from({ length: DIM }, (_, i) => Math.sin(seed + i))
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

// Spy on fetch BEFORE importing the module under test, so the spy intercepts
// any module-load-time calls (none currently, but defensive).
const fetchSpy = vi.fn<typeof fetch>()
globalThis.fetch = fetchSpy as unknown as typeof fetch

const { isOllamaAvailable, isEmbedModelAvailable, getEmbedding, clearEmbeddingCache, EMBEDDING_DIM } =
  await import('./embeddings')

beforeEach(() => {
  fetchSpy.mockReset()
  clearEmbeddingCache()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('embeddings — EMBEDDING_DIM constant', () => {
  it('exports the 384-dim constant in lockstep with db.ts', () => {
    expect(EMBEDDING_DIM).toBe(DIM)
  })
})

describe('embeddings — isOllamaAvailable', () => {
  it('returns true when /api/tags responds 200', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResp({ models: [] }))
    expect(await isOllamaAvailable()).toBe(true)
  })

  it('returns false when /api/tags responds non-2xx', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResp({}, 500))
    expect(await isOllamaAvailable()).toBe(false)
  })

  it('returns false when fetch throws (connection refused)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    expect(await isOllamaAvailable()).toBe(false)
  })
})

describe('embeddings — isEmbedModelAvailable', () => {
  it('returns true when models list includes the embed model', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResp({ models: [{ name: 'all-minilm:latest' }] }))
    expect(await isEmbedModelAvailable()).toBe(true)
  })

  it('returns false when the model is missing from the list', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResp({ models: [{ name: 'llama3' }] }))
    expect(await isEmbedModelAvailable()).toBe(false)
  })

  it('returns false when /api/tags errors', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('boom'))
    expect(await isEmbedModelAvailable()).toBe(false)
  })
})

describe('embeddings — getEmbedding', () => {
  it('returns null for empty / whitespace-only input without hitting Ollama', async () => {
    expect(await getEmbedding('')).toBeNull()
    expect(await getEmbedding('   \n  ')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns the embedding vector on happy path', async () => {
    const vec = makeVec()
    fetchSpy.mockResolvedValueOnce(jsonResp({ embeddings: [vec] }))
    const result = await getEmbedding('hello world')
    expect(result).toEqual(vec)
    expect(result).toHaveLength(DIM)
  })

  it('memoizes repeated identical inputs (cache hit on second call)', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResp({ embeddings: [makeVec(2)] }))
    const a = await getEmbedding('cached text')
    const b = await getEmbedding('cached text')
    expect(a).toEqual(b)
    expect(fetchSpy).toHaveBeenCalledTimes(1)  // second call served from cache
  })

  it('returns null on non-2xx response', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResp({ error: 'oops' }, 500))
    expect(await getEmbedding('x')).toBeNull()
  })

  it('returns null when Ollama returns wrong-dim vector', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResp({ embeddings: [[1, 2, 3]] }))
    expect(await getEmbedding('x')).toBeNull()
  })

  it('returns null when Ollama returns empty embeddings array', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResp({ embeddings: [] }))
    expect(await getEmbedding('x')).toBeNull()
  })

  it('returns null when fetch rejects', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'))
    expect(await getEmbedding('x')).toBeNull()
  })

  it('truncates very long inputs before sending', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResp({ embeddings: [makeVec()] }))
    const longInput = 'a'.repeat(50_000)
    await getEmbedding(longInput)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const call = fetchSpy.mock.calls[0]
    const init = call[1] as RequestInit | undefined
    const body = JSON.parse(init?.body as string)
    // MAX_INPUT_CHARS = 4000 in embeddings.ts
    expect(body.input.length).toBe(4000)
  })

  it('cache is keyed on the trimmed/truncated input, so whitespace variants share', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResp({ embeddings: [makeVec(7)] }))
    const a = await getEmbedding('  same text  ')
    const b = await getEmbedding('same text')
    expect(a).toEqual(b)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('clearEmbeddingCache forces a refetch on next call', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResp({ embeddings: [makeVec()] }))
    await getEmbedding('refresh me')
    clearEmbeddingCache()
    fetchSpy.mockResolvedValueOnce(jsonResp({ embeddings: [makeVec(99)] }))
    await getEmbedding('refresh me')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
