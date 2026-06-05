// Obsidian-style canvas knowledge graph.
//
// Architecture:
//   - D3 force simulation owns positions on a tick-driven loop.
//   - Quadtree owns spatial lookup for hit tests + viewport culling (it's
//     never user-visible; nothing is "clustered" or hidden by it).
//   - Drawing is pass-batched: dim/normal/highlight edges, then nodes in the
//     same three tiers, then labels with a smooth zoom-driven fade. No
//     discrete LOD jump.
//   - Hover state highlights the hovered node + its 1-hop neighbours and
//     dims everything else, so the user sees the local subgraph emerge from
//     the background without anything snapping in or out.
//   - Selected node gets a breathing pulse ring driven by a single RAF
//     loop that only runs while there's a selection.
//
// Performance discipline:
//   - All canvas batches share a single style + beginPath() + stroke() call.
//   - Pulse RAF is scoped — no rAF runs when nothing is selected.
//   - Label rendering is gated by labelOpacity() so the cold path never
//     touches the font + text-shadow machinery.

import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import * as d3 from 'd3'
import { useStore } from '../store'
import { buildGraph, type FilterMode, type GraphNode } from '../utils/graph-builder'
import { Quadtree } from '../utils/quadtree'
import {
  drawNode, addEdgePath, applyEdgeStyle, drawLabel,
  labelOpacity, nodeRadius,
  type NodeState, type EdgeState,
} from '../utils/graph-renderer'
import {
  buildAdjacency, getNodeAtPoint, highlightPath, pulsePhase,
  type AdjacencyEntry,
} from '../utils/graph-interaction'

type D3Node = GraphNode & d3.SimulationNodeDatum
interface D3Link extends d3.SimulationLinkDatum<D3Node> {
  edgeType: 'relationship' | 'mention'
}

interface GraphCanvasProps {
  filter: FilterMode
  showAll: boolean
  watchPath?: string | null
  onNodeSelect: (node: GraphNode | null) => void
  onNodeOpen: (node: GraphNode) => void
}

const BTN_CLS = 'w-7 h-7 flex items-center justify-center bg-[#1a1a1a]/80 hover:bg-[#252525] border border-[#333] rounded text-[#888] hover:text-[#ccc] transition-colors'

