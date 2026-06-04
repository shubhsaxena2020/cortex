// Cortex — popup

const K = {
  token: 'extension-token',
  port: 'app-port',
  status: 'app-status',
  pairingState: 'pairing-state',
  paired: 'extension-paired',        // true once successfully paired; cleared only on 401 or Disconnect
  cachedResults: 'cached-results',
  cachedQuery: 'cached-query'
}

const SEARCH_DEBOUNCE_MS = 300
const TOAST_MS = 2500
const TOKEN_REGEX = /^[0-9a-f]{64}$/i

const $ = (id) => document.getElementById(id)
const searchInput    = $('search-input')
const resultsEl      = $('results')
const settingsPanel  = $('settings-panel')
const settingsToggle = $('settings-toggle')
const tokenInput     = $('token-input')
const pairBtn        = $('pair-btn')
const connectBtn     = $('connect-btn')
const connectHint    = $('connect-hint')
const statusEl       = $('status')
const toastEl        = $('toast')
const saveChatWrap   = $('save-chat-wrap')
const saveChatBtn    = $('save-chat-btn')
const saveChatIcon   = $('save-chat-icon')
const saveChatLabel  = $('save-chat-label')
const disconnectBtn  = $('disconnect-btn')

let inflight = null
let debounceTimer = null
let toastTimer = null
let existingChatInfo = null  // { exists, path, messageCount } from check-url

init().catch(err => showStatus('err', `Init failed: ${err.message || err}`))

// ── Boot ────────────────────────────────────────────────────────────────────

async function init() {
  wireEvents()

  // Read with explicit literal key names to avoid any constant mismatch
  console.log('[cortex popup] Opening — reading storage')
  const stored = await chrome.storage.local.get([
    'extension-paired',
    'extension-token',
    'pairing-state',
    'app-port',
    'app-status'
  ])
  console.log('[cortex popup] Storage read:', JSON.stringify({
    paired:       stored['extension-paired'],
    hasToken:     !!stored['extension-token'],
    tokenLength:  stored['extension-token'] ? stored['extension-token'].length : 0,
    pairingState: stored['pairing-state'],
    port:         stored['app-port'],
    status:       stored['app-status']
  }))

  const isPaired     = stored['extension-paired'] === true
  const token        = stored['extension-token']   || null
  const pairingState = stored['pairing-state']     || 'idle'
  const port         = stored['app-port']           || null
  const status       = stored['app-status']         || null

  await restoreCachedResults()

  // Pairing handshake in progress
  if (pairingState === 'pairing') {
    settingsPanel.hidden = false
    showConnectingUI()
    return
  }

  // ── Already paired ────────────────────────────────────────────────────────
  if (isPaired && token) {
    console.log('[cortex popup] Already paired — showing connected state immediately')
    hideStatus()
    settingsPanel.hidden = true
    if (disconnectBtn) disconnectBtn.hidden = false

    // Silent /health check — non-blocking, never forces re-pair on network failure
    verifyConnection(token, port).then(ok => {
      if (!ok) {
        // App offline but we stay paired — user just needs to start the app
        showStatus('warn', 'App not running — start Cortex')
      }
    })

    await maybeShowSaveChatButton()
    await runSearch('')
    searchInput.focus()
    return
  }

  // ── Not yet paired ────────────────────────────────────────────────────────
  console.log('[cortex popup] Not paired — showing connect UI')
  if (!token) {
    showStatus('warn', 'Not paired — click Connect to App below')
    settingsPanel.hidden = false
    return
  }
  if (!port || status !== 'connected') {
    showStatus('warn', 'Looking for Cortex app…')
    const updated = await requestDiscovery()
    if (!updated.port || updated.status !== 'connected') {
      showStatus('err', 'App not running — start Cortex')
      return
    }
  }

  hideStatus()
  await maybeShowSaveChatButton()
  await runSearch('')
  searchInput.focus()
}

async function verifyConnection(token, port) {
  if (!port) {
    const disc = await requestDiscovery()
    if (!disc.port || disc.status !== 'connected') return false
    port = disc.port
  }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(4000)
    })
    if (r.status === 401) {
      // Token explicitly rejected by the app — must re-pair
      await chrome.storage.local.remove(['extension-paired', 'extension-token'])
      showStatus('err', 'Token rejected — please re-pair')
      settingsPanel.hidden = false
      if (disconnectBtn) disconnectBtn.hidden = true
      return false
    }
    return r.ok
  } catch {
    // Network error / app offline — stay paired, caller shows soft warning
    return false
  }
}

