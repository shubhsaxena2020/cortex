// Tiny YAML-frontmatter reader. We only need to pull a `url: ...` line out
// of saved conversation .md files, so we don't pull a full YAML parser as a
// dependency. The format we emit (see src/main/index.ts saveConversationToVault
// and extension/popup.js buildMarkdown) is line-oriented and predictable:
//
//   ---
//   source: claude
//   captured: 2026-06-04T20:41:00Z
//   url: https://claude.ai/chat/2f8161e4-...
//   tags: [foo, bar]
//   ---
//
// Pure function, no I/O. Tested in frontmatter.test.ts.

export interface ParsedFrontmatter {
  /** Full key→value map for every `key: value` line in the frontmatter block. */
  fields: Readonly<Record<string, string>>
  /** True if a `---\n...\n---` block was found at the top of the input. */
  hasFrontmatter: boolean
  /** Convenience accessor — null if not present. */
  url: string | null
  /** Convenience accessor — null if not present. */
  source: string | null
}

const EMPTY: ParsedFrontmatter = {
  fields: Object.freeze({}),
  hasFrontmatter: false,
  url: null,
  source: null,
}

/**
 * Extract the YAML-ish frontmatter block at the top of a Markdown document.
 * Returns an EMPTY result if no frontmatter is present — never throws.
 *
 * The implementation is line-oriented and intentionally conservative:
 *   - Only the FIRST `---` block at the top counts.
 *   - Inline `#` comments are stripped (anything after a ` # `).
 *   - Values are trimmed; surrounding quotes (`"..."` or `'...'`) are stripped.
 *   - Array/flow values (`tags: [a, b]`) are stored verbatim as the string
 *     `[a, b]`; we don't parse them. Callers needing arrays parse themselves.
 *   - Duplicate keys: last one wins (matches YAML behaviour).
 */
export function parseFrontmatter(text: string | null | undefined): ParsedFrontmatter {
  if (typeof text !== 'string' || text.length === 0) return EMPTY

  // Normalise line endings so CRLF-saved files behave identically to LF.
  const normalised = text.replace(/\r\n?/g, '\n')

  // Frontmatter must START the document. Allow at most one leading BOM.
  const body = normalised.startsWith('﻿') ? normalised.slice(1) : normalised
  if (!body.startsWith('---')) return EMPTY

  // First line must be exactly `---` (no extra content on the same line).
  const firstNewline = body.indexOf('\n')
  if (firstNewline === -1) return EMPTY
  const firstLine = body.slice(0, firstNewline).trim()
  if (firstLine !== '---') return EMPTY

  // Find the matching closing `---` on its own line.
  const rest = body.slice(firstNewline + 1)
  const closingMatch = /\n---\s*(\n|$)/.exec(rest)
  if (!closingMatch) return EMPTY
  const blockEnd = closingMatch.index
  const block = rest.slice(0, blockEnd)

  // Parse `key: value` lines. Skip blank lines.
  const fields: Record<string, string> = {}
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith('#')) continue  // full-line comment

    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue  // malformed line; ignore

    const key = line.slice(0, colonIdx).trim()
    if (key === '') continue

    let value = line.slice(colonIdx + 1).trim()

    // Strip inline ` # comment` trailing values (but not `#` inside quoted
    // strings — we don't parse YAML strict; just look for ` # ` with spaces).
    const commentIdx = value.indexOf(' # ')
    if (commentIdx !== -1) value = value.slice(0, commentIdx).trim()

    // Strip surrounding quotes if matched pair.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }

    fields[key] = value
  }

  return {
    fields: Object.freeze(fields),
    hasFrontmatter: true,
    url: fields['url'] ?? null,
    source: fields['source'] ?? null,
  }
}
