#!/usr/bin/env node
// scripts/profile-lod.mjs
//
// v0.2 P0 #3 — graph LOD + viewport-culling pipeline benchmark.
//
// Times the quadtree build + viewport query + LOD cluster pipeline at three
// zoom levels with N=10000 synthetic positions. Reports per-frame cost so we
// can derive the headroom inside a 16.6ms (60 FPS) budget.
//
// Real browser FPS is measured via the in-app debug overlay (?debug=graph or
// localStorage 'cortex.debug.graph' = '1'). This script profiles the JS
// pipeline cost only — no canvas paint.
//
// The Quadtree / LOD logic here is inlined (not imported) so the script runs
// under plain Node without a TS loader. Keep this file in sync with
// src/renderer/src/utils/{quadtree,lod}.ts if the production algorithms change.
//
// USAGE
//   node scripts/profile-lod.mjs                # 10k nodes, 200 frames per zoom
//   node scripts/profile-lod.mjs --nodes=20000
//   node scripts/profile-lod.mjs --frames=500

import { writeFileSync } from 'fs'
import { join } from 'path'

// ── Inlined Quadtree (mirrors src/renderer/src/utils/quadtree.ts) ───────────
const CAPACITY = 8
const MAX_DEPTH = 16
function makeQNode(bounds, depth) { return { bounds, depth, items: [], children: null } }
function within(b, x, y) { return x >= b.minX && x < b.maxX && y >= b.minY && y < b.maxY }
function overlaps(a, b) { return !(a.maxX <= b.minX || a.minX >= b.maxX || a.maxY <= b.minY || a.minY >= b.maxY) }
function subdivide(n) {
  const { minX, minY, maxX, maxY } = n.bounds
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2, d = n.depth + 1
  n.children = [
    makeQNode({ minX, minY, maxX: mx, maxY: my }, d),
    makeQNode({ minX: mx, minY, maxX, maxY: my }, d),
    makeQNode({ minX, minY: my, maxX: mx, maxY }, d),
    makeQNode({ minX: mx, minY: my, maxX, maxY }, d),
  ]
  const old = n.items; n.items = []
  for (const it of old) qInsert(n, it)
}
function qInsert(n, item) {
  if (!within(n.bounds, item.x, item.y)) return false
  if (n.children) {
    for (const c of n.children) if (qInsert(c, item)) return true
    n.items.push(item); return true
  }
  n.items.push(item)
  if (n.items.length > CAPACITY && n.depth < MAX_DEPTH) subdivide(n)
  return true
}
function qQuery(n, b, out) {
  if (!overlaps(n.bounds, b)) return
  if (n.children) {
    for (const c of n.children) qQuery(c, b, out)
    for (const it of n.items) if (it.x >= b.minX && it.x < b.maxX && it.y >= b.minY && it.y < b.maxY) out.push(it)
    return
  }
  for (const it of n.items) if (it.x >= b.minX && it.x < b.maxX && it.y >= b.minY && it.y < b.maxY) out.push(it)
}
function buildTree(points, margin = 100) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y
  }
  const root = makeQNode({ minX: minX - margin, minY: minY - margin, maxX: maxX + margin + 1, maxY: maxY + margin + 1 }, 0)
  for (const p of points) qInsert(root, p)
  return root
}
function queryTree(root, b) { const out = []; qQuery(root, b, out); return out }

// ── Inlined LOD (mirrors src/renderer/src/utils/lod.ts) ─────────────────────
function getDetailLevel(z) { return z < 0.5 ? 'far' : z >= 2.0 ? 'close' : 'medium' }
function clusterNodes(nodes, zoom) {
  const bucket = 40 / zoom
  const buckets = new Map()
  for (const n of nodes) {
    const k = `${Math.floor(n.x / bucket)}|${Math.floor(n.y / bucket)}`
    let arr = buckets.get(k); if (!arr) { arr = []; buckets.set(k, arr) }
    arr.push(n)
  }
  const out = []
  for (const arr of buckets.values()) {
    for (let i = 0; i < arr.length; i += 50) {
      const slice = arr.slice(i, i + 50)
      let sx = 0, sy = 0
      for (const n of slice) { sx += n.x; sy += n.y }
      out.push({ x: sx / slice.length, y: sy / slice.length, size: slice.length })
    }
  }
  return out
}

