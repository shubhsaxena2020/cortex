import { describe, it, expect } from 'vitest'
import { splitWikiSegments, wikiToMarkdown, wikiTargetFromHref, titleIndexOf } from './wiki-text'

describe('splitWikiSegments', () => {
  it('splits text around links', () => {
    expect(splitWikiSegments('see [[Note A]] and [[Note B|b]]!')).toEqual([
      { type: 'text', value: 'see ' },
      { type: 'link', target: 'Note A', label: 'Note A' },
      { type: 'text', value: ' and ' },
      { type: 'link', target: 'Note B', label: 'b' },
      { type: 'text', value: '!' },
    ])
  })

  it('returns one text segment when no links exist', () => {
    expect(splitWikiSegments('plain')).toEqual([{ type: 'text', value: 'plain' }])
  })

  it('returns empty for empty input', () => {
    expect(splitWikiSegments('')).toEqual([])
  })

  it('skips empty targets', () => {
    expect(splitWikiSegments('[[ ]]x')).toEqual([{ type: 'text', value: '[[ ]]x' }])
  })
})

describe('wikiToMarkdown', () => {
  it('rewrites links with encoded hrefs', () => {
    expect(wikiToMarkdown('go [[My Note]]')).toBe('go [My Note](#wiki=My%20Note)')
  })

  it('uses alias as the label', () => {
    expect(wikiToMarkdown('[[Target|click here]]')).toBe('[click here](#wiki=Target)')
  })

  it('passes through content without links untouched', () => {
    expect(wikiToMarkdown('# heading\n**bold**')).toBe('# heading\n**bold**')
  })
})

describe('wikiTargetFromHref', () => {
  it('round-trips with wikiToMarkdown', () => {
    expect(wikiTargetFromHref('#wiki=My%20Note')).toBe('My Note')
  })

  it('returns null for normal hrefs', () => {
    expect(wikiTargetFromHref('https://example.com')).toBeNull()
    expect(wikiTargetFromHref(undefined)).toBeNull()
  })
})

describe('titleIndexOf', () => {
  it('is case-insensitive and first-wins', () => {
    const index = titleIndexOf([
      { id: 'a', title: 'Dup' },
      { id: 'b', title: 'dup' },
    ])
    expect(index.get('dup')).toBe('a')
  })
})
