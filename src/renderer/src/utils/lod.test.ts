import { describe, it, expect } from 'vitest'
import { getDetailLevel, clusterNodes } from './lod'

describe('getDetailLevel', () => {
  it('returns far below threshold', () => {
    expect(getDetailLevel(0.1)).toBe('far')
    expect(getDetailLevel(0.49)).toBe('far')
  })
  it('returns medium in the middle band', () => {
    expect(getDetailLevel(0.5)).toBe('medium')
    expect(getDetailLevel(1.0)).toBe('medium')
    expect(getDetailLevel(1.9)).toBe('medium')
  })
  it('returns close at high zoom', () => {
    expect(getDetailLevel(2.0)).toBe('close')
    expect(getDetailLevel(8)).toBe('close')
  })
})

describe('clusterNodes', () => {
  it('buckets nearby nodes together', () => {
    const nodes = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1, y: 1 },
      { id: 'c', x: 2, y: 2 },
      { id: 'd', x: 9999, y: 9999 },
    ]
    const clusters = clusterNodes(nodes, 0.5)
    // a, b, c live in one bucket (within 80-unit cell at zoom 0.5);
    // d lives alone.
    expect(clusters.length).toBe(2)
    const sizes = clusters.map(c => c.size).sort()
    expect(sizes).toEqual([1, 3])
  })

  it('caps cluster size so a dense bucket splits into multiple clusters', () => {
    const nodes = Array.from({ length: 120 }, (_, i) => ({ id: `n${i}`, x: i * 0.01, y: 0 }))
    const clusters = clusterNodes(nodes, 1)
    expect(clusters.length).toBeGreaterThanOrEqual(3)  // ceil(120 / 50)
    for (const c of clusters) expect(c.size).toBeLessThanOrEqual(50)
  })

  it('handles empty input', () => {
    expect(clusterNodes([], 1)).toEqual([])
  })
})
