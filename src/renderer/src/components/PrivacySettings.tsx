import React, { useCallback, useEffect, useState } from 'react'
import { MessageSquarePlus, ListChecks, Download, Trash2, BarChart3, Shield } from 'lucide-react'
import { useTelemetry } from '../hooks/useTelemetry'
import FeedbackModal from './FeedbackModal'
import type { TelemetryEvent, TelemetryStats, StoredFeedback } from '../../../types'

type Toast = { message: string } | null

export default function PrivacySettings(): React.ReactElement {
  const { enabled, loading, setEnabled } = useTelemetry()
  const [showFeedback, setShowFeedback] = useState(false)
  const [events, setEvents] = useState<TelemetryEvent[] | null>(null)
  const [stats, setStats] = useState<TelemetryStats | null>(null)
  const [feedbackList, setFeedbackList] = useState<StoredFeedback[] | null>(null)
  const [toast, setToast] = useState<Toast>(null)

  const flash = useCallback((message: string) => {
    setToast({ message })
    setTimeout(() => setToast(null), 3000)
  }, [])

  const refreshStats = useCallback(() => {
    void window.electron.telemetry.getStats().then(setStats)
  }, [])

  useEffect(() => { if (enabled) refreshStats() }, [enabled, refreshStats])

  const handleToggle = async (): Promise<void> => {
    await setEnabled(!enabled)
    if (!enabled) refreshStats()
    else { setStats(null); setEvents(null) }
  }

  const viewEvents = async (): Promise<void> => {
    setEvents(await window.electron.telemetry.getAll())
    refreshStats()
  }

  const exportEvents = async (): Promise<void> => {
    const json = await window.electron.telemetry.export()
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `cortex-telemetry-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    flash('Telemetry exported to your downloads.')
  }

  const clearEvents = async (): Promise<void> => {
    await window.electron.telemetry.clear()
    setEvents([])
    refreshStats()
    flash('All telemetry events deleted.')
  }

  const viewFeedback = async (): Promise<void> => {
    setFeedbackList(await window.electron.feedback.getAll())
  }

  return (
    <>
      {/* ── Feedback ─────────────────────────────────────────────────────── */}
      <section className="mb-10">
        <div className="flex items-center gap-2 mb-1">
          <MessageSquarePlus size={14} className="text-[#6B9FD4]" />
          <h2 className="text-base font-semibold text-[#E8E8E8]">Feedback</h2>
        </div>
        <p className="text-xs text-[#555] mb-5 leading-relaxed">
          Found a bug? Have an idea? Let us know — your feedback helps Cortex improve. Stored locally.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => setShowFeedback(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#6366f1] hover:bg-[#4f46e5] text-white text-sm font-medium transition-colors"
          >
            <MessageSquarePlus size={14} />
            Send Feedback
          </button>
          <button
            onClick={() => void viewFeedback()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#2a2a2a] hover:bg-[#333] text-[#aaa] border border-[#333] text-sm font-medium transition-colors"
          >
            <ListChecks size={14} />
            View Feedback
          </button>
        </div>

        {feedbackList && (
          <div className="mt-4 space-y-2 max-h-64 overflow-y-auto">
            {feedbackList.length === 0 ? (
              <div className="text-xs text-[#555] p-3 bg-[#111] rounded-lg border border-[#222]">No feedback submitted yet.</div>
            ) : feedbackList.map(f => (
              <div key={f.id} className="p-3 bg-[#1a1a1a] border border-[#2d2d2d] rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#6366f1]/20 text-[#a5b4fc]">{f.type}</span>
                  <span className="text-sm text-[#E8E8E8]">{f.title}</span>
                  <span className="ml-auto text-[10px] text-[#555]">{f.timestamp.slice(0, 10)}</span>
                </div>
                {f.description && <p className="text-xs text-[#888] leading-relaxed">{f.description}</p>}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Telemetry ────────────────────────────────────────────────────── */}
      <section className="mb-10">
        <div className="flex items-center gap-2 mb-1">
          <Shield size={14} className="text-[#6B9FD4]" />
          <h2 className="text-base font-semibold text-[#E8E8E8]">Anonymous Usage Data</h2>
        </div>
        <p className="text-xs text-[#555] mb-5 leading-relaxed">
          Help improve Cortex by sharing anonymous usage data. No personal information is collected or sent to the cloud.
          All data is stored locally on your machine. You can view, export, or delete it anytime.
        </p>

        <label className="flex items-start gap-3 p-3 bg-[#1a1a1a] border border-[#2d2d2d] rounded-lg cursor-pointer select-none">
          <input
            type="checkbox"
            checked={enabled}
            disabled={loading}
            onChange={() => void handleToggle()}
            className="mt-0.5 accent-[#6366f1] w-4 h-4"
          />
          <div className="flex-1">
            <div className="text-sm text-[#E8E8E8]">Send anonymous usage events</div>
            <div className="text-xs text-[#666] mt-0.5">No personal data, no cloud upload. Events stored locally.</div>
          </div>
        </label>

        {enabled && (
          <>
            <div className="flex gap-2 mt-3">
              <button onClick={() => void viewEvents()} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#2a2a2a] hover:bg-[#333] text-[#aaa] border border-[#333] text-xs font-medium transition-colors">
                <ListChecks size={12} /> View All Events
              </button>
              <button onClick={() => void exportEvents()} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#2a2a2a] hover:bg-[#333] text-[#aaa] border border-[#333] text-xs font-medium transition-colors">
                <Download size={12} /> Export as JSON
              </button>
              <button onClick={() => void clearEvents()} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#2a2a2a] hover:bg-[#3a2a2a] text-[#888] hover:text-red-400 border border-[#333] text-xs font-medium transition-colors">
                <Trash2 size={12} /> Clear All
              </button>
            </div>

            {stats && (
              <div className="mt-3 p-3 bg-[#0e1620] border border-[#1f3553] rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <BarChart3 size={12} className="text-[#6B9FD4]" />
                  <span className="text-xs text-[#a5b4fc]">{stats.total} event{stats.total !== 1 ? 's' : ''}</span>
                  {stats.earliest && (
                    <span className="text-[10px] text-[#555]">
                      {stats.earliest.slice(0, 10)} → {stats.latest?.slice(0, 10)}
                    </span>
                  )}
                </div>
                {Object.keys(stats.byType).length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(stats.byType).map(([type, count]) => (
                      <span key={type} className="text-[10px] px-1.5 py-0.5 rounded bg-[#1a1a1a] text-[#888] border border-[#222]">
                        {type}: {count}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {events && (
              <div className="mt-3 space-y-1 max-h-64 overflow-y-auto font-mono text-[11px]">
                {events.length === 0 ? (
                  <div className="text-xs text-[#555] p-3 bg-[#111] rounded-lg border border-[#222] font-sans">No events captured yet.</div>
                ) : events.slice(-200).reverse().map((e, i) => (
                  <div key={i} className="p-2 bg-[#111] border border-[#222] rounded">
                    <span className="text-[#6B9FD4]">{e.type}</span>
                    <span className="text-[#555]"> · {e.timestamp.slice(11, 19)}</span>
                    <span className="text-[#888]"> {JSON.stringify(e.data)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {showFeedback && (
        <FeedbackModal
          onClose={() => setShowFeedback(false)}
          onSubmitted={() => flash('Feedback saved. View all in Settings → Feedback.')}
        />
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] px-4 py-2.5 rounded-lg bg-[#10a37f] text-white text-sm shadow-2xl">
          {toast.message}
        </div>
      )}
    </>
  )
}
