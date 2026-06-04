import { describe, it, expect } from 'vitest'
import { buildGraph, fileColor, filenameStem, type GraphMemory, type GraphRelationship } from './graph-builder'
import type { VaultFile } from '../../../types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function mem(id: string, title: string, content = '', source = 'manual'): GraphMemory {
  return { id, title, content, source, tags: [] }
}

function rel(a: string, b: string): GraphRelationship {
  return { memory_a_id: a, memory_b_id: b, relationship_type: 'related' }
}

function file(id: string, filename: string, ext: string, content = ''): VaultFile {
  return { id, filename, filepath: `/vault/${filename}`, extension: ext, content, size: 100, lastModified: 0, indexedAt: 0 }
}

// ── fileColor ─────────────────────────────────────────────────────────────────

describe('fileColor', () => {
  it('returns green for code files', () => {
    expect(fileColor('.py')).toBe('#4CAF50')
    expect(fileColor('.ts')).toBe('#4CAF50')
    expect(fileColor('.js')).toBe('#4CAF50')
  })

  it('returns orange for doc files', () => {
    expect(fileColor('.pdf')).toBe('#FF9800')
    expect(fileColor('.docx')).toBe('#FF9800')
  })

  it('returns yellow for data files', () => {
    expect(fileColor('.json')).toBe('#FFC107')
    expect(fileColor('.csv')).toBe('#FFC107')
  })

  it('returns grey for text files', () => {
    expect(fileColor('.md')).toBe('#9E9E9E')
    expect(fileColor('.txt')).toBe('#9E9E9E')
  })

  it('returns dark grey for unknown', () => {
    expect(fileColor('.xyz')).toBe('#555555')
  })
})

// ── filenameStem ──────────────────────────────────────────────────────────────

describe('filenameStem', () => {
  it('strips the extension', () => {
    expect(filenameStem(file('1', 'notes.md', '.md'))).toBe('notes')
    expect(filenameStem(file('2', 'my-script.py', '.py'))).toBe('my-script')
  })

  it('lowercases the result', () => {
    expect(filenameStem(file('3', 'README.md', '.md'))).toBe('readme')
  })
})

// ── buildGraph — filter modes ─────────────────────────────────────────────────

describe('buildGraph — filter modes', () => {
  const memories = [mem('m1', 'Memory 1'), mem('m2', 'Memory 2')]
  const files = [file('f1', 'script.py', '.py')]
  const rels: GraphRelationship[] = []

  it('returns both memories and files when filter=both', () => {
    const { nodes } = buildGraph(memories, rels, files, 'both')
    expect(nodes.filter(n => n.nodeType === 'memory')).toHaveLength(2)
    expect(nodes.filter(n => n.nodeType === 'file')).toHaveLength(1)
  })

  it('returns only memories when filter=memories', () => {
    const { nodes } = buildGraph(memories, rels, files, 'memories')
    expect(nodes.every(n => n.nodeType === 'memory')).toBe(true)
    expect(nodes).toHaveLength(2)
  })

  it('returns only files when filter=files', () => {
    const { nodes } = buildGraph(memories, rels, files, 'files')
    expect(nodes.every(n => n.nodeType === 'file')).toBe(true)
    expect(nodes).toHaveLength(1)
  })
})

// ── buildGraph — relationship edges ──────────────────────────────────────────

describe('buildGraph — relationship edges', () => {
  it('creates edge for known memory relationship', () => {
    const memories = [mem('m1', 'A'), mem('m2', 'B')]
    const { links } = buildGraph(memories, [rel('m1', 'm2')], [], 'both')
    expect(links).toHaveLength(1)
    expect(links[0].edgeType).toBe('relationship')
    expect(links[0].source).toBe('m1')
    expect(links[0].target).toBe('m2')
  })

  it('skips relationship where one memory is missing', () => {
    const memories = [mem('m1', 'A')]
    const { links } = buildGraph(memories, [rel('m1', 'm-missing')], [], 'both')
    expect(links).toHaveLength(0)
  })

  it('does not add relationship edges in files-only mode', () => {
    const memories = [mem('m1', 'A'), mem('m2', 'B')]
    const { links } = buildGraph(memories, [rel('m1', 'm2')], [], 'files')
    expect(links).toHaveLength(0)
  })
})

