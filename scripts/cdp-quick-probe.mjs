// Quick CDP probe to see what the Sigma renderer is actually doing.
const list = await (await fetch('http://127.0.0.1:9333/json')).json()
const target = list.find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((res, rej) => { const m = ++id; pending.set(m, { res, rej }); ws.send(JSON.stringify({ id: m, method, params })) })
}
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result) }
}
await new Promise((r) => { ws.onopen = r })
await send('Runtime.enable')

// Switch to graph view
await send('Runtime.evaluate', { expression: `(() => { const ev = new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true }); window.dispatchEvent(ev); document.dispatchEvent(ev); return 1 })()`, returnByValue: true })
await new Promise((r) => setTimeout(r, 8000))

const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    canvas: !!document.querySelector('canvas'),
    sigmaContainer: !!document.querySelector('.sigma-container'),
    dbg: !!window.__cortexGraphDebug,
    nodeCount: window.__cortexGraphDebug?.nodeCount?.() ?? null,
    linkCount: window.__cortexGraphDebug?.linkCount?.() ?? null,
    posSample: window.__cortexGraphDebug?.positions?.()?.slice(0, 3) ?? null,
    drawStats: window.__cortexDrawStats ?? null,
    bodySnippet: (document.body.textContent ?? '').slice(0, 200),
  })`,
  returnByValue: true,
})
console.log(r.result.value)
ws.close(); process.exit(0)