function wireEvents() {
  settingsToggle.addEventListener('click', () => {
    settingsPanel.hidden = !settingsPanel.hidden
    if (!settingsPanel.hidden) tokenInput.focus()
    else searchInput.focus()
  })

  connectBtn.addEventListener('click', () => void handleConnect())

  pairBtn.addEventListener('click', () => void handlePair())
  tokenInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); void handlePair() }
  })

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => void runSearch(searchInput.value), SEARCH_DEBOUNCE_MS)
  })

  saveChatBtn.addEventListener('click', () => void handleSaveChat())

  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', () => void handleDisconnect())
  }
}

async function handleDisconnect() {
  await chrome.storage.local.remove([K.paired, K.token, K.port, K.status])
  existingChatInfo = null
  saveChatWrap.hidden = true
  settingsPanel.hidden = false
  if (disconnectBtn) disconnectBtn.hidden = true
  restoreConnectButton()
  showStatus('warn', 'Disconnected — pair again to reconnect')
  tokenInput.focus()
}

// ── Click-to-pair flow ──────────────────────────────────────────────────────

async function handleConnect() {
  showConnectingUI()
  try {
    await sendMessage({ type: 'start-pairing' })
  } catch (e) {
    restoreConnectButton()
    showStatus('err', "Can't reach background worker — try reloading the extension")
  }
}

function showConnectingUI() {
  connectBtn.disabled = true
  connectBtn.textContent = 'Waiting for app… (click Pair Extension in app)'
  hideStatus()
}

function restoreConnectButton() {
  connectBtn.disabled = false
  connectBtn.textContent = 'Connect to App'
}

function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else resolve(resp)
    })
  })
}

// React to pairing-state writes coming from the service worker.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes[K.pairingState]) return
  const next = changes[K.pairingState].newValue
  if (next === 'paired') {
    await chrome.storage.local.set({ [K.pairingState]: 'idle', [K.paired]: true })
    settingsPanel.hidden = true
    if (disconnectBtn) disconnectBtn.hidden = false
    hideStatus()
    restoreConnectButton()
    showToast('ok', 'Paired ✓')
    await maybeShowSaveChatButton()
    await runSearch('')
    searchInput.focus()
  } else if (next === 'timeout') {
    await chrome.storage.local.set({ [K.pairingState]: 'idle' })
    restoreConnectButton()
    showStatus('warn', "Timed out — click 'Pair Extension' in the app and try again")
  } else if (next === 'error') {
    await chrome.storage.local.set({ [K.pairingState]: 'idle' })
    restoreConnectButton()
    showStatus('err', "Can't reach app — is it running?")
  } else if (next === 'pairing') {
    showConnectingUI()
  }
})

// ── Manual paste pair flow ──────────────────────────────────────────────────

