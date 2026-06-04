// Cortex — chat extraction content script
// Injected dynamically by popup.js via chrome.scripting.executeScript.
// Returns: { messages: [{role, content, index}], source: string, title: string }

function extractChat() {
  const url = location.hostname.toLowerCase()

  if (url === 'claude.ai' || url.endsWith('.claude.ai')) {
    return extractClaude()
  }
  if (url === 'chatgpt.com' || url.endsWith('.chatgpt.com') || url === 'chat.openai.com') {
    return extractChatGPT()
  }
  if (url === 'gemini.google.com') {
    return extractGemini()
  }

  return { messages: [], source: 'manual', title: document.title }
}

// Walk upward from an action-bar button (Copy / Edit / Retry) to the
// enclosing AI message container. Strategy: keep climbing while the parent
// is still scoped to a SINGLE turn (i.e., contains exactly one action-bar)
// and stop one level below the first ancestor that shares the action-bar
// with another turn. This is robust to Claude.ai's frequent DOM shuffles
// because we never depend on a class name or data-testid for the AI
// container itself — only on the action button, which is functionally
// stable (users need it to copy answers).
function findAiContainerFromActionBar(buttonEl) {
  if (!buttonEl) return null
  // Hard cap so a missing scope-boundary never walks to <body>.
  var MAX_WALK = 10
  var node = buttonEl.parentElement
  var lastSingleTurnNode = null
  for (var i = 0; i < MAX_WALK && node && node !== document.body; i++) {
    var copyButtonsInside = node.querySelectorAll('[data-testid="action-bar-copy"]').length
    if (copyButtonsInside > 1) {
      // We've walked into a wrapper that contains other turns. The last
      // single-turn ancestor is our message container.
      return lastSingleTurnNode || node
    }
    lastSingleTurnNode = node
    node = node.parentElement
  }
  return lastSingleTurnNode
}

