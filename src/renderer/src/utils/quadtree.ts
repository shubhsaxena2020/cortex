// Point-region quadtree for graph viewport culling.
//
// Why we have our own and not d3-quadtree: d3 ships one, but its query API
// (`visit(callback)`) is awkward for our "give me an array of nodes in this
// rectangle" use case, and we want a typed handle on the node payload. The
// implementation is ~80 lines — cheaper than wrapping d3.
//
// Capacity-split PR quadtree: a leaf holds up to CAPACITY points, then splits
// into 4 quadrants. Bounds are inclusive on min, exclusive on max so a point
// belongs to exactly one quadrant.

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface Point2D {
  x: number
  y: number
}

const CAPACITY = 8         // empirical sweet spot for 10k random points
const MAX_DEPTH = 16       // hard stop so degenerate inputs (all-same-position) don't recurse forever

interface QNode<T extends Point2D> {
  bounds: Bounds
  depth: number
  items: T[]               // populated only on leaves
  children: [QNode<T>, QNode<T>, QNode<T>, QNode<T>] | null
}

function makeNode<T extends Point2D>(bounds: Bounds, depth: number): QNode<T> {
  return { bounds, depth, items: [], children: null }
}

function within(b: Bounds, x: number, y: number): boolean {
  return x >= b.minX && x < b.maxX && y >= b.minY && y < b.maxY
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return !(a.maxX <= b.minX || a.minX >= b.maxX || a.maxY <= b.minY || a.minY >= b.maxY)
}

function subdivide<T extends Point2D>(n: QNode<T>): void {
  const { minX, minY, maxX, maxY } = n.bounds
  const midX = (minX + maxX) / 2
  const midY = (minY + maxY) / 2
  const d = n.depth + 1
  n.children = [
    makeNode<T>({ minX,      minY,      maxX: midX, maxY: midY }, d),
    makeNode<T>({ minX: midX, minY,      maxX,      maxY: midY }, d),
    makeNode<T>({ minX,      minY: midY, maxX: midX, maxY      }, d),
    makeNode<T>({ minX: midX, minY: midY, maxX,      maxY      }, d),
  ]
  // Re-distribute existing items into the new children.
  const old = n.items
  n.items = []
  for (const it of old) insertInto(n, it)
}

function insertInto<T extends Point2D>(n: QNode<T>, item: T): boolean {
  if (!within(n.bounds, item.x, item.y)) return false
  if (n.children) {
    for (const c of n.children) if (insertInto(c, item)) return true
    // Should be unreachable — children fully tile parent. Fall through to
    // leaf storage as a safety net for floating-point edge cases.
    n.items.push(item)
    return true
  }
  n.items.push(item)
  if (n.items.length > CAPACITY && n.depth < MAX_DEPTH) subdivide(n)
  return true
}

function queryInto<T extends Point2D>(n: QNode<T>, b: Bounds, out: T[]): void {
  if (!overlaps(n.bounds, b)) return
  if (n.children) {
    for (const c of n.children) queryInto(c, b, out)
    // Items may still live on this internal node (the safety-net branch).
    for (const it of n.items) if (it.x >= b.minX && it.x < b.maxX && it.y >= b.minY && it.y < b.maxY) out.push(it)
    return
  }
  for (const it of n.items) if (it.x >= b.minX && it.x < b.maxX && it.y >= b.minY && it.y < b.maxY) out.push(it)
}

export class Quadtree<T extends Point2D> {
  private root: QNode<T>
  private _size = 0

  constructor(bounds: Bounds) {
    this.root = makeNode<T>(bounds, 0)
  }

  insert(item: T): boolean {
    const ok = insertInto(this.root, item)
    if (ok) this._size++
    return ok
  }

  /** Returns items whose (x, y) lies inside `b`. Order is unspecified. */
  query(b: Bounds): T[] {
    const out: T[] = []
    queryInto(this.root, b, out)
    return out
  }

  size(): number { return this._size }

  /** Build a tree sized to fit `points` plus a margin. Avoids the gotcha of
   *  inserting points outside the root bounds (which silently get dropped). */
  static build<T extends Point2D>(points: readonly T[], margin = 100): Quadtree<T> {
    if (points.length === 0) {
      return new Quadtree({ minX: -margin, minY: -margin, maxX: margin, maxY: margin })
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of points) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    // Inflate to give the < maxX/maxY half-open interval room.
    const t = new Quadtree<T>({
      minX: minX - margin,
      minY: minY - margin,
      maxX: maxX + margin + 1,
      maxY: maxY + margin + 1,
    })
    for (const p of points) t.insert(p)
    return t
  }
}
