// Memory detail panel — opened by clicking a memory node on the graph.
//
// Richer sibling of GraphView's InfoPanel (which remains for vault-file
// nodes): shows content preview, editable tags, related memories sorted by
// edge strength with signal provenance, and Copy / Open / Delete actions.

import React, { useMemo, useState, useCallback, useEffect } from 'react'
import { X, ExternalLink, Trash2, Copy, Check, Plus, Tag, Link2, Sparkles, Star } from 'lucide-react'
import { useStore } from '../store'
import { splitWikiSegments, titleIndexOf } from '../utils/wiki-text'
import type { MemorySummary } from '../../../types'

const SOURCE_BADGES: Record<string, { label: string; bg: string; fg: string }> = {
  claude:  { label: 'Claude',  bg: 'bg-[#7C3AED]/20', fg: 'text-[#a78bfa]' },
  chatgpt: { label: 'ChatGPT', bg: 'bg-[#10B981]/20', fg: 'text-[#34d399]' },
  gemini:  { label: 'Gemini',  bg: 'bg-[#F59E0B]/20', fg: 'text-[#fbbf24]' },
  manual:  { label: 'Manual',  bg: 'bg-[#3B82F6]/20', fg: 'text-[#60a5fa]' },
}

const SIGNAL_LABELS: Record<string, string> = {
  'auto:tag': 'tags',
  'auto:keyword': 'keywords',
  'auto:embedding': 'similar',
  'manual': 'linked',
  'wiki': 'wiki',
}

