// Opt-in, fully-local telemetry + feedback storage (v0.2.0 P0 #5).
//
// PRIVACY CONTRACT (enforced here, not just promised in the UI):
//   - OFF by default. Nothing is written until the user flips the toggle.
//   - Zero network. This module only ever touches the local filesystem under
//     <userData>/telemetry and <userData>/feedback.
//   - Zero PII. Events carry derived scalars only (lengths, counts, latencies,
//     a SHA-256 of the vault path — never the path itself). `redactEvent()`
//     is a defence-in-depth blocklist that strips any field a future caller
//     might add carelessly (path, query, content, ip, email, …).
//   - User-owned. Everything is viewable, exportable, and deletable from
//     Settings.
//
// TESTABILITY: the pure helpers (hashPath, makeEvent, redactEvent,
// dailyFilename, serializeEvents, parseJsonl, validateFeedback) take no
// hidden state and never touch disk or electron, so they unit-test in plain
// Node. Disk + lifecycle live behind initTelemetry(dir).

import { join } from 'path'
import { promises as fs } from 'fs'
import { createHash, randomUUID } from 'crypto'

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
  timestamp: string // ISO8601
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

export const FEEDBACK_TITLE_MAX = 50
export const FEEDBACK_DESC_MAX = 500
const RETENTION_DAYS = 30
const FLUSH_INTERVAL_MS = 60_000

// Keys that must never reach disk. Matched case-insensitively against event
// data keys. The schema callers use is already clean; this is the safety net.
const PII_KEY_BLOCKLIST = new Set([
  'path', 'filepath', 'vaultpath', 'query', 'content', 'text', 'body',
  'ip', 'ipaddress', 'userid', 'user_id', 'email', 'name', 'username',
  'url', 'token', 'title',
])

// ── Pure helpers (no state, no I/O) ─────────────────────────────────────────

/** SHA-256 hex of a path. Used so we can tell "same vault" apart across
 *  sessions without ever storing the real path. */
export function hashPath(path: string): string {
  return createHash('sha256').update(path).digest('hex')
}

/** Drop any blocklisted (potentially-PII) keys from an event's data. */
export function redactEvent(event: TelemetryEvent): TelemetryEvent {
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(event.data)) {
    if (PII_KEY_BLOCKLIST.has(k.toLowerCase())) continue
    clean[k] = v
  }
  return { ...event, data: clean }
}

/** Build a redacted event with an ISO timestamp. `now` is injectable for tests. */
export function makeEvent(
  type: TelemetryEventType,
  data: Record<string, unknown>,
  now: number = Date.now(),
): TelemetryEvent {
  return redactEvent({ type, data, timestamp: new Date(now).toISOString() })
}

/** Daily-rotated JSONL filename, e.g. events-2026-06-05.jsonl. */
export function dailyFilename(date: Date = new Date()): string {
  return `events-${date.toISOString().slice(0, 10)}.jsonl`
}

/** Serialize events to JSON-Lines (one compact JSON object per line). */
export function serializeEvents(events: readonly TelemetryEvent[]): string {
  if (events.length === 0) return ''
  return events.map(e => JSON.stringify(e)).join('\n') + '\n'
}

/** Parse a JSONL blob, skipping blank/corrupt lines defensively. */
export function parseJsonl(blob: string): TelemetryEvent[] {
  const out: TelemetryEvent[] = []
  for (const line of blob.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as TelemetryEvent
      if (obj && typeof obj.type === 'string') out.push(obj)
    } catch {
      // Skip a torn line (e.g. a half-written final line after a crash).
    }
  }
  return out
}

/** Validate + normalise a feedback submission. Throws on invalid input. */
export function validateFeedback(input: Partial<FeedbackSubmission>): FeedbackSubmission {
  const type = input.type
  if (type !== 'bug' && type !== 'feature' && type !== 'other') {
    throw new Error('feedback.type must be bug | feature | other')
  }
  const title = (input.title ?? '').trim()
  if (!title) throw new Error('feedback.title is required')
  const description = (input.description ?? '').trim()
  return {
    type,
    title: title.slice(0, FEEDBACK_TITLE_MAX),
    description: description.slice(0, FEEDBACK_DESC_MAX),
  }
}

// ── Stateful runtime (disk + lifecycle) ─────────────────────────────────────