function extractClaude() {
  const messages = []
  let index = 0

  console.log('[cortex] Starting extraction, user-message count:',
    document.querySelectorAll('[data-testid="user-message"]').length,
    'action-bar-copy count:',
    document.querySelectorAll('[data-testid="action-bar-copy"]').length)

  // Strategy 0 (preferred, 2026-06+ DOM): action-bar buttons as anchors.
  // [data-testid="assistant-message"] no longer exists in Claude.ai's
  // current DOM, but Copy/Edit/Retry buttons on every AI response do.
  // Walk up from each Copy button to find the response container.
  var userMsgsForS0 = document.querySelectorAll('[data-testid="user-message"]')
  var copyButtons = document.querySelectorAll('[data-testid="action-bar-copy"]')
  if (userMsgsForS0.length > 0 && copyButtons.length > 0) {
    var combined = []
    for (var u0 = 0; u0 < userMsgsForS0.length; u0++) {
      combined.push({ el: userMsgsForS0[u0], role: 'human' })
    }
    var aiContainers = []
    var seen = new Set()
    for (var b = 0; b < copyButtons.length; b++) {
      var container = findAiContainerFromActionBar(copyButtons[b])
      if (container && !seen.has(container)) {
        seen.add(container)
        aiContainers.push(container)
      }
    }
    for (var ai = 0; ai < aiContainers.length; ai++) {
      combined.push({ el: aiContainers[ai], role: 'ai' })
    }
    combined.sort(function(x, y) {
      var pos = x.el.compareDocumentPosition(y.el)
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    })
    for (var c0 = 0; c0 < combined.length; c0++) {
      var content0 = extractTextFromElement(combined[c0].el)
      if (content0 && content0.length >= 10) {
        messages.push({ role: combined[c0].role, content: content0, index: index++ })
      }
    }
    // Only return if we got at least one ai message — otherwise fall through
    // to legacy strategies which may match a future DOM regression.
    var hasAi = messages.some(function(m) { return m.role === 'ai' })
    if (messages.length > 0 && hasAi) {
      console.log('[cortex] Strategy 0 succeeded:', messages.length, 'messages',
        '(', messages.filter(function(m){return m.role==='human'}).length, 'human,',
        messages.filter(function(m){return m.role==='ai'}).length, 'ai )')
      return { messages: messages, source: 'claude', title: document.title }
    }
    // Reset and fall through if Strategy 0 produced no AI messages.
    messages.length = 0
    index = 0
  }

  // Strategy 1: user-message / assistant-message data-testid (legacy Claude.ai DOM)
  const userMsgs = document.querySelectorAll('[data-testid="user-message"]')
  if (userMsgs.length > 0) {
    // Log what follows the first user-message for debugging
    var firstUser = userMsgs[0]
    var nextSib = firstUser ? firstUser.nextElementSibling : null
    if (nextSib) {
      console.log('[cortex] Element after first user-message testid:',
        nextSib.getAttribute('data-testid'), 'tag:', nextSib.tagName)
    }

    // Collect all message elements in DOM order by walking siblings/parents
    // Try explicit assistant selectors first, then fall back to next-sibling pairing
    var aiSelector = '[data-testid="assistant-message"], [data-testid="ai-response"]'
    var aiMsgs = document.querySelectorAll(aiSelector)

    if (aiMsgs.length > 0) {
      // Both sides found — merge and sort by DOM order
      var combined = []
      for (var u = 0; u < userMsgs.length; u++) {
        combined.push({ el: userMsgs[u], role: 'human' })
      }
      for (var a = 0; a < aiMsgs.length; a++) {
        combined.push({ el: aiMsgs[a], role: 'ai' })
      }
      combined.sort(function(x, y) {
        var pos = x.el.compareDocumentPosition(y.el)
        return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      })
      for (var c = 0; c < combined.length; c++) {
        var content = extractTextFromElement(combined[c].el)
        if (content && content.length >= 10) {
          messages.push({ role: combined[c].role, content: content, index: index++ })
        }
      }
    } else {
      // No explicit AI selector matched — pair each user-message with its
      // nearest following sibling div as the AI response
      for (var i = 0; i < userMsgs.length; i++) {
        var userEl = userMsgs[i]
        var userText = extractTextFromElement(userEl)
        if (userText && userText.length >= 10) {
          messages.push({ role: 'human', content: userText, index: index++ })
        }
        // Walk next siblings to find AI response
        var sibling = userEl.nextElementSibling
        while (sibling) {
          // Stop if we hit the next user message
          if (sibling.getAttribute('data-testid') === 'user-message') break
          var sibText = extractTextFromElement(sibling)
          if (sibText && sibText.length >= 10) {
            messages.push({ role: 'ai', content: sibText, index: index++ })
            break
          }
          sibling = sibling.nextElementSibling
        }
      }
    }

    if (messages.length > 0) return { messages, source: 'claude', title: document.title }
  }

  // Strategy 2: interleave all user-message elements with following response containers
  // by DOM position (fallback when AI selector is unknown)
  var allUserMsgs = document.querySelectorAll('[data-testid="user-message"]')
  if (allUserMsgs.length > 0) {
    for (var j = 0; j < allUserMsgs.length; j++) {
      var uEl = allUserMsgs[j]
      var uText = extractTextFromElement(uEl)
      if (uText && uText.length >= 10) {
        messages.push({ role: 'human', content: uText, index: index++ })
      }
      // Scan following siblings in parent for AI response
      var parent = uEl.parentElement
      if (parent) {
        var kids = Array.from(parent.children)
        var uIdx = kids.indexOf(uEl)
        for (var k = uIdx + 1; k < kids.length; k++) {
          if (kids[k].getAttribute('data-testid') === 'user-message') break
          var kText = extractTextFromElement(kids[k])
          if (kText && kText.length >= 10) {
            messages.push({ role: 'ai', content: kText, index: index++ })
            break
          }
        }
      }
    }
    if (messages.length > 0) return { messages, source: 'claude', title: document.title }
  }

  // Strategy 3: walk up from input area to find conversation, then children
  const inputArea = document.querySelector('[data-testid="chat-input"], [contenteditable="true"], textarea')
  if (inputArea) {
    let container = inputArea.parentElement
    for (let i = 0; i < 10 && container; i++) {
      const children = Array.from(container.children).filter(el => {
        const text = extractTextFromElement(el)
        return text && text.length >= 10
      })
      if (children.length >= 2) {
        children.forEach((el, i) => {
          const avatarImg = el.querySelector('img[alt*="Claude"], img[alt*="User"]')
          let role
          if (avatarImg) {
            role = (avatarImg.getAttribute('alt') || '').toLowerCase().includes('user') ? 'human' : 'ai'
          } else {
            role = i % 2 === 0 ? 'human' : 'ai'
          }
          const text = extractTextFromElement(el)
          if (text && text.length >= 10) messages.push({ role, content: text, index: messages.length })
        })
        if (messages.length > 0) return { messages, source: 'claude', title: document.title }
      }
      container = container.parentElement
    }
  }

  // Strategy 4: class-based fallback
  const humanTurns = document.querySelectorAll('.human-turn, [class*="human"]')
  const aiTurns = document.querySelectorAll('.ai-turn, [class*="assistant"]')
  if (humanTurns.length > 0 || aiTurns.length > 0) {
    const combined = []
    for (const el of humanTurns) combined.push({ el, role: 'human' })
    for (const el of aiTurns) combined.push({ el, role: 'ai' })
    combined.sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el)
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    })
    for (const { el, role } of combined) {
      const content = extractTextFromElement(el)
      if (content && content.length >= 10) messages.push({ role, content, index: index++ })
    }
    if (messages.length > 0) return { messages, source: 'claude', title: document.title }
  }

  // Debug fallback
  if (messages.length === 0) {
    console.warn('[cortex] Claude extraction failed. Page title:', document.title)
    console.warn('[cortex] Body preview:', document.body.innerHTML.slice(0, 500))
    console.warn('[cortex] Tried: data-testid, role=presentation, input-walk, class fallback')
    return {
      messages: [],
      source: 'claude',
      title: document.title,
      error: 'Could not read chat. Make sure you have a conversation open and the page is fully loaded.'
    }
  }

  return { messages, source: 'claude', title: document.title }
}

