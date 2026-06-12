// Wiki-link parsing + resolution (v0.3.0 bidirectional links).
//
// Pure functions only — no DB access. Persistence lives in wiki-edges.ts;
// queries live in db.ts. Syntax follows Obsidian: [[Target Title]] links to
// the memory whose title matches (case-insensitive), [[Target|alias]] renders
// as "alias". Simplification vs Obsidian: links inside code blocks are still
// parsed (documented trade-off — content here is chat transcripts, where
// fenced blocks legitimately reference notes).

const WIKI_LINK_RE = /\[\[([^[\]]+?)\]\]/g
const MAX_TARGET_LEN = 200

/** The link target of one `[[...]]` occurrence (alias stripped, trimmed). */
export function parseTarget(inner: string): string | null {
  const target = inner.split('|')[0].trim()
  if (!target || target.length > MAX_TARGET_LEN) return null
  return target
}

/**
 * Extract unique wiki-link targets from content, in order of first occurrence.
 * Case-insensitive dedupe; the first-seen casing is preserved.
 */
export function extractWikiLinks(content: string): string[] {
  if (!content || !content.includes('[[')) return []
  const seen = new Set<string>()
  const targets: string[] = []
  for (const match of content.matchAll(WIKI_LINK_RE)) {
    const target = parseTarget(match[1])
    if (!target) continue
    const key = target.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    targets.push(target)
  }
  return targets
}

/**
 * Lowercased title → memory id. First memory wins on duplicate titles, which
 * matches Obsidian's "first match" behavior for ambiguous links.
 */
export function buildTitleIndex(rows: Array<{ id: string; title: string }>): Map<string, string> {
  const index = new Map<string, string>()
  for (const row of rows) {
    const key = row.title.trim().toLowerCase()
    if (key && !index.has(key)) index.set(key, row.id)
  }
  return index
}

export interface ResolvedLinks {
  resolved: Array<{ title: string; id: string }>
  unresolved: string[]
}

/** Split targets into memories that exist vs dangling link text. */
export function resolveLinks(targets: string[], index: Map<string, string>): ResolvedLinks {
  const resolved: Array<{ title: string; id: string }> = []
  const unresolved: string[] = []
  for (const target of targets) {
    const id = index.get(target.toLowerCase())
    if (id) resolved.push({ title: target, id })
    else unresolved.push(target)
  }
  return { resolved, unresolved }
}
