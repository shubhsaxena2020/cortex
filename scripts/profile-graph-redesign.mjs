#!/usr/bin/env node
// scripts/profile-graph-redesign.mjs
//
// v0.2 graph-redesign profile. The Obsidian-style rewrite shows ALL visible
// nodes (no LOD clustering), so the worst-case draw at 10k nodes / zoom 0.2
// has to push every node + edge to the canvas every frame. This script times
// the JS half of that pipeline:
//   - quadtree.query for the viewport
//   - 1-hop adjacency lookup (hover state)
//   - per-edge classification + bucket fill
//   - per-node state classification
//
// Actual canvas paint cost is browser-only — measure that via the in-app
// debug overlay (?debug=graph). Numbers here cap what the pipeline costs
// before any paint work.
//
// USAGE
//   node scripts/profile-graph-redesign.mjs                   # 10k nodes
//   node scripts/profile-graph-redesign.mjs --nodes=20000
//   node scripts/profile-graph-redesign.mjs --frames=500

import { writeFileSync } from 'fs'
import { join } from 'path'

// ── Inlined quadtree (sync with src/renderer/src/utils/quadtree.ts) ─────────
const CAP = 8, MAXD = 16
const mk = (b, d) => ({ bounds: b, depth: d, items: [], children: null })
const within = (b, x, y) => x >= b.minX && x < b.maxX && y >= b.minY && y < b.maxY
const overlaps = (a, b) => !(a.maxX <= b.minX || a.minX >= b.maxX || a.maxY <= b.minY || a.minY >= b.maxY)
function sub(n) {
  const { minX, minY, maxX, maxY } = n.bounds
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2, d = n.depth + 1
  n.children = [
    mk({ minX, minY, maxX: mx, maxY: my }, d),
    mk({ minX: mx, minY, maxX, maxY: my }, d),
    mk({ minX, minY: my, maxX: mx, maxY }, d),
    mk({ minX: mx, minY: my, maxX, maxY }, d),
  ]
  const old = n.items; n.items = []
  for (const it of old) ins(n, it)
}
function ins(n, it) {
  if (!within(n.bounds, it.x, it.y)) return false
  if (n.children) {
    for (const c of n.children) if (ins(c, it)) return true
    n.items.push(it); return true
  }
  n.items.push(it)
  if (n.items.length > CAP && n.depth < MAXD) sub(n)
  return true
}
function qry(n, b, out) {
  if (!overlaps(n.bounds, b)) return
  if (n.children) {
    for (const c of n.children) qry(c, b, out)
    for (const it of n.items) if (it.x >= b.minX && it.x < b.maxX && it.y >= b.minY && it.y < b.maxY) out.push(it)
    return
  }
  for (const it of n.items) if (it.x >= b.minX && it.x < b.maxX && it.y >= b.minY && it.y < b.maxY) out.push(it)
}
function build(points, margin = 128) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y
  }
  const r = mk({ minX: minX - margin, minY: minY - margin, maxX: maxX + margin + 1, maxY: maxY + margin + 1 }, 0)
  for (const p of points) ins(r, p)
  return r
}
function query(r, b) { const out = []; qry(r, b, out); return out }

// ── Setup ────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2))
const N = parseInt(args.get('nodes') ?? '10000', 10)
const FRAMES = parseInt(args.get('frames') ?? '200', 10)
const E_PER_NODE = 2  // avg degree ≈ 4 in an undirected graph

