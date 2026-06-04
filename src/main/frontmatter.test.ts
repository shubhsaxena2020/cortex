import { describe, it, expect } from 'vitest'
import { parseFrontmatter } from './frontmatter'

describe('parseFrontmatter', () => {
  describe('absence', () => {
    it('returns empty for null / undefined / empty', () => {
      expect(parseFrontmatter(null).hasFrontmatter).toBe(false)
      expect(parseFrontmatter(undefined).hasFrontmatter).toBe(false)
      expect(parseFrontmatter('').hasFrontmatter).toBe(false)
    })

    it('returns empty when document does not start with ---', () => {
      const md = '# Some Document\n\nNo frontmatter here.'
      expect(parseFrontmatter(md).hasFrontmatter).toBe(false)
    })

    it('returns empty when opening --- has trailing content on the same line', () => {
      const md = '--- not really frontmatter\nfoo: bar\n---\n'
      expect(parseFrontmatter(md).hasFrontmatter).toBe(false)
    })

    it('returns empty when there is no closing ---', () => {
      const md = '---\nurl: https://x.com/a\nbody never closes the block'
      expect(parseFrontmatter(md).hasFrontmatter).toBe(false)
    })
  })

  describe('the actual saved-chat format from the vault', () => {
    it('parses the real-world Claude saved-chat header', () => {
      const md = [
        '---',
        'source: claude',
        'captured: 2026-06-03T07:41:49.995Z',
        'url: https://claude.ai/chat/2f8161e4-5c85-4204-8681-6895df559852',
        'tags: []',
        '---',
        '',
        '# CBSE website vulnerability assessment - Claude',
        '',
        '> first user message here',
      ].join('\n')

      const fm = parseFrontmatter(md)
      expect(fm.hasFrontmatter).toBe(true)
      expect(fm.source).toBe('claude')
      expect(fm.url).toBe('https://claude.ai/chat/2f8161e4-5c85-4204-8681-6895df559852')
      expect(fm.fields['captured']).toBe('2026-06-03T07:41:49.995Z')
      expect(fm.fields['tags']).toBe('[]')
    })
  })

  describe('line endings and BOM', () => {
    it('tolerates CRLF line endings', () => {
      const md = '---\r\nurl: https://x.com/a\r\n---\r\nbody'
      expect(parseFrontmatter(md).url).toBe('https://x.com/a')
    })

    it('tolerates a leading BOM', () => {
      const md = '﻿---\nurl: https://x.com/a\n---\nbody'
      expect(parseFrontmatter(md).url).toBe('https://x.com/a')
    })
  })

  describe('value handling', () => {
    it('trims whitespace around values', () => {
      const md = '---\nurl:    https://x.com/a    \n---\n'
      expect(parseFrontmatter(md).url).toBe('https://x.com/a')
    })

    it('strips matched double-quotes', () => {
      const md = '---\nurl: "https://x.com/a"\n---\n'
      expect(parseFrontmatter(md).url).toBe('https://x.com/a')
    })

    it('strips matched single-quotes', () => {
      const md = "---\nurl: 'https://x.com/a'\n---\n"
      expect(parseFrontmatter(md).url).toBe('https://x.com/a')
    })

    it('does not strip mismatched quotes', () => {
      const md = '---\nurl: "https://x.com/a\n---\n'
      expect(parseFrontmatter(md).url).toBe('"https://x.com/a')
    })

    it('strips trailing # comments only when separated by spaces', () => {
      const md = '---\nurl: https://x.com/a # this is a note\n---\n'
      expect(parseFrontmatter(md).url).toBe('https://x.com/a')
    })

    it('does not split on # inside URLs (no space)', () => {
      // Frontmatter URLs shouldn't have anchors, but if they do, don't truncate.
      const md = '---\nurl: https://x.com/a#section\n---\n'
      expect(parseFrontmatter(md).url).toBe('https://x.com/a#section')
    })
  })

  describe('robustness', () => {
    it('skips blank lines and full-line # comments', () => {
      const md = [
        '---',
        '',
        '# a comment',
        'url: https://x.com/a',
        '',
        'source: claude',
        '---',
      ].join('\n')
      const fm = parseFrontmatter(md)
      expect(fm.url).toBe('https://x.com/a')
      expect(fm.source).toBe('claude')
    })

    it('last duplicate key wins', () => {
      const md = '---\nurl: https://x.com/a\nurl: https://x.com/b\n---\n'
      expect(parseFrontmatter(md).url).toBe('https://x.com/b')
    })

    it('ignores malformed lines without a colon', () => {
      const md = '---\nurl: https://x.com/a\nthis line has no colon\nsource: claude\n---\n'
      const fm = parseFrontmatter(md)
      expect(fm.url).toBe('https://x.com/a')
      expect(fm.source).toBe('claude')
    })

    it('returns null url when frontmatter is present but has no url key', () => {
      const md = '---\nsource: claude\ntags: []\n---\n'
      const fm = parseFrontmatter(md)
      expect(fm.hasFrontmatter).toBe(true)
      expect(fm.url).toBeNull()
    })

    it('fields object is frozen (immutability invariant)', () => {
      const md = '---\nurl: https://x.com/a\n---\n'
      const fm = parseFrontmatter(md)
      expect(Object.isFrozen(fm.fields)).toBe(true)
    })
  })
})
