import React, { useMemo, useState } from 'react'
import { X, Copy, Brain, Check } from 'lucide-react'
import { useStore } from '../store'

interface InsightPopupProps {
  onClose: () => void
}

export default function InsightPopup({ onClose }: InsightPopupProps): React.ReactElement {
  const { memories, relationships, selectedMemoryId, selectMemory, setView } = useStore()
  const [copied, setCopied] = useState(false)

  const related = useMemo(() => {
    if (memories.length === 0) return []

    if (selectedMemoryId) {
      const relatedIds = new Set<string>()
      relationships.forEach(r => {
        if (r.memory_a_id === selectedMemoryId) relatedIds.add(r.memory_b_id)
        if (r.memory_b_id === selectedMemoryId) relatedIds.add(r.memory_a_id)
      })
      if (relatedIds.size > 0) {
        return memories.filter(m => relatedIds.has(m.id)).slice(0, 3)
      }
    }
    // Fallback to most recent (excluding current)
    return memories.filter(m => m.id !== selectedMemoryId).slice(0, 3)
  }, [memories, relationships, selectedMemoryId])

  const copyContext = async (): Promise<void> => {
    // Store rows are light (no content) — fetch full bodies for the copy.
    const full = await Promise.all(related.map(m => window.electron.memories.get(m.id)))
    const text = full
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .map(m => `# ${m.title}\n\n${m.content}`)
      .join('\n\n---\n\n')
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="absolute bottom-16 right-4 w-72 bg-[#2d2d2d] border border-[#404040] rounded-xl shadow-2xl z-50 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#404040]">
        <div className="flex items-center gap-2">
          <Brain size={13} className="text-[#6366f1]" />
          <span className="text-sm font-semibold text-[#e0e0e0]">Memory Insights</span>
        </div>
        <button onClick={onClose} className="text-[#555] hover:text-[#b0b0b0] transition-colors">
          <X size={13} />
        </button>
      </div>

      <div className="p-3">
        <p className="text-xs text-[#555] mb-2.5">
          {related.length > 0
            ? `${related.length} relevant ${related.length === 1 ? 'memory' : 'memories'} found`
            : 'No memories yet — create some first.'}
        </p>

        <div className="space-y-1.5">
          {related.map(m => (
            <div
              key={m.id}
              onClick={() => { selectMemory(m.id); setView('editor'); onClose() }}
              className="p-2.5 bg-[#1a1a1a] rounded-lg cursor-pointer hover:bg-[#3a3a4a] transition-colors border border-transparent hover:border-[#6366f1]/30"
            >
              <p className="text-xs font-medium text-[#e0e0e0] truncate">{m.title}</p>
              <p className="text-xs text-[#555] truncate mt-0.5">
                {(m.content || m.snippet || '').replace(/[#*`_]/g, '').slice(0, 65)}
              </p>
            </div>
          ))}
        </div>

        {related.length > 0 && (
          <button
            onClick={() => void copyContext()}
            className="mt-3 w-full flex items-center justify-center gap-2 py-2 bg-[#6366f1] hover:bg-[#4f46e5] text-white text-xs rounded-lg font-medium transition-colors"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied to clipboard!' : 'Copy context for AI'}
          </button>
        )}
      </div>
    </div>
  )
}
