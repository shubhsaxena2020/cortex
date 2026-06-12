// Auto-tagging from content (v0.3.0) — pure heuristics, no DB, no Ollama.
//
// Deterministic keyword scoring keeps tagging functional offline and
// instantly testable; an LLM tagger can layer on top later without changing
// the call sites. Design choices:
//
//  - Title words weigh 3× body words (titles are dense signal in chat captures).
//  - Existing vault tags are preferred over fresh keywords: a tag the user
//    already organizes by is worth more than a novel word, scaled by usage.
//  - "Lock" semantics live at the call sites: tags are only suggested when a
//    memory has none — existing tags are never overwritten or appended to.

import { normalizeTag, isValidTag } from './tag-ops'

const STOP_WORDS = new Set([
  'the','this','that','with','from','have','been','were','they','their',
  'will','would','should','could','about','into','than','then','when',
  'what','which','where','while','your','just','because','these','those',
  'them','also','more','most','some','such','only','very','here','there',
  'make','made','like','want','need','take','says','said','using','used',
  'does','doesn','don','can','cannot','it','its','how','why','are','is',
  'and','for','you','not','but','all','any','get','use','one','two','way',
])

const TITLE_WEIGHT = 3
const VOCAB_BONUS = 4
const MIN_WORD_LEN = 4
const MIN_SCORE = 2 // a word seen once in the body is not a tag

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter(w => w.length >= MIN_WORD_LEN && !STOP_WORDS.has(w))
}

/** True when every meaningful word of the tag appears in the token set. */
export function tagMatchesText(tag: string, tokens: Set<string>): boolean {
  const parts = tag.split('-').filter(p => p.length >= 3)
  if (parts.length === 0) return false
  return parts.every(p => tokens.has(p) || (p.length >= MIN_WORD_LEN && [...tokens].some(t => t.startsWith(p))))
}

/**
 * Suggest up to `maxTags` tags for a memory from its title + content.
 *
 * @param vocab existing tag vocabulary with usage counts (db.getTagCounts())
 */
export function suggestTags(
  title: string,
  content: string,
  vocab: Array<{ tag: string; count: number }> = [],
  maxTags = 5,
): string[] {
  const titleTokens = tokenize(title || '')
  const bodyTokens = tokenize(content || '')
  if (titleTokens.length + bodyTokens.length === 0) return []

  // Frequency scoring with title weighting.
  const scores = new Map<string, number>()
  for (const w of bodyTokens) scores.set(w, (scores.get(w) ?? 0) + 1)
  for (const w of titleTokens) scores.set(w, (scores.get(w) ?? 0) + TITLE_WEIGHT)

  const tokenSet = new Set([...titleTokens, ...bodyTokens])

  // Existing vocabulary first: a tag the user already uses, found in this
  // text, outranks any novel keyword.
  const vocabHits = vocab
    .filter(v => isValidTag(v.tag) && tagMatchesText(v.tag, tokenSet))
    .map(v => ({
      tag: v.tag,
      score: VOCAB_BONUS + Math.log2(1 + v.count) + (scores.get(v.tag) ?? 0),
    }))

  // Fresh keywords from the text itself.
  const keywordHits = [...scores.entries()]
    .filter(([, score]) => score >= MIN_SCORE)
    .map(([word, score]) => ({ tag: normalizeTag(word), score }))
    .filter(h => isValidTag(h.tag))

  const out: string[] = []
  const seen = new Set<string>()
  for (const { tag } of [...vocabHits, ...keywordHits].sort((a, b) => b.score - a.score)) {
    if (seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
    if (out.length >= maxTags) break
  }
  return out
}
