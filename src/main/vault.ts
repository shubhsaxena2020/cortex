import { join, basename, extname } from 'path'
import { readFile, writeFile, mkdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import chokidar, { type FSWatcher } from 'chokidar'
import { app, BrowserWindow } from 'electron'
import log from 'electron-log'
import * as db from './db'
import { getEmbedding } from './embeddings'

const VAULT_CONFIG_FILE = 'vault-config.json'
const MAX_FILE_SIZE = 10 * 1024 * 1024  // 10 MB

const WATCH_IGNORE = [
  // Dependency dirs
  '**/node_modules/**',
  '**/.git/**',
  '**/.svn/**',
  '**/.hg/**',
  '**/.cache/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
  '**/.tox/**',
  '**/vendor/**',
  // Build output dirs (any of these in the user's chosen folder would
  // bloat the index with thousands of generated artifacts)
  '**/dist/**',
  '**/build/**',
  '**/release/**',
  '**/out/**',
  '**/target/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.svelte-kit/**',
  '**/.turbo/**',
  '**/.vite/**',
  '**/.parcel-cache/**',
  '**/.docusaurus/**',
  '**/.nyc_output/**',
  // IDE / editor scratch
  '**/.idea/**',
  '**/.vscode/**',
  // System / OS junk
  '**/*.log',
  '**/Thumbs.db',
  '**/.DS_Store',
  '**/Windows/**',
  '**/Program Files/**',
  '**/Program Files (x86)/**',
  '**/AppData/Local/Temp/**',
  '**/AppData/Roaming/**',
  // Media + archives + binaries (rarely indexable as text)
  '**/*.mp4', '**/*.mkv', '**/*.avi',
  '**/*.mov', '**/*.wmv', '**/*.iso',
  '**/*.zip', '**/*.tar', '**/*.gz',
  '**/*.exe', '**/*.msi', '**/*.dll',
]

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.js', '.ts', '.jsx', '.tsx', '.py',
  '.json', '.csv', '.html', '.xml', '.yaml', '.yml',
  '.sh', '.bash', '.sql', '.css', '.scss', '.toml',
  '.ini', '.cfg', '.rs', '.go', '.java', '.c', '.cpp',
  '.h', '.hpp', '.rb', '.php',
])

export const DEFAULT_VAULT_FOLDERS = [
  'AI Conversations/Claude',
  'AI Conversations/ChatGPT',
  'AI Conversations/Gemini',
  'Code Projects',
  'Documents',
  'Notes',
  'Resources',
]

export interface VaultConfig {
  vaultPath: string | null
  initialized: boolean
  watchPath?: string | null
}

// ── Config ────────────────────────────────────────────────────────────────────

export function getVaultConfigPath(configDir?: string): string {
  const dir = configDir ?? app.getPath('userData')
  return join(dir, VAULT_CONFIG_FILE)
}

export async function loadVaultConfig(configDir?: string): Promise<VaultConfig | null> {
  const configPath = getVaultConfigPath(configDir)
  if (!existsSync(configPath)) return null
  try {
    const raw = await readFile(configPath, 'utf-8')
    return JSON.parse(raw) as VaultConfig
  } catch {
    return null
  }
}

