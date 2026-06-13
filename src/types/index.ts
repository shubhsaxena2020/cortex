export type MemorySource = 'claude' | 'chatgpt' | 'gemini' | 'manual'
export type RelationshipType = 'related' | 'building_on' | 'contrasts' | 'example' | 'wiki'
export type ViewType = 'editor' | 'graph' | 'search' | 'settings'

/** Embedding backfill state (v0.3.0 backfill UI). */
export interface SeedStatus {
  state: 'idle' | 'running' | 'paused' | 'done' | 'skipped'
  done: number
  total: number
  reason?: string
}

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
  /**
   * Full body. List surfaces receive the LIGHT projection where this is ''
   * until the memory is hydrated via memories:get (see store.hydrateMemory) —
   * at 100k memories shipping every content over IPC is hundreds of MB.
   */
  content: string
  /** First 200 chars of content — always present on light rows, for previews/filtering. */
  snippet?: string
  source: MemorySource
  created_at: string
  updated_at: string
  tags: string[]
  /** Canonical source URL — present for chats captured via the extension; null otherwise. Used for dedup (P0 #1). */
  url: string | null
}

/** Memory→file mention edge, computed in the main process (graph perf). */
export interface MentionEdge {
  source: string
  target: string
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
    search: (query: string, tags?: string[], source?: string, dates?: { from?: number; to?: number }) => Promise<SearchResult[]>
  }
  relationships: {
    getAll: () => Promise<Relationship[]>
    getForMemory: (memoryId: string) => Promise<Relationship[]>
    create: (rel: Omit<Relationship, 'id'>) => Promise<Relationship>
    delete: (id: string) => Promise<void>
  }
  graph: {
    getMentionEdges: () => Promise<MentionEdge[]>
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
  tags: {
    getCounts: () => Promise<Array<{ tag: string; count: number }>>
    rename: (from: string, to: string) => Promise<{ changed: number; error: string | null }>
    delete: (tag: string) => Promise<{ changed: number; error: string | null }>
    suggest: (id: string) => Promise<string[]>
  }
  embeddings: {
    getStatus: () => Promise<SeedStatus>
    pause: () => Promise<SeedStatus>
    resume: () => Promise<SeedStatus>
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
    onEmbeddingsProgress: (callback: (data: SeedStatus) => void) => () => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
  }
}
