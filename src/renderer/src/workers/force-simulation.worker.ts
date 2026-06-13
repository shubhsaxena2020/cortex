// Off-main-thread D3 force layout.
//
// WHY: running the force simulation for a 10k-node graph on the main thread
// froze the window — every tick (forceManyBody + forceCollide over 10k nodes)
// is multi-millisecond, and the old code both ticked AND redrew on the main
// thread. Here the physics runs in a Worker; the main thread only renders.
//
// PROTOCOL (typed arrays end-to-end — at 100k nodes structured-cloning object
// arrays costs seconds; transferable buffers cost ~0):
//   main → worker : init     { count, positions: Float32Array buffer (NaN =
//                              unset), connections: Float32Array buffer,
//                              links: Uint32Array buffer of [src,tgt] index
//                              pairs, width, height }
//                   drag     { index, x, y } | dragEnd { index }
//                   reheat | stop
//   worker → main : positions (transferable Float32Array of [x,y,…] in init
//                              index order)
//
// Node identity is INDEX-based: the main thread owns id↔index mapping; the
// worker never sees an id string.
//
// SCALE ADAPTATION: d3-force defaults are tuned for hundreds of nodes. At
// 100k, forceCollide dominates every tick (it rebuilds its own quadtree per
// pass) for spacing that's invisible below LOD-far anyway, and a slow
// alphaDecay means thousands of ticks before settle. Forces and cadence are
// therefore stepped by node count — visually identical at small scale,
// convergent within seconds at 100k.

import {
  forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY,
  type Simulation, type SimulationNodeDatum, type SimulationLinkDatum,
} from 'd3-force'

interface WNode extends SimulationNodeDatum {
  index: number
  connections: number
}
type WLink = SimulationLinkDatum<WNode>

type InitMsg = {
  type: 'init'
  count: number
  positions: ArrayBuffer    // Float32 [x,y,…], NaN = let d3 place it
  connections: ArrayBuffer  // Float32 per node (radius input)
  links: ArrayBuffer        // Uint32 [srcIndex, tgtIndex, …]
  width: number
  height: number
}
type InMsg =
  | InitMsg
  | { type: 'drag'; index: number; x: number; y: number }
  | { type: 'dragEnd'; index: number }
  | { type: 'reheat'; alpha?: number }
  | { type: 'stop' }

// Cast `self` to a minimal worker surface — avoids pulling in the WebWorker lib
// (which conflicts with the DOM lib's `self`/`postMessage` typings used by the
// rest of the renderer tsconfig).
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<InMsg>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

let sim: Simulation<WNode, WLink> | null = null
let nodes: WNode[] = []
let scheduled = false
let ticksPerBatch = 5

// Mirrors graph-renderer nodeRadius (4 + sqrt(connections) * 3, clamped) —
// duplicated to keep this worker dependency-free for the typed-array protocol.
function radiusOf(connections: number): number {
  const r = 4 + Math.sqrt(connections) * 3
  return Math.max(4, Math.min(r, 50))
}

function postPositions(): void {
  const buf = new Float32Array(nodes.length * 2)
  for (let i = 0; i < nodes.length; i++) {
    buf[i * 2] = nodes[i].x ?? 0
    buf[i * 2 + 1] = nodes[i].y ?? 0
  }
  // Transfer the buffer (zero-copy). A fresh buffer is allocated each batch, so
  // we never need it back.
  ctx.postMessage({ type: 'positions', buffer: buf.buffer, count: nodes.length }, [buf.buffer])
}

function runBatch(): void {
  scheduled = false
  if (!sim) return
  for (let i = 0; i < ticksPerBatch; i++) sim.tick()
  postPositions()
  if (sim.alpha() > sim.alphaMin()) schedule()
}

function schedule(): void {
  if (scheduled || !sim) return
  scheduled = true
  setTimeout(runBatch, 0)
}