function formatDate(iso?: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

interface MemoryDetailProps {
  memoryId: string
  onClose: () => void
  onOpen: () => void
  onJump: (id: string) => void
}

export default function MemoryDetail({ memoryId, onClose, onOpen, onJump }: MemoryDetailProps): React.ReactElement | null {
  const { memories, relationships, updateMemory, deleteMemory, hydrateMemory, setPinned } = useStore()
  const [copied, setCopied] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [newTag, setNewTag] = useState('')
  const [addingTag, setAddingTag] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [summary, setSummary] = useState<MemorySummary | null>(null)
  const [generatingSummary, setGeneratingSummary] = useState(false)

  const memory = memories.find(m => m.id === memoryId)

  // Store rows are light — pull full content for the preview. The panel
  // renders immediately with the snippet-less body and fills in when the
  // hydrated row lands.
  useEffect(() => {
    void hydrateMemory(memoryId)
    void window.electron.summaries.get(memoryId).then(setSummary).catch(() => {})
  }, [memoryId, hydrateMemory])

  const related = useMemo(() => {
    if (!memory) return []
    return relationships
      .filter(r => (r.memory_a_id === memory.id || r.memory_b_id === memory.id) && r.signal_type !== 'wiki')
      .map(r => {
        const otherId = r.memory_a_id === memory.id ? r.memory_b_id : r.memory_a_id
        const other = memories.find(m => m.id === otherId)
        return other ? { memory: other, strength: r.strength, signal: r.signal_type } : null
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 8)
  }, [memory, relationships, memories])

  // Backlinks: wiki edges pointing AT this memory — "what links here".
  const backlinks = useMemo(() => {
    if (!memory) return []
    return relationships
      .filter(r => r.signal_type === 'wiki' && r.memory_b_id === memory.id)
      .map(r => memories.find(m => m.id === r.memory_a_id))
      .filter((m): m is NonNullable<typeof m> => m !== undefined)
  }, [memory, relationships, memories])

  // Title → id map so [[links]] in the content preview can jump on click.
  const titleIndex = useMemo(() => titleIndexOf(memories), [memories])

  const contentSegments = useMemo(() => {
    if (!memory?.content) return []
    const text = memory.content.length > 600 ? memory.content.slice(0, 600) + '…' : memory.content
    return splitWikiSegments(text)
  }, [memory?.content])

  const handleCopy = useCallback(async () => {
    if (!memory) return
    const md = `# ${memory.title}\n\n${memory.content}\n\n---\nSource: ${memory.source} · Tags: ${memory.tags.join(', ')}`
    await navigator.clipboard.writeText(md)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [memory])

  const handleDelete = useCallback(async () => {
    if (!memory) return
    if (!confirmingDelete) { setConfirmingDelete(true); return }
    await deleteMemory(memory.id)
    onClose()
  }, [memory, confirmingDelete, deleteMemory, onClose])

  const handleRemoveTag = useCallback(async (tag: string) => {
    if (!memory) return
    await updateMemory(memory.id, { tags: memory.tags.filter(t => t !== tag) })
  }, [memory, updateMemory])

  const handleAddTag = useCallback(async () => {
    if (!memory) return
    const tag = newTag.trim().toLowerCase().replace(/\s+/g, '-')
    if (!tag || memory.tags.includes(tag)) { setNewTag(''); setAddingTag(false); return }
    await updateMemory(memory.id, { tags: [...memory.tags, tag] })
    setNewTag('')
    setAddingTag(false)
  }, [memory, newTag, updateMemory])

  const handleTogglePin = useCallback(async () => {
    if (!memory) return
    await setPinned(memory.id, !memory.pinned)
  }, [memory, setPinned])

  const handleGenerateSummary = useCallback(async () => {
    if (!memory || generatingSummary) return
    setGeneratingSummary(true)
    try {
      const result = await window.electron.summaries.summarize(memory.id)
      setSummary(result)
    } finally {
      setGeneratingSummary(false)
    }
  }, [memory, generatingSummary])

  const handleSuggestTags = useCallback(async () => {
    if (!memory || suggesting) return
    setSuggesting(true)
    try {
      const suggested = await window.electron.tags.suggest(memory.id)
      const merged = [...memory.tags]
      for (const t of suggested) if (!merged.includes(t)) merged.push(t)
      if (merged.length > memory.tags.length) {
        await updateMemory(memory.id, { tags: merged })
      }
    } finally {
      setSuggesting(false)
    }
  }, [memory, suggesting, updateMemory])

  if (!memory) return null

  const badge = SOURCE_BADGES[memory.source] ?? SOURCE_BADGES.manual

  return (
    <div className="absolute top-4 right-4 bottom-4 w-[300px] flex flex-col bg-[#161616]/95 backdrop-blur-sm border border-[#333] rounded-xl shadow-2xl overflow-hidden z-10">
      {/* Header */}
      <div className="flex items-start justify-between p-3 pb-2 border-b border-[#2a2a2a] flex-shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {memory.pinned && <Star size={11} className="text-[#fbbf24] flex-shrink-0" fill="currentColor" />}
            <div className="text-sm font-semibold text-[#e8e8e8] leading-snug break-words">{memory.title}</div>
          </div>
          <div className="flex items-center gap-2 mt-1.5">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${badge.bg} ${badge.fg}`}>{badge.label}</span>
            <span className="text-[10px] text-[#555]">{formatDate(memory.created_at)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 ml-2 flex-shrink-0">
          <button
            onClick={() => void handleTogglePin()}
            aria-label={memory.pinned ? 'Unpin memory' : 'Pin memory'}
            title={memory.pinned ? 'Unpin from always-relevant context' : 'Pin as always-relevant context'}
            className={`transition-colors mt-0.5 ${memory.pinned ? 'text-[#fbbf24] hover:text-[#fcd34d]' : 'text-[#444] hover:text-[#fbbf24]'}`}
          >
            <Star size={13} fill={memory.pinned ? 'currentColor' : 'none'} />
          </button>
          <button onClick={onClose} aria-label="Close" className="text-[#444] hover:text-[#888] transition-colors mt-0.5">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Summary (v0.4) */}
      {(summary?.oneLine || summary?.paragraph) && (
        <div className="px-3 py-2 border-b border-[#2a2a2a] bg-[#a78bfa]/5 flex-shrink-0">
          <div className="flex items-center gap-1 text-[10px] text-[#a78bfa] uppercase tracking-wider mb-1">
            <Sparkles size={9} /> Summary
          </div>
          {summary.oneLine && <div className="text-xs text-[#ccc] mb-1">{summary.oneLine}</div>}
          {summary.paragraph && summary.paragraph !== summary.oneLine && (
            <div className="text-[11px] text-[#999] leading-relaxed">{summary.paragraph}</div>
          )}
        </div>
      )}
      {!summary && (
        <div className="px-3 py-1.5 border-b border-[#2a2a2a] flex-shrink-0">
          <button
            onClick={() => void handleGenerateSummary()}
            disabled={generatingSummary}
            className="flex items-center gap-1 text-[10px] text-[#a78bfa] hover:text-[#c4b5fd] disabled:opacity-50"
          >
            <Sparkles size={9} /> {generatingSummary ? 'Summarizing…' : 'Generate summary'}
          </button>
        </div>
      )}

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {/* Content preview — [[wiki links]] are clickable when they resolve */}
        {memory.content && (
          <div className="px-3 py-2 border-b border-[#2a2a2a]">
            <div className="text-xs text-[#999] leading-relaxed whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
              {contentSegments.map((seg, i) => {
                if (seg.type === 'text') return <React.Fragment key={i}>{seg.value}</React.Fragment>
                const targetId = titleIndex.get(seg.target.toLowerCase())
                return targetId ? (
                  <button
                    key={i}
                    onClick={() => onJump(targetId)}
                    className="text-[#6B9FD4] hover:underline"
                    title={`Open "${seg.target}"`}
                  >
                    {seg.label}
                  </button>
                ) : (
                  <span key={i} className="text-[#666] border-b border-dotted border-[#444]" title="No memory with this title yet">
                    {seg.label}
                  </span>
                )
              })}
            </div>
          </div>
        )}

        {/* Tags — editable */}
        <div className="px-3 py-2 border-b border-[#2a2a2a]">
          <div className="flex items-center gap-1 text-[10px] text-[#444] uppercase tracking-wider mb-1.5">
            <Tag size={9} /> Tags
          </div>
          <div className="flex flex-wrap gap-1">
            {memory.tags.map(tag => (
              <span key={tag} className="group flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#252525] text-[10px] text-[#999]">
                {tag}
                <button
                  onClick={() => handleRemoveTag(tag)}
                  aria-label={`Remove tag ${tag}`}
                  className="text-[#444] hover:text-[#e57373] transition-colors"
                >
                  <X size={8} />
                </button>
              </span>
            ))}
            {addingTag ? (
              <input
                autoFocus
                value={newTag}
                onChange={e => setNewTag(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void handleAddTag()
                  if (e.key === 'Escape') { setNewTag(''); setAddingTag(false) }
                }}
                onBlur={() => void handleAddTag()}
                className="w-20 px-1.5 py-0.5 rounded bg-[#252525] text-[10px] text-[#ccc] outline-none border border-[#6B9FD4]/50"
                placeholder="new-tag"
              />
            ) : (
              <button
                onClick={() => setAddingTag(true)}
                aria-label="Add tag"
                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[#1d1d1d] text-[10px] text-[#555] hover:text-[#888] hover:bg-[#252525] transition-colors"
              >
                <Plus size={8} /> add
              </button>
            )}
            <button
              onClick={() => void handleSuggestTags()}
              disabled={suggesting}
              aria-label="Suggest tags from content"
              title="Suggest tags from content"
              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[#1d1d1d] text-[10px] text-[#555] hover:text-[#a78bfa] hover:bg-[#252525] transition-colors disabled:opacity-50"
            >
              <Sparkles size={8} /> {suggesting ? '…' : 'suggest'}
            </button>
          </div>
        </div>

        {/* Backlinks — wiki links pointing at this memory */}
        {backlinks.length > 0 && (
          <div className="px-3 py-2 border-b border-[#2a2a2a]">
            <div className="flex items-center gap-1 text-[10px] text-[#444] uppercase tracking-wider mb-1.5">
              <Link2 size={9} /> Linked mentions · {backlinks.length}
            </div>
            <div className="space-y-0.5">
              {backlinks.map(m => (
                <button
                  key={m.id}
                  onClick={() => onJump(m.id)}
                  className="w-full flex items-center gap-2 text-left text-xs text-[#888] hover:text-[#e8e8e8] hover:bg-[#1f1f1f] rounded px-1.5 py-1 transition-colors"
                >
                  <span className="truncate">{m.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Related memories */}
        {related.length > 0 && (
          <div className="px-3 py-2">
            <div className="text-[10px] text-[#444] uppercase tracking-wider mb-1.5">
              Related · {related.length}
            </div>
            <div className="space-y-0.5">
              {related.map(({ memory: m, strength, signal }) => (
                <button
                  key={m.id}
                  onClick={() => onJump(m.id)}
                  className="w-full flex items-center justify-between gap-2 text-left text-xs text-[#888] hover:text-[#e8e8e8] hover:bg-[#1f1f1f] rounded px-1.5 py-1 transition-colors"
                >
                  <span className="truncate">{m.title}</span>
                  <span className="flex-shrink-0 text-[9px] text-[#555]">
                    {SIGNAL_LABELS[signal] ?? signal} {Math.round(strength * 100)}%
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-1.5 p-3 pt-2 border-t border-[#2a2a2a] flex-shrink-0">
        <button
          onClick={onOpen}
          className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-[#6B9FD4]/20 hover:bg-[#6B9FD4]/30 text-[#6B9FD4] text-xs font-medium transition-colors"
        >
          <ExternalLink size={11} /> Open
        </button>
        <button
          onClick={() => void handleCopy()}
          aria-label="Copy as markdown"
          className="flex items-center justify-center px-2.5 py-1.5 rounded-lg bg-[#252525] hover:bg-[#2e2e2e] text-[#888] transition-colors"
        >
          {copied ? <Check size={11} className="text-[#34d399]" /> : <Copy size={11} />}
        </button>
        <button
          onClick={() => void handleDelete()}
          onMouseLeave={() => setConfirmingDelete(false)}
          aria-label={confirmingDelete ? 'Confirm delete' : 'Delete memory'}
          className={`flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
            confirmingDelete
              ? 'bg-[#e57373]/25 text-[#e57373] font-medium'
              : 'bg-[#252525] hover:bg-[#2e2e2e] text-[#888]'
          }`}
        >
          <Trash2 size={11} />
          {confirmingDelete && 'Sure?'}
        </button>
      </div>
    </div>
  )
}
