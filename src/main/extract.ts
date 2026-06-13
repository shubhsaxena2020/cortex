// Atomic-learning extraction (v0.5 thesis #1).
//
// After a memory is summarized, an Ollama pass extracts the conversation's
// *learnings* — short sentences capturing what was decided, concluded, or
// worth remembering past this week. Each learning is stored as its own
// first-class memory with source='derived' and derived_from=<parent id>.
//
// The digest reads from learnings, not parent chats: the parent is the
// substrate, the learning is the gold. Search ranks learnings higher
// because they carry the actual signal.
//
// Single Ollama call per memory, JSON-mode output, post-processed by a
// pure parser so the failure modes (model emits prose, drops the array,
// wraps in markdown code fence) are testable.

import log from 'electron-log'

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const EXTRACT_MODEL = process.env.CORTEX_EXTRACT_MODEL || process.env.CORTEX_SUMMARY_MODEL || 'llama3.2:3b'
const MAX_INPUT_CHARS = 6000
const GEN_TIMEOUT_MS = 60_000
const MAX_LEARNINGS = 5

const SYSTEM_PROMPT = `You extract atomic learnings from a captured conversation or note.
An atomic learning is ONE complete sentence that captures something concluded, decided, learned, or worth remembering past this week.
NOT a summary. NOT a question. NOT "the user asked about X." DIRECT statements only.

Examples:
  GOOD: "SQLite FTS5's MATCH operator requires phrase-quoting for queries containing special characters."
  GOOD: "We decided to ship the CLI before the web companion because terminal usage dominates."
  BAD:  "The user asked how to use FTS5."
  BAD:  "This conversation covered SQLite indexing strategies."

Output a JSON array of 0 to ${MAX_LEARNINGS} strings. No keys, no preamble, no markdown.
If there is nothing concrete to extract, output exactly: []
Each learning must stand alone — readable months from now without the parent conversation.`

/**
 * Extract a JSON array of strings from a model response, tolerating common
 * failure modes (markdown fences, leading prose, trailing commas).
 */
export function parseLearnings(raw: string): string[] {
  if (!raw) return []
  let text = String(raw).trim()
  // Strip markdown code fences.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  // Find the first `[` and the last `]` — model may have wrapped the JSON in prose.
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start) return []
  const slice = text.slice(start, end + 1)
  try {
    const parsed = JSON.parse(slice)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((s) => typeof s === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length >= 1 && s.length <= 400)
      .slice(0, MAX_LEARNINGS)
  } catch {
    // Tolerate trailing commas — strip them and retry once.
    try {
      const cleaned = slice.replace(/,(\s*[\]}])/g, '$1')
      const parsed = JSON.parse(cleaned)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((s) => typeof s === 'string').map((s) => s.trim()).filter((s) => s.length >= 1 && s.length <= 400).slice(0, MAX_LEARNINGS)
    } catch {
      return []
    }
  }
}

export function clampInput(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) return text
  const cut = text.lastIndexOf(' ', MAX_INPUT_CHARS)
  return text.slice(0, cut > MAX_INPUT_CHARS / 2 ? cut : MAX_INPUT_CHARS)
}

/** Reject learnings that are duplicates or trivial restatements of existing ones. */
export function dedupeLearnings(candidates: string[], existing: string[] = []): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  const existingNorms = new Set(existing.map(norm))
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of candidates) {
    const n = norm(c)
    if (!n || existingNorms.has(n) || seen.has(n)) continue
    seen.add(n)
    out.push(c)
  }
  return out
}

export async function extractLearningsFromText(
  title: string,
  content: string,
): Promise<{ learnings: string[]; model: string }> {
  const prompt = clampInput(`Title: ${title}\n\n${content}`.trim())
  if (!prompt) return { learnings: [], model: EXTRACT_MODEL }
  try {
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        system: SYSTEM_PROMPT,
        prompt,
        stream: false,
        format: 'json', // ask Ollama for strict JSON; smaller models still drift
        options: { temperature: 0.2, num_predict: 600, top_p: 0.9 },
      }),
      signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
    })
    if (!r.ok) {
      log.warn(`[extract] ollama responded ${r.status}`)
      return { learnings: [], model: EXTRACT_MODEL }
    }
    const body = await r.json() as { response?: string }
    return { learnings: parseLearnings(body.response ?? ''), model: EXTRACT_MODEL }
  } catch (err) {
    log.warn('[extract] request failed:', err)
    return { learnings: [], model: EXTRACT_MODEL }
  }
}
