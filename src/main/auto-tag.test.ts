import { describe, it, expect } from 'vitest'
import { suggestTags, tagMatchesText } from './auto-tag'

describe('tagMatchesText', () => {
  it('matches single-word tags present in tokens', () => {
    expect(tagMatchesText('electron', new Set(['electron', 'react']))).toBe(true)
  })

  it('matches hyphenated tags when all parts appear', () => {
    expect(tagMatchesText('graph-performance', new Set(['graph', 'performance']))).toBe(true)
  })

  it('rejects tags with missing parts', () => {
    expect(tagMatchesText('graph-performance', new Set(['graph']))).toBe(false)
  })

  it('matches by prefix for stemmed variants', () => {
    // tag "embedding" should match token "embeddings"
    expect(tagMatchesText('embedding', new Set(['embeddings']))).toBe(true)
  })
})

describe('suggestTags', () => {
  it('returns empty for empty input', () => {
    expect(suggestTags('', '')).toEqual([])
  })

  it('extracts repeated meaningful keywords', () => {
    const tags = suggestTags(
      'Debugging sqlite performance',
      'The sqlite query planner picks indexes. sqlite ANALYZE helps the planner. Slow sqlite queries need indexes.',
    )
    expect(tags).toContain('sqlite')
  })

  it('weights title words above body words', () => {
    const tags = suggestTags(
      'electron architecture',
      'various words repeated repeated repeated here often often often',
    )
    // title words appear once each but get 3x weight, beating single-occurrence body words
    expect(tags).toContain('electron')
    expect(tags).toContain('architecture')
  })

  it('ignores stop words entirely', () => {
    const tags = suggestTags('about which where', 'because these those them also more most')
    expect(tags).toEqual([])
  })

  it('prefers existing vocabulary tags over fresh keywords', () => {
    const vocab = [{ tag: 'knowledge-graph', count: 20 }]
    const tags = suggestTags(
      'Notes on the knowledge graph',
      'The graph stores knowledge as nodes. Edges connect graph nodes.',
      vocab,
    )
    expect(tags[0]).toBe('knowledge-graph')
  })

  it('caps at maxTags', () => {
    const content = 'alpha alpha beta beta gamma gamma delta delta epsilon epsilon zeta zeta eta eta'
    expect(suggestTags('many words', content, [], 3)).toHaveLength(3)
  })

  it('drops single-occurrence body words below the score floor', () => {
    const tags = suggestTags('', 'mentioned once somewhere quietly')
    expect(tags).toEqual([])
  })

  it('normalizes suggested tags to valid tag format', () => {
    const tags = suggestTags('TypeScript TYPESCRIPT', 'TypeScript everywhere TypeScript')
    expect(tags).toContain('typescript')
    for (const t of tags) expect(t).toBe(t.toLowerCase())
  })
})
