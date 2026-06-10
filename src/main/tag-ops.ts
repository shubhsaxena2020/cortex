// Bulk tag operations — pure logic.
//
// db.ts applies these to each memory row's tags JSON; keeping the
// transformation here (operating on the raw JSON string) means the whole
// rename/delete/merge behavior is unit-testable without SQLite.

/** Roadmap §2.6.2: tags are lowercase alphanumeric + hyphens. */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9+#.-]/g, '')   // keep a few common tech chars (c++, c#, .net)
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function isValidTag(tag: string): boolean {
  return tag.length > 0 && tag === normalizeTag(tag)
}

/** Replace `from` with `to` in a tag list, deduping while preserving order. */
export function renameTagInList(tags: string[], from: string, to: string): string[] {
  const out: string[] = []
  for (const t of tags) {
    const mapped = t === from ? to : t
    if (!out.includes(mapped)) out.push(mapped)
  }
  return out
}

export function removeTagFromList(tags: string[], tag: string): string[] {
  return tags.filter(t => t !== tag)
}

/**
 * Apply a rename to a memory row's tags JSON.
 * Returns the new JSON string, or null when the row doesn't contain `from`
 * (callers skip the UPDATE for unchanged rows).
 */
export function applyTagRename(tagsJson: string | null, from: string, to: string): string | null {
  const tags = parseTags(tagsJson)
  if (!tags.includes(from)) return null
  return JSON.stringify(renameTagInList(tags, from, to))
}

/** Same contract as applyTagRename, for deletion. */
export function applyTagDelete(tagsJson: string | null, tag: string): string | null {
  const tags = parseTags(tagsJson)
  if (!tags.includes(tag)) return null
  return JSON.stringify(removeTagFromList(tags, tag))
}

export function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson) return []
  try {
    const parsed = JSON.parse(tagsJson)
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

/** Count occurrences of every tag across a set of tags-JSON values. */
export function countTags(tagsJsons: Array<string | null>): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const json of tagsJsons) {
    for (const t of parseTags(json)) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}
