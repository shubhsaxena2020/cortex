// Renderer-side wiki-link helpers (v0.3.0).
//
// Mirrors the parsing rules of src/main/wiki-links.ts but serves rendering:
// splitting text into segments for clickable previews, and rewriting
// [[links]] into markdown so ReactMarkdown can render them via a custom
// anchor component.

export type WikiSegment =
  | { type: 'text'; value: string }
  | { type: 'link'; target: string; label: string }

const WIKI_LINK_RE = /\[\[([^[\]]+?)\]\]/g

/** Href prefix used to smuggle wiki targets through markdown anchors. */
export const WIKI_HREF_PREFIX = '#wiki='

export function splitWikiSegments(text: string): WikiSegment[] {
  if (!text) return []
  const segments: WikiSegment[] = []
  let last = 0
  for (const match of text.matchAll(WIKI_LINK_RE)) {
    const idx = match.index ?? 0
    const inner = match[1]
    const pipe = inner.indexOf('|')
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
    const label = (pipe === -1 ? inner : inner.slice(pipe + 1)).trim() || target
    if (!target) continue
    if (idx > last) segments.push({ type: 'text', value: text.slice(last, idx) })
    segments.push({ type: 'link', target, label })
    last = idx + match[0].length
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) })
  return segments
}

/**
 * Rewrite [[Target]] / [[Target|alias]] into markdown links with a #wiki=
 * href so the editor preview can render them through ReactMarkdown.
 */
export function wikiToMarkdown(content: string): string {
  if (!content || !content.includes('[[')) return content
  return content.replace(WIKI_LINK_RE, (_m, inner: string) => {
    const pipe = inner.indexOf('|')
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
    const label = (pipe === -1 ? inner : inner.slice(pipe + 1)).trim() || target
    if (!target) return _m
    return `[${label}](${WIKI_HREF_PREFIX}${encodeURIComponent(target)})`
  })
}

/** Extract the wiki target from an anchor href produced by wikiToMarkdown. */
export function wikiTargetFromHref(href: string | undefined): string | null {
  if (!href || !href.startsWith(WIKI_HREF_PREFIX)) return null
  try {
    return decodeURIComponent(href.slice(WIKI_HREF_PREFIX.length))
  } catch {
    return null
  }
}

/** Lowercased title → memory id (first wins), for link resolution in the UI. */
export function titleIndexOf(memories: Array<{ id: string; title: string }>): Map<string, string> {
  const index = new Map<string, string>()
  for (const m of memories) {
    const key = m.title.trim().toLowerCase()
    if (key && !index.has(key)) index.set(key, m.id)
  }
  return index
}
