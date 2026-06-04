import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: vi.fn().mockReturnValue('/test/userData') },
}))

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}))

vi.mock('./db', () => ({
  hasVectorSearch: vi.fn().mockReturnValue(false),
  upsertVaultFile: vi.fn(),
  getVaultFileByPath: vi.fn(),
  storeVaultEmbedding: vi.fn(),
  deleteVaultFileByPath: vi.fn(),
}))

vi.mock('./embeddings', () => ({
  getEmbedding: vi.fn().mockResolvedValue(null),
}))

const mockReadFile = vi.fn()
const mockWriteFile = vi.fn()
const mockMkdir = vi.fn()
const mockStat = vi.fn()
vi.mock('fs/promises', () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
}))

const mockExistsSync = vi.fn()
vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  getVaultConfigPath,
  loadVaultConfig,
  saveVaultConfig,
  initVault,
  isTextFile,
  extractText,
  indexFile,
  startVaultWatcher,
  stopVaultWatcher,
  startWatchFolderWatcher,
  stopWatchFolderWatcher,
  DEFAULT_VAULT_FOLDERS,
} from './vault'
import * as db from './db'
import chokidar from 'chokidar'

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  mockMkdir.mockResolvedValue(undefined)
  mockWriteFile.mockResolvedValue(undefined)
})

describe('getVaultConfigPath', () => {
  it('uses provided configDir', () => {
    const result = getVaultConfigPath('/custom/dir')
    expect(result).toContain('vault-config.json')
    expect(result).toContain('custom')
  })

  it('falls back to app.getPath when no configDir', () => {
    const result = getVaultConfigPath()
    expect(result).toContain('vault-config.json')
    expect(result).toContain('userData')
  })
})

describe('loadVaultConfig', () => {
  it('returns null when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    const result = await loadVaultConfig('/test/dir')
    expect(result).toBeNull()
  })

  it('returns parsed config when file exists', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFile.mockResolvedValue(JSON.stringify({ vaultPath: '/vault', initialized: true }))
    const result = await loadVaultConfig('/test/dir')
    expect(result).toEqual({ vaultPath: '/vault', initialized: true })
  })

  it('returns null on parse error', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFile.mockResolvedValue('invalid json {{{')
    const result = await loadVaultConfig('/test/dir')
    expect(result).toBeNull()
  })
})

describe('saveVaultConfig', () => {
  it('writes JSON to correct path', async () => {
    const config = { vaultPath: '/vault', initialized: true }
    await saveVaultConfig(config, '/test/dir')
    expect(mockWriteFile).toHaveBeenCalledOnce()
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, string]
    expect(JSON.parse(content)).toEqual(config)
  })
})

describe('initVault', () => {
  it('creates vault root and all default subfolders', async () => {
    await initVault('/my/vault', '/test/dir')
    // 1 root + 7 subfolders = 8 mkdir calls
    expect(mockMkdir).toHaveBeenCalledTimes(1 + DEFAULT_VAULT_FOLDERS.length)
    expect(mockMkdir).toHaveBeenCalledWith('/my/vault', { recursive: true })
  })

  it('saves config after creating folders', async () => {
    await initVault('/my/vault', '/test/dir')
    expect(mockWriteFile).toHaveBeenCalledOnce()
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, string]
    const saved = JSON.parse(content) as { vaultPath: string; initialized: boolean }
    expect(saved.vaultPath).toBe('/my/vault')
    expect(saved.initialized).toBe(true)
  })
})

describe('isTextFile', () => {
  it.each(['.md', '.txt', '.py', '.ts', '.js', '.json', '.csv'])(
    'returns true for %s', ext => expect(isTextFile(ext)).toBe(true)
  )

  it.each(['.pdf', '.docx', '.xlsx', '.png', '.jpg', '.exe'])(
    'returns false for %s', ext => expect(isTextFile(ext)).toBe(false)
  )

  it('is case-insensitive', () => {
    expect(isTextFile('.MD')).toBe(true)
    expect(isTextFile('.PY')).toBe(true)
  })
})

