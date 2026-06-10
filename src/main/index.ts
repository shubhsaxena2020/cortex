import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, basename } from 'path'
import { readFile, writeFile, mkdir, rename, rm, copyFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import * as db from './db'
import { toMemory, toRelationship, makeHighlight } from './transformers'
import { loadOrCreateConfig, bootstrapPort, getCachedConfig, getConfigPath, persistPort } from './extension-config'
import { startHttpServer, stopHttpServer, armPairing } from './http'
import { seedEmbeddingsIfNeeded, embedAndStore, memoryToText } from './seed-embeddings'
import { isOllamaAvailable, isEmbedModelAvailable } from './embeddings'
import { loadVaultConfig, saveVaultConfig, initVault, startVaultWatcher, stopVaultWatcher, startWatchFolderWatcher, stopWatchFolderWatcher } from './vault'
import * as telemetry from './telemetry'
import { buildEdgesForMemory, backfillAllEdges, invalidateEdgeCandidateCache } from './edge-builder'
import { memoriesToJson, memoriesToCsv, parseMemoriesJson } from './export-import'
import { normalizeTag, isValidTag } from './tag-ops'
import { version as appVersion } from '../../package.json'
import type { TelemetryEventType, FeedbackSubmission } from '../types'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require('mammoth') as typeof import('mammoth')

// Module-level vault path — updated on startup and when user changes vault.
let currentVaultPath: string | null = null

const PLATFORM_FOLDERS: Record<string, string> = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  manual: 'Manual',
}

async function saveConversationToVault(
  memory: { id: string; title: string; content: string; source: string; created_at: string; tags: string[] },
  url?: string
): Promise<void> {
  if (!currentVaultPath) return
  try {
    const platform = PLATFORM_FOLDERS[memory.source] ?? 'Manual'
    const folder = join(currentVaultPath, 'AI Conversations', platform)
    await mkdir(folder, { recursive: true })

    const date = memory.created_at.slice(0, 10)
    const slug = memory.title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 50)
    const filename = `${date}-${slug || 'untitled'}.md`
    const filepath = join(folder, filename)

    const frontmatter = [
      '---',
      `source: ${memory.source}`,
      `captured: ${memory.created_at}`,
      url ? `url: ${url}` : null,
      `tags: [${memory.tags.join(', ')}]`,
      '---',
      '',
    ].filter(l => l !== null).join('\n')

    await writeFile(filepath, frontmatter + memory.content, 'utf-8')
  } catch (err) {
    log.error('[vault] failed to save conversation file:', err)
  }
}

// ─── Single-instance lock ─────────────────────────────────────────────────────
// Prevents a second Electron instance from fighting over the HTTP port + DB.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  // Log renderer crashes instead of showing a blank white window
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error(`[cortex] Renderer process gone: ${details.reason} (exit=${details.exitCode})`)
    // Don't quit — user can see the crash info in the main process log
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log.error(`[cortex] Renderer failed to load: ${errorDescription} (code=${errorCode})`)
  })

  mainWindow.webContents.setWindowOpenHandler(details => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ─── HTTP server bootstrap (with EADDRINUSE retry) ────────────────────────────

function broadcastMemoriesChanged(payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('memories:changed', payload)
  }
}

function broadcastExtensionPaired(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('extension:paired')
  }
}

function broadcastVaultChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('vault:changed')
  }
}

