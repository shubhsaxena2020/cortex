export type MemorySource = 'claude' | 'chatgpt' | 'gemini' | 'manual'
export type RelationshipType = 'related' | 'building_on' | 'contrasts' | 'example'
export type ViewType = 'editor' | 'graph' | 'search' | 'settings'

export interface ExtensionConfig {
  token: string
  port: number
  configPath: string
}

export interface SystemStatus {
  ollama: {
    reachable: boolean
    modelPulled: boolean
    model: string
  }
  vectorSearch: {
    enabled: boolean
    embeddedCount: number
    totalMemories: number
  }
  apiServer: {
    port: number
    listening: boolean
  }
}

export interface VaultConfig {
  vaultPath: string | null
  initialized: boolean
  watchPath?: string | null
}

export interface VaultFile {
  id: string
  filepath: string
  filename: string
  extension: string
  content: string
  size: number
  lastModified: number
  indexedAt: number
}

export interface Memory {
  id: string
  title: string
  content: string
  source: MemorySource
  created_at: string
  updated_at: string
  tags: string[]
  /** Canonical source URL — present for chats captured via the extension; null otherwise. Used for dedup (P0 #1). */
  url: string | null
}

export interface Relationship {
  id: string
  memory_a_id: string
  memory_b_id: string
  relationship_type: RelationshipType
  /** Combined signal score 0.0–1.0 (P1 #4 auto-edges) */
  strength: number
  /** Signal provenance: 'auto:tag' | 'auto:keyword' | 'auto:embedding' | 'manual' */
  signal_type: string
}

export interface SearchResult extends Memory {
  highlight?: string
}

export type TelemetryEventType =
  | 'search_executed'
  | 'memory_created'
  | 'memory_deleted'
  | 'graph_interaction'
  | 'extension_paired'
  | 'app_session'

export interface TelemetryEvent {
  type: TelemetryEventType
  data: Record<string, unknown>
  timestamp: string
}

export interface TelemetryStats {
  total: number
  byType: Record<string, number>
  earliest: string | null
  latest: string | null
}

export type FeedbackType = 'bug' | 'feature' | 'other'

export interface FeedbackSubmission {
  type: FeedbackType
  title: string
  description: string
}

export interface StoredFeedback extends FeedbackSubmission {
  id: string
  timestamp: string
}

export interface ElectronAPI {
  memories: {
    getAll: () => Promise<Memory[]>
    get: (id: string) => Promise<Memory | null>
    create: (memory: Omit<Memory, 'id' | 'created_at' | 'updated_at'>) => Promise<Memory>
    update: (id: string, memory: Partial<Memory>) => Promise<Memory>
    delete: (id: string) => Promise<void>
    search: (query: string, tags?: string[], source?: string) => Promise<SearchResult[]>
  }
  relationships: {
    getAll: () => Promise<Relationship[]>
    getForMemory: (memoryId: string) => Promise<Relationship[]>
    create: (rel: Omit<Relationship, 'id'>) => Promise<Relationship>
    delete: (id: string) => Promise<void>
  }
  extension: {
    getConfig: () => Promise<ExtensionConfig>
    armPairing: (durationMs?: number) => Promise<number>  // returns epoch-ms deadline
  }
  system: {
    getStatus: () => Promise<SystemStatus>
  }
  vault: {
    getConfig: () => Promise<VaultConfig | null>
    choosePath: () => Promise<string | null>
    initVault: (vaultPath: string) => Promise<void>
    getFiles: () => Promise<VaultFile[]>
    searchFiles: (query: string) => Promise<VaultFile[]>
    deleteFile: (id: string) => Promise<void>
    openInExplorer: (filepath: string) => Promise<void>
    readFile: (filepath: string) => Promise<string>
    createFile: (dirPath: string, filename: string) => Promise<void>
    createFolder: (dirPath: string, name: string) => Promise<void>
    rename: (oldPath: string, newPath: string) => Promise<void>
    deleteItem: (itemPath: string) => Promise<void>
    copyToVault: (sourcePaths: string[], destDir: string) => Promise<string[]>
    openFile: (filepath: string) => Promise<void>
    extractDocText: (filepath: string) => Promise<string>
    semanticSearch: (query: string) => Promise<VaultFile[]>
    setWatchPath: (watchPath: string) => Promise<void>
    removeWatchPath: () => Promise<void>
  }
  data: {
    exportMemories: (format: 'json' | 'csv') => Promise<{ exported: number; path: string | null }>
    importMemories: () => Promise<{ imported: number; skipped: number; errors: string[] }>
  }
  telemetry: {
    isEnabled: () => Promise<boolean>
    setEnabled: (enabled: boolean) => Promise<void>
    capture: (type: TelemetryEventType, data: Record<string, unknown>) => void
    getAll: () => Promise<TelemetryEvent[]>
    getStats: () => Promise<TelemetryStats>
    export: () => Promise<string>
    clear: () => Promise<void>
  }
  feedback: {
    save: (submission: FeedbackSubmission) => Promise<StoredFeedback>
    getAll: () => Promise<StoredFeedback[]>
  }
  events: {
    onMemoriesChanged: (callback: () => void) => () => void  // returns unsubscribe
    onExtensionPaired: (callback: () => void) => () => void  // returns unsubscribe
    onVaultChanged: (callback: () => void) => () => void     // returns unsubscribe
    onIndexProgress: (callback: (data: { current: number; total: number }) => void) => () => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
  }
}
