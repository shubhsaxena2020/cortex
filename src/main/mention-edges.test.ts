import { describe, it, expect } from 'vitest'
import { buildMentionEdges, filenameStem, MAX_MENTIONS_PER_FILE } from './mention-edges'

const mem = (id: string, title: string, content = '') => ({ id, title, content })
const file = (id: string, filename: string) => ({ id, filename })

describe('filenameStem', () => {
  it('strips the last extension and lowercases', () => {
    expect(filenameStem('My-Notes.MD')).toBe('my-notes')
    expect(filenameStem('archive.tar.gz')).toBe('archive.tar')
  })

  it('leaves extensionless names alone', () => {
    expect(filenameStem('README')).toBe('readme')
  })
})

describe('buildMentionEdges', () => {
  it('links a memory to a file whose stem appears as a whole word', () => {
    const edges = buildMentionEdges(
      [mem('m1', 'Notes about quadtree culling')],
      [file('f1', 'quadtree.ts')],
    )
    expect(edges).toEqual([{ source: 'm1', target: 'f1' }])
  })

  it('matches whole words only — no substring false positives', () => {
    const edges = buildMentionEdges(
      [mem('m1', 'building an application')],
      [file('f1', 'app.ts')], // "app" is inside "application" but not a word
    )
    expect(edges).toEqual([])
  })

  it('searches content as well as title', () => {
    const edges = buildMentionEdges(
      [mem('m1', 'untitled', 'see the embeddings module for details')],
      [file('f1', 'embeddings.ts')],
    )
    expect(edges).toHaveLength(1)
  })

  it('ignores stems of 2 chars or fewer', () => {
    const edges = buildMentionEdges(
      [mem('m1', 'db db db')],
      [file('f1', 'db.ts')],
    )
    expect(edges).toEqual([])
  })

  it('caps fan-out per file', () => {
    const memories = Array.from({ length: 20 }, (_, i) => mem(`m${i}`, 'common keyword here'))
    const edges = buildMentionEdges(memories, [file('f1', 'common.md')])
    expect(edges).toHaveLength(MAX_MENTIONS_PER_FILE)
  })

  it('returns empty for empty inputs', () => {
    expect(buildMentionEdges([], [file('f1', 'a.md')])).toEqual([])
    expect(buildMentionEdges([mem('m1', 'title')], [])).toEqual([])
  })

  it('handles null content', () => {
    const edges = buildMentionEdges(
      [{ id: 'm1', title: 'quadtree notes', content: null }],
      [file('f1', 'quadtree.md')],
    )
    expect(edges).toHaveLength(1)
  })
})
