import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  ChevronRight, ChevronDown, File, FileText, FileCode, FileSpreadsheet,
  FolderOpen, Folder, FilePlus, FolderPlus, Pencil, Trash2, ExternalLink,
} from 'lucide-react'
import type { VaultFile } from '../../../types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FolderNode {
  type: 'folder'
  name: string
  path: string
  children: TreeNode[]
  fileCount: number
}

interface FileNode {
  type: 'file'
  name: string
  path: string
  file: VaultFile
  children: never[]
}

type TreeNode = FolderNode | FileNode

interface ContextMenu {
  x: number
  y: number
  targetPath: string
  isDir: boolean
}

interface FileTreeProps {
  files: VaultFile[]
  vaultRoot: string
  selectedFileId: string | null
  onSelectFile: (file: VaultFile) => void
  onRefresh: () => void
  readOnly?: boolean
}

// ── File icon helpers ─────────────────────────────────────────────────────────

const CODE_EXTS = new Set(['.py', '.js', '.ts', '.jsx', '.tsx', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.rb', '.php', '.sh', '.bash'])
const DATA_EXTS = new Set(['.json', '.csv', '.xml', '.yaml', '.yml', '.toml', '.sql'])
const PDF_EXTS = new Set(['.pdf'])
const OFFICE_EXTS = new Set(['.docx', '.xlsx', '.pptx', '.doc', '.xls'])

function fileIcon(ext: string): React.ReactElement {
  const e = ext.toLowerCase()
  if (CODE_EXTS.has(e)) return <FileCode size={12} className="text-green-400 flex-shrink-0" />
  if (PDF_EXTS.has(e)) return <File size={12} className="text-orange-400 flex-shrink-0" />
  if (OFFICE_EXTS.has(e)) return <FileSpreadsheet size={12} className="text-blue-400 flex-shrink-0" />
  if (DATA_EXTS.has(e)) return <FileText size={12} className="text-yellow-400 flex-shrink-0" />
  if (e === '.md' || e === '.txt') return <FileText size={12} className="text-[#aaa] flex-shrink-0" />
  return <File size={12} className="text-[#666] flex-shrink-0" />
}

// ── Tree builder ──────────────────────────────────────────────────────────────

function buildTree(files: VaultFile[], vaultRoot: string): FolderNode {
  const root: FolderNode = { type: 'folder', name: '', path: vaultRoot, children: [], fileCount: 0 }

  for (const file of files) {
    // Normalize separators and compute relative path
    const normalized = file.filepath.replace(/\\/g, '/')
    const rootNorm = vaultRoot.replace(/\\/g, '/')
    const rel = normalized.startsWith(rootNorm + '/')
      ? normalized.slice(rootNorm.length + 1)
      : normalized
    const parts = rel.split('/')
    if (parts.length === 0 || parts[0] === '') continue

    let node: FolderNode = root
    for (let i = 0; i < parts.length - 1; i++) {
      const folderName = parts[i]
      let child = node.children.find((c): c is FolderNode => c.type === 'folder' && c.name === folderName)
      if (!child) {
        child = {
          type: 'folder',
          name: folderName,
          path: node.path + '/' + folderName,
          children: [],
          fileCount: 0,
        }
        node.children.push(child)
      }
      child.fileCount++
      node = child
    }

    const leaf = parts[parts.length - 1]
    node.children.push({ type: 'file', name: leaf, path: file.filepath, file, children: [] })
  }

  return root
}

// ── Main component ────────────────────────────────────────────────────────────

export default function FileTree({ files, vaultRoot, selectedFileId, onSelectFile, onRefresh, readOnly = false }: FileTreeProps): React.ReactElement {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<ContextMenu | null>(null)
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const tree = buildTree(files, vaultRoot)

  // Auto-expand top-level folders
  useEffect(() => {
    const top = tree.children.filter((c): c is FolderNode => c.type === 'folder').map(c => c.path)
    setExpanded(new Set(top))
  }, [vaultRoot])  // Only on vault root change, not every file change

  // Close context menu on outside click
  useEffect(() => {
    if (!menu) return
    const handler = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menu])

  const toggleExpanded = (path: string): void => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const openContextMenu = (e: React.MouseEvent, targetPath: string, isDir: boolean): void => {
    e.preventDefault()
    e.stopPropagation()
    if (readOnly) return
    setMenu({ x: e.clientX, y: e.clientY, targetPath, isDir })
  }

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>, destDir: string): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    const droppedFiles = Array.from(e.dataTransfer.files) as Array<File & { path?: string }>
    const paths = droppedFiles.map(f => f.path).filter((p): p is string => !!p)
    if (paths.length === 0) return
    await window.electron.vault.copyToVault(paths, destDir)
    onRefresh()
  }, [onRefresh])

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const handleMenuAction = async (action: string): Promise<void> => {
    if (!menu) return
    const { targetPath, isDir } = menu
    setMenu(null)

    if (action === 'open') {
      await window.electron.vault.openInExplorer(targetPath)
    } else if (action === 'new-file') {
      const name = prompt('File name:')
      if (name) {
        const dir = isDir ? targetPath : targetPath.replace(/[/\\][^/\\]+$/, '')
        await window.electron.vault.createFile(dir, name)
        onRefresh()
      }
    } else if (action === 'new-folder') {
      const name = prompt('Folder name:')
      if (name) {
        const dir = isDir ? targetPath : targetPath.replace(/[/\\][^/\\]+$/, '')
        await window.electron.vault.createFolder(dir, name)
        onRefresh()
      }
    } else if (action === 'rename') {
      const current = targetPath.split(/[/\\]/).pop() ?? ''
      setRenaming({ path: targetPath, name: current })
    } else if (action === 'delete') {
      if (confirm(`Delete "${targetPath.split(/[/\\]/).pop()}"?`)) {
        await window.electron.vault.deleteItem(targetPath)
        onRefresh()
      }
    }
  }

  const handleRename = async (newName: string): Promise<void> => {
    if (!renaming || !newName || newName === renaming.name) { setRenaming(null); return }
    const parent = renaming.path.replace(/[/\\][^/\\]+$/, '')
    const newPath = parent + '/' + newName
    await window.electron.vault.rename(renaming.path, newPath)
    setRenaming(null)
    onRefresh()
  }

  if (files.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-[#444] text-xs leading-relaxed">
        No files yet.{'\n'}Drop files here or add them to your vault folder.
      </div>
    )
  }

  return (
    <div
      className="flex-1 overflow-y-auto relative"
      onDrop={e => void handleDrop(e, vaultRoot)}
      onDragOver={handleDragOver}
    >
      {tree.children.map(node => (
        <TreeNodeRow
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          selectedFileId={selectedFileId}
          renaming={renaming}
          onToggle={toggleExpanded}
          onSelectFile={onSelectFile}
          onContextMenu={openContextMenu}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onRename={handleRename}
        />
      ))}

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-[#2d2d2d] border border-[#505050] rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: menu.x, top: menu.y }}
        >
          <MenuItem icon={<FilePlus size={12} />} label="New File" onClick={() => void handleMenuAction('new-file')} />
          <MenuItem icon={<FolderPlus size={12} />} label="New Folder" onClick={() => void handleMenuAction('new-folder')} />
          <div className="h-px bg-[#404040] my-1" />
          <MenuItem icon={<Pencil size={12} />} label="Rename" onClick={() => void handleMenuAction('rename')} />
          <MenuItem icon={<ExternalLink size={12} />} label="Open in Explorer" onClick={() => void handleMenuAction('open')} />
          <div className="h-px bg-[#404040] my-1" />
          <MenuItem icon={<Trash2 size={12} />} label="Delete" onClick={() => void handleMenuAction('delete')} danger />
        </div>
      )}
    </div>
  )
}