async function startServerWithRetry(): Promise<void> {
  const config = await loadOrCreateConfig()
  const httpOpts = {
    port: config.port,
    onMemoryCreated: (memory: ReturnType<typeof toMemory>, url?: string) => {
      broadcastMemoriesChanged({ memory })
      void embedAndStore(memory.id, memoryToText(memory))
      void saveConversationToVault(memory, url)
      // Fire-and-forget: auto-edges for the new memory (P1 #4)
      setImmediate(async () => {
        try {
          await buildEdgesForMemory(db.getDb(), memory.id)
        } catch (err) {
          log.error('[edge-builder] Failed to build edges for new memory:', err)
        }
      })
      telemetry.capture('memory_created', {
        source: memory.source,
        size_bytes: Buffer.byteLength(memory.content ?? '', 'utf8'),
      })
    },
    onMemoryDeleted: (memory: { id: string }) => {
      broadcastMemoriesChanged({ memory, deleted: true })
      telemetry.capture('memory_deleted', { count: 1 })
    },
    onExtensionPaired: () => {
      broadcastExtensionPaired()
      telemetry.capture('extension_paired', {
        extension_version: 'unknown',
        vault_path_hash: currentVaultPath ? telemetry.hashPath(currentVaultPath) : null,
      })
    },
    saveVaultFile: async (filename: string, content: string, source: string) => {
      if (!currentVaultPath) return { success: false }
      try {
        const platform = PLATFORM_FOLDERS[source] ?? 'Manual'
        const folder = join(currentVaultPath, 'AI Conversations', platform)
        await mkdir(folder, { recursive: true })
        const filepath = join(folder, filename)
        await writeFile(filepath, content, 'utf-8')
        broadcastVaultChanged()
        return { success: true, path: filepath }
      } catch (err) {
        log.error('[vault] saveVaultFile failed:', err)
        return { success: false }
      }
    }
  }
  let port: number
  try {
    port = await startHttpServer(httpOpts)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
    // TOCTOU race — the port we resolved went stale. Re-bootstrap and retry once.
    const newPort = await bootstrapPort()
    port = await startHttpServer({ ...httpOpts, port: newPort })
  }
  if (port !== config.port) await persistPort(port)
  log.info(`[cortex] extension API on http://127.0.0.1:${port}`)
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

if (is.dev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9333')
}

// File logger writes to <userData>/logs/main.log. Keeps a rolling buffer so
// when a user reports "the app won't start" we have something to inspect
// without asking them to set up a console session.
log.initialize()
log.transports.file.level = 'info'
log.transports.console.level = 'info'

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.cortex')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await db.initDb()
  await telemetry.initTelemetry(app.getPath('userData')).catch(err =>
    log.error('[telemetry] init failed:', err)
  )
  registerIpcHandlers()
  try {
    await startServerWithRetry()
  } catch (err) {
    log.error('[cortex] extension API failed to start:', err)
    // App keeps running even if extension API fails — desktop UI is unaffected.
  }

  // Start vault watcher if a vault path is configured.
  const vaultCfg = await loadVaultConfig().catch(() => null)
  currentVaultPath = vaultCfg?.vaultPath ?? null
  if (currentVaultPath) {
    startVaultWatcher(currentVaultPath)
    log.info(`[cortex] vault watcher started: ${currentVaultPath}`)
  }
  if (vaultCfg?.watchPath) {
    startWatchFolderWatcher(vaultCfg.watchPath)
    log.info(`[cortex] watch folder watcher started: ${vaultCfg.watchPath}`)
  }

  // Backfill embeddings in the background; doesn't block window creation.
  // If Ollama isn't installed/running, this silently no-ops and search degrades
  // to keyword mode.
  void seedEmbeddingsIfNeeded()
    .then(r => {
      if (r.skipped) log.info(`[cortex] embedding seed skipped (${r.skipped})`)
      else log.info(`[cortex] embedding seed: ${r.embedded} new of ${r.total}`)
    })
    .catch(err => log.error('[cortex] seed failed:', err))

  // Backfill auto-edges in the background (P1 #4); runs after schema migration.
  // Only processes memories without existing auto-edges, so subsequent startups
  // are a no-op.
  setImmediate(async () => {
    try {
      log.info('[cortex] Starting auto-edge backfill...')
      let lastLog = 0
      await backfillAllEdges(db.getDb(), (done, total) => {
        if (done - lastLog >= 500 || done === total) {
          log.info(`[cortex] Backfill progress: ${done}/${total}`)
          lastLog = done
        }
      })
      log.info('[cortex] Auto-edge backfill complete.')
    } catch (err) {
      log.error('[cortex] Backfill error:', err)
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', async () => {
  stopVaultWatcher()
  stopWatchFolderWatcher()
  // Session summary (no-op if telemetry is off). Counts are cheap DB reads.
  try {
    const memoriesIndexed = db.getAllMemories().length
    const filesIndexed = db.getAllVaultFiles().length
    await telemetry.recordSessionEnd({ memoriesIndexed, filesIndexed })
  } catch (err) {
    log.error('[telemetry] session-end failed:', err)
  }
  await stopHttpServer().catch(err => log.error('[cortex] stopHttpServer:', err))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ─── IPC handlers ─────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  // Memories
  ipcMain.handle('memories:getAll', () =>
    db.getAllMemories().map(toMemory)
  )

  ipcMain.handle('memories:get', (_e, id: string) => {
    const row = db.getMemory(id)
    return row ? toMemory(row) : null
  })

  ipcMain.handle('memories:create', (_e, data: {
    title: string; content: string; source: string; tags: string[]
  }) => {
    const id = randomUUID()
    const row = db.createMemory(
      id,
      data.title || 'Untitled',
      data.content || '',
      data.source || 'manual',
      data.tags || []
    )
    // Fire-and-forget: response returns immediately; embedding lands async.
    void embedAndStore(id, memoryToText(row))
    telemetry.capture('memory_created', {
      source: row.source,
      size_bytes: Buffer.byteLength(row.content ?? '', 'utf8'),
    })
    return toMemory(row)
  })

  ipcMain.handle('memories:update', (_e, id: string, data: {
    title?: string; content?: string; tags?: string[]
  }) => {
    const current = db.getMemory(id)
    if (!current) throw new Error(`Memory not found: ${id}`)
    db.updateMemory(
      id,
      data.title ?? current.title,
      data.content ?? current.content,
      data.tags ?? current.tags
    )
    const updated = db.getMemory(id)!
    void embedAndStore(id, memoryToText(updated))
    return toMemory(updated)
  })

  ipcMain.handle('memories:delete', (_e, id: string) => {
    db.deleteMemory(id)
    telemetry.capture('memory_deleted', { count: 1 })
  })

  ipcMain.handle('memories:search', (_e, query: string, tags?: string[], source?: string, dates?: { from?: number; to?: number }) => {
    // db.searchMemories signature: (query, source?, tags?, dateFrom?, dateTo?)
    const t0 = performance.now()
    const rows = db.searchMemories(query || '', source, tags, dates?.from, dates?.to)
    const latency = performance.now() - t0
    // Only the query LENGTH is recorded — never the query text.
    telemetry.capture('search_executed', {
      query_length: (query || '').length,
      result_count: rows.length,
      latency_ms: Math.round(latency * 100) / 100,
    })
    return rows.map(r => ({ ...toMemory(r), highlight: makeHighlight(r.content || '', query || '') }))
  })

  // Relationships
  ipcMain.handle('relationships:getAll', () =>
    db.getAllRelationships().map(toRelationship)
  )

  ipcMain.handle('relationships:getForMemory', (_e, memoryId: string) =>
    db.getRelationshipsForMemory(memoryId).map(toRelationship)
  )

  ipcMain.handle('relationships:create', (_e, data: {
    memory_a_id: string; memory_b_id: string; relationship_type: string
  }) => {
    const row = db.createRelationship(
      data.memory_a_id,
      data.memory_b_id,
      data.relationship_type || 'related'
    )
    return toRelationship(row)
  })

  ipcMain.handle('relationships:delete', (_e, id: string) => {
    db.deleteRelationship(id)
  })

  // Extension config (read-only — for the Settings page)
  ipcMain.handle('extension:getConfig', () => {
    const cfg = getCachedConfig()
    return { token: cfg.token, port: cfg.port, configPath: getConfigPath() }
  })

  // Click-to-pair: arms the /pair window for the given duration (default 60s).
  // Returns the epoch-ms deadline so the renderer can show a live countdown.
  ipcMain.handle('extension:armPairing', (_e, durationMs?: number) => {
    return armPairing(durationMs)
  })

  // System status: surfaces silent-degradation state to the renderer so the
  // user can see at a glance whether semantic search is actually running.
  // The Ollama probes use short timeouts (2s each) and can run in parallel.
  ipcMain.handle('system:getStatus', async () => {
    const cfg = getCachedConfig()
    const [reachable, modelPulled] = await Promise.all([
      isOllamaAvailable(),
      isEmbedModelAvailable(),
    ])
    const enabled = db.hasVectorSearch()
    const totalMemories = db.getAllMemories().length
    const embeddedCount = enabled ? db.countEmbeddings() : 0
    return {
      ollama: {
        reachable,
        modelPulled,
        model: process.env.CORTEX_EMBED_MODEL || 'all-minilm',
      },
      vectorSearch: { enabled, embeddedCount, totalMemories },
      apiServer: { port: cfg.port, listening: true },
    }
  })

  // Vault
  ipcMain.handle('vault:getConfig', () => loadVaultConfig())

  ipcMain.handle('vault:choosePath', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose Vault Folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Use as Vault',
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle('vault:initVault', async (_e, vaultPath: string) => {
    await initVault(vaultPath)
    currentVaultPath = vaultPath
    startVaultWatcher(vaultPath)
    broadcastVaultChanged()
  })

  ipcMain.handle('vault:getFiles', () => db.getAllVaultFiles())

  ipcMain.handle('vault:searchFiles', (_e, query: string) => db.searchVaultFiles(query))

  ipcMain.handle('vault:deleteFile', (_e, id: string) => db.deleteVaultFileById(id))

  ipcMain.handle('vault:openInExplorer', (_e, filepath: string) => shell.showItemInFolder(filepath))

  ipcMain.handle('vault:readFile', (_e, filepath: string) => readFile(filepath, 'utf-8'))

  ipcMain.handle('vault:createFile', async (_e, dirPath: string, filename: string) => {
    await writeFile(join(dirPath, filename), '', 'utf-8')
  })

  ipcMain.handle('vault:createFolder', async (_e, dirPath: string, name: string) => {
    await mkdir(join(dirPath, name), { recursive: true })
  })

  ipcMain.handle('vault:rename', (_e, oldPath: string, newPath: string) => rename(oldPath, newPath))

  ipcMain.handle('vault:deleteItem', (_e, itemPath: string) =>
    rm(itemPath, { recursive: true, force: true })
  )

  ipcMain.handle('vault:openFile', (_e, filepath: string) => shell.openPath(filepath))

  ipcMain.handle('vault:semanticSearch', async (_e, query: string) => {
    const { getEmbedding } = await import('./embeddings')
    const vec = await getEmbedding(query)
    if (!vec) {
      // Keyword fallback
      return db.searchVaultFiles(query)
    }
    const hits = db.vectorSearchVaultFiles(vec, 20)
    if (hits.length === 0) return db.searchVaultFiles(query)
    const files = hits.map(h => db.getVaultFileById(h.file_id)).filter(Boolean)
    return files
  })

  ipcMain.handle('vault:extractDocText', async (_e, filepath: string) => {
    const result = await mammoth.extractRawText({ path: filepath }) as { value: string }
    return result.value
  })

  ipcMain.handle('vault:copyToVault', async (_e, sourcePaths: string[], destDir: string) => {
    const results: string[] = []
    for (const src of sourcePaths) {
      const dest = join(destDir, basename(src))
      await copyFile(src, dest)
      results.push(dest)
    }
    return results
  })

  ipcMain.handle('vault:setWatchPath', async (_e, watchPath: string) => {
    const cfg = await loadVaultConfig() ?? { vaultPath: null, initialized: false }
    await saveVaultConfig({ ...cfg, watchPath })
    startWatchFolderWatcher(watchPath)
    broadcastVaultChanged()
  })

  ipcMain.handle('vault:removeWatchPath', async () => {
    const cfg = await loadVaultConfig() ?? { vaultPath: null, initialized: false }
    await saveVaultConfig({ ...cfg, watchPath: null })
    stopWatchFolderWatcher()
    broadcastVaultChanged()
  })

  // ── Telemetry (opt-in, fully local) ──────────────────────────────────────
  ipcMain.handle('telemetry:isEnabled', () => telemetry.isTelemetryEnabled())
  ipcMain.handle('telemetry:setEnabled', (_e, enabled: boolean) => telemetry.setTelemetryEnabled(enabled))
  // `send` (not invoke) for capture — fire-and-forget from the renderer.
  ipcMain.on('telemetry:capture', (_e, type: TelemetryEventType, data: Record<string, unknown>) => {
    telemetry.capture(type, data)
  })
  ipcMain.handle('telemetry:getAll', () => telemetry.getAllEvents())
  ipcMain.handle('telemetry:getStats', () => telemetry.getTelemetryStats())
  ipcMain.handle('telemetry:export', () => telemetry.exportEvents({ appVersion, platform: process.platform }))
  ipcMain.handle('telemetry:clear', () => telemetry.clearAllEvents())

  // ── Feedback (independent of telemetry opt-in) ───────────────────────────
  ipcMain.handle('feedback:save', (_e, submission: FeedbackSubmission) => telemetry.saveFeedback(submission))
  ipcMain.handle('feedback:getAll', () => telemetry.getAllFeedback())

  // ── Bulk tag operations ───────────────────────────────────────────────────
  ipcMain.handle('tags:getCounts', () => db.getTagCounts())

  ipcMain.handle('tags:rename', (_e, from: string, to: string) => {
    const target = normalizeTag(to)
    if (!isValidTag(target)) return { changed: 0, error: `Invalid tag name: "${to}"` }
    const changed = db.renameTag(from, target)
    if (changed > 0) {
      // Bulk tag ops don't bump updatedAt, so the edge-builder's fingerprint
      // cache can't see them — invalidate explicitly.
      invalidateEdgeCandidateCache()
      broadcastMemoriesChanged()
    }
    return { changed, error: null }
  })

  ipcMain.handle('tags:delete', (_e, tag: string) => {
    const changed = db.deleteTag(tag)
    if (changed > 0) {
      invalidateEdgeCandidateCache()
      broadcastMemoriesChanged()
    }
    return { changed, error: null }
  })

  // ── Data export / import ──────────────────────────────────────────────────
  ipcMain.handle('data:exportMemories', async (_e, format: 'json' | 'csv') => {
    const memories = db.getAllMemories().map(toMemory)
    const ext = format === 'csv' ? 'csv' : 'json'
    const result = await dialog.showSaveDialog({
      title: 'Export Memories',
      defaultPath: `cortex-memories-${new Date().toISOString().slice(0, 10)}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    })
    if (result.canceled || !result.filePath) return { exported: 0, path: null }
    const payload = format === 'csv' ? memoriesToCsv(memories) : memoriesToJson(memories)
    await writeFile(result.filePath, payload, 'utf-8')
    return { exported: memories.length, path: result.filePath }
  })

  ipcMain.handle('data:importMemories', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import Memories',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePaths[0]) {
      return { imported: 0, skipped: 0, errors: [] }
    }
    const raw = await readFile(result.filePaths[0], 'utf-8')
    const { memories, errors } = parseMemoriesJson(raw)

    // Skip exact duplicates (same title + content) already in the DB.
    const existing = new Set(
      db.getAllMemories().map(m => `${m.title}\u0000${m.content ?? ''}`)
    )
    let imported = 0
    let skipped = 0
    for (const m of memories) {
      if (existing.has(`${m.title}\u0000${m.content}`)) { skipped++; continue }
      const id = randomUUID()
      const row = db.createMemory(id, m.title, m.content, m.source, m.tags, m.url)
      void embedAndStore(id, memoryToText(row))
      void buildEdgesForMemory(db.getDb(), id).catch(() => {})
      imported++
    }
    if (imported > 0) broadcastMemoriesChanged()
    return { imported, skipped, errors }
  })
}