describe('extractText', () => {
  it('returns null for non-text files', async () => {
    const result = await extractText('/file.pdf', '.pdf')
    expect(result).toBeNull()
    expect(mockStat).not.toHaveBeenCalled()
  })

  it('returns null for files exceeding size limit', async () => {
    mockStat.mockResolvedValue({ size: 10 * 1024 * 1024 + 1 })  // just over 10 MB
    const result = await extractText('/file.md', '.md')
    expect(result).toBeNull()
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it('returns file contents for small text files', async () => {
    mockStat.mockResolvedValue({ size: 1024 })
    mockReadFile.mockResolvedValue('# Hello')
    const result = await extractText('/file.md', '.md')
    expect(result).toBe('# Hello')
  })

  it('returns null when stat throws', async () => {
    mockStat.mockRejectedValue(new Error('ENOENT'))
    const result = await extractText('/missing.md', '.md')
    expect(result).toBeNull()
  })
})

describe('indexFile', () => {
  it('calls upsertVaultFile with correct data', async () => {
    mockStat.mockResolvedValue({ size: 512, mtimeMs: 1700000000000 })
    mockReadFile.mockResolvedValue('hello world')
    await indexFile('/vault/notes/test.md')
    expect(db.upsertVaultFile).toHaveBeenCalledWith(expect.objectContaining({
      filepath: '/vault/notes/test.md',
      filename: 'test.md',
      extension: '.md',
      content: 'hello world',
      size: 512,
    }))
  })

  it('upserts with null content for binary files', async () => {
    mockStat.mockResolvedValue({ size: 2048, mtimeMs: 1700000000000 })
    await indexFile('/vault/doc.pdf')
    expect(db.upsertVaultFile).toHaveBeenCalledWith(expect.objectContaining({
      extension: '.pdf',
      content: null,
    }))
  })

  it('silently skips when stat throws', async () => {
    mockStat.mockRejectedValue(new Error('EACCES'))
    await indexFile('/vault/locked.txt')
    expect(db.upsertVaultFile).not.toHaveBeenCalled()
  })
})

describe('startVaultWatcher / stopVaultWatcher', () => {
  it('starts chokidar watch on given path', () => {
    startVaultWatcher('/my/vault')
    expect(chokidar.watch).toHaveBeenCalledWith('/my/vault', expect.objectContaining({
      ignoreInitial: false,
      persistent: true,
    }))
  })

  it('stops existing watcher before starting new one', () => {
    const mockWatcher = { on: vi.fn().mockReturnThis(), close: vi.fn().mockResolvedValue(undefined) }
    vi.mocked(chokidar.watch).mockReturnValue(mockWatcher as ReturnType<typeof chokidar.watch>)
    startVaultWatcher('/vault1')
    startVaultWatcher('/vault2')
    expect(mockWatcher.close).toHaveBeenCalledOnce()
    expect(chokidar.watch).toHaveBeenCalledTimes(2)
  })

  it('stopVaultWatcher closes the watcher', () => {
    const mockWatcher = { on: vi.fn().mockReturnThis(), close: vi.fn().mockResolvedValue(undefined) }
    vi.mocked(chokidar.watch).mockReturnValue(mockWatcher as ReturnType<typeof chokidar.watch>)
    startVaultWatcher('/my/vault')
    stopVaultWatcher()
    expect(mockWatcher.close).toHaveBeenCalledOnce()
  })
})

describe('startWatchFolderWatcher / stopWatchFolderWatcher', () => {
  it('starts chokidar watch on given watch path with depth limit', () => {
    startWatchFolderWatcher('/my/downloads')
    expect(chokidar.watch).toHaveBeenCalledWith('/my/downloads', expect.objectContaining({
      ignoreInitial: false,
      persistent: true,
      depth: 10,
    }))
  })

  it('operates independently of vault watcher', () => {
    vi.clearAllMocks()
    startVaultWatcher('/vault')
    startWatchFolderWatcher('/downloads')
    expect(chokidar.watch).toHaveBeenCalledTimes(2)
  })

  it('stopWatchFolderWatcher closes only the watch folder watcher', () => {
    const vaultMock = { on: vi.fn().mockReturnThis(), close: vi.fn().mockResolvedValue(undefined) }
    const watchMock = { on: vi.fn().mockReturnThis(), close: vi.fn().mockResolvedValue(undefined) }
    vi.mocked(chokidar.watch)
      .mockReturnValueOnce(vaultMock as ReturnType<typeof chokidar.watch>)
      .mockReturnValueOnce(watchMock as ReturnType<typeof chokidar.watch>)
    startVaultWatcher('/vault')
    startWatchFolderWatcher('/downloads')
    stopWatchFolderWatcher()
    expect(watchMock.close).toHaveBeenCalledOnce()
    expect(vaultMock.close).not.toHaveBeenCalled()
  })

  it('stopWatchFolderWatcher is safe to call when no watcher running', () => {
    stopWatchFolderWatcher()
    // should not throw
  })
})
