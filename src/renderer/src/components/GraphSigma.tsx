// Sigma.js + Graphology + ForceAtlas2 renderer.
//
// Replaces the Canvas2D + d3-force pipeline. WebGL pushes the per-frame draw
// cost from the main thread onto the GPU; ForceAtlas2 runs in its own
// Web Worker (graphology-layout-forceatlas2/worker) so the layout never
// blocks paint.
//
// What we preserve from the old GraphCanvas:
//   - Edge colors per signal type (tag blue / keyword yellow / cosine purple
//     / wiki emerald)
//   - Node size = clamp(sqrt(connections)*3, 4, 20)
//   - Hover tooltip (memory title + connection count)
//   - Click to select, double-click to open, drag to move
//   - Focus mode (dim non-neighbours when a node is hovered or selected)
//   - Zoom / pan controls
//   - Label LOD — Sigma's labelRenderedSizeThreshold handles this natively
//   - The __cortexGraphDebug window handle the CDP profiler reads
//
// What we drop (intentionally):
//   - The quadtree, the lod.ts cluster machinery, the canvas bucket pass,
//     the Float32Array position protocol. Sigma owns spatial culling and
//     batching internally.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { SigmaContainer, useSigma, useRegisterEvents, useLoadGraph } from '@react-sigma/core'
import '@react-sigma/core/lib/style.css'
import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'
import FA2Layout from 'graphology-layout-forceatlas2/worker'
import { useStore } from '../store'
import { buildGraph, type FilterMode, type GraphNode, type GraphLink } from '../utils/graph-builder'
import { edgeColor, nodeSize, initialPosition } from '../utils/graph-styling'

const BTN_CLS = 'w-7 h-7 flex items-center justify-center bg-[#1a1a1a]/80 hover:bg-[#252525] border border-[#333] rounded text-[#888] hover:text-[#ccc] transition-colors'

interface GraphSigmaProps {
  filter: FilterMode
  showAll: boolean
  watchPath?: string | null
  onNodeSelect: (node: GraphNode | null) => void
  onNodeOpen: (node: GraphNode) => void
}

// Settings tuned for our dark background. These are read once by Sigma at
// mount; per-frame styling overrides happen via the node/edge reducers.
const SIGMA_SETTINGS = {
  // Label LOD: Sigma renders labels only when the node's drawn pixel size is
  // above this threshold. Far zoom → small nodes → no labels. Matches the
  // behaviour the Canvas2D version emulated with labelOpacity().
  labelRenderedSizeThreshold: 8,
  labelDensity: 0.07,
  labelGridCellSize: 60,
  labelFont: 'system-ui, -apple-system, sans-serif',
  labelSize: 11,
  labelWeight: '500',
  labelColor: { color: '#888' },
  defaultNodeColor: '#6B9FD4',
  defaultEdgeColor: '#666',
  // Render edges below nodes (default), and let the GPU do its thing.
  zIndex: false,
  // Hovered node highlight — Sigma draws a halo automatically.
  defaultNodeHoverColor: '#fff',
  // Hide edges + labels during interaction. Each node x/y change triggers
  // Sigma to re-upload its geometry buffer — for a 28k-edge graph that's
  // tens of ms per frame. Hiding edges during the move drops per-frame
  // WebGL work to nodes only; they reappear on release.
  hideEdgesOnMove: true,
  hideLabelsOnMove: true,
  renderEdgeLabels: false,
  minCameraRatio: 0.05,
  maxCameraRatio: 12,
} as const

