import React, { useState } from 'react'
import { X, Bug, Lightbulb, MessageSquare, Paperclip, Loader2 } from 'lucide-react'
import type { FeedbackType } from '../../../types'

const TITLE_MAX = 50
const DESC_MAX = 500

interface FeedbackModalProps {
  onClose: () => void
  onSubmitted: () => void   // parent shows the success toast
}

const TYPE_OPTIONS: { value: FeedbackType; label: string; icon: React.ReactNode }[] = [
  { value: 'bug', label: 'Bug', icon: <Bug size={14} /> },
  { value: 'feature', label: 'Feature Request', icon: <Lightbulb size={14} /> },
  { value: 'other', label: 'Other', icon: <MessageSquare size={14} /> },
]

export default function FeedbackModal({ onClose, onSubmitted }: FeedbackModalProps): React.ReactElement {
  const [type, setType] = useState<FeedbackType>('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = title.trim().length > 0 && !submitting

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await window.electron.feedback.save({ type, title: title.trim(), description: description.trim() })
      onSubmitted()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save feedback')
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[92vw] bg-[#1a1a1a] border border-[#333] rounded-xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2d2d2d]">
          <h2 className="text-base font-semibold text-[#E8E8E8]">Send Feedback</h2>
          <button onClick={onClose} className="text-[#666] hover:text-[#ccc] transition-colors" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <p className="text-xs text-[#777] leading-relaxed">
            Found a bug? Have an idea? Let us know — your feedback helps Cortex improve. Saved locally on your machine.
          </p>

          {/* Type selector */}
          <div className="flex gap-2">
            {TYPE_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setType(opt.value)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  type === opt.value
                    ? 'bg-[#6366f1]/20 border-[#6366f1] text-[#a5b4fc]'
                    : 'bg-[#222] border-[#333] text-[#888] hover:text-[#ccc]'
                }`}
              >
                {opt.icon}
                {opt.label}
              </button>
            ))}
          </div>

          {/* Title */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="fb-title" className="text-xs text-[#888]">Title</label>
              <span className="text-[10px] text-[#555] tabular-nums">{title.length}/{TITLE_MAX}</span>
            </div>
            <input
              id="fb-title"
              type="text"
              value={title}
              maxLength={TITLE_MAX}
              onChange={e => setTitle(e.target.value)}
              placeholder="Brief summary"
              className="w-full px-3 py-2 bg-[#111] border border-[#333] rounded-lg text-sm text-[#E8E8E8] placeholder-[#555] focus:border-[#6366f1] focus:outline-none"
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="fb-desc" className="text-xs text-[#888]">Description</label>
              <span className="text-[10px] text-[#555] tabular-nums">{description.length}/{DESC_MAX}</span>
            </div>
            <textarea
              id="fb-desc"
              value={description}
              maxLength={DESC_MAX}
              onChange={e => setDescription(e.target.value)}
              placeholder="What happened, or what would you like to see?"
              rows={5}
              className="w-full px-3 py-2 bg-[#111] border border-[#333] rounded-lg text-sm text-[#E8E8E8] placeholder-[#555] focus:border-[#6366f1] focus:outline-none resize-none"
            />
          </div>

          {/* Screenshot attach — UI-only placeholder for a future release */}
          <button
            disabled
            title="Coming in a future release"
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-[#333] text-xs text-[#555] cursor-not-allowed w-full justify-center"
          >
            <Paperclip size={12} />
            Attach screenshot (coming soon)
          </button>

          {error && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-800/40 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[#2d2d2d]">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-[#888] hover:text-[#ccc] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#6366f1] hover:bg-[#4f46e5] text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {submitting ? 'Saving…' : 'Send Feedback'}
          </button>
        </div>
      </div>
    </div>
  )
}
