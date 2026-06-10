import { describe, it, expect, beforeEach } from 'vitest'
import {
  addToHistory, loadHistory, clearHistory, sameSearch,
  saveSearch, loadSaved, deleteSaved,
  HISTORY_LIMIT, type StorageLike,
} from './search-history'

function memStorage(): StorageLike {
  const m = new Map<string, string>()
  return {
    getItem: k => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v) },
  }
}

let storage: StorageLike
beforeEach(() => { storage = memStorage() })

describe('search history', () => {
  it('starts empty', () => {
    expect(loadHistory(storage)).toEqual([])
  })

  it('adds entries to the front', () => {
    addToHistory(storage, { query: 'first', at: 1 })
    addToHistory(storage, { query: 'second', at: 2 })
    const h = loadHistory(storage)
    expect(h.map(e => e.query)).toEqual(['second', 'first'])
  })

  it('moves duplicate queries to the front instead of repeating', () => {
    addToHistory(storage, { query: 'alpha', at: 1 })
    addToHistory(storage, { query: 'beta', at: 2 })
    addToHistory(storage, { query: 'alpha', at: 3 })
    const h = loadHistory(storage)
    expect(h.map(e => e.query)).toEqual(['alpha', 'beta'])
    expect(h[0].at).toBe(3)
  })

  it('treats same query with different filters as distinct', () => {
    addToHistory(storage, { query: 'q', at: 1 })
    addToHistory(storage, { query: 'q', source: 'claude', at: 2 })
    addToHistory(storage, { query: 'q', tags: ['rust'], at: 3 })
    expect(loadHistory(storage)).toHaveLength(3)
  })

  it('caps the list at HISTORY_LIMIT', () => {
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      addToHistory(storage, { query: `q${i}`, at: i })
    }
    const h = loadHistory(storage)
    expect(h).toHaveLength(HISTORY_LIMIT)
    expect(h[0].query).toBe(`q${HISTORY_LIMIT + 4}`)
  })

  it('ignores blank queries with no filters', () => {
    addToHistory(storage, { query: '   ', at: 1 })
    expect(loadHistory(storage)).toEqual([])
  })

  it('keeps blank query when filters are set', () => {
    addToHistory(storage, { query: '', source: 'gemini', at: 1 })
    expect(loadHistory(storage)).toHaveLength(1)
  })

  it('clears', () => {
    addToHistory(storage, { query: 'x', at: 1 })
    clearHistory(storage)
    expect(loadHistory(storage)).toEqual([])
  })

  it('survives corrupted storage payloads', () => {
    storage.setItem('cortex.search.history', '{not json')
    expect(loadHistory(storage)).toEqual([])
  })
})

describe('sameSearch', () => {
  it('is case-insensitive on query and order-insensitive on tags', () => {
    expect(sameSearch(
      { query: 'Rust', tags: ['a', 'b'], at: 1 },
      { query: 'rust', tags: ['b', 'a'], at: 2 },
    )).toBe(true)
  })

  it('differs on source', () => {
    expect(sameSearch(
      { query: 'q', source: 'claude', at: 1 },
      { query: 'q', source: 'gemini', at: 2 },
    )).toBe(false)
  })
})

describe('saved searches', () => {
  it('saves and loads named searches', () => {
    saveSearch(storage, { name: 'My rust notes', query: 'rust', tags: ['rust'], at: 1 })
    const s = loadSaved(storage)
    expect(s).toHaveLength(1)
    expect(s[0].name).toBe('My rust notes')
  })

  it('overwrites entries with the same name', () => {
    saveSearch(storage, { name: 'n', query: 'old', at: 1 })
    saveSearch(storage, { name: 'n', query: 'new', at: 2 })
    const s = loadSaved(storage)
    expect(s).toHaveLength(1)
    expect(s[0].query).toBe('new')
  })

  it('rejects empty names', () => {
    saveSearch(storage, { name: '  ', query: 'q', at: 1 })
    expect(loadSaved(storage)).toEqual([])
  })

  it('deletes by name', () => {
    saveSearch(storage, { name: 'a', query: '1', at: 1 })
    saveSearch(storage, { name: 'b', query: '2', at: 2 })
    deleteSaved(storage, 'a')
    expect(loadSaved(storage).map(s => s.name)).toEqual(['b'])
  })
})
