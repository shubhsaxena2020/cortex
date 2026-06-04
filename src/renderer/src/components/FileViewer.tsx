import React, { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import sql from 'highlight.js/lib/languages/sql'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'
import { ExternalLink, Loader } from 'lucide-react'
import type { VaultFile } from '../../../types'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('go', go)
hljs.registerLanguage('java', java)
hljs.registerLanguage('cpp', cpp)

// ── Extension mappings ────────────────────────────────────────────────────────

type ViewMode = 'markdown' | 'code' | 'pdf' | 'plain' | 'docx' | 'unknown'

const EXT_TO_MODE: Record<string, ViewMode> = {
  '.md': 'markdown',
  '.js': 'code', '.ts': 'code', '.jsx': 'code', '.tsx': 'code',
  '.py': 'code', '.go': 'code', '.rs': 'code', '.java': 'code',
  '.c': 'code', '.cpp': 'code', '.h': 'code', '.hpp': 'code',
  '.rb': 'code', '.php': 'code', '.sh': 'code', '.bash': 'code',
  '.sql': 'code', '.css': 'code', '.scss': 'code',
  '.json': 'code', '.yaml': 'code', '.yml': 'code', '.toml': 'code',
  '.xml': 'code', '.html': 'code',
  '.txt': 'plain', '.csv': 'plain', '.ini': 'plain', '.cfg': 'plain',
  '.pdf': 'pdf',
  '.docx': 'docx', '.doc': 'docx',
}

const EXT_TO_LANG: Record<string, string> = {
  '.js': 'javascript', '.ts': 'typescript',
  '.jsx': 'javascript', '.tsx': 'typescript',
  '.py': 'python', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.c': 'cpp', '.cpp': 'cpp',
  '.h': 'cpp', '.hpp': 'cpp',
  '.json': 'json', '.yaml': 'json', '.yml': 'json',
  '.toml': 'json', '.sql': 'sql',
  '.css': 'css', '.scss': 'css',
  '.xml': 'xml', '.html': 'xml',
  '.sh': 'bash', '.bash': 'bash',
}

// ── Component ─────────────────────────────────────────────────────────────────

interface FileViewerProps {
  file: VaultFile
}

export default function FileViewer({ file }: FileViewerProps): React.ReactElement {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const mode: ViewMode = EXT_TO_MODE[file.extension.toLowerCase()] ?? 'unknown'

  useEffect(() => {
    setContent(null)
    setError(null)
    setLoading(true)

    if (mode === 'pdf' || mode === 'unknown') {
      setLoading(false)
      return
    }

    const load = async (): Promise<void> => {
      try {
        if (mode === 'docx') {
          const text = await window.electron.vault.extractDocText(file.filepath)
          setContent(text)
        } else {
          const text = await window.electron.vault.readFile(file.filepath)
          setContent(text)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    }

    void load()
  }, [file.filepath, mode])

  const openFile = (): void => { void window.electron.vault.openFile(file.filepath) }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-[#303030] flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-[#555] px-1.5 py-0.5 rounded bg-[#2d2d2d] border border-[#404040] flex-shrink-0 font-mono">
            {file.extension || 'file'}
          </span>
          <span className="text-sm text-[#e0e0e0] font-medium truncate">{file.filename}</span>
        </div>
        <button
          onClick={openFile}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs text-[#888] hover:text-[#e0e0e0] hover:bg-[#2d2d2d] transition-colors flex-shrink-0"
          title="Open with default app"
        >
          <ExternalLink size={11} /> Open
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-[#555]">
            <Loader size={16} className="animate-spin" />
          </div>
        ) : error ? (
          <div className="p-5 text-sm text-red-400">{error}</div>
        ) : mode === 'markdown' ? (
          <div className="px-8 py-6 prose prose-invert prose-sm max-w-none">
            <ReactMarkdown>{content ?? ''}</ReactMarkdown>
          </div>
        ) : mode === 'code' ? (
          <CodeView content={content ?? ''} ext={file.extension.toLowerCase()} />
        ) : mode === 'plain' || mode === 'docx' ? (
          <pre className="px-5 py-5 text-xs text-[#ccc] whitespace-pre-wrap font-mono leading-relaxed">
            {content}
          </pre>
        ) : mode === 'pdf' ? (
          <iframe
            src={`file:///${file.filepath.replace(/\\/g, '/')}`}
            className="w-full h-full border-0"
            title={file.filename}
          />
        ) : (
          <UnknownFileView file={file} onOpen={openFile} />
        )}
      </div>
    </div>
  )
}

// ── Sub-views ─────────────────────────────────────────────────────────────────

function CodeView({ content, ext }: { content: string; ext: string }): React.ReactElement {
  const lang = EXT_TO_LANG[ext]
  let highlighted = ''
  try {
    highlighted = lang
      ? hljs.highlight(content, { language: lang }).value
      : hljs.highlightAuto(content).value
  } catch {
    highlighted = content
  }

  return (
    <div className="relative">
      {lang && (
        <span className="absolute top-3 right-4 text-xs text-[#444] font-mono select-none">{lang}</span>
      )}
      <pre className="px-5 py-5 text-xs leading-relaxed overflow-x-auto">
        <code
          className="hljs font-mono"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  )
}

function UnknownFileView({ file, onOpen }: { file: VaultFile; onOpen: () => void }): React.ReactElement {
  const kb = (file.size / 1024).toFixed(1)
  return (
    <div className="flex flex-col items-center justify-center h-48 gap-4 text-center px-8">
      <div className="text-[#444] text-sm space-y-1">
        <p className="text-[#888]">{file.filename}</p>
        <p>{file.extension || 'unknown type'} · {kb} KB</p>
      </div>
      <button
        onClick={onOpen}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#2d2d2d] hover:bg-[#3a3a4a] border border-[#404040] text-sm text-[#b0b0b0] hover:text-[#e0e0e0] transition-colors"
      >
        <ExternalLink size={13} /> Open with default app
      </button>
    </div>
  )
}
