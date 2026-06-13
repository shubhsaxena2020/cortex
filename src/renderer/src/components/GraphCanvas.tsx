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
import { getDetailLevel, clusterNodes } from '../utils/lod'
import {
  drawNode, addEdgePath, applyEdgeStyle,
  type NodeState, type EdgeState,
} from '../utils/graph-renderer'
import {
  buildAdjacency, getNodeAtPoint, highlightPath, pulsePhase,
  type AdjacencyEntry,
} from '../utils/graph-interaction'
import { edgeColor } from '../utils/graph-builder'

type D3Node = GraphNode & d3.SimulationNodeDatum
interface D3Link extends d3.SimulationLinkDatum<D3Node> {
  edgeType: 'relationship' | 'mention'
  signalType?: 'auto:tag' | 'auto:keyword' | 'auto:embedding' | 'manual' | 'wiki'
  strength?: number
}

interface GraphCanvasProps {
  filter: FilterMode
  showAll: boolean
  watchPath?: string | null
  onNodeSelect: (node: GraphNode | null) => void
  onNodeOpen: (node: GraphNode) => void
}

const BTN_CLS = 'w-7 h-7 flex items-center justify-center bg-[#1a1a1a]/80 hover:bg-[#252525] border border-[#333] rounded text-[#888] hover:text-[#ccc] transition-colors'

// Above this many visible nodes the frame switches to flat-fill node
// rendering (no gradient / shadowBlur / rings) — the rich style costs ~40µs
// per node, which is invisible at 300 nodes and 200ms+ at 5k.
const FAST_DRAW_THRESHOLD = 1500

// Dev-only staleness sentinel: lets CDP harnesses confirm which revision of
// this module the renderer actually loaded (HMR/orphaned-vite mixups cost a
// debugging hour during the 100k overhaul).
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__cortexGraphRev = 'overhaul-v3'
}
// Above this many visible nodes the frame clusters regardless of zoom level —
// a fit-to-bounds view of 100k nodes can sit in the 'medium' zoom band while
// tens of thousands of nodes are on screen. Sized by the EDGE bill, not the
// node bill: ~5k visible nodes on a dense graph drag in ~40k edge segments
// (measured 168ms/frame), so the cutover happens well before that.
const DENSITY_FAR_THRESHOLD = 2500
// While the simulation streams, positions (and the quadtree version) change
// every batch; rebuilding the far scene cache each time costs O(nodes+links).
// A stale cluster scene is visually fine for a settling layout — rebuild at
// most this often. Zoom-band changes still rebuild immediately.
const FAR_CACHE_MIN_REBUILD_MS = 700
// While the simulation streams, worker position batches can arrive faster
// than they're worth applying (each apply is an O(nodes) copy + bounds pass,
// and invalidates the spatial index). Only the NEWEST snapshot matters —
// stash it and apply on this cadence.
const POSITIONS_APPLY_MS = 400
// Full-scan edge hover is exact but O(links) per mousemove; above this many
// links it switches to a quadtree-local test (edges incident to nodes near
// the cursor). Trade-off: hovering a long edge far from both endpoints stops
// tooltipping on huge graphs — acceptable against 300k-iteration mousemoves.
const EDGE_HOVER_FULL_SCAN_MAX = 20_000
// Hard ceiling on bundled far-LOD edge segments per scene-cache build. Pair
// dedupe alone doesn't bound the count when links span distant clusters
// (measured 114k pairs at 60k memories / 150k links).
const FAR_EDGE_SEG_CAP = 6000

