import { create } from 'zustand'
import type { Memory, Relationship, ViewType, SearchResult, VaultFile, VaultConfig } from '../../types'

interface CortexState {
  memories: Memory[]
  relationships: Relationship[]
  selectedMemoryId: string | null
  selectionKey: number
  currentView: ViewType
  searchQuery: string
  searchResults: SearchResult[]
  selectedTags: string[]
  isLoading: boolean
  vaultFiles: VaultFile[]
  vaultConfig: VaultConfig | null
  selectedFileId: string | null
  indexProgress: { current: number; total: number } | null

  fetchMemories: () => Promise<void>
  fetchRelationships: () => Promise<void>
  selectMemory: (id: string | null) => void
  clearSelection: () => void
  setView: (view: ViewType) => void
  createMemory: (data: Omit<Memory, 'id' | 'created_at' | 'updated_at'>) => Promise<Memory>
  updateMemory: (id: string, data: Partial<Memory>) => Promise<void>
  deleteMemory: (id: string) => Promise<void>
  searchMemories: (query: string, tags?: string[], source?: string, dates?: { from?: number; to?: number }) => Promise<void>
  setSearchQuery: (query: string) => void
  toggleTag: (tag: string) => void
  clearSelectedTags: () => void
  createRelationship: (data: Omit<Relationship, 'id'>) => Promise<void>
  deleteRelationship: (id: string) => Promise<void>
  getAllTags: () => string[]
  getTagCounts: () => Record<string, number>
  getSelectedMemory: () => Memory | undefined
  fetchVaultFiles: () => Promise<void>
  selectFile: (id: string | null) => void
  getSelectedFile: () => VaultFile | undefined
  getVaultOnlyFiles: () => VaultFile[]
  getWatchFiles: () => VaultFile[]
}

export const useStore = create<CortexState>((set, get) => ({
  memories: [],
  relationships: [],
  selectedMemoryId: null,
  selectionKey: 0,
  currentView: 'editor',
  searchQuery: '',
  searchResults: [],
  selectedTags: [],
  isLoading: false,
  vaultFiles: [],
  vaultConfig: null,
  selectedFileId: null,
  indexProgress: null,

  fetchMemories: async () => {
    set({ isLoading: true })
    try {
      const memories = await window.electron.memories.getAll()
      set({ memories })
    } finally {
      set({ isLoading: false })
    }
  },

  fetchRelationships: async () => {
    const relationships = await window.electron.relationships.getAll()
    set({ relationships })
  },

  selectMemory: id => set(state => ({
    selectedMemoryId: id,
    selectedFileId: null,
    selectionKey: state.selectionKey + 1,
  })),

  clearSelection: () => set({ selectedMemoryId: null, selectedFileId: null }),

  setView: view => set({ currentView: view }),

  createMemory: async data => {
    const memory = await window.electron.memories.create(data)
    set(state => ({ memories: [memory, ...state.memories] }))
    return memory
  },

  updateMemory: async (id, data) => {
    const updated = await window.electron.memories.update(id, data)
    set(state => ({
      memories: state.memories.map(m => (m.id === id ? updated : m))
    }))
  },

  deleteMemory: async id => {
    await window.electron.memories.delete(id)
    set(state => ({
      memories: state.memories.filter(m => m.id !== id),
      selectedMemoryId: state.selectedMemoryId === id ? null : state.selectedMemoryId
    }))
  },

  searchMemories: async (query, tags, source, dates) => {
    const results = await window.electron.memories.search(query, tags, source, dates)
    set({ searchResults: results, searchQuery: query })
  },

  setSearchQuery: query => {
    set({ searchQuery: query })
    get().searchMemories(query, get().selectedTags.length ? get().selectedTags : undefined)
  },

  toggleTag: tag =>
    set(state => ({
      selectedTags: state.selectedTags.includes(tag)
        ? state.selectedTags.filter(t => t !== tag)
        : [...state.selectedTags, tag]
    })),

  clearSelectedTags: () => set({ selectedTags: [] }),

  createRelationship: async data => {
    const rel = await window.electron.relationships.create(data)
    set(state => ({ relationships: [...state.relationships, rel] }))
  },

  deleteRelationship: async id => {
    await window.electron.relationships.delete(id)
    set(state => ({ relationships: state.relationships.filter(r => r.id !== id) }))
  },

  getAllTags: () => {
    const tagSet = new Set<string>()
    get().memories.forEach(m => m.tags.forEach(t => tagSet.add(t)))
    return Array.from(tagSet).sort()
  },

  getTagCounts: () => {
    const counts: Record<string, number> = {}
    get().memories.forEach(m => m.tags.forEach(t => { counts[t] = (counts[t] || 0) + 1 }))
    return counts
  },

  getSelectedMemory: () => {
    const { memories, selectedMemoryId } = get()
    return memories.find(m => m.id === selectedMemoryId)
  },

  fetchVaultFiles: async () => {
    const [files, config] = await Promise.all([
      window.electron.vault.getFiles(),
      window.electron.vault.getConfig(),
    ])
    set({ vaultFiles: files, vaultConfig: config })
  },

  selectFile: id => set({ selectedFileId: id, selectedMemoryId: null }),

  getSelectedFile: () => {
    const { vaultFiles, selectedFileId } = get()
    return vaultFiles.find(f => f.id === selectedFileId)
  },

  getVaultOnlyFiles: () => {
    const { vaultFiles, vaultConfig } = get()
    const vp = vaultConfig?.vaultPath
    if (!vp) return vaultFiles
    return vaultFiles.filter(f => f.filepath.startsWith(vp))
  },

  getWatchFiles: () => {
    const { vaultFiles, vaultConfig } = get()
    const wp = vaultConfig?.watchPath
    if (!wp) return []
    return vaultFiles.filter(f => f.filepath.startsWith(wp))
  },
}))
