// Search history + saved searches.
//
// Pure functions over a Storage-like interface so the logic is unit-testable
// in the node test environment (no jsdom). The renderer passes
// window.localStorage; tests pass an in-memory stub.

export interface SearchEntry {
  query: string
  source?: string
  tags?: string[]
  /** epoch ms — supplied by the caller so the module stays pure */
  at: number
}

export interface SavedSearch extends SearchEntry {
  name: string
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const HISTORY_KEY = 'cortex.search.history'
export const SAVED_KEY = 'cortex.search.saved'
export const HISTORY_LIMIT = 20

function readJson<T>(storage: StorageLike, key: string): T[] {
  try {
    const raw = storage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Two entries match when query + filters are identical (order-insensitive tags). */
export function sameSearch(a: SearchEntry, b: SearchEntry): boolean {
  if (a.query.trim().toLowerCase() !== b.query.trim().toLowerCase()) return false
  if ((a.source ?? '') !== (b.source ?? '')) return false
  const ta = [...(a.tags ?? [])].sort().join(',')
  const tb = [...(b.tags ?? [])].sort().join(',')
  return ta === tb
}

export function loadHistory(storage: StorageLike): SearchEntry[] {
  return readJson<SearchEntry>(storage, HISTORY_KEY)
}

/**
 * Add an entry to the front of history. Duplicates of an existing entry move
 * to the front instead of repeating; the list is capped at HISTORY_LIMIT.
 * Blank queries with no filters are ignored.
 */
export function addToHistory(storage: StorageLike, entry: SearchEntry): SearchEntry[] {
  if (!entry.query.trim() && !(entry.tags?.length) && !entry.source) {
    return loadHistory(storage)
  }
  const next = [entry, ...loadHistory(storage).filter(e => !sameSearch(e, entry))].slice(0, HISTORY_LIMIT)
  storage.setItem(HISTORY_KEY, JSON.stringify(next))
  return next
}

export function clearHistory(storage: StorageLike): void {
  storage.setItem(HISTORY_KEY, JSON.stringify([]))
}

export function loadSaved(storage: StorageLike): SavedSearch[] {
  return readJson<SavedSearch>(storage, SAVED_KEY)
}

/** Save a named search. Re-using a name overwrites that entry. */
export function saveSearch(storage: StorageLike, search: SavedSearch): SavedSearch[] {
  const name = search.name.trim()
  if (!name) return loadSaved(storage)
  const next = [{ ...search, name }, ...loadSaved(storage).filter(s => s.name !== name)]
  storage.setItem(SAVED_KEY, JSON.stringify(next))
  return next
}

export function deleteSaved(storage: StorageLike, name: string): SavedSearch[] {
  const next = loadSaved(storage).filter(s => s.name !== name)
  storage.setItem(SAVED_KEY, JSON.stringify(next))
  return next
}