async function handlePair() {
  const candidate = tokenInput.value.trim()
  if (!TOKEN_REGEX.test(candidate)) {
    showStatus('err', 'Token must be 64 hex characters')
    return
  }

  let port = await getStored(K.port)
  if (!port) {
    showStatus('warn', 'Looking for Cortex app…')
    const updated = await requestDiscovery()
    port = updated.port
    if (!port) { showStatus('err', "Can't reach app — is it running?"); return }
  }

  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/recent?limit=1`, {
      headers: { 'Authorization': `Bearer ${candidate}` }
    })
    if (r.status === 401) {
      const code = await readErrorCode(r)
      if (code === 'INVALID_TOKEN')   { showStatus('err', 'Invalid token'); return }
      if (code === 'INVALID_ORIGIN')  { showStatus('err', 'Origin rejected — server too strict'); return }
      if (code === 'MISSING_TOKEN')   { showStatus('err', 'Token not sent'); return }
      showStatus('err', `Unauthorized (${code || 'unknown'})`)
      return
    }
    if (!r.ok) { showStatus('err', `Pair failed (HTTP ${r.status})`); return }
  } catch (_) {
    showStatus('err', "Can't reach app")
    return
  }

  await chrome.storage.local.set({ [K.token]: candidate, [K.paired]: true })
  tokenInput.value = ''
  settingsPanel.hidden = true
  if (disconnectBtn) disconnectBtn.hidden = false
  hideStatus()
  showToast('ok', 'Paired ✓')
  await runSearch('')
  searchInput.focus()
}

// ── Search ──────────────────────────────────────────────────────────────────

async function runSearch(query) {
  query = (query || '').trim()

  const stored = await chrome.storage.local.get([K.token, K.port])
  const token = stored[K.token]
  const port  = stored[K.port]
  if (!token) { showStatus('err', 'Not paired'); return }
  if (!port)  { showStatus('err', 'App not running'); return }

  if (inflight) inflight.abort()
  inflight = new AbortController()

  const url = query
    ? `http://127.0.0.1:${port}/api/search?q=${encodeURIComponent(query)}`
    : `http://127.0.0.1:${port}/api/recent?limit=10`

  try {
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: inflight.signal
    })
    if (r.status === 401) {
      // 401 = invalid token; clear paired state
      await chrome.storage.local.remove([K.paired])
      showStatus('err', 'Token rejected — re-pair')
      return
    }
    if (!r.ok) { showStatus('err', `Search failed (${r.status})`); return }

    let body
    try { body = await r.json() }
    catch { showStatus('err', 'Bad response from app'); return }

    const results = Array.isArray(body.results) ? body.results : []
    hideStatus()
    renderResults(results, query)
    await cacheResults(results, query)
  } catch (e) {
    if (e.name === 'AbortError') return
    showStatus('err', "Can't reach app")
  } finally {
    inflight = null
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderResults(results, _query) {
  resultsEl.innerHTML = ''
  for (const r of results) {
    resultsEl.append(buildCard(r))
  }
}

function buildCard(memory) {
  const card = document.createElement('div')
  card.className = 'result'
  card.title = 'Click to copy memory content'

  const titleRow = document.createElement('div')
  titleRow.className = 'result-title'
  const titleText = document.createElement('span')
  titleText.textContent = memory.title || 'Untitled'
  const sourceTag = document.createElement('span')
  sourceTag.className = 'result-source'
  sourceTag.textContent = memory.source || 'manual'
  titleRow.append(titleText, sourceTag)
  card.append(titleRow)

  const snip = document.createElement('div')
  snip.className = 'result-snippet'
  if (memory.highlight) {
    snip.innerHTML = memory.highlight
  } else {
    const text = (memory.content || '').replace(/[#*`_]/g, '').trim().slice(0, 160)
    snip.textContent = text || '(empty)'
  }
  card.append(snip)

  card.addEventListener('click', () => void copyMemory(memory))
  return card
}

async function copyMemory(memory) {
  try {
    await navigator.clipboard.writeText(memory.content || '')
    showToast('ok', 'Copied ✓')
  } catch (_) {
    showToast('err', 'Copy failed')
  }
}

// ── Cache ───────────────────────────────────────────────────────────────────

async function cacheResults(results, query) {
  try {
    const store = chrome.storage.session ?? chrome.storage.local
    await store.set({ [K.cachedResults]: results, [K.cachedQuery]: query })
  } catch (_) { /* ignore */ }
}

async function restoreCachedResults() {
  try {
    const store = chrome.storage.session ?? chrome.storage.local
    const got = await store.get([K.cachedResults, K.cachedQuery])
    const cached = got[K.cachedResults]
    if (Array.isArray(cached) && cached.length > 0) {
      if (got[K.cachedQuery]) searchInput.value = got[K.cachedQuery]
      renderResults(cached, got[K.cachedQuery] || '')
    }
  } catch (_) { /* ignore */ }
}

// ── Save This Chat ──────────────────────────────────────────────────────────

const SUPPORTED_CHAT_HOSTS = [
  'claude.ai', 'chatgpt.com', 'chat.openai.com', 'gemini.google.com'
]

async function maybeShowSaveChatButton() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab || !tab.url) return
    const hostname = new URL(tab.url).hostname.toLowerCase()
    const isSupported = SUPPORTED_CHAT_HOSTS.some(h => hostname === h || hostname.endsWith('.' + h))
    if (!isSupported) { saveChatWrap.hidden = true; return }

    saveChatWrap.hidden = false

    // Check if this URL was already saved
    const stored = await chrome.storage.local.get([K.token, K.port])
    if (!stored[K.token] || !stored[K.port]) return

    try {
      const r = await fetch(
        `http://127.0.0.1:${stored[K.port]}/api/vault/check-url?url=${encodeURIComponent(tab.url)}`,
        { headers: { 'Authorization': `Bearer ${stored[K.token]}` } }
      )
      if (r.ok) {
        const info = await r.json()
        existingChatInfo = info.exists ? info : null
        if (info.exists) {
          saveChatIcon.textContent = '🔄'
          saveChatLabel.textContent = `Update Chat (${info.messageCount} msgs)`
        } else {
          existingChatInfo = null
          saveChatIcon.textContent = '💾'
          saveChatLabel.textContent = 'Save This Chat'
        }
      }
    } catch { /* ignore */ }
  } catch (_) {
    saveChatWrap.hidden = true
  }
}

