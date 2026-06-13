// Directly invoke the memories IPC from the renderer and time it.
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
  expression: `(async () => {
    const t0 = performance.now()
    try {
      const memories = await Promise.race([
        window.electron.memories.getAll(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 30s')), 30000)),
      ])
      return JSON.stringify({ ok: true, count: memories.length, ms: Math.round(performance.now() - t0), sample: memories[0]?.title?.slice(0, 40) })
    } catch (err) {
      return JSON.stringify({ ok: false, error: String(err), ms: Math.round(performance.now() - t0) })
    }
  })()`,
  returnByValue: true,
  awaitPromise: true,
})
console.log('[ipc]', r.result.value)
ws.close(); process.exit(0)