function extractChatGPT() {
  const messages = []
  let index = 0

  // Strategy 1: stable data-message-author-role attribute
  const roleEls = document.querySelectorAll('[data-message-author-role]')
  if (roleEls.length > 0) {
    for (const el of roleEls) {
      const authorRole = el.getAttribute('data-message-author-role')
      const role = authorRole === 'user' ? 'human' : 'ai'
      // Try to get content from a nested content div
      const contentEl = el.querySelector('.markdown, .prose, [class*="markdown"], [class*="prose"]')
      const content = contentEl
        ? extractTextFromElement(contentEl)
        : extractTextFromElement(el)
      if (content && content.length >= 10) messages.push({ role, content, index: index++ })
    }
    if (messages.length > 0) return { messages, source: 'chatgpt', title: document.title }
  }

  // Strategy 2: article elements with conversation-turn
  const articles = document.querySelectorAll('article[data-testid^="conversation-turn"]')
  for (const article of articles) {
    const roleEl = article.querySelector('[data-message-author-role]')
    if (!roleEl) continue
    const authorRole = roleEl.getAttribute('data-message-author-role')
    const role = authorRole === 'user' ? 'human' : 'ai'
    const contentEl = article.querySelector('.markdown, .prose, [class*="markdown"]')
    const content = contentEl
      ? extractTextFromElement(contentEl)
      : extractTextFromElement(article)
    if (content && content.length >= 10) messages.push({ role, content, index: index++ })
  }

  if (messages.length === 0) {
    console.warn('[cortex] ChatGPT extraction failed. Page title:', document.title)
    console.warn('[cortex] Body preview:', document.body.innerHTML.slice(0, 500))
    return {
      messages: [],
      source: 'chatgpt',
      title: document.title,
      error: 'Could not read chat. Make sure you have a conversation open and the page is fully loaded.'
    }
  }

  return { messages, source: 'chatgpt', title: document.title }
}