async function handleSaveChat() {
  const stored = await chrome.storage.local.get([K.token, K.port])
  const token = stored[K.token]
  const port = stored[K.port]
  if (!token || !port) {
    showToast('err', 'Not connected to app')
    return
  }

  saveChatBtn.disabled = true
  saveChatIcon.textContent = '⏳'
  saveChatLabel.textContent = 'Extracting…'

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab || !tab.id) throw new Error('No active tab')

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    })

    const extracted = results && results[0] && results[0].result
    if (!extracted || !extracted.messages || extracted.messages.length === 0) {
      const errMsg = extracted && extracted.error
        ? extracted.error
        : 'No messages found'
      showSaveFeedback('error', '✗', errMsg)
      return
    }

    const { messages, source, title } = extracted
    const isUpdate = existingChatInfo && existingChatInfo.exists

    // Always rebuild the full markdown from ALL current messages.
    // This ensures previously-truncated messages are replaced with full content.
    const markdown = buildMarkdown(messages, source, title, tab.url || '')
    const filename = isUpdate
      ? existingChatInfo.path.split(/[/\\]/).pop()
      : buildFilename(title, tab.url || '')

    const r = await fetch(`http://127.0.0.1:${port}/api/vault/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ filename, content: markdown, source })
    })

    if (r.ok) {
      const label = isUpdate
        ? `Updated ${messages.length} msgs`
        : `Saved ${messages.length} messages`
      showSaveFeedback('success', '✓', label)
      existingChatInfo = { exists: true, path: (existingChatInfo && existingChatInfo.path) || '', messageCount: messages.length }
    } else if (r.status === 503) {
      showSaveFeedback('error', '✗', 'Vault not configured in app')
    } else {
      showSaveFeedback('error', '✗', `Save failed (${r.status})`)
    }
  } catch (err) {
    showSaveFeedback('error', '✗', 'Could not read chat')
  }
}

function showSaveFeedback(type, icon, text) {
  saveChatBtn.disabled = false
  saveChatBtn.className = `save-chat-btn ${type}`
  saveChatIcon.textContent = icon
  saveChatLabel.textContent = text
  setTimeout(() => {
    saveChatBtn.className = 'save-chat-btn'
    saveChatIcon.textContent = existingChatInfo ? '🔄' : '💾'
    saveChatLabel.textContent = existingChatInfo
      ? `Update Chat (${existingChatInfo.messageCount} msgs)`
      : 'Save This Chat'
  }, 2500)
}

function buildMarkdown(messages, source, title, url) {
  const now = new Date().toISOString()
  const lines = [
    '---',
    `source: ${source}`,
    `captured: ${now}`,
    url ? `url: ${url}` : null,
    '---',
    '',
    `# ${title || 'Untitled Chat'}`,
    '',
  ].filter(l => l !== null)

  for (const msg of messages) {
    if (msg.role === 'human') {
      const quoted = msg.content.split('\n').map(l => `> ${l}`).join('\n')
      lines.push(quoted)
    } else {
      lines.push(msg.content)
    }
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}

function buildFilename(title, url) {
  const now = new Date()
  const date = now.toISOString().slice(0, 10)
  const time = now.toTimeString().slice(0, 5).replace(':', '-')
  const slug = (title || 'chat')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '')
  return `${date}-${time}-${slug || 'untitled'}.md`
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function getStored(key) {
  const s = await chrome.storage.local.get([key])
  return s[key] ?? null
}

async function readErrorCode(response) {
  try {
    const body = await response.json()
    return (body && body.code) || null
  } catch (_) {
    return null
  }
}

function requestDiscovery() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'discover' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        resolve({ port: null, status: 'not-running' })
        return
      }
      resolve(resp)
    })
  })
}

function showStatus(kind, text) {
  statusEl.textContent = text
  statusEl.className = `status ${kind}`
  statusEl.hidden = false
}
function hideStatus() {
  statusEl.hidden = true
  statusEl.textContent = ''
}

function showToast(kind, text) {
  clearTimeout(toastTimer)
  toastEl.textContent = text
  toastEl.className = `toast ${kind}`
  toastEl.hidden = false
  toastTimer = setTimeout(() => { toastEl.hidden = true }, TOAST_MS)
}
