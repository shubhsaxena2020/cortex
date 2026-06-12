import { describe, it, expect } from 'vitest'
import { extractWikiLinks, buildTitleIndex, resolveLinks, parseTarget } from './wiki-links'

describe('parseTarget', () => {
  it('strips alias after pipe', () => {
    expect(parseTarget('Real Title|shown text')).toBe('Real Title')
  })

  it('trims whitespace', () => {
    expect(parseTarget('  Padded  ')).toBe('Padded')
  })

  it('rejects empty and oversized targets', () => {
    expect(parseTarget('   ')).toBeNull()
    expect(parseTarget('|alias only')).toBeNull()
    expect(parseTarget('x'.repeat(201))).toBeNull()
  })
})

describe('extractWikiLinks', () => {
  it('finds simple links', () => {
    expect(extractWikiLinks('See [[Graph Performance]] and [[Auto Edges]].'))
      .toEqual(['Graph Performance', 'Auto Edges'])
  })

  it('handles aliased links', () => {
    expect(extractWikiLinks('Read [[Cortex Architecture|the architecture doc]] first'))
      .toEqual(['Cortex Architecture'])
  })

  it('dedupes case-insensitively keeping first casing', () => {
    expect(extractWikiLinks('[[Edge Builder]] then [[edge builder]] again'))
      .toEqual(['Edge Builder'])
  })

  it('ignores malformed brackets', () => {
    expect(extractWikiLinks('[[]] [[ ]] [single] [[unclosed')).toEqual([])
  })

  it('returns empty for content without links', () => {
    expect(extractWikiLinks('no links here')).toEqual([])
    expect(extractWikiLinks('')).toEqual([])
  })

  it('handles nested-bracket noise without crossing boundaries', () => {
    // [[a]] and [[b]] are links; the stray ]] between them is ignored
    expect(extractWikiLinks('[[a]] ]] [[b]]')).toEqual(['a', 'b'])
  })
})

describe('buildTitleIndex', () => {
  it('maps lowercased titles to ids, first wins on duplicates', () => {
    const index = buildTitleIndex([
      { id: 'm1', title: 'Graph Performance' },
      { id: 'm2', title: 'graph performance' },
      { id: 'm3', title: 'Other' },
    ])
    expect(index.get('graph performance')).toBe('m1')
    expect(index.get('other')).toBe('m3')
    expect(index.size).toBe(2)
  })

  it('skips blank titles', () => {
    expect(buildTitleIndex([{ id: 'm1', title: '   ' }]).size).toBe(0)
  })
})

describe('resolveLinks', () => {
  const index = buildTitleIndex([
    { id: 'm1', title: 'Known Note' },
  ])

  it('splits resolved from unresolved', () => {
    const { resolved, unresolved } = resolveLinks(['known note', 'Ghost Note'], index)
    expect(resolved).toEqual([{ title: 'known note', id: 'm1' }])
    expect(unresolved).toEqual(['Ghost Note'])
  })

  it('handles empty input', () => {
    expect(resolveLinks([], index)).toEqual({ resolved: [], unresolved: [] })
  })
})
