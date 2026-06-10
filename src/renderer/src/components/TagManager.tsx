// Tag manager modal — all tags with counts, plus bulk rename / merge / delete.
//
// Merging is rename-into-existing: renaming "ml" to "machine-learning" when
// the target already exists dedupes per-memory in the main process, so the
// same control covers both operations.

import React, { useEffect, useState, useCallback } from 'react'
import { X, Pencil, Trash2, Check, Tag as TagIcon } from 'lucide-react'
import { useStore } from '../store'

interface TagRow {
  tag: string
  count: number
}

interface TagManagerProps {
  onClose: () => void
}

export default function TagManager({ onClose }: TagManagerProps): React.ReactElement {
  const { fetchMemories } = useStore()
  const [rows, setRows] = useState<TagRow[]>([])
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setRows(await window.electron.tags.getCounts())
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleRename = useCallback(async (from: string) => {
    const to = editValue.trim()
    setEditing(null)
    if (!to || to === from) return
    setBusy(true)
    try {
      const r = await window.electron.tags.rename(from, to)
      if (r.error) {
        setStatus(r.error)
      } else {
        const merged = rows.some(x => x.tag === to)
        setStatus(`${merged ? 'Merged' : 'Renamed'} "${from}" → "${to}" across ${r.changed} memories`)
        await Promise.all([refresh(), fetchMemories()])
      }
    } finally {
      setBusy(false)
    }
  }, [editValue, rows, refresh, fetchMemories])

  const handleDelete = useCallback(async (tag: string) => {
    if (confirming !== tag) { setConfirming(tag); return }
    setConfirming(null)
    setBusy(true)
    try {
      const r = await window.electron.tags.delete(tag)
      setStatus(`Removed "${tag}" from ${r.changed} memories`)
      await Promise.all([refresh(), fetchMemories()])
    } finally {
      setBusy(false)
    }
  }, [confirming, refresh, fetchMemories])

  const visible = filter
    ? rows.filter(r => r.tag.includes(filter.trim().toLowerCase()))
    : rows

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[420px] max-h-[70vh] flex flex-col bg-[#1a1a1a] border border-[#333] rounded-xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#2a2a2a]">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#e8e8e8]">
            <TagIcon size={14} className="text-[#6B9FD4]" />
            Manage Tags
            <span className="text-xs font-normal text-[#555]">{rows.length}</span>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-[#444] hover:text-[#888] transition-colors">
            <X size={15} />
          </button>
        </div>

        {/* Filter */}
        <div className="px-4 py-2 border-b border-[#2a2a2a]">
          <input
            autoFocus
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter tags…"
            className="w-full bg-[#111] text-[#e0e0e0] px-3 py-1.5 rounded-lg border border-[#333] focus:outline-none focus:border-[#6B9FD4] text-xs placeholder-[#444]"
          />
        </div>

        {/* Rows */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {visible.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-[#444]">
              {rows.length === 0 ? 'No tags yet' : 'No tags match'}
            </div>
          ) : visible.map(({ tag, count }) => (
            <div
              key={tag}
              className="group flex items-center justify-between gap-2 px-4 py-1.5 hover:bg-[#1f1f1f] transition-colors"
            >
              {editing === tag ? (
                <input
                  autoFocus
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void handleRename(tag)
                    if (e.key === 'Escape') setEditing(null)
                  }}
                  onBlur={() => void handleRename(tag)}
                  className="flex-1 bg-[#111] text-[#e0e0e0] px-2 py-1 rounded border border-[#6B9FD4] focus:outline-none text-xs"
                />
              ) : (
                <span className="flex-1 text-xs text-[#bbb] truncate">
                  {tag} <span className="text-[#444] ml-1">{count}</span>
                </span>
              )}
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                {editing !== tag && (
                  <button
                    onClick={() => { setEditing(tag); setEditValue(tag); setConfirming(null) }}
                    disabled={busy}
                    title="Rename (rename to an existing tag to merge)"
                    className="p-1 rounded text-[#555] hover:text-[#6B9FD4] hover:bg-[#252525] transition-colors"
                  >
                    <Pencil size={11} />
                  </button>
                )}
                <button
                  onClick={() => void handleDelete(tag)}
                  onMouseLeave={() => setConfirming(c => (c === tag ? null : c))}
                  disabled={busy}
                  title={confirming === tag ? 'Click again to confirm' : `Remove from all ${count} memories`}
                  className={`p-1 rounded transition-colors ${
                    confirming === tag
                      ? 'text-[#e57373] bg-[#e57373]/15'
                      : 'text-[#555] hover:text-[#e57373] hover:bg-[#252525]'
                  }`}
                >
                  {confirming === tag ? <Check size={11} /> : <Trash2 size={11} />}
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Status */}
        {status && (
          <div className="px-4 py-2 border-t border-[#2a2a2a] text-[11px] text-[#888]">{status}</div>
        )}
      </div>
    </div>
  )
}