// ── buildGraph — mention edges ────────────────────────────────────────────────

describe('buildGraph — mention edges', () => {
  it('creates mention edge when filename stem appears in memory content', () => {
    const memories = [mem('m1', 'Notes', 'I wrote a script for this')]
    const files = [file('f1', 'script.py', '.py')]
    const { links } = buildGraph(memories, [], files, 'both')
    const mentionLink = links.find(l => l.edgeType === 'mention')
    expect(mentionLink).toBeDefined()
    expect(mentionLink?.source).toBe('m1')
    expect(mentionLink?.target).toBe('f1')
  })

  it('creates mention edge when stem appears in title', () => {
    const memories = [mem('m1', 'about readme file', '')]
    const files = [file('f1', 'README.md', '.md')]
    const { links } = buildGraph(memories, [], files, 'both')
    expect(links.some(l => l.edgeType === 'mention')).toBe(true)
  })

  it('ignores stems that are too short (<=2 chars)', () => {
    const memories = [mem('m1', 'a readme', 'about it')]
    const files = [file('f1', 'to.md', '.md')]  // stem = "to" (2 chars)
    const { links } = buildGraph(memories, [], files, 'both')
    expect(links.some(l => l.edgeType === 'mention')).toBe(false)
  })

  it('does not add mention edges when filter=memories', () => {
    const memories = [mem('m1', 'Notes', 'I wrote a script')]
    const files = [file('f1', 'script.py', '.py')]
    const { links } = buildGraph(memories, [], files, 'memories')
    expect(links.some(l => l.edgeType === 'mention')).toBe(false)
  })
})

// ── buildGraph — watch folder (fromWatch flag) ────────────────────────────────

describe('buildGraph — fromWatch flag', () => {
  it('marks file node as fromWatch when filepath starts with watchPath', () => {
    const memories = [mem('m1', 'Memory')]
    const files = [file('f1', 'readme.md', '.md', '')]
    // Override filepath to simulate watch folder
    files[0] = { ...files[0], filepath: '/watch/readme.md' }
    const { nodes } = buildGraph(memories, [], files, 'both', '/watch')
    const fileNode = nodes.find(n => n.id === 'f1')!
    expect(fileNode.fromWatch).toBe(true)
  })

  it('does not mark vault files as fromWatch', () => {
    const memories = [mem('m1', 'Memory')]
    const files = [file('f1', 'readme.md', '.md', '')]
    // vault filepath, watchPath is different
    const { nodes } = buildGraph(memories, [], files, 'both', '/watch')
    const fileNode = nodes.find(n => n.id === 'f1')!
    expect(fileNode.fromWatch).toBe(false)
  })

  it('fromWatch is false when no watchPath provided', () => {
    const files = [file('f1', 'readme.md', '.md', '')]
    const { nodes } = buildGraph([], [], files, 'files')
    expect(nodes[0].fromWatch).toBe(false)
  })
})

// ── buildGraph — connection counts ────────────────────────────────────────────

describe('buildGraph — connection counts', () => {
  it('counts connections per node correctly', () => {
    const memories = [mem('m1', 'A'), mem('m2', 'B'), mem('m3', 'C')]
    const rels = [rel('m1', 'm2'), rel('m1', 'm3')]
    const { nodes } = buildGraph(memories, rels, [], 'memories')
    const m1 = nodes.find(n => n.id === 'm1')!
    const m2 = nodes.find(n => n.id === 'm2')!
    expect(m1.connections).toBe(2)
    expect(m2.connections).toBe(1)
  })

  it('nodes with no connections have count 0', () => {
    const memories = [mem('m1', 'Isolated')]
    const { nodes } = buildGraph(memories, [], [], 'memories')
    expect(nodes[0].connections).toBe(0)
  })
})
