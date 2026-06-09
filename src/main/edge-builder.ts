// Edge builder — three-signal cascade for Memory→Memory auto-edges (P1 #4).
//
// When a memory is created or during backfill, this module finds related memories
// using three signals in order: shared tags (Jaccard), keyword overlap (FTS5-indexed),
// and embedding cosine similarity (sqlite-vec KNN). Top 5 candidates become edges
// in the memory_relationships table.
//
// Performance constraints:
//  - Signal 2 uses FTS5 MATCH, NOT O(N²) iteration
//  - Signal 3 uses sqlite-vec KNN, NOT manual cosine scan
//  - Signal 1 scans all memories with tags but skips those already found

import type Database from 'better-sqlite3'
import { extractKeywords, jaccardSimilarity } from './utils/text'
import { getEmbedding } from './embeddings'
import log from 'electron-log'

// Thresholds
const TAG_MIN_SCORE = 0.0       // Any tag overlap qualifies as candidate
const KW_THRESHOLD = 0.15       // Keyword Jaccard ≥ 0.15
const EMBED_WEAK = 0.50         // Cosine similarity ≥ 0.50 (weak candidate)
const EMBED_STRONG = 0.70       // Cosine similarity ≥ 0.70 (strong)
const MAX_EDGES_PER_MEMORY = 5  // Edge cap — prevents hairball

interface EdgeCandidate {
  targetId: string
  score: number
  signalType: 'auto:tag' | 'auto:keyword' | 'auto:embedding'
}

type MemoryRow = {
  id: string
  title: string
  content: string | null
  timestamp: number
  updatedAt: number
  source: string
  tags: string | null
  url: string | null
}

/**
 * Tag Jaccard score between two memories.
 */
function tagScore(tagsA: string[], tagsB: string[]): number {
  return jaccardSimilarity(new Set(tagsA), new Set(tagsB))
}

/**
 * Signal 2: Use FTS5 MATCH to find keyword-similar candidates efficiently.
 * Returns matching memory IDs for further scoring.
 */
function getKeywordCandidates(
  db: Database.Database,
  memoryId: string,
  content: string,
): string[] {
  const keywords = Array.from(extractKeywords(content || '')).slice(0, 10)
  if (keywords.length === 0) return []

  // Build FTS5 query: keyword1 OR keyword2 OR ...
  const ftsQuery = keywords.map(k => `"${k.replace(/"/g, '""')}"`).join(' OR ')

  try {
    const rows = db.prepare(`
      SELECT memory_id
      FROM memories_fts
      WHERE memories_fts MATCH ?
      AND memory_id != ?
      LIMIT 50
    `).all(ftsQuery, memoryId) as Array<{ memory_id: string }>
    return rows.map(r => r.memory_id)
  } catch (err) {
    log.warn('[edge-builder] FTS5 keyword query failed:', err)
    return []
  }
}

/**
 * Load tag candidates: all memories with non-empty tags.
 * Returns memory IDs + tags for scoring.
 */
function getTagCandidates(
  db: Database.Database,
  memoryId: string,
): Array<{ id: string; tags: string }> {
  return db.prepare(`
    SELECT id, tags FROM memories
    WHERE id != ?
    AND tags IS NOT NULL
    AND tags != '[]'
  `).all(memoryId) as Array<{ id: string; tags: string }>
}

/**
 * Signal 3: Use sqlite-vec KNN to find embedding-similar candidates.
 * Requires sqlite-vec to be loaded (hasVectorSearch).
 * Returns memory IDs with their cosine similarity scores.
 */
async function getEmbeddingCandidates(
  db: Database.Database,
  memoryId: string,
  memoryContent: string,
): Promise<Array<{ id: string; similarity: number }>> {
  // Check if vector search is available by testing the table
  try {
    // First, ensure this memory has an embedding
    const existing = db.prepare(
      'SELECT 1 FROM memory_vectors WHERE memory_id = ?'
    ).get(memoryId) as unknown

    if (!existing) {
      // Try to generate embedding on the fly
      const vec = await getEmbedding(memoryContent || memoryId)
      if (vec) {
        const buf = Buffer.from(new Float32Array(vec).buffer)
        const upsert = db.transaction((id: string, b: Buffer) => {
          db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(id)
          db.prepare('INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)').run(id, b)
        })
        upsert(memoryId, buf)
      } else {
        return [] // Ollama unavailable — skip signal 3
      }
    }

    // KNN query — fetch the memory's own vector and search
    const row = db.prepare(
      'SELECT embedding FROM memory_vectors WHERE memory_id = ?'
    ).get(memoryId) as { embedding: Buffer } | undefined

    if (!row) return []

    // vec0 KNN: MATCH with the query vector buffer
    const candidates = db.prepare(`
      SELECT memory_id, distance
      FROM memory_vectors
      WHERE embedding MATCH ?
      AND memory_id != ?
      ORDER BY distance
      LIMIT 20
    `).all(row.embedding, memoryId) as Array<{ memory_id: string; distance: number }>

    // Convert cosine distance (0=identical, 2=opposite) to similarity
    return candidates
      .map(c => ({ id: c.memory_id, similarity: 1 - (c.distance / 2) }))
      .filter(c => c.similarity >= EMBED_WEAK)
  } catch (err) {
    // sqlite-vec not loaded or query failed — graceful fallback
    return []
  }
}

