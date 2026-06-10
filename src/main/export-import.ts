// Memory export/import serialization.
//
// Pure functions — no fs, no DB. The IPC layer in index.ts handles dialogs,
// file IO, and inserting parsed memories; this module owns the formats so the
// logic is unit-testable.

export interface ExportableMemory {
  id: string
  title: string
  content: string
  source: string
  created_at: string
  updated_at: string
  tags: string[]
  url: string | null
}

export interface ImportedMemory {
  title: string
  content: string
  source: string
  tags: string[]
  url: string | null
}

export interface ImportResult {
  memories: ImportedMemory[]
  errors: string[]
}

const EXPORT_VERSION = 1
const VALID_SOURCES = new Set(['claude', 'chatgpt', 'gemini', 'manual'])

export function memoriesToJson(memories: ExportableMemory[]): string {
  return JSON.stringify({ cortexExport: EXPORT_VERSION, count: memories.length, memories }, null, 2)
}

/** RFC-4180 style escaping: wrap in quotes when the value contains , " or newline. */
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return '"' + value.replace(/"/g, '""') + '"'
  return value
}

export function memoriesToCsv(memories: ExportableMemory[]): string {
  const header = 'id,title,content,source,created_at,updated_at,tags,url'
  const rows = memories.map(m => [
    m.id, m.title, m.content, m.source, m.created_at, m.updated_at,
    m.tags.join(';'), m.url ?? '',
  ].map(csvEscape).join(','))
  return [header, ...rows].join('\r\n')
}

/**
 * Parse a Cortex JSON export (or a bare array of memory-shaped objects).
 * Invalid entries are skipped with a per-entry error rather than failing the
 * whole import.
 */
export function parseMemoriesJson(raw: string): ImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { memories: [], errors: ['File is not valid JSON'] }
  }

  const list: unknown = Array.isArray(parsed)
    ? parsed
    : (parsed as { memories?: unknown })?.memories

  if (!Array.isArray(list)) {
    return { memories: [], errors: ['JSON has no "memories" array'] }
  }

  const memories: ImportedMemory[] = []
  const errors: string[] = []
  list.forEach((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`Entry ${i}: not an object`)
      return
    }
    const e = entry as Record<string, unknown>
    const title = typeof e.title === 'string' ? e.title.trim() : ''
    const content = typeof e.content === 'string' ? e.content : ''
    if (!title && !content) {
      errors.push(`Entry ${i}: missing both title and content`)
      return
    }
    const source = typeof e.source === 'string' && VALID_SOURCES.has(e.source.toLowerCase())
      ? e.source.toLowerCase()
      : 'manual'
    const tags = Array.isArray(e.tags)
      ? e.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      : []
    const url = typeof e.url === 'string' && e.url.trim() !== '' ? e.url : null
    memories.push({ title: title || 'Untitled', content, source, tags, url })
  })

  return { memories, errors }
}
