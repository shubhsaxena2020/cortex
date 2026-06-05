import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  hashPath, redactEvent, makeEvent, dailyFilename, serializeEvents, parseJsonl,
  validateFeedback, FEEDBACK_TITLE_MAX, FEEDBACK_DESC_MAX,
  initTelemetry, isTelemetryEnabled, setTelemetryEnabled, capture,
  flushTelemetry, getAllEvents, getTelemetryStats, exportEvents, clearAllEvents,
  recordSessionEnd, saveFeedback, getAllFeedback, __resetTelemetryForTest,
} from './telemetry'

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('hashPath', () => {
  it('produces a stable 64-char sha256 hex and never echoes the path', () => {
    const h = hashPath('C:\\Users\\someone\\secret-vault')
    expect(h).toMatch(/^[a-f0-9]{64}$/)
    expect(h).not.toContain('secret')
    expect(hashPath('C:\\Users\\someone\\secret-vault')).toBe(h) // deterministic
  })
})

describe('redactEvent', () => {
  it('strips blocklisted PII keys but keeps derived scalars', () => {
    const ev = redactEvent({
      type: 'search_executed',
      data: { query: 'my secret search', query_length: 16, result_count: 3, path: '/home/x' },
      timestamp: '2026-06-05T00:00:00.000Z',
    })
    expect(ev.data).toEqual({ query_length: 16, result_count: 3 })
    expect(ev.data.query).toBeUndefined()
    expect(ev.data.path).toBeUndefined()
  })
  it('is case-insensitive on key names', () => {
    const ev = redactEvent({ type: 'memory_created', data: { VaultPath: '/x', Email: 'a@b.c', size_bytes: 9 }, timestamp: 't' })
    expect(ev.data).toEqual({ size_bytes: 9 })
  })
})

describe('makeEvent', () => {
  it('redacts and stamps an ISO timestamp from injected now', () => {
    const ev = makeEvent('memory_deleted', { count: 2, content: 'nope' }, Date.parse('2026-06-05T12:00:00.000Z'))
    expect(ev.type).toBe('memory_deleted')
    expect(ev.data).toEqual({ count: 2 })
    expect(ev.timestamp).toBe('2026-06-05T12:00:00.000Z')
  })
})

describe('dailyFilename', () => {
  it('rotates per UTC day', () => {
    expect(dailyFilename(new Date('2026-06-05T23:59:59.000Z'))).toBe('events-2026-06-05.jsonl')
  })
})

describe('serializeEvents / parseJsonl', () => {
  it('round-trips events through JSONL', () => {
    const events = [
      makeEvent('search_executed', { query_length: 5, result_count: 1, latency_ms: 12 }, 0),
      makeEvent('graph_interaction', { action: 'zoom', zoom_level: 1.2, node_count: 40 }, 1000),
    ]
    const blob = serializeEvents(events)
    expect(blob.endsWith('\n')).toBe(true)
    expect(parseJsonl(blob)).toEqual(events)
  })
  it('skips blank and torn lines', () => {
    const blob = '{"type":"app_session","data":{},"timestamp":"t"}\n\n{bad json\n'
    const parsed = parseJsonl(blob)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].type).toBe('app_session')
  })
  it('serializes empty input to empty string', () => {
    expect(serializeEvents([])).toBe('')
  })
})

describe('validateFeedback', () => {
  it('accepts valid input and trims', () => {
    expect(validateFeedback({ type: 'bug', title: '  crash ', description: ' on launch ' }))
      .toEqual({ type: 'bug', title: 'crash', description: 'on launch' })
  })
  it('caps title and description length', () => {
    const v = validateFeedback({ type: 'other', title: 'x'.repeat(200), description: 'y'.repeat(2000) })
    expect(v.title).toHaveLength(FEEDBACK_TITLE_MAX)
    expect(v.description).toHaveLength(FEEDBACK_DESC_MAX)
  })
  it('rejects bad type and empty title', () => {
    expect(() => validateFeedback({ type: 'spam' as never, title: 'x' })).toThrow()
    expect(() => validateFeedback({ type: 'bug', title: '   ' })).toThrow()
  })
})

