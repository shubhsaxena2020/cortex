// CDP profiler for the graph drag interaction.
//
// Connects to the running Electron dev instance, switches to the Graph view,
// starts Tracing with the categories DevTools uses for the Performance panel,
// simulates a 3-second drag, stops Tracing, then aggregates the events the
// same way the DevTools "Bottom-Up" tab does: total self-time per function
// name, plus the top individual long tasks.
//
// The script ALSO injects a parallel in-page profiler that measures:
//   - rAF inter-arrival deltas (proxy for actual paint cadence)
//   - draw() self-time (already exposed on window.__cortexDrawStats)
//   - longtask PerformanceObserver entries
// so we have two independent measurements that must agree.

const RAW = await (await fetch('http://127.0.0.1:9333/json')).json()
const target = RAW.find((t) => t.type === 'page')
if (!target) { console.error('no page target'); process.exit(1) }
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const events = []
let tracingDone = null
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id)
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result)
    return
  }
  if (msg.method === 'Tracing.dataCollected') {
    for (const ev of msg.params.value) events.push(ev)
  } else if (msg.method === 'Tracing.tracingComplete') {
    tracingDone?.()
  }
}
await new Promise((r) => { ws.onopen = r })
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const m = ++id; pending.set(m, { res, rej })
    ws.send(JSON.stringify({ id: m, method, params }))
  })
}
async function evalJson(expr, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise })
  return r.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.setWebLifecycleState', { state: 'active' })
await send('Emulation.setFocusEmulationEnabled', { enabled: true })

// Make sure the debug overlay is on so we can sample the new counters live.
await evalJson(`localStorage.setItem('cortex.debug.graph', '1')`)
await send('Page.reload')
await new Promise((r) => setTimeout(r, 5000))

// Switch to Graph view.
await evalJson(`(() => {
  const ev = new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true })
  window.dispatchEvent(ev); document.dispatchEvent(ev); return 1
})()`)

// Wait until the graph has actually drawn at least one frame.
for (let i = 0; i < 30; i++) {
  const stats = await evalJson(`JSON.stringify(window.__cortexDrawStats ?? null)`)
  if (stats && stats !== 'null') break
  await new Promise((r) => setTimeout(r, 1000))
}
console.log('[profile] graph ready')

// In-page parallel profiler. PerformanceObserver for long tasks; rAF deltas
// for actual paint cadence; draw() timing comes from __cortexDrawStats which
// the renderer already updates per frame.
await evalJson(`(() => {
  window.__PROFILE = { rafDeltas: [], longTasks: [], drawTimes: [] }
  if (window.__PROFILE_INSTALLED) return 1
  window.__PROFILE_INSTALLED = true

  // rAF inter-arrival
  let last = 0
  const orig = window.requestAnimationFrame
  window.requestAnimationFrame = function(cb) {
    return orig.call(window, (now) => {
      if (last) window.__PROFILE.rafDeltas.push(now - last)
      last = now
      cb(now)
    })
  }

  // Long tasks
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__PROFILE.longTasks.push({ name: e.name, start: Math.round(e.startTime), dur: Math.round(e.duration) })
      }
    }).observe({ entryTypes: ['longtask'] })
  } catch {}

  // Hook the draw self-time. __cortexDrawStats.frameMs is set every draw, but
  // we want a buffer not a single sample.
  const origDescriptor = Object.getOwnPropertyDescriptor(window, '__cortexDrawStats')
  let last_ms = 0
  setInterval(() => {
    const s = window.__cortexDrawStats
    if (s && s.frameMs !== last_ms) {
      window.__PROFILE.drawTimes.push(s.frameMs)
      last_ms = s.frameMs
    }
  }, 1)
  return 1
})()`)

// Snapshot baseline: how does idle main thread look?
await evalJson(`window.__PROFILE.rafDeltas = []; window.__PROFILE.longTasks = []; window.__PROFILE.drawTimes = []`)
await new Promise((r) => setTimeout(r, 1000))
const idle = await evalJson(`JSON.stringify({
  rafN: window.__PROFILE.rafDeltas.length,
  rafP50: window.__PROFILE.rafDeltas.sort((a,b)=>a-b)[Math.floor(window.__PROFILE.rafDeltas.length/2)] ?? null,
  rafP95: window.__PROFILE.rafDeltas.sort((a,b)=>a-b)[Math.floor(window.__PROFILE.rafDeltas.length*0.95)] ?? null,
  longN: window.__PROFILE.longTasks.length,
})`)
console.log('[profile] idle:', idle)

// Start CDP tracing.
const categories = [
  'devtools.timeline',
  'v8.execute',
  'blink',
  'blink.user_timing',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'rail',
  'loading',
]
events.length = 0
const completed = new Promise((r) => { tracingDone = r })
await send('Tracing.start', {
  transferMode: 'ReportEvents',
  categories: categories.join(','),
  options: 'sampling-frequency=10000',
})

// Reset the in-page buffers.
await evalJson(`window.__PROFILE.rafDeltas = []; window.__PROFILE.longTasks = []; window.__PROFILE.drawTimes = []`)

