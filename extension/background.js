// Cortex — service worker
//
// Owns: context menu registration, app-discovery loop, message bridge for popup.
// Storage keys: extension-token, app-port, app-status, app-last-checked.

const PORT_RANGE_START = 48729
const PORT_RANGE_END = 48739
const PROBE_TIMEOUT_MS = 5000
const DISCOVERY_ALARM = 'cortex-discovery'
const CONTEXT_MENU_ID = 'save-to-cortex'

const K = {
  token: 'extension-token',
  port: 'app-port',
  status: 'app-status',           // 'connected' | 'not-running'
  lastChecked: 'app-last-checked',
  pairingState: 'pairing-state',  // 'idle' | 'pairing' | 'paired' | 'timeout' | 'error'
  paired: 'extension-paired'      // true once successfully paired
}

const PAIR_POLL_INTERVAL_MS = 2000
const PAIR_POLL_DEADLINE_MS = 5 * 60 * 1000  // generous 5-min poll window — app's own 60s arming window is the security boundary
let pairingInFlight = false

// ── Lifecycle ────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  // removeAll first so reinstall/update doesn't trip a duplicate-ID error.
  await chrome.contextMenus.removeAll()
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: 'Save to Cortex',
    contexts: ['selection']
  })
  await chrome.alarms.create(DISCOVERY_ALARM, { periodInMinutes: 0.5 })
  await discover()
})

chrome.runtime.onStartup.addListener(async () => {
  console.log('[cortex] SW startup — reading credentials from storage')
  const startupStored = await chrome.storage.local.get([K.token, K.paired, K.port])
  console.log('[cortex] Startup storage read:', JSON.stringify(startupStored))
  await chrome.alarms.create(DISCOVERY_ALARM, { periodInMinutes: 0.5 })
  await discover()
  await verifyPairedCredentials()
})

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === DISCOVERY_ALARM) await discover()
})

// ── Context menu: save selection to /api/memories ───────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return
  const selection = (info.selectionText || '').trim()
  if (!selection) return
  await saveSelection(selection, tab)
})