// ─── Outer component: owns store subscription + tooltip state ───────────────
export default function GraphSigma(props: GraphSigmaProps): React.ReactElement {
  const { memories, relationships, vaultFiles, mentionEdges } = useStore()
  const [graphInfo, setGraphInfo] = useState<{ shown: number; total: number } | null>(null)
  const [tooltip, setTooltip] = useState<{ x: number; y: number; title: string; sub: string } | null>(null)

  // Build a Graphology graph from the store. This is pure data; Sigma reads
  // it via useLoadGraph in the inner controller.
  const { graph, count } = useMemo(() => buildGraphologyGraph(
    memories, relationships, vaultFiles, mentionEdges, props.filter, props.showAll, props.watchPath,
  ), [memories, relationships, vaultFiles, mentionEdges, props.filter, props.showAll, props.watchPath])

  useEffect(() => {
    setGraphInfo(count.shown < count.total ? { shown: count.shown, total: count.total } : null)
  }, [count.shown, count.total])

  if (count.shown === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#0D0D0D]">
        <div className="text-center text-[#444]">
          <div className="text-5xl mb-3">◇</div>
          <p className="text-sm">No nodes to show.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full h-full relative">
      <SigmaContainer
        settings={SIGMA_SETTINGS}
        style={{ width: '100%', height: '100%', background: '#0D0D0D' }}
      >
        <GraphSigmaController
          graph={graph}
          onNodeSelect={props.onNodeSelect}
          onNodeOpen={props.onNodeOpen}
          onTooltipChange={setTooltip}
        />
        <ZoomControls />
      </SigmaContainer>

      {tooltip && (
        <div
          className="absolute pointer-events-none select-none bg-[#0F1428]/90 text-xs px-3 py-2 rounded shadow-lg z-20"
          style={{ left: tooltip.x + 12, top: tooltip.y - 24, border: '1px solid rgba(148,163,184,0.2)' }}
        >
          <div className="text-[#E2E8F0] font-medium">{tooltip.title}</div>
          <div className="text-[#94A3B8] text-[9px] mt-0.5">{tooltip.sub}</div>
        </div>
      )}

      {graphInfo && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-[#1a1a1a]/80 text-[#888] text-xs px-3 py-1 rounded-full pointer-events-none select-none">
          Showing {graphInfo.shown} connected of {graphInfo.total} nodes
        </div>
      )}
    </div>
  )
}

// ─── Inner controller: hooks into the Sigma instance ─────────────────────────
//
// Split from the outer component so we can use useSigma/useRegisterEvents,
// which require being inside the SigmaContainer's React context.

