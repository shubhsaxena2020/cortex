import { describe, it, expect } from 'vitest'
import { labelOpacity, nodeRadius, nodeFill, LABEL_FADE_LO, LABEL_FADE_HI, NODE_R_MIN, NODE_R_MAX } from './graph-renderer'

const baseNode = (connections: number) => ({
  id: 'n', title: 'n', nodeType: 'memory' as const, color: '#abcdef', baseR: 4, connections,
})

describe('labelOpacity', () => {
  it('is 0 at or below LABEL_FADE_LO', () => {
    expect(labelOpacity(0)).toBe(0)
    expect(labelOpacity(LABEL_FADE_LO)).toBe(0)
  })
  it('is 1 at or above LABEL_FADE_HI', () => {
    expect(labelOpacity(LABEL_FADE_HI)).toBe(1)
    expect(labelOpacity(8)).toBe(1)
  })
  it('is monotonically non-decreasing between the thresholds', () => {
    let prev = 0
    for (let z = LABEL_FADE_LO; z <= LABEL_FADE_HI; z += 0.05) {
      const o = labelOpacity(z)
      expect(o).toBeGreaterThanOrEqual(prev)
      expect(o).toBeGreaterThanOrEqual(0)
      expect(o).toBeLessThanOrEqual(1)
      prev = o
    }
  })
})

describe('nodeRadius', () => {
  it('returns the minimum for a 0-connection node', () => {
    expect(nodeRadius(baseNode(0))).toBe(NODE_R_MIN)
  })
  it('clamps to NODE_R_MAX for arbitrarily large connection counts', () => {
    expect(nodeRadius(baseNode(10_000))).toBe(NODE_R_MAX)
  })
  it('grows monotonically with connection count', () => {
    const a = nodeRadius(baseNode(5))
    const b = nodeRadius(baseNode(20))
    expect(b).toBeGreaterThan(a)
  })
})

describe('nodeFill', () => {
  it('appends an 8-hex alpha pair to the colour', () => {
    expect(nodeFill(baseNode(1), 'normal')).toBe('#abcdefcc')
    expect(nodeFill(baseNode(1), 'dim')).toBe('#abcdef22')
    expect(nodeFill(baseNode(1), 'highlight')).toBe('#abcdefff')
    expect(nodeFill(baseNode(1), 'selected')).toBe('#abcdefff')
  })
})
