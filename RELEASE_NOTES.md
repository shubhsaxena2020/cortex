# Cortex v0.1.0-beta — Pre-Release (Infrastructure)

> **This is a GitHub Pre-Release, not the latest release.** v0.1.0 ships the plumbing — Electron app, sqlite-vec storage, Chrome extension capture pipeline, Ollama integration, D3 graph. The user-visible *intelligence* (dedup, summarization, auto-tagging, performance) lands in v0.2. If you're looking for a finished product, come back in Q3 2026 for v0.2. If you want to see how the pipeline works or stress-test the capture flow, you're in the right place.

Privacy-first desktop app: captures AI conversations from Claude, ChatGPT, and Gemini into a local knowledge graph. Nothing leaves your machine.

## What works in v0.1.0-beta

- **Local-only memory store** — better-sqlite3 + sqlite-vec for vector search, FTS5 for keyword fallback. No cloud, no telemetry.
- **Chrome extension capture** — browser extension talks to the app over `127.0.0.1` and saves AI conversations to your vault as Markdown.
- **Extension pairing handshake** — `GET /health` returns `{ app: 'cortex' }`; the extension only trusts a server that returns that exact handshake. Bearer-token auth on every other route.
- **Vault on disk** — your data lives as plain files in a folder you pick. Cortex never copies or moves files; it indexes them in place.
- **Knowledge graph** — D3 force-directed view of memories + watched files + relationships.
- **Ollama integration (optional)** — local `all-minilm` model (384-dim) for semantic search. Silent fallback to keyword search if Ollama is down or sqlite-vec fails to load.
- **Watch folder** — point at any existing folder; Cortex auto-indexes the text files into the graph.

## Stack

Electron 31 · React 18 · TypeScript 5 · Tailwind 3 · better-sqlite3 12 · sqlite-vec 0.1 · Fastify 5 · D3 7 · Zustand 4 · Vitest 4. **128/128 tests passing.**

## Try it (developer install, ~10 minutes)

> The Windows installer is unsigned in this beta. SmartScreen will warn — that's expected. Code-signing is on the v0.4 distribution-polish list.

1. Download `Cortex Setup 0.1.0.exe` (~83 MB) from the assets below and run it. Click **More info → Run anyway** on the SmartScreen prompt.
2. Launch Cortex. First run routes you to **Settings** to pick a vault folder.
3. (Recommended) Install [Ollama](https://ollama.com/download) and run `ollama pull all-minilm` for semantic search. Without it you get keyword search, which still works.
4. Install the Chrome extension unpacked — see [`EXTENSION_SETUP.md`](./EXTENSION_SETUP.md). Web Store listing is v0.4.
5. In Settings, click **Pair Extension**; open the extension popup and authorize within 60 seconds.
6. Start a conversation on claude.ai / chatgpt.com / gemini.google.com. It auto-saves to your vault. Open **Graph** to see it.

## Honest limitations

- **Windows-only installer.** macOS DMG + Linux AppImage shipped in v0.4 (gated by Apple Developer enrollment + Windows code cert — see ROADMAP.md).
- **Installer unsigned.** SmartScreen warning is real. Fix is v0.4, costs ~$300/yr in certs.
- **Extension load-unpacked only.** Chrome Web Store listing is v0.4.
- **No installer smoke test on a third party's machine yet.** If it crashes on yours, that's a v0.1.0 bug — please file an issue.
- **Graph slows past ~8000 nodes.** LOD + viewport culling lands in v0.2.
- **Duplicate captures.** Same conversation scraped twice creates two memories. Dedup is v0.2 P0.
- **No summarization / auto-tagging.** v0.3.
- **DB integration tests parked** (`src/main/db.test.disabled.ts`) due to better-sqlite3 ABI mismatch between Electron's Node (125) and vitest's Node (127). The DB code is covered end-to-end by `scripts/integration-tests.mjs` against the live Electron process. Proper fix (vitest-electron) is v0.3.

## What v0.1.0-beta is asking for

Not press. Not stars (although the URL appreciates them). **Install reports.**
- Did the installer run on your machine?
- Did the extension pair on the first try?
- Did your first captured conversation appear in the Notes view?

That's it. File issues with that level of detail and you've contributed more than any feature request can right now.

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for the full v0.2 → v1.0 plan. Reviewed via Claude Council; v0.2 was deliberately cut to 5 P0 items.

---

Issues / questions: <https://github.com/shubhsaxena2020/cortex/issues>
