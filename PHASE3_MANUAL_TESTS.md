# Phase 3 Manual Testing Checklist

Semantic search via Ollama + sqlite-vec.

## Prerequisites (one-time)

- [ ] **Install Ollama** from <https://ollama.com> (Windows installer)
- [ ] **Pull the embedding model**:
  ```powershell
  ollama pull all-minilm
  ```
  (~22 MB; one-time download)
- [ ] **Verify Ollama is running**:
  ```powershell
  Invoke-RestMethod http://127.0.0.1:11434/api/tags
  ```
  Should list `all-minilm` in `models`.
- [ ] **Install the new npm dep**:
  ```powershell
  cd C:\Users\shubh\cortex
  npm install sqlite-vec
  npm run postinstall   # rebuilds native bits for Electron's ABI
  ```

## Setup

- [ ] **Run** `npm run dev`. Watch the terminal for:
  - `[db] sqlite-vec loaded; vector search enabled` ✓
  - `[cortex] extension API on http://127.0.0.1:48729` ✓
  - `[seed] embedding N memories...` then `[seed] done — N memories embedded` ✓
  - App window appears in under ~5s (model load is in Ollama, doesn't block app)
- [ ] **Reload the extension** at `chrome://extensions` (circular arrow on the Cortex card).

If the seed line says `skipped (ollama-unavailable)` or `skipped (model-not-pulled)`, fix the prerequisites and restart.

---

## Test 1 — Semantic search beats keyword search

- [ ] Create 3 new memories in the app (Ctrl+N each):
  1. *"Machine learning is about training neural networks on labeled data"*
  2. *"Deep learning uses convolutional networks for image recognition"*
  3. *"Coffee brewing requires hot water around 95°C and a paper filter"*
- [ ] Wait ~5 seconds (embeddings land async after create).
- [ ] **Result:** all three should now have vectors. Confirm via terminal — no errors.

**No direct UI yet for vector search** in the desktop app (sidebar search is still LIKE-based). Vector search is exposed via `/api/related`. Skip to Test 3 to verify it works.

- [ ] PASS / FAIL: ___

---

## Test 2 — Extension save flow still works

The Phase 2c right-click save now also auto-embeds. Verify nothing broke:

- [ ] On any AI page, select text → right-click → "Save to Cortex".
- [ ] Badge shows ✓ green. Memory appears in sidebar within a second.
- [ ] Terminal shows no errors. (No explicit "[embed]" log per memory — the fire-and-forget runs silent.)

- [ ] PASS / FAIL: ___

---

## Test 3 — `/api/related` returns semantically-similar memories

Open a separate PowerShell window:

```powershell
$cfg = Get-Content "$env:APPDATA\Cortex\extension-config.json" | ConvertFrom-Json
$h = @{ "Authorization" = "Bearer $($cfg.token)" }

# Should rank ML/AI memories above coffee
Invoke-RestMethod "http://127.0.0.1:$($cfg.port)/api/related?context=neural+networks+for+machine+learning" -Headers $h | ConvertTo-Json -Depth 4
```

- [ ] **Top result title** matches one of the ML memories from Test 1 (or another ML-related memory you have). The coffee memory should not appear in top 3.

- [ ] PASS / FAIL: ___

---

## Test 4 — Vectors persist across restart

- [ ] Quit the app (Ctrl+C in the dev terminal, then close the window).
- [ ] Run `npm run dev` again.
- [ ] Terminal: `[seed] all N memories already embedded` (no re-embedding — they're stored).
- [ ] Repeat Test 3's curl — still returns semantically-ranked results.

- [ ] PASS / FAIL: ___

---

## Test 5 — Graceful fallback when Ollama is down

- [ ] **Stop Ollama**: `Stop-Process -Name ollama -Force` (or quit Ollama desktop).
- [ ] In the app, create a new memory.
- [ ] Terminal: `[embeddings] request failed: ...` warning (expected) — but app keeps working.
- [ ] Curl Test 3 again. **`/api/related` should still return results** — falls back to keyword extraction.

- [ ] PASS / FAIL: ___

- [ ] **Restart Ollama** (`ollama serve` or launch the desktop app) before continuing.

---

## Test 6 — Performance check

- [ ] Create 20 quick memories (right-click save 20 times from any selected text).
- [ ] Watch the terminal: seed runs once (5-10 seconds for 20 embeddings via Ollama).
- [ ] Curl `/api/related?context=...` a few times. Response should be **under 500ms** consistently (one Ollama call + one vec0 KNN query).

- [ ] PASS / FAIL: ___

---

## Test 7 — Automated test script

```powershell
cd C:\Users\shubh\cortex
node scripts/test-embeddings.mjs
```

Five tests run. Expected output:

```
[PASS] Embeddings model available  all-minilm
[PASS] Similarity ordering is correct  A↔B=0.7XX  A↔C=0.2XX
[PASS] Top-3 contains 2 ML memories, no off-topic
[PASS] 10 embeddings in <2000>ms
[PASS] /api/related responded with N result(s)
─────────────────────────────
5 passed, 0 failed
```

- [ ] All 5 PASS

---

## Summary

If all 7 PASS, Phase 3 is functionally complete. Semantic search is live; the rest of the app keeps working.

**Known limitations / follow-ups:**
- Vector search runs on `/api/related` only — the desktop Search page is still LIKE-based. Easy follow-up to swap.
- No "model is loading" indicator in the UI yet (since Ollama hosts the model, not us, load time is whatever Ollama takes).
- No re-embed when memory is updated by external means (we re-embed on every IPC update; HTTP POST already embeds).
- `all-minilm` is the lightest model (384-dim, ~22MB). Swap to `nomic-embed-text` (768-dim, better quality) by setting `$env:CORTEX_EMBED_MODEL = 'nomic-embed-text'` before launching — but you'd need to re-seed because vector dimensions don't match.
