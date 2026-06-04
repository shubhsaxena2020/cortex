# Cortex

Cortex is a desktop app that gives you one searchable place for everything you've ever told an AI. Save snippets from Claude, ChatGPT, Gemini, or anywhere else with a right-click; browse them as notes; visualize how they connect in a graph; search them by keyword or semantic similarity — all backed by a local SQLite database on your machine. No cloud, no telemetry, no account.

## Status

**Latest release:** [v0.1.0-beta](https://github.com/shubhsaxena2020/cortex/releases/tag/v0.1.0-beta) (Pre-Release, Windows installer). See [`RELEASE_NOTES.md`](./RELEASE_NOTES.md).

**Recent progress** (2026-06-04):
- v0.2 P0 #1 shipped — conversation deduplication by canonical URL with cross-pipeline absorption ([`1d7d0e1`](https://github.com/shubhsaxena2020/cortex/commit/1d7d0e1) · [`c015dfe`](https://github.com/shubhsaxena2020/cortex/commit/c015dfe))
- v0.2 P0 #2 shipped — smart capture filtering for ChatGPT system + tool messages ([`9f24fb8`](https://github.com/shubhsaxena2020/cortex/commit/9f24fb8))
- 198 tests passing; build green; v0.2 P0 #4 (search latency) is next

Roadmap: [`v0.2-FULL-ROADMAP.md`](./v0.2-FULL-ROADMAP.md) (Council-vetted).

---

## Table of contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Running in dev mode](#running-in-dev-mode)
- [Building & packaging](#building--packaging)
- [The Chrome extension](#the-chrome-extension)
  - [Install (developer mode)](#install-developer-mode)
  - [Pair with the desktop app](#pair-with-the-desktop-app)
- [HTTP API reference](#http-api-reference)
- [Architecture](#architecture)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## Requirements

| | Required | Recommended | Notes |
|---|---|---|---|
| **Node.js** | ≥ 20.x | 22.x | Comes with npm. |
| **Ollama** | optional | install for semantic search | Enables vector embeddings. Without it, search degrades to keyword/LIKE matching. |
| **Chrome / Chromium** | optional | for the extension | Manifest V3. Edge & Brave work too. |
| **OS** | Windows / macOS / Linux | | Currently tested on Windows 11. |

To enable semantic search after installing Ollama:

```bash
ollama pull all-minilm     # ~22 MB, 384-dim embedding model
```

---

## Quick start

### Install the prebuilt app (Windows)

1. Grab the latest `Cortex Setup <version>.exe` from the [Releases](https://github.com/shubhsaxena2020/cortex/releases) page.
2. Run the installer. **On first launch Windows will show "Windows protected your PC" (SmartScreen)** because the installer is unsigned for v0.1. Click **More info → Run anyway**.
3. The app opens. Pick a folder to use as your vault when prompted.
4. (Optional) Install [Ollama](https://ollama.com/download) and pull the embedding model to enable semantic search:
   ```bash
   ollama pull all-minilm
   ```
   Without Ollama, search degrades cleanly to keyword/LIKE matching.

### Build from source

```bash
git clone https://github.com/shubhsaxena2020/cortex.git
cd cortex
npm install
npm run dev
```

The app opens. Create your first memory with **Ctrl+N**.

---

## Running in dev mode

```bash
npm run dev
```

This runs `electron-vite dev` — hot reload for the renderer (React), full restart for the main process (Node) on `Ctrl+C` + rerun. The HTTP API for the browser extension starts automatically on `127.0.0.1:48729` (or the next free port in 48729–48738; fallback ephemeral).

**Keyboard shortcuts:**

| Shortcut | Action |
|---|---|
| `Ctrl+N` | New memory |
| `Ctrl+1` | Notes view |
| `Ctrl+2` | Graph view |
| `Ctrl+3` / `Ctrl+K` | Search |
| `Ctrl+,` | Settings |
| `Ctrl+S` | Force-save (auto-saves on idle anyway) |

---

## Building & packaging

```bash
npm run build              # type-check + bundle main, preload, renderer
npm run release            # build + electron-builder package
```

Output lands in `release/`. Configure target platforms in [`electron-builder.json`](electron-builder.json).

> **Native modules:** `better-sqlite3` and `sqlite-vec` are native. The `postinstall` hook runs `electron-builder install-app-deps` to rebuild them against Electron's Node ABI. If you change Electron's version, rerun `npm run postinstall`.

---

## The Chrome extension

The extension lives in [`extension/`](extension/) at the repo root. It's a Manifest V3 unpacked extension that talks to the desktop app over a local HTTP server (bearer-token auth, never leaves localhost).

### Install (developer mode)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** → select the `extension/` directory.
4. Pin the extension icon to the toolbar.

### Pair with the desktop app

Two-click handshake (either order works):

1. In the **extension popup**, click **⚙ → "Connect to App"**.
2. In the **desktop app**, press `Ctrl+,` → click **"Pair Extension"**.

Within 2 seconds, the popup shows **"Paired ✓"** and your recent memories appear. The token is single-use within a 60-second window — once paired, the window closes immediately.

**Right-click flow:** with the extension paired, select text on any web page (especially claude.ai / chatgpt.com / gemini.google.com), right-click → **"Save to Cortex"**. The source is auto-detected from the page URL. The extension icon flashes a colored badge:

| Badge | Meaning |
|---|---|
| Green ✓ | Saved |
| Amber ? | Not paired |
| Amber ! | Token rejected — re-pair |
| Red ✗ | App not running or save failed |

If you want to start over: `chrome.storage.local.clear()` in the popup's DevTools console.

---

## HTTP API reference

Base URL: `http://127.0.0.1:<port>` (port from `%APPDATA%/cortex/extension-config.json`).

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | none | Liveness probe. Returns `{ok, app, version, apiVersion}`. |
| `GET` | `/pair` | none | Single-use within an explicitly-armed 60s window. Returns `{token}`. |
| `GET` | `/api/search?q=&source=&tags=` | Bearer | LIKE-search memories. `tags` is comma-separated; all must match. |
| `GET` | `/api/recent?limit=10` | Bearer | Most recently updated, capped at 50. |
| `GET` | `/api/related?context=<text>` | Bearer | Semantic KNN if Ollama + sqlite-vec are available; keyword fallback otherwise. Returns `{results, keywords}`. |
| `POST` | `/api/memories` | Bearer | Body: `{title, content, source, tags}`. Fires async embedding write. Returns `201 {memory}`. |
| `DELETE` | `/api/memories/:id` | Bearer | Removes the memory + its vector + fts entry. `204` on success, `404 NOT_FOUND` if no such id. |
| `GET` | `/api/admin/embed-status?ids=a,b` | Bearer | Returns `{vectorSearchEnabled, totalEmbedded, embedded, missing}` for the given ids (or globally if no ids). |

**Auth rules:**
- `Authorization: Bearer <64-char hex token>` on every `/api/*` route. Constant-time comparison.
- If `Origin` is present, it must start with `chrome-extension://`. If absent (Chrome quirk for extension popup fetches to `host_permissions` URLs), the request is allowed if the token is valid.
- Body size limit: 10 MB.

**Error envelope:** `{error: string, code: 'MISSING_TOKEN' | 'INVALID_TOKEN' | 'INVALID_ORIGIN' | 'NOT_FOUND' | 'PAIRING_NOT_ARMED'}` with appropriate HTTP status.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Chrome extension (Manifest V3)                               │
│  ┌────────────────┐    ┌──────────────────────────────────┐  │
│  │ service worker │    │ popup                            │  │
│  │ - port probe   │◄──►│ - search, copy, pair, save-flow  │  │
│  │ - pair polling │    │                                  │  │
│  │ - ctx menu save│    │                                  │  │
│  └────────┬───────┘    └──────────────────────────────────┘  │
└───────────┼───────────────────────────────────────────────────┘
            │ fetch http://127.0.0.1:<port>/api/*
            │ Authorization: Bearer <token>
            ▼
┌───────────────────────────────────────────────────────────────┐
│  Electron desktop app                                         │
│                                                               │
│  Main process (Node)                                          │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ index.ts        — app lifecycle, IPC, single-inst lock  │ │
│  │ http.ts         — Fastify; buildApp() + startHttpServer │ │
│  │ db.ts           — better-sqlite3 + sqlite-vec (vec0)    │ │
│  │ embeddings.ts   — Ollama client (lazy, optional)        │ │
│  │ extension-config.ts — token + port persistence           │ │
│  │ seed-embeddings.ts — backfill on startup                │ │
│  │ transformers.ts — row → API/IPC shape, highlight escape │ │
│  └────────────────────┬────────────────────────────────────┘ │
│                       │ contextBridge (preload)              │
│                       ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Preload (sandbox bridge)                                │ │
│  │ Exposes window.electron.{memories,relationships,         │ │
│  │   extension,events} to the renderer                     │ │
│  └────────────────────┬────────────────────────────────────┘ │
│                       │ contextIsolation: true               │
│                       ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Renderer (React + Zustand)                              │ │
│  │ Sidebar | Editor | Graph (D3) | Search | Settings       │ │
│  └─────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │  Ollama (optional)│
                         │  127.0.0.1:11434  │
                         │  all-minilm 384d  │
                         └──────────────────┘
```

**Data flow for a memory save from the extension:**

1. Right-click on a page → context menu → `chrome.contextMenus.onClicked` in service worker
2. Service worker POSTs to `http://127.0.0.1:<port>/api/memories` with bearer token
3. Fastify route handler validates auth, calls `db.createMemory()`
4. Synchronous SQLite write completes; response returns to extension
5. **Fire-and-forget**: in parallel, `embedAndStore()` POSTs the text to Ollama, gets a 384-dim vector, writes it to `memory_vectors` (sqlite-vec virtual table)
6. Server broadcasts `memories:changed` IPC event to all open windows
7. React renderer's `App.tsx` listener calls `fetchMemories()` — sidebar updates in real time

**Storage paths** (Windows):

| File | Path |
|---|---|
| Main database | `%APPDATA%/cortex/memories.db` |
| Extension config | `%APPDATA%/cortex/extension-config.json` |

---

## Testing

```bash
npm test              # vitest run — 51 tests
npm run test:watch    # vitest watch mode
```

Test layout:

| File | What it covers | Runtime |
|---|---|---|
| [`src/main/transformers.test.ts`](src/main/transformers.test.ts) | Pure functions: `toMemory`, `toRelationship`, `makeHighlight` (incl. XSS-escape) | Plain Node |
| [`src/main/http.test.ts`](src/main/http.test.ts) | All HTTP routes via Fastify's `inject()`, with `db` + `embeddings` mocked | Plain Node |
| [`src/main/embeddings.test.ts`](src/main/embeddings.test.ts) | Ollama client with stubbed `global.fetch` | Plain Node |
| [`src/main/db.test.disabled.ts`](src/main/db.test.disabled.ts) | Full db.ts CRUD against `:memory:` SQLite | **Disabled** — see file header for the rebuild ritual |
| [`scripts/integration-tests.mjs`](scripts/integration-tests.mjs) | End-to-end against the running app + real DB + real Ollama | Plain Node, **app must be running** |
| [`scripts/api-smoke-tests.mjs`](scripts/api-smoke-tests.mjs) | All endpoints over real HTTP, real auth, real round-trips | Plain Node, **app must be running** |
| [`scripts/final-phase3-report.mjs`](scripts/final-phase3-report.mjs) | Runs the two above + writes `FINAL_PHASE3_REPORT.md` | Plain Node |

**Why `db.test.disabled`?** `better-sqlite3` is rebuilt for Electron's Node ABI (125) by the postinstall step. Plain `node` is ABI 127 and can't load the .node binary. Real DB coverage lives at the integration layer where the right binary is loaded by the live Electron process. To run the unit tests anyway: `npm rebuild better-sqlite3` → enable the file → `npm test` → `npm run postinstall` to restore.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `NODE_MODULE_VERSION` mismatch error on `npm run dev` | better-sqlite3 not rebuilt for Electron | `npm run postinstall` |
| Extension popup says "App not running" | Server not listening on a port in 48729–48738 | Confirm `npm run dev` is running; check terminal for `[cortex] extension API on http://...` |
| Pair button does nothing | SW dead from a previous session | Reload extension at `chrome://extensions` |
| `[db] sqlite-vec unavailable` in terminal | Native binary missing for your platform | Falls back to keyword search; verify `npm install sqlite-vec` ran cleanly |
| `[seed] skipped (ollama-unavailable)` | Ollama not running | `ollama serve` or launch Ollama desktop; then create a new memory to trigger embed |
| `[seed] skipped (model-not-pulled)` | `all-minilm` not in Ollama | `ollama pull all-minilm` |
| Search returns no semantic results | Embeddings haven't backfilled yet | Wait for `[seed] done` log on startup |

For deeper diagnosis: open DevTools in the app (`Ctrl+Shift+I`), check the main process terminal output, and the extension service worker logs at `chrome://extensions` → Inspect views: service worker.

---

## License

MIT. See [`LICENSE`](LICENSE) if present (or treat the repo as MIT by default).
