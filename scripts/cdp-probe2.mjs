// Probe layout state: are positions real? did auto-fit run? what's the lod?
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
await send('Runtime.enable')
const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const dbg = window.__cortexGraphDebug
    const pos = dbg?.positions?.() ?? []
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, zeros = 0
    for (const p of pos) {
      if (p.x === 0 && p.y === 0) zeros++
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    return JSON.stringify({
      sampled: pos.length,
      zeros,
      bounds: { minX: Math.round(minX), maxX: Math.round(maxX), minY: Math.round(minY), maxY: Math.round(maxY) },
      transform: dbg?.transform?.(),
      drawStats: window.__cortexDrawStats,
    })
  })()`,
  returnByValue: true,
})
console.log(r.result.value)
ws.close(); process.exit(0)
