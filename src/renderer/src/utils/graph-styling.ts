// Pure mapping from our internal graph data (graph-builder.ts output) to the
// node/edge attribute shapes Sigma + Graphology consume. Kept pure and
// dependency-free so it's unit-testable and the WebGL renderer in
// GraphSigma.tsx never has to fight typing.

import type { GraphLink, GraphNode } from './graph-builder'

/** Edge color palette per the v0.5 thesis + the new Sigma spec. */
export function edgeColor(link: Pick<GraphLink, 'signalType' | 'edgeType'>): string {
  switch (link.signalType) {
    case 'auto:tag':       return '#4A9EFF' // blue — tag Jaccard
    case 'auto:keyword':   return '#FFD700' // yellow — keyword overlap
    // The user spec calls this "auto:cosine"; the codebase has historically
    // used "auto:embedding". Treat both as the same purple cosine-similarity edge.
    case 'auto:embedding': return '#A855F7' // purple
    case 'wiki':           return '#10b981' // emerald — explicit [[wiki]] link
  }
  if (link.edgeType === 'mention') return '#333' // very dim — mention edges
  return '#666' // default grey for manual/unknown
}

/**
 * Node size in Sigma units (Sigma multiplies these by a screen-px scale).
 * Spec: `Math.max(4, Math.min(20, Math.sqrt(connections) * 3))`. Floats are
 * fine — Sigma will clamp to its own internal min/max as well.
 */
export function nodeSize(connections: number): number {
  if (!Number.isFinite(connections) || connections < 0) connections = 0
  return Math.max(4, Math.min(20, Math.sqrt(connections) * 3))
}

/**
 * Sigma-side attributes for a node. The original GraphNode is stashed as
 * `rawNode` so click/hover handlers can ship it back to React state.
 */
export interface SigmaNodeAttrs {
  label: string
  x: number
  y: number
  size: number
  color: string
  nodeType: GraphNode['nodeType']
  source?: string
  connections: number
  rawNode: GraphNode
}

export function toSigmaNode(node: GraphNode, position: { x: number; y: number }): SigmaNodeAttrs {
  return {
    label: node.title,
    x: position.x,
    y: position.y,
    size: nodeSize(node.connections),
    color: node.color,
    nodeType: node.nodeType,
    source: node.source,
    connections: node.connections,
    rawNode: node,
  }
}

export interface SigmaEdgeAttrs {
  color: string
  size: number
  signalType?: GraphLink['signalType']
  edgeType: GraphLink['edgeType']
  strength: number
  /** Whether to dash the line. Sigma's default edge program ignores this;
   *  custom programs read it. Mention edges look better as dashes. */
  dashed: boolean
}

export function toSigmaEdge(link: GraphLink): SigmaEdgeAttrs {
  const strength = typeof link.strength === 'number' ? link.strength : 0.5
  return {
    color: edgeColor(link),
    // Edge thickness reflects strength so high-confidence relationships are
    // visually weightier. Capped to keep dense graphs readable.
    size: Math.max(0.4, Math.min(2.5, strength * 1.6 + 0.3)),
    signalType: link.signalType,
    edgeType: link.edgeType,
    strength,
    dashed: link.edgeType === 'mention',
  }
}

/**
 * Sigma throws if a node has no x/y. For the very first frame, before
 * ForceAtlas2 has run a single step, we seed positions on a small unit
 * grid scaled by node count so FA2 has a non-degenerate starting state.
 *
 * Deterministic — same node order yields same positions, which keeps
 * snapshot/golden test outputs stable.
 */
export function initialPosition(index: number, total: number): { x: number; y: number } {
  if (total <= 0) return { x: 0, y: 0 }
  // Phyllotaxis spiral — same trick d3-force uses internally. Avoids the
  // central pile-up that uniform `Math.random()` gives.
  const angle = index * 2.4
  const radius = Math.sqrt(index + 1)
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
}
