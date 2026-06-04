# Cortex Roadmap

> Living document. Phase tags are intent, not contract.

## v0.1.0 — Infrastructure (current ✅)

- [x] Electron 31 + React 18 + TypeScript scaffold (3-process boundary: main / preload / renderer)
- [x] better-sqlite3 + sqlite-vec storage with FTS5 fallback
- [x] Ollama `all-minilm` embeddings (384-dim) with silent degradation
- [x] Chrome MV3 extension + Fastify pairing handshake (`body.app === 'cortex'`)
- [x] Vault folder + chokidar watch folder
- [x] D3 knowledge graph
- [x] Settings UI with AI status, vault, watch folder, pairing
- [x] 128/128 unit + integration tests
- [x] NSIS Windows installer
- [x] First GitHub Release

## v0.2.0 — "It feels smart" (next)

Goal: the app stops being a glorified file index and starts earning the word *cortex*.

### Capture quality
- [ ] **Conversation deduplication** — same Claude chat scraped twice shouldn't create two memories
- [ ] **Smart capture filtering** — skip empty / single-message / system-error chats
- [ ] **Conversation summarization** — one-line + paragraph summary via local Ollama (`llama3.2:3b` or similar)
- [ ] **Auto-tagging** — extract topical tags from content; user can edit/lock tags

### Performance
- [ ] **Graph rendering for 8000+ nodes** — viewport culling, level-of-detail, web worker for force simulation
- [ ] **Embedding backfill UI** — show progress, allow pause/resume
- [ ] **First-search latency** — < 200ms p95 on a 10k-memory vault

### Test infrastructure
- [ ] **`db.test.disabled.ts` → vitest-electron** — proper Electron-Node test runner so the disabled DB integration tests run in CI

### Distribution
- [ ] **macOS DMG** signed + notarized
- [ ] **Linux AppImage**
- [ ] **Chrome Web Store** listing for the extension
- [ ] **Auto-update** via electron-updater + GitHub releases

## v0.3.0 — Polish

- [ ] Multi-model Ollama picker (let user swap embedding + summarization models)
- [ ] Export graph as PNG / SVG / PDF
- [ ] Saved searches / smart folders
- [ ] Dark / light theme toggle (currently dark-only)
- [ ] Keyboard navigation through graph
- [ ] Settings UI polish pass (a11y audit, focus traps, reduced-motion)

## v0.4.0 — Connect

- [ ] Bidirectional links between memories (Markdown `[[wiki]]` style)
- [ ] Backlinks panel
- [ ] Daily / weekly digest view
- [ ] Local web companion (read-only) on the LAN
- [ ] Optional encrypted sync between two of your own machines (no cloud middleman — Syncthing-style)

## v1.0.0 — Stable

- [ ] Documented public API for plugins (custom capturers, custom extractors)
- [ ] Performance benchmark suite checked into CI
- [ ] Migration story for schema changes
- [ ] First-class support for non-AI sources (Markdown editors, RSS, email-to-vault)
- [ ] Comprehensive user docs + screencast

## Out of scope (explicitly)

- Cloud-hosted vault — Cortex is local-first by design. Optional encrypted P2P sync only.
- Telemetry / analytics — not now, not ever.
- Mobile clients — out of scope for at least the first year.
- LLM hosting — we integrate with Ollama; we do not ship inference.
