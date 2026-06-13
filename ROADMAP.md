# Cortex Roadmap

> Living document. Phase tags are intent, not contract. Reviewed via Claude Council; see commit history for prior versions.

## What Cortex is (and what the roadmap is for)

The moat is the **capture pipeline**: a Chrome extension + Electron app that pulls AI conversations out of the walled gardens of Claude / ChatGPT / Gemini and stores them as plain Markdown in a local SQLite-backed knowledge graph. Search, graph view, and embeddings are *how you use* what was captured — they are not the differentiator.

Every phase below earns the right to exist by sharpening or extending that capture-to-retrieval loop. If a feature doesn't, it gets cut.

## v0.1.0 — Infrastructure (GitHub Pre-Release `v0.1.0-beta`)

The plumbing. Honestly framed: not the smart product yet.

- [x] Electron 31 + React 18 + TypeScript scaffold (3-process boundary: main / preload / renderer)
- [x] better-sqlite3 + sqlite-vec storage with FTS5 fallback
- [x] Ollama `all-minilm` embeddings (384-dim), **optional** — silent degradation to keyword search if absent
- [x] Chrome MV3 extension + Fastify pairing handshake (`body.app === 'cortex'`)
- [x] Vault folder + chokidar watch folder
- [x] D3 knowledge graph
- [x] Settings UI (AI status, vault, watch folder, pairing) with scroll fix
- [x] 128/128 unit + integration tests (DB integration suite parked behind ABI mismatch — covered by live-process script)
- [x] NSIS Windows installer
- [x] GitHub Pre-Release

## v0.2.0 — "The capture pipeline is correct, fast, and observable" ✅ SHIPPED (2026-06-05)

All five P0 items landed. Two items (Web-worker force simulation, embedding throughput) that were scoped as v0.3-or-deferred shipped early because the graph work demanded them. See `RELEASE_NOTES.md` for the full changelog and measured numbers.

- [x] **Conversation deduplication** — canonical-URL upsert (`upsertMemoryByUrl`); the same chat captured twice updates one memory in place instead of forking the graph.
- [x] **Smart capture filtering** — content-script skips empty / single-message / system+tool-only chats before they reach the app.
- [x] **Graph LOD + viewport culling** — quadtree culling + smooth label LOD, then a full Obsidian-style canvas redesign. **Shipped beyond scope:** force simulation moved to a Web Worker, and an O(memories×files) mention-edge explosion (1.35M edges → black canvas at 10k+5k scale) was root-caused via live DevTools-protocol inspection and fixed (inverted word→memory index, ~1k edges, ~0.4s build).
- [x] **<200 ms p95 search latency on a 10k-memory vault** — `searchMemories` swapped to FTS5 `MATCH` + `idx_memories_updated`. Measured p95 **86.6 ms** on 10k synthetic memories (target 200 ms).
- [x] **In-app feedback + opt-in, local-only usage log** — `telemetry.ts` (daily JSONL, PII-blocklist redaction, vault path hashed), feedback form, Settings view/export/clear. OFF by default; never leaves the machine. Verified end-to-end (toggle persistence, feedback file on disk) via live app inspection.

**Bonus shipped:** embedding seed parallelization (request-batching + concurrency + per-row fallback, ~2.1× with zero data loss); force-simulation Web Worker (physics off the main thread).

### v0.2 result

- 245/245 tests green · build clean · graph verified rendering live (6,603 non-background canvas pixels at 10k nodes, worker streaming).
- **Still open (external):** third-party Windows 11 smoke test of the installer — see `docs/SMOKE-TEST-CHECKLIST.md`.

## v0.3.0 — "It feels smart" ✅ SHIPPED (2026-06-13)

The features the name "Cortex" implies. Earns the right to exist after v0.2 proves the pipeline is correct.

Shipped 5 of 8 per the kill criteria, plus two items the criteria didn't anticipate: an MCP server (the second brain as native Claude tool calls) and a 100k-node graph performance overhaul.

