# Cortex

[![tests](https://img.shields.io/badge/tests-453%20passing-brightgreen)](#testing)
[![release](https://img.shields.io/badge/release-v0.5.0-blue)](https://github.com/shubhsaxena2020/cortex/releases/tag/v0.5.0)
[![license](https://img.shields.io/badge/license-MIT-blue)](#)

A privacy-first, local-first second brain. Captures AI conversations from Claude / ChatGPT / Gemini via a Chrome extension, extracts atomic learnings via local Ollama, surfaces them as a daily digest, makes the whole thing queryable from your terminal (`cortex`) and from Claude itself (MCP server). No cloud, no telemetry, no account.

## Status — v0.5.0 (2026-06-13)

**Latest release:** [v0.5.0 — "The brain that thinks back"](https://github.com/shubhsaxena2020/cortex/releases/tag/v0.5.0)

What's in it now (cumulative through v0.5):

- **Capture** — Chrome extension catches Claude.ai + ChatGPT conversations; canonical-URL dedup so the same chat captured twice updates one memory instead of forking the graph.
- **Search** — FTS5 keyword + sqlite-vec semantic (Ollama `all-minilm`, 384d). Sub-100ms p95 on 10k memories; degrades silently to keyword when Ollama is down.
- **Graph** — D3 force layout off the main thread in a Web Worker; 125k+ nodes settled at **133 FPS** (7.5 ms/frame) on the far-zoom view. Cluster discs, bundled edges, density-override LOD, flat-fill fast path.
- **Wiki links + backlinks** — `[[Title]]` syntax persists as graph edges; "Linked mentions" panel on every memory.
- **Auto-tagging** — deterministic title-weighted heuristic tagger (offline, no Ollama needed) with lock semantics so user edits aren't clobbered on re-capture.
- **Summarization** — Ollama (`llama3.2:3b`) generates one-line + paragraph summaries per memory, cached by content hash. MCP search responses return summaries by default to fit LLM contexts.
- **Atomic learnings** — after capture, Ollama extracts up to 5 short sentences capturing what was concluded/decided. Each becomes a first-class memory (`source='derived'`, `derived_from=<parent>`). Digest reads from learnings; parents stay as substrate.
- **Daily journal** (Ctrl+5) — one entry per day, first-class memory, paired with the digest in the UI. `cortex journal --edit` opens `$EDITOR`.
- **Pinned memories** — star toggle, prepended to every MCP search envelope and the sidebar top.
- **Daily / weekly digest** (Ctrl+4 + `cortex digest`) — grouped by top tag, one-line summaries, two-second morning-coffee read.

See full per-version notes in [`RELEASE_NOTES.md`](./RELEASE_NOTES.md). Architecture reasoning per version in [`docs/V04-THINKING.md`](./docs/V04-THINKING.md) and [`docs/V05-THINKING.md`](./docs/V05-THINKING.md).

> **Screenshots coming** — the app surfaces (graph, digest, journal, detail panel with learnings) are stable as of v0.5 but screenshots haven't been added to the README yet.

## How it gets used

There are three surfaces, deliberately. Pick whichever fits the moment:

```text
┌─────────────────────────────────────────────────────────────────┐
│  Electron app  — graph, sidebar, editor, digest, journal,       │
│                  detail panel with learnings + backlinks        │
├─────────────────────────────────────────────────────────────────┤
│  cortex CLI    — terminal companion. search, recent, digest,    │
│                  journal, add, pin, export. Pipeable.           │
├─────────────────────────────────────────────────────────────────┤
│  MCP server    — 11 tools over stdio. Claude Code + Claude      │
│                  Desktop reach into the second brain mid-chat.  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Table of contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Using the `cortex` CLI](#using-the-cortex-cli)
- [Connecting the MCP server to Claude](#connecting-the-mcp-server-to-claude)
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
2. Run the installer. **On first launch Windows will show "Windows protected your PC" (SmartScreen)** because the installer is unsigned (code-signing is deferred — see v0.4 thinking doc). Click **More info → Run anyway**.
3. The app opens. Pick a folder to use as your vault when prompted.
4. (Optional but recommended) Install [Ollama](https://ollama.com/download) and pull two models:
   ```bash
   ollama pull all-minilm    # 384d embeddings — semantic search
   ollama pull llama3.2:3b   # summaries + atomic learning extraction
   ```
   Without Ollama, search degrades to keyword, summaries don't generate, and learning extraction is a no-op. Everything else still works.

### Build from source

```bash
git clone https://github.com/shubhsaxena2020/cortex.git
cd cortex
npm install
npm run dev
```

The app opens. Create your first memory with **Ctrl+N**.

---

## Using the `cortex` CLI

The CLI ships in `cli/` and works from a built repo. It speaks to the same SQLite DB the app uses, so you can use both interchangeably.

```bash
# From the repo root, without PATH setup:
npm run cortex -- search "auth flow"
npm run cortex -- digest
npm run cortex -- journal "what stuck with me today"

# Or add cli/ to your PATH so `cortex` works from anywhere:
#   Windows (PowerShell): $env:PATH = "C:\path\to\cortex\cli;$env:PATH"
#   Bash:                 export PATH="$HOME/cortex/cli:$PATH"
cortex search "sqlite migration" --mode semantic --limit 5
cortex recent --tag rust --limit 20
cortex add "scheduler-by-priority idea from podcast" --tag idea
echo "thought from stdin" | cortex add
cortex pin <id>
cortex export <id> --format md
```

Run `cortex help` for the full command list. The CLI is pre-v7-DB tolerant (it won't break if you haven't launched the Electron app since installing), and it auto-detects whether sqlite-vec and Ollama are available.

---

## Connecting the MCP server to Claude

The MCP server (`mcp/server.mjs`) exposes 11 tools that let Claude reach into your Cortex DB mid-conversation: `cortex_search`, `cortex_get_memory`, `cortex_list_memories`, `cortex_create_memory`, `cortex_related`, `cortex_stats`, `cortex_digest`, `cortex_pinned`, `cortex_pin`, `cortex_extract`, `cortex_journal`.

### Claude Code (project-scoped)

The repo ships an `.mcp.json` that registers `cortex` automatically. From any Claude Code session in the repo:

```text
Use the cortex_search tool to find what I've captured about X.
```

### Claude Desktop (global)

Add this to `claude_desktop_config.json` (the path varies by OS — see the [MCP docs](https://modelcontextprotocol.io/quickstart/user)). Adjust the absolute paths to wherever you cloned the repo:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "C:\\path\\to\\cortex\\node_modules\\electron\\dist\\electron.exe",
      "args": ["C:\\path\\to\\cortex\\mcp\\server.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

The server must run under Electron-as-Node because `better-sqlite3` is compiled for Electron's ABI; system Node can't load it.

Verify the server is healthy with the bundled smoke harness:

```bash
node scripts/run-as-node.cjs mcp/smoke.mjs
# Expected: 14/14 PASS on the 11-tool surface
```

See [`mcp/README.md`](./mcp/README.md) for the per-tool reference.

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
npm test              # vitest run — 453 tests, ~2s
npm run test:watch    # vitest watch mode

# Server / harness verification:
node scripts/run-as-node.cjs mcp/smoke.mjs        # MCP end-to-end (14/14 PASS)
node scripts/run-as-node.cjs cli/cortex.mjs stats # CLI sanity check
```

Test count grew from 264 (v0.2.0) → 453 (v0.5.0). The pure cores (DB transformers, FTS5 phrase quoting, summary parsing, learning extraction, digest grouping, wiki-link parsing, mention-edge building, MCP protocol dispatch) are all unit-tested under plain vitest. better-sqlite3 paths are covered by live-process scripts.

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
