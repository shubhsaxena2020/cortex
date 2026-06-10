const list = await (await fetch('http://127.0.0.1:9333/json')).json()
const page = list.find(t => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((res, rej) => { const m = ++id; pending.set(m, {res, rej}); ws.send(JSON.stringify({id: m, method, params})) })
}
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result) }
}
await new Promise(r => { ws.onopen = r })
await send('Runtime.enable'); await send('Page.enable')
await send('Page.setWebLifecycleState', { state: 'active' })
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
async function evalJson(expr, await_ = false) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: await_ })
  return r.result.value
}
// 1. API surface
console.log('[final] data API exposed:', await evalJson(`typeof window.electron.data?.exportMemories === 'function'`))
// 2. relationships carry signal types
console.log('[final] first rel:', await evalJson(`window.electron.relationships.getAll().then(r => JSON.stringify({ n: r.length, sig: r[0]?.signal_type, str: r[0]?.strength }))`, true))
// 3. graph view renders
await evalJson(`(() => { const ev = new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true }); window.dispatchEvent(ev); document.dispatchEvent(ev); return 1 })()`)
await new Promise(r => setTimeout(r, 6000))
console.log('[final] graph state:', await evalJson(`(() => { const d = window.__cortexGraphDebug; return d ? JSON.stringify({ n: d.nodeCount(), l: d.linkCount(), k: +d.transform().k.toFixed(3) }) : 'no debug' })()`))
const px = await evalJson(`(() => {
  const c = document.querySelector('canvas')
  if (!c) return 'no canvas'
  const img = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let lit = 0
  for (let i = 0; i < img.length; i += 16) if (img[i]+img[i+1]+img[i+2] > 90) lit++
  return JSON.stringify({ litSamples: lit })
})()`)
console.log('[final] canvas:', px)
const dataUrl = await evalJson(`document.querySelector('canvas').toDataURL('image/png')`)
const fs = await import('fs')
fs.writeFileSync('C:/Users/shubh/cortex/scripts/graph-final.png', Buffer.from(dataUrl.split(',')[1], 'base64'))
console.log('[final] png saved')
ws.close(); process.exit(0)