- [x] **Bidirectional `[[wiki]]` links + backlinks panel** — Obsidian-style `[[Title]]` / `[[Title|alias]]`; edges persist as `signal_type='wiki'` (emerald), clickable in detail + editor previews, "Linked mentions" panel, FTS5-driven inbound re-resolution on create/retitle.
- [x] Auto-tagging from content; user can edit / lock tags — deterministic heuristic tagger (title-weighted keywords + existing-vocab preference, offline, no Ollama); first capture tags an untagged conversation, re-captures never clobber user edits; per-memory "suggest" button.
- [x] Embedding backfill UI — visible progress, pause/resume — status machine in seed-embeddings, live progress in status bar + Settings AI panel, pause at batch boundaries.
- [x] Saved searches / smart folders — search history (last 20) + named saved searches; date-range filters.
- [x] ~~Graph force simulation in a web worker~~ — **shipped in v0.2.0** (culling alone wasn't enough at 10k nodes)
- [ ] Conversation summarization via local Ollama → **slipped to v0.4**: requires a generative model dependency (`llama3.2:3b`) the embed-only Ollama setup doesn't have; not worth blocking the release on a second model pull.
- [ ] Multi-model Ollama picker → **slipped to v0.4**: settings plumbing with no user pull until summarization (the second model consumer) exists.
- [ ] `db.test.disabled.ts` → vitest-electron → **slipped to v0.4**: infra-only; current coverage of the DB layer via live-process scripts + 399 unit tests is adequate while feature surface moves fast.

### Shipped beyond scope (v0.3.0)

- **Cortex MCP server** (`mcp/`) — six tools over stdio JSON-RPC (keyword FTS5 + semantic sqlite-vec search, get/list/create/related/stats), zero new dependencies, runs under Electron-as-Node, registered for Claude Code (project `.mcp.json`) and Claude Desktop. The second brain is now queryable as native tool calls.
- **Graph performance overhaul to 100k+ nodes** — memory content no longer ships to the renderer (light projections + 200-char snippets + per-selection hydration); mention edges computed in the main process behind a fingerprint cache; worker simulation scales by node count (collide dropped ≥20k, Barnes-Hut theta 1.2, adaptive cooling/batching) with a zero-copy typed-array protocol; density-based LOD (clusters whenever >8k nodes are on screen, any zoom); flat-fill fast path above 1.5k visible nodes (no per-node shadowBlur); memoized clustering; quadtree-local edge hover above 20k links. Measured numbers in RELEASE_NOTES.md.

## v0.4.0 — "Cortex finds you, not the other way around" ✅ SHIPPED (2026-06-13)

Pivoted hard from the original v0.4 scope ("polish + distribution"). See [docs/V04-THINKING.md](docs/V04-THINKING.md) for the full reasoning. The TL;DR: code signing and themes don't make a second brain indispensable; making it reach the user from outside the Electron window does. After v0.3 unlocked the MCP server, v0.4 doubles down on that inversion.

- [x] **`cortex` CLI** — terminal companion sharing the MCP query layer. `search`, `recent`, `digest`, `export`, `stats`, `tags`, `pinned`, `pin`/`unpin`. Pipeable, greppable, hooks into the same FTS5 / sqlite-vec / Ollama stack. Both Bash and CMD launchers; `npm run cortex` works locally.
- [x] **Local Ollama summarization** (`llama3.2:3b`). One-line (≤20 words) + paragraph (≤80 words) per memory, cached in `memory_summaries` keyed on content hash. Backfill UI in Settings; MCP `cortex_search` and `cortex_get_memory` return summaries by default — the bandwidth fix that makes the second brain composable with limited LLM contexts.
- [x] **Daily / weekly digest** (`cortex digest` + in-app Digest view, Ctrl+4). Grouped by top tags, summarized one-liners, clickable to drill into the editor. Pulled forward from v0.5 because the digest is what makes the app a daily habit.
- [x] **Pinned memories** ("always-relevant context"). Per-memory star toggle in the detail panel; pinned set surfaces at the top of the sidebar and prepended to every MCP `cortex_search` envelope. The user-IS surface the 13 seed memories revealed was missing.
- [x] **Medium-zoom edge LOD** — graph perf top-up from v0.3. Edge strength threshold rises with visible-edge count; mention edges drop above 4k visible nodes. Buys back the remaining sad zoom band.
- [x] **MCP server v0.4** — three new tools (`cortex_digest`, `cortex_pinned`, `cortex_pin`), summary-first result envelopes, pinned-context prepend on every search.

### Slipped to v1.0 (calling it explicitly)
- macOS DMG signed + notarized — no users on Mac yet; pay when there are.
- Windows code-signing certificate — same.
- Auto-update via electron-updater — needs signed builds first.
- Linux AppImage — Windows-first; cross-compile when the ask is real.
- Export graph as PNG / SVG / PDF — novelty.
- Dark / light theme toggle — dark works.
- Keyboard navigation through graph — low marginal value.
- Comprehensive accessibility pass — important when there are users.
- `db.test.disabled.ts` → vitest-electron — infra; 434 tests cover the layer.

### Verified this release
- 434/434 tests green (399 → 434, +35 across summarize/digest/MCP/CLI).
- MCP smoke harness: 14/14 checks (handshake → tools/list at 9 tools → search → digest → pinned → create → error paths).
- CLI smoke: search returns semantic hits with distances and one-liners; stats / tags / pinned / help all produce correct output.
- Production build clean across all three processes.

## v0.5.0 — Connect (your own machines, not other people's)

- [ ] Daily / weekly digest view
- [ ] Local read-only web companion (open `http://cortex.local` on your LAN-only laptop)
- [ ] Optional **encrypted P2P sync between your own machines** — Syncthing-style, no cloud middleman, never a server

## v1.0.0 — Stable

- [ ] Documented public **plugin API** — only if v0.3-0.5 produced unsolicited "I'd build X if I could" requests. If nobody asked, this stays out.
- [ ] Performance benchmark suite checked into CI
- [ ] Schema migration story (forward + back-compat)
- [ ] Non-AI source adapters — Markdown editors (Obsidian vault), RSS, email-to-vault
- [ ] Comprehensive user docs + a 3-minute screencast

## Out of scope (explicitly)

- **Cloud-hosted vault.** Local-first by design. Optional encrypted P2P sync between *your own* devices only.
- **Cloud telemetry.** Hard no.
  - *In scope:* opt-in, local-only, transparent usage logs the user can read and delete. v0.2 P0.
- **Mobile clients.** Not in the first year.
- **LLM hosting.** Cortex integrates with Ollama; it does not ship inference.
- **Closed-source.** Open-source for the lifetime of the project.
