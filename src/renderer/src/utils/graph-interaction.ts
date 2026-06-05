// Graph interaction primitives: adjacency lookup, hit testing, and BFS
// neighbour expansion. Pure, side-effect-free — owned by the component
// that ties them to canvas events.

import type { GraphNode } from './graph-builder'
import type { Quadtree } from './quadtree'
import { nodeRadius } from './graph-renderer'

export interface AdjacencyEntry {
  /** Set of neighbour node ids reachable via any edge type. */
  neighbours: Set<string>
}

/**
 * Build an undirected adjacency map keyed by node id. Run once when nodes
 * or links change — O(n + m), small constant per entry, ~600 KB for a 10k /
 * 20k graph (one Set per node).
 */
export function buildAdjacency(
  nodes: readonly GraphNode[],
  links: readonly { source: string | GraphNode; target: string | GraphNode }[],
): Map<string, AdjacencyEntry> {
  const map = new Map<string, AdjacencyEntry>()
  for (const n of nodes) map.set(n.id, { neighbours: new Set() })
  for (const l of links) {
    const s = typeof l.source === 'string' ? l.source : l.source.id
    const t = typeof l.target === 'string' ? l.target : l.target.id
    map.get(s)?.neighbours.add(t)
    map.get(t)?.neighbours.add(s)
  }
  return map
}

/**
 * Hit-test the graph at simulation coordinates (sx, sy). The quadtree narrows
 * candidates to a small window; final selection is the visually-closest node
 * whose disc covers the point (with a small pixel tolerance).
 *
 * Returns null if no node is within range.
 */
export function getNodeAtPoint<T extends GraphNode & { x?: number; y?: number }>(
  sx: number,
  sy: number,
  tree: Quadtree<T> | null,
  fallbackNodes: readonly T[],
  hitTolerancePx = 4,
  zoom = 1,
): T | null {
  // Query envelope must cover the largest possible disc + tolerance. We
  // compute against the screen-pixel tolerance so the hit area feels the
  // same at every zoom.
  const tolSim = hitTolerancePx / zoom
  const ENVELOPE = (NODE_R_HARD_MAX) + tolSim
  const candidates = tree
    ? tree.query({ minX: sx - ENVELOPE, minY: sy - ENVELOPE, maxX: sx + ENVELOPE, maxY: sy + ENVELOPE })
    : fallbackNodes
  let best: T | null = null
  let minD = Infinity
  for (const n of candidates) {
    const dx = (n.x ?? 0) - sx
    const dy = (n.y ?? 0) - sy
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d <= nodeRadius(n) + tolSim && d < minD) {
      minD = d
      best = n
    }
  }
  return best
}

// Hard envelope for hit-test windowing. Slightly larger than NODE_R_MAX so
// borderline hits (radius 14 + tolerance) always land inside the query
// rectangle. Kept private to interaction so renderer changes don't require
// a coupled bump here.
const NODE_R_HARD_MAX = 18

/**
 * BFS expansion: return the set of node ids within `depth` hops of `from`
 * (inclusive of `from` itself). Depth 1 is the typical hover-highlight ring.
 */
export function highlightPath(
  from: string,
  depth: number,
  adjacency: ReadonlyMap<string, AdjacencyEntry>,
): Set<string> {
  const out = new Set<string>([from])
  if (depth <= 0) return out
  let frontier: string[] = [from]
  for (let d = 0; d < depth; d++) {
    const next: string[] = []
    for (const id of frontier) {
      const entry = adjacency.get(id)
      if (!entry) continue
      for (const n of entry.neighbours) {
        if (!out.has(n)) {
          out.add(n)
          next.push(n)
        }
      }
    }
    if (next.length === 0) break
    frontier = next
  }
  return out
}

/**
 * Phase value in [0, 1) for a breathing pulse animation, derived from a
 * timestamp + period. Pure — caller schedules the RAF loop and passes
 * `performance.now()`.
 */
export function pulsePhase(nowMs: number, periodMs = 1600): number {
  return (nowMs % periodMs) / periodMs
}
