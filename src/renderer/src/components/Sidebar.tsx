import React, { useState } from 'react'
import { Search, Tag, X, HardDrive, Eye, Settings2 } from 'lucide-react'
import { useStore } from '../store'
import FileTree from './FileTree'
import TagManager from './TagManager'
import type { Memory, VaultFile } from '../../../types'

type SidebarTab = 'memories' | 'files'

// Max memory rows mounted at once — see the render-cap comment at the list.
const SIDEBAR_RENDER_CAP = 300

const SOURCE_COLORS: Record<string, string> = {
  claude: '#E53E3E',
  chatgpt: '#F0F0F0',
  gemini: '#9B59B6',
  manual: '#6B9FD4',
}

interface SidebarProps {
  onNewMemory: () => void
}

export default function Sidebar({ onNewMemory: _onNewMemory }: SidebarProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<SidebarTab>('memories')
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const {
    memories, selectedMemoryId, selectedTags, currentView,
    setView, selectMemory, clearSelection, toggleTag, clearSelectedTags,
    getTagCounts, searchQuery, setSearchQuery,
    vaultConfig, selectedFileId, selectFile, fetchVaultFiles,
    getVaultOnlyFiles, getWatchFiles, indexProgress,
  } = useStore()

  const tagCounts = getTagCounts()
  const allTags = Object.keys(tagCounts).sort()
  const vaultFiles = getVaultOnlyFiles()
  const watchFiles = getWatchFiles()

  const filtered = memories.filter(m => {
    const q = searchQuery.toLowerCase()
    // Light rows carry a snippet instead of full content; full-text matches
    // beyond the snippet come from the Search view (FTS5), not this filter.
    const body = m.content || m.snippet || ''
    const matchesQuery = !q ||
      m.title.toLowerCase().includes(q) ||
      body.toLowerCase().includes(q)
    const matchesTags = selectedTags.length === 0 ||
      selectedTags.some(t => m.tags.includes(t))
    return matchesQuery && matchesTags
  })

  return (
    <div className="flex flex-col h-full w-[280px] min-w-[280px] bg-[#1A1A1A] border-r border-[#242424]">
      {/* Tab switcher: Memories / Files */}
      <div className="flex px-3 py-2 gap-1 border-b border-[#242424] flex-shrink-0">
        <TabButton
          active={activeTab === 'memories'}
          onClick={() => setActiveTab('memories')}
          label="Memories"
          count={memories.length}
          icon={null}
        />
        <TabButton
          active={activeTab === 'files'}
          onClick={() => setActiveTab('files')}
          label="Files"
          count={vaultFiles.length + watchFiles.length}
          icon={null}
        />
      </div>

      {activeTab === 'memories' ? (
        <>
          {/* Search */}
          <div className="px-3 py-2 flex-shrink-0">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#444]" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Filter memories…"
                className="w-full bg-[#111] text-[#E8E8E8] text-xs pl-7 pr-3 py-1.5 rounded-lg border border-[#2a2a2a] focus:outline-none focus:border-[#6B9FD4] placeholder-[#333]"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[#444] hover:text-[#888]"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          </div>

          {/* Tags */}
          {allTags.length > 0 && (
            <div className="px-3 pb-2 flex-shrink-0">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1 text-[#444]">
                  <Tag size={10} />
                  <span className="text-xs uppercase tracking-wider">Tags</span>
                </div>
                <div className="flex items-center gap-2">
                  {selectedTags.length > 0 && (
                    <button onClick={clearSelectedTags} className="text-xs text-[#6B9FD4] hover:text-[#8ab5d4]">Clear</button>
                  )}
                  <button
                    onClick={() => setTagManagerOpen(true)}
                    title="Manage tags (rename, merge, delete)"
                    className="text-[#444] hover:text-[#6B9FD4] transition-colors"
                  >
                    <Settings2 size={11} />
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {allTags.slice(0, 10).map(tag => (
                  <button
                    key={tag}
                    onClick={() => toggleTag(tag)}
                    className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                      selectedTags.includes(tag)
                        ? 'bg-[#6B9FD4]/20 border-[#6B9FD4] text-[#6B9FD4]'
                        : 'border-[#2a2a2a] text-[#555] hover:border-[#6B9FD4] hover:text-[#6B9FD4]'
                    }`}
                  >
                    {tag} <span className="opacity-50">{tagCounts[tag]}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="h-px bg-[#242424] mx-3 flex-shrink-0" />

          {/* Memory list */}
          <div className="flex-1 overflow-y-auto pt-1">
            <div className="px-3 py-1.5 flex-shrink-0">
              <span className="text-xs text-[#333] uppercase tracking-wider">Recent · {filtered.length}</span>
            </div>
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-[#333] text-xs leading-relaxed">
                {memories.length === 0 ? 'No memories yet.' : 'No matches found.'}
              </div>
            ) : (
              // Render cap (100k-scale): mounting one DOM row per memory put
              // 7+ MB of nodes in the tree at 60k memories and froze first
              // paint. The list is recency-ordered; anything beyond the cap
              // is reachable via the filter box or the Search view (FTS5).
              filtered.slice(0, SIDEBAR_RENDER_CAP).map(m => (
                <MemoryItem
                  key={m.id}
                  memory={m}
                  isSelected={m.id === selectedMemoryId}
                  onClick={() => {
                    selectMemory(m.id)
                    if (currentView !== 'editor') setView('editor')
                  }}
                />
              ))
            )}
            {filtered.length > SIDEBAR_RENDER_CAP && (
              <div className="px-4 py-3 text-center text-[#444] text-xs">
                Showing {SIDEBAR_RENDER_CAP} of {filtered.length} — narrow with the filter box or use Search
              </div>
            )}
          </div>
        </>
      ) : (
        /* Files tab — vault + watch sections */
        <div className="flex-1 overflow-y-auto">
          {vaultConfig?.vaultPath ? (
            <>
              {/* Vault section */}
              <div className="px-3 pt-2 pb-1 flex-shrink-0">
                <div className="flex items-center gap-1.5 text-xs text-[#444] uppercase tracking-wider">
                  <HardDrive size={10} />
                  <span>Vault</span>
                  <span className="text-[#333]">({vaultFiles.length})</span>
                </div>
              </div>
              <FileTree
                files={vaultFiles}
                vaultRoot={vaultConfig.vaultPath}
                selectedFileId={selectedFileId}
                onSelectFile={(file: VaultFile) => {
                  selectFile(file.id)
                  if (currentView !== 'editor') setView('editor')
                }}
                onRefresh={() => void fetchVaultFiles()}
              />

              {/* Watch folder section */}
              {vaultConfig.watchPath && (
                <>
                  <div className="px-3 pt-3 pb-1 border-t border-[#242424] flex-shrink-0">
                    <div className="flex items-center gap-1.5 text-xs text-[#444] uppercase tracking-wider">
                      <Eye size={10} />
                      <span>Watched: {vaultConfig.watchPath.split(/[/\\]/).pop()}</span>
                      <span className="text-[#333]">({watchFiles.length})</span>
                    </div>
                  </div>
                  <FileTree
                    files={watchFiles}
                    vaultRoot={vaultConfig.watchPath}
                    selectedFileId={selectedFileId}
                    onSelectFile={(file: VaultFile) => {
                      selectFile(file.id)
                      if (currentView !== 'editor') setView('editor')
                    }}
                    onRefresh={() => void fetchVaultFiles()}
                    readOnly
                  />
                </>
              )}
            </>
          ) : (
            <div className="px-4 py-6 text-center text-[#333] text-xs leading-relaxed">
              No vault configured.{'\n'}Set up a vault in Settings.
            </div>
          )}
        </div>
      )}

      {indexProgress && (
        <div className="flex-shrink-0 px-3 py-1.5 border-t border-[#242424] text-xs text-[#555] bg-[#1a1a1a]">
          Indexing files: {indexProgress.current}/{indexProgress.total}…
        </div>
      )}

      {tagManagerOpen && <TagManager onClose={() => setTagManagerOpen(false)} />}
    </div>
  )
}

function TabButton({ active, onClick, label, count }: {
  active: boolean; onClick: () => void; label: string; count: number; icon: React.ReactNode
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
        active ? 'bg-[#242424] text-[#E8E8E8]' : 'text-[#555] hover:text-[#888]'
      }`}
    >
      {label}
      <span className={`${active ? 'text-[#444]' : 'text-[#333]'}`}>({count})</span>
    </button>
  )
}

function MemoryItem({ memory, isSelected, onClick }: {
  memory: Memory; isSelected: boolean; onClick: () => void
}): React.ReactElement {
  const dot = SOURCE_COLORS[memory.source] || '#6B9FD4'
  const preview = (memory.content || memory.snippet || '').replace(/[#*`_>\-]/g, '').trim().slice(0, 80)

  return (
    <div
      onClick={onClick}
      className={`px-3 py-3 cursor-pointer border-l-2 transition-all min-h-[64px] ${
        isSelected
          ? 'bg-[#242424] border-[#6B9FD4]'
          : 'border-transparent hover:bg-[#1e1e1e] hover:border-[#333]'
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="text-sm font-semibold text-[#E8E8E8] leading-snug truncate">
          {memory.title || 'Untitled'}
        </span>
        <span className="w-2 h-2 rounded-full mt-1 flex-shrink-0" style={{ backgroundColor: dot }} />
      </div>
      {preview && (
        <p className="text-xs text-[#555] line-clamp-2 leading-relaxed">{preview}</p>
      )}
      {memory.tags.length > 0 && (
        <div className="flex gap-1 mt-1.5 flex-wrap">
          {memory.tags.slice(0, 3).map(t => (
            <span key={t} className="text-xs px-1.5 py-0 rounded-full bg-[#111] text-[#444]">{t}</span>
          ))}
        </div>
      )}
    </div>
  )
}
