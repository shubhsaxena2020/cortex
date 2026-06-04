# Phase 3 — Automated Integration Test Report

_Generated: 2026-06-02T23:07:06.687Z_

## 🚀 Phase 3 status: COMPLETE

**Totals: 25 passed, 0 failed**

---

## ✅ Features under test

- `sqlite-vec` extension loads inside Electron's main process
- Ollama client (`src/main/embeddings.ts`) reaches `http://127.0.0.1:11434/api/embed`
- `memory_vectors` virtual table stores 384-dim Float32 vectors for each memory
- POST `/api/memories` triggers a fire-and-forget embedding write (no client-visible latency)
- GET `/api/related` performs vector KNN via sqlite-vec, returns semantically-ranked results
- Graceful fallback to keyword extraction when Ollama is unreachable or embeddings empty
- Existing endpoints (`/health`, `/api/search`, `/api/recent`) untouched and still pass smoke tests

---

## 📊 Test results

### api-smoke

**17/17 passed**

- ✅ **GET /health → 200**  
  _status=200_
- ✅ **/health body has ok=true and app=cortex**  
  _{"ok":true,"app":"cortex","version":"0.1.0","apiVersion":1}_
- ✅ **/health body has version + apiVersion**
- ✅ **Missing token on /api/recent → 401**  
  _status=401_
- ✅ **Invalid token on /api/recent → 401**  
  _status=401_
- ✅ **Invalid token response includes code=INVALID_TOKEN**  
  _{"error":"invalid_token","code":"INVALID_TOKEN"}_
- ✅ **GET /api/recent?limit=5 → 200**  
  _status=200_
- ✅ **/api/recent returns results[]**
- ✅ **/api/recent respects limit**  
  _got 5_
- ✅ **GET /api/search?q=a → 200**  
  _status=200_
- ✅ **/api/search returns results[]**
- ✅ **GET /api/related → 200**  
  _status=200_
- ✅ **/api/related returns results[] and keywords[]**
- ✅ **POST /api/memories → 201**  
  _status=201_
- ✅ **POST returns the created memory with an id**  
  _{"memory":{"id":"9f042e62-f348-4617-bb5c-4b73fb608237","title":"[TEST-SMOKE] smoke memory","content"_
- ✅ **DELETE /api/memories/:id → 204**  
  _status=204_
- ✅ **Deleted memory no longer appears in /api/recent**

### integration

**8/8 passed**

- ✅ **Create 5 diverse memories via HTTP**  
  _5/5_
- ✅ **sqlite-vec extension is loaded (vectorSearchEnabled)**
- ✅ **All 5 memories have vector embeddings within 15s**  
  _5/5 after 500ms_
- ✅ **/api/related ranks AI ≥ off-topic for ML query**  
  _top3 AI=2 off-topic=0 — [TEST-PHASE3] ai | [TEST-PHASE3] ai | My first insight_
- ✅ **/api/related ranks coffee ≥ AI for espresso query**  
  _top3 coffee=1 AI=1 — [TEST-PHASE3] coffee | [TEST-PHASE3] ai | [TEST-PHASE3] sports_
- ✅ **/api/related returns keywords[] for UI display**  
  _machine, learning_
- ✅ **/api/search (LIKE) finds the coffee test memory**  
  _matched titles: [TEST-PHASE3] coffee_
- ✅ **DELETE /api/memories/:id removes the embedding too**  
  _delete=204 stillEmbedded=false_

---

## How these tests run

- They open the **same** `memories.db` the running app uses (WAL mode allows concurrent reads/writes).
- Test memories are tagged with `[TEST-PHASE3]` / `[TEST-SMOKE]` prefixes and removed at the end of each run.
- Pre-cleanup also removes leftover `[TEST-PHASE3]` rows from any previous crashed run.
- Tests hit the live HTTP API at the port from `extension-config.json`.

## Common causes of failure

- **Suite errored "extension-config.json missing"** → start the app: `npm run dev`
- **Suite errored "app unreachable"** → app crashed; check the dev terminal
- **"All 5 memories have vector embeddings stored" failed** → either:
  - Ollama isn't running (`ollama serve` or launch Ollama desktop)
  - `all-minilm` model not pulled (`ollama pull all-minilm`)
  - `sqlite-vec` npm package not installed in test process (run `npm install sqlite-vec`)
- **Semantic ranking tests fail** → embeddings landed but Ollama returned dim-mismatched vectors; check that `CORTEX_EMBED_MODEL` (if set) is 384-dim

## 🎉 Notes

All suites green. Phase 3 is functionally complete — vector search works end-to-end.

