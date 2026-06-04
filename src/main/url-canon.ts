// URL canonicalisation for dedup keys.
//
// Two captures of the same Claude/ChatGPT/Gemini conversation should produce
// identical dedup keys regardless of:
//   - Trailing slashes
//   - URL fragments (anchors)
//   - Tracking query params (utm_*, fbclid, gclid, ref, ref_src)
//   - Hostname case
//
// We deliberately KEEP all non-tracking query params and the full path,
// because the path is where conversation IDs live for all three providers:
//   - claude.ai/chat/<uuid>
//   - chatgpt.com/c/<uuid>
//   - gemini.google.com/app/<id>

const TRACKING_PARAM_PATTERNS: ReadonlyArray<RegExp> = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^msclkid$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^_ga$/i,
  /^mc_(cid|eid)$/i,
]

function isTrackingParam(name: string): boolean {
  return TRACKING_PARAM_PATTERNS.some(re => re.test(name))
}

/**
 * Canonicalise a URL into a stable dedup key.
 *
 * Returns null for input that isn't a parsable absolute http(s) URL. Caller
 * should treat null as "no canonical key" — usually fall back to whatever
 * the original string was (or skip dedup).
 *
 * Pure function, no I/O, fully unit-tested.
 */
export function canonicalUrl(input: string | null | undefined): string | null {
  if (typeof input !== 'string' || input.trim() === '') return null

  let parsed: URL
  try {
    parsed = new URL(input.trim())
  } catch {
    return null
  }

  // Only http(s). Mailto, chrome-extension://, file://, etc. aren't dedup-able
  // conversation URLs by definition.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  // Hostname lowercase. Note: URL parser already lowercases the host for us,
  // but we make it explicit so a future refactor can't accidentally break it.
  const host = parsed.hostname.toLowerCase()

  // Strip tracking params; preserve order of remaining ones for determinism.
  const cleanParams: Array<[string, string]> = []
  for (const [k, v] of parsed.searchParams.entries()) {
    if (!isTrackingParam(k)) cleanParams.push([k, v])
  }
  cleanParams.sort(([a], [b]) => a.localeCompare(b))

  // Path: collapse multiple slashes, strip trailing slash (except for root).
  let path = parsed.pathname.replace(/\/{2,}/g, '/')
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)

  // Reassemble. Always include protocol+host+path; query only if non-empty;
  // never include fragment.
  const query = cleanParams.length === 0
    ? ''
    : '?' + cleanParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')

  return `${parsed.protocol}//${host}${path}${query}`
}

/**
 * Same canonicalisation but returns a SHA-256-flavoured short key suitable
 * for an indexed lookup column. Used when we want a fixed-width key for
 * indexing instead of the variable-length canonical URL itself.
 *
 * (Currently we just store the canonical URL directly because URLs are
 * already short — this helper is here for future use.)
 */
export function dedupKey(input: string | null | undefined): string | null {
  return canonicalUrl(input)
}
