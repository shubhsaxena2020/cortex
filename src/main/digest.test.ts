import { describe, it, expect } from 'vitest'
import { buildDigest, renderDigestText, windowStart, type DigestMemory } from './digest'

const NOW = 1_780_000_000_000

function mem(id: string, tags: string[], oneLine: string | null = null): DigestMemory {
  return { id, title: `Title ${id}`, source: 'claude', tags, updatedAt: NOW, oneLine }
}

describe('windowStart', () => {
  it('returns the right offset for day vs week', () => {
    expect(windowStart('day', NOW)).toBe(NOW - 86_400_000)
    expect(windowStart('week', NOW)).toBe(NOW - 7 * 86_400_000)
  })
})

describe('buildDigest', () => {
  it('handles an empty window cleanly', () => {
    const d = buildDigest('day', [], NOW)
    expect(d.totalMemories).toBe(0)
    expect(d.groups).toEqual([])
    expect(d.topTags).toEqual([])
  })

  it('groups by top tags ordered by count', () => {
    const memories = [
      mem('1', ['rust']),
      mem('2', ['rust']),
      mem('3', ['rust']),
      mem('4', ['react']),
      mem('5', ['react']),
      mem('6', ['db']),
    ]
    const d = buildDigest('day', memories, NOW)
    expect(d.topTags.map(t => t.tag)).toEqual(['rust', 'react', 'db'])
    expect(d.groups[0].label).toBe('rust')
    expect(d.groups[0].memories).toHaveLength(3)
    expect(d.groups[1].label).toBe('react')
  })

  it('places each memory under exactly one top-tag bucket', () => {
    const memories = [
      mem('a', ['rust', 'react']),
      mem('b', ['react', 'rust']),
    ]
    const d = buildDigest('day', memories, NOW)
    // rust and react each have 2 occurrences — first alphabetically wins as primary.
    const flat = d.groups.flatMap(g => g.memories.map(m => m.id))
    expect(flat.sort()).toEqual(['a', 'b'])
  })

  it('produces a separate (untagged) group for tagless memories', () => {
    const memories = [mem('1', []), mem('2', ['rust'])]
    const d = buildDigest('day', memories, NOW)
    expect(d.untaggedCount).toBe(1)
    expect(d.groups.some(g => g.label === '(untagged)')).toBe(true)
  })

  it('collapses non-top tags into a single "other" group', () => {
    // 6 distinct tags → only top 6 become groups; introduce a 7th tag.
    const memories = [
      ...Array.from({ length: 6 }, (_, i) => mem(`top${i}`, [`tag${i}`])),
      ...Array.from({ length: 6 }, (_, i) => mem(`top${i}-extra`, [`tag${i}`])),
      mem('rare', ['rare-tag']),
    ]
    const d = buildDigest('day', memories, NOW)
    expect(d.topTags.map(t => t.tag)).not.toContain('rare-tag')
    expect(d.groups.some(g => g.label === 'other')).toBe(true)
  })

  it('caps members per group', () => {
    const memories = Array.from({ length: 10 }, (_, i) => mem(`m${i}`, ['rust']))
    const d = buildDigest('day', memories, NOW, 3)
    expect(d.groups[0].memories).toHaveLength(3)
  })
})

describe('renderDigestText', () => {
  it('renders an empty digest with a clear placeholder', () => {
    const d = buildDigest('day', [], NOW)
    expect(renderDigestText(d)).toContain('Nothing new captured')
  })

  it('uses one-line summaries when present, falls back to title', () => {
    const memories = [
      mem('1', ['rust'], 'fixed sqlite migration bug'),
      mem('2', ['rust']),
    ]
    const d = buildDigest('day', memories, NOW)
    const out = renderDigestText(d)
    expect(out).toContain('fixed sqlite migration bug')
    expect(out).toContain('Title 2')
  })

  it('uses "today" vs "this week" headings', () => {
    expect(renderDigestText(buildDigest('day', [], NOW))).toContain('today')
    expect(renderDigestText(buildDigest('week', [], NOW))).toContain('this week')
  })
})
