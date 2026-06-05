// Level-of-detail thresholds + cluster aggregation for the graph view.
//
// LOD is a zoom-driven enum: FAR clusters nearby nodes into one disc; MEDIUM
// renders every node but skips labels; CLOSE renders nodes + labels + the
// stronger highlight rings. Edge rendering uses the same enum (FAR drops
// 'mention' edges entirely; MEDIUM keeps both but lighter).
//
// Cluster aggregation runs on the already-culled set of nodes from the
// quadtree query — never on the global graph. Pinning it after culling keeps
// the cost O(visible) instead of O(total).

import type { Point2D } from './quadtree'

export type DetailLevel = 'far' | 'medium' | 'close'

// Thresholds picked from the GraphCanvas zoom scaleExtent [0.05, 8] so all
// three levels are reachable. Keep MEDIUM the widest band — it's the common
// working zoom.
export const LOD_FAR_MAX = 0.5
export const LOD_CLOSE_MIN = 2.0

export function getDetailLevel(zoom: number): DetailLevel {
  if (zoom < LOD_FAR_MAX) return 'far'
  if (zoom >= LOD_CLOSE_MIN) return 'close'
  return 'medium'
}

export interface Cluster<T> {
  x: number
  y: number
  size: number          // number of nodes in this cluster
  members: T[]          // kept for hit-testing; not rendered individually
  representativeId: string  // stable id for highlight continuity
}

/**
 * Group nodes into spatial buckets using a fixed grid sized in screen pixels.
 * Grid size grows as we zoom out — at zoom=0.05 a single screen pixel covers
 * 20 simulation units, so a 40-screen-pixel bucket = 800 sim units.
 *
 * Grid bucketing beats quadtree-based clustering here because clusters are
 * recomputed every camera move; a grid is O(n) per frame with no tree
 * traversal, and clusters reproject cleanly when zoom changes (no flicker
 * from tree rebalancing).
 *
 * MAX_CLUSTER_SIZE caps the visual weight of a single dot so a dense region
 * doesn't become one gigantic disc; instead it stays as several large dots.
 */
const MAX_CLUSTER_SIZE = 50
const BUCKET_SCREEN_PX = 40

export function clusterNodes<T extends Point2D & { id: string }>(
  nodes: readonly T[],
  zoom: number,
): Cluster<T>[] {
  if (nodes.length === 0) return []
  const bucketSize = BUCKET_SCREEN_PX / zoom
  const buckets = new Map<string, T[]>()
  for (const n of nodes) {
    const bx = Math.floor(n.x / bucketSize)
    const by = Math.floor(n.y / bucketSize)
    const key = `${bx}|${by}`
    let arr = buckets.get(key)
    if (!arr) { arr = []; buckets.set(key, arr) }
    arr.push(n)
  }
  const out: Cluster<T>[] = []
  for (const arr of buckets.values()) {
    // Split oversized buckets into multiple clusters so MAX_CLUSTER_SIZE is
    // an upper bound on every output. Cheap, deterministic, no spatial reshuffle.
    for (let i = 0; i < arr.length; i += MAX_CLUSTER_SIZE) {
      const slice = arr.slice(i, i + MAX_CLUSTER_SIZE)
      let sx = 0, sy = 0
      for (const n of slice) { sx += n.x; sy += n.y }
      out.push({
        x: sx / slice.length,
        y: sy / slice.length,
        size: slice.length,
        members: slice,
        representativeId: slice[0].id,
      })
    }
  }
  return out
}
