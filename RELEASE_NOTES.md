# Cortex v0.1.0 — Privacy-First Knowledge Graph

Privacy-first desktop application with local AI inference and an auto-captured conversation knowledge graph. Everything stays on your machine.

## What's in v0.1.0

This is the infrastructure release — the plumbing for everything Cortex will become. v0.2+ layers the user-visible intelligence on top.

### Features

- **Local-only memory store** — better-sqlite3 + sqlite-vec for vector search, FTS5 for keyword fallback. No cloud, no telemetry.
- **Chrome extension capture** — browser extension talks to the app over `127.0.0.1` and saves AI conversations (Claude, ChatGPT, Gemini) to your vault as Markdown.
- **Extension pairing handshake** — `GET /health` returns `{ app: 'cortex' }`; extension only trusts a server that returns that exact handshake. Bearer-token auth on every other route.
- **Vault on disk** — your data lives as plain files in a folder you pick (default suggestion: `cortex_brain`). Cortex never copies or moves files; it indexes them in place.
- **Knowledge graph** — D3 force-directed visualisation of memories + watched files + the relationships between them.
- **Ollama integration** — local `all-minilm` model (384-dim) for semantic search. Falls back silently to keyword search if Ollama is down or sqlite-vec fails to load.
- **Watch folder** — point at any existing folder (Downloads, a project, your notes) and Cortex auto-indexes the text files into the graph.

### Stack

- Electron 31 · React 18 · TypeScript 5 · Tailwind 3
- better-sqlite3 12 · sqlite-vec 0.1 · Fastify 5
- D3 7 · Zustand 4 · react-markdown · highlight.js
- Vitest 4 — **128/128 tests passing**

### Getting started

1. Download `Cortex Setup 0.1.0.exe` (~83 MB) from the release assets and run it.
2. Launch Cortex. First run will route you to **Settings** to pick a vault folder.
3. (Optional, recommended) Install [Ollama](https://ollama.com/download) and `ollama pull all-minilm` for semantic search.
4. Install the Chrome extension (unpacked, from the `extension/` folder — see `EXTENSION_SETUP.md`).
5. In Settings, click **Pair Extension**, then open the extension popup and authorize within 60 seconds.
6. Start a conversation on claude.ai, chatgpt.com, or gemini.google.com. It auto-saves to your vault. Open the **Graph** tab to see it appear.

### Known limitations

- Windows-only installer in v0.1.0. macOS DMG / Linux AppImage targets are configured but not yet shipped — v0.2.
- Graph canvas slows down past ~8000 nodes; performance pass planned for v0.2.
- Semantic search requires Ollama; without it the app falls back to FTS keyword matching (which works fine, just less smart).
- DB integration tests (`src/main/db.test.disabled.ts`) are parked due to `better-sqlite3` ABI mismatch between Electron's Node and stock Node. The DB code is covered end-to-end by `scripts/integration-tests.mjs` against the live Electron process. Proper fix (vitest-electron) is on the v0.2 list.
- Chrome Web Store listing not yet published — load unpacked for now.

### Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for v0.2 → v1.0 plans (reviewed via Claude Council).

---

Issues / questions: <https://github.com/shubhsaxena2020/cortex/issues>
