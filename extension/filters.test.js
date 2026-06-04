// @vitest-environment jsdom
//
// Tests for extension/filters.js capture predicates.
//
// jsdom env is REQUIRED — predicates take real Element instances and call
// .getAttribute(). vitest's node env doesn't expose document/Element, so a
// per-file env header puts THIS file in jsdom while every other test stays
// on the cheaper node env.
//
// The same module is loaded in production by Chrome (sets globalThis.cortexFilters)
// and here by vitest (CommonJS require returns the api object directly). Both
// paths exercise the same code — no duplication, no drift.

import { describe, it, expect, beforeEach } from 'vitest'

// Use require() — filters.js uses the dual-export pattern (globalThis +
// module.exports) so require returns the API directly. import would pull
// the file's side-effect IIFE but not the module.exports object.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const filters = require('./filters.js')

// jsdom helper — build a synthetic DOM fragment from an HTML string.
function dom(html) {
  document.body.innerHTML = html
  return document.body
}

describe('cortexFilters', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  describe('shape', () => {
    it('exposes the documented predicate surface', () => {
      expect(typeof filters.shouldSkipChatGPTElement).toBe('function')
      expect(typeof filters.shouldSkipClaudeElement).toBe('function')
      expect(typeof filters.shouldSkipGeminiElement).toBe('function')
      expect(typeof filters.isChatGPTSystemMessage).toBe('function')
      expect(typeof filters.isChatGPTToolMessage).toBe('function')
      expect(typeof filters.isPlaceholderText).toBe('function')
      expect(filters.version).toBeGreaterThanOrEqual(1)
    })
  })

  // ── ChatGPT system + tool filtering ─────────────────────────────────────

  describe('isChatGPTSystemMessage', () => {
    it('returns true for elements with data-message-author-role="system"', () => {
      const body = dom('<div data-message-author-role="system">You are a helpful assistant.</div>')
      const el = body.firstElementChild
      expect(filters.isChatGPTSystemMessage(el)).toBe(true)
    })

    it('returns false for user messages', () => {
      const body = dom('<div data-message-author-role="user">What\'s the weather?</div>')
      const el = body.firstElementChild
      expect(filters.isChatGPTSystemMessage(el)).toBe(false)
    })

    it('returns false for assistant messages', () => {
      const body = dom('<div data-message-author-role="assistant">It is sunny.</div>')
      const el = body.firstElementChild
      expect(filters.isChatGPTSystemMessage(el)).toBe(false)
    })

    it('returns false for elements without the attribute', () => {
      const body = dom('<div>random div</div>')
      const el = body.firstElementChild
      expect(filters.isChatGPTSystemMessage(el)).toBe(false)
    })

    it('returns false for null / undefined safely', () => {
      expect(filters.isChatGPTSystemMessage(null)).toBe(false)
      expect(filters.isChatGPTSystemMessage(undefined)).toBe(false)
    })
  })

  describe('isChatGPTToolMessage', () => {
    it('returns true for tool-role messages', () => {
      const body = dom('<div data-message-author-role="tool">{"result": "..."}</div>')
      const el = body.firstElementChild
      expect(filters.isChatGPTToolMessage(el)).toBe(true)
    })

    it('returns false for non-tool roles', () => {
      const cases = ['user', 'assistant', 'system', '']
      for (const role of cases) {
        const body = dom(`<div data-message-author-role="${role}">x</div>`)
        expect(filters.isChatGPTToolMessage(body.firstElementChild)).toBe(false)
      }
    })
  })

  describe('shouldSkipChatGPTElement (composite)', () => {
    it('skips system messages', () => {
      const body = dom('<div data-message-author-role="system">sys</div>')
      expect(filters.shouldSkipChatGPTElement(body.firstElementChild)).toBe(true)
    })

    it('skips tool messages', () => {
      const body = dom('<div data-message-author-role="tool">tool</div>')
      expect(filters.shouldSkipChatGPTElement(body.firstElementChild)).toBe(true)
    })

    it('does NOT skip user or assistant messages', () => {
      const body = dom(`
        <div data-message-author-role="user">human turn</div>
        <div data-message-author-role="assistant">ai turn</div>
      `)
      const [user, ai] = body.querySelectorAll('div')
      expect(filters.shouldSkipChatGPTElement(user)).toBe(false)
      expect(filters.shouldSkipChatGPTElement(ai)).toBe(false)
    })
  })

  // ── Claude + Gemini placeholders ─────────────────────────────────────────

  describe('shouldSkipClaudeElement', () => {
    it('returns false for everything (no Claude filters defined yet)', () => {
      // Documents the current state: harness is ready, predicate is no-op
      // until a real Claude noise pattern is reported.
      const body = dom('<div data-testid="user-message">test</div>')
      expect(filters.shouldSkipClaudeElement(body.firstElementChild)).toBe(false)
    })
  })

  describe('shouldSkipGeminiElement', () => {
    it('returns false for everything (no Gemini filters defined yet)', () => {
      // Same as Claude — harness ready, predicate is no-op pending evidence.
      const body = dom('<user-query>test</user-query>')
      expect(filters.shouldSkipGeminiElement(body.firstElementChild)).toBe(false)
    })
  })

  // ── Placeholder text filtering ──────────────────────────────────────────

  describe('isPlaceholderText', () => {
    it('matches whitespace-only strings', () => {
      expect(filters.isPlaceholderText('')).toBe(true)
      expect(filters.isPlaceholderText('   ')).toBe(true)
      expect(filters.isPlaceholderText('\n\t')).toBe(true)
    })

    it('matches ellipsis-only strings', () => {
      expect(filters.isPlaceholderText('...')).toBe(true)
      expect(filters.isPlaceholderText('…')).toBe(true)
      expect(filters.isPlaceholderText(' ... ')).toBe(true)
    })

    it('matches loading-state placeholders (case-insensitive)', () => {
      expect(filters.isPlaceholderText('Loading')).toBe(true)
      expect(filters.isPlaceholderText('Please wait')).toBe(true)
      expect(filters.isPlaceholderText('Generating')).toBe(true)
      expect(filters.isPlaceholderText('thinking')).toBe(true)
      expect(filters.isPlaceholderText('Loading…')).toBe(true)
    })

    it('does NOT match real conversational text', () => {
      // The hard test — real refusals must NOT match, or we lose legitimate
      // AI responses. This is the conservative bound.
      expect(filters.isPlaceholderText('I cannot help with that.')).toBe(false)
      expect(filters.isPlaceholderText('Loading the model takes time.')).toBe(false)
      expect(filters.isPlaceholderText('Please wait until I finish my point.')).toBe(false)
      expect(filters.isPlaceholderText('The answer is 42')).toBe(false)
    })

    it('returns false safely for non-strings', () => {
      expect(filters.isPlaceholderText(null)).toBe(false)
      expect(filters.isPlaceholderText(undefined)).toBe(false)
      expect(filters.isPlaceholderText(42)).toBe(false)
    })
  })

  // ── Realistic ChatGPT DOM fixture ───────────────────────────────────────
  //
  // Synthetic minimal fixture standing in for a real ChatGPT conversation
  // with system + tool + user + assistant turns. When you capture a real
  // ChatGPT conversation that exhibits noise, replace this with the actual
  // outerHTML of the chat region — the test structure stays identical.

  describe('end-to-end fixture: ChatGPT conversation with system + tool noise', () => {
    const FIXTURE_HTML = `
      <main>
        <div data-message-author-role="system">
          <div class="markdown">You are a helpful AI assistant. Follow user instructions carefully.</div>
        </div>
        <article data-testid="conversation-turn-1">
          <div data-message-author-role="user">
            <div class="markdown">What is 2 + 2?</div>
          </div>
        </article>
        <article data-testid="conversation-turn-2">
          <div data-message-author-role="tool">
            <div class="markdown">{"tool":"calculator","result":4}</div>
          </div>
        </article>
        <article data-testid="conversation-turn-3">
          <div data-message-author-role="assistant">
            <div class="markdown">2 + 2 equals 4.</div>
          </div>
        </article>
      </main>
    `

    it('filters drop system + tool, preserve user + assistant', () => {
      const body = dom(FIXTURE_HTML)
      const roleEls = body.querySelectorAll('[data-message-author-role]')
      expect(roleEls.length).toBe(4)  // sanity: fixture parsed

      const kept = []
      for (const el of roleEls) {
        if (filters.shouldSkipChatGPTElement(el)) continue
        kept.push(el.getAttribute('data-message-author-role'))
      }
      expect(kept).toEqual(['user', 'assistant'])
    })
  })
})
