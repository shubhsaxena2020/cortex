# Cortex MCP Server

Exposes the Cortex second brain (`%APPDATA%\Cortex\memories.db`) to MCP clients —
Claude Code, Claude Desktop, or anything speaking MCP over stdio — as native tool calls.

## Tools

| Tool | What it does |
|---|---|
| `cortex_search` | FTS5 keyword or sqlite-vec semantic search (`mode: auto\|keyword\|semantic`); semantic embeds the query via local Ollama (`all-minilm`, 384d) and falls back to keyword when Ollama is down |
| `cortex_get_memory` | One memory by id — full content + graph relationships |
| `cortex_list_memories` | Recent memories, filterable by tags / source |
| `cortex_create_memory` | Save a memory (source `mcp`), embedded immediately when Ollama is up; auto-edges build at next app startup |
| `cortex_related` | Graph neighbors with edge strength + signal type |
| `cortex_stats` | Counts by source/signal, embedding coverage, top tags |

## Architecture

```
mcp/core.mjs    pure protocol + tool logic (DI ctx) — unit-tested in src/main/mcp-core.test.ts
mcp/server.mjs  shell: better-sqlite3 + sqlite-vec + Ollama + stdio loop
mcp/smoke.mjs   end-to-end harness (spawns the real server, runs every tool)
```

Two deliberate decisions:

1. **Zero new dependencies.** MCP stdio is newline-delimited JSON-RPC 2.0; the three
   methods we need (`initialize`, `tools/list`, `tools/call`) are ~80 lines to dispatch.
   Installing `@modelcontextprotocol/sdk` would trigger `postinstall` →
   `electron-builder install-app-deps` → native-module rebuild churn for no gain.
2. **Runs under Electron-as-Node.** `better-sqlite3` in this repo is compiled for
   Electron's ABI; system Node cannot load it. Clients must launch the server as
   `electron.exe mcp/server.mjs` with `ELECTRON_RUN_AS_NODE=1`.

## Registration

Already registered in:

- `C:\Users\shubh\.claude\claude_desktop_config.json` (Claude Desktop)
- `.mcp.json` in this repo (Claude Code, project-scoped)

```json
"cortex": {
  "command": "C:\\Users\\shubh\\cortex\\node_modules\\electron\\dist\\electron.exe",
  "args": ["C:\\Users\\shubh\\cortex\\mcp\\server.mjs"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" }
}
```

Env overrides: `CORTEX_DB_PATH`, `OLLAMA_URL`, `CORTEX_EMBED_MODEL`.

## Verify

```
node scripts/run-as-node.cjs mcp/smoke.mjs   # full handshake + every tool against the real DB
npx vitest run src/main/mcp-core.test.ts     # 31 unit tests for the pure core
```

## Concurrency notes

- The server opens the same WAL database as the running app; reads never block.
  Writes (`cortex_create_memory`) wait up to 3 s (`busy_timeout`) for the app's writer lock.
- Memories created here appear in the running app after its next data refresh
  (the `memories:changed` push only fires for app-internal writes).
