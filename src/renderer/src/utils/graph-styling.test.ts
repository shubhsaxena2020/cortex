import { describe, it, expect } from 'vitest'
import { edgeColor, nodeSize, toSigmaNode, toSigmaEdge, initialPosition } from './graph-styling'
import type { GraphLink, GraphNode } from './graph-builder'

describe('edgeColor', () => {
  it('maps the three signal types to the spec colors', () => {
    expect(edgeColor({ signalType: 'auto:tag', edgeType: 'relationship' })).toBe('#4A9EFF')
    expect(edgeColor({ signalType: 'auto:keyword', edgeType: 'relationship' })).toBe('#FFD700')
    expect(edgeColor({ signalType: 'auto:embedding', edgeType: 'relationship' })).toBe('#A855F7')
  })

  it('treats wiki links as emerald (v0.3 carry-over)', () => {
    expect(edgeColor({ signalType: 'wiki', edgeType: 'relationship' })).toBe('#10b981')
  })

  it('dims mention edges by default', () => {
    expect(edgeColor({ edgeType: 'mention' })).toBe('#333')
  })

  it('falls back to grey for manual or unknown signal types', () => {
    expect(edgeColor({ signalType: 'manual', edgeType: 'relationship' })).toBe('#666')
    expect(edgeColor({ edgeType: 'relationship' })).toBe('#666')
  })
})

describe('nodeSize', () => {
  it('returns the spec formula clamped to [4, 20]', () => {
    expect(nodeSize(0)).toBe(4)
    expect(nodeSize(1)).toBeCloseTo(4)   // sqrt(1)*3 = 3 → clamp up to 4
    expect(nodeSize(9)).toBe(9)          // sqrt(9)*3 = 9
    expect(nodeSize(100)).toBe(20)       // sqrt(100)*3 = 30 → clamp to 20
  })

  it('defends against NaN / negative inputs', () => {
    expect(nodeSize(NaN)).toBe(4)
    expect(nodeSize(-5)).toBe(4)
  })
})

const baseNode = (over: Partial<GraphNode> = {}): GraphNode => ({
  id: 'n1',
  title: 'Test',
  nodeType: 'memory',
  color: '#7C3AED',
  baseR: 6,
  connections: 0,
  source: 'claude',
  ...over,
})

describe('toSigmaNode', () => {
  it('preserves the raw node for click-back', () => {
    const node = baseNode({ connections: 16 })
    const attrs = toSigmaNode(node, { x: 12, y: 34 })
    expect(attrs.rawNode).toBe(node)
    expect(attrs.x).toBe(12)
    expect(attrs.y).toBe(34)
    expect(attrs.size).toBe(12) // sqrt(16)*3 = 12
    expect(attrs.label).toBe('Test')
    expect(attrs.color).toBe('#7C3AED')
  })
})

describe('toSigmaEdge', () => {
  it('maps strength to edge thickness within a sane band', () => {
    const link: GraphLink = { source: 'a', target: 'b', edgeType: 'relationship', signalType: 'auto:tag', strength: 0.7 }
    const attrs = toSigmaEdge(link)
    expect(attrs.color).toBe('#4A9EFF')
    expect(attrs.size).toBeGreaterThanOrEqual(0.4)
    expect(attrs.size).toBeLessThanOrEqual(2.5)
    expect(attrs.strength).toBe(0.7)
    expect(attrs.dashed).toBe(false)
  })

  it('dashes mention edges and defaults missing strength to 0.5', () => {
    const link: GraphLink = { source: 'a', target: 'b', edgeType: 'mention' }
    const attrs = toSigmaEdge(link)
    expect(attrs.dashed).toBe(true)
    expect(attrs.strength).toBe(0.5)
  })
})

describe('initialPosition', () => {
  it('returns origin for empty input', () => {
    expect(initialPosition(0, 0)).toEqual({ x: 0, y: 0 })
  })

  it('is deterministic — same (index,total) yields same position', () => {
    expect(initialPosition(3, 10)).toEqual(initialPosition(3, 10))
  })

  it('spreads nodes outward as index grows (radius monotonic)', () => {
    const r0 = Math.hypot(initialPosition(0, 100).x, initialPosition(0, 100).y)
    const r99 = Math.hypot(initialPosition(99, 100).x, initialPosition(99, 100).y)
    expect(r99).toBeGreaterThan(r0)
  })
})
