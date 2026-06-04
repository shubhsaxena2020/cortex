import { describe, it, expect } from 'vitest'
import { toMemory, toRelationship, makeHighlight, type DbMemory, type DbRelationship } from './transformers'

const baseRow: DbMemory = {
  id: 'abc',
  title: 'Test',
  content: 'Hello world',
  timestamp: 1000000000000,
  updatedAt: 1000000001000,
  source: 'claude',
  tags: ['tag1'],
}

describe('toMemory', () => {
  it('maps all fields correctly', () => {
    const memory = toMemory(baseRow)
    expect(memory.id).toBe('abc')
    expect(memory.title).toBe('Test')
    expect(memory.content).toBe('Hello world')
    expect(memory.source).toBe('claude')
    expect(memory.tags).toEqual(['tag1'])
  })

  it('defaults missing content to empty string', () => {
    const memory = toMemory({ ...baseRow, content: '' })
    expect(memory.content).toBe('')
  })

  it('defaults missing source to manual', () => {
    const memory = toMemory({ ...baseRow, source: '' })
    expect(memory.source).toBe('manual')
  })
})

describe('toRelationship', () => {
  it('maps all fields correctly', () => {
    const row: DbRelationship = { id: 'r1', sourceId: 'a', targetId: 'b', relationship: 'related' }
    const rel = toRelationship(row)
    expect(rel.id).toBe('r1')
    expect(rel.memory_a_id).toBe('a')
    expect(rel.memory_b_id).toBe('b')
    expect(rel.relationship_type).toBe('related')
  })

  it('defaults missing relationship to related', () => {
    const row: DbRelationship = { id: 'r2', sourceId: 'a', targetId: 'b', relationship: '' }
    const rel = toRelationship(row)
    expect(rel.relationship_type).toBe('related')
  })
})

describe('makeHighlight', () => {
  it('returns undefined when query is empty', () => {
    expect(makeHighlight('hello world', '')).toBeUndefined()
  })

  it('returns undefined when query is not found', () => {
    expect(makeHighlight('hello world', 'xyz')).toBeUndefined()
  })

  it('wraps matched text in a mark tag', () => {
    const result = makeHighlight('hello world', 'world')
    expect(result).toContain('<mark>world</mark>')
  })

  it('is case-insensitive', () => {
    const result = makeHighlight('Hello World', 'hello')
    expect(result).toContain('<mark>Hello</mark>')
  })

  it('escapes HTML in surrounding context', () => {
    const result = makeHighlight('<script>alert(1)</script> world', 'world')
    expect(result).not.toContain('<script>')
    expect(result).toContain('&lt;script&gt;')
  })
})
