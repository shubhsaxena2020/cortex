#!/usr/bin/env node
// scripts/verify-paste-mechanisms.mjs
//
// "Verify paste mechanisms for the v0.3 switch-AI handoff feature."
//
// A Node script CANNOT verify in-browser DOM behaviour — the input boxes
// only exist inside each provider's runtime context, behind auth. So this
// script doesn't pretend to run Puppeteer. Instead it prints a DevTools
// probe + workflow that takes ~3 minutes per provider at the user's
// keyboard. The probe output goes back into docs/PASTE-MECHANISM-REFERENCE.md.

const PROBE = `
// ─── Cortex paste-mechanism probe ────────────────────────────────────────
// Paste into DevTools Console on the provider's chat page (must be logged in
// AND have an active conversation visible). Run, copy the printed object,
// paste it back to Claude Code.

(() => {
  const result = { provider: location.hostname, ts: new Date().toISOString() };

  // 1. Find the input element. Try common patterns in order of specificity.
  const candidates = [
    '[data-testid="chat-input"]',                // Claude.ai today
    '#prompt-textarea',                           // ChatGPT historical id
    '[contenteditable="true"][role="textbox"]',  // generic rich input
    'rich-textarea [contenteditable]',           // Gemini Lit element
    'textarea[placeholder*="essage" i]',         // textarea-style chat input
    'div[contenteditable="true"]',               // last-resort contenteditable
    'textarea',                                  // last-resort textarea
  ];
  let input = null, hitSelector = null;
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) { input = el; hitSelector = sel; break; }
  }
  result.input_found = !!input;
  if (!input) { console.log(JSON.stringify(result, null, 2)); return result; }

  // 2. Describe what we found.
  result.matched_selector = hitSelector;
  result.tag = input.tagName.toLowerCase();
  result.is_contenteditable = input.getAttribute('contenteditable') === 'true';
  result.has_react_props = Object.keys(input).some(k => k.startsWith('__react'));
  result.placeholder = input.getAttribute('placeholder') || input.getAttribute('aria-label') || null;
  result.data_testid = input.getAttribute('data-testid') || null;
  result.role = input.getAttribute('role') || null;
  result.parent_tag = input.parentElement ? input.parentElement.tagName.toLowerCase() : null;
  result.parent_data_testid = input.parentElement ? input.parentElement.getAttribute('data-testid') : null;

  // 3. Probe paste behaviour (NON-DESTRUCTIVE: we restore the original value).
  //    Try four common injection methods and observe which fires the
  //    framework's change tracker (the Send button becoming enabled is the
  //    canonical signal — most providers disable Send until input is non-empty).
  const sendBtn = document.querySelector(
    'button[data-testid="send-button"], button[aria-label*="end" i], button[type="submit"]'
  );
  result.send_button_found = !!sendBtn;
  result.send_button_initially_disabled = sendBtn ? sendBtn.disabled : null;

  const PROBE_TEXT = '__cortex_probe__';
  const methods = [];
  const originalText = input.value !== undefined ? input.value : input.textContent;

  // Method A: direct .value assignment
  if (input.value !== undefined) {
    try {
      input.value = PROBE_TEXT;
      methods.push({ method: 'value=', enabledSend: sendBtn ? !sendBtn.disabled : null });
    } catch (e) { methods.push({ method: 'value=', error: String(e) }); }
  }

  // Method B: textContent (contenteditable)
  if (input.isContentEditable) {
    try {
      input.textContent = PROBE_TEXT;
      methods.push({ method: 'textContent=', enabledSend: sendBtn ? !sendBtn.disabled : null });
    } catch (e) { methods.push({ method: 'textContent=', error: String(e) }); }
  }

  // Method C: native setter + dispatchEvent (the React-safe pattern)
  try {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) {
      setter.set.call(input, PROBE_TEXT);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      methods.push({ method: 'native-setter+input-event', enabledSend: sendBtn ? !sendBtn.disabled : null });
    }
  } catch (e) { methods.push({ method: 'native-setter+input-event', error: String(e) }); }

  // Method D: execCommand insertText (works for React-controlled contenteditables)
  if (input.isContentEditable) {
    try {
      input.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, PROBE_TEXT);
      methods.push({ method: 'execCommand(insertText)', enabledSend: sendBtn ? !sendBtn.disabled : null });
    } catch (e) { methods.push({ method: 'execCommand(insertText)', error: String(e) }); }
  }

  result.methods_tried = methods;

  // 4. Restore original (best-effort).
  try {
    if (input.value !== undefined) input.value = originalText;
    else input.textContent = originalText;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } catch (_) { /* ignore */ }

  console.log(JSON.stringify(result, null, 2));
  return result;
})();
// ─────────────────────────────────────────────────────────────────────────
`.trim();

const HEADER = `
Cortex switch-AI paste-mechanism verifier
=========================================
This tool does NOT verify anything by itself — it prints a DevTools probe
you paste into each provider's chat page. The probe is non-destructive
(restores the input's original value).

Workflow (~3 min per provider):

  1. Log in to the provider and open any active chat with the input box visible.
  2. Open DevTools → Console.
  3. Paste the probe below.
  4. Copy the JSON object printed to the console.
  5. Paste it back to Claude Code (one per provider).

Claude Code will fill in docs/PASTE-MECHANISM-REFERENCE.md from your output.

Providers to test:
  - https://claude.ai/  (any open chat)
  - https://chatgpt.com/  (any open chat)
  - https://gemini.google.com/app  (any open chat)

Probe (copy everything between the dashes):
`;

console.log(HEADER);
console.log(PROBE);
console.log('\nDone. Run the probe on all 3 sites, then paste outputs back.');
