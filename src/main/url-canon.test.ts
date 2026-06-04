import { describe, it, expect } from 'vitest'
import { canonicalUrl } from './url-canon'

describe('canonicalUrl', () => {
  describe('null and edge cases', () => {
    it('returns null for null / undefined / empty / whitespace input', () => {
      expect(canonicalUrl(null)).toBeNull()
      expect(canonicalUrl(undefined)).toBeNull()
      expect(canonicalUrl('')).toBeNull()
      expect(canonicalUrl('   ')).toBeNull()
    })

    it('returns null for non-string input', () => {
      // @ts-expect-error — intentional bad input
      expect(canonicalUrl(42)).toBeNull()
      // @ts-expect-error
      expect(canonicalUrl({})).toBeNull()
    })

    it('returns null for unparseable URLs', () => {
      expect(canonicalUrl('not a url')).toBeNull()
      expect(canonicalUrl('foo')).toBeNull()
      expect(canonicalUrl('/relative/path')).toBeNull()
    })

    it('returns null for non-http schemes', () => {
      expect(canonicalUrl('mailto:foo@bar.com')).toBeNull()
      expect(canonicalUrl('file:///c:/tmp')).toBeNull()
      expect(canonicalUrl('chrome-extension://abc/page.html')).toBeNull()
      expect(canonicalUrl('javascript:alert(1)')).toBeNull()
    })
  })

  describe('basic canonicalisation', () => {
    it('lowercases the hostname', () => {
      expect(canonicalUrl('https://CLAUDE.AI/chat/abc')).toBe('https://claude.ai/chat/abc')
    })

    it('preserves case in the path (conversation IDs are case-sensitive)', () => {
      expect(canonicalUrl('https://claude.ai/chat/ABC-Def-123'))
        .toBe('https://claude.ai/chat/ABC-Def-123')
    })

    it('strips trailing slash except on root', () => {
      expect(canonicalUrl('https://claude.ai/chat/abc/')).toBe('https://claude.ai/chat/abc')
      expect(canonicalUrl('https://claude.ai/')).toBe('https://claude.ai/')
    })

    it('strips the URL fragment', () => {
      expect(canonicalUrl('https://claude.ai/chat/abc#section-2')).toBe('https://claude.ai/chat/abc')
    })

    it('collapses multiple slashes in the path', () => {
      expect(canonicalUrl('https://claude.ai//chat///abc')).toBe('https://claude.ai/chat/abc')
    })
  })

  describe('tracking-param stripping', () => {
    it('strips utm_* params', () => {
      expect(canonicalUrl('https://claude.ai/chat/abc?utm_source=email&utm_medium=cta'))
        .toBe('https://claude.ai/chat/abc')
    })

    it('strips fbclid, gclid, msclkid', () => {
      expect(canonicalUrl('https://claude.ai/chat/abc?fbclid=xyz')).toBe('https://claude.ai/chat/abc')
      expect(canonicalUrl('https://claude.ai/chat/abc?gclid=xyz')).toBe('https://claude.ai/chat/abc')
      expect(canonicalUrl('https://claude.ai/chat/abc?msclkid=xyz')).toBe('https://claude.ai/chat/abc')
    })

    it('preserves non-tracking query params', () => {
      // Hypothetical: ChatGPT could add a real param we need to disambiguate on
      expect(canonicalUrl('https://chatgpt.com/c/abc?model=gpt-5'))
        .toBe('https://chatgpt.com/c/abc?model=gpt-5')
    })

    it('sorts preserved params for deterministic output', () => {
      // Same query, different order → same canonical
      expect(canonicalUrl('https://x.com/p?b=2&a=1'))
        .toBe(canonicalUrl('https://x.com/p?a=1&b=2'))
    })

    it('strips tracking but keeps non-tracking in mixed query', () => {
      expect(canonicalUrl('https://chatgpt.com/c/abc?model=gpt-5&utm_source=tw'))
        .toBe('https://chatgpt.com/c/abc?model=gpt-5')
    })
  })

  describe('real-world provider URLs', () => {
    it('canonicalises claude.ai conversation URLs identically across variants', () => {
      const base = 'https://claude.ai/chat/2f8161e4-5c85-4204-8681-6895df559852'
      const variants = [
        base,
        base + '/',
        base + '#anchor',
        'HTTPS://CLAUDE.AI/chat/2f8161e4-5c85-4204-8681-6895df559852',
        base + '?utm_source=share',
        base + '?fbclid=xyz#anchor',
      ]
      const canon = canonicalUrl(base)
      expect(canon).toBe('https://claude.ai/chat/2f8161e4-5c85-4204-8681-6895df559852')
      for (const v of variants) {
        expect(canonicalUrl(v)).toBe(canon)
      }
    })

    it('treats different conversation paths as different keys', () => {
      const a = canonicalUrl('https://claude.ai/chat/conv-1')
      const b = canonicalUrl('https://claude.ai/chat/conv-2')
      expect(a).not.toBe(b)
      expect(a).not.toBeNull()
      expect(b).not.toBeNull()
    })

    it('treats different providers with same conversation id as different keys', () => {
      // Defensive: two providers should never collide even if path coincides.
      const claude = canonicalUrl('https://claude.ai/chat/abc')
      const chatgpt = canonicalUrl('https://chatgpt.com/c/abc')
      expect(claude).not.toBe(chatgpt)
    })

    it('handles gemini.google.com/app paths', () => {
      expect(canonicalUrl('https://gemini.google.com/app/abc-123'))
        .toBe('https://gemini.google.com/app/abc-123')
    })
  })

  describe('preserves whitespace tolerance', () => {
    it('trims leading/trailing whitespace on input', () => {
      expect(canonicalUrl('  https://claude.ai/chat/abc  '))
        .toBe('https://claude.ai/chat/abc')
    })
  })
})
