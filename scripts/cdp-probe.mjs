// Quick CDP probe: what is the renderer showing right now?
const list = await (await fetch('http://127.0.0.1:9333/json')).json()
const page = list.find(t => t.type === 'page')
if (!page) { console.log('NO PAGE TARGET'); process.exit(1) }
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
  expression: `JSON.stringify({
    url: location.href,
    hasCanvas: !!document.querySelector('canvas'),
    bodyChars: document.body?.textContent?.length ?? 0,
    bodyHead: (document.body?.textContent ?? '').slice(0, 200),
    memCount: window.__cortexGraphDebug?.nodeCount?.() ?? null,
    drawStats: window.__cortexDrawStats ?? null,
  })`,
  returnByValue: true,
})
console.log(r.result.value)
ws.close(); process.exit(0)