function extractGemini() {
  const messages = []
  let index = 0

  // Strategy 1: user-query and model-response web components
  const userEls = document.querySelectorAll(
    'user-query, .user-query, [class*="user-query"], .query-text, [data-chunk-index] .query-content'
  )
  const modelEls = document.querySelectorAll(
    'model-response, .model-response, [class*="model-response"], .response-content, .markdown-main-panel'
  )

  if (userEls.length > 0 || modelEls.length > 0) {
    const combined = []
    for (const el of userEls) combined.push({ el, role: 'human' })
    for (const el of modelEls) combined.push({ el, role: 'ai' })
    combined.sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el)
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    })
    for (const { el, role } of combined) {
      const content = extractTextFromElement(el)
      if (content && content.length >= 10) messages.push({ role, content, index: index++ })
    }
    if (messages.length > 0) return { messages, source: 'gemini', title: document.title }
  }

  // Strategy 2: conversation bubble fallback
  const bubbles = document.querySelectorAll('[class*="conversation"] [class*="message"]')
  for (const bubble of bubbles) {
    const text = extractTextFromElement(bubble)
    if (text && text.length >= 10) messages.push({ role: 'ai', content: text, index: index++ })
  }

  if (messages.length === 0) {
    console.warn('[cortex] Gemini extraction failed. Page title:', document.title)
    console.warn('[cortex] Body preview:', document.body.innerHTML.slice(0, 500))
    console.warn('[cortex] Tried: user-query/model-response, conversation bubbles')
    return {
      messages: [],
      source: 'gemini',
      title: document.title,
      error: 'Could not read chat. Make sure you have a conversation open and the page is fully loaded.'
    }
  }

  return { messages, source: 'gemini', title: document.title }
}

function extractTextFromElement(el) {
  if (!el) return ''
  return domToMarkdown(el).trim()
}

function domToMarkdown(node) {
  if (!node) return ''
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || ''
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return ''
  }

  var tag = node.tagName.toLowerCase()

  // Skip hidden elements and script/style noise
  if (tag === 'script' || tag === 'style' || tag === 'noscript') return ''

  var children = Array.from(node.childNodes)
  var inner = children.map(domToMarkdown).join('')

  if (tag === 'br') return '\n'
  if (tag === 'hr') return '\n---\n'

  if (tag === 'strong' || tag === 'b') {
    var t = inner.trim()
    return t ? '**' + t + '**' : ''
  }
  if (tag === 'em' || tag === 'i') {
    var t = inner.trim()
    return t ? '*' + t + '*' : ''
  }

  if (tag === 'code') {
    // Inline code (inside a <pre> is handled by 'pre' branch below)
    if (node.parentElement && node.parentElement.tagName.toLowerCase() === 'pre') {
      return inner
    }
    return '`' + inner.trim() + '`'
  }

  if (tag === 'pre') {
    var lang = ''
    var codeEl = node.querySelector('code')
    var content = ''
    if (codeEl) {
      var cls = codeEl.className || ''
      var match = cls.match(/language-(\w+)/)
      if (match) lang = match[1]
      content = codeEl.textContent || ''
    } else {
      content = node.textContent || ''
    }
    return '\n```' + lang + '\n' + content + '\n```\n'
  }

  if (tag === 'a') {
    var href = node.getAttribute('href') || ''
    var text = inner.trim()
    if (!text) return ''
    if (!href) return text
    return '[' + text + '](' + href + ')'
  }

  if (tag === 'h1') return '\n# '   + inner.trim() + '\n'
  if (tag === 'h2') return '\n## '  + inner.trim() + '\n'
  if (tag === 'h3') return '\n### ' + inner.trim() + '\n'
  if (tag === 'h4') return '\n#### '+ inner.trim() + '\n'
  if (tag === 'h5') return '\n##### '+ inner.trim() + '\n'
  if (tag === 'h6') return '\n###### '+ inner.trim() + '\n'

  if (tag === 'li') {
    return '\n- ' + inner.trim()
  }
  if (tag === 'ul' || tag === 'ol') {
    return '\n' + inner + '\n'
  }

  if (tag === 'table') {
    return convertTable(node)
  }

  if (tag === 'p') {
    return '\n' + inner.trim() + '\n'
  }
  if (tag === 'div' || tag === 'section' || tag === 'article') {
    var trimmed = inner.trim()
    if (!trimmed) return ''
    return '\n' + trimmed + '\n'
  }

  return inner
}

function convertTable(table) {
  var rows = Array.from(table.querySelectorAll('tr'))
  if (rows.length === 0) return ''
  var result = ''
  rows.forEach(function(row, i) {
    var cells = Array.from(row.querySelectorAll('th, td'))
    var line = '| ' + cells.map(function(c) {
      return (c.textContent || '').trim().replace(/\|/g, '\\|')
    }).join(' | ') + ' |'
    result += line + '\n'
    if (i === 0 && cells.length > 0) {
      result += '| ' + cells.map(function() { return '---' }).join(' | ') + ' |\n'
    }
  })
  return '\n' + result + '\n'
}

// Execute — last expression is captured by executeScript as results[0].result
extractChat()
