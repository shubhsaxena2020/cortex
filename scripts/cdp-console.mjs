// Capture renderer console + uncaught exceptions across a reload.
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
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id)
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const args = (msg.params.args ?? []).map(a => a.value ?? a.description ?? a.type).join(' ')
    console.log(`[console.${msg.params.type}]`, args.slice(0, 400))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    console.log('[EXCEPTION]', d.text, d.exception?.description?.slice(0, 600) ?? '')
  }
}
await new Promise(r => { ws.onopen = r })
await send('Runtime.enable'); await send('Page.enable')
await send('Page.setWebLifecycleState', { state: 'active' })
await send('Page.reload')
await new Promise(r => setTimeout(r, 20000))
// switch to graph view
await send('Runtime.evaluate', { expression: `(() => { const ev = new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true }); window.dispatchEvent(ev); document.dispatchEvent(ev); return 1 })()`, returnByValue: true })
await new Promise(r => setTimeout(r, 25000))
const r = await send('Runtime.evaluate', { expression: `JSON.stringify({ stats: window.__cortexDrawStats ?? null, dbg: !!window.__cortexGraphDebug })`, returnByValue: true })
console.log('[final]', r.result.value)
ws.close(); process.exit(0)
