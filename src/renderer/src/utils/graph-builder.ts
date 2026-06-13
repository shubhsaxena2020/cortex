import type { VaultFile, MentionEdge } from '../../../types'

export type FilterMode = 'both' | 'memories' | 'files'

export interface GraphMemory {
  id: string
  title: string
  /** Unused by the graph since mention edges moved to the main process; kept optional for callers passing full rows. */
  content?: string
  source: string
  tags: string[]
}

export interface GraphRelationship {
  memory_a_id: string
  memory_b_id: string
  relationship_type: string
  signal_type?: string
  strength?: number
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
  signalType?: 'auto:tag' | 'auto:keyword' | 'auto:embedding' | 'manual' | 'wiki'
  strength?: number
  color?: string
}

const SOURCE_COLORS: Record<string, string> = {
  claude: '#7C3AED',
  chatgpt: '#10B981',
  gemini: '#F59E0B',
  manual: '#3B82F6',
}

export const EDGE_COLORS: Record<string, string> = {
  'auto:tag':       'rgba(59, 130, 246, 0.30)',   // blue-500 at 30%
  'auto:keyword':   'rgba(234, 179, 8, 0.28)',    // yellow-500 at 28%
  'auto:embedding': 'rgba(168, 85, 247, 0.32)',   // purple-500 at 32%
  'manual':         'rgba(148, 163, 184, 0.45)',   // slate-400 at 45%
  'wiki':           'rgba(16, 185, 129, 0.40)',   // emerald-500 at 40% — explicit links read strongest
}

export function edgeColor(link: GraphLink): string {
  if (link.edgeType === 'mention') {
    return 'rgba(148, 163, 184, 0.12)'  // slate-400 at 12% — nearly invisible
  }
  return EDGE_COLORS[link.signalType ?? 'manual'] ?? EDGE_COLORS['manual']
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
  mentionEdges: MentionEdge[] = [],
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
      links.push({
        source: r.memory_a_id,
        target: r.memory_b_id,
        edgeType: 'relationship',
        signalType: (r.signal_type as GraphLink['signalType']) ?? 'manual',
        strength: (r.strength as number) ?? 0,
      })
    }
  }

  if (filter === 'both') {
    // Mention edges are precomputed in the MAIN process (mention-edges.ts)
    // behind a fingerprint cache, because building them needs memory content
    // — which no longer ships to the renderer at all. (History: the original
    // renderer-side O(memories × files) substring scan cost ~80s and 1.35M
    // edges at 10k+5k; the inverted-index rewrite fixed the algorithm, and
    // the 100k overhaul moved it server-side to kill the content IPC bill.)
    // Endpoints are validated against the current node sets so stale cache
    // rows or filtered nodes can't produce dangling links.
    for (const e of mentionEdges) {
      if (memoryIdSet.has(e.source) && fileIdSet.has(e.target)) {
        links.push({ source: e.source, target: e.target, edgeType: 'mention' })
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
