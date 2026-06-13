import React, { useEffect, useCallback, useState } from 'react'
import { FileText, Network, Search as SearchIcon, Sun, BookOpen, Settings as SettingsIcon, Plus, FolderOpen } from 'lucide-react'
import { useStore } from './store'
import Dashboard from './pages/Dashboard'
import GraphView from './pages/GraphView'
import Search from './pages/Search'
import Settings from './pages/Settings'
import DigestView from './pages/DigestView'
import JournalView from './pages/JournalView'
import Sidebar from './components/Sidebar'
import ErrorBoundary from './components/ErrorBoundary'
import type { ViewType, SystemStatus, SeedStatus } from '../../types'

const NAV_ITEMS: { view: ViewType; icon: React.ReactNode; label: string; shortcut: string }[] = [
  { view: 'editor', icon: <FileText size={16} />, label: 'Notes', shortcut: 'Ctrl+1' },
  { view: 'graph', icon: <Network size={16} />, label: 'Graph', shortcut: 'Ctrl+2' },
  { view: 'search', icon: <SearchIcon size={16} />, label: 'Search', shortcut: 'Ctrl+3' },
  { view: 'digest', icon: <Sun size={16} />, label: 'Digest', shortcut: 'Ctrl+4' },
  { view: 'journal', icon: <BookOpen size={16} />, label: 'Journal', shortcut: 'Ctrl+5' },
]

