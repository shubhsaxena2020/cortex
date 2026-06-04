// Cortex — capture-filter predicates.
//
// Shared between extension/content.js (production extraction) and
// extension/filters.test.js (vitest jsdom). Lives at the extension/ root
// so a single source of truth covers both runtime and tests — preventing
// the duplicated-and-drifted-logic class of bug that caused the v0.1.0.1
// Claude truncation (see diagnostics/truncation-report.json).
//
// Loaded by popup.js via chrome.scripting.executeScript({ files: ['filters.js', 'content.js'] }).
// filters.js runs first; content.js sees globalThis.cortexFilters populated.
//
// V0.2 P0 #2 scope: filter system prompts, tool-use blocks, and empty
// responses BEFORE the message hits the POST body. The dom-walker that
// extracts message text already filters `length >= 10` chars; these
// predicates run earlier, on the candidate element itself, before we even
// reach text extraction.
//
// Predicates are PURE functions of an Element. They return true if the
// element should be SKIPPED (i.e. filtered out of the capture). Each rule
// is named so debug logs and tests can identify which one fired.

(function attachCortexFilters(scope) {
  'use strict'

  // ── ChatGPT ──────────────────────────────────────────────────────────────
  //
  // Both rules anchor on `data-message-author-role`, which is the same
  // functionally-stable attribute extractChatGPT() already uses to assign
  // human/ai roles. Adding the system + tool filters here closes the gap.

  function isChatGPTSystemMessage(el) {
    if (!el || !el.getAttribute) return false
    return el.getAttribute('data-message-author-role') === 'system'
  }

  function isChatGPTToolMessage(el) {
    if (!el || !el.getAttribute) return false
    return el.getAttribute('data-message-author-role') === 'tool'
  }

  function shouldSkipChatGPTElement(el) {
    return isChatGPTSystemMessage(el) || isChatGPTToolMessage(el)
  }

  // ── Claude ───────────────────────────────────────────────────────────────
  //
  // No filters yet. Claude.ai does NOT expose system prompts in the
  // user-visible DOM, and we don't have evidence of tool-use noise selectors
  // that need filtering. The harness is ready to receive specific rules when
  // a reproducer surfaces — add the predicate, add the fixture, ship.
  //
  // TODO(v0.2.x): if Claude introduces visible system messages or tool
  // blocks, add the per-element predicate here and the fixture under
  // tests/fixtures/.

  function shouldSkipClaudeElement(_el) {
    return false
  }

  // ── Gemini ───────────────────────────────────────────────────────────────
  //
  // No filters yet. Gemini's Web Components (`user-query`, `model-response`)
  // are symmetric; system instructions from Gems aren't currently observed
  // in the captured DOM. Same TODO as Claude — harness ready when needed.

  function shouldSkipGeminiElement(_el) {
    return false
  }

  // ── Shared: empty / loading-state text ───────────────────────────────────
  //
  // Stricter than the `length >= 10` chars guard in extractTextFromElement.
  // Filters whitespace-only, ellipsis-only, and obvious loading placeholders
  // that occasionally slip past the length guard when wrapped in markup.
  //
  // CONSERVATIVE — does NOT filter on "I cannot help with that" or other
  // model refusals; those are legitimate AI responses and the user may
  // actually want to capture them.

  const LOADING_PATTERNS = [
    /^\s*$/,
    /^[\s.…·•]+$/,
    // Loading-state phrases optionally followed by any combination of
    // dots / ellipsis / whitespace ("Loading", "Loading...", "Loading…",
    // "Please wait .", etc.). Anchored on both sides so any extra real
    // words (e.g. "Loading the model takes time") fail to match.
    /^(loading|please wait|generating|thinking)[.…\s]*$/i,
  ]

  function isPlaceholderText(text) {
    if (typeof text !== 'string') return false
    return LOADING_PATTERNS.some(re => re.test(text))
  }

  // ── Public surface ───────────────────────────────────────────────────────

  const api = {
    // Per-provider element predicates
    shouldSkipChatGPTElement,
    shouldSkipClaudeElement,
    shouldSkipGeminiElement,

    // Named ChatGPT predicates (exposed for tests + future debug logs)
    isChatGPTSystemMessage,
    isChatGPTToolMessage,

    // Shared text predicate
    isPlaceholderText,

    // Version stamp so content.js can detect a stale injection
    version: 1,
  }

  // Browser content-script context: attach to globalThis so content.js sees it.
  if (scope) scope.cortexFilters = api

  // CommonJS / vitest context: export the same surface.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null))