export default function GraphCanvas({
  filter, showAll, watchPath, onNodeSelect, onNodeOpen,
}: GraphCanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { memories, relationships, vaultFiles, selectedMemoryId, selectedFileId } = useStore()

  const [tooltip, setTooltip] = useState<{ x: number; y: number; title: string } | null>(null)
  const [graphInfo, setGraphInfo] = useState<{ shown: number; total: number } | null>(null)
  const [debug, setDebug] = useState<{ fps: number; visNodes: number; visEdges: number } | null>(null)

  // Debug overlay opt-in via ?debug=graph or localStorage flag.
  const debugEnabled = useMemo(() =>
    typeof window !== 'undefined' &&
    (window.location?.search?.includes('debug=graph') ||
     window.localStorage?.getItem('cortex.debug.graph') === '1'),
  [])

  // Imperative refs (avoid re-rendering the React tree on every frame)
  const drawRef        = useRef<() => void>(() => {})
  const nodesRef       = useRef<D3Node[]>([])
  const linksRef       = useRef<D3Link[]>([])
  const adjacencyRef   = useRef<Map<string, AdjacencyEntry>>(new Map())
  const transformRef   = useRef<d3.ZoomTransform>(d3.zoomIdentity)
  const simRef         = useRef<d3.Simulation<D3Node, D3Link> | null>(null)
  const zoomRef        = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null)
  const hoverIdRef     = useRef<string | null>(null)
  const hoverSetRef    = useRef<Set<string> | null>(null)   // hover + 1-hop neighbours
  const selectedIdRef  = useRef<string | null>(null)
  const openIdRef      = useRef<string | null>(null)
  const nodePositions  = useRef<Map<string, { x: number; y: number }>>(new Map())
  const quadtreeRef    = useRef<Quadtree<D3Node> | null>(null)
  const quadtreeDirty  = useRef(true)
  const pulseRafRef    = useRef<number | null>(null)
  const frameTimesRef  = useRef<number[]>([])
  const lastDebugTickRef = useRef(0)

  // Sync editor-open highlight without rebuilding the simulation.
  useEffect(() => {
    openIdRef.current = selectedMemoryId ?? selectedFileId ?? null
    drawRef.current()
  }, [selectedMemoryId, selectedFileId])

  const handleZoomIn   = useCallback(() => {
    const c = canvasRef.current
    if (!c || !zoomRef.current) return
    d3.select(c).transition().duration(250).call(zoomRef.current.scaleBy, 1.5)
  }, [])
  const handleZoomOut  = useCallback(() => {
    const c = canvasRef.current
    if (!c || !zoomRef.current) return
    d3.select(c).transition().duration(250).call(zoomRef.current.scaleBy, 1 / 1.5)
  }, [])
  const handleFitScreen = useCallback(() => {
    const c = canvasRef.current
    if (!c || !zoomRef.current) return
    d3.select(c).transition().duration(400).call(zoomRef.current.transform, d3.zoomIdentity)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // HiDPI: render to device pixels, layout in CSS pixels. Without this the
    // graph looks soft on retina / 2× scaling.
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const cssW = canvas.clientWidth || 900
    const cssH = canvas.clientHeight || 650
    canvas.width  = Math.floor(cssW * dpr)
    canvas.height = Math.floor(cssH * dpr)
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const w = cssW
    const h = cssH

    // Restore zoom state across re-renders (D3 keeps it on the DOM node).
    const existingT = d3.zoomTransform(canvas)
    if (existingT !== d3.zoomIdentity) transformRef.current = existingT

    const raw = buildGraph(memories, relationships, vaultFiles, filter, watchPath)
    const allNodes = raw.nodes as D3Node[]
    const visNodes = showAll ? allNodes : allNodes.filter(n => n.connections > 0)
    setGraphInfo(visNodes.length < allNodes.length
      ? { shown: visNodes.length, total: allNodes.length }
      : null)
    if (visNodes.length === 0) {
      ctx.clearRect(0, 0, w, h)
      return
    }
    // Restore cached positions across filter changes for layout continuity.
    for (const n of visNodes) {
      const p = nodePositions.current.get(n.id)
      if (p) { n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0 }
    }

    const nodeById = new Map(visNodes.map(n => [n.id, n]))
    const visLinks = (raw.links as D3Link[]).filter(l => {
      const s = typeof l.source === 'string' ? l.source : (l.source as D3Node).id
      const t = typeof l.target === 'string' ? l.target : (l.target as D3Node).id
      return nodeById.has(s) && nodeById.has(t)
    })

    nodesRef.current = visNodes
    linksRef.current = visLinks
    adjacencyRef.current = buildAdjacency(visNodes, visLinks)
    quadtreeDirty.current = true

    // ── Draw ────────────────────────────────────────────────────────────────
    function draw() {
      const t = transformRef.current
      const frameStart = performance.now()

      // Background — solid near-black gives edges room to breathe. Use
      // a fillRect rather than clearRect so the canvas isn't transparent
      // (lets any glow underdraw blend correctly against it).
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#0c0c10'
      ctx.fillRect(0, 0, w, h)

      ctx.save()
      ctx.translate(t.x, t.y)
      ctx.scale(t.k, t.k)

      // Viewport bounds in simulation space (+128 px screen-pixel buffer to
      // hide pop-in during pan).
      const buf = 128 / t.k
      const vL = (-t.x) / t.k - buf
      const vR = (w - t.x) / t.k + buf
      const vT = (-t.y) / t.k - buf
      const vB = (h - t.y) / t.k + buf

      // Refresh spatial index when the sim marked it dirty. On a settled
      // graph the same tree is reused across many pan/zoom frames.
      if (quadtreeDirty.current || quadtreeRef.current == null) {
        quadtreeRef.current = Quadtree.build(nodesRef.current, 128)
        quadtreeDirty.current = false
      }
      const visibleNodes = quadtreeRef.current.query({ minX: vL, minY: vT, maxX: vR, maxY: vB })
      const visibleSet = new Set<string>()
      for (const n of visibleNodes) visibleSet.add(n.id)

      const hoverSet = hoverSetRef.current
      const hoverActive = hoverSet !== null && hoverSet.size > 0
      const selectedId = selectedIdRef.current
      const openId = openIdRef.current
      const labelAlpha = labelOpacity(t.k)

      // State classifier — kept inline + branchless so the hot loops don't
      // call back into helpers per node/edge.
      function nodeStateOf(id: string): NodeState {
        if (id === selectedId || id === openId) return 'selected'
        if (hoverActive) return hoverSet!.has(id) ? 'highlight' : 'dim'
        return 'normal'
      }
      function edgeStateOf(srcId: string, tgtId: string): EdgeState {
        if (!hoverActive) return 'normal'
        return hoverSet!.has(srcId) && hoverSet!.has(tgtId) ? 'highlight' : 'dim'
      }

      // ── Edges ────────────────────────────────────────────────────────────
      // Bucket pass: collect per (state × kind) line segments, then issue
      // one beginPath/stroke per bucket. 4 buckets max (dim/normal/highlight ×
      // mention/relationship). Highlight bucket renders last so it sits on top.
      type Bucket = Array<[number, number, number, number]>
      const buckets: Record<EdgeState, Record<'relationship' | 'mention', Bucket>> = {
        normal:    { relationship: [], mention: [] },
        dim:       { relationship: [], mention: [] },
        highlight: { relationship: [], mention: [] },
      }
      let edgesDrawn = 0
      for (const link of linksRef.current) {
        const src = link.source as D3Node
        const tgt = link.target as D3Node
        // Cull edges with neither endpoint visible.
        if (!visibleSet.has(src.id) && !visibleSet.has(tgt.id)) continue
        const state = edgeStateOf(src.id, tgt.id)
        buckets[state][link.edgeType].push([src.x ?? 0, src.y ?? 0, tgt.x ?? 0, tgt.y ?? 0])
        edgesDrawn++
      }
      // Order matters: dim first (sinks behind), normal next, highlight on top.
      const order: EdgeState[] = ['dim', 'normal', 'highlight']
      for (const state of order) {
        for (const kind of ['relationship', 'mention'] as const) {
          const segs = buckets[state][kind]
          if (segs.length === 0) continue
          applyEdgeStyle(ctx, state, kind, t.k)
          ctx.beginPath()
          for (let i = 0; i < segs.length; i++) {
            const s = segs[i]
            addEdgePath(ctx, s[0], s[1], s[2], s[3])
          }
          ctx.stroke()
        }
      }
      ctx.setLineDash([])

      // ── Nodes ────────────────────────────────────────────────────────────
      // Two-tier draw: dim first (background layer), then everything else.
      // Selected/highlight nodes have extra geometry (rings) so they're
      // drawn last individually.
      let nodesDrawn = 0
      const phase = selectedId ? pulsePhase(frameStart) : 0
      const emphasised: D3Node[] = []
      for (const node of visibleNodes) {
        const state = nodeStateOf(node.id)
        if (state === 'dim') {
          drawNode(ctx, node, 'dim', t.k)
          nodesDrawn++
        } else if (state === 'normal') {
          drawNode(ctx, node, 'normal', t.k)
          nodesDrawn++
        } else {
          // selected + highlight come last so glow rings overlap correctly.
          emphasised.push(node)
        }
      }
      for (const node of emphasised) {
        const state = nodeStateOf(node.id)
        drawNode(ctx, node, state, t.k, phase)
        nodesDrawn++
      }

      // ── Labels ───────────────────────────────────────────────────────────
      // Skip the whole pass when fully faded out (the common low-zoom case).
      // Always render labels for emphasised nodes regardless of zoom — they
      // matter to the user even when the rest are hidden.
      if (labelAlpha > 0.02) {
        for (const node of visibleNodes) {
          const state = nodeStateOf(node.id)
          if (state === 'dim') continue
          drawLabel(ctx, node, t.k, labelAlpha, false)
        }
      }
      for (const node of emphasised) {
        // Emphasised label always at full strength, even at zoom 0.05.
        drawLabel(ctx, node, t.k, 1, true)
      }

      ctx.restore()

      // Cache positions for layout continuity across filter changes.
      for (const n of nodesRef.current) {
        if (n.x != null && n.y != null) nodePositions.current.set(n.id, { x: n.x, y: n.y })
      }

      // FPS sampling — rolling 60-frame window; throttle overlay updates.
      if (debugEnabled) {
        const ft = frameTimesRef.current
        ft.push(frameStart)
        if (ft.length > 60) ft.shift()
        const span = ft.length > 1 ? ft[ft.length - 1] - ft[0] : 0
        const fps = span > 0 ? Math.round(((ft.length - 1) / span) * 1000) : 0
        if (frameStart - lastDebugTickRef.current > 200) {
          lastDebugTickRef.current = frameStart
          setDebug({ fps, visNodes: nodesDrawn, visEdges: edgesDrawn })
        }
      }
    }
    drawRef.current = draw

    // ── Pulse RAF loop (active only while a node is selected) ───────────────
    function pulseTick() {
      pulseRafRef.current = null
      if (selectedIdRef.current == null) return
      drawRef.current()
      pulseRafRef.current = requestAnimationFrame(pulseTick)
    }
    function ensurePulseLoop() {
      if (selectedIdRef.current != null && pulseRafRef.current == null) {
        pulseRafRef.current = requestAnimationFrame(pulseTick)
      }
    }

    // ── Force simulation ───────────────────────────────────────────────────
    const sim = d3.forceSimulation<D3Node>(visNodes)
      .force('link',      d3.forceLink<D3Node, D3Link>(visLinks).id(d => d.id).distance(50).strength(0.7))
      .force('charge',    d3.forceManyBody().strength(-180))
      .force('center',    d3.forceCenter(w / 2, h / 2))
      .force('collision', d3.forceCollide<D3Node>(d => nodeRadius(d) + 3))
      .force('x',         d3.forceX(w / 2).strength(0.04))
      .force('y',         d3.forceY(h / 2).strength(0.04))
      .velocityDecay(0.4)
      .alphaMin(0.001)
      .on('tick', () => {
        quadtreeDirty.current = true
        draw()
      })
    simRef.current = sim

    // ── Zoom + pan ─────────────────────────────────────────────────────────
    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.05, 8])
      .filter(event => {
        if (event instanceof WheelEvent) return true
        if (!(event instanceof MouseEvent)) return true
        const rect = canvas.getBoundingClientRect()
        const [sx, sy] = toSim(event.clientX - rect.left, event.clientY - rect.top)
        return !hitTest(sx, sy)
      })
      .on('zoom', ev => {
        transformRef.current = ev.transform
        // Reheat the sim slightly on big zoom changes so the layout responds
        // to the new visible viewport — same heuristic as the previous build.
        if (sim.alpha() < 0.05) sim.alpha(0.1).restart()
        draw()
      })
    zoomRef.current = zoom
    d3.select(canvas).call(zoom).on('dblclick.zoom', null)
    draw()

    // ── Hit detection ──────────────────────────────────────────────────────
    function toSim(cx: number, cy: number): [number, number] {
      const t = transformRef.current
      return [(cx - t.x) / t.k, (cy - t.y) / t.k]
    }
    function hitTest(sx: number, sy: number): D3Node | null {
      return getNodeAtPoint(sx, sy, quadtreeRef.current, nodesRef.current, 4, transformRef.current.k)
    }

    // ── Mouse handlers ─────────────────────────────────────────────────────
    let mdX = 0, mdY = 0
    let dragNode: D3Node | null = null

    function setHover(node: D3Node | null) {
      const newId = node?.id ?? null
      if (newId === hoverIdRef.current) return
      hoverIdRef.current = newId
      if (newId == null) {
        hoverSetRef.current = null
      } else {
        hoverSetRef.current = highlightPath(newId, 1, adjacencyRef.current)
      }
      draw()
    }

    const onMouseDown = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      mdX = e.clientX - rect.left
      mdY = e.clientY - rect.top
      const [sx, sy] = toSim(mdX, mdY)
      dragNode = hitTest(sx, sy)
      if (dragNode) {
        dragNode.fx = dragNode.x
        dragNode.fy = dragNode.y
        sim.alphaTarget(0.3).restart()
      }
    }

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const [sx, sy] = toSim(cx, cy)

      if (dragNode) {
        dragNode.fx = sx
        dragNode.fy = sy
        return
      }
      if (e.buttons > 0) {
        // Panning — clear hover so it doesn't drag behind the cursor.
        if (hoverIdRef.current) setHover(null)
        return
      }

      const found = hitTest(sx, sy)
      if (found) {
        canvas.style.cursor = 'pointer'
        const t = transformRef.current
        setTooltip({
          x: (found.x ?? 0) * t.k + t.x,
          y: (found.y ?? 0) * t.k + t.y,
          title: found.title,
        })
      } else {
        canvas.style.cursor = ''
        setTooltip(null)
      }
      setHover(found)
    }

    const onMouseUp = () => {
      if (dragNode) {
        dragNode.fx = null
        dragNode.fy = null
        sim.alphaTarget(0)
        dragNode = null
      }
    }

    const onClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      if (Math.hypot(cx - mdX, cy - mdY) > 8) return  // was a drag
      const [sx, sy] = toSim(cx, cy)
      const found = hitTest(sx, sy)
      selectedIdRef.current = found?.id ?? null
      onNodeSelect(found)
      if (found) ensurePulseLoop()
      draw()
    }

    const onDblClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const [sx, sy] = toSim(cx, cy)
      const found = hitTest(sx, sy)
      if (found) onNodeOpen(found)
    }

    const onMouseLeave = () => {
      setTooltip(null)
      canvas.style.cursor = ''
      if (hoverIdRef.current) setHover(null)
    }

    canvas.addEventListener('mousedown',  onMouseDown)
    canvas.addEventListener('mousemove',  onMouseMove)
    canvas.addEventListener('mouseup',    onMouseUp)
    canvas.addEventListener('click',      onClick)
    canvas.addEventListener('dblclick',   onDblClick)
    canvas.addEventListener('mouseleave', onMouseLeave)

    return () => {
      sim.stop()
      simRef.current = null
      drawRef.current = () => {}
      if (pulseRafRef.current != null) {
        cancelAnimationFrame(pulseRafRef.current)
        pulseRafRef.current = null
      }
      canvas.removeEventListener('mousedown',  onMouseDown)
      canvas.removeEventListener('mousemove',  onMouseMove)
      canvas.removeEventListener('mouseup',    onMouseUp)
      canvas.removeEventListener('click',      onClick)
      canvas.removeEventListener('dblclick',   onDblClick)
      canvas.removeEventListener('mouseleave', onMouseLeave)
      d3.select(canvas).on('.zoom', null)
      canvas.style.cursor = ''
      setTooltip(null)
    }
  }, [memories, relationships, vaultFiles, filter, showAll, watchPath, onNodeSelect, onNodeOpen, debugEnabled])

  return (
    <div className="w-full h-full relative">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ display: 'block', background: '#0c0c10' }}
      />

      {tooltip && (
        <div
          className="absolute pointer-events-none select-none bg-[#111]/90 text-[#ccc] text-xs px-2 py-1 rounded shadow-lg z-20"
          style={{ left: tooltip.x + 12, top: tooltip.y - 24 }}
        >
          {tooltip.title}
        </div>
      )}

      {debug && (
        <div className="absolute top-2 left-2 bg-[#1a1a1a]/90 text-[#ccc] text-xs px-3 py-2 rounded font-mono pointer-events-none select-none">
          <div>fps: <span className={debug.fps >= 55 ? 'text-green-400' : debug.fps >= 30 ? 'text-yellow-400' : 'text-red-400'}>{debug.fps}</span></div>
          <div>nodes: {debug.visNodes} / {nodesRef.current.length}</div>
          <div>edges: {debug.visEdges} / {linksRef.current.length}</div>
        </div>
      )}

      {graphInfo && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-[#1a1a1a]/80 text-[#888] text-xs px-3 py-1 rounded-full pointer-events-none select-none">
          Showing {graphInfo.shown} connected of {graphInfo.total} nodes
        </div>
      )}

      <div className="absolute bottom-12 right-4 flex flex-col gap-1">
        <button onClick={handleZoomIn}   className={`${BTN_CLS} text-sm`} title="Zoom in">+</button>
        <button onClick={handleZoomOut}  className={`${BTN_CLS} text-sm`} title="Zoom out">−</button>
        <button onClick={handleFitScreen}className={`${BTN_CLS} text-xs`} title="Fit to screen">⊙</button>
      </div>
    </div>
  )
}
