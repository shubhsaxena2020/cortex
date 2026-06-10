import { describe, it, expect } from 'vitest'
import {
  normalizeTag, isValidTag, renameTagInList, removeTagFromList,
  applyTagRename, applyTagDelete, parseTags, countTags,
} from './tag-ops'

describe('normalizeTag', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(normalizeTag('  Machine Learning ')).toBe('machine-learning')
  })
  it('strips invalid characters but keeps tech ones', () => {
    expect(normalizeTag('C++')).toBe('c++')
    expect(normalizeTag('C#')).toBe('c#')
    expect(normalizeTag('.NET')).toBe('.net')
    expect(normalizeTag('what?!')).toBe('what')
  })
  it('collapses and trims hyphens', () => {
    expect(normalizeTag('a---b')).toBe('a-b')
    expect(normalizeTag('-edge-')).toBe('edge')
  })
})

describe('isValidTag', () => {
  it('accepts normalized tags', () => {
    expect(isValidTag('rust-lang')).toBe(true)
  })
  it('rejects empty and unnormalized input', () => {
    expect(isValidTag('')).toBe(false)
    expect(isValidTag('Has Space')).toBe(false)
  })
})

describe('renameTagInList', () => {
  it('replaces in place preserving order', () => {
    expect(renameTagInList(['a', 'b', 'c'], 'b', 'x')).toEqual(['a', 'x', 'c'])
  })
  it('dedupes when target already present', () => {
    expect(renameTagInList(['a', 'b'], 'b', 'a')).toEqual(['a'])
  })
  it('no-ops when source absent', () => {
    expect(renameTagInList(['a'], 'z', 'x')).toEqual(['a'])
  })
})

describe('removeTagFromList', () => {
  it('removes the tag', () => {
    expect(removeTagFromList(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('applyTagRename / applyTagDelete (JSON row contract)', () => {
  it('returns updated JSON when the row contains the tag', () => {
    expect(applyTagRename('["a","b"]', 'b', 'c')).toBe('["a","c"]')
    expect(applyTagDelete('["a","b"]', 'a')).toBe('["b"]')
  })
  it('returns null for rows that do not contain the tag (skip UPDATE)', () => {
    expect(applyTagRename('["a"]', 'z', 'x')).toBeNull()
    expect(applyTagDelete('["a"]', 'z')).toBeNull()
  })
  it('treats null/corrupt JSON as empty (null result)', () => {
    expect(applyTagRename(null, 'a', 'b')).toBeNull()
    expect(applyTagRename('{bad', 'a', 'b')).toBeNull()
  })
  it('merging into an existing tag dedupes', () => {
    expect(applyTagRename('["keep","merge-me"]', 'merge-me', 'keep')).toBe('["keep"]')
  })
})

describe('parseTags', () => {
  it('drops non-string entries', () => {
    expect(parseTags('["ok", 5, null]')).toEqual(['ok'])
  })
  it('handles non-array JSON', () => {
    expect(parseTags('"str"')).toEqual([])
  })
})

describe('countTags', () => {
  it('counts across rows, sorted by count desc then name', () => {
    const out = countTags(['["a","b"]', '["b"]', '["c","b"]', null])
    expect(out).toEqual([
      { tag: 'b', count: 3 },
      { tag: 'a', count: 1 },
      { tag: 'c', count: 1 },
    ])
  })
})
