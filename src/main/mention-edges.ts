// Mention-edge builder (graph perf overhaul, 100k-scale).
//
// Mention edges connect a memory to a vault file whose filename stem appears
// as a whole word in the memory's text. This used to live in the renderer's
// graph-builder, which forced memories:getAll to ship FULL CONTENT over IPC
// just so the renderer could tokenize it — at 100k memories that's hundreds
// of MB serialized per graph open. Building the edges here, where content is
// a local SQL read, removes content from the renderer data path entirely.
//
// Algorithm is the proven inverted-index form (word → memory ids, then one
// lookup per file stem): O(total words) build + O(files) lookups, with a
// per-file fan-out cap so common stems don't hairball.

import { getMentionSourceRows, getMentionFileRows, getMemoriesFingerprint, getVaultFilesFingerprint } from './db'
import log from 'electron-log'

export interface MentionEdge {
  source: string  // memory id
  target: string  // vault file id
}

export const MAX_MENTIONS_PER_FILE = 8

/** Filename without its last extension, lowercased. */
export function filenameStem(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').toLowerCase()
}

/**
 * Pure core — testable without SQLite. Mirrors the renderer's previous
 * whole-word matching exactly (words ≥3 chars, [a-z0-9]+ tokens).
 */
export function buildMentionEdges(
  memories: Array<{ id: string; title: string; content: string | null }>,
  files: Array<{ id: string; filename: string }>,
  cap = MAX_MENTIONS_PER_FILE,
): MentionEdge[] {
  if (memories.length === 0 || files.length === 0) return []

  const wordToMemoryIds = new Map<string, string[]>()
  for (const m of memories) {
    const words = new Set(
      (`${m.title} ${m.content ?? ''}`).toLowerCase().match(/[a-z0-9]+/g) ?? []
    )
    for (const w of words) {
      if (w.length <= 2) continue
      const arr = wordToMemoryIds.get(w)
      if (arr) arr.push(m.id)
      else wordToMemoryIds.set(w, [m.id])
    }
  }

  const edges: MentionEdge[] = []
  for (const f of files) {
    const stem = filenameStem(f.filename)
    if (stem.length <= 2) continue
    const matched = wordToMemoryIds.get(stem)
    if (!matched) continue
    const n = Math.min(matched.length, cap)
    for (let i = 0; i < n; i++) {
      edges.push({ source: matched[i], target: f.id })
    }
  }
  return edges
}

// ── Cached wrapper ────────────────────────────────────────────────────────────
//
// The index scan is O(all content) — seconds at 100k memories — so it runs at
// most once per data change. The fingerprint (COUNT + MAX(updatedAt) on both
// tables) catches every normal write path; bulk tag ops don't alter mention
// inputs (title/content/filenames), so they're irrelevant here.

let cache: { fingerprint: string; edges: MentionEdge[] } | null = null

export function invalidateMentionEdgeCache(): void {
  cache = null
}

export function getMentionEdges(): MentionEdge[] {
  const fingerprint = `${getMemoriesFingerprint()}|${getVaultFilesFingerprint()}`
  if (cache?.fingerprint === fingerprint) return cache.edges

  const t0 = Date.now()
  const edges = buildMentionEdges(getMentionSourceRows(), getMentionFileRows())
  log.info(`[mention-edges] rebuilt ${edges.length} edges in ${Date.now() - t0}ms`)
  cache = { fingerprint, edges }
  return edges
}