async function saveSelection(selection, tab) {
  const { [K.token]: token, [K.port]: port, [K.status]: status } =
    await chrome.storage.local.get([K.token, K.port, K.status])

  if (!token) {
    setBadge('?', '#f59e0b') // pair needed
    return
  }

  let activePort = port
  if (!activePort || status !== 'connected') {
    await discover()
    const fresh = await chrome.storage.local.get([K.port, K.status])
    if (!fresh[K.port] || fresh[K.status] !== 'connected') {
      setBadge('✗', '#ef4444') // app not running
      return
    }
    activePort = fresh[K.port]
  }

  const source = detectSource(tab && tab.url)
  const pageTitle = (tab && tab.title) || ''
  const pageUrl = (tab && tab.url) || ''

  const content = pageUrl
    ? `${selection}\n\n> ${pageTitle}\n> ${pageUrl}`
    : selection

  const body = {
    title: deriveTitle(selection),
    content,
    source,
    url: pageUrl || undefined,
    tags: [],
  }

  try {
    const r = await fetch(`http://127.0.0.1:${activePort}/api/memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(body)
    })
    if (r.ok)                  setBadge('✓', '#10a37f')
    else if (r.status === 401) setBadge('!', '#f59e0b') // re-pair
    else                       setBadge('✗', '#ef4444')
  } catch (_) {
    setBadge('✗', '#ef4444')
  }
}

function detectSource(url) {
  if (!url) return 'manual'
  try {
    const h = new URL(url).hostname.toLowerCase()
    if (h === 'claude.ai'       || h.endsWith('.claude.ai'))     return 'claude'
    if (h === 'chatgpt.com'     || h.endsWith('.chatgpt.com')
                                || h === 'chat.openai.com')      return 'chatgpt'
    if (h === 'gemini.google.com')                               return 'gemini'
  } catch (_) { /* malformed url */ }
  return 'manual'
}

function deriveTitle(text) {
  const firstLine = text.trim().split(/\r?\n/)[0].trim()
  if (!firstLine) return 'Untitled'
  if (firstLine.length <= 60) return firstLine
  return firstLine.slice(0, 57).trimEnd() + '…'
}

// Badge feedback — visible on the extension icon for ~3 seconds.
// MV3 SWs are alive for ~30s after activity, so setTimeout is reliable here.
let badgeClearTimer = null
function setBadge(text, color) {
  if (badgeClearTimer) clearTimeout(badgeClearTimer)
  chrome.action.setBadgeText({ text })
  chrome.action.setBadgeBackgroundColor({ color })
  badgeClearTimer = setTimeout(() => {
    chrome.action.setBadgeText({ text: '' })
    badgeClearTimer = null
  }, 3000)
}

// ── Message bridge: popup can request immediate re-discovery (e.g. after Pair) ──

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false

  if (msg.type === 'discover') {
    discover().then(async () => {
      const s = await chrome.storage.local.get([K.port, K.status])
      sendResponse({ port: s[K.port] ?? null, status: s[K.status] ?? 'not-running' })
    })
    return true
  }

  if (msg.type === 'start-pairing') {
    // Fire-and-forget: the actual polling runs in the SW and the popup
    // observes progress via chrome.storage.onChanged on K.pairingState.
    startPairing().catch(err => console.error('[cortex] pairing crashed:', err))
    sendResponse({ ok: true })
    return false
  }

  if (msg.type === 'cancel-pairing') {
    pairingInFlight = false
    chrome.storage.local.set({ [K.pairingState]: 'idle' })
    sendResponse({ ok: true })
    return false
  }

  return false
})

// ── Click-to-pair polling (runs in SW so it survives popup close) ───────────

async function startPairing() {
  if (pairingInFlight) return
  pairingInFlight = true
  await chrome.storage.local.set({ [K.pairingState]: 'pairing' })

  // Make sure we know where the app is.
  let port = (await chrome.storage.local.get([K.port]))[K.port]
  if (!port) {
    await discover()
    port = (await chrome.storage.local.get([K.port]))[K.port]
    if (!port) {
      await chrome.storage.local.set({ [K.pairingState]: 'error' })
      pairingInFlight = false
      return
    }
  }

  const deadline = Date.now() + PAIR_POLL_DEADLINE_MS

  while (pairingInFlight && Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/pair`)
      if (r.ok) {
        const body = await r.json().catch(() => null)
        if (body && typeof body.token === 'string' && /^[0-9a-f]{64}$/i.test(body.token)) {
          console.log('[cortex] Pair succeeded — saving credentials: token length', body.token.length, 'port', port)
          await chrome.storage.local.set({
            [K.token]: body.token,
            [K.paired]: true,
            [K.pairingState]: 'paired'
          })
          const verify = await chrome.storage.local.get([K.token, K.paired, K.pairingState])
          console.log('[cortex] Storage after pair save:', JSON.stringify(verify))
          pairingInFlight = false
          return
        }
      }
      // 403 (PAIRING_NOT_ARMED) → keep waiting silently
    } catch (_) {
      // app probably went down; keep trying — it might come back
    }
    await sleep(PAIR_POLL_INTERVAL_MS)
  }

  if (pairingInFlight) {
    await chrome.storage.local.set({ [K.pairingState]: 'timeout' })
  }
  pairingInFlight = false
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Credential verification on startup ───────────────────────────────────────

async function verifyPairedCredentials() {
  const stored = await chrome.storage.local.get([K.token, K.port, K.paired])
  const token = stored[K.token]
  const port = stored[K.port]
  if (!token || !stored[K.paired]) return  // not paired, nothing to verify

  if (!port) return  // no known port yet; discovery will run separately

  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(4000)
    })
    if (r.status === 401) {
      // Token rejected — clear paired state so popup shows re-pair UI
      await chrome.storage.local.remove([K.paired, K.token])
    }
    // 200 = healthy and paired; network error = app not running but stay paired
  } catch (_) {
    // App not running — keep paired=true so popup shows "start app" instead of re-pair
  }
}

// ── Discovery ────────────────────────────────────────────────────────────────

async function probe(port, signal) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal })
    if (!r.ok) return null
    const body = await r.json()
    return body && body.app === 'cortex' ? port : null
  } catch (_) {
    return null
  }
}

async function discover() {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)

  // Try the previously known port first (sticky), then the rest of the range in parallel.
  const stored = await chrome.storage.local.get([K.port])
  const sticky = stored[K.port]
  const ports = []
  if (sticky) ports.push(sticky)
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (p !== sticky) ports.push(p)
  }

  let found = null
  await Promise.all(ports.map(async (p) => {
    if (found) return
    const ok = await probe(p, ctrl.signal)
    if (ok && !found) found = ok
  }))

  clearTimeout(timer)

  const now = Date.now()
  if (found) {
    await chrome.storage.local.set({
      [K.port]: found,
      [K.status]: 'connected',
      [K.lastChecked]: now
    })
  } else {
    await chrome.storage.local.set({
      [K.status]: 'not-running',
      [K.lastChecked]: now
    })
  }
}
