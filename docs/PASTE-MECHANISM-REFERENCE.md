# Input Injection Reference for Switch AI (v0.3)

> Reference doc for the v0.3 handoff-helper feature. Each provider's chat input is reached differently. This is the **starter** version — entries are filled from prior knowledge or our own extension code, **explicitly flagged for live verification**. Run `node scripts/verify-paste-mechanisms.mjs` for the DevTools probe that produces verified values.
>
> **Status legend:**
> - 🟢 `verified` — confirmed via the DevTools probe on a live page
> - 🟡 `evidence` — known from Cortex's existing extension code or recent prior art; not re-verified for v0.3
> - 🔴 `unverified` — library knowledge or guess, MUST be probed before v0.3 implementation

## Claude.ai

| Field | Value | Status |
|---|---|---|
| Live URL | `https://claude.ai/` | — |
| Selector | `[data-testid="chat-input"]` (most likely) | 🟡 evidence (used in our `extension/content.js:195` as input anchor) |
| Tag | likely a `div` with `contenteditable="true"` | 🔴 unverified |
| Framework | React (ProseMirror-based editor suspected) | 🔴 unverified |
| Paste method (predicted) | `focus()` → `document.execCommand('selectAll', false, null)` → `document.execCommand('insertText', false, text)` — required for React-controlled contenteditables to fire change tracker | 🔴 unverified |
| Send-button enable signal | Send button is disabled when input is empty; becomes enabled after correct paste fires the input event | 🔴 unverified |
| Quirks (suspected) | ProseMirror editors strip raw HTML on paste; plain text is fine. Newlines may be converted to `<p>` blocks. Very long pastes (>10k chars) may visibly stutter on first render. | 🔴 unverified |
| Reliability (predicted) | **High** if Method D (`execCommand insertText`) works; **Medium** otherwise. ProseMirror is the most consistent of the three. | 🔴 unverified |

## ChatGPT.com

| Field | Value | Status |
|---|---|---|
| Live URL | `https://chatgpt.com/` | — |
| Selector | `#prompt-textarea` (historical) — may have changed | 🔴 unverified |
| Tag | Historically `<textarea>`; recent rewrites moved to `<div contenteditable>` | 🔴 unverified |
| Framework | React | 🟡 evidence (well-known) |
| Paste method (predicted, textarea path) | Native value setter + `input` event:<br>`const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;`<br>`setter.call(el, text);`<br>`el.dispatchEvent(new Event('input', { bubbles: true }));` | 🟡 evidence (canonical React-controlled input pattern) |
| Paste method (predicted, contenteditable path) | Same as Claude: `execCommand('insertText', false, text)` | 🔴 unverified |
| Send-button enable signal | Disabled until input non-empty; arrow-up icon | 🟡 evidence |
| Quirks (suspected) | ChatGPT auto-grows the textarea; line breaks render correctly. Slash-commands may intercept `/` at start of input. May normalize whitespace. | 🔴 unverified |
| Reliability (predicted) | **Medium-High**. Most likely failure: ChatGPT migrated to contenteditable in 2026 and Method C silently no-ops because the element is no longer an `HTMLTextAreaElement`. Probe will reveal. | 🔴 unverified |

## Gemini

| Field | Value | Status |
|---|---|---|
| Live URL | `https://gemini.google.com/app` | — |
| Selector | `rich-textarea [contenteditable]` (Lit custom element with internal contenteditable) | 🔴 unverified |
| Tag | `<rich-textarea>` web component wrapping a contenteditable `<div>` | 🟡 evidence (Google's Material/Lit conventions) |
| Framework | Lit + Angular shell | 🟡 evidence |
| Paste method (predicted) | `execCommand('insertText')` on the inner contenteditable. Custom element observers should propagate to Angular bindings. | 🔴 unverified |
| Send-button enable signal | Send button has `aria-label="Send message"`; disabled when input empty | 🔴 unverified |
| Quirks (suspected) | Custom-element boundary may swallow some events. Initial focus may be hijacked by Gemini's welcome state on a fresh tab — opening from URL with `q=` parameter may behave differently than pasting into an existing conversation. The web component may not exist until the chat panel is fully rendered (async). | 🔴 unverified |
| Reliability (predicted) | **Medium**. Web-component boundaries make this the trickiest of the three. May need to dispatch events on both the shadow-root inner element AND the host element. | 🔴 unverified |

## Universal paste pattern (recommended starting implementation)

Once the probe results are in, the v0.3 paste helper should be a per-provider strategy table that tries methods in order and stops at the first one that enables the Send button:

```js
// Pseudocode — actual implementation per provider goes in extension/handoff-paste.js
async function pasteIntoProvider(provider, text) {
  const input = findInputForProvider(provider);  // per-provider selector
  if (!input) throw new Error('input-not-found');

  // Try methods in fragility-ordered priority:
  //   D (execCommand) → C (native setter+event) → B (textContent=) → A (value=)
  // Stop at the first one that flips the Send button to enabled.

  const sendBtn = findSendButton(provider);
  for (const method of pasteMethodsFor(provider)) {
    await method(input, text);
    await raf(); // wait one frame
    if (!sendBtn.disabled) return { ok: true, method: method.name };
  }
  return { ok: false, reason: 'no-method-enabled-send' };
}
```

**Why this shape:**
- Falls back gracefully when one provider's DOM changes — degrades to "the user might have to click in the input box to confirm" rather than silent no-op.
- Self-documenting via the returned `method` field — Cortex can log which method worked per provider and update the priority order when one breaks.
- Per-provider strategy lists let each provider have its own list (Gemini might need shadow-DOM-aware variants; Claude might only need the ProseMirror path).

## Probe output to fill in

When you run the probe on each of the three sites, paste the JSON output back to Claude Code. The fields you'll get:

```jsonc
{
  "provider": "claude.ai",
  "ts": "...",
  "input_found": true,
  "matched_selector": "[data-testid=\"chat-input\"]",   // ← verified selector
  "tag": "div",                                           // ← verified
  "is_contenteditable": true,                             // ← verified
  "has_react_props": true,                                // ← framework signal
  "placeholder": "Reply to Claude…",                      // ← context
  "data_testid": "chat-input",
  "role": "textbox",
  "parent_tag": "div",
  "parent_data_testid": null,
  "send_button_found": true,
  "send_button_initially_disabled": true,
  "methods_tried": [
    { "method": "textContent=", "enabledSend": false },
    { "method": "native-setter+input-event", "enabledSend": false },
    { "method": "execCommand(insertText)", "enabledSend": true }  // ← WINNER
  ]
}
```

The **WINNER** for each provider is the method whose `enabledSend: true` happens first. Claude Code will rewrite this doc with verified rows once you paste the three outputs back.

## Implementation notes for v0.3

When v0.3 picks up the switch-AI feature:
- The "paste helper" is a new `extension/handoff-paste.js` content script, declared in `manifest.json` to match the three provider URLs.
- Triggered when the destination tab's URL contains a `cortex-payload=<id>` param (the param is added by the source-tab popup before opening the new tab).
- Reads the actual text from `chrome.storage.local[cortexHandoffPayloads][id]` (set by the source tab before opening). Storage instead of URL so 50-turn-summary payloads don't blow URL length limits and don't end up in browser history.
- After pasting, clears the URL param via `history.replaceState` so a page refresh doesn't re-paste.
- Never auto-submits. The whole point is the user reviews + hits Send.

## Re-verification cadence

Provider DOMs change. Every 3-6 months, or when a user reports the handoff feature stopped working for one provider, re-run the probe and update this doc.
