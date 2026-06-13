// Summary runner — orchestrates Ollama summarization against the DB.
//
// Single-flight: only one summarization in flight per memory id (so a
// hydration trigger + a backfill tick for the same row don't double-call
// Ollama). Idempotent across re-runs: a fresh content_hash short-circuits.

import * as db from './db'
import log from 'electron-log'
import { contentHash, isSummaryModelAvailable, summarizeMemory } from './summarize'

const inFlight = new Map<string, Promise<db.MemorySummary | null>>()
let modelAvailability: { value: boolean; checkedAt: number } | null = null
const AVAILABILITY_TTL_MS = 30_000

async function modelReady(): Promise<boolean> {
  const now = Date.now()
  if (modelAvailability && now - modelAvailability.checkedAt < AVAILABILITY_TTL_MS) {
    return modelAvailability.value
  }
  const ok = await isSummaryModelAvailable()
  modelAvailability = { value: ok, checkedAt: now }
  return ok
}

/**
 * Returns the cached summary if fresh; otherwise generates a new one (or
 * null if Ollama / the model is unreachable). Concurrent callers for the
 * same id share one in-flight promise.
 */
export function summarizeIfNeeded(memoryId: string): Promise<db.MemorySummary | null> {
  const existing = inFlight.get(memoryId)
  if (existing) return existing

  const promise = (async (): Promise<db.MemorySummary | null> => {
    const memory = db.getMemory(memoryId)
    if (!memory) return null
    const hash = contentHash(memory.title, memory.content)
    const cached = db.getSummary(memoryId)
    if (cached && cached.contentHash === hash && (cached.oneLine || cached.paragraph)) {
      return cached
    }

    if (!(await modelReady())) return null

    const result = await summarizeMemory(memory.title, memory.content)
    if (!result.oneLine && !result.paragraph) return null
    const summary: db.MemorySummary = {
      memoryId,
      oneLine: result.oneLine,
      paragraph: result.paragraph,
      contentHash: hash,
      model: result.model,
      createdAt: Date.now(),
    }
    db.upsertSummary(summary)
    return summary
  })().finally(() => { inFlight.delete(memoryId) })

  inFlight.set(memoryId, promise)
  return promise
}

/**
 * Backfill summaries for memories whose summary is missing or stale. Runs
 * sequentially (Ollama serialises generate calls anyway) and yields between
 * memories so the UI thread isn't starved.
 */
export async function backfillSummaries(
  limit?: number,
  onProgress?: (done: number, total: number) => void,
): Promise<{ done: number; total: number; skipped?: string }> {
  if (!(await modelReady())) {
    return { done: 0, total: 0, skipped: 'model-unavailable' }
  }
  const needed = db.getMemoryIdsNeedingSummary(id => {
    const m = db.getMemory(id)
    return m ? contentHash(m.title, m.content) : ''
  }, limit)
  if (needed.length === 0) return { done: 0, total: 0 }

  log.info(`[summary] backfill: ${needed.length} memories`)
  let done = 0
  for (const id of needed) {
    try {
      await summarizeIfNeeded(id)
    } catch (err) {
      log.warn(`[summary] backfill: ${id} failed:`, err)
    }
    done++
    if (onProgress) onProgress(done, needed.length)
    await new Promise(r => setImmediate(r))
  }
  log.info(`[summary] backfill complete: ${done}/${needed.length}`)
  return { done, total: needed.length }
}
