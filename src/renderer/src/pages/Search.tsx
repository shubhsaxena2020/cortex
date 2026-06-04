import React, { useState, useEffect } from 'react'
import { Search as SearchIcon, X, Filter, FileText, HardDrive } from 'lucide-react'
import { useStore } from '../store'
import type { SearchResult, MemorySource, VaultFile } from '../../../types'

const SOURCE_COLORS: Record<string, string> = {
  claude: '#6366f1',
  chatgpt: '#10a37f',
  gemini: '#8b5cf6',
  manual: '#3b82f6',
}

const SOURCE_OPTIONS: { value: MemorySource | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'claude', label: 'Claude' },
  { value: 'chatgpt', label: 'ChatGPT' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'manual', label: 'Manual' },
]

type SearchType = 'all' | 'memories' | 'files'

type UnifiedResult =
  | { kind: 'memory'; data: SearchResult }
  | { kind: 'file'; data: VaultFile }

export default function Search(): React.ReactElement {
  const {
    selectMemory, selectFile, setView,
    searchMemories, getAllTags,
  } = useStore()

  const [query, setQuery] = useState('')
  const [searchType, setSearchType] = useState<SearchType>('all')
  const [source, setSource] = useState<MemorySource | ''>('')
  const [tags, setTags] = useState<string[]>([])
  const [memResults, setMemResults] = useState<SearchResult[]>([])
  const [fileResults, setFileResults] = useState<VaultFile[]>([])
  const [busy, setBusy] = useState(false)

  const allTags = getAllTags()

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const runSearch = async () => {
    setBusy(true)
    try {
      const searchPromises: [Promise<void>, Promise<void>] = [
        Promise.resolve(),
        Promise.resolve(),
      ]

      if (searchType !== 'files') {
        searchPromises[0] = searchMemories(query, tags.length ? tags : undefined, source || undefined)
          .then(() => {}) as Promise<void>
      } else {
        setMemResults([])
        searchPromises[0] = Promise.resolve()
      }

      if (searchType !== 'memories' && query.trim()) {
        searchPromises[1] = window.electron.vault.semanticSearch(query)
          .then(files => { setFileResults(files) })
      } else if (searchType !== 'memories' && !query.trim()) {
        searchPromises[1] = window.electron.vault.getFiles()
          .then(files => { setFileResults(files.slice(0, 30)) })
      } else {
        setFileResults([])
        searchPromises[1] = Promise.resolve()
      }

      await Promise.all(searchPromises)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void runSearch() }, [query, source, tags, searchType])

  // Sync memResults from store
  const storeResults = useStore(s => s.searchResults)
  useEffect(() => {
    if (searchType !== 'files') setMemResults(storeResults)
  }, [storeResults, searchType])

  const toggleTag = (t: string): void =>
    setTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])

  const unified: UnifiedResult[] = [
    ...memResults.map(r => ({ kind: 'memory' as const, data: r })),
    ...fileResults.map(f => ({ kind: 'file' as const, data: f })),
  ]

  return (
    <div className="flex w-full h-full">
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#404040] bg-[#222] space-y-3">
          {/* Query input */}
          <div className="relative">
            <SearchIcon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555]" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search memories and files… (semantic when available)"
              className="w-full bg-[#1a1a1a] text-[#e0e0e0] pl-10 pr-10 py-2.5 rounded-lg border border-[#404040] focus:outline-none focus:border-[#6366f1] text-sm placeholder-[#444]"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#555] hover:text-[#b0b0b0]"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* Type toggle */}
          <div className="flex items-center gap-3">
            <div className="flex rounded bg-[#1a1a1a] border border-[#404040] p-0.5 gap-0.5">
              {([
                { v: 'all' as SearchType, icon: <Filter size={10} />, label: 'All' },
                { v: 'memories' as SearchType, icon: <FileText size={10} />, label: 'Memories' },
                { v: 'files' as SearchType, icon: <HardDrive size={10} />, label: 'Files' },
              ]).map(({ v, icon, label }) => (
                <button
                  key={v}
                  onClick={() => setSearchType(v)}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    searchType === v ? 'bg-[#6366f1] text-white' : 'text-[#666] hover:text-[#aaa]'
                  }`}
                >
                  {icon} {label}
                </button>
              ))}
            </div>

            {/* Source filter (only for memories) */}
            {searchType !== 'files' && (
              <div className="flex gap-1 flex-wrap">
                {SOURCE_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setSource(opt.value)}
                    className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                      source === opt.value
                        ? 'border-[#6366f1] bg-[#6366f1]/20 text-[#a5b4fc]'
                        : 'border-[#404040] text-[#666] hover:border-[#555] hover:text-[#b0b0b0]'
                    }`}
                    style={opt.value && source !== opt.value ? { color: SOURCE_COLORS[opt.value] + '99' } : {}}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Tag filter */}
          {searchType !== 'files' && allTags.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {allTags.map(t => (
                <button
                  key={t}
                  onClick={() => toggleTag(t)}
                  className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                    tags.includes(t)
                      ? 'border-[#6366f1] bg-[#6366f1]/20 text-[#a5b4fc]'
                      : 'border-[#404040] text-[#555] hover:border-[#555]'
                  }`}
                >
                  #{t}
                </button>
              ))}
              {tags.length > 0 && (
                <button onClick={() => setTags([])} className="text-xs text-[#6366f1] ml-1 hover:text-[#818cf8]">
                  clear
                </button>
              )}
            </div>
          )}
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {busy ? (
            <div className="text-center text-[#444] text-sm py-10">Searching…</div>
          ) : unified.length === 0 ? (
            <div className="text-center text-[#333] py-10">
              {query
                ? <><p className="text-[#555]">No results for</p><p className="text-[#444] text-sm mt-1">"{query}"</p></>
                : <p className="text-[#444] text-sm">Type to search memories and files</p>}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-[#444]">
                {unified.length} {unified.length === 1 ? 'result' : 'results'}
                {memResults.length > 0 && fileResults.length > 0 && (
                  <span className="ml-2 text-[#333]">
                    ({memResults.length} memories · {fileResults.length} files)
                  </span>
                )}
              </p>
              {unified.map(r => r.kind === 'memory' ? (
                <MemoryResultCard
                  key={`m-${r.data.id}`}
                  result={r.data}
                  onOpen={() => { selectMemory(r.data.id); setView('editor') }}
                />
              ) : (
                <FileResultCard
                  key={`f-${r.data.id}`}
                  file={r.data}
                  onOpen={() => { selectFile(r.data.id); setView('editor') }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Result cards ──────────────────────────────────────────────────────────────

function MemoryResultCard({ result, onOpen }: { result: SearchResult; onOpen: () => void }): React.ReactElement {
  const color = SOURCE_COLORS[result.source] || '#3b82f6'
  return (
    <div
      onClick={onOpen}
      className="p-4 bg-[#2d2d2d] border border-[#404040] rounded-lg cursor-pointer hover:border-[#6366f1] hover:bg-[#303040] transition-all"
    >
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <h3 className="text-sm font-semibold text-[#e0e0e0] leading-snug">{result.title}</h3>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="text-xs px-1.5 py-0.5 rounded bg-[#1a1a1a] border border-[#404040] text-[#555]">
            Memory
          </span>
          <span className="text-xs px-2 py-0.5 rounded text-white capitalize font-medium" style={{ backgroundColor: color }}>
            {result.source}
          </span>
        </div>
      </div>
      {result.highlight ? (
        <div className="text-xs text-[#888] leading-relaxed" dangerouslySetInnerHTML={{ __html: result.highlight }} />
      ) : (
        <p className="text-xs text-[#666] leading-relaxed line-clamp-2">
          {result.content.replace(/[#*`_]/g, '').slice(0, 160)}
        </p>
      )}
      {result.tags.length > 0 && (
        <div className="flex gap-1 mt-2 flex-wrap">
          {result.tags.map(t => (
            <span key={t} className="text-xs px-1.5 rounded bg-[#3f3f3f] text-[#555]">#{t}</span>
          ))}
        </div>
      )}
    </div>
  )
}

