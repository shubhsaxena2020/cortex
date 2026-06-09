// Off-main-thread D3 force layout.
//
// WHY: running the force simulation for a 10k-node graph on the main thread
// froze the window — every tick (forceManyBody + forceCollide over 10k nodes)
// is multi-millisecond, and the old code both ticked AND redrew on the main
// thread. Here the physics runs in a Worker; the main thread only renders.
//
// PROTOCOL
//   main → worker : init | drag | dragEnd | reheat | stop
//   worker → main : positions  (a transferable Float32Array of [x,y,x,y,…] in
//                               the SAME index order as the init nodes array)
//
// Positions are batched: we run TICKS_PER_BATCH ticks, post once, then yield
// (setTimeout 0 — Workers have no requestAnimationFrame) so incoming drag/stop
// messages are handled promptly. This keeps message volume ~1/batch instead of
// one per tick.

import {
  forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide,
  type Simulation, type SimulationNodeDatum, type SimulationLinkDatum,
} from 'd3-force'
import { nodeRadius } from '../utils/graph-renderer'
import type { GraphNode } from '../utils/graph-builder'

interface WNode extends SimulationNodeDatum {
  id: string
  connections: number
}
type WLink = SimulationLinkDatum<WNode> & { edgeType?: string; strength?: number }

type InitMsg = {
  type: 'init'
  nodes: { id: string; connections: number; x?: number; y?: number }[]
  links: { source: string; target: string; edgeType?: string; strength?: number }[]
  width: number
  height: number
}
type InMsg =
  | InitMsg
  | { type: 'drag'; id: string; x: number; y: number }
  | { type: 'dragEnd'; id: string }
  | { type: 'reheat'; alpha?: number }
  | { type: 'stop' }

// Cast `self` to a minimal worker surface — avoids pulling in the WebWorker lib
// (which conflicts with the DOM lib's `self`/`postMessage` typings used by the
// rest of the renderer tsconfig).
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<InMsg>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

const TICKS_PER_BATCH = 5
const WARMUP_TICKS = 100

let sim: Simulation<WNode, WLink> | null = null
let nodes: WNode[] = []
let byId = new Map<string, WNode>()
let scheduled = false

// Collide radius must match the renderer's node radius so layout spacing and
// drawn discs agree. Reuse nodeRadius (it only reads `.connections`); the cast
// is safe because WNode carries that field.
function collideRadius(n: WNode): number {
  return nodeRadius(n as unknown as GraphNode) + 3
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
  for (let i = 0; i < TICKS_PER_BATCH; i++) sim.tick()
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
      nodes = msg.nodes.map(n => ({ id: n.id, connections: n.connections, x: n.x, y: n.y }))
      byId = new Map(nodes.map(n => [n.id, n]))
      const links: WLink[] = msg.links.map(l => ({ source: l.source, target: l.target }))
      sim = forceSimulation<WNode, WLink>(nodes)
        // Redesigned force parameters (P1 #4 visual overhaul):
        // - linkDistance varies by edge type: 60-100px for relationships (based on strength),
        //   80px for mention edges. Much tighter than the old 250px which spread too thin.
        // - linkStrength: 0.4 for relationships (moderate pull), 0.2 for mentions (weak).
        // - charge: degree-based repulsion so high-degree hubs push clusters apart.
        // - collide: keep nodes from overlapping using degree-based radius.
        // - alphaDecay 0.02: slower cooling lets nodes settle into better positions.
        .force('link', forceLink<WNode, WLink>(links).id(d => d.id)
          .distance(l => {
            const wl = l as WLink & { edgeType?: string; strength?: number }
            if (wl.edgeType === 'relationship') return 60 + (1 - (wl.strength ?? 0.5)) * 40
            return 80
          })
          .strength(l => {
            const wl = l as WLink & { edgeType?: string }
            if (wl.edgeType === 'relationship') return 0.4
            return 0.2
          })
        )
        .force('charge', forceManyBody<WNode>()
          .strength(d => -200 - (d.connections ?? 1) * 15)
          .distanceMax(400)
        )
        .force('center', forceCenter(msg.width / 2, msg.height / 2).strength(0.08))
        .force('collision', forceCollide<WNode>(collideRadius).strength(0.8))
        .alphaDecay(0.02)
        .velocityDecay(0.4)
        .alphaMin(0.001)
        .stop() // we drive ticks manually — no internal d3-timer in the worker
      // Warm up offline so the first frame the user sees is already laid out.
      for (let i = 0; i < WARMUP_TICKS; i++) sim.tick()
      postPositions()
      schedule()
      break
    }
    case 'drag': {
      const n = byId.get(msg.id)
      if (n) { n.fx = msg.x; n.fy = msg.y }
      reheat(0.3)
      break
    }
    case 'dragEnd': {
      const n = byId.get(msg.id)
      if (n) { n.fx = null; n.fy = null }
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
