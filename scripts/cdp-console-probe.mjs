// Capture renderer console + exceptions for a few seconds across reload.
const list = await (await fetch('http://127.0.0.1:9333/json')).json()
const target = list.find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
function send(method, params = {}) { return new Promise((res, rej) => { const m = ++id; pending.set(m, { res, rej }); ws.send(JSON.stringify({ id: m, method, params })) }) }
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); return }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const t = msg.params.type
    const args = (msg.params.args ?? []).map(a => a.value ?? a.description ?? a.type).join(' ')
    if (t === 'error' || t === 'warning' || (args.includes('cortex') || args.includes('Sigma') || args.includes('FA2'))) {
      console.log(`[${t}]`, args.slice(0, 300))
    }
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    console.log('[EXC]', d.text, d.exception?.description?.slice(0, 400) ?? '')
  }
}
await new Promise(r => { ws.onopen = r })
await send('Runtime.enable'); await send('Page.enable')
await send('Page.reload')
await new Promise(r => setTimeout(r, 6000))
await send('Runtime.evaluate', { expression: `(() => { const ev = new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true }); window.dispatchEvent(ev); document.dispatchEvent(ev); return 1 })()`, returnByValue: true })
await new Promise(r => setTimeout(r, 8000))
// Test synthetic mousedown reaches Sigma
const r = await send('Runtime.evaluate', {
  expression: `(() => {
    window.__DOWN_FIRED = 0
    const pick = window.__cortexGraphDebug?.pickCenterNode?.()
    if (!pick) return 'no pick'
    const canvas = document.querySelector('canvas')
    const rect = canvas.getBoundingClientRect()
    const cx = pick.vpX + rect.left, cy = pick.vpY + rect.top
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy, button: 0, buttons: 1 }))
    return JSON.stringify({
      pickedNode: pick.id.slice(0, 12),
      vp: { x: pick.vpX, y: pick.vpY },
      fa2StillRef: !!(window.__cortexGraphDebug?.fa2Status?.()) ?? null,
    })
  })()`,
  returnByValue: true,
})
console.log('[probe]', r.result.value)
await new Promise(r => setTimeout(r, 500))
ws.close(); process.exit(0)