// ── Setup ────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2))
const N = parseInt(args.get('nodes') ?? '10000', 10)
const FRAMES = parseInt(args.get('frames') ?? '200', 10)

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
const SPREAD = 600
const nodes = Array.from({ length: N }, (_, i) => ({
  id: `n${i}`, x: gauss(rng) * SPREAD, y: gauss(rng) * SPREAD,
}))

const W = 1200, H = 800
const zooms = [
  { label: 'far',    zoom: 0.2 },
  { label: 'medium', zoom: 1.0 },
  { label: 'close',  zoom: 3.0 },
]
console.log(`[lod] nodes=${N} frames=${FRAMES}/zoom`)

// Warmup
buildTree(nodes, 100)

const allSamples = []
const summary = {}

for (const { label, zoom } of zooms) {
  const t0 = hrtimeMs()
  const tree = buildTree(nodes, 100)
  const buildMs = hrtimeMs() - t0
  const samples = []
  for (let f = 0; f < FRAMES; f++) {
    const ang = (f / FRAMES) * Math.PI * 4
    const camX = Math.cos(ang) * 200, camY = Math.sin(ang) * 200
    const buf = 200 / zoom
    const vL = camX - (W / 2) / zoom - buf
    const vR = camX + (W / 2) / zoom + buf
    const vT = camY - (H / 2) / zoom - buf
    const vB = camY + (H / 2) / zoom + buf

    const a = hrtimeMs()
    const vis = queryTree(tree, { minX: vL, minY: vT, maxX: vR, maxY: vB })
    const b = hrtimeMs()
    const lod = getDetailLevel(zoom)
    let drawn = vis.length, clusters = 0
    if (lod === 'far') {
      const cs = clusterNodes(vis, zoom)
      drawn = cs.length; clusters = cs.length
    }
    const c = hrtimeMs()
    samples.push({
      frame: f,
      query_ms: +(b - a).toFixed(4),
      cluster_ms: +(c - b).toFixed(4),
      total_ms: +(c - a).toFixed(4),
      visible_count: vis.length,
      drawn_count: drawn,
      cluster_count: clusters,
    })
  }

  const totals = samples.map(s => s.total_ms).sort((x, y) => x - y)
  const queries = samples.map(s => s.query_ms).sort((x, y) => x - y)
  const visibles = samples.map(s => s.visible_count)
  const meanTotal = totals.reduce((x, y) => x + y, 0) / totals.length
  const stats = {
    frames: totals.length,
    visible_mean: Math.round(visibles.reduce((x, y) => x + y, 0) / visibles.length),
    visible_max: Math.max(...visibles),
    cull_p50_ms: percentile(totals, 0.5),
    cull_p95_ms: percentile(totals, 0.95),
    cull_p99_ms: percentile(totals, 0.99),
    query_p95_ms: percentile(queries, 0.95),
    quadtree_build_ms: +buildMs.toFixed(3),
    derived_fps_capacity: Math.round(1000 / Math.max(meanTotal, 0.001)),
  }
  summary[label] = stats
  allSamples.push({ zoom, label, samples })
  console.log(`[lod] ${label.padEnd(6)} zoom=${zoom.toFixed(2)} visible≈${stats.visible_mean} cull p95=${stats.cull_p95_ms}ms cap=${stats.derived_fps_capacity}fps`)
}

const result = {
  generatedAt: new Date().toISOString(),
  config: { nodes: N, frames: FRAMES, viewport: { w: W, h: H } },
  notes: 'JS pipeline cost only; real browser FPS via in-app debug overlay (?debug=graph).',
  summary,
  samples: allSamples,
}
const out = join(process.cwd(), 'profiling-lod-results.json')
writeFileSync(out, JSON.stringify(result, null, 2))
console.log(`[lod] wrote ${out}`)

function hrtimeMs() { const [s, n] = process.hrtime(); return s * 1000 + n / 1e6 }
function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  return +sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(4)
}
function parseArgs(argv) {
  const flags = new Set(), kv = new Map()
  for (const a of argv) {
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq >= 0) kv.set(a.slice(2, eq), a.slice(eq + 1)); else flags.add(a.slice(2))
  }
  return Object.assign(flags, { get: k => kv.get(k) })
}