// Simulate a 3-second drag. Find a node first.
const dragSetup = await evalJson(`(() => {
  const dbg = window.__cortexGraphDebug
  if (!dbg) return null
  const positions = dbg.positions()
  if (!positions || positions.length === 0) return null
  // Pick a node near the centre of the cloud so the cursor stays on canvas.
  const t = dbg.transform()
  // Hit-test: find the node closest to canvas center (in screen coords).
  const canvas = document.querySelector('canvas')
  const rect = canvas.getBoundingClientRect()
  const screenCx = rect.width / 2, screenCy = rect.height / 2
  let bestI = -1, bestD = Infinity
  for (let i = 0; i < positions.length; i++) {
    const sx = positions[i].x * t.k + t.x
    const sy = positions[i].y * t.k + t.y
    const d = Math.hypot(sx - screenCx, sy - screenCy)
    if (d < bestD) { bestD = d; bestI = i }
  }
  if (bestI < 0) return null
  const sx = positions[bestI].x * t.k + t.x
  const sy = positions[bestI].y * t.k + t.y
  return JSON.stringify({ canvasLeft: rect.left, canvasTop: rect.top, startX: sx, startY: sy, transform: t })
})()`)
console.log('[profile] drag setup:', dragSetup)
if (!dragSetup) { console.error('no graph debug handle'); ws.close(); process.exit(1) }
const setup = JSON.parse(dragSetup)

// Dispatch mousedown + 180 mousemoves over 3 seconds (≈60/sec) + mouseup.
await evalJson(`(async () => {
  const canvas = document.querySelector('canvas')
  const rect = canvas.getBoundingClientRect()
  const cx = ${setup.startX} + rect.left
  const cy = ${setup.startY} + rect.top
  canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy, button: 0, buttons: 1 }))
  const t0 = performance.now()
  for (let i = 0; i < 180; i++) {
    const dx = Math.sin(i / 10) * 120
    const dy = Math.cos(i / 12) * 80
    canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx + dx, clientY: cy + dy, button: 0, buttons: 1 }))
    await new Promise(r => setTimeout(r, 16))
  }
  canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy, button: 0, buttons: 0 }))
  return Math.round(performance.now() - t0)
})()`, true)

console.log('[profile] drag complete, stopping trace…')
await send('Tracing.end')
await completed

// In-page profile during drag.
const inPage = await evalJson(`JSON.stringify({
  rafN: window.__PROFILE.rafDeltas.length,
  rafP50: (window.__PROFILE.rafDeltas.slice().sort((a,b)=>a-b)[Math.floor(window.__PROFILE.rafDeltas.length/2)] ?? null),
  rafP95: (window.__PROFILE.rafDeltas.slice().sort((a,b)=>a-b)[Math.floor(window.__PROFILE.rafDeltas.length*0.95)] ?? null),
  rafMax: (window.__PROFILE.rafDeltas.length ? Math.max(...window.__PROFILE.rafDeltas) : null),
  drawN: window.__PROFILE.drawTimes.length,
  drawP50: (window.__PROFILE.drawTimes.slice().sort((a,b)=>a-b)[Math.floor(window.__PROFILE.drawTimes.length/2)] ?? null),
  drawP95: (window.__PROFILE.drawTimes.slice().sort((a,b)=>a-b)[Math.floor(window.__PROFILE.drawTimes.length*0.95)] ?? null),
  drawMax: (window.__PROFILE.drawTimes.length ? Math.max(...window.__PROFILE.drawTimes) : null),
  longN: window.__PROFILE.longTasks.length,
  longTopK: window.__PROFILE.longTasks.slice().sort((a,b)=>b.dur-a.dur).slice(0, 10),
  longTotalMs: window.__PROFILE.longTasks.reduce((a,b)=>a+b.dur, 0),
})`)
console.log('[profile] DRAG inPage:', inPage)

// ── Trace analysis ────────────────────────────────────────────────────────────
//
// Aggregate "X" phase events (complete events with dur) by name. The DevTools
// Performance panel's "Bottom-Up" view shows total self-time per function; we
// approximate that with total dur per event name. Then the top single events
// for spikes.

const xEvents = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number')
const byName = new Map()
for (const e of xEvents) {
  const key = e.name
  const rec = byName.get(key) ?? { count: 0, total: 0, max: 0, cat: e.cat }
  rec.count++
  rec.total += e.dur
  if (e.dur > rec.max) rec.max = e.dur
  byName.set(key, rec)
}
const topByTotal = [...byName.entries()]
  .sort((a, b) => b[1].total - a[1].total)
  .slice(0, 25)
  .map(([name, r]) => ({ name, cat: r.cat, count: r.count, totalMs: Math.round(r.total / 1000), maxMs: Math.round(r.max / 100) / 10 }))

console.log('\n=== TOP 25 EVENTS BY TOTAL TIME (microseconds → ms) ===')
console.table(topByTotal)

const topSpikes = xEvents
  .filter((e) => e.dur > 4000)  // > 4ms
  .sort((a, b) => b.dur - a.dur)
  .slice(0, 20)
  .map((e) => ({ name: e.name, cat: e.cat, ms: Math.round(e.dur / 100) / 10, args: e.args && Object.keys(e.args).length < 4 ? JSON.stringify(e.args).slice(0, 100) : '…' }))

console.log('\n=== TOP 20 INDIVIDUAL SPIKES (> 4ms) ===')
console.table(topSpikes)

// Bucket frame work: events grouped by their nearest FireAnimationFrame.
const frames = xEvents.filter((e) => e.name === 'FireAnimationFrame')
const drawCalls = xEvents.filter((e) => e.name === 'FunctionCall' && e.args?.data?.functionName?.includes?.('draw'))
console.log(`\nFireAnimationFrame events: ${frames.length}`)
console.log(`FunctionCall (draw?) events: ${drawCalls.length}`)

// Long task bucket
const longInTrace = xEvents.filter((e) => e.dur > 16000)
console.log(`\nLong tasks in trace (>16ms): ${longInTrace.length}`)
console.log('Top 10 long tasks by self-duration:')
for (const e of longInTrace.sort((a, b) => b.dur - a.dur).slice(0, 10)) {
  console.log(`  ${Math.round(e.dur / 100) / 10}ms  ${e.cat}/${e.name}  ${JSON.stringify(e.args || {}).slice(0, 120)}`)
}

ws.close()
process.exit(0)
