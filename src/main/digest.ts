// Daily / weekly digest (v0.4 thesis #3).
//
// Pure data assembly — given a window of memories and their (possibly
// missing) summaries, produce a structured digest. Ollama is invoked
// elsewhere (summary-runner.ts) so this module is unit-testable.

export type DigestWindow = 'day' | 'week'

export interface DigestMemory {
  id: string
  title: string
  source: string
  tags: string[]
  updatedAt: number
  oneLine: string | null
}

export interface DigestGroup {
  /** Tag or '(untagged)'. */
  label: string
  memories: DigestMemory[]
}

export interface Digest {
  window: DigestWindow
  since: number
  until: number
  totalMemories: number
  groups: DigestGroup[]
  /** Top tags seen in this window, ordered by count. */
  topTags: Array<{ tag: string; count: number }>
  /** Memories that landed but have no tags — surfaced as a separate group. */
  untaggedCount: number
}

export function windowStart(window: DigestWindow, now = Date.now()): number {
  const ms = window === 'day' ? 24 * 3600_000 : 7 * 24 * 3600_000
  return now - ms
}

export function buildDigest(
  window: DigestWindow,
  memories: DigestMemory[],
  now = Date.now(),
  maxPerGroup = 5,
): Digest {
  const since = windowStart(window, now)
  // Count tag occurrences across the window; the topN drive the groups.
  const tagCounts = new Map<string, number>()
  for (const m of memories) {
    for (const t of m.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([tag, count]) => ({ tag, count }))

  // Bucket memories under their FIRST top tag so each memory appears once.
  const topTagSet = new Set(topTags.map(t => t.tag))
  const groupsMap = new Map<string, DigestMemory[]>()
  for (const t of topTags) groupsMap.set(t.tag, [])
  const untagged: DigestMemory[] = []

  for (const m of memories) {
    const primary = m.tags.find(t => topTagSet.has(t))
    if (primary) {
      groupsMap.get(primary)!.push(m)
    } else if (m.tags.length === 0) {
      untagged.push(m)
    } else {
      // Has tags, but none in the top set — bucket under the first one anyway
      // so the user still sees it, with a per-memory label.
      const other = m.tags[0]
      let arr = groupsMap.get(other)
      if (!arr) { arr = []; groupsMap.set(other, arr) }
      arr.push(m)
    }
  }

  const groups: DigestGroup[] = []
  for (const t of topTags) {
    const arr = groupsMap.get(t.tag) ?? []
    if (arr.length === 0) continue
    groups.push({ label: t.tag, memories: arr.slice(0, maxPerGroup) })
  }
  // Non-top tags that picked up memories (long-tail) — collapsed into one group.
  const longTail: DigestMemory[] = []
  for (const [tag, arr] of groupsMap) {
    if (topTagSet.has(tag)) continue
    longTail.push(...arr)
  }
  if (longTail.length > 0) {
    groups.push({ label: 'other', memories: longTail.slice(0, maxPerGroup) })
  }
  if (untagged.length > 0) {
    groups.push({ label: '(untagged)', memories: untagged.slice(0, maxPerGroup) })
  }

  return {
    window,
    since,
    until: now,
    totalMemories: memories.length,
    groups,
    topTags,
    untaggedCount: untagged.length,
  }
}

/** Plain-text digest for `cortex digest` and email-style copy. */
export function renderDigestText(d: Digest): string {
  const lines: string[] = []
  const wLabel = d.window === 'day' ? 'today' : 'this week'
  lines.push(`# Cortex digest — ${wLabel}`)
  lines.push(`${d.totalMemories} memories · ${d.topTags.length} top tags`)
  lines.push('')
  if (d.totalMemories === 0) {
    lines.push('Nothing new captured in this window.')
    return lines.join('\n')
  }
  for (const g of d.groups) {
    lines.push(`## ${g.label}`)
    for (const m of g.memories) {
      const sub = m.oneLine ?? m.title
      lines.push(`  - ${sub}`)
    }
    lines.push('')
  }
  return lines.join('\n').trim()
}
