import { describe, it, expect } from 'vitest'
import { buildAdjacency, highlightPath, pulsePhase } from './graph-interaction'
import type { GraphNode } from './graph-builder'

const n = (id: string): GraphNode => ({
  id, title: id, nodeType: 'memory', color: '#fff', baseR: 4, connections: 0,
})

describe('buildAdjacency', () => {
  it('builds undirected neighbour sets', () => {
    const nodes = ['a', 'b', 'c'].map(n)
    const links = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ]
    const adj = buildAdjacency(nodes, links)
    expect([...adj.get('a')!.neighbours]).toEqual(['b'])
    expect([...adj.get('b')!.neighbours].sort()).toEqual(['a', 'c'])
    expect([...adj.get('c')!.neighbours]).toEqual(['b'])
  })

  it('handles GraphNode-typed link endpoints', () => {
    const nodes = ['a', 'b'].map(n)
    const adj = buildAdjacency(nodes, [{ source: nodes[0], target: nodes[1] }])
    expect(adj.get('a')!.neighbours.has('b')).toBe(true)
  })
})

describe('highlightPath', () => {
  // a — b — c — d — e
  const nodes = ['a', 'b', 'c', 'd', 'e'].map(n)
  const adj = buildAdjacency(nodes, [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
    { source: 'c', target: 'd' },
    { source: 'd', target: 'e' },
  ])

  it('depth=0 returns just the source', () => {
    expect([...highlightPath('c', 0, adj)]).toEqual(['c'])
  })
  it('depth=1 returns source + direct neighbours', () => {
    expect([...highlightPath('c', 1, adj)].sort()).toEqual(['b', 'c', 'd'])
  })
  it('depth=2 expands one more hop', () => {
    expect([...highlightPath('c', 2, adj)].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
  it('handles unknown nodes without throwing', () => {
    expect([...highlightPath('zzz', 2, adj)]).toEqual(['zzz'])
  })
})

describe('pulsePhase', () => {
  it('returns a value in [0, 1)', () => {
    for (const ms of [0, 100, 800, 1599, 99999]) {
      const p = pulsePhase(ms, 1600)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(1)
    }
  })
  it('is periodic', () => {
    expect(pulsePhase(100, 1000)).toBeCloseTo(pulsePhase(1100, 1000), 10)
  })
})