export async function saveVaultConfig(config: VaultConfig, configDir?: string): Promise<void> {
  const configPath = getVaultConfigPath(configDir)
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initVault(vaultPath: string, configDir?: string): Promise<void> {
  await mkdir(vaultPath, { recursive: true })
  for (const folder of DEFAULT_VAULT_FOLDERS) {
    await mkdir(join(vaultPath, folder), { recursive: true })
  }
  await saveVaultConfig({ vaultPath, initialized: true }, configDir)
}

// ── Text extraction ───────────────────────────────────────────────────────────

export function isTextFile(ext: string): boolean {
  return TEXT_EXTENSIONS.has(ext.toLowerCase())
}

export async function extractText(filepath: string, extension: string): Promise<string | null> {
  if (!isTextFile(extension)) return null
  try {
    const fileStat = await stat(filepath)
    if (fileStat.size > MAX_FILE_SIZE) return null
    return await readFile(filepath, 'utf-8')
  } catch {
    return null
  }
}

// ── File indexing ─────────────────────────────────────────────────────────────

export async function indexFile(filepath: string): Promise<void> {
  const ext = extname(filepath)
  const filename = basename(filepath)
  let size = 0
  let lastModified = 0
  let content: string | null = null

  try {
    const fileStat = await stat(filepath)
    size = fileStat.size
    lastModified = Math.floor(fileStat.mtimeMs)

    // Skip if the file is unchanged since the last index pass. Without this,
    // every restart re-runs extractText and hits Ollama for every file in the
    // vault — turning a sub-second boot into minutes of useless work for users
    // with non-trivial vaults.
    const existing = db.getVaultFileByPath(filepath)
    if (existing && existing.lastModified === lastModified && existing.size === size) {
      return
    }

    content = await extractText(filepath, ext)
  } catch {
    return
  }

  db.upsertVaultFile({ filepath, filename, extension: ext, content, size, lastModified })

  if (content && db.hasVectorSearch()) {
    const file = db.getVaultFileByPath(filepath)
    if (file) {
      void getEmbedding(content.slice(0, 4000)).then(vec => {
        if (vec) db.storeVaultEmbedding(file.id, vec)
      })
    }
  }
}

// ── Watcher ───────────────────────────────────────────────────────────────────

let watcher: FSWatcher | null = null
let watchFolderWatcher: FSWatcher | null = null

export function startVaultWatcher(vaultPath: string): void {
  stopVaultWatcher()
  watcher = chokidar.watch(vaultPath, {
    ignoreInitial: false,
    persistent: true,
    // Pointing the vault at any normal folder must not index node_modules,
    // .git, large binaries, etc. WATCH_IGNORE covers those; the leading regex
    // strips dotfiles. Mirrors the watch-folder watcher below.
    ignored: [/(^|[/\\])\../, ...WATCH_IGNORE],
  })
  watcher.on('add', filepath => { void indexFile(filepath) })
  watcher.on('change', filepath => { void indexFile(filepath) })
  watcher.on('unlink', filepath => { db.deleteVaultFileByPath(filepath) })
}

export function stopVaultWatcher(): void {
  if (watcher) {
    void watcher.close()
    watcher = null
  }
}

// ── Watch folder — debounced batch processing ─────────────────────────────────

let pendingWatchFiles = new Set<string>()
let watchDebounceTimer: ReturnType<typeof setTimeout> | null = null

function sendProgress(current: number, total: number): void {
  const wins = BrowserWindow.getAllWindows()
  const win = wins[0] ?? null
  if (win) win.webContents.send('vault:indexProgress', { current, total })
}

function scheduleWatchIndex(filepath: string): void {
  pendingWatchFiles.add(filepath)
  if (watchDebounceTimer) clearTimeout(watchDebounceTimer)
  watchDebounceTimer = setTimeout(() => {
    const files = [...pendingWatchFiles]
    pendingWatchFiles.clear()
    watchDebounceTimer = null
    void processWatchBatch(files)
  }, 2000)
}

async function processWatchBatch(files: string[]): Promise<void> {
  const total = files.length
  let processed = 0

  for (let i = 0; i < files.length; i++) {
    const filepath = files[i]

    try {
      const s = await stat(filepath)
      if (s.size > MAX_FILE_SIZE) {
        log.debug(`[vault] skipping large file: ${filepath} (${s.size} bytes)`)
        processed++
        sendProgress(processed, total)
        continue
      }
    } catch {
      processed++
      continue
    }

    await indexFile(filepath)
    processed++
    sendProgress(processed, total)

    if (i < files.length - 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    }
  }
}

export function startWatchFolderWatcher(watchPath: string): void {
  stopWatchFolderWatcher()
  watchFolderWatcher = chokidar.watch(watchPath, {
    ignoreInitial: false,
    persistent: true,
    ignored: [/(^|[/\\])\./, ...WATCH_IGNORE],
    depth: 10,
  })
  watchFolderWatcher.on('add', filepath => scheduleWatchIndex(filepath))
  watchFolderWatcher.on('change', filepath => scheduleWatchIndex(filepath))
  watchFolderWatcher.on('unlink', filepath => { db.deleteVaultFileByPath(filepath) })
}

export function stopWatchFolderWatcher(): void {
  if (watchFolderWatcher) {
    void watchFolderWatcher.close()
    watchFolderWatcher = null
  }
  // Clear any pending debounce
  if (watchDebounceTimer) {
    clearTimeout(watchDebounceTimer)
    watchDebounceTimer = null
  }
  pendingWatchFiles.clear()
}
