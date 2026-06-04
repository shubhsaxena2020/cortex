import React, { useEffect, useRef, useCallback, useState } from 'react'
import * as d3 from 'd3'
import { useStore } from '../store'
import { buildGraph, type FilterMode, type GraphNode } from '../utils/graph-builder'

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

const NODE_R = (d: D3Node): number => d.baseR + Math.min(d.connections * 1.5, 8)
const BTN_CLS = 'w-7 h-7 flex items-center justify-center bg-[#1a1a1a]/80 hover:bg-[#252525] border border-[#333] rounded text-[#888] hover:text-[#ccc] transition-colors'

export default function GraphCanvas({
  filter, showAll, watchPath, onNodeSelect, onNodeOpen,
}: GraphCanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { memories, relationships, vaultFiles, selectedMemoryId, selectedFileId } = useStore()

  const [tooltip, setTooltip] = useState<{ x: number; y: number; title: string } | null>(null)
  const [graphInfo, setGraphInfo] = useState<{ shown: number; total: number } | null>(null)

  // Refs for imperative access inside event handlers and draw callbacks
  const drawRef        = useRef<() => void>(() => {})
  const nodesRef       = useRef<D3Node[]>([])
  const linksRef       = useRef<D3Link[]>([])
  const transformRef   = useRef<d3.ZoomTransform>(d3.zoomIdentity)
  const simRef         = useRef<d3.Simulation<D3Node, D3Link> | null>(null)
  const zoomRef        = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null)
  const selectedIdRef  = useRef<string | null>(null)   // node clicked in graph → InfoPanel
  const openIdRef      = useRef<string | null>(null)   // node open in editor (from store)
  const nodePositions  = useRef<Map<string, { x: number; y: number }>>(new Map())

  // Effect 1 — sync editor-open highlight without rebuilding simulation
  useEffect(() => {
    openIdRef.current = selectedMemoryId ?? selectedFileId ?? null
    drawRef.current()
  }, [selectedMemoryId, selectedFileId])

  const handleZoomIn = useCallback(() => {
    const c = canvasRef.current
    if (!c || !zoomRef.current) return
    d3.select(c).transition().duration(250).call(zoomRef.current.scaleBy, 1.5)
  }, [])

  const handleZoomOut = useCallback(() => {
    const c = canvasRef.current
    if (!c || !zoomRef.current) return
    d3.select(c).transition().duration(250).call(zoomRef.current.scaleBy, 1 / 1.5)
  }, [])

  const handleFitScreen = useCallback(() => {
    const c = canvasRef.current
    if (!c || !zoomRef.current) return
    d3.select(c).transition().duration(400).call(zoomRef.current.transform, d3.zoomIdentity)
  }, [])

  // Effect 2 — build D3 simulation and wire canvas event handlers
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const w = canvas.clientWidth || 900
    const h = canvas.clientHeight || 650
    canvas.width  = w
    canvas.height = h

    // Restore zoom state from previous render (same DOM node, D3 stores it on the element)
    const existingT = d3.zoomTransform(canvas)
    if (existingT !== d3.zoomIdentity) transformRef.current = existingT

    const raw = buildGraph(memories, relationships, vaultFiles, filter, watchPath)
    const allNodes = raw.nodes as D3Node[]
    const visNodes = showAll ? allNodes : allNodes.filter(n => n.connections > 0)

    setGraphInfo(visNodes.length < allNodes.length
      ? { shown: visNodes.length, total: allNodes.length }
      : null
    )

    if (visNodes.length === 0) { ctx.clearRect(0, 0, w, h); return }

    // Restore cached positions so layout stays stable across filter changes
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

    // ── Draw ────────────────────────────────────────────────────────────────────
    function draw() {
      const t = transformRef.current

      ctx.clearRect(0, 0, w, h)
      ctx.save()
      ctx.translate(t.x, t.y)
      ctx.scale(t.k, t.k)

      // Viewport bounds in simulation space (+200px screen-pixel buffer)
      const buf = 200 / t.k
      const vL = (-t.x) / t.k - buf
      const vR = (w - t.x) / t.k + buf
      const vT = (-t.y) / t.k - buf
      const vB = (h - t.y) / t.k + buf
      const inView = (n: D3Node) => {
        const x = n.x ?? 0, y = n.y ?? 0
        return x >= vL && x <= vR && y >= vT && y <= vB
      }

      // ── Edges ──────────────────────────────────────────────────────────────
      ctx.lineWidth = 1 / t.k
      for (const link of linksRef.current) {
        const src = link.source as D3Node
        const tgt = link.target as D3Node
        if (!inView(src) && !inView(tgt)) continue
        if (link.edgeType === 'mention') {
          ctx.setLineDash([3 / t.k, 3 / t.k])
          ctx.strokeStyle = 'rgba(80,80,80,0.25)'
        } else {
          ctx.setLineDash([])
          ctx.strokeStyle = 'rgba(80,80,80,0.35)'
        }
        ctx.beginPath()
        ctx.moveTo(src.x ?? 0, src.y ?? 0)
        ctx.lineTo(tgt.x ?? 0, tgt.y ?? 0)
        ctx.stroke()
      }
      ctx.setLineDash([])

      // ── Nodes ──────────────────────────────────────────────────────────────
      const selId  = selectedIdRef.current
      const openId = openIdRef.current

      for (const node of nodesRef.current) {
        if (!inView(node)) continue
        const nx = node.x ?? 0
        const ny = node.y ?? 0
        const r  = NODE_R(node)
        const highlight = node.id === selId || node.id === openId

        // Glow ring
        if (highlight) {
          ctx.beginPath()
          ctx.arc(nx, ny, r + 6, 0, Math.PI * 2)
          ctx.fillStyle = node.color + '40'
          ctx.fill()
        }

        // Fill
        ctx.beginPath()
        ctx.arc(nx, ny, r, 0, Math.PI * 2)
        ctx.fillStyle = node.fromWatch
          ? (highlight ? node.color + 'cc' : node.color + '59')
          : (highlight ? node.color       : node.color + 'cc')
        ctx.fill()

        // Stroke
        ctx.strokeStyle  = highlight ? '#ffffff' : (node.nodeType === 'file' ? node.color : '#1a1a1a')
        ctx.lineWidth    = (highlight ? 2.5 : 1.5) / t.k
        ctx.globalAlpha  = node.nodeType === 'file' ? 0.7 : 1
        if (node.nodeType === 'file') ctx.setLineDash([3 / t.k, 2 / t.k])
        ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = 1

        // Label (always on at zoom > 1.5, or when highlighted)
        if (t.k > 1.5 || highlight) {
          const fontSize = 9 / t.k   // renders as ~9px on screen at any zoom
          ctx.font        = `${fontSize}px system-ui, sans-serif`
          ctx.textAlign   = 'center'
          ctx.fillStyle   = highlight ? '#e8e8e8' : '#666666'
          const label = node.title.length > 22 ? node.title.slice(0, 22) + '…' : node.title
          ctx.fillText(label, nx, ny - r - 5 / t.k)
        }
      }

      ctx.restore()

      // Cache positions for layout continuity
      for (const n of nodesRef.current) {
        if (n.x != null && n.y != null) nodePositions.current.set(n.id, { x: n.x, y: n.y })
      }
    }

    drawRef.current = draw

    // ── Simulation ──────────────────────────────────────────────────────────────
    const sim = d3.forceSimulation<D3Node>(visNodes)
      .force('link',      d3.forceLink<D3Node, D3Link>(visLinks).id(d => d.id).distance(60).strength(0.8))
      .force('charge',    d3.forceManyBody().strength(-200))
      .force('center',    d3.forceCenter(w / 2, h / 2))
      .force('collision', d3.forceCollide<D3Node>(20))
      .force('x',         d3.forceX(w / 2).strength(0.05))
      .force('y',         d3.forceY(h / 2).strength(0.05))
      .velocityDecay(0.4)
      .alphaMin(0.001)
      .on('tick', draw)

    simRef.current = sim

    // ── Zoom ────────────────────────────────────────────────────────────────────
    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.05, 8])
      .filter(event => {
        // Always allow wheel-zoom; only block pointer-drag when cursor is on a node
        if (event instanceof WheelEvent) return true
        if (!(event instanceof MouseEvent)) return true
        const rect = canvas.getBoundingClientRect()
        const [sx, sy] = toSim(event.clientX - rect.left, event.clientY - rect.top)
        return !hitTest(sx, sy)
      })
      .on('zoom', ev => {
        transformRef.current = ev.transform
        if (sim.alpha() < 0.05) sim.alpha(0.1).restart()
        draw()
      })

    zoomRef.current = zoom
    d3.select(canvas).call(zoom).on('dblclick.zoom', null)
    draw()

    // ── Hit detection ───────────────────────────────────────────────────────────
    function toSim(cx: number, cy: number): [number, number] {
      const t = transformRef.current
      return [(cx - t.x) / t.k, (cy - t.y) / t.k]
    }

    function hitTest(sx: number, sy: number): D3Node | null {
      let best: D3Node | null = null, minD = Infinity
      for (const n of nodesRef.current) {
        const d = Math.hypot((n.x ?? 0) - sx, (n.y ?? 0) - sy)
        if (d <= NODE_R(n) + 4 && d < minD) { minD = d; best = n }
      }
      return best
    }

    // ── Mouse event handlers ────────────────────────────────────────────────────
    let mdX = 0, mdY = 0
    let dragNode: D3Node | null = null

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

      // Skip hover detection while panning (any button held, no drag node)
      if (e.buttons > 0) return

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
    }

    canvas.addEventListener('mousedown',  onMouseDown)
    canvas.addEventListener('mousemove',  onMouseMove)
    canvas.addEventListener('mouseup',    onMouseUp)
    canvas.addEventListener('click',      onClick)
    canvas.addEventListener('dblclick',   onDblClick)
    canvas.addEventListener('mouseleave', onMouseLeave)

    return () => {
      sim.stop()
      simRef.current  = null
      drawRef.current = () => {}
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
  }, [memories, relationships, vaultFiles, filter, showAll, watchPath, onNodeSelect, onNodeOpen])

  return (
    <div className="w-full h-full relative">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ display: 'block', background: 'transparent' }}
      />

      {tooltip && (
        <div
          className="absolute pointer-events-none select-none bg-[#111]/90 text-[#ccc] text-xs px-2 py-1 rounded shadow-lg z-20"
          style={{ left: tooltip.x + 12, top: tooltip.y - 24 }}
        >
          {tooltip.title}
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
