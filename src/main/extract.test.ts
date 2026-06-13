import { describe, it, expect } from 'vitest'
import { parseLearnings, dedupeLearnings, clampInput } from './extract'

describe('parseLearnings', () => {
  it('parses a bare JSON array', () => {
    expect(parseLearnings('["one", "two"]')).toEqual(['one', 'two'])
  })

  it('strips markdown code fences', () => {
    expect(parseLearnings('```json\n["alpha", "beta"]\n```')).toEqual(['alpha', 'beta'])
  })

  it('tolerates leading prose', () => {
    expect(parseLearnings('Here are the learnings:\n["x", "y"]\nDone.')).toEqual(['x', 'y'])
  })

  it('returns empty for non-arrays', () => {
    expect(parseLearnings('"just a string"')).toEqual([])
  })

  it('extracts the inner array when the model wraps it in an object', () => {
    // Permissive recovery — small models like llama3.2 occasionally wrap
    // their JSON output in a `{"learnings": [...]}` envelope despite the
    // system prompt asking for a bare array. Better to recover the array
    // than to drop the whole response.
    expect(parseLearnings('{"learnings": ["a"]}')).toEqual(['a'])
  })

  it('returns empty for malformed input', () => {
    expect(parseLearnings('')).toEqual([])
    expect(parseLearnings('not json at all')).toEqual([])
  })

  it('drops entries that are too long', () => {
    const ok = 'a respectable learning that has enough words'
    expect(parseLearnings(`["${ok}", "${'x'.repeat(500)}"]`)).toEqual([ok])
  })

  it('caps the result at five learnings', () => {
    const longList = JSON.stringify(Array.from({ length: 10 }, (_, i) => `valid learning number ${i}`))
    expect(parseLearnings(longList)).toHaveLength(5)
  })

  it('tolerates trailing commas with a retry', () => {
    expect(parseLearnings('["one valid learning entry",]')).toEqual(['one valid learning entry'])
  })

  it('handles non-string elements by dropping them', () => {
    expect(parseLearnings('["good learning entry here", 42, null, true]')).toEqual(['good learning entry here'])
  })
})

describe('dedupeLearnings', () => {
  it('drops case- and punctuation-insensitive duplicates within the batch', () => {
    expect(dedupeLearnings(['Foo bar.', 'foo bar', 'baz'])).toEqual(['Foo bar.', 'baz'])
  })

  it('drops entries matching existing learnings', () => {
    expect(dedupeLearnings(['Foo bar', 'Quux'], ['foo bar!'])).toEqual(['Quux'])
  })

  it('handles empty inputs', () => {
    expect(dedupeLearnings([])).toEqual([])
    expect(dedupeLearnings(['x'], [])).toEqual(['x'])
  })
})

describe('clampInput', () => {
  it('passes short input through', () => {
    expect(clampInput('hi')).toBe('hi')
  })

  it('truncates at a word boundary when possible', () => {
    const text = 'word '.repeat(2000).trim()
    const out = clampInput(text)
    expect(out.length).toBeLessThanOrEqual(6000)
    expect(out.endsWith('word')).toBe(true)
  })
})