// ── Stateful (real temp dir) ──────────────────────────────────────────────────

describe('telemetry runtime', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'cortex-telemetry-'))
    await initTelemetry(dir)
  })
  afterEach(async () => {
    __resetTelemetryForTest()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('defaults to OFF and captures nothing until enabled', async () => {
    expect(isTelemetryEnabled()).toBe(false)
    capture('search_executed', { query_length: 3, result_count: 0, latency_ms: 1 })
    await flushTelemetry()
    expect(await getAllEvents()).toEqual([])
  })

  it('persists the opt-in flag across re-init', async () => {
    await setTelemetryEnabled(true)
    expect(isTelemetryEnabled()).toBe(true)
    __resetTelemetryForTest()
    await initTelemetry(dir)
    expect(isTelemetryEnabled()).toBe(true)
  })

  it('writes captured events to disk as JSONL when enabled', async () => {
    await setTelemetryEnabled(true)
    capture('memory_created', { source: 'claude', size_bytes: 1234 })
    capture('graph_interaction', { action: 'hover', zoom_level: 1, node_count: 10 })
    await flushTelemetry()
    const events = await getAllEvents()
    expect(events).toHaveLength(2)
    expect(events.map(e => e.type).sort()).toEqual(['graph_interaction', 'memory_created'])
  })

  it('clears all events on demand', async () => {
    await setTelemetryEnabled(true)
    capture('memory_deleted', { count: 1 })
    await flushTelemetry()
    expect((await getAllEvents()).length).toBe(1)
    await clearAllEvents()
    expect(await getAllEvents()).toEqual([])
  })

  it('captures nothing after opt-out', async () => {
    await setTelemetryEnabled(true)
    await setTelemetryEnabled(false)
    // capture() is a no-op while disabled.
    capture('memory_deleted', { count: 1 })
    await flushTelemetry()
    expect(await getAllEvents()).toEqual([])
  })

  it('summarises stats by type with a date range', async () => {
    await setTelemetryEnabled(true)
    capture('search_executed', { query_length: 1, result_count: 0, latency_ms: 1 })
    capture('search_executed', { query_length: 2, result_count: 1, latency_ms: 2 })
    capture('memory_created', { source: 'manual', size_bytes: 10 })
    await flushTelemetry()
    const stats = await getTelemetryStats()
    expect(stats.total).toBe(3)
    expect(stats.byType.search_executed).toBe(2)
    expect(stats.byType.memory_created).toBe(1)
    expect(stats.earliest).not.toBeNull()
    expect(stats.latest).not.toBeNull()
  })

  it('exports events with provenance metadata', async () => {
    await setTelemetryEnabled(true)
    capture('memory_created', { source: 'gemini', size_bytes: 5 })
    await flushTelemetry()
    const json = JSON.parse(await exportEvents({ appVersion: '0.2.0', platform: 'win32' }))
    expect(json.appVersion).toBe('0.2.0')
    expect(json.platform).toBe('win32')
    expect(json.eventCount).toBe(1)
    expect(json.events).toHaveLength(1)
  })

  it('records a session-end summary', async () => {
    await setTelemetryEnabled(true)
    await recordSessionEnd({ memoriesIndexed: 42, filesIndexed: 7 })
    const events = await getAllEvents()
    const session = events.find(e => e.type === 'app_session')
    expect(session).toBeDefined()
    expect(session!.data.memories_indexed).toBe(42)
    expect(session!.data.files_indexed).toBe(7)
    expect(typeof session!.data.session_duration_sec).toBe('number')
  })

  it('saves and lists feedback regardless of telemetry opt-in', async () => {
    // Feedback is independent of the telemetry toggle.
    const saved = await saveFeedback({ type: 'bug', title: 'broken graph', description: 'nodes vanish' })
    expect(saved.id).toBeTruthy()
    const all = await getAllFeedback()
    expect(all).toHaveLength(1)
    expect(all[0].title).toBe('broken graph')
    expect(all[0].type).toBe('bug')
  })

  it('rejects invalid feedback', async () => {
    await expect(saveFeedback({ type: 'bug', title: '' })).rejects.toThrow()
  })
})
