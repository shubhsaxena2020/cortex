// Extract runner — orchestrates atomic-learning extraction against the DB.
//
// Single-flight per parent id. Calls Ollama via extract.ts, then inserts
// each learning as a first-class memory (source='derived', derived_from=
// parent.id). Inherits the parent's tags so the digest already groups
// learnings correctly without a second pass.

import { randomUUID } from 'crypto'
import * as db from './db'
import log from 'electron-log'
import { extractLearningsFromText, dedupeLearnings } from './extract'
import { isSummaryModelAvailable } from './summarize'

const inFlight = new Map<string, Promise<string[]>>()
let modelAvailability: { value: boolean; checkedAt: number } | null = null
const AVAILABILITY_TTL_MS = 30_000

async function modelReady(): Promise<boolean> {
  const now = Date.now()
  if (modelAvailability && now - modelAvailability.checkedAt < AVAILABILITY_TTL_MS) {
    return modelAvailability.value
  }
  // Reuse summarize's availability probe — same model in the common config.
  const ok = await isSummaryModelAvailable()
  modelAvailability = { value: ok, checkedAt: now }
  return ok
}

function titleFor(learning: string): string {
  // Trim to a reasonable display length without breaking mid-word.
  const trimmed = learning.trim()
  if (trimmed.length <= 80) return trimmed
  const cut = trimmed.lastIndexOf(' ', 80)
  return trimmed.slice(0, cut > 50 ? cut : 80) + '…'
}

/**
 * Extract learnings for one parent memory. Returns the ids of the new
 * derived memories. Skips parents that aren't suitable (too short,
 * already-derived themselves, etc.) and silently no-ops if Ollama is
 * unavailable.
 */
export function extractForMemory(parentId: string): Promise<string[]> {
  const existing = inFlight.get(parentId)
  if (existing) return existing

  const promise = (async (): Promise<string[]> => {
    const parent = db.getMemory(parentId)
    if (!parent) return []
    if (parent.source === 'derived' || parent.source === 'journal') return []
    if ((parent.content?.length ?? 0) < 80) return []
    if (!(await modelReady())) return []

    const { learnings: raw } = await extractLearningsFromText(parent.title, parent.content ?? '')
    if (raw.length === 0) return []

    // Dedupe against existing children — if we re-extract on a re-captured
    // chat, don't store the same learnings twice.
    const existingChildren = db.getDerivedFor(parentId).map((m) => m.content)
    const fresh = dedupeLearnings(raw, existingChildren)
    if (fresh.length === 0) return []

    const created: string[] = []
    for (const text of fresh) {
      const id = randomUUID()
      try {
        db.createDerivedMemory(id, titleFor(text), text, parentId, parent.tags)
        created.push(id)
      } catch (err) {
        log.warn(`[extract] failed to insert derived from ${parentId}:`, err)
      }
    }
    if (created.length > 0) {
      log.info(`[extract] ${parentId.slice(0, 8)}: extracted ${created.length} learning(s)`)
    }
    return created
  })().finally(() => { inFlight.delete(parentId) })

  inFlight.set(parentId, promise)
  return promise
}

/** Backfill extraction for memories whose extraction is still pending. */
export async function backfillExtraction(
  limit?: number,
  onProgress?: (done: number, total: number) => void,
): Promise<{ done: number; total: number; created: number; skipped?: string }> {
  if (!(await modelReady())) {
    return { done: 0, total: 0, created: 0, skipped: 'model-unavailable' }
  }
  // Targets: memories that are eligible (not derived, not journal, content
  // long enough) AND have no derived children yet. The COUNT subquery on
  // memory_relationships isn't necessary because we use the derived_from
  // index for exact "has children" lookups.
  const rows = db.getMemoriesNeedingExtraction(limit ?? 50)
  if (rows.length === 0) return { done: 0, total: 0, created: 0 }
  log.info(`[extract] backfill: ${rows.length} parent memories`)
  let done = 0
  let created = 0
  for (const id of rows) {
    try {
      const ids = await extractForMemory(id)
      created += ids.length
    } catch (err) {
      log.warn(`[extract] backfill failed for ${id}:`, err)
    }
    done++
    if (onProgress) onProgress(done, rows.length)
    await new Promise(r => setImmediate(r))
  }
  log.info(`[extract] backfill complete: ${done} processed, ${created} learnings`)
  return { done, total: rows.length, created }
}
