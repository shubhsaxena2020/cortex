import * as db from './db'
import log from 'electron-log'
import { getEmbedding, isOllamaAvailable, isEmbedModelAvailable } from './embeddings'

const BATCH_SIZE = 10

export function memoryToText(m: { title: string; content: string }): string {
  return `${m.title}\n\n${m.content || ''}`.trim()
}

export async function embedAndStore(memoryId: string, text: string): Promise<void> {
  if (!db.hasVectorSearch()) return
  if (!text.trim()) return
  const vec = await getEmbedding(text)
  if (vec) db.storeEmbedding(memoryId, vec)
}

export async function seedEmbeddingsIfNeeded(): Promise<{ skipped?: string; embedded: number; total: number }> {
  if (!db.hasVectorSearch()) {
    return { skipped: 'vector-search-disabled', embedded: 0, total: 0 }
  }

  if (!(await isOllamaAvailable())) {
    log.warn('[seed] Ollama unavailable; skipping embedding backfill (install from https://ollama.com)')
    return { skipped: 'ollama-unavailable', embedded: 0, total: 0 }
  }

  if (!(await isEmbedModelAvailable())) {
    log.warn("[seed] embed model not pulled; run: ollama pull all-minilm")
    return { skipped: 'model-not-pulled', embedded: 0, total: 0 }
  }

  const all = db.getAllMemories()
  if (all.length === 0) return { embedded: 0, total: 0 }

  const existing = db.getEmbeddedMemoryIds()
  const needed = all.filter(m => !existing.has(m.id))
  if (needed.length === 0) {
    log.info(`[seed] all ${all.length} memories already embedded`)
    return { embedded: 0, total: all.length }
  }

  log.info(`[seed] embedding ${needed.length} memories...`)
  let done = 0
  for (let i = 0; i < needed.length; i += BATCH_SIZE) {
    const batch = needed.slice(i, i + BATCH_SIZE)
    await Promise.all(batch.map(async (m) => {
      const vec = await getEmbedding(memoryToText(m))
      if (vec) db.storeEmbedding(m.id, vec)
      done++
    }))
    log.info(`[seed] ${done}/${needed.length}`)
  }
  log.info(`[seed] done — ${done} memories embedded`)
  return { embedded: done, total: all.length }
}