interface TelemetryState {
  baseDir: string
  telemetryDir: string
  feedbackDir: string
  configPath: string
  enabled: boolean
  queue: TelemetryEvent[]
  flushChain: Promise<void>
  flushTimer: ReturnType<typeof setInterval> | null
  sessionStart: number
}

let state: TelemetryState | null = null

function getState(): TelemetryState {
  if (!state) throw new Error('Telemetry not initialised — call initTelemetry() first')
  return state
}

interface TelemetryConfigFile {
  enabled: boolean
}

async function readEnabledFlag(configPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const cfg = JSON.parse(raw) as Partial<TelemetryConfigFile>
    return cfg.enabled === true
  } catch {
    // Missing/corrupt config → OFF. Opt-in default is the safe default.
    return false
  }
}

async function writeEnabledFlag(configPath: string, enabled: boolean): Promise<void> {
  const tmp = configPath + '.tmp'
  await fs.writeFile(tmp, JSON.stringify({ enabled } satisfies TelemetryConfigFile, null, 2), 'utf8')
  await fs.rename(tmp, configPath)
}

/**
 * Initialise telemetry against a userData directory. Idempotent-ish: a second
 * call replaces state (used only at app start in practice). Loads the opt-in
 * flag, starts the periodic flush, prunes old files, and records session start.
 */
export async function initTelemetry(userDataDir: string): Promise<void> {
  const telemetryDir = join(userDataDir, 'telemetry')
  const feedbackDir = join(userDataDir, 'feedback')
  const configPath = join(userDataDir, 'telemetry-config.json')
  const enabled = await readEnabledFlag(configPath)

  state = {
    baseDir: userDataDir,
    telemetryDir,
    feedbackDir,
    configPath,
    enabled,
    queue: [],
    flushChain: Promise.resolve(),
    flushTimer: null,
    sessionStart: Date.now(),
  }

  if (enabled) {
    state.flushTimer = setInterval(() => { void flushTelemetry() }, FLUSH_INTERVAL_MS)
    if (typeof state.flushTimer === 'object' && 'unref' in state.flushTimer) {
      (state.flushTimer as unknown as { unref: () => void }).unref()
    }
  }
  await pruneOldEvents().catch(() => {})
}

export function isTelemetryEnabled(): boolean {
  return state?.enabled ?? false
}

/** Flip the opt-in flag and persist it. Starts/stops the flush timer. */
export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  const s = getState()
  if (s.enabled === enabled) return
  s.enabled = enabled
  await writeEnabledFlag(s.configPath, enabled)
  if (enabled && !s.flushTimer) {
    s.flushTimer = setInterval(() => { void flushTelemetry() }, FLUSH_INTERVAL_MS)
  } else if (!enabled && s.flushTimer) {
    clearInterval(s.flushTimer)
    s.flushTimer = null
    s.queue = [] // drop anything queued — user just opted out
  }
}

/**
 * Record an event. No-op when telemetry is off. Non-blocking: enqueues and
 * kicks an async flush, so callers (IPC handlers, hot paths) never wait on
 * disk. Data is redacted at construction.
 */
export function capture(type: TelemetryEventType, data: Record<string, unknown>): void {
  const s = state
  if (!s || !s.enabled) return
  s.queue.push(makeEvent(type, data))
  void flushTelemetry()
}

/** Drain the queue to today's JSONL file. Serialised via a promise chain so
 *  concurrent callers can't interleave appends. */
export function flushTelemetry(): Promise<void> {
  const s = state
  if (!s) return Promise.resolve()
  s.flushChain = s.flushChain.then(async () => {
    if (s.queue.length === 0) return
    const batch = s.queue
    s.queue = []
    try {
      await fs.mkdir(s.telemetryDir, { recursive: true })
      await fs.appendFile(join(s.telemetryDir, dailyFilename()), serializeEvents(batch), 'utf8')
    } catch {
      // Re-queue on failure so we retry next flush rather than silently lose.
      s.queue.unshift(...batch)
    }
  })
  return s.flushChain
}

