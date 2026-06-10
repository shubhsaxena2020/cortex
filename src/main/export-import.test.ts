import { describe, it, expect } from 'vitest'
import {
  memoriesToJson, memoriesToCsv, csvEscape, parseMemoriesJson,
  type ExportableMemory,
} from './export-import'

const mem = (over: Partial<ExportableMemory> = {}): ExportableMemory => ({
  id: 'id-1',
  title: 'Title',
  content: 'Content',
  source: 'claude',
  created_at: '2026-06-10T00:00:00.000Z',
  updated_at: '2026-06-10T00:00:00.000Z',
  tags: ['a', 'b'],
  url: null,
  ...over,
})

describe('memoriesToJson', () => {
  it('wraps memories in a versioned envelope', () => {
    const parsed = JSON.parse(memoriesToJson([mem()]))
    expect(parsed.cortexExport).toBe(1)
    expect(parsed.count).toBe(1)
    expect(parsed.memories[0].title).toBe('Title')
  })
})

describe('csvEscape', () => {
  it('passes plain values through', () => {
    expect(csvEscape('hello')).toBe('hello')
  })
  it('quotes values with commas', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
  })
  it('doubles embedded quotes', () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
  })
  it('quotes values with newlines', () => {
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
  })
})

describe('memoriesToCsv', () => {
  it('emits a header plus one row per memory', () => {
    const csv = memoriesToCsv([mem(), mem({ id: 'id-2' })])
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('id,title,content,source,created_at,updated_at,tags,url')
  })

  it('escapes commas and quotes in content', () => {
    const csv = memoriesToCsv([mem({ content: 'a,b "c"' })])
    expect(csv).toContain('"a,b ""c"""')
  })

  it('joins tags with semicolons', () => {
    const csv = memoriesToCsv([mem({ tags: ['x', 'y', 'z'] })])
    expect(csv).toContain('x;y;z')
  })
})

describe('parseMemoriesJson', () => {
  it('round-trips its own export format', () => {
    const json = memoriesToJson([mem({ title: 'RT', tags: ['t'] })])
    const { memories, errors } = parseMemoriesJson(json)
    expect(errors).toEqual([])
    expect(memories).toHaveLength(1)
    expect(memories[0]).toMatchObject({ title: 'RT', source: 'claude', tags: ['t'] })
  })

  it('accepts a bare array', () => {
    const { memories } = parseMemoriesJson(JSON.stringify([{ title: 'Bare', content: 'c' }]))
    expect(memories).toHaveLength(1)
  })

  it('rejects non-JSON', () => {
    const { memories, errors } = parseMemoriesJson('not json')
    expect(memories).toEqual([])
    expect(errors).toEqual(['File is not valid JSON'])
  })

  it('rejects JSON without a memories array', () => {
    const { errors } = parseMemoriesJson('{"foo": 1}')
    expect(errors).toEqual(['JSON has no "memories" array'])
  })

  it('skips invalid entries but keeps valid ones', () => {
    const { memories, errors } = parseMemoriesJson(JSON.stringify({
      memories: [{ title: 'ok', content: 'x' }, 42, { tags: ['no-title-or-content'] }],
    }))
    expect(memories).toHaveLength(1)
    expect(errors).toHaveLength(2)
  })

  it('normalizes unknown sources to manual', () => {
    const { memories } = parseMemoriesJson(JSON.stringify([{ title: 't', content: 'c', source: 'EVIL' }]))
    expect(memories[0].source).toBe('manual')
  })

  it('drops non-string tags', () => {
    const { memories } = parseMemoriesJson(JSON.stringify([{ title: 't', content: 'c', tags: ['ok', 7, ''] }]))
    expect(memories[0].tags).toEqual(['ok'])
  })

  it('defaults missing title to Untitled when content exists', () => {
    const { memories } = parseMemoriesJson(JSON.stringify([{ content: 'just content' }]))
    expect(memories[0].title).toBe('Untitled')
  })
})
