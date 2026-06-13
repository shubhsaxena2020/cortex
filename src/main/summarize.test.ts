import { describe, it, expect } from 'vitest'
import { contentHash, isFresh, clampInput, cleanOutput, capWords } from './summarize'

describe('contentHash', () => {
  it('is stable for the same input', () => {
    const a = contentHash('Title', 'Body')
    const b = contentHash('Title', 'Body')
    expect(a).toBe(b)
  })

  it('changes when title or content changes', () => {
    const base = contentHash('Title', 'Body')
    expect(contentHash('Title!', 'Body')).not.toBe(base)
    expect(contentHash('Title', 'Body!')).not.toBe(base)
  })

  it('trims whitespace at the boundary', () => {
    expect(contentHash('  Title  ', 'Body')).toBe(contentHash('Title', 'Body'))
  })
})

describe('isFresh', () => {
  it('is true for matching hashes', () => {
    expect(isFresh('abc', 'abc')).toBe(true)
  })

  it('is false for missing or different cached hashes', () => {
    expect(isFresh('abc', null)).toBe(false)
    expect(isFresh('abc', undefined)).toBe(false)
    expect(isFresh('abc', 'xyz')).toBe(false)
  })
})

describe('clampInput', () => {
  it('passes short input through', () => {
    expect(clampInput('hi')).toBe('hi')
  })

  it('truncates at a word boundary when possible', () => {
    const text = 'word '.repeat(2000).trim() // 9999 chars, well over MAX_INPUT_CHARS
    const out = clampInput(text)
    expect(out.length).toBeLessThanOrEqual(6000)
    expect(out.endsWith(' ')).toBe(false)
    // Should not split mid-word
    expect(out.endsWith('word')).toBe(true)
  })

  it('hard-cuts when no good word boundary exists', () => {
    const text = 'x'.repeat(8000)
    const out = clampInput(text)
    expect(out.length).toBe(6000)
  })
})

describe('cleanOutput', () => {
  it('strips conversational preambles', () => {
    expect(cleanOutput("Here's a summary: User asked about auth flow.", true)).toBe(
      'User asked about auth flow'
    )
    expect(cleanOutput('Sure! Authentication redesign.', true)).toBe('Authentication redesign')
    expect(cleanOutput('Summary: Quadtree culling shipped.', true)).toBe('Quadtree culling shipped')
  })

  it('strips quotes and trailing punctuation on one-liners', () => {
    expect(cleanOutput('"Hello world."', true)).toBe('Hello world')
  })

  it('collapses internal whitespace in paragraphs', () => {
    expect(cleanOutput('A\n\n  B\tC', false)).toBe('A B C')
  })

  it('keeps the first line only for one-liners', () => {
    expect(cleanOutput('First line\nsecond line\nthird', true)).toBe('First line')
  })

  it('returns empty for empty input', () => {
    expect(cleanOutput('', true)).toBe('')
    expect(cleanOutput('', false)).toBe('')
  })
})

describe('capWords', () => {
  it('passes input through under the cap', () => {
    expect(capWords('one two three', 5)).toBe('one two three')
  })

  it('truncates at the word cap with ellipsis', () => {
    expect(capWords('one two three four five six', 3)).toBe('one two three…')
  })
})