// ── Tree node row ─────────────────────────────────────────────────────────────

interface TreeNodeRowProps {
  node: TreeNode
  depth: number
  expanded: Set<string>
  selectedFileId: string | null
  renaming: { path: string; name: string } | null
  onToggle: (path: string) => void
  onSelectFile: (file: VaultFile) => void
  onContextMenu: (e: React.MouseEvent, path: string, isDir: boolean) => void
  onDrop: (e: React.DragEvent<HTMLDivElement>, destDir: string) => Promise<void>
  onDragOver: (e: React.DragEvent) => void
  onRename: (newName: string) => Promise<void>
}

function TreeNodeRow({
  node, depth, expanded, selectedFileId, renaming,
  onToggle, onSelectFile, onContextMenu, onDrop, onDragOver, onRename,
}: TreeNodeRowProps): React.ReactElement {
  const indent = depth * 12

  if (node.type === 'folder') {
    const isExpanded = expanded.has(node.path)
    const isRenaming = renaming?.path === node.path

    return (
      <>
        <div
          className="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-[#353535] text-[#888] hover:text-[#e0e0e0] select-none group"
          style={{ paddingLeft: 8 + indent }}
          onClick={() => onToggle(node.path)}
          onContextMenu={e => onContextMenu(e, node.path, true)}
          onDrop={e => void onDrop(e, node.path)}
          onDragOver={onDragOver}
        >
          <span className="text-[#555]">
            {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
          {isExpanded
            ? <FolderOpen size={12} className="text-[#6366f1] flex-shrink-0" />
            : <Folder size={12} className="text-[#555] flex-shrink-0" />
          }
          {isRenaming ? (
            <RenameInput initialValue={node.name} onConfirm={onRename} onCancel={() => onRename('')} />
          ) : (
            <span className="text-xs truncate flex-1">{node.name}</span>
          )}
          {node.fileCount > 0 && (
            <span className="text-xs text-[#555] bg-[#1a1a1a] px-1.5 py-0.5 rounded-full ml-auto flex-shrink-0">
              {node.fileCount}
            </span>
          )}
        </div>
        {isExpanded && node.children.map(child => (
          <TreeNodeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            selectedFileId={selectedFileId}
            renaming={renaming}
            onToggle={onToggle}
            onSelectFile={onSelectFile}
            onContextMenu={onContextMenu}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onRename={onRename}
          />
        ))}
      </>
    )
  }

  const isSelected = node.file.id === selectedFileId
  const isRenaming = renaming?.path === node.path

  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer select-none ${
        isSelected ? 'bg-[#3a3a4a] text-[#e0e0e0]' : 'text-[#888] hover:bg-[#353535] hover:text-[#e0e0e0]'
      }`}
      style={{ paddingLeft: 8 + indent + 14 }}
      onClick={() => onSelectFile(node.file)}
      onContextMenu={e => onContextMenu(e, node.path, false)}
    >
      {fileIcon(node.file.extension)}
      {isRenaming ? (
        <RenameInput initialValue={node.name} onConfirm={onRename} onCancel={() => onRename('')} />
      ) : (
        <span className="text-xs truncate">{node.name}</span>
      )}
    </div>
  )
}

function RenameInput({ initialValue, onConfirm, onCancel }: {
  initialValue: string
  onConfirm: (v: string) => void
  onCancel: () => void
}): React.ReactElement {
  const [value, setValue] = useState(initialValue)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => { ref.current?.select() }, [])

  return (
    <input
      ref={ref}
      value={value}
      autoFocus
      onClick={e => e.stopPropagation()}
      onChange={e => setValue(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') { e.preventDefault(); onConfirm(value) }
        if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      }}
      onBlur={() => onConfirm(value)}
      className="flex-1 bg-[#1a1a1a] text-[#e0e0e0] text-xs px-1 py-0 rounded border border-[#6366f1] outline-none min-w-0"
    />
  )
}

function MenuItem({ icon, label, onClick, danger = false }: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[#3a3a4a] transition-colors ${danger ? 'text-red-400 hover:text-red-300' : 'text-[#b0b0b0] hover:text-[#e0e0e0]'}`}
    >
      {icon} {label}
    </button>
  )
}
