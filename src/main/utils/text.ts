// Shared text utilities for the Cortex backend.
// Extracted from http.ts so both the HTTP layer and edge-builder can use them.

const STOP_WORDS = new Set([
  'the','this','that','with','from','have','been','were','they','their',
  'will','would','should','could','about','into','than','then','when',
  'what','which','where','while','your','just','because','these','those',
  'them','also','more','most','some','such','only','very','here','there',
  'them','also','make','made','like','want','need','take','says','said',
])

/**
 * Extract meaningful keywords from text.
 * Returns unique lowercased words >4 chars, filtered by stop-word list.
 */
export function extractKeywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
  return new Set(words)
}

/**
 * Jaccard similarity between two sets.
 * Returns |intersection| / |union|, or 0 if both sets are empty.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a]
  smaller.forEach(item => {
    if (larger.has(item)) intersection++
  })
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}