/** Capture the session-summary event. Call on before-quit. */
export async function recordSessionEnd(stats: { memoriesIndexed: number; filesIndexed: number }): Promise<void> {
  const s = state
  if (!s || !s.enabled) return
  const durationSec = Math.round((Date.now() - s.sessionStart) / 1000)
  capture('app_session', {
    session_start: new Date(s.sessionStart).toISOString(),
    session_duration_sec: durationSec,
    memories_indexed: stats.memoriesIndexed,
    files_indexed: stats.filesIndexed,
  })
  await flushTelemetry()
}

// ── View / export / delete ──────────────────────────────────────────────────

export async function getAllEvents(): Promise<TelemetryEvent[]> {
  const s = getState()
  // Flush pending first so the view reflects everything captured so far.
  await flushTelemetry()
  let files: string[]
  try {
    files = (await fs.readdir(s.telemetryDir)).filter(f => f.endsWith('.jsonl')).sort()
  } catch {
    return []
  }
  const all: TelemetryEvent[] = []
  for (const f of files) {
    try {
      all.push(...parseJsonl(await fs.readFile(join(s.telemetryDir, f), 'utf8')))
    } catch { /* skip unreadable file */ }
  }
  return all
}

export interface TelemetryStats {
  total: number
  byType: Record<string, number>
  earliest: string | null
  latest: string | null
}

export async function getTelemetryStats(): Promise<TelemetryStats> {
  const events = await getAllEvents()
  const byType: Record<string, number> = {}
  let earliest: string | null = null
  let latest: string | null = null
  for (const e of events) {
    byType[e.type] = (byType[e.type] ?? 0) + 1
    if (!earliest || e.timestamp < earliest) earliest = e.timestamp
    if (!latest || e.timestamp > latest) latest = e.timestamp
  }
  return { total: events.length, byType, earliest, latest }
}

/** Export everything as a single JSON document with provenance metadata. */
export async function exportEvents(meta: { appVersion: string; platform: string }): Promise<string> {
  const events = await getAllEvents()
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    appVersion: meta.appVersion,
    platform: meta.platform,
    eventCount: events.length,
    events,
  }, null, 2)
}

export async function clearAllEvents(): Promise<void> {
  const s = getState()
  s.queue = []
  try {
    const files = await fs.readdir(s.telemetryDir)
    await Promise.all(
      files.filter(f => f.endsWith('.jsonl')).map(f => fs.rm(join(s.telemetryDir, f), { force: true })),
    )
  } catch { /* nothing to clear */ }
}

/** Delete JSONL files older than RETENTION_DAYS (by date in filename). */
async function pruneOldEvents(): Promise<void> {
  const s = getState()
  let files: string[]
  try {
    files = await fs.readdir(s.telemetryDir)
  } catch {
    return
  }
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  for (const f of files) {
    const m = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)
    if (!m) continue
    if (new Date(m[1] + 'T00:00:00Z').getTime() < cutoff) {
      await fs.rm(join(s.telemetryDir, f), { force: true }).catch(() => {})
    }
  }
}

// ── Feedback ────────────────────────────────────────────────────────────────

export async function saveFeedback(input: Partial<FeedbackSubmission>): Promise<StoredFeedback> {
  const s = getState()
  const valid = validateFeedback(input)
  const stored: StoredFeedback = {
    ...valid,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  }
  await fs.mkdir(s.feedbackDir, { recursive: true })
  const filename = `feedback-${Date.now()}-${stored.id.slice(0, 8)}.json`
  const tmp = join(s.feedbackDir, filename + '.tmp')
  await fs.writeFile(tmp, JSON.stringify(stored, null, 2), 'utf8')
  await fs.rename(tmp, join(s.feedbackDir, filename))
  return stored
}

export async function getAllFeedback(): Promise<StoredFeedback[]> {
  const s = getState()
  let files: string[]
  try {
    files = (await fs.readdir(s.feedbackDir)).filter(f => f.endsWith('.json'))
  } catch {
    return []
  }
  const out: StoredFeedback[] = []
  for (const f of files) {
    try {
      out.push(JSON.parse(await fs.readFile(join(s.feedbackDir, f), 'utf8')) as StoredFeedback)
    } catch { /* skip corrupt */ }
  }
  // Newest first.
  return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
}

/** Test-only: reset module state between cases. */
export function __resetTelemetryForTest(): void {
  if (state?.flushTimer) clearInterval(state.flushTimer)
  state = null
}
