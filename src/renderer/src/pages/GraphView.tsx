import React, { useCallback, useState } from 'react'
import { Info, X, ExternalLink, Eye } from 'lucide-react'
import GraphCanvas from '../components/GraphCanvas'
import type { FilterMode } from '../utils/graph-builder'
import type { GraphNode } from '../utils/graph-builder'
import { useStore } from '../store'

const SOURCE_COLORS: Record<string, string> = {
  claude: '#E53E3E',
  chatgpt: '#F0F0F0',
  gemini: '#9B59B6',
  manual: '#6B9FD4',
}

const FILE_COLORS: Record<string, string> = {
  code: '#4CAF50',
  doc: '#FF9800',
  data: '#FFC107',
  note: '#9E9E9E',
}

function formatDate(iso?: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function GraphView(): React.ReactElement {
  const { createMemory, selectMemory, selectFile, setView, memories, relationships, vaultFiles, vaultConfig } = useStore()
  const [filter, setFilter] = useState<FilterMode>('both')
  const [showAll, setShowAll] = useState(false)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)

  const watchPath = vaultConfig?.watchPath ?? null

  const totalNodes = filter === 'both' ? memories.length + vaultFiles.length
    : filter === 'memories' ? memories.length : vaultFiles.length

  const handleNewMemory = useCallback(async () => {
    const m = await createMemory({ title: 'New Memory', content: '', source: 'manual', tags: [] })
    selectMemory(m.id)
    setView('editor')
  }, [createMemory, selectMemory, setView])

  const handleNodeOpen = useCallback((node: GraphNode) => {
    if (node.nodeType === 'memory') {
      selectMemory(node.id)
    } else {
      selectFile(node.id)
    }
    setView('editor')
  }, [selectMemory, selectFile, setView])

  // Build connected nodes list for info panel
  const connectedNodes = selectedNode
    ? relationships
        .filter(r => r.memory_a_id === selectedNode.id || r.memory_b_id === selectedNode.id)
        .map(r => {
          const otherId = r.memory_a_id === selectedNode.id ? r.memory_b_id : r.memory_a_id
          return memories.find(m => m.id === otherId)
        })
        .filter(Boolean)
        .slice(0, 5)
    : []

  return (
    <div className="flex flex-col w-full h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#333] bg-[#1a1a1a] flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-[#888]">Knowledge Graph</span>
          <span className="text-xs text-[#444]">
            {totalNodes} nodes · {relationships.length} edges
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Connected / All toggle */}
          <div className="flex rounded bg-[#111] border border-[#333] p-0.5 gap-0.5">
            <button
              onClick={() => setShowAll(false)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                !showAll ? 'bg-[#6B9FD4] text-white' : 'text-[#555] hover:text-[#888]'
              }`}
            >
              Connected
            </button>
            <button
              onClick={() => setShowAll(true)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                showAll ? 'bg-[#6B9FD4] text-white' : 'text-[#555] hover:text-[#888]'
              }`}
            >
              <Eye size={9} />
              All
            </button>
          </div>

          {/* Filter toggle */}
          <div className="flex rounded bg-[#111] border border-[#333] p-0.5 gap-0.5">
            {(['both', 'memories', 'files'] as FilterMode[]).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors capitalize ${
                  filter === f ? 'bg-[#6B9FD4] text-white' : 'text-[#555] hover:text-[#888]'
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          {/* Legends */}
          {filter !== 'files' && (
            <div className="flex items-center gap-2">
              {Object.entries(SOURCE_COLORS).map(([src, color]) => (
                <div key={src} className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-xs text-[#444] capitalize">{src}</span>
                </div>
              ))}
            </div>
          )}
          {filter !== 'memories' && (
            <div className="flex items-center gap-2">
              {Object.entries(FILE_COLORS).map(([type, color]) => (
                <div key={type} className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full border border-dashed" style={{ backgroundColor: color, borderColor: color }} />
                  <span className="text-xs text-[#444] capitalize">{type}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative overflow-hidden">
        {totalNodes === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-[#333]">
              <div className="text-5xl mb-4">🕸️</div>
              <p className="text-[#555] text-sm">Nothing to show.</p>
              <p className="text-[#444] text-xs mt-1">Create memories or add files to your vault.</p>
            </div>
          </div>
        ) : (
          <GraphCanvas
            filter={filter}
            showAll={showAll}
            watchPath={watchPath}
            onNodeSelect={setSelectedNode}
            onNodeOpen={handleNodeOpen}
          />
        )}

        {/* Bottom hint */}
        {totalNodes > 0 && !selectedNode && (
          <div className="absolute bottom-4 left-4 flex items-center gap-1.5 text-xs text-[#2a2a2a] select-none pointer-events-none">
            <Info size={11} />
            Click node to select · Double-click to open · Drag to move · Scroll to zoom
          </div>
        )}

        {/* Info panel — bottom-left overlay */}
        {selectedNode && (
          <InfoPanel
            node={selectedNode}
            connectedMemories={connectedNodes.filter((m): m is NonNullable<typeof m> => !!m)}
            onClose={() => setSelectedNode(null)}
            onOpen={() => handleNodeOpen(selectedNode)}
            onJump={(id) => {
              const m = memories.find(x => x.id === id)
              if (m) {
                selectMemory(id)
                setView('editor')
              }
            }}
          />
        )}
      </div>
    </div>
  )
}

// ── Info panel ────────────────────────────────────────────────────────────────

interface InfoPanelProps {
  node: GraphNode
  connectedMemories: Array<{ id: string; title: string; source: string }>
  onClose: () => void
  onOpen: () => void
  onJump: (id: string) => void
}

function InfoPanel({ node, connectedMemories, onClose, onOpen, onJump }: InfoPanelProps): React.ReactElement {
  const isFile = node.nodeType === 'file'
  const fileDate = node.file ? formatDate(new Date(node.file.lastModified).toISOString()) : ''
  const dot = node.color

  return (
    <div className="absolute bottom-4 left-4 w-[220px] bg-[#1a1a1a]/95 backdrop-blur-sm border border-[#333] rounded-xl shadow-2xl overflow-hidden z-10">
      {/* Header */}
      <div className="flex items-start justify-between p-3 pb-2 border-b border-[#2a2a2a]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: dot }} />
          <span className="text-xs font-semibold text-[#e8e8e8] truncate">{node.title}</span>
        </div>
        <button onClick={onClose} className="text-[#444] hover:text-[#888] transition-colors ml-2 flex-shrink-0">
          <X size={12} />
        </button>
      </div>

      {/* Meta */}
      <div className="px-3 py-2 space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-[#555]">{isFile ? node.file?.extension || 'file' : node.source || 'memory'}</span>
          {fileDate && <span className="text-[#444]">{fileDate}</span>}
        </div>
        <div className="text-xs text-[#555]">
          {node.connections} connection{node.connections !== 1 ? 's' : ''}
          {node.fromWatch && <span className="ml-2 text-[#f59e0b]">watched</span>}
        </div>
      </div>

      {/* Connected nodes */}
      {connectedMemories.length > 0 && (
        <div className="border-t border-[#2a2a2a] px-3 py-2">
          <div className="text-xs text-[#444] uppercase tracking-wider mb-1.5">Connected</div>
          <div className="space-y-1">
            {connectedMemories.map(m => (
              <button
                key={m.id}
                onClick={() => onJump(m.id)}
                className="w-full text-left text-xs text-[#888] hover:text-[#e8e8e8] truncate transition-colors py-0.5"
              >
                {m.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Open button */}
      <div className="px-3 pb-3 pt-1">
        <button
          onClick={onOpen}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-[#6B9FD4]/20 hover:bg-[#6B9FD4]/30 text-[#6B9FD4] text-xs font-medium transition-colors"
        >
          <ExternalLink size={11} />
          Open
        </button>
      </div>
    </div>
  )
}