export default function GraphCanvas({
  filter, showAll, watchPath, onNodeSelect, onNodeOpen,
}: GraphCanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { memories, relationships, vaultFiles, mentionEdges, selectedMemoryId, selectedFileId } = useStore()

  const [tooltip, setTooltip] = useState<{ x: number; y: number; title: string; sub?: string } | null>(null)
  const [edgeTooltip, setEdgeTooltip] = useState<{ x: number; y: number; label: string; signalType: string; strength: number } | null>(null)
  const [graphInfo, setGraphInfo] = useState<{ shown: number; total: number } | null>(null)
  const [debug, setDebug] = useState<{ fps: number; rafFps: number; visNodes: number; visEdges: number } | null>(null)

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
  const workerRef      = useRef<Worker | null>(null)
  const zoomRef        = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null)
  const hoverIdRef     = useRef<string | null>(null)
  const hoverSetRef    = useRef<Set<string> | null>(null)   // hover + 1-hop neighbours
  const selectedIdRef  = useRef<string | null>(null)
  const openIdRef      = useRef<string | null>(null)
  const nodePositions  = useRef<Map<string, { x: number; y: number }>>(new Map())
  const quadtreeRef    = useRef<Quadtree<D3Node> | null>(null)
  const quadtreeDirty  = useRef(true)
  const quadtreeVersionRef = useRef(0)
  const quadtreeBuiltAtRef = useRef(0)
  const pendingPositionsRef = useRef<{ buffer: Float32Array; count: number } | null>(null)
  const positionsAppliedAtRef = useRef(0)
  const scheduleRenderRef = useRef<() => void>(() => {})
  const linksByNodeRef = useRef<Map<string, D3Link[]>>(new Map())
  const cloudBoundsRef = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null)
  // Far-LOD scene cache: clusters + bundled edge segments computed over ALL
  // nodes once per (positions version × zoom band), reused across every pan /
  // zoom frame inside the band. Per-frame far cost is then O(clusters), not
  // O(nodes + links).
  const farCacheRef = useRef<{
    key: string
    kBucket: number
    builtAt: number
    clusters: ReturnType<typeof clusterNodes<D3Node & { x: number; y: number }>>
    clusterOf: Map<string, number>
    pairSegs: Map<string, Array<[number, number, number, number]>>
    segCount: number
  } | null>(null)
  const frameTimesRef  = useRef<number[]>([])
  const rafTimesRef    = useRef<number[]>([])  // raw rAF tick times — proxies actual paint cadence
  const lastDebugTickRef = useRef(0)
  // Drag state — kept in refs so mouse-handler closures see the current value
  // without re-running the worker-setup effect.
  const isDraggingRef  = useRef(false)
  const dragIndexRef   = useRef(-1)
  const dragPendingRef = useRef<{ index: number; x: number; y: number } | null>(null)
  const fitToBoundsRef = useRef<(animate?: boolean) => void>(() => {})
  const userNavigatedRef = useRef(false)   // stops auto-fit once the user pans/zooms

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
    fitToBoundsRef.current(true)
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

    const raw = buildGraph(memories, relationships, vaultFiles, filter, watchPath, mentionEdges)
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

    // Resolve each link's endpoints to the actual node objects. d3-forceLink
    // used to do this in place during sim init, but the simulation now runs in
    // a Worker (which mutates its OWN node copies). The renderer needs node
    // refs so draw() can read live link.source.x / link.target.y.
    const nodeById = new Map(visNodes.map(n => [n.id, n]))
    const visLinks: D3Link[] = []
    for (const l of raw.links as D3Link[]) {
      const s = typeof l.source === 'string' ? l.source : (l.source as D3Node).id
      const t = typeof l.target === 'string' ? l.target : (l.target as D3Node).id
      const src = nodeById.get(s)
      const tgt = nodeById.get(t)
      if (src && tgt) visLinks.push({ source: src, target: tgt, edgeType: l.edgeType, signalType: l.signalType, strength: l.strength })
    }

    nodesRef.current = visNodes
    linksRef.current = visLinks
    adjacencyRef.current = buildAdjacency(visNodes, visLinks)
    quadtreeDirty.current = true
    farCacheRef.current = null

    // Per-node incident links for quadtree-local edge hover on huge graphs.
    const linksByNode = new Map<string, D3Link[]>()
    for (const l of visLinks) {
      const sId = (l.source as D3Node).id
      const tId = (l.target as D3Node).id
      let sArr = linksByNode.get(sId)
      if (!sArr) { sArr = []; linksByNode.set(sId, sArr) }
      sArr.push(l)
      let tArr = linksByNode.get(tId)
      if (!tArr) { tArr = []; linksByNode.set(tId, tArr) }
      tArr.push(l)
    }
    linksByNodeRef.current = linksByNode

    // Index lookup for the worker protocol (it identifies nodes by init order).
    const nodeIndexById = new Map<string, number>()
    visNodes.forEach((node, i) => nodeIndexById.set(node.id, i))

    // Dev-only inspection handle for headless verification (CDP scripts read
    // live layout state through this; stripped from production builds).
    if (import.meta.env.DEV) {
      ;(window as unknown as Record<string, unknown>).__cortexGraphDebug = {
        nodeCount: () => nodesRef.current.length,
        linkCount: () => linksRef.current.length,
        positions: () => nodesRef.current.slice(0, 2000).map(n => ({ x: n.x ?? 0, y: n.y ?? 0 })),
        transform: () => ({ ...transformRef.current }),
        dims: { w, h },
      }
    }

    // Throttled graph_interaction telemetry. No-op in the main process unless
    // the user opted in; throttle here keeps IPC chatter low regardless.
    const lastCaptureAt: Record<string, number> = {}
    const GRAPH_TELEMETRY_THROTTLE_MS = 3000
    function captureGraph(action: 'pan' | 'zoom' | 'hover' | 'click' | 'drag') {
      const now = performance.now()
      if (now - (lastCaptureAt[action] ?? 0) < GRAPH_TELEMETRY_THROTTLE_MS) return
      lastCaptureAt[action] = now
      window.electron.telemetry.capture('graph_interaction', {
        action,
        zoom_level: Math.round(transformRef.current.k * 1000) / 1000,
        node_count: nodesRef.current.length,
      })
    }

    // ── Draw ────────────────────────────────────────────────────────────────
    function draw() {
      try {
        const t = transformRef.current
        const frameStart = performance.now()

      // Background — dark near-black (#0D0D0D) with a subtle radial gradient
      // from center to give depth. The center glow uses a low-opacity purple
      // tone that matches the Claude source color theme.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // Stops must be OPAQUE: a semi-transparent stop drawn without clearing
      // compounds frame-over-frame into a white bloom. #14101B is #0D0D0D with
      // ~4% of the Claude purple pre-blended.
      const bgGrad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.6)
      bgGrad.addColorStop(0, '#14101B')
      bgGrad.addColorStop(1, '#0D0D0D')
      ctx.fillStyle = bgGrad
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

      // Apply the newest pending physics snapshot on a fixed cadence. The
      // worker may post per tick; intermediate snapshots are dropped (only
      // the latest is stashed). Apply + spatial-index rebuild happen together
      // so hit-testing, culling, and the far cache stay mutually consistent.
      const pending = pendingPositionsRef.current
      if (pending && frameStart - positionsAppliedAtRef.current >= POSITIONS_APPLY_MS) {
        pendingPositionsRef.current = null
        positionsAppliedAtRef.current = frameStart
        const pos = pending.buffer
        const arr = nodesRef.current
        const count = Math.min(arr.length, pending.count)
        // Don't overwrite the dragged node's position with the worker's last
        // snapshot — the cursor owns its x/y until dragEnd. Without this gate
        // the dragged node visibly snaps backward 2.5×/sec when the position
        // batch ships a stale fx/fy.
        const dragIdx = isDraggingRef.current ? dragIndexRef.current : -1
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (let i = 0; i < count; i++) {
          if (i === dragIdx) continue
          const x = pos[i * 2]
          const y = pos[i * 2 + 1]
          arr[i].x = x
          arr[i].y = y
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
          nodePositions.current.set(arr[i].id, { x, y })
        }
        if (count > 0) cloudBoundsRef.current = { minX, minY, maxX, maxY }
        quadtreeDirty.current = true
        if (!userNavigatedRef.current) fitToBoundsRef.current(false)
      } else if (pending) {
        // Gate not open yet — keep the render loop alive so the snapshot
        // lands on a later frame even if nothing else marks the frame dirty.
        scheduleRenderRef.current()
      }

      // Refresh spatial index when positions or drags marked it dirty — but
      // at most a few times per second. While the simulation streams,
      // rebuilding a 100k-node tree per batch starved the frame budget;
      // hit-testing and culling tolerate ≤300ms of staleness.
      if ((quadtreeDirty.current && frameStart - quadtreeBuiltAtRef.current > 300) || quadtreeRef.current == null) {
        quadtreeRef.current = Quadtree.build(nodesRef.current, 128)
        quadtreeDirty.current = false
        quadtreeBuiltAtRef.current = frameStart
        quadtreeVersionRef.current++
      }

      // LOD decision BEFORE any per-node work. Zoom band first; then a
      // density override using a cheap visible-count estimate (viewport area
      // vs node-cloud area) so a fitted 100k view in the 'medium' band still
      // takes the cluster path — without paying a 30k-result quadtree query
      // just to discover the frame is unpayable.
      const zoomLod = getDetailLevel(t.k)
      let lod: ReturnType<typeof getDetailLevel> = zoomLod
      const totalNodes = nodesRef.current.length
      if (zoomLod !== 'far' && totalNodes > DENSITY_FAR_THRESHOLD) {
        const cb = cloudBoundsRef.current
        if (cb) {
          const cloudArea = Math.max(1, (cb.maxX - cb.minX) * (cb.maxY - cb.minY))
          const viewArea = (vR - vL) * (vB - vT)
          const estimate = totalNodes * Math.min(1, viewArea / cloudArea)
          if (estimate > DENSITY_FAR_THRESHOLD) lod = 'far'
        } else {
          // No physics batch yet — the layout is still the initial dense pile,
          // where clustering is right at ANY zoom. Without this, the first
          // seconds after opening a 100k graph draw every node per frame.
          lod = 'far'
        }
      }

      // The exact visible set is only needed on the medium/close path; far
      // frames draw from the cluster cache and never query the tree.
      const visibleNodes = lod === 'far'
        ? ([] as D3Node[])
        : quadtreeRef.current.query({ minX: vL, minY: vT, maxX: vR, maxY: vB })
      // The area-based estimate undercounts dense centers (uniform-density
      // assumption); the actual query result is authoritative. The query was
      // already paid for — the unpayable part is DRAWING it.
      if (lod !== 'far' && visibleNodes.length > DENSITY_FAR_THRESHOLD) lod = 'far'
      const visibleSet = new Set<string>()
      if (lod !== 'far') for (const n of visibleNodes) visibleSet.add(n.id)

      const hoverSet = hoverSetRef.current
      const hoverActive = hoverSet !== null && hoverSet.size > 0
      const selectedId = selectedIdRef.current
      const openId = openIdRef.current

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
      // Bucket pass: collect per (state × kind × signalType) line segments, then issue
      // one beginPath/stroke per bucket. This allows color-coding edges by signal type.
      type Bucket = Array<[number, number, number, number]>
      type BucketKey = string // "${state}:${kind}:${signalType}"
      const buckets = new Map<BucketKey, { segs: Bucket; signalColor: string }>()
      function getBucket(state: EdgeState, kind: 'relationship' | 'mention', signalType?: string): { segs: Bucket; signalColor: string } {
        const key = `${state}:${kind}:${signalType ?? 'manual'}`
        let b = buckets.get(key)
        if (!b) {
          const baseColor = edgeColor({ source: '', target: '', edgeType: kind as any, signalType: signalType as any })
          b = { segs: [], signalColor: baseColor }
          buckets.set(key, b)
        }
        return b
      }
      // Far-LOD scene cache. Keyed on positions version × half-octave zoom
      // band — pans and intra-band zooms reuse it wholesale. Built over ALL
      // nodes (not the viewport) so panning never recomputes; bundled edges
      // are deduped per cluster pair AND hard-capped, because on a graph with
      // long-range links "one segment per pair" alone can still mean 100k+
      // strokes (measured: 114,796 segs / 347ms per frame at 60k memories).
      let farClusters: ReturnType<typeof clusterNodes<D3Node & { x: number; y: number }>> | null = null
      let clusterOf = new Map<string, number>()
      let farPairSegs: Map<string, Array<[number, number, number, number]>> | null = null
      let farSegCount = 0
      if (lod === 'far') {
        const kBucket = Math.round(Math.log2(Math.max(t.k, 1e-4)) * 2)
        const cacheKey = `${quadtreeVersionRef.current}|${kBucket}`
        const cached = farCacheRef.current
        const staleButUsable =
          cached != null && cached.kBucket === kBucket &&
          frameStart - cached.builtAt < FAR_CACHE_MIN_REBUILD_MS
        if (cached?.key !== cacheKey && !staleButUsable) {
          const kNominal = Math.pow(2, kBucket / 2)
          const positioned = nodesRef.current.filter(n => n.x != null && n.y != null) as Array<D3Node & { x: number; y: number }>
          const clusters = clusterNodes(positioned, kNominal)
          const co = new Map<string, number>()
          clusters.forEach((c, i) => {
            for (const m of c.members) co.set(m.id, i)
          })
          const pairSegs = new Map<string, Array<[number, number, number, number]>>()
          const seenPairs = new Set<number>()
          let segCount = 0
          for (const link of linksRef.current) {
            if (segCount >= FAR_EDGE_SEG_CAP) break
            if (link.edgeType === 'mention') continue
            if ((link.strength ?? 1) < 0.2) continue
            const ci = co.get((link.source as D3Node).id)
            const cj = co.get((link.target as D3Node).id)
            if (ci == null || cj == null || ci === cj) continue
            const pairKey = ci < cj ? ci * 0x100000 + cj : cj * 0x100000 + ci
            if (seenPairs.has(pairKey)) continue
            seenPairs.add(pairKey)
            const sig = link.signalType ?? 'manual'
            let segs = pairSegs.get(sig)
            if (!segs) { segs = []; pairSegs.set(sig, segs) }
            segs.push([clusters[ci].x, clusters[ci].y, clusters[cj].x, clusters[cj].y])
            segCount++
          }
          farCacheRef.current = { key: cacheKey, kBucket, builtAt: frameStart, clusters, clusterOf: co, pairSegs, segCount }
        }
        farClusters = farCacheRef.current.clusters
        clusterOf = farCacheRef.current.clusterOf
        farPairSegs = farCacheRef.current.pairSegs
        farSegCount = farCacheRef.current.segCount
      }

      // Flat-fill fast path once the frame has more nodes than the rich style
      // (gradient + shadowBlur per node) can afford. ALSO during drag at any
      // size — Canvas2D shadowBlur saturates the compositor command buffer
      // and the user sees frame stalls even when the JS-side FPS reads 60.
      const dragging = isDraggingRef.current
      const fastDraw = dragging || visibleNodes.length > FAST_DRAW_THRESHOLD

      let edgesDrawn = 0
      if (lod === 'far' && farPairSegs) {
        // Cached bundled edges, one stroke pass per signal colour. Hover
        // dim/highlight is deliberately skipped at far zoom — per-frame state
        // classification is what the cache exists to avoid, and at cluster
        // scale a highlighted member edge is sub-pixel anyway.
        for (const [sig, segs] of farPairSegs) {
          if (segs.length === 0) continue
          applyEdgeStyle(ctx, 'normal', 'relationship', t.k, edgeColor({ source: '', target: '', edgeType: 'relationship', signalType: sig as D3Link['signalType'] }))
          ctx.beginPath()
          for (let i = 0; i < segs.length; i++) {
            const s = segs[i]
            addEdgePath(ctx, s[0], s[1], s[2], s[3])
          }
          ctx.stroke()
        }
        edgesDrawn = farSegCount
        ctx.setLineDash([])
      } else {
        // v0.4: edge strength threshold rises with visible-node count. The
        // medium band was the one painful zoom in v0.3 — 5–10k visible nodes
        // dragged ~40k edges of mostly-low strength into view at 78ms/frame.
        // Raising the floor to ~0.4 at scale halves the bill without losing
        // anything the user perceives at this zoom. During drag the threshold
        // bumps further: weak edges visibly wiggle but add no signal.
        const edgeStrengthMin = dragging
          ? 0.4
          : visibleNodes.length > 3000
            ? Math.min(0.5, 0.2 + (visibleNodes.length - 3000) / 12000)
            : 0.2
        for (const link of linksRef.current) {
          const src = link.source as D3Node
          const tgt = link.target as D3Node
          // Cull edges with neither endpoint visible.
          if (!visibleSet.has(src.id) && !visibleSet.has(tgt.id)) continue
          // Skip weak auto-edges — they create visual noise without meaning.
          if (link.edgeType === 'relationship' && (link.strength ?? 1) < edgeStrengthMin) continue
          // Mention edges are dropped during drag (always) and above 4k nodes.
          if (link.edgeType === 'mention' && (dragging || visibleNodes.length > 4000)) continue
          const state = edgeStateOf(src.id, tgt.id)
          // Use signalType for auto-edges, kind for mentions
          const sigType = link.edgeType === 'relationship' ? (link.signalType ?? 'manual') : undefined
          const b = getBucket(state, link.edgeType, sigType)
          b.segs.push([src.x ?? 0, src.y ?? 0, tgt.x ?? 0, tgt.y ?? 0])
          edgesDrawn++
        }
        // Order matters: dim first (sinks behind), normal next, highlight on top.
        const order: EdgeState[] = ['dim', 'normal', 'highlight']
        for (const state of order) {
          for (const [key, { segs, signalColor }] of buckets) {
            if (!key.startsWith(state + ':')) continue
            if (segs.length === 0) continue
            const kind = key.includes(':mention') ? 'mention' : 'relationship'
            applyEdgeStyle(ctx, state, kind, t.k, signalColor)
            ctx.beginPath()
            for (let i = 0; i < segs.length; i++) {
              const s = segs[i]
              addEdgePath(ctx, s[0], s[1], s[2], s[3])
            }
            ctx.stroke()
          }
        }
        ctx.setLineDash([])
      }

      // ── Nodes ────────────────────────────────────────────────────────────
      // Two-tier draw: dim first (background layer), then everything else.
      // Selected/highlight nodes have extra geometry (rings) so they're
      // drawn last individually.
      let nodesDrawn = 0
      const phase = selectedId ? pulsePhase(frameStart) : 0
      const emphasised: D3Node[] = []
      if (lod === 'far' && farClusters) {
        // FAR: one disc per spatial cluster instead of 10k sub-pixel dots.
        // Clusters come from the scene cache (whole graph) — cull centers
        // against the viewport here, which is O(clusters) per frame.
        // Selected/highlighted members still render individually on top so
        // interaction state stays visible at any zoom; the member scan only
        // runs when there IS interaction state (it's O(total nodes)).
        const clusterFast = farClusters.length > FAST_DRAW_THRESHOLD
        const interacting = hoverActive || selectedId != null || openId != null
        const cullMargin = 60
        for (const cluster of farClusters) {
          if (
            cluster.x < vL - cullMargin || cluster.x > vR + cullMargin ||
            cluster.y < vT - cullMargin || cluster.y > vB + cullMargin
          ) continue
          const rep = cluster.members[0]
          if (cluster.size === 1) {
            const state = interacting ? nodeStateOf(rep.id) : 'normal'
            if (state === 'selected' || state === 'highlight') { emphasised.push(rep); continue }
            drawNode(ctx, rep, state, t.k, 0, clusterFast)
            nodesDrawn++
            continue
          }
          // Synthetic disc: radius driven by cluster population via the
          // existing connections→radius curve; representative's color.
          drawNode(
            ctx,
            { ...rep, x: cluster.x, y: cluster.y, connections: cluster.size * 2 },
            'normal',
            t.k,
            0,
            clusterFast,
          )
          nodesDrawn++
          if (interacting) {
            for (const m of cluster.members) {
              const state = nodeStateOf(m.id)
              if (state === 'selected' || state === 'highlight') emphasised.push(m)
            }
          }
        }
      } else {
        for (const node of visibleNodes) {
          const state = nodeStateOf(node.id)
          if (state === 'dim') {
            drawNode(ctx, node, 'dim', t.k, 0, fastDraw)
            nodesDrawn++
          } else if (state === 'normal') {
            drawNode(ctx, node, 'normal', t.k, 0, fastDraw)
            nodesDrawn++
          } else {
            // selected + highlight come last so glow rings overlap correctly.
            emphasised.push(node)
          }
        }
      }
      for (const node of emphasised) {
        const state = nodeStateOf(node.id)
        // Emphasised nodes are few — usually rich. But during drag the rich
        // path (shadowBlur for the pulse ring) is exactly what flooded the
        // compositor; flat-fill them too while dragging.
        drawNode(ctx, node, state, t.k, phase, dragging)
        nodesDrawn++
      }

      ctx.restore()

      // Per-frame stats for headless verification (dev only, no React churn).
      if (import.meta.env.DEV) {
        ;(window as unknown as Record<string, unknown>).__cortexDrawStats = {
          lod, nodesDrawn, edgesDrawn, k: t.k,
          frameMs: Math.round((performance.now() - frameStart) * 100) / 100,
        }
      }

      // FPS sampling. Two metrics, because they diverge in exactly the
      // pathology we just fixed:
      //   fps    = how often draw() runs (rAF-callback rate when dirty).
      //            High even when the compositor is dropping frames.
      //   rafFps = raw rAF tick rate from the renderLoop. When the GPU
      //            compositor is saturated, vsync slips and rAF fires less
      //            often — this number tracks what the user actually sees.
      if (debugEnabled) {
        const ft = frameTimesRef.current
        ft.push(frameStart)
        if (ft.length > 60) ft.shift()
        const span = ft.length > 1 ? ft[ft.length - 1] - ft[0] : 0
        const fps = span > 0 ? Math.round(((ft.length - 1) / span) * 1000) : 0
        const rt = rafTimesRef.current
        const rspan = rt.length > 1 ? rt[rt.length - 1] - rt[0] : 0
        const rafFps = rspan > 0 ? Math.round(((rt.length - 1) / rspan) * 1000) : 0
        if (frameStart - lastDebugTickRef.current > 200) {
          lastDebugTickRef.current = frameStart
          setDebug({ fps, rafFps, visNodes: nodesDrawn, visEdges: edgesDrawn })
        }
      }
      } catch (err) {
        console.error('[graph] Draw loop error:', err)
        // Keep the loop alive — one bad frame must not kill the RAF loop
      }
    }
    drawRef.current = draw

    // ── Render loop ─────────────────────────────────────────────────────────
    // The render is fully decoupled from physics now. A single rAF redraws only
    // when something changed (`dirty`), plus continuously while a node is
    // selected (so the pulse ring breathes). This is the only place that paints.
    let dirty = true
    let renderRaf = 0
    const scheduleRender = (): void => { dirty = true }
    scheduleRenderRef.current = scheduleRender
    function renderLoop(now: number): void {
      // Sample raw rAF cadence regardless of draw — that's what tells us
      // whether the compositor is actually granting paint slots at 60Hz.
      if (debugEnabled) {
        const rt = rafTimesRef.current
        rt.push(now)
        if (rt.length > 60) rt.shift()
      }
      // Coalesce drag traffic at rAF rate. Native mousemove fires at 120-250Hz
      // on modern hardware; that was structured-cloning a drag message per
      // event AND triggering reheat(0.3) per event in the worker, which
      // posted a position batch per reheat. Flushing once per rAF caps the
      // worker round-trips at the screen refresh rate.
      if (dragPendingRef.current) {
        const msg = dragPendingRef.current
        dragPendingRef.current = null
        workerRef.current?.postMessage({ type: 'drag', index: msg.index, x: msg.x, y: msg.y })
      }
      if (dirty || selectedIdRef.current != null) {
        dirty = false
        draw()
      }
      renderRaf = requestAnimationFrame(renderLoop)
    }
    renderRaf = requestAnimationFrame(renderLoop)

    // ── Force simulation (off the main thread) ──────────────────────────────
    // The Worker owns the physics. It streams batched node positions back; we
    // copy them into our node objects (same index order as init) and request a
    // render. Nothing here blocks the UI thread.
    const worker = new Worker(
      new URL('../workers/force-simulation.worker.ts', import.meta.url),
      { type: 'module' },
    )
    workerRef.current = worker
    worker.onmessage = (ev: MessageEvent): void => {
      const msg = ev.data as { type: string; buffer?: ArrayBuffer; count?: number }
      if (msg.type !== 'positions' || !msg.buffer) return
      // Stash only — applying every batch (an O(nodes) copy + bounds pass)
      // starved the main thread at 100k while the sim streamed per-tick.
      // draw() applies the newest snapshot on a fixed cadence; superseded
      // snapshots are simply dropped.
      pendingPositionsRef.current = { buffer: new Float32Array(msg.buffer), count: msg.count ?? 0 }
      scheduleRender()
    }
    // Typed-array init (zero-copy transfer). At 100k nodes structured-cloning
    // object arrays into the worker costs seconds; three buffers cost ~0.
    // Node identity is index-based from here on — drag messages carry the
    // node's init-order index, never its id.
    {
      const count = visNodes.length
      const positions = new Float32Array(count * 2)
      const connections = new Float32Array(count)
      visNodes.forEach((node, i) => {
        positions[i * 2] = node.x ?? NaN
        positions[i * 2 + 1] = node.y ?? NaN
        connections[i] = node.connections
      })
      const linkPairs = new Uint32Array(visLinks.length * 2)
      visLinks.forEach((l, i) => {
        linkPairs[i * 2] = nodeIndexById.get((l.source as D3Node).id) ?? 0
        linkPairs[i * 2 + 1] = nodeIndexById.get((l.target as D3Node).id) ?? 0
      })
      worker.postMessage(
        {
          type: 'init',
          count,
          positions: positions.buffer,
          connections: connections.buffer,
          links: linkPairs.buffer,
          width: w,
          height: h,
        },
        [positions.buffer, connections.buffer, linkPairs.buffer],
      )
    }

    // ── Zoom + pan ─────────────────────────────────────────────────────────
    const zoom = d3.zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.01, 8])
      .filter(event => {
        if (event instanceof WheelEvent) return true
        if (!(event instanceof MouseEvent)) return true
        const rect = canvas.getBoundingClientRect()
        const [sx, sy] = toSim(event.clientX - rect.left, event.clientY - rect.top)
        return !hitTest(sx, sy)
      })
      .on('zoom', ev => {
        transformRef.current = ev.transform
        // Only direct user input (wheel/drag) disables auto-fit; programmatic
        // transforms (fit itself) have no sourceEvent.
        if (ev.sourceEvent) userNavigatedRef.current = true
        // Zoom/pan is a pure view transform — no physics involvement, just a
        // repaint next frame.
        scheduleRender()
        // Classify wheel as zoom, drag as pan (throttled).
        captureGraph(ev.sourceEvent instanceof WheelEvent ? 'zoom' : 'pan')
      })
    zoomRef.current = zoom
    d3.select(canvas).call(zoom).on('dblclick.zoom', null)

    // Fit the camera so the node bounding box fills ~90% of the viewport.
    // Goes through the d3-zoom behavior (not transformRef directly) so wheel
    // and drag gestures continue from the fitted transform.
    fitToBoundsRef.current = (animate = false) => {
      const arr = nodesRef.current
      if (arr.length === 0) return
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const node of arr) {
        const nx = node.x ?? 0, ny = node.y ?? 0
        if (nx < minX) minX = nx
        if (ny < minY) minY = ny
        if (nx > maxX) maxX = nx
        if (ny > maxY) maxY = ny
      }
      const bw = Math.max(maxX - minX, 1)
      const bh = Math.max(maxY - minY, 1)
      const k = Math.min(8, Math.max(0.01, 0.9 * Math.min(w / bw, h / bh)))
      const tx = w / 2 - k * (minX + maxX) / 2
      const ty = h / 2 - k * (minY + maxY) / 2
      const t = d3.zoomIdentity.translate(tx, ty).scale(k)
      const sel = d3.select(canvas)
      if (animate) sel.transition().duration(400).call(zoom.transform, t)
      else sel.call(zoom.transform, t)
    }
    scheduleRender()

    // ── Hit detection ──────────────────────────────────────────────────────
    function toSim(cx: number, cy: number): [number, number] {
      const t = transformRef.current
      return [(cx - t.x) / t.k, (cy - t.y) / t.k]
    }
    function hitTest(sx: number, sy: number): D3Node | null {
      return getNodeAtPoint(sx, sy, quadtreeRef.current, nodesRef.current, 4, transformRef.current.k)
    }

    /** Point-to-segment distance check shared by both edge hover strategies. */
    function edgeDistSq(link: D3Link, sx: number, sy: number): number | null {
      const src = link.source as D3Node
      const tgt = link.target as D3Node
      if (src.x == null || tgt.x == null) return null
      const dx = (tgt.x - src.x)
      const dy = (tgt.y - src.y)
      const lenSq = dx * dx + dy * dy
      let t = ((sx - src.x) * dx + (sy - src.y) * dy) / (lenSq || 1)
      t = Math.max(0, Math.min(1, t))
      const px = src.x + t * dx
      const py = src.y + t * dy
      return (sx - px) * (sx - px) + (sy - py) * (sy - py)
    }

    /** Find an edge near the given simulation-space point. Returns the link + distance squared. */
    function hitTestEdge(sx: number, sy: number): { link: D3Link; distSq: number } | null {
      // At FAR zoom nodes are cluster discs and individual edges aren't
      // meaningfully hoverable — skip the scan per mousemove.
      if (getDetailLevel(transformRef.current.k) === 'far') return null
      const k = transformRef.current.k
      const threshold = 16 / (k * k) // ~4px in sim space
      let best: { link: D3Link; distSq: number } | null = null

      if (linksRef.current.length <= EDGE_HOVER_FULL_SCAN_MAX) {
        // Exact: every edge, every mousemove. Fine up to ~20k links.
        for (const link of linksRef.current) {
          const distSq = edgeDistSq(link, sx, sy)
          if (distSq != null && distSq < threshold && (!best || distSq < best.distSq)) {
            best = { link, distSq }
          }
        }
        return best
      }

      // Huge graphs: only test edges incident to nodes near the cursor
      // (quadtree window), de-duplicated. O(local degree) per mousemove.
      const radius = 48 / k
      const nearby = quadtreeRef.current?.query({
        minX: sx - radius, minY: sy - radius, maxX: sx + radius, maxY: sy + radius,
      }) ?? []
      const seen = new Set<D3Link>()
      for (const node of nearby) {
        const incident = linksByNodeRef.current.get(node.id)
        if (!incident) continue
        for (const link of incident) {
          if (seen.has(link)) continue
          seen.add(link)
          const distSq = edgeDistSq(link, sx, sy)
          if (distSq != null && distSq < threshold && (!best || distSq < best.distSq)) {
            best = { link, distSq }
          }
        }
      }
      return best
    }

    // ── Mouse handlers ─────────────────────────────────────────────────────
    let mdX = 0, mdY = 0
    let dragId: string | null = null

    function setHover(node: D3Node | null) {
      const newId = node?.id ?? null
      if (newId === hoverIdRef.current) return
      hoverIdRef.current = newId
      if (newId == null) {
        hoverSetRef.current = null
      } else {
        hoverSetRef.current = highlightPath(newId, 1, adjacencyRef.current)
        captureGraph('hover')
      }
      scheduleRender()
    }

    const onMouseDown = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      mdX = e.clientX - rect.left
      mdY = e.clientY - rect.top
      const [sx, sy] = toSim(mdX, mdY)
      const found = hitTest(sx, sy)
      dragId = found?.id ?? null
      if (found) {
        const idx = nodeIndexById.get(found.id) ?? -1
        isDraggingRef.current = true
        dragIndexRef.current = idx
        // Pin the node in the worker at its current position so the layout
        // holds it under the cursor. Worker protocol is index-based.
        worker.postMessage({ type: 'drag', index: idx, x: found.x ?? sx, y: found.y ?? sy })
        scheduleRender()
      }
    }

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const [sx, sy] = toSim(cx, cy)

      if (dragId) {
        // Instant local feedback: move the node now. Defer the worker postMessage
        // to the next rAF flush so 120-250Hz mousemoves don't flood the worker
        // (each worker drag message was triggering reheat + a fresh position
        // batch — the compositor saw an unbroken stream of canvas commands).
        const node = nodeById.get(dragId)
        if (node) { node.x = sx; node.y = sy }
        dragPendingRef.current = { index: nodeIndexById.get(dragId) ?? -1, x: sx, y: sy }
        quadtreeDirty.current = true
        scheduleRender()
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
        const nodeData = found as D3Node
        const sourceLabel = nodeData.source ?? ''
        const degree = (nodeData as any).connections ?? 0
        setTooltip({
          x: (found.x ?? 0) * t.k + t.x,
          y: (found.y ?? 0) * t.k + t.y,
          title: found.title,
          sub: degree > 0 ? `${sourceLabel} · ${degree} connections` : sourceLabel,
        })
        setEdgeTooltip(null)
      } else {
        // Check for edge hover
        const edgeHit = hitTestEdge(sx, sy)
        if (edgeHit && edgeHit.link.edgeType === 'relationship' && edgeHit.link.signalType && edgeHit.link.signalType !== 'manual') {
          canvas.style.cursor = 'pointer'
          const src = edgeHit.link.source as D3Node
          const tgt = edgeHit.link.target as D3Node
          const midX = ((src.x ?? 0) + (tgt.x ?? 0)) / 2
          const midY = ((src.y ?? 0) + (tgt.y ?? 0)) / 2
          const t = transformRef.current
          const label = {
            'auto:tag':       'Shared tags',
            'auto:keyword':   'Shared keywords',
            'auto:embedding': 'Semantic similarity',
            'wiki':           'Wiki link',
          }[edgeHit.link.signalType] ?? 'Connected'
          setEdgeTooltip({
            x: midX * t.k + t.x,
            y: midY * t.k + t.y,
            label,
            signalType: edgeHit.link.signalType,
            strength: edgeHit.link.strength ?? 0,
          })
          setTooltip(null)
        } else {
          canvas.style.cursor = ''
          setTooltip(null)
          setEdgeTooltip(null)
        }
      }
      setHover(found)
    }

    const onMouseUp = () => {
      if (dragId) {
        // Flush any pending drag coords so the worker's final fx/fy is the
        // cursor's last position, not a stale one.
        if (dragPendingRef.current) {
          const msg = dragPendingRef.current
          dragPendingRef.current = null
          worker.postMessage({ type: 'drag', index: msg.index, x: msg.x, y: msg.y })
        }
        worker.postMessage({ type: 'dragEnd', index: nodeIndexById.get(dragId) ?? -1 })
        dragId = null
        isDraggingRef.current = false
        dragIndexRef.current = -1
        scheduleRender()
        captureGraph('drag')
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
      if (found) captureGraph('click')
      // Selection drives the pulse; the render loop keeps animating while a
      // node is selected, so just request a repaint here.
      scheduleRender()
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
      setEdgeTooltip(null)
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
      // Clear drag state — a mid-drag teardown (HMR, prop change) must not
      // leave the next mount stuck in flat-fill or with a stale drag index.
      isDraggingRef.current = false
      dragIndexRef.current = -1
      dragPendingRef.current = null
      worker.postMessage({ type: 'stop' })
      worker.terminate()
      workerRef.current = null
      drawRef.current = () => {}
      if (renderRaf) cancelAnimationFrame(renderRaf)
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
  }, [memories, relationships, vaultFiles, mentionEdges, filter, showAll, watchPath, onNodeSelect, onNodeOpen, debugEnabled])

  return (
    <div className="w-full h-full relative">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ display: 'block', background: '#0D0D0D' }}
      />

      {tooltip && (
        <div
          className="absolute pointer-events-none select-none bg-[#0F1428]/90 text-xs px-3 py-2 rounded shadow-lg z-20"
          style={{
            left: tooltip.x + 12,
            top: tooltip.y - 24,
            border: '1px solid rgba(148, 163, 184, 0.2)',
          }}
        >
          <div className="text-[#E2E8F0] font-medium">{tooltip.title}</div>
          {tooltip.sub && <div className="text-[#94A3B8] text-[9px] mt-0.5">{tooltip.sub}</div>}
        </div>
      )}

      {edgeTooltip && (
        <div
          className="absolute pointer-events-none select-none bg-[#111]/90 text-xs px-3 py-2 rounded shadow-lg z-20"
          style={{ left: edgeTooltip.x + 12, top: edgeTooltip.y - 24 }}
        >
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{
                backgroundColor: edgeColor({
                  source: '', target: '', edgeType: 'relationship',
                  signalType: edgeTooltip.signalType as any,
                }),
              }}
            />
            <span className="text-[#ccc]">{edgeTooltip.label}</span>
          </div>
          <div className="text-[#888] mt-0.5">{Math.round(edgeTooltip.strength * 100)}% similarity</div>
        </div>
      )}

      {debug && (
        <div className="absolute top-2 left-2 bg-[#1a1a1a]/90 text-[#ccc] text-xs px-3 py-2 rounded font-mono pointer-events-none select-none">
          <div>
            paint: <span className={debug.rafFps >= 55 ? 'text-green-400' : debug.rafFps >= 30 ? 'text-yellow-400' : 'text-red-400'}>{debug.rafFps}</span>
            <span className="text-[#666]"> · draw:</span> <span className={debug.fps >= 55 ? 'text-green-400' : debug.fps >= 30 ? 'text-yellow-400' : 'text-red-400'}>{debug.fps}</span>
          </div>
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