function GraphSigmaController({ graph, onNodeSelect, onNodeOpen, onTooltipChange }: {
  graph: Graph
  onNodeSelect: (node: GraphNode | null) => void
  onNodeOpen: (node: GraphNode) => void
  onTooltipChange: (t: { x: number; y: number; title: string; sub: string } | null) => void
}): null {
  const sigma = useSigma()
  const loadGraph = useLoadGraph()
  const registerEvents = useRegisterEvents()

  const fa2Ref = useRef<FA2Layout | null>(null)
  const draggedNodeRef = useRef<string | null>(null)
  const hoveredNodeRef = useRef<string | null>(null)
  const selectedNodeRef = useRef<string | null>(null)
  const neighboursRef = useRef<Set<string>>(new Set())

  // Load the graph + start ForceAtlas2 in its worker. New graph identity
  // means a new dataset shape — tear down the old layout and start fresh.
  useEffect(() => {
    loadGraph(graph)

    // Stop any prior layout — useLoadGraph replaces the underlying graph
    // but FA2Layout holds a reference to the previous one.
    fa2Ref.current?.kill()
    fa2Ref.current = null

    if (graph.order === 0) return

    const sensible = forceAtlas2.inferSettings(graph)
    const layout = new FA2Layout(graph, {
      settings: { ...sensible, scalingRatio: 8, gravity: 1, slowDown: 4 },
      weighted: true,
    })
    fa2Ref.current = layout
    layout.start()

    // FA2 is one-shot: kill the worker entirely after a short burst. A
    // running FA2 worker streams 30+ position postMessages per second to
    // the main thread; at 10k nodes each handler is multi-ms, saturating
    // the main thread and starving rAF (confirmed by CDP trace: 151
    // HandlePostMessage events totalling 3.2 s of work over a 5 s drag).
    // Profile target: with FA2 killed before drag, the only main-thread
    // work during drag is Sigma's per-attribute-update redraw.
    const killTimer = window.setTimeout(() => {
      layout.kill()
      fa2Ref.current = null
    }, 1200)

    // Camera fit after the first physics tick lands so the layout extent
    // is non-zero. setTimeout is fine here; we just need a deferred frame.
    const fitTimer = window.setTimeout(() => {
      try { (sigma.getCamera() as { animatedReset?: (o: { duration: number }) => void }).animatedReset?.({ duration: 400 }) } catch { /* sigma not ready */ }
    }, 1400)

    // Dev-only profiling handle — kept identical in shape to the Canvas2D
    // renderer's so existing CDP scripts keep working. Sigma owns its own
    // draw loop; we hook beforeRender/afterRender to surface per-frame
    // timing in the same `__cortexDrawStats` global the v0.3 profiler reads.
    let drawStart = 0
    let drawCount = 0
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__cortexGraphDebug = {
        nodeCount: () => graph.order,
        linkCount: () => graph.size,
        positions: () => {
          const out: Array<{ x: number; y: number; id: string }> = []
          let i = 0
          graph.forEachNode((id, attrs) => {
            if (i++ < 2000) out.push({ x: attrs.x ?? 0, y: attrs.y ?? 0, id })
          })
          return out
        },
        transform: () => sigma.getCamera().getState(),
        dims: { w: sigma.getDimensions().width, h: sigma.getDimensions().height },
        renderer: 'sigma-webgl',
        // Helpers for CDP profilers: convert graph coords to viewport
        // (canvas-relative) pixel coords, and pick a node visible in the
        // current viewport to drag for synthetic drag tests.
        graphToViewport: (x: number, y: number) => sigma.graphToViewport({ x, y }),
        pickCenterNode: () => {
          const dims = sigma.getDimensions()
          const cx = dims.width / 2, cy = dims.height / 2
          let bestId = ''
          let bestD = Infinity
          let bestX = 0, bestY = 0
          graph.forEachNode((id, attrs) => {
            const vp = sigma.graphToViewport({ x: attrs.x ?? 0, y: attrs.y ?? 0 })
            const d = Math.hypot(vp.x - cx, vp.y - cy)
            if (d < bestD) { bestD = d; bestId = id; bestX = vp.x; bestY = vp.y }
          })
          return bestId ? { id: bestId, vpX: bestX, vpY: bestY } : null
        },
      }
      const onBefore = () => { drawStart = performance.now() }
      const onAfter = () => {
        drawCount++
        ;(window as unknown as Record<string, unknown>).__cortexDrawStats = {
          frameMs: Math.round((performance.now() - drawStart) * 100) / 100,
          frame: drawCount,
          renderer: 'sigma-webgl',
          k: sigma.getCamera().getState().ratio,
        }
      }
      sigma.on('beforeRender', onBefore)
      sigma.on('afterRender', onAfter)
    }

    return () => {
      window.clearTimeout(killTimer)
      window.clearTimeout(fitTimer)
      try { layout.kill() } catch { /* already killed */ }
      fa2Ref.current = null
    }
  }, [graph, sigma, loadGraph])

  // Per-frame styling overrides. nodeReducer / edgeReducer fire on every
  // Sigma render and let us dim non-neighbour nodes for focus mode without
  // mutating the underlying graph data.
  useEffect(() => {
    sigma.setSetting('nodeReducer', (node, data) => {
      const focused = selectedNodeRef.current ?? hoveredNodeRef.current
      if (!focused) return data
      if (node === focused) {
        return { ...data, zIndex: 2, highlighted: true }
      }
      if (neighboursRef.current.has(node)) {
        return { ...data, zIndex: 1, highlighted: true }
      }
      return { ...data, color: '#222', label: '', zIndex: 0 }
    })
    sigma.setSetting('edgeReducer', (edge, data) => {
      const focused = selectedNodeRef.current ?? hoveredNodeRef.current
      if (!focused) return data
      const g = sigma.getGraph()
      const [a, b] = g.extremities(edge)
      const incident = a === focused || b === focused
      if (incident) return { ...data, zIndex: 1 }
      return { ...data, color: 'rgba(80,80,90,0.08)', zIndex: 0 }
    })
  }, [sigma])

  // Reusable: refresh neighbours when focus changes, then ask Sigma to redraw.
  const refreshFocus = useCallback((nodeId: string | null) => {
    if (!nodeId) {
      neighboursRef.current = new Set()
    } else {
      const g = sigma.getGraph()
      const set = new Set<string>([nodeId])
      try {
        g.forEachNeighbor(nodeId, (n) => set.add(n))
      } catch { /* node may have been removed mid-event */ }
      neighboursRef.current = set
    }
    sigma.refresh()
  }, [sigma])

  // All mouse events. Drag is handled directly here — on `downNode` we stop
  // FA2 and disable the camera (so panning doesn't fight drag); on
  // `mousemovebody` we update the node's x/y in graph space; on `mouseup`
  // we re-enable everything.
  useEffect(() => {
    registerEvents({
      enterNode: (e) => {
        if (draggedNodeRef.current) return
        const g = sigma.getGraph()
        const attrs = g.getNodeAttributes(e.node) as { rawNode?: GraphNode; connections?: number; source?: string; label: string }
        hoveredNodeRef.current = e.node
        refreshFocus(selectedNodeRef.current ?? e.node)
        // Position the tooltip near the cursor.
        const { x, y } = sigma.graphToViewport({
          x: g.getNodeAttribute(e.node, 'x') as number,
          y: g.getNodeAttribute(e.node, 'y') as number,
        })
        const src = attrs.source ?? attrs.rawNode?.source ?? ''
        const degree = attrs.connections ?? attrs.rawNode?.connections ?? 0
        onTooltipChange({
          x, y,
          title: attrs.label,
          sub: degree > 0 ? `${src} · ${degree} connections` : src,
        })
      },
      leaveNode: () => {
        if (draggedNodeRef.current) return
        hoveredNodeRef.current = null
        onTooltipChange(null)
        refreshFocus(selectedNodeRef.current)
      },
      downNode: (e) => {
        draggedNodeRef.current = e.node
        sigma.getGraph().setNodeAttribute(e.node, 'highlighted', true)
        sigma.getCamera().disable()
        // Hard-kill any lingering layout worker so position postMessages
        // can't compete with the drag's per-frame node-attribute updates.
        try { fa2Ref.current?.kill() } catch { /* already killed */ }
        fa2Ref.current = null
      },
      mousemovebody: (e) => {
        const node = draggedNodeRef.current
        if (!node) return
        const pos = sigma.viewportToGraph(e)
        // One graph mutation (mergeNodeAttributes) instead of two
        // (setNodeAttribute × 2) — halves the change-event count Sigma's
        // render scheduler reacts to.
        sigma.getGraph().mergeNodeAttributes(node, { x: pos.x, y: pos.y })
        // Preventing both default and stop propagation keeps Sigma's own
        // camera-pan logic from also running on this move.
        e.preventSigmaDefault()
        e.original.preventDefault()
        e.original.stopPropagation()
      },
      mouseup: () => {
        if (draggedNodeRef.current) {
          sigma.getGraph().removeNodeAttribute(draggedNodeRef.current, 'highlighted')
          draggedNodeRef.current = null
          sigma.getCamera().enable()
        }
      },
      mousedown: () => {
        // If we were stale from a previous component (no node hit), still
        // keep camera enabled.
        if (!draggedNodeRef.current) sigma.getCamera().enable()
      },
      clickNode: (e) => {
        const g = sigma.getGraph()
        const raw = g.getNodeAttribute(e.node, 'rawNode') as GraphNode | undefined
        selectedNodeRef.current = e.node
        refreshFocus(e.node)
        if (raw) onNodeSelect(raw)
      },
      doubleClickNode: (e) => {
        const g = sigma.getGraph()
        const raw = g.getNodeAttribute(e.node, 'rawNode') as GraphNode | undefined
        if (raw) onNodeOpen(raw)
      },
      clickStage: () => {
        selectedNodeRef.current = null
        refreshFocus(null)
        onNodeSelect(null)
      },
    })
  }, [sigma, registerEvents, refreshFocus, onNodeSelect, onNodeOpen, onTooltipChange])

  // Render the in-canvas controls via a tiny portal-like overlay — we keep
  // them inside the controller so they have access to the sigma instance.
  return null
}