function FileResultCard({ file, onOpen }: { file: VaultFile; onOpen: () => void }): React.ReactElement {
  const kb = (file.size / 1024).toFixed(1)
  const ext = file.extension || 'file'

  return (
    <div
      onClick={onOpen}
      className="p-4 bg-[#2d2d2d] border border-[#404040] rounded-lg cursor-pointer hover:border-[#22c55e] hover:bg-[#2d3530] transition-all"
    >
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <h3 className="text-sm font-semibold text-[#e0e0e0] leading-snug">{file.filename}</h3>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="text-xs px-1.5 py-0.5 rounded bg-[#1a1a1a] border border-[#404040] text-[#555]">
            File
          </span>
          <span className="text-xs px-2 py-0.5 rounded bg-[#1e2d1e] text-[#22c55e] font-mono border border-[#22c55e]/30">
            {ext}
          </span>
        </div>
      </div>
      <p className="text-xs text-[#555] truncate">{file.filepath}</p>
      {file.content && (
        <p className="text-xs text-[#666] leading-relaxed line-clamp-2 mt-1">
          {file.content.replace(/[#*`_]/g, '').slice(0, 160)}
        </p>
      )}
      <div className="text-xs text-[#444] mt-1.5">{kb} KB</div>
    </div>
  )
}