/**
 * Build auto-edges for a single memory by running the three-signal cascade.
 *
 * 1. Keyword candidates via FTS5 (fastest, narrows the search space)
 * 2. Tag candidates via SQL scan (only if memory has tags)
 * 3. Embedding candidates via sqlite-vec KNN (only if available)
 *
 * Results are scored, sorted, and capped at MAX_EDGES_PER_MEMORY.
 *
 * @returns Number of edges created
 */
export async function buildEdgesForMemory(
  db: Database.Database,
  memoryId: string,
  opts: { isBackfill?: boolean } = {},
): Promise<number> {
  const memory = db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) as MemoryRow | undefined
  if (!memory) return 0

  const memoryTags: string[] = JSON.parse(memory.tags || '[]')
  const memoryKeywords = extractKeywords(memory.content || '')

  const candidateMap = new Map<string, EdgeCandidate>()

  // --- Signal 2: Keyword candidates (FTS5-indexed — fast path) ---
  const kwCandidateIds = getKeywordCandidates(db, memoryId, memory.content || '')
  for (const otherId of kwCandidateIds) {
    const other = db.prepare('SELECT id, content, tags FROM memories WHERE id = ?').get(otherId) as MemoryRow | undefined
    if (!other) continue

    const otherKeywords = extractKeywords(other.content || '')
    const kwScore = jaccardSimilarity(memoryKeywords, otherKeywords)

    if (kwScore >= KW_THRESHOLD) {
      // Also check tag score while we have this memory loaded
      const otherTags: string[] = JSON.parse(other.tags || '[]')
      const tScore = tagScore(memoryTags, otherTags)

      // Pick the best signal for this candidate
      if (tScore > kwScore && tScore > TAG_MIN_SCORE) {
        candidateMap.set(otherId, { targetId: otherId, score: tScore, signalType: 'auto:tag' })
      } else {
        candidateMap.set(otherId, { targetId: otherId, score: kwScore, signalType: 'auto:keyword' })
      }
    }
  }

  // --- Signal 1: Tag candidates (SQL — only if memory has tags) ---
  if (memoryTags.length > 0) {
    const tagCandidates = getTagCandidates(db, memoryId)
    for (const other of tagCandidates) {
      if (candidateMap.has(other.id)) continue // Already found via keyword
      const otherTags: string[] = JSON.parse(other.tags || '[]')
      const score = tagScore(memoryTags, otherTags)
      if (score > TAG_MIN_SCORE) {
        candidateMap.set(other.id, { targetId: other.id, score, signalType: 'auto:tag' })
      }
    }
  }

  // --- Signal 3: Embedding candidates (sqlite-vec KNN — async) ---
  const embCandidates = await getEmbeddingCandidates(db, memoryId, memory.content || '')
  for (const { id: otherId, similarity } of embCandidates) {
    const existing = candidateMap.get(otherId)
    if (!existing || similarity > existing.score) {
      candidateMap.set(otherId, {
        targetId: otherId,
        score: similarity,
        signalType: 'auto:embedding',
      })
    }
  }

  // --- Apply edge cap: top 5 by score ---
  const top5 = Array.from(candidateMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_EDGES_PER_MEMORY)

  if (top5.length === 0) return 0

  // --- Insert edges (idempotent) ---
  const insert = db.prepare(
    `INSERT OR REPLACE INTO memory_relationships (id, sourceId, targetId, relationship, strength, signal_type)
     VALUES (?, ?, ?, ?, ?, ?)`
  )

  const insertMany = db.transaction((edges: typeof top5) => {
    for (const edge of edges) {
      const compositeId = `${memoryId}-${edge.targetId}`
      insert.run(compositeId, memoryId, edge.targetId, edge.signalType, edge.score, edge.signalType)
    }
  })

  insertMany(top5)
  return top5.length
}

/**
 * Backfill auto-edges for all memories that don't yet have any auto-edges.
 * Runs in batches to avoid blocking the event loop.
 */
export async function backfillAllEdges(
  db: Database.Database,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  // Only process memories with no existing auto-edges
  const unconnected = db.prepare(`
    SELECT m.id
    FROM memories m
    LEFT JOIN memory_relationships mr ON mr.sourceId = m.id AND mr.signal_type LIKE 'auto:%'
    WHERE mr.sourceId IS NULL
    ORDER BY m.timestamp DESC
  `).all() as Array<{ id: string }>

  const total = unconnected.length
  if (total === 0) {
    log.info('[edge-builder] backfill: all memories already have auto-edges (no-op)')
    return
  }

  log.info(`[edge-builder] backfill: processing ${total} memories`)
  let done = 0
  const BATCH_SIZE = 50

  for (let i = 0; i < unconnected.length; i += BATCH_SIZE) {
    const batch = unconnected.slice(i, i + BATCH_SIZE)

    for (const { id } of batch) {
      try {
        await buildEdgesForMemory(db, id, { isBackfill: true })
      } catch (err) {
        log.warn(`[edge-builder] backfill: failed for memory ${id}:`, err)
      }
      done++
      if (onProgress) onProgress(done, total)
    }

    // Yield after each batch to avoid blocking the event loop
    await new Promise(resolve => setImmediate(resolve))
  }

  log.info(`[edge-builder] backfill: complete — ${done} memories processed`)
}