export default function App(): React.ReactElement {
  const {
    fetchMemories, fetchRelationships, fetchVaultFiles, fetchMentionEdges,
    currentView, setView, clearSelection,
    createMemory, selectMemory,
    searchQuery, setSearchQuery,
  } = useStore()

  // First-launch forcing function: if no vault is configured we route the
  // user straight to Settings and show a banner explaining what's needed.
  // Without this, a fresh install lands in the editor with no obvious path
  // forward — the most common "I tried it, it didn't work" outcome.
  const [needsVault, setNeedsVault] = useState(false)

  // Lightweight status pulse for the bottom bar. Refreshes every 30s and on
  // memory changes (since embeddedCount updates as new memories are stored).
  const [status, setStatus] = useState<SystemStatus | null>(null)
  // Live embedding backfill state (v0.3.0) — non-null only while running/paused.
  const [seedStatus, setSeedStatus] = useState<SeedStatus | null>(null)

  useEffect(() => {
    fetchMemories()
    fetchRelationships()
    void fetchVaultFiles()
    void fetchMentionEdges()

    void window.electron.vault.getConfig().then(cfg => {
      if (!cfg?.vaultPath) {
        setNeedsVault(true)
        setView('settings')
      }
    }).catch(() => {})

    const refreshStatus = (): void => {
      void window.electron.system.getStatus().then(setStatus).catch(() => {})
    }
    refreshStatus()
    const statusTimer = setInterval(refreshStatus, 30_000)

    const unsubMemories = window.electron.events.onMemoriesChanged(() => {
      fetchMemories()
      void fetchMentionEdges()
      refreshStatus()
    })
    const unsubVault = window.electron.events.onVaultChanged(() => {
      void fetchVaultFiles()
      void fetchMentionEdges()
      void window.electron.vault.getConfig().then(cfg => {
        if (cfg?.vaultPath) setNeedsVault(false)
      }).catch(() => {})
    })
    const unsubProgress = window.electron.events.onIndexProgress(data => {
      useStore.setState({ indexProgress: data.current >= data.total ? null : data })
    })
    const unsubEmbed = window.electron.events.onEmbeddingsProgress(s => {
      setSeedStatus(s.state === 'running' || s.state === 'paused' ? s : null)
      if (s.state === 'done') refreshStatus()
    })
    return () => { unsubMemories(); unsubVault(); unsubProgress(); unsubEmbed(); clearInterval(statusTimer) }
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      if (e.key === '1') { e.preventDefault(); clearSelection(); setView('editor') }
      if (e.key === '2') { e.preventDefault(); clearSelection(); setView('graph') }
      if (e.key === '3') { e.preventDefault(); clearSelection(); setView('search') }
      if (e.key === '4') { e.preventDefault(); clearSelection(); setView('digest') }
      if (e.key === '5') { e.preventDefault(); clearSelection(); setView('journal') }
      if (e.key === 'k') { e.preventDefault(); clearSelection(); setView('search') }
      if (e.key === ',') { e.preventDefault(); setView('settings') }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setView, clearSelection])

  const handleNewMemory = useCallback(async () => {
    const m = await createMemory({ title: 'New Memory', content: '', source: 'manual', tags: [] })
    selectMemory(m.id)
    if (currentView !== 'editor') setView('editor')
  }, [createMemory, selectMemory, currentView, setView])

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-screen bg-[#0F0F0F] text-[#E8E8E8] overflow-hidden select-none">
      {/* First-launch banner: shown until a vault is configured. */}
      {needsVault && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-[#6366f1]/15 border-b border-[#6366f1]/40 flex-shrink-0">
          <FolderOpen size={14} className="text-[#a5b4fc] flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-[#E8E8E8]">Pick a vault folder to get started</div>
            <div className="text-[11px] text-[#a5b4fc] truncate">
              Cortex stores conversations and notes here. No files outside the folder are moved or copied.
            </div>
          </div>
        </div>
      )}
      {/* Top nav bar */}
      <div className="flex items-center h-12 px-4 gap-4 bg-[#111] border-b border-[#242424] flex-shrink-0">
        {/* Brand */}
        <div className="flex items-center gap-2 w-[236px] flex-shrink-0">
          <span className="text-[#6B9FD4] font-bold text-sm">◆</span>
          <span className="text-[#E8E8E8] font-semibold text-sm tracking-wide">Cortex</span>
        </div>

        {/* Global search */}
        <div className="flex-1 max-w-xl">
          <div className="relative">
            <SearchIcon size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#444]" />
            <input
              type="text"
              value={currentView === 'search' ? searchQuery : ''}
              onChange={e => {
                if (currentView !== 'search') { clearSelection(); setView('search') }
                setSearchQuery(e.target.value)
              }}
              onFocus={() => {
                if (currentView !== 'search') { clearSelection(); setView('search') }
              }}
              placeholder="Search memories and files…"
              className="w-full bg-[#1a1a1a] text-[#E8E8E8] text-xs pl-9 pr-4 py-1.5 rounded-lg border border-[#2a2a2a] focus:outline-none focus:border-[#6B9FD4] placeholder-[#333]"
            />
          </div>
        </div>

        {/* Right actions */}
        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={() => void handleNewMemory()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#6B9FD4]/15 hover:bg-[#6B9FD4]/25 text-[#6B9FD4] transition-colors"
            title="New memory (Ctrl+N)"
          >
            <Plus size={13} /> New
          </button>
          <button
            onClick={() => setView('settings')}
            className={`p-2 rounded-lg transition-colors ${
              currentView === 'settings'
                ? 'text-[#6B9FD4] bg-[#6B9FD4]/15'
                : 'text-[#444] hover:text-[#888] hover:bg-[#1a1a1a]'
            }`}
            title="Settings (Ctrl+,)"
          >
            <SettingsIcon size={15} />
          </button>
        </div>
      </div>

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Icon rail */}
        <div className="flex flex-col items-center py-3 gap-1 bg-[#111] border-r border-[#242424] w-12 flex-shrink-0">
          {NAV_ITEMS.map(({ view, icon, label, shortcut }) => (
            <button
              key={view}
              onClick={() => { clearSelection(); setView(view) }}
              title={`${label} (${shortcut})`}
              className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
                currentView === view
                  ? 'bg-[#6B9FD4]/20 text-[#6B9FD4]'
                  : 'text-[#444] hover:text-[#888] hover:bg-[#1a1a1a]'
              }`}
            >
              {icon}
            </button>
          ))}
        </div>

        {/* Sidebar (hidden in settings) */}
        {currentView !== 'settings' && (
          <Sidebar onNewMemory={handleNewMemory} />
        )}

        {/* Content — flex container so child views (which use flex-1 + overflow-y-auto) get a bounded height and can scroll. */}
        <main className="flex-1 overflow-hidden flex flex-col min-w-0">
          {currentView === 'editor' && <Dashboard />}
          {currentView === 'graph' && <GraphView />}
          {currentView === 'search' && <Search />}
          {currentView === 'digest' && <DigestView />}
          {currentView === 'journal' && <JournalView />}
          {currentView === 'settings' && <Settings />}
        </main>
      </div>

      {/* Status bar */}
      <StatusBar status={status} seedStatus={seedStatus} onOpenSettings={() => setView('settings')} />
    </div>
    </ErrorBoundary>
  )
}

function StatusBar({ status, seedStatus, onOpenSettings }: { status: SystemStatus | null; seedStatus: SeedStatus | null; onOpenSettings: () => void }): React.ReactElement {
  // Indexing takes priority over the semantic-search status text — it's the
  // only live activity worth surfacing in a single status row.
  const indexProgress = useStore(s => s.indexProgress)
  const isIndexing = indexProgress !== null && indexProgress.total > 0

  if (isIndexing) {
    const { current, total } = indexProgress
    const pct = Math.min(100, Math.round((current / total) * 100))
    return (
      <button
        onClick={onOpenSettings}
        title="Indexing watch folder — click for Settings"
        className="flex items-center gap-3 h-6 px-4 text-[11px] bg-[#0a0a0a] border-t border-[#242424] flex-shrink-0 hover:bg-[#111] transition-colors text-left"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-[#6B9FD4] animate-pulse" />
        <span className="text-[#888]">Indexing… {current}/{total}</span>
        <div className="flex-1 max-w-[240px] h-1 bg-[#1a1a1a] rounded-full overflow-hidden">
          <div
            className="h-full bg-[#6B9FD4] transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Indexing ${current} of ${total} files`}
          />
        </div>
        <span className="text-[#444] tabular-nums">{pct}%</span>
      </button>
    )
  }

  // Embedding backfill in flight: show live progress instead of the stale
  // embedded count (second priority, after vault indexing).
  if (seedStatus && seedStatus.total > 0) {
    const pct = Math.min(100, Math.round((seedStatus.done / seedStatus.total) * 100))
    return (
      <button
        onClick={onOpenSettings}
        title="Embedding memories — click for Settings"
        className="flex items-center gap-3 h-6 px-4 text-[11px] bg-[#0a0a0a] border-t border-[#242424] flex-shrink-0 hover:bg-[#111] transition-colors text-left"
      >
        <span className={`w-1.5 h-1.5 rounded-full bg-[#a78bfa] ${seedStatus.state === 'running' ? 'animate-pulse' : ''}`} />
        <span className="text-[#888]">
          Embedding… {seedStatus.done}/{seedStatus.total}{seedStatus.state === 'paused' ? ' (paused)' : ''}
        </span>
        <div className="flex-1 max-w-[240px] h-1 bg-[#1a1a1a] rounded-full overflow-hidden">
          <div
            className="h-full bg-[#a78bfa] transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Embedded ${seedStatus.done} of ${seedStatus.total} memories`}
          />
        </div>
        <span className="text-[#444] tabular-nums">{pct}%</span>
      </button>
    )
  }

  const semanticOn = !!status && status.vectorSearch.enabled && status.ollama.reachable && status.ollama.modelPulled
  const label = !status ? 'Checking…'
    : semanticOn ? `Semantic search: on (${status.vectorSearch.embeddedCount}/${status.vectorSearch.totalMemories} embedded)`
    : 'Semantic search: off — keyword only'
  return (
    <button
      onClick={onOpenSettings}
      title="Open Settings → AI Features"
      className="flex items-center gap-2 h-6 px-4 text-[11px] bg-[#0a0a0a] border-t border-[#242424] flex-shrink-0 hover:bg-[#111] transition-colors text-left"
    >
      <span className={`w-1.5 h-1.5 rounded-full ${semanticOn ? 'bg-[#10a37f]' : 'bg-[#f59e0b]'}`} />
      <span className="text-[#666]">{label}</span>
      {status && (
        <span className="ml-auto text-[#333]">port {status.apiServer.port}</span>
      )}
    </button>
  )
}
