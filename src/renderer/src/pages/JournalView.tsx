import React, { useEffect, useState, useCallback } from 'react'
import { Save, BookOpen, Clock } from 'lucide-react'
import { useStore } from '../store'
import type { Memory } from '../../../types'

/**
 * Daily journal (v0.5 thesis #2). Composition surface for the user's own
 * thinking, paired with the digest. One entry per day, upserted in place.
 * Recent entries listed on the left.
 */
export default function JournalView(): React.ReactElement {
  const { selectMemory, setView } = useStore()
  const [today, setToday] = useState<Memory | null>(null)
  const [content, setContent] = useState('')
  const [recent, setRecent] = useState<Memory[]>([])
  const [saveStatus, setSaveStatus] = useState<'saved' | 'unsaved' | 'saving'>('saved')
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    const [t, r] = await Promise.all([
      window.electron.journal.today(),
      window.electron.journal.recent(10),
    ])
    setToday(t)
    setRecent(r)
    setContent(t?.content ?? '')
    setSaveStatus('saved')
    setLoaded(true)
  }, [])

  useEffect(() => { void load() }, [load])

  // Debounced autosave — keeps the editor feeling instant without flooding IPC.
  useEffect(() => {
    if (!loaded) return
    if (content === (today?.content ?? '')) return
    setSaveStatus('unsaved')
    const t = setTimeout(async () => {
      setSaveStatus('saving')
      const updated = await window.electron.journal.upsert(content)
      setToday(updated)
      setSaveStatus('saved')
    }, 800)
    return () => clearTimeout(t)
  }, [content, today, loaded])

  const todayLabel = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <div className="flex-1 flex bg-[#0F0F0F] overflow-hidden">
      {/* Recent entries */}
      <aside className="w-[220px] flex-shrink-0 border-r border-[#242424] overflow-y-auto bg-[#111]">
        <div className="px-3 py-3 border-b border-[#242424]">
          <div className="flex items-center gap-1.5 text-xs text-[#444] uppercase tracking-wider">
            <BookOpen size={11} /> Journal
          </div>
        </div>
        {recent.map(e => (
          <button
            key={e.id}
            onClick={() => { selectMemory(e.id); setView('editor') }}
            className="w-full text-left px-3 py-2 border-b border-[#1a1a1a] hover:bg-[#1a1a1a] transition-colors"
          >
            <div className="text-xs text-[#888] font-medium">{e.title.replace('Journal — ', '')}</div>
            <div className="text-[10px] text-[#444] truncate mt-0.5">
              {(e.content || e.snippet || '').slice(0, 50)}
            </div>
          </button>
        ))}
        {recent.length === 0 && (
          <div className="px-3 py-6 text-[10px] text-[#444] text-center">
            No entries yet
          </div>
        )}
      </aside>

      {/* Today's entry */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-3 border-b border-[#242424] flex-shrink-0">
          <div>
            <div className="text-sm font-semibold text-[#E8E8E8]">{todayLabel}</div>
            <div className="flex items-center gap-1 text-[10px] text-[#555] mt-0.5">
              <Clock size={9} />
              <span>{saveStatus === 'saved' ? '✓ saved' : saveStatus === 'saving' ? '…' : '● unsaved'}</span>
            </div>
          </div>
          <div className="text-[10px] text-[#444]">Pair with today's digest (Ctrl+4)</div>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-6">
          {!loaded ? (
            <div className="text-[#444] text-sm animate-pulse">Loading…</div>
          ) : (
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder={`What's stuck with you today?\n\nFew lines. The point is the writing, not the polish.\nLink other memories with [[Title]].`}
              className="w-full h-full bg-transparent text-sm text-[#d0d0d0] focus:outline-none resize-none leading-relaxed placeholder-[#333] font-mono select-text"
              autoFocus
              spellCheck
            />
          )}
        </div>
      </div>
    </div>
  )
}
