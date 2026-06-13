import React, { useEffect, useState, useCallback } from 'react'
import { Sun, Moon, RefreshCw, ExternalLink, Sparkles } from 'lucide-react'
import { useStore } from '../store'
import type { Digest, DigestWindow } from '../../../types'

/**
 * Daily / weekly digest (v0.4 thesis #3).
 *
 * Grouped one-line summaries of recent captures. The "killer move" is that
 * this view answers "what did I capture this week?" in five seconds without
 * the user opening anything else; clicking a group entry jumps into the
 * editor on that memory.
 */
export default function DigestView(): React.ReactElement {
  const { selectMemory, setView } = useStore()
  const [window, setWindow] = useState<DigestWindow>('day')
  const [digest, setDigest] = useState<Digest | null>(null)
  const [loading, setLoading] = useState(false)
  const [summarizing, setSummarizing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setDigest(await window_electron_digest(window))
    } finally {
      setLoading(false)
    }
  }, [window])

  useEffect(() => { void load() }, [load])

  const handleOpen = (id: string): void => {
    selectMemory(id)
    setView('editor')
  }

  // "Summarize missing" — kicks the backfill so subsequent digest loads have
  // one-line summaries instead of titles. Bounded per-call so we don't
  // accidentally enqueue thousands.
  const handleBackfill = useCallback(async () => {
    setSummarizing(true)
    try {
      const total = digest?.totalMemories ?? 50
      await window.electron.summaries.backfill(Math.min(50, total))
      await load()
    } finally {
      setSummarizing(false)
    }
  }, [digest, load])

  return (
    <div className="flex-1 overflow-y-auto bg-[#0F0F0F]">
      <div className="max-w-3xl mx-auto px-10 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-[#E8E8E8]">Digest</h1>
            <p className="text-sm text-[#555] mt-1">
              {window === 'day' ? "What you captured today" : "What you captured this week"}
            </p>
          </div>
          <div className="flex items-center gap-1.5 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-0.5">
            <button
              onClick={() => setWindow('day')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                window === 'day' ? 'bg-[#6B9FD4]/20 text-[#6B9FD4]' : 'text-[#555] hover:text-[#888]'
              }`}
            >
              <Sun size={11} /> Day
            </button>
            <button
              onClick={() => setWindow('week')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                window === 'week' ? 'bg-[#6B9FD4]/20 text-[#6B9FD4]' : 'text-[#555] hover:text-[#888]'
              }`}
            >
              <Moon size={11} /> Week
            </button>
          </div>
        </div>

        {loading && !digest && (
          <div className="text-center py-12 text-[#444] text-sm">Loading…</div>
        )}

        {digest && digest.totalMemories === 0 && (
          <div className="text-center py-16 text-[#555] text-sm">
            Nothing captured in this window.
            <div className="text-xs text-[#444] mt-2">
              Try the other range or capture something via the Chrome extension.
            </div>
          </div>
        )}

        {digest && digest.totalMemories > 0 && (
          <>
            <div className="flex items-center justify-between mb-4 px-1">
              <div className="text-xs text-[#666]">
                {digest.totalMemories} memories · {digest.topTags.length} top tags
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void handleBackfill()}
                  disabled={summarizing}
                  title="Generate one-line summaries for memories that don't have them yet"
                  className="flex items-center gap-1.5 text-xs text-[#a78bfa] hover:text-[#c4b5fd] disabled:opacity-50"
                >
                  <Sparkles size={11} />
                  {summarizing ? 'Summarizing…' : 'Summarize missing'}
                </button>
                <button
                  onClick={() => void load()}
                  disabled={loading}
                  className="flex items-center gap-1.5 text-xs text-[#6B9FD4] hover:text-[#8ab5d4] disabled:opacity-50"
                >
                  <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                  Refresh
                </button>
              </div>
            </div>

            {digest.groups.map(group => (
              <section key={group.label} className="mb-6">
                <h2 className="text-sm font-semibold text-[#6B9FD4] mb-2 px-1">
                  {group.label} <span className="text-[#444] font-normal">· {group.memories.length}</span>
                </h2>
                <div className="bg-[#161616]/80 border border-[#2a2a2a] rounded-lg overflow-hidden">
                  {group.memories.map((m, i) => (
                    <button
                      key={m.id}
                      onClick={() => handleOpen(m.id)}
                      className={`w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-[#1f1f1f] transition-colors ${
                        i > 0 ? 'border-t border-[#2a2a2a]' : ''
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-[#E8E8E8] truncate">
                          {m.oneLine ?? m.title}
                        </div>
                        {m.oneLine && (
                          <div className="text-[10px] text-[#444] mt-0.5 truncate">
                            {m.title}
                          </div>
                        )}
                      </div>
                      <ExternalLink size={11} className="text-[#444] flex-shrink-0 mt-1" />
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

// Tiny indirection so the useEffect closure doesn't capture `window`
// (the React state) by name — TypeScript and the eslint plugin both flag
// that as a shadowing bug. Renaming the state variable was the alternative;
// this keeps `window: DigestWindow` readable.
async function window_electron_digest(w: DigestWindow): Promise<Digest> {
  return window.electron.digest.get(w)
}
