import type { MemorySource } from '../types'

export type DbMemory = {
  id: string
  title: string
  content: string
  timestamp: number
  updatedAt: number
  source: string
  tags: string[]
}

export type DbRelationship = {
  id: string
  sourceId: string
  targetId: string
  relationship: string
}

export function toMemory(row: DbMemory) {
  return {
    id: row.id,
    title: row.title,
    content: row.content || '',
    source: (row.source || 'manual') as MemorySource,
    created_at: new Date(row.timestamp || Date.now()).toISOString(),
    updated_at: new Date(row.updatedAt || Date.now()).toISOString(),
    tags: row.tags || []
  }
}

export function toRelationship(row: DbRelationship) {
  return {
    id: row.id,
    memory_a_id: row.sourceId,
    memory_b_id: row.targetId,
    relationship_type: row.relationship || 'related'
  }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => HTML_ESCAPES[c])

export function makeHighlight(content: string, query: string): string | undefined {
  if (!query || !content) return undefined
  const idx = content.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return undefined
  const before = Math.max(0, idx - 40)
  const after = Math.min(content.length, idx + query.length + 80)
  const prefix = before > 0 ? '…' : ''
  const suffix = after < content.length ? '…' : ''
  return prefix
    + escapeHtml(content.slice(before, idx))
    + '<mark>' + escapeHtml(content.slice(idx, idx + query.length)) + '</mark>'
    + escapeHtml(content.slice(idx + query.length, after))
    + suffix
}
