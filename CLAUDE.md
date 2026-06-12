# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # start Electron app in dev mode (electron-vite + hot reload)
npm run build        # compile all three processes for production
npm run release      # build + package with electron-builder (outputs to release/)
npm test             # run Vitest once (non-interactive)
npm run test:watch   # Vitest in watch mode
npx vitest run src/main/transformers.test.ts  # run a single test file
```

## Architecture

Cortex is an **Electron desktop app** with three separate processes that each have distinct boundaries.

### Process layout

| Process | Entry | Role |
|---|---|---|
| Main | `src/main/index.ts` | Node.js: DB, IPC handlers, HTTP server, embeddings |
| Preload | `src/preload/index.ts` | Context bridge — only file that can touch both worlds |
| Renderer | `src/renderer/src/main.tsx` | React UI — no direct DB or Node access |

Shared types live in `src/types/index.ts` and are imported by all three.

### Data flow

The renderer never calls SQLite directly. Every operation goes through:

```
Renderer (window.electron.*) → IPC → main/index.ts handlers → db.ts → SQLite
```

`window.electron` is typed as `ElectronAPI` (defined in `src/types/index.ts`). The preload script in `src/preload/index.ts` is the only place that wires `ipcRenderer.invoke` to that interface via `contextBridge`.

### Main process modules

- **`db.ts`** — all SQLite access. Three regular tables (`memories`, `memory_relationships`, `fts_memories`) plus an optional `memory_vectors` virtual table (sqlite-vec). Initialised once by `initDb()` at app start; subsequent calls are no-ops.
- **`transformers.ts`** — pure functions that map raw DB rows to the `Memory`/`Relationship` shapes used by the API and renderer. Tags are stored as JSON strings in SQLite and parsed here. This is the only layer currently covered by unit tests.
- **`http.ts`** — Fastify server that exposes the browser extension API on `127.0.0.1`. Accepts only `chrome-extension://` origins plus tokenless requests (Chrome extensions omit `Origin` on host-permission fetches). Bearer token auth for every route except `/health` and `/pair`.
- **`extension-config.ts`** — manages the token and port written to `userData/extension-config.json`. Port is probed in range 48729–48738 then falls back to an ephemeral OS port.
- **`embeddings.ts`** — calls a local Ollama instance (`all-minilm`, dim 384) for vector embeddings. Every function returns `null` silently if Ollama is unreachable; callers fall back to keyword search automatically.
- **`seed-embeddings.ts`** — on startup, backfills embeddings for any memory that lacks one. Runs fire-and-forget; does not block window creation.

### Optional vector search

sqlite-vec is loaded best-effort during `initDb()`. If it fails (missing native module, ABI mismatch, etc.) `hasVectorSearch()` returns `false` and all vector paths are bypassed. `/api/related` then uses keyword frequency ranking instead. The same degradation applies if Ollama is down.

### Extension pairing

`/pair` is a public endpoint (no token required) but is only live during a time-limited window opened by the Settings page ("Pair Extension" button). The window is set via `armPairing()` and immediately closed after the first successful pair. The token returned is written into the browser extension's storage.

### Renderer

The renderer is a single-page Zustand app (`src/renderer/src/store.ts`) that renders one of four views (`editor`, `graph`, `search`, `settings`) based on `currentView`. Navigation is keyboard-driven (Ctrl+1/2/3/,).

The store subscribes to `memories:changed` events pushed from the main process so that memories created by the browser extension appear in real time without polling.

### Testing

Vitest runs in `node` environment and picks up `src/**/*.test.ts`. The PostToolUse hook in `.claude/settings.local.json` runs `npm test` automatically after every file edit. New test files need no config changes.

## Cortex Second Brain — Live Context

The project knowledge base lives in `%APPDATA%\Cortex\memories.db` (13 `project_seed` memories).
Claude Code can query it directly at any time — no app required.

**Preferred: MCP tools.** The `cortex` MCP server is registered project-scoped in `.mcp.json`
(and globally in `claude_desktop_config.json`). Use `cortex_search` / `cortex_get_memory` /
`cortex_list_memories` / `cortex_create_memory` / `cortex_related` / `cortex_stats` as native
tool calls — keyword (FTS5) and semantic (Ollama + sqlite-vec) search both work. See `mcp/README.md`.

**Fallback: shell dump (works in any context, no MCP needed):**
```
node scripts/run-as-node.cjs scripts/cortex-dump.mjs
```

**Keyword search mid-session:**
```
node scripts/run-as-node.cjs scripts/cortex-dump.mjs "auto-edges"
node scripts/run-as-node.cjs scripts/cortex-dump.mjs "constraint"
```

**Tag filter:**
```
node scripts/run-as-node.cjs scripts/cortex-dump.mjs --tags "bug,open-issue"
node scripts/run-as-node.cjs scripts/cortex-dump.mjs --tags "architecture"
```

Run the dump at the start of any session that touches Cortex code so current constraints,
open issues, and roadmap decisions are in context. The dump output is self-contained
markdown — safe to paste into any Claude chat as well.
