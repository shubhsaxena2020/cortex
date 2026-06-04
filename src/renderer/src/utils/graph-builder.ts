import type { VaultFile } from '../../../types'

export type FilterMode = 'both' | 'memories' | 'files'

export interface GraphMemory {
  id: string
  title: string
  content: string
  source: string
  tags: string[]
}

export interface GraphRelationship {
  memory_a_id: string
  memory_b_id: string
  relationship_type: string
}

export interface GraphNode {
  id: string
  title: string
  nodeType: 'memory' | 'file'
  color: string
  baseR: number
  connections: number
  source?: string
  file?: VaultFile
  fromWatch?: boolean
}

export interface GraphLink {
  source: string
  target: string
  edgeType: 'relationship' | 'mention'
}

const SOURCE_COLORS: Record<string, string> = {
  claude: '#E53E3E',
  chatgpt: '#F0F0F0',
  gemini: '#9B59B6',
  manual: '#6B9FD4',
}

const CODE_EXTS = new Set(['.py', '.js', '.ts', '.jsx', '.tsx', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.rb', '.php', '.sh'])
const DOC_EXTS = new Set(['.pdf', '.docx', '.doc', '.pptx', '.xlsx'])
const DATA_EXTS = new Set(['.json', '.csv', '.yaml', '.yml', '.xml', '.toml', '.sql'])
const TEXT_EXTS = new Set(['.md', '.txt', '.rst'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'])

export function fileColor(ext: string): string {
  const e = ext.toLowerCase()
  if (CODE_EXTS.has(e)) return '#4CAF50'
  if (DOC_EXTS.has(e)) return '#FF9800'
  if (DATA_EXTS.has(e)) return '#FFC107'
  if (TEXT_EXTS.has(e)) return '#9E9E9E'
  if (IMAGE_EXTS.has(e)) return '#E91E63'
  return '#555555'
}

export function filenameStem(f: VaultFile): string {
  return f.filename.replace(/\.[^.]+$/, '').toLowerCase()
}

export function buildGraph(
  memories: GraphMemory[],
  relationships: GraphRelationship[],
  vaultFiles: VaultFile[],
  filter: FilterMode,
  watchPath?: string | null,
): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = []
  const memoryIdSet = new Set<string>()
  const fileIdSet = new Set<string>()

  if (filter !== 'files') {
    for (const m of memories) {
      nodes.push({
        id: m.id,
        title: m.title,
        nodeType: 'memory',
        color: SOURCE_COLORS[m.source] ?? '#6B9FD4',
        baseR: 6,
        connections: 0,
        source: m.source,
      })
      memoryIdSet.add(m.id)
    }
  }

  if (filter !== 'memories') {
    for (const f of vaultFiles) {
      const fromWatch = !!(watchPath && f.filepath.startsWith(watchPath))
      nodes.push({
        id: f.id,
        title: f.filename,
        nodeType: 'file',
        color: fileColor(f.extension),
        baseR: 5,
        connections: 0,
        file: f,
        fromWatch,
      })
      fileIdSet.add(f.id)
    }
  }

  const links: GraphLink[] = []

  for (const r of relationships) {
    if (memoryIdSet.has(r.memory_a_id) && memoryIdSet.has(r.memory_b_id)) {
      links.push({ source: r.memory_a_id, target: r.memory_b_id, edgeType: 'relationship' })
    }
  }

  if (filter === 'both') {
    for (const m of memories) {
      const haystack = (m.title + ' ' + m.content).toLowerCase()
      for (const f of vaultFiles) {
        const stem = filenameStem(f)
        if (stem.length > 2 && haystack.includes(stem)) {
          links.push({ source: m.id, target: f.id, edgeType: 'mention' })
        }
      }
    }
  }

  const counts = new Map<string, number>()
  for (const l of links) {
    counts.set(l.source, (counts.get(l.source) ?? 0) + 1)
    counts.set(l.target, (counts.get(l.target) ?? 0) + 1)
  }
  for (const n of nodes) {
    n.connections = counts.get(n.id) ?? 0
  }

  return { nodes, links }
}