function reheat(target: number): void {
  if (!sim) return
  // Keep the layout warm: set the cooling target and bump current alpha so the
  // loop has energy to run.
  sim.alphaTarget(target).alpha(Math.max(sim.alpha(), 0.3))
  schedule()
}

ctx.onmessage = (e: MessageEvent<InMsg>): void => {
  const msg = e.data
  switch (msg.type) {
    case 'init': {
      const positions = new Float32Array(msg.positions)
      const connections = new Float32Array(msg.connections)
      const linkPairs = new Uint32Array(msg.links)
      const n = msg.count

      nodes = new Array<WNode>(n)
      for (let i = 0; i < n; i++) {
        const x = positions[i * 2]
        const y = positions[i * 2 + 1]
        nodes[i] = {
          index: i,
          connections: connections[i],
          // NaN means "no cached position" — leave undefined so d3 uses its
          // phyllotaxis initial placement (deterministic, no overlap pile).
          ...(Number.isNaN(x) ? {} : { x, y }),
        }
      }
      const links: WLink[] = new Array(linkPairs.length / 2)
      for (let i = 0; i < links.length; i++) {
        links[i] = { source: linkPairs[i * 2], target: linkPairs[i * 2 + 1] }
      }

      // Scale tiers. HUGE drops collide (its per-tick quadtree dominates the
      // profile and the spacing it buys is sub-pixel at the zoom levels where
      // 100k nodes are on screen), relaxes Barnes-Hut precision, and cools
      // faster. Batch size shrinks so position frames stream steadily even
      // when a single tick costs hundreds of ms.
      const big = n >= 20_000
      const huge = n >= 50_000
      ticksPerBatch = huge ? 1 : big ? 2 : 5
      // Barnes-Hut theta 1.2 at scale: coarser approximation, ~2× faster
      // ticks, indistinguishable layout at the zooms where 100k nodes show.
      const charge = forceManyBody<WNode>().strength(big ? -60 : -120).theta(big ? 1.2 : 0.9)

      sim = forceSimulation<WNode, WLink>(nodes)
        // Obsidian-matched force values at normal scale (see v0.2 notes):
        // linkDistance 60, linkStrength 0.5, charge -120, collide r+4.
        .force('link', forceLink<WNode, WLink>(links).distance(60).strength(big ? 0.3 : 0.5))
        .force('charge', charge)
        .force('center', forceCenter(msg.width / 2, msg.height / 2).strength(0.1))
        // Weak positional pull keeps disconnected components from repelling
        // each other to infinity — without it a 10k-node graph spreads to a
        // ±16k-unit cloud that no zoom level can frame usefully.
        .force('x', forceX<WNode>(msg.width / 2).strength(big ? 0.08 : 0.05))
        .force('y', forceY<WNode>(msg.height / 2).strength(big ? 0.08 : 0.05))
        .alphaDecay(huge ? 0.06 : big ? 0.045 : 0.028)
        .velocityDecay(0.4)
        .alphaMin(big ? 0.005 : 0.001)
        .stop() // we drive ticks manually — no internal d3-timer in the worker
      if (!big) {
        sim.force('collision', forceCollide<WNode>(node => radiusOf(node.connections) + 4).strength(0.8))
      }
      // Stream positions from tick 0 so the first paint happens immediately —
      // a synchronous warmup blocks the first batch and reads as a blank
      // canvas. Early frames show the layout organizing: feedback, not a bug.
      postPositions()
      schedule()
      break
    }
    case 'drag': {
      const node = nodes[msg.index]
      if (node) { node.fx = msg.x; node.fy = msg.y }
      reheat(0.3)
      break
    }
    case 'dragEnd': {
      const node = nodes[msg.index]
      if (node) { node.fx = null; node.fy = null }
      if (sim) sim.alphaTarget(0) // let it cool and the loop stop on its own
      break
    }
    case 'reheat':
      reheat(msg.alpha ?? 0.3)
      break
    case 'stop':
      sim?.stop()
      sim = null
      break
  }
}