// ─── Zoom / fit controls. Lives inside SigmaContainer so it has the camera. ─
function ZoomControls(): React.ReactElement {
  const sigma = useSigma()
  const camera = sigma.getCamera()
  const handleZoomIn = useCallback(() => { (camera as unknown as { animatedZoom: (o: { duration: number }) => void }).animatedZoom({ duration: 250 }) }, [camera])
  const handleZoomOut = useCallback(() => { (camera as unknown as { animatedUnzoom: (o: { duration: number }) => void }).animatedUnzoom({ duration: 250 }) }, [camera])
  const handleFit = useCallback(() => { (camera as unknown as { animatedReset: (o: { duration: number }) => void }).animatedReset({ duration: 400 }) }, [camera])
  return (
    <div className="absolute bottom-12 right-4 flex flex-col gap-1 z-10">
      <button onClick={handleZoomIn}  className={`${BTN_CLS} text-sm`} title="Zoom in">+</button>
      <button onClick={handleZoomOut} className={`${BTN_CLS} text-sm`} title="Zoom out">−</button>
      <button onClick={handleFit}     className={`${BTN_CLS} text-xs`} title="Fit to screen">⊙</button>
    </div>
  )
}

// ─── Pure: build the Graphology graph from our internal data ────────────────
//
// Extracted so it can be tested against a known buildGraph output without
// instantiating Sigma. Sigma never sees the original GraphLink/GraphNode
// types directly — the raw node is stashed as an attribute so click handlers
// can ship it back to React state.

