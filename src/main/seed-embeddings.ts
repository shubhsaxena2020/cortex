import * as db from './db'
import log from 'electron-log'
import { getEmbedding, getEmbeddings, isOllamaAvailable, isEmbedModelAvailable } from './embeddings'

const BATCH_SIZE = 10

// ── Backfill state (v0.3.0 embedding backfill UI) ────────────────────────────
//
// One seeding run at a time. Pause takes effect at the next batch boundary;
// resume restarts the scan, which is cheap because already-embedded memories
// are skipped up front. Progress is pushed to the renderer via the callback
// registered by main/index.ts (broadcast over 'embeddings:progress').

export type SeedState = 'idle' | 'running' | 'paused' | 'done' | 'skipped'

export interface SeedStatus {
  state: SeedState
  done: number
  total: number
  /** Why the run was skipped: vector-search-disabled | ollama-unavailable | model-not-pulled */
  reason?: string
}

let status: SeedStatus = { state: 'idle', done: 0, total: 0 }
let pauseRequested = false
let running = false
let onProgress: ((s: SeedStatus) => void) | null = null

export function registerSeedProgressCallback(cb: (s: SeedStatus) => void): void {
  onProgress = cb
}

export function getSeedStatus(): SeedStatus {
  return { ...status }
}

export function pauseSeeding(): SeedStatus {
  if (status.state === 'running') pauseRequested = true
  return getSeedStatus()
}

export async function resumeSeeding(): Promise<SeedStatus> {
  if (status.state === 'paused' || status.state === 'skipped') {
    void seedEmbeddingsIfNeeded()
  }
  return getSeedStatus()
}

function setStatus(next: SeedStatus): void {
  status = next
  try { onProgress?.(getSeedStatus()) } catch { /* renderer gone */ }
}

// ── Embedding helpers ─────────────────────────────────────────────────────────

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
  if (running) return { skipped: 'already-running', embedded: status.done, total: status.total }

  if (!db.hasVectorSearch()) {
    setStatus({ state: 'skipped', done: 0, total: 0, reason: 'vector-search-disabled' })
    return { skipped: 'vector-search-disabled', embedded: 0, total: 0 }
  }

  if (!(await isOllamaAvailable())) {
    log.warn('[seed] Ollama unavailable; skipping embedding backfill (install from https://ollama.com)')
    setStatus({ state: 'skipped', done: 0, total: 0, reason: 'ollama-unavailable' })
    return { skipped: 'ollama-unavailable', embedded: 0, total: 0 }
  }

  if (!(await isEmbedModelAvailable())) {
    log.warn("[seed] embed model not pulled; run: ollama pull all-minilm")
    setStatus({ state: 'skipped', done: 0, total: 0, reason: 'model-not-pulled' })
    return { skipped: 'model-not-pulled', embedded: 0, total: 0 }
  }

  const all = db.getAllMemories()
  if (all.length === 0) {
    setStatus({ state: 'done', done: 0, total: 0 })
    return { embedded: 0, total: 0 }
  }

  const existing = db.getEmbeddedMemoryIds()
  const needed = all.filter(m => !existing.has(m.id))
  if (needed.length === 0) {
    log.info(`[seed] all ${all.length} memories already embedded`)
    setStatus({ state: 'done', done: all.length, total: all.length })
    return { embedded: 0, total: all.length }
  }

  log.info(`[seed] embedding ${needed.length} memories...`)
  running = true
  pauseRequested = false
  const alreadyDone = all.length - needed.length
  setStatus({ state: 'running', done: alreadyDone, total: all.length })

  let done = 0
  try {
    for (let i = 0; i < needed.length; i += BATCH_SIZE) {
      if (pauseRequested) {
        log.info(`[seed] paused at ${done}/${needed.length}`)
        setStatus({ state: 'paused', done: alreadyDone + done, total: all.length })
        return { embedded: done, total: all.length }
      }
      const batch = needed.slice(i, i + BATCH_SIZE)
      // One Ollama round-trip per batch instead of one per memory.
      const vecs = await getEmbeddings(batch.map(m => memoryToText(m)))
      batch.forEach((m, j) => {
        const vec = vecs[j]
        if (vec) db.storeEmbedding(m.id, vec)
        done++
      })
      setStatus({ state: 'running', done: alreadyDone + done, total: all.length })
      log.info(`[seed] ${done}/${needed.length}`)
    }
  } finally {
    running = false
  }
  log.info(`[seed] done — ${done} memories embedded`)
  setStatus({ state: 'done', done: alreadyDone + done, total: all.length })
  return { embedded: done, total: all.length }
}
