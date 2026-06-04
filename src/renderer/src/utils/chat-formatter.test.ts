import { describe, it, expect } from 'vitest'

// ── Pure chat formatting functions (mirrors popup.js logic) ───────────────────

interface ChatMessage {
  role: 'human' | 'ai'
  content: string
  index: number
}

function buildMarkdown(messages: ChatMessage[], source: string, title: string, url: string): string {
  const now = '2025-01-15T12:00:00.000Z'
  const lines: string[] = [
    '---',
    `source: ${source}`,
    `captured: ${now}`,
    ...(url ? [`url: ${url}`] : []),
    '---',
    '',
    `# ${title || 'Untitled Chat'}`,
    '',
  ]

  for (const msg of messages) {
    if (msg.role === 'human') {
      const quoted = msg.content.split('\n').map(l => `> ${l}`).join('\n')
      lines.push(quoted)
    } else {
      lines.push(msg.content)
    }
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}

function buildFilename(title: string, _url: string, isoDate: string): string {
  const date = isoDate.slice(0, 10)
  const time = isoDate.slice(11, 16).replace(':', '-')
  const slug = (title || 'chat')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '')
  return `${date}-${time}-${slug || 'untitled'}.md`
}

function detectSource(url: string): string {
  try {
    const h = new URL(url).hostname.toLowerCase()
    if (h === 'claude.ai' || h.endsWith('.claude.ai')) return 'claude'
    if (h === 'chatgpt.com' || h.endsWith('.chatgpt.com') || h === 'chat.openai.com') return 'chatgpt'
    if (h === 'gemini.google.com') return 'gemini'
  } catch { /* malformed url */ }
  return 'manual'
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildMarkdown — human messages use blockquotes', () => {
  it('wraps human messages in > blockquote', () => {
    const messages: ChatMessage[] = [{ role: 'human', content: 'Hello AI', index: 0 }]
    const md = buildMarkdown(messages, 'claude', 'Test Chat', '')
    expect(md).toContain('> Hello AI')
  })

  it('AI messages are full width (no blockquote)', () => {
    const messages: ChatMessage[] = [{ role: 'ai', content: 'Hello human', index: 0 }]
    const md = buildMarkdown(messages, 'claude', 'Test Chat', '')
    expect(md).toContain('Hello human')
    expect(md).not.toContain('> Hello human')
  })

  it('multi-line human messages get > on each line', () => {
    const messages: ChatMessage[] = [{ role: 'human', content: 'Line 1\nLine 2', index: 0 }]
    const md = buildMarkdown(messages, 'claude', 'Test Chat', '')
    expect(md).toContain('> Line 1\n> Line 2')
  })

  it('includes frontmatter with source and url', () => {
    const messages: ChatMessage[] = []
    const md = buildMarkdown(messages, 'chatgpt', 'My Chat', 'https://chatgpt.com/c/123')
    expect(md).toContain('source: chatgpt')
    expect(md).toContain('url: https://chatgpt.com/c/123')
  })

  it('includes H1 title', () => {
    const messages: ChatMessage[] = []
    const md = buildMarkdown(messages, 'claude', 'My Great Chat', '')
    expect(md).toContain('# My Great Chat')
  })

  it('falls back to Untitled Chat when title is empty', () => {
    const messages: ChatMessage[] = []
    const md = buildMarkdown(messages, 'claude', '', '')
    expect(md).toContain('# Untitled Chat')
  })

  it('separates messages with ---', () => {
    const messages: ChatMessage[] = [
      { role: 'human', content: 'Q', index: 0 },
      { role: 'ai', content: 'A', index: 1 },
    ]
    const md = buildMarkdown(messages, 'claude', 'Chat', '')
    expect(md.split('---').length).toBeGreaterThanOrEqual(4)
  })
})

describe('buildFilename', () => {
  it('produces YYYY-MM-DD-HH-MM-slug.md format', () => {
    const fn = buildFilename('My Great Chat', '', '2025-06-03T14:30:00.000Z')
    expect(fn).toMatch(/^2025-06-03-14-30-my-great-chat\.md$/)
  })

  it('slugifies title — removes special chars, lowercases', () => {
    const fn = buildFilename('Hello World! (Test)', '', '2025-01-01T00:00:00.000Z')
    expect(fn).toContain('hello-world-test')
  })

  it('truncates long titles to 40 chars in slug', () => {
    const longTitle = 'a'.repeat(60)
    const fn = buildFilename(longTitle, '', '2025-01-01T00:00:00.000Z')
    const slug = fn.replace(/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-/, '').replace(/\.md$/, '')
    expect(slug.length).toBeLessThanOrEqual(40)
  })

  it('uses chat as fallback slug when title empty', () => {
    const fn = buildFilename('', '', '2025-01-01T09:05:00.000Z')
    expect(fn).toMatch(/chat\.md$/)
  })
})

describe('detectSource', () => {
  it('detects claude.ai', () => {
    expect(detectSource('https://claude.ai/chat/abc')).toBe('claude')
  })

  it('detects chatgpt.com', () => {
    expect(detectSource('https://chatgpt.com/c/123')).toBe('chatgpt')
  })

  it('detects chat.openai.com', () => {
    expect(detectSource('https://chat.openai.com/c/xyz')).toBe('chatgpt')
  })

  it('detects gemini.google.com', () => {
    expect(detectSource('https://gemini.google.com/app')).toBe('gemini')
  })

  it('returns manual for unknown domains', () => {
    expect(detectSource('https://example.com/chat')).toBe('manual')
  })

  it('returns manual for empty string', () => {
    expect(detectSource('')).toBe('manual')
  })
})
