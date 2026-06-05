// Obsidian-style graph drawing primitives.
//
// All functions are pure and take ctx + already-transformed simulation
// coordinates (the caller handles ctx.translate/scale once per frame). Sizes
// and line widths that should look constant on screen accept the current
// zoom and divide internally — call sites stay free of `/ zoom` noise.
//
// Visual language:
//   - Node colours come from graph-builder (one per source/file kind). We
//     don't redefine palettes here — we only modulate alpha by render state.
//   - Edges are achromatic by default and only adopt colour when emphasised.
//   - Labels fade smoothly across a zoom band so there's no "snap" at any
//     particular zoom level (the previous LOD enum did this and felt jarring).

import type { GraphNode } from './graph-builder'

export type NodeState = 'normal' | 'dim' | 'highlight' | 'selected'
export type EdgeKind = 'relationship' | 'mention'
export type EdgeState = 'normal' | 'dim' | 'highlight'

// Zoom thresholds for the label fade ramp. Matches Obsidian: labels are gone
// at/below zoom 0.5 and fully shown at/above 1.0, fading linearly in log2(zoom)
// space between. (Obsidian: textAlpha = clamp(log2(zoom)+1-textFade, 0, 1);
// see docs/OBSIDIAN-GRAPH-PATTERNS.md.) These are the zoom values where the
// ramp hits 0 and 1.
export const LABEL_FADE_LO = 0.5
export const LABEL_FADE_HI = 1.0

// Node radius envelope. Keep MIN small enough that a dense cluster reads as
// "many small dots" rather than "one fat blob", but big enough to be hit-
// testable. MAX is capped so a 200-degree super-node doesn't dominate.
export const NODE_R_MIN = 8
export const NODE_R_MAX = 30

/**
 * Visual radius in simulation units for a node, derived from its degree.
 * Obsidian's exact formula: clamp(3·√(degree+1), 8, 30) (times nodeSizeMultiplier,
 * which Cortex pins at 1). √ scaling — a hub grows fast then flattens at the cap.
 * See docs/OBSIDIAN-GRAPH-PATTERNS.md (@2215514).
 */
export function nodeRadius(node: GraphNode): number {
  const r = 3 * Math.sqrt(node.connections + 1)
  return Math.max(NODE_R_MIN, Math.min(r, NODE_R_MAX))
}

/**
 * Label opacity as a pure function of zoom. Obsidian's exact ramp:
 * clamp(log2(zoom) + 1 - textFadeMultiplier, 0, 1) with textFadeMultiplier = 0.
 * Linear in log2(zoom): 0 at zoom 0.5, 1 at zoom 1.0.
 */
export function labelOpacity(zoom: number): number {
  if (zoom <= 0) return 0
  return Math.max(0, Math.min(1, Math.log2(zoom) + 1))
}

// Cheap 8-hex alpha suffix — avoids string allocations inside the hot loop
// by precomputing both for every state. The base node.color from
// graph-builder is "#RRGGBB", append "AA" for the alpha byte.
const ALPHA_HEX = {
  normal:    'cc',  // 80%
  dim:       '33',  // 0.2 — Obsidian's exact dim alpha (fQ = 0.2) for nodes
                    // outside the hovered subgraph. The larger 8–30px node radii
                    // keep them readable against #0c0c10 even at 20% alpha.
  highlight: 'ff',  // 100%
  selected:  'ff',  // 100% (plus pulse ring on top, see drawNode)
} satisfies Record<NodeState, string>

/** Compose node fill colour. Returns "#RRGGBBAA". */
export function nodeFill(node: GraphNode, state: NodeState): string {
  return node.color + ALPHA_HEX[state]
}

/**
 * Draw one node. ctx is already translated+scaled to simulation space.
 * Pass `pulsePhase` in [0,1) for the selected state to drive the glow ring.
 */
