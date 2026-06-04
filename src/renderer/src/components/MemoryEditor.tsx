import React, { useState, useEffect, useCallback, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import { Save, Eye, Edit2, Tag, X, Trash2, Clock } from 'lucide-react'
import { useStore } from '../store'
import type { MemorySource } from '../../../types'

const SOURCES: { value: MemorySource; label: string; color: string }[] = [
  { value: 'manual', label: 'Manual', color: '#3b82f6' },
  { value: 'claude', label: 'Claude', color: '#6366f1' },
  { value: 'chatgpt', label: 'ChatGPT', color: '#10a37f' },
  { value: 'gemini', label: 'Gemini', color: '#8b5cf6' }
]

function formatRelative(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(isoString).toLocaleDateString()
}

export default function MemoryEditor(): React.ReactElement {
  const { getSelectedMemory, updateMemory, deleteMemory, selectMemory, selectionKey } = useStore()
  const memory = getSelectedMemory()

  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [source, setSource] = useState<MemorySource>('manual')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [isPreview, setIsPreview] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'unsaved'>('saved')

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const memoryId = memory?.id

  useEffect(() => {
    if (!memory) return
    setTitle(memory.title)
    setContent(memory.content)
    setSource(memory.source)
    setTags(memory.tags)
    setSaveStatus('saved')
    setIsPreview(false)
  }, [memoryId, selectionKey])

  const save = useCallback(async () => {
    if (!memoryId) return
    setSaveStatus('saving')
    try {
      await updateMemory(memoryId, { title, content, source, tags })
      setSaveStatus('saved')
    } catch {
      setSaveStatus('unsaved')
    }
  }, [memoryId, title, content, source, tags, updateMemory])

  useEffect(() => {
    if (!memoryId) return
    setSaveStatus('unsaved')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(save, 600)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [title, content, source, tags, memoryId])

  const handleTagKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && tagInput.trim()) {
      const t = tagInput.trim().toLowerCase()
      if (!tags.includes(t)) setTags(prev => [...prev, t])
      setTagInput('')
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!memory) return
    if (!window.confirm(`Delete "${memory.title}"? This cannot be undone.`)) return
    await deleteMemory(memory.id)
    selectMemory(null)
  }

  // Ctrl+S manual save
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  // Dashboard only mounts MemoryEditor when selectedMemoryId is set;
  // this guard is a safety net for the async window between selection and memory load.
  if (!memory) return null

  const wordCount = content.split(/\s+/).filter(Boolean).length
  const srcOpt = SOURCES.find(s => s.value === source) ?? SOURCES[0]

  return (
    <div className="flex-1 flex flex-col h-full bg-[#1a1a1a] overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#2d2d2d] bg-[#222]">
        <div className="flex items-center gap-3">
          {/* Source */}
          <select
            value={source}
            onChange={e => setSource(e.target.value as MemorySource)}
            className="text-xs bg-[#2d2d2d] border border-[#404040] rounded px-2 py-1 focus:outline-none focus:border-[#6366f1] cursor-pointer"
            style={{ color: srcOpt.color }}
          >
            {SOURCES.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-[#444]">{wordCount}w</span>
          <span className={`text-xs ${
            saveStatus === 'saved' ? 'text-[#10a37f]' :
            saveStatus === 'saving' ? 'text-[#555]' : 'text-[#f59e0b]'
          }`}>
            {saveStatus === 'saved' ? '✓ Saved' : saveStatus === 'saving' ? '…' : '● Unsaved'}
          </span>
          <button
            onClick={() => setIsPreview(v => !v)}
            className={`p-1.5 rounded transition-colors ${isPreview ? 'bg-[#6366f1] text-white' : 'text-[#555] hover:bg-[#2d2d2d] hover:text-[#e0e0e0]'}`}
            title="Toggle preview (markdown)"
          >
            {isPreview ? <Edit2 size={13} /> : <Eye size={13} />}
          </button>
          <button
            onClick={save}
            className="p-1.5 rounded text-[#555] hover:bg-[#2d2d2d] hover:text-[#e0e0e0] transition-colors"
            title="Save (Ctrl+S)"
          >
            <Save size={13} />
          </button>
          <button
            onClick={handleDelete}
            className="p-1.5 rounded text-[#555] hover:bg-[#2d2d2d] hover:text-red-500 transition-colors"
            title="Delete"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      {/* Title */}
      <div className="px-6 pt-5 pb-2">
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Untitled memory…"
          className="w-full bg-transparent text-2xl font-bold text-[#e0e0e0] focus:outline-none placeholder-[#333] leading-tight"
        />
        <div className="flex items-center gap-2 mt-2 text-xs text-[#444]">
          <Clock size={10} />
          <span>Created {formatRelative(memory.created_at)}</span>
          {memory.updated_at !== memory.created_at && (
            <span>· edited {formatRelative(memory.updated_at)}</span>
          )}
        </div>
      </div>

      {/* Tags */}
      <div className="px-6 pb-3 flex items-center flex-wrap gap-1.5">
        <Tag size={11} className="text-[#444]" />
        {tags.map(t => (
          <span key={t} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-[#2d2d2d] border border-[#404040] text-[#b0b0b0]">
            {t}
            <button onClick={() => setTags(prev => prev.filter(x => x !== t))} className="hover:text-red-400 transition-colors">
              <X size={9} />
            </button>
          </span>
        ))}
        <input
          value={tagInput}
          onChange={e => setTagInput(e.target.value)}
          onKeyDown={handleTagKey}
          placeholder="+ tag"
          className="bg-transparent text-xs text-[#e0e0e0] focus:outline-none placeholder-[#333] w-16"
        />
      </div>

      <div className="h-px bg-[#2a2a2a] mx-6" />

      {/* Content area */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isPreview ? (
          <div className="prose max-w-none text-sm">
            <ReactMarkdown>{content || '*Nothing written yet…*'}</ReactMarkdown>
          </div>
        ) : (
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            placeholder={'Write in markdown…\n\n# Heading\n**bold**, *italic*, `code`\n\n- list item'}
            className="w-full h-full bg-transparent text-sm text-[#d0d0d0] focus:outline-none resize-none leading-relaxed placeholder-[#333] font-mono select-text"
            spellCheck
          />
        )}
      </div>
    </div>
  )
}
