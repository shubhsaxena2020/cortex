// CDP profiler for Sigma.js + ForceAtlas2 drag interaction.
//
// Same skeleton as cdp-profile-drag.mjs, but uses the Sigma-aware helpers
// on __cortexGraphDebug (graphToViewport, pickCenterNode) instead of the
// Canvas2D camera math, and runs a 5-second drag per the v0.6 spec.

const RAW = await (await fetch('http://127.0.0.1:9333/json')).json()
const target = RAW.find((t) => t.type === 'page')
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

await evalJson(`localStorage.setItem('cortex.debug.graph', '1')`)
await send('Page.reload')
await new Promise((r) => setTimeout(r, 5000))

await evalJson(`(() => {
  const ev = new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true })
  window.dispatchEvent(ev); document.dispatchEvent(ev); return 1
})()`)

// Wait until Sigma has rendered at least one frame AND has nodes loaded.
for (let i = 0; i < 30; i++) {
  const ready = await evalJson(`JSON.stringify({
    drawn: window.__cortexDrawStats?.frame ?? 0,
    nodes: window.__cortexGraphDebug?.nodeCount?.() ?? 0,
  })`)
  if (ready) {
    const r = JSON.parse(ready)
    if (r.drawn > 0 && r.nodes > 0) {
      console.log('[profile] graph ready —', ready)
      break
    }
  }
  await new Promise((r) => setTimeout(r, 1000))
}

// In-page profiler (same shape as the v0.5 drag fix script).
await evalJson(`(() => {
  window.__PROFILE = { rafDeltas: [], longTasks: [], drawTimes: [] }
  if (window.__PROFILE_INSTALLED) return 1
  window.__PROFILE_INSTALLED = true
  let last = 0
  const orig = window.requestAnimationFrame
  window.requestAnimationFrame = function(cb) {
    return orig.call(window, (now) => {
      if (last) window.__PROFILE.rafDeltas.push(now - last)
      last = now
      cb(now)
    })
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__PROFILE.longTasks.push({ name: e.name, dur: Math.round(e.duration) })
      }
    }).observe({ entryTypes: ['longtask'] })
  } catch {}
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

// Baseline (idle).
await evalJson(`window.__PROFILE.rafDeltas = []; window.__PROFILE.longTasks = []; window.__PROFILE.drawTimes = []`)
await new Promise((r) => setTimeout(r, 1500))
const idle = await evalJson(`JSON.stringify({
  rafN: window.__PROFILE.rafDeltas.length,
  rafP50: window.__PROFILE.rafDeltas.slice().sort((a,b)=>a-b)[Math.floor(window.__PROFILE.rafDeltas.length/2)] ?? null,
  longN: window.__PROFILE.longTasks.length,
})`)
console.log('[profile] idle:', idle)

// Pick a node near the centre of the screen.
const pick = await evalJson(`JSON.stringify(window.__cortexGraphDebug.pickCenterNode())`)
const node = JSON.parse(pick ?? 'null')
if (!node) { console.error('no node picked'); ws.close(); process.exit(1) }
console.log('[profile] dragging node', node.id.slice(0, 12), 'starting at viewport', node.vpX.toFixed(0), node.vpY.toFixed(0))

// Tracing on.
const categories = [
  'devtools.timeline', 'v8.execute', 'blink', 'blink.user_timing',
  'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'rail', 'loading',
]
events.length = 0
const completed = new Promise((r) => { tracingDone = r })
await send('Tracing.start', {
  transferMode: 'ReportEvents',
  categories: categories.join(','),
})

// Reset in-page buffers post tracing-start so they only cover the drag.
await evalJson(`window.__PROFILE.rafDeltas = []; window.__PROFILE.longTasks = []; window.__PROFILE.drawTimes = []`)

// Reset handler counters before the real drag.
await evalJson(`window.__DOWN_FIRED = 0; window.__MOVE_FIRED = 0`)

// 5-second drag via CDP's Input.dispatchMouseEvent — these are REAL Chromium
// input events (same code path the user's mouse uses), so Sigma's internal
// document-level mousemove listener picks them up. Synthetic
// `new MouseEvent` only bubbles to React/DOM listeners; Sigma's captor uses
// addEventListener at a lower level that synthetic events miss.
const containerOffset = await evalJson(`(() => {
  const c = document.querySelector('.sigma-container')
  const r = c.getBoundingClientRect()
  return JSON.stringify({ left: r.left, top: r.top })
})()`)
const off = JSON.parse(containerOffset)
const cx = Math.round(node.vpX + off.left)
const cy = Math.round(node.vpY + off.top)

await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, buttons: 1 })
const startMs = Date.now()
for (let i = 0; i < 300; i++) {
  const dx = Math.sin(i / 15) * 140
  const dy = Math.cos(i / 17) * 90
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(cx + dx), y: Math.round(cy + dy), button: 'left', buttons: 1 })
  await new Promise((r) => setTimeout(r, 16))
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0 })
console.log(`[profile] drag dispatched in ${Date.now() - startMs}ms`)

console.log('[profile] drag complete; stopping trace…')
await send('Tracing.end')
await completed

const handlers = await evalJson(`JSON.stringify({
  downFired: window.__DOWN_FIRED ?? 0,
  moveFired: window.__MOVE_FIRED ?? 0,
})`)
console.log('[profile] Sigma handlers fired:', handlers)

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
})`)
console.log('[profile] DRAG inPage:', inPage)

// Trace aggregation.
const xEvents = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number')
const byName = new Map()
for (const e of xEvents) {
  const k = e.name
  const r = byName.get(k) ?? { count: 0, total: 0, max: 0 }
  r.count++; r.total += e.dur; if (e.dur > r.max) r.max = e.dur
  byName.set(k, r)
}
const top = [...byName.entries()]
  .sort((a, b) => b[1].total - a[1].total)
  .slice(0, 15)
  .map(([name, r]) => ({ name, count: r.count, totalMs: Math.round(r.total / 1000), maxMs: Math.round(r.max / 100) / 10 }))
console.log('\n=== TOP 15 EVENTS BY TOTAL TIME ===')
console.table(top)
const longInTrace = xEvents.filter((e) => e.dur > 16000)
console.log(`\nLong tasks in trace (>16ms): ${longInTrace.length}`)

ws.close(); process.exit(0)