function mulberry32(s) {
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function gauss(rng) {
  const u = Math.max(rng(), 1e-9), v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
const rng = mulberry32(42)
const nodes = Array.from({ length: N }, (_, i) => ({
  id: `n${i}`,
  x: gauss(rng) * 600, y: gauss(rng) * 600,
}))
const links = []
for (let i = 0; i < N; i++) {
  for (let k = 0; k < E_PER_NODE; k++) {
    const j = Math.floor(rng() * N)
    if (j !== i) {
      links.push({
        sourceId: nodes[i].id, targetId: nodes[j].id,
        sx: nodes[i].x, sy: nodes[i].y, tx: nodes[j].x, ty: nodes[j].y,
        kind: rng() < 0.7 ? 'relationship' : 'mention',
      })
    }
  }
}

// Adjacency
const adj = new Map()
for (const n of nodes) adj.set(n.id, new Set())
for (const l of links) {
  adj.get(l.sourceId)?.add(l.targetId)
  adj.get(l.targetId)?.add(l.sourceId)
}

const W = 1200, H = 800

const zooms = [
  { label: 'all-visible (worst case)', zoom: 0.15 },  // entire 10k in viewport
  { label: 'medium working zoom',      zoom: 1.0 },
  { label: 'close-up + labels',        zoom: 3.0 },
]

console.log(`[redesign] nodes=${N} edges=${links.length} frames=${FRAMES}/zoom`)
build(nodes, 128)  // warmup JIT

const summary = {}
const allSamples = []

// Hover for half the frames so we measure the highlight-path codepath too.
const HOVER_FRAMES = FRAMES / 2

for (const { label, zoom } of zooms) {
  const tBuild0 = now()
  const tree = build(nodes, 128)
  const buildMs = now() - tBuild0
  const samples = []

  for (let f = 0; f < FRAMES; f++) {
    const ang = (f / FRAMES) * Math.PI * 4
    const camX = Math.cos(ang) * 200, camY = Math.sin(ang) * 200
    const buf = 128 / zoom
    const vL = camX - (W / 2) / zoom - buf
    const vR = camX + (W / 2) / zoom + buf
    const vT = camY - (H / 2) / zoom - buf
    const vB = camY + (H / 2) / zoom + buf

    // Viewport cull
    const tCull0 = now()
    const visible = query(tree, { minX: vL, minY: vT, maxX: vR, maxY: vB })
    const visSet = new Set()
    for (const n of visible) visSet.add(n.id)
    const tCull1 = now()

    // Hover state: pick a random visible node every Nth frame
    let hoverSet = null
    if (f >= HOVER_FRAMES && visible.length > 0) {
      const hoverNode = visible[Math.floor(rng() * visible.length)]
      hoverSet = new Set([hoverNode.id])
      const nbrs = adj.get(hoverNode.id)
      if (nbrs) for (const n of nbrs) hoverSet.add(n)
    }

    // Edge bucket fill
    const tEdges0 = now()
    let edgesDrawn = 0
    const buckets = {
      normal:    { relationship: 0, mention: 0 },
      dim:       { relationship: 0, mention: 0 },
      highlight: { relationship: 0, mention: 0 },
    }
    for (const l of links) {
      if (!visSet.has(l.sourceId) && !visSet.has(l.targetId)) continue
      let state
      if (!hoverSet) state = 'normal'
      else state = (hoverSet.has(l.sourceId) && hoverSet.has(l.targetId)) ? 'highlight' : 'dim'
      buckets[state][l.kind]++
      edgesDrawn++
    }
    const tEdges1 = now()

    // Node state classification
    const tNodes0 = now()
    let nodesDrawn = 0
    for (const n of visible) {
      // (just touch the codepath — equivalent to nodeStateOf)
      const _state = !hoverSet ? 'normal' : (hoverSet.has(n.id) ? 'highlight' : 'dim')
      void _state
      nodesDrawn++
    }
    const tNodes1 = now()

    samples.push({
      frame: f,
      cull_ms: +(tCull1 - tCull0).toFixed(4),
      edges_ms: +(tEdges1 - tEdges0).toFixed(4),
      nodes_ms: +(tNodes1 - tNodes0).toFixed(4),
      total_ms: +(tNodes1 - tCull0).toFixed(4),
      visible_nodes: visible.length,
      visible_edges: edgesDrawn,
      hovered: hoverSet != null,
    })
  }

  const totals = samples.map(s => s.total_ms).sort((a, b) => a - b)
  const visibles = samples.map(s => s.visible_nodes)
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length
  const cap = Math.round(1000 / Math.max(mean, 0.001))
  const stats = {
    frames: totals.length,
    visible_nodes_mean: Math.round(visibles.reduce((a, b) => a + b, 0) / visibles.length),
    visible_nodes_max: Math.max(...visibles),
    visible_edges_mean: Math.round(samples.reduce((a, s) => a + s.visible_edges, 0) / samples.length),
    pipeline_p50_ms: pct(totals, 0.5),
    pipeline_p95_ms: pct(totals, 0.95),
    pipeline_p99_ms: pct(totals, 0.99),
    quadtree_build_ms: +buildMs.toFixed(3),
    derived_fps_capacity_pipeline_only: cap,
  }
  summary[label] = stats
  allSamples.push({ zoom, label, samples })
  console.log(`[redesign] ${label.padEnd(30)} zoom=${zoom.toFixed(2)} visN=${stats.visible_nodes_mean} visE=${stats.visible_edges_mean} p95=${stats.pipeline_p95_ms}ms cap=${cap}fps`)
}

const out = join(process.cwd(), 'profiling-graph-redesign.json')
writeFileSync(out, JSON.stringify({
  generatedAt: new Date().toISOString(),
  notes: 'JS pipeline cost only (cull + bucket fill + node classify). Real paint via in-app overlay.',
  config: { nodes: N, edges: links.length, frames: FRAMES, hover_frames: HOVER_FRAMES, viewport: { w: W, h: H } },
  summary, samples: allSamples,
}, null, 2))
console.log(`[redesign] wrote ${out}`)

function now() { const [s, n] = process.hrtime(); return s * 1000 + n / 1e6 }
function pct(sorted, p) { if (!sorted.length) return 0; return +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(4) }
function parseArgs(argv) {
  const flags = new Set(), kv = new Map()
  for (const a of argv) {
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq >= 0) kv.set(a.slice(2, eq), a.slice(eq + 1)); else flags.add(a.slice(2))
  }
  return Object.assign(flags, { get: k => kv.get(k) })
}