function buildGraphologyGraph(
  memories: Parameters<typeof buildGraph>[0],
  relationships: Parameters<typeof buildGraph>[1],
  vaultFiles: Parameters<typeof buildGraph>[2],
  mentionEdges: Parameters<typeof buildGraph>[5],
  filter: FilterMode,
  showAll: boolean,
  watchPath: string | null | undefined,
): { graph: Graph; count: { shown: number; total: number } } {
  const raw = buildGraph(memories, relationships, vaultFiles, filter, watchPath, mentionEdges)
  const visNodes = showAll ? raw.nodes : raw.nodes.filter((n) => n.connections > 0)
  const visIds = new Set(visNodes.map((n) => n.id))

  const g = new Graph({ multi: false, type: 'undirected', allowSelfLoops: false })
  visNodes.forEach((n, i) => {
    const pos = initialPosition(i, visNodes.length)
    g.addNode(n.id, {
      label: n.title.length > 60 ? n.title.slice(0, 60) + '…' : n.title,
      x: pos.x,
      y: pos.y,
      size: nodeSize(n.connections),
      color: n.color,
      nodeType: n.nodeType,
      source: n.source,
      connections: n.connections,
      rawNode: n,
    })
  })

  for (const link of raw.links as GraphLink[]) {
    const sId = typeof link.source === 'string' ? link.source : (link.source as { id: string }).id
    const tId = typeof link.target === 'string' ? link.target : (link.target as { id: string }).id
    if (!visIds.has(sId) || !visIds.has(tId)) continue
    if (sId === tId) continue
    // multi: false — duplicates silently rejected.
    try {
      g.addUndirectedEdge(sId, tId, {
        color: edgeColor(link),
        size: Math.max(0.5, Math.min(2.5, (link.strength ?? 0.5) * 1.6 + 0.3)),
        signalType: link.signalType,
        edgeType: link.edgeType,
        strength: link.strength ?? 0.5,
      })
    } catch {
      // edge already exists
    }
  }

  return { graph: g, count: { shown: g.order, total: raw.nodes.length } }
}
