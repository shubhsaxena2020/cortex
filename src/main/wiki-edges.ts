// Wiki-edge sync — persists [[wiki links]] as graph relationships.
//
// Parsing/resolution is pure (wiki-links.ts); SQL lives in db.ts. This module
// is the thin orchestration layer the IPC handlers and startup hook call.
//
// Edge shape: sourceId = the memory containing the link, targetId = the
// linked memory, signal_type = 'wiki', strength = 1.0. Backlinks of M are
// therefore "wiki edges whose targetId is M" — the renderer derives them from
// the relationships it already has, no extra IPC needed.

import * as db from './db'
import { extractWikiLinks, buildTitleIndex, resolveLinks } from './wiki-links'
import log from 'electron-log'

/**
 * Re-derive the outgoing wiki edges of one memory from its current content.
 * Idempotent; removing every [[link]] from the content clears its edges.
 */
export function syncWikiEdgesForMemory(
  memoryId: string,
  titleIndex?: Map<string, string>,
): number {
  const memory = db.getMemory(memoryId)
  if (!memory) return 0
  const targets = extractWikiLinks(memory.content || '')
  if (targets.length === 0) {
    db.replaceWikiEdges(memoryId, [])
    return 0
  }
  const index = titleIndex ?? buildTitleIndex(db.getAllMemoryTitles())
  const { resolved } = resolveLinks(targets, index)
  return db.replaceWikiEdges(memoryId, resolved.map(r => r.id))
}

/**
 * A memory was created or retitled: links elsewhere that say [[its title]]
 * may have just become resolvable (or stale). FTS5 narrows the candidates;
 * syncWikiEdgesForMemory recomputes each one exactly.
 */
export function resyncMentionsOfTitle(title: string, excludeId?: string): void {
  const trimmed = title.trim()
  if (!trimmed) return
  const candidates = db.findMemoryIdsByPhrase(trimmed)
  if (candidates.length === 0) return
  const index = buildTitleIndex(db.getAllMemoryTitles())
  for (const id of candidates) {
    if (id === excludeId) continue
    try {
      syncWikiEdgesForMemory(id, index)
    } catch (err) {
      log.warn(`[wiki-edges] resync failed for ${id}:`, err)
    }
  }
}

/** Convenience hook for create/update paths: own links + inbound mentions. */
export function syncWikiAfterChange(memoryId: string, title: string): void {
  try {
    syncWikiEdgesForMemory(memoryId)
    resyncMentionsOfTitle(title, memoryId)
  } catch (err) {
    log.warn(`[wiki-edges] sync failed for ${memoryId}:`, err)
  }
}

/**
 * Startup backfill: sync every memory whose content contains '[['. The LIKE
 * prefilter keeps this O(linkers), not O(all memories) — on a vault with no
 * wiki syntax it's a single indexed-ish scan and zero writes.
 */
export function backfillWikiEdges(): { processed: number; edges: number } {
  const ids = db.getMemoryIdsWithWikiSyntax()
  if (ids.length === 0) return { processed: 0, edges: 0 }
  const index = buildTitleIndex(db.getAllMemoryTitles())
  let edges = 0
  for (const id of ids) {
    try {
      edges += syncWikiEdgesForMemory(id, index)
    } catch (err) {
      log.warn(`[wiki-edges] backfill failed for ${id}:`, err)
    }
  }
  log.info(`[wiki-edges] backfill: ${ids.length} linkers, ${edges} edges`)
  return { processed: ids.length, edges }
}