export function drawNode(
  ctx: CanvasRenderingContext2D,
  node: GraphNode & { x?: number; y?: number },
  state: NodeState,
  zoom: number,
  pulsePhase = 0,
): void {
  const x = node.x ?? 0
  const y = node.y ?? 0
  const r = nodeRadius(node)

  // Glow / pulse ring for selected + highlight. Sized to scale with the node
  // so a 4px dot doesn't get a 20px ring.
  if (state === 'selected') {
    // Pulse breathes between +3 and +7 simulation units.
    const pulse = 3 + (Math.sin(pulsePhase * Math.PI * 2) * 0.5 + 0.5) * 4
    ctx.beginPath()
    ctx.arc(x, y, r + pulse, 0, Math.PI * 2)
    ctx.fillStyle = node.color + '33'
    ctx.fill()
  } else if (state === 'highlight') {
    ctx.beginPath()
    ctx.arc(x, y, r + 3, 0, Math.PI * 2)
    ctx.fillStyle = node.color + '40'
    ctx.fill()
  }

  // Body.
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = nodeFill(node, state)
  ctx.fill()

  // Hairline outline — screen-pixel constant, only above a few zooms where
  // it actually reads (below that it's just aliasing). Dimmed nodes skip it
  // so they recede further.
  if (state !== 'dim' && zoom > 0.4) {
    ctx.lineWidth = (state === 'selected' || state === 'highlight' ? 1.5 : 0.8) / zoom
    ctx.strokeStyle = state === 'selected' || state === 'highlight' ? '#ffffff' : '#0e0e10'
    ctx.stroke()
  }
}

/**
 * Draw one edge between two endpoints. Edges are batched per state by the
 * caller (single beginPath/stroke per style is dramatically faster than per
 * edge); this helper covers the per-edge geometry only.
 */
export function addEdgePath(
  ctx: CanvasRenderingContext2D,
  sx: number, sy: number,
  tx: number, ty: number,
): void {
  ctx.moveTo(sx, sy)
  ctx.lineTo(tx, ty)
}

/** Stroke style + width for a batch of edges in a given state and kind. */
export function applyEdgeStyle(
  ctx: CanvasRenderingContext2D,
  state: EdgeState,
  kind: EdgeKind,
  zoom: number,
): void {
  // Width scales as 1/zoom so edges read as ~1 screen pixel at any zoom.
  // Highlighted edges go thicker (~1.6 px) for legibility against the dim
  // background.
  const widthPx = state === 'highlight' ? 1.6 : 1
  ctx.lineWidth = widthPx / zoom

  if (state === 'highlight') {
    ctx.strokeStyle = kind === 'mention' ? 'rgba(190, 190, 255, 0.55)' : 'rgba(255, 255, 255, 0.55)'
    ctx.setLineDash(kind === 'mention' ? [4 / zoom, 3 / zoom] : [])
    return
  }
  if (state === 'dim') {
    ctx.strokeStyle = 'rgba(150,150,170,0.04)'
    ctx.setLineDash([])
    return
  }
  // normal
  if (kind === 'mention') {
    ctx.strokeStyle = 'rgba(180,180,210,0.08)'
    ctx.setLineDash([3 / zoom, 3 / zoom])
  } else {
    ctx.strokeStyle = 'rgba(190,190,210,0.18)'
    ctx.setLineDash([])
  }
}

/**
 * Draw the label for a node. Caller is responsible for skipping when
 * `labelOpacity(zoom)` is 0 — saves the font set + transform on the cold path.
 */
export function drawLabel(
  ctx: CanvasRenderingContext2D,
  node: GraphNode & { x?: number; y?: number },
  zoom: number,
  opacity: number,
  emphasised: boolean,
): void {
  const x = node.x ?? 0
  const y = node.y ?? 0
  const r = nodeRadius(node)
  const fontPx = (emphasised ? 11 : 10) / zoom
  ctx.font = `${fontPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'

  const text = node.title.length > 28 ? node.title.slice(0, 28) + '…' : node.title
  const yPos = y + r + 3 / zoom

  // Soft text shadow for readability over edges. Single offset pass — full
  // shadowBlur is too slow at 10k labels.
  ctx.fillStyle = `rgba(0, 0, 0, ${Math.min(0.85, opacity)})`
  ctx.fillText(text, x + 0.6 / zoom, yPos + 0.6 / zoom)

  ctx.fillStyle = emphasised
    ? `rgba(235, 235, 240, ${opacity})`
    : `rgba(165, 170, 185, ${opacity})`
  ctx.fillText(text, x, yPos)
}
