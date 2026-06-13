// Patient FPS harness for large graphs: waits for the graph to actually be
// drawing (readiness poll) before measuring, then samples far / pan / medium.
const list = await (await fetch('http://127.0.0.1:9333/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((res, rej) => { const m = ++id; pending.set(m, { res, rej }); ws.send(JSON.stringify({ id: m, method, params })) })
}
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result) }
}
await new Promise(r => { ws.onopen = r })
await send('Runtime.enable'); await send('Page.enable')
await send('Page.setWebLifecycleState', { state: 'active' })
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
async function evalJson(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r.result.value
}

await evalJson(`localStorage.setItem('cortex.debug.graph', '1')`)
await send('Page.reload')
await new Promise(r => setTimeout(r, 4000))
await send('Page.setWebLifecycleState', { state: 'active' })

// Open graph view, then poll until draw stats appear (graph effect at 125k
// blocks the main thread for a while — fixed waits undershoot).
await evalJson(`(() => { const ev = new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true }); window.dispatchEvent(ev); document.dispatchEvent(ev); return 1 })()`)
const t0 = Date.now()
let ready = false
for (let i = 0; i < 120; i++) {
  const stats = await evalJson(`JSON.stringify(window.__cortexDrawStats ?? null)`)
  if (stats && stats !== 'null') { ready = true; break }
  await new Promise(r => setTimeout(r, 1000))
}
console.log(`[fps2] graph first draw after ${(Date.now() - t0) / 1000}s (ready=${ready})`)
if (!ready) { ws.close(); process.exit(1) }

// Let the layout settle + cache warm.
await new Promise(r => setTimeout(r, 12000))

async function measure(label, jiggleExpr) {
  await evalJson(jiggleExpr)
  await new Promise(r => setTimeout(r, 3000))
  const out = await evalJson(`(() => {
    clearInterval(window.__jig)
    const el = [...document.querySelectorAll('div')].find(d => /fps/i.test(d.textContent ?? '') && (d.textContent ?? '').length < 200)
    return JSON.stringify({ label: '${label}', overlay: el?.textContent ?? 'n/a', stats: window.__cortexDrawStats })
  })()`)
  console.log('[fps2]', out)
}

const wheelJiggle = `(() => {
  const c = document.querySelector('canvas')
  const r = c.getBoundingClientRect()
  let i = 0
  window.__jig = setInterval(() => {
    c.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + r.width/2, clientY: r.top + r.height/2, deltaY: (i++ % 2 === 0 ? -1 : 1), bubbles: true, cancelable: true }))
  }, 16)
  return 1
})()`

// 1. Far view (auto-fit), zoom jiggle.
await measure('far/fit zoom-jiggle', wheelJiggle)

// 2. Pan at far view: drag the canvas background.
await measure('far/fit pan', `(() => {
  const c = document.querySelector('canvas')
  const r = c.getBoundingClientRect()
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2
  let i = 0
  c.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, buttons: 1, bubbles: true }))
  window.__jig = setInterval(() => {
    const dx = Math.sin(i / 10) * 200
    c.dispatchEvent(new MouseEvent('mousemove', { clientX: cx + dx, clientY: cy, buttons: 1, bubbles: true }))
    i++
  }, 16)
  return 1
})()`)
await evalJson(`(() => { const c = document.querySelector('canvas'); c.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return 1 })()`)

// 3. Zoom in to medium/close and jiggle there.
await evalJson(`(() => {
  const c = document.querySelector('canvas')
  const r = c.getBoundingClientRect()
  for (let i = 0; i < 14; i++) c.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + r.width/2, clientY: r.top + r.height/2, deltaY: -120, bubbles: true, cancelable: true }))
  return 1
})()`)
await new Promise(r => setTimeout(r, 1000))
await measure('zoomed-in jiggle (settling)', wheelJiggle)

// 4. Wait for the simulation to fully settle, then measure steady state.
console.log('[fps2] waiting 60s for settle…')
await new Promise(r => setTimeout(r, 60000))
await measure('zoomed-in jiggle (settled)', wheelJiggle)
await evalJson(`(() => {
  const c = document.querySelector('canvas')
  const r = c.getBoundingClientRect()
  for (let i = 0; i < 14; i++) c.dispatchEvent(new WheelEvent('wheel', { clientX: r.left + r.width/2, clientY: r.top + r.height/2, deltaY: 120, bubbles: true, cancelable: true }))
  return 1
})()`)
await new Promise(r => setTimeout(r, 1000))
await measure('far/fit jiggle (settled)', wheelJiggle)

ws.close(); process.exit(0)
