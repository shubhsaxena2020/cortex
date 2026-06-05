import { describe, it, expect } from 'vitest'
import { Quadtree } from './quadtree'

describe('Quadtree', () => {
  it('inserts and queries within bounds', () => {
    const t = new Quadtree<{ id: string; x: number; y: number }>({ minX: 0, minY: 0, maxX: 100, maxY: 100 })
    t.insert({ id: 'a', x: 10, y: 10 })
    t.insert({ id: 'b', x: 90, y: 90 })
    t.insert({ id: 'c', x: 50, y: 50 })

    expect(t.query({ minX: 0, minY: 0, maxX: 20, maxY: 20 }).map(n => n.id)).toEqual(['a'])
    expect(t.query({ minX: 0, minY: 0, maxX: 100, maxY: 100 }).map(n => n.id).sort()).toEqual(['a', 'b', 'c'])
    expect(t.query({ minX: 200, minY: 200, maxX: 300, maxY: 300 })).toEqual([])
  })

  it('rejects points outside its bounds', () => {
    const t = new Quadtree<{ id: string; x: number; y: number }>({ minX: 0, minY: 0, maxX: 10, maxY: 10 })
    expect(t.insert({ id: 'a', x: 100, y: 100 })).toBe(false)
    expect(t.size()).toBe(0)
  })

  it('splits when capacity exceeded and still finds all points', () => {
    const points = Array.from({ length: 200 }, (_, i) => ({
      id: `n${i}`,
      x: (i * 13.7) % 1000,
      y: (i * 7.3) % 1000,
    }))
    const t = Quadtree.build(points)
    expect(t.size()).toBe(200)
    const all = t.query({ minX: -1000, minY: -1000, maxX: 2000, maxY: 2000 })
    expect(all.length).toBe(200)
  })

  it('build sizes bounds to fit all input points', () => {
    const pts = [{ id: 'a', x: -500, y: 300 }, { id: 'b', x: 800, y: -200 }]
    const t = Quadtree.build(pts)
    expect(t.size()).toBe(2)
    expect(t.query({ minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 }).length).toBe(2)
  })

  it('survives many points at the same coordinate (depth cap)', () => {
    const t = new Quadtree<{ id: string; x: number; y: number }>({ minX: 0, minY: 0, maxX: 100, maxY: 100 })
    for (let i = 0; i < 50; i++) t.insert({ id: `n${i}`, x: 50, y: 50 })
    expect(t.size()).toBe(50)
    expect(t.query({ minX: 49, minY: 49, maxX: 51, maxY: 51 }).length).toBe(50)
  })
})
