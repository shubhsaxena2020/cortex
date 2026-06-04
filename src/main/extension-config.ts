import { app } from 'electron'
import { join } from 'path'
import { promises as fs } from 'fs'
import { randomBytes } from 'crypto'
import { createServer } from 'net'
import log from 'electron-log'

export interface ExtensionConfig {
  token: string
  port: number
}

const PORT_RANGE_START = 48729
const PORT_RANGE_END = 48738
const HOST = '127.0.0.1'
const TOKEN_BYTES = 32

let cached: ExtensionConfig | null = null

export function getConfigPath(): string {
  return join(app.getPath('userData'), 'extension-config.json')
}

export function getToken(): string {
  if (!cached) throw new Error('Extension config not loaded — call loadOrCreateConfig() first')
  return cached.token
}

export function getCachedConfig(): ExtensionConfig {
  if (!cached) throw new Error('Extension config not loaded — call loadOrCreateConfig() first')
  return cached
}

export async function persistPort(port: number): Promise<void> {
  if (!cached) throw new Error('Extension config not loaded')
  if (cached.port === port) return
  cached.port = port
  await writeConfig(cached)
}

async function readConfig(): Promise<Partial<ExtensionConfig> | null> {
  try {
    const raw = await fs.readFile(getConfigPath(), 'utf8')
    return JSON.parse(raw) as Partial<ExtensionConfig>
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    log.warn('[extension-config] failed to read config, will regenerate:', err)
    return null
  }
}

async function writeConfig(config: ExtensionConfig): Promise<void> {
  const path = getConfigPath()
  const tmp = path + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
  await fs.rename(tmp, path)
}

function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false)
      else reject(err)
    })
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, HOST)
  })
}

function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, HOST, () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      server.close(() => resolve(port))
    })
  })
}

// TOCTOU note: a small race exists between this probe and the real server.listen()
// in http.ts. Caller should handle EADDRINUSE on actual bind and re-run.
export async function bootstrapPort(preferred?: number): Promise<number> {
  if (preferred && preferred > 0 && await tryBind(preferred)) return preferred

  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (p === preferred) continue
    if (await tryBind(p)) return p
  }

  return getEphemeralPort()
}

export async function loadOrCreateConfig(): Promise<ExtensionConfig> {
  if (cached) return cached

  const existing = await readConfig()
  const validToken = typeof existing?.token === 'string' && existing.token.length === TOKEN_BYTES * 2
  const token = validToken ? existing!.token! : randomBytes(TOKEN_BYTES).toString('hex')
  const port = await bootstrapPort(existing?.port)

  const config: ExtensionConfig = { token, port }
  const dirty = !existing || existing.token !== token || existing.port !== port
  if (dirty) await writeConfig(config)

  cached = config
  return config
}
