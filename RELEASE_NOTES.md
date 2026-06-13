# Cortex v0.4.0 — "Cortex finds you, not the other way around" (2026-06-13)

> Pivoted hard from the ROADMAP-as-written. The original v0.4 scope was code signing and themes; the actual v0.4 is the inversion that v0.3's MCP server kicked off — Cortex stops waiting to be opened. See [`docs/V04-THINKING.md`](docs/V04-THINKING.md) for the full reasoning.

Privacy-first desktop app: captures AI conversations from Claude, ChatGPT, and Gemini into a local knowledge graph. Nothing leaves your machine.

## What changed

- **`cortex` CLI** — a real terminal companion. `cortex search "auth flow"`, `cortex recent --tag rust --limit 20`, `cortex digest`, `cortex export <id>`, `cortex stats`, `cortex tags`, `cortex pin <id>`, `cortex unpin <id>`, `cortex pinned`. Pipeable (snippet-only output on non-TTY for `| grep`, `| head`), greppable, opens the same FTS5 + sqlite-vec + Ollama stack the MCP server uses. Both Bash (`cli/cortex`) and CMD (`cli/cortex.cmd`) launchers ship; `npm run cortex -- <cmd>` works locally without PATH setup.
- **Local Ollama summarization** with `llama3.2:3b` (or `CORTEX_SUMMARY_MODEL`). Two summaries per memory — one-line (≤20 words) and paragraph (≤80 words) — cached in `memory_summaries` keyed on content hash. Stale summaries invalidate when content changes. Generation is null-safe: Ollama down ⇒ silent no-op, same pattern as embeddings.
- **MCP server v0.4: bandwidth fix + three new tools.** `cortex_search` and `cortex_get_memory` return one-line / paragraph summaries instead of raw content, dropping the typical search-result payload from ~600 lines of raw chat to ~60 lines of distilled summary. Three new tools: `cortex_digest`, `cortex_pinned`, `cortex_pin`. Pinned memories are prepended to every `cortex_search` envelope. Tools went 6 → 9.
- **Daily / weekly digest** (`cortex digest` + in-app view, Ctrl+4). Groups recent captures by top tag, surfaces one-line summaries, clickable in the app to drill into the editor. Two-second read on the CLI for morning-coffee use.
- **Pinned memories** — per-memory star toggle in the detail panel; pinned set surfaces at the top of the sidebar and prepends to every MCP search response. The "user-IS" surface the 13 seed memories revealed was missing.
- **Medium-zoom edge LOD fix** — graph perf top-up. Edge strength threshold rises with visible-edge count; mention edges drop above 4k visible nodes. Buys back the one remaining sad zoom band from v0.3.
- **Schema v7** — `memory_summaries` table + `memories.pinned` column + `idx_memories_pinned`. Forward-only, idempotent, runs at first launch.

## Why this scope, not the ROADMAP's

The original v0.4 ROADMAP was distribution + polish: code signing ($300/yr), Linux AppImage, auto-update, dark/light themes, accessibility, keyboard graph navigation. All of that is future table-stakes — and none of it makes Cortex genuinely indispensable to someone using it daily. Per `docs/V04-THINKING.md`:

> The product is half-passive on intake and fully active on retrieval. A second brain that waits to be asked is a filing cabinet. The thing it needs to become is the thing that finds *me*.

The CLI is the highest-leverage single thing I can ship — terminal users will reach `cortex search` 20× a day, never the Electron window. The summarization makes the MCP server's output composable with limited LLM contexts. The digest makes the app a habit instead of a tool. Pinning gives the user an explicit "always-relevant context" surface.

## Verified this release

- **434/434** unit + integration tests green (399 → 434, +35 across summarize/digest/MCP/CLI).
- **MCP smoke harness:** 14/14 checks (handshake → 9-tool list → search → digest → pinned → create → error paths).
- **CLI** verified live against the real DB: `cortex stats`, `cortex search` (semantic mode), `cortex tags`, `cortex help` all produce correct output.
- `npm run build` clean across all three processes + worker chunk.

## Stack

Electron 31 · React 18 · TypeScript 5 · Tailwind 3 · better-sqlite3 12 · sqlite-vec 0.1 · Fastify 5 · D3 7 · Zustand 4 · Vitest 4 · local Ollama (`all-minilm` 384d for embeddings, `llama3.2:3b` for summarization, both optional with graceful degradation). **434/434 tests passing.**

---

# Cortex v0.3.0 — "Smart, linked, and 100k-ready" (2026-06-13)

> Cortex earns the name. Six of v0.3's eight roadmap items shipped (the kill criteria asked for at most five — we beat it), plus two items the criteria didn't anticipate: an **MCP server** turning the second brain into native Claude tool calls, and a **graph performance overhaul** that takes the canvas from 2.9 FPS at 100k+ nodes (v0.2) to **133 FPS settled**.

Privacy-first desktop app: captures AI conversations from Claude, ChatGPT, and Gemini into a local knowledge graph. Nothing leaves your machine.

## Headline features

- **Bidirectional `[[wiki]]` links + backlinks panel.** Obsidian-style syntax (`[[Title]]` and `[[Title|alias]]`) persists as graph edges with a dedicated emerald color and a "wiki" signal type. Clickable in detail-panel previews and the editor's markdown preview; unresolved targets render muted as dangling links. New memories automatically resolve inbound links — if someone wrote `[[Cortex Architecture]]` before that memory existed, the link binds itself the moment the memory appears. Backlinks ("Linked mentions") section on every memory shows who points here.
- **Auto-tagging from content.** Deterministic heuristic tagger weights title words 3× and prefers existing vocabulary tags (scaled by usage) over fresh keywords. No Ollama dependency — works fully offline. Lock semantics: first capture of an untagged conversation gets suggested tags; re-captures and user edits are never clobbered. Per-memory "suggest" button in the detail panel.
- **Embedding backfill UI.** Visible progress bar in both the Settings AI panel and the status bar; pause at batch boundaries, resume restarts the scan. Skip reasons (Ollama down, model not pulled, vector search disabled) become actionable hints instead of silent no-ops.
- **Cortex MCP server.** Six tools over stdio JSON-RPC 2.0 — `cortex_search` (FTS5 keyword + sqlite-vec semantic with auto-fallback), `cortex_get_memory`, `cortex_list_memories`, `cortex_create_memory`, `cortex_related`, `cortex_stats`. Zero new dependencies (hand-rolled dispatch beats `@modelcontextprotocol/sdk`'s postinstall native-rebuild churn). Runs under Electron-as-Node because `better-sqlite3` is compiled for Electron's ABI. Registered for Claude Code (project `.mcp.json`) and Claude Desktop (`claude_desktop_config.json`). Tested with 31 unit tests + a full end-to-end smoke harness against the live DB.
- **Graph performance overhaul: 125k+ nodes, no jank.** Measured on a 60k-memory + 60k-file + 150k-edge fixture:
  - **Far view (auto-fit, full graph in view): 7.5 ms/frame steady state — 133 FPS.** (v0.2 measurement on the same hardware: 347 ms/frame, 2.9 FPS — **44× improvement.**)
  - **Cold open to first paint: 13–15 s** at 125k nodes (the layout streams from tick 0 — early frames show physics organizing instead of a blank canvas).
  - Medium-zoom pan/zoom with ~40k edges on screen: 78 ms/frame (~13 FPS) settled — still degraded by per-edge stroke cost, but interactive instead of frozen.
  - **Memory content no longer ships to the renderer.** `memories:getAll` returns the LIGHT projection (id + title + tags + 200-char snippet); full bodies hydrate per selection. Editor mounts gate behind hydration so autosave can't write empty content over real data.
  - **Mention edges computed in the main process** behind a fingerprint cache. Renderer never tokenizes memory content.
  - **Worker simulation scales by node count.** ≥20k nodes drops `forceCollide` (its per-tick quadtree dominates the profile and the spacing it buys is sub-pixel at 100k zoom levels), raises Barnes-Hut `theta` to 1.2, cools faster, batches fewer ticks per post. Zero-copy typed-array init protocol — three `ArrayBuffer`s instead of object arrays (structured-cloning 100k objects costs seconds).
  - **Far-LOD scene cache.** Clusters + bundled edge segments (deduped per pair, hard-capped at 6,000 segments) computed over the whole graph once per zoom band; reused across every pan/zoom frame in the band. Per-frame far cost becomes O(clusters), not O(nodes + links).
  - **Density-override LOD.** Visible-count override forces the cluster path whenever the frame would otherwise be unpayable, regardless of zoom band.
  - **Flat-fill fast path** above 1,500 visible nodes (no gradient, no `shadowBlur` per node — the rich style costs ~40 µs/node).
  - **Adaptive quadtree leaf capacity** (32 ≥ 20k points; 8 below). 4× fewer tree-node objects on big graphs with no measurable query-time hit.
  - **Quadtree-local edge hover** above 20k links — tests only edges incident to nodes near the cursor instead of the full O(links) scan.
  - **Throttled position application.** Worker batches are stashed (only the newest matters) and applied at 400 ms cadence — earlier code applied every batch, an O(nodes) copy + bounds pass that starved the main thread while the sim streamed per-tick.
  - **Sidebar render cap** at 300 rows. Mounting one DOM row per memory put 7+ MB of nodes in the React tree at 60k and froze first paint.

## Shipped vs slipped (v0.3 kill criteria: ship ≥5 of 8)

| Item | Status |
|---|---|
| Bidirectional `[[wiki]]` links + backlinks panel | ✅ Shipped |
| Auto-tagging from content | ✅ Shipped |
| Embedding backfill UI | ✅ Shipped |
| Saved searches / smart folders | ✅ Shipped (search history + named saved searches + date-range filters) |
| Graph force simulation in a web worker | ✅ Shipped in v0.2; further tuned here |
| Conversation summarization | ⏭ Slipped to v0.4 — needs a second Ollama model (`llama3.2:3b`). Not worth blocking on. |
| Multi-model Ollama picker | ⏭ Slipped to v0.4 — settings plumbing with no consumer until summarization exists. |
| `db.test.disabled.ts` → vitest-electron | ⏭ Slipped to v0.4 — infra-only; live-process scripts + 399 unit tests cover the DB layer. |

**6/8 shipped — kill criteria exceeded.**

## Verified this release

- **399/399** unit + integration tests green. `npm run build` clean across all three processes + worker chunk.
- **MCP server** end-to-end smoke harness: 12/12 checks (handshake → tools/list → stats → search keyword → search semantic → get → related → create → round-trip → error paths).
- **Graph at 125,177 nodes / 175,087 edges:** cold open to interactive in 13–15s; far-zoom steady state 133 FPS (7.5 ms/frame); pan/zoom never frozen.
- Live verification via Chrome DevTools Protocol harness (`scripts/cdp-fps2.mjs`) — actual draw timings from the real renderer, not synthetic micro-benchmarks.

## Migrations

- **Schema v6** unchanged from v0.2 (introduced `idx_memories_source` + `ANALYZE`). No migrations in this release.
- **Wiki backfill** runs once at startup, LIKE-prefiltered so vaults with no wiki syntax pay one scan and zero writes.

## Known limitations carried into v0.3.0

- **Medium-zoom pan/zoom still degraded** at 5–10k visible nodes (~13 FPS). Far and close zoom are smooth; the middle band has 40k edges in view simultaneously and per-edge stroke cost dominates. v0.4 candidate: edge strength threshold rising with visible count, or OffscreenCanvas + WebGL.
- **Edge hover stops tooltipping at scale** for edges whose endpoints are both far from the cursor (20k-link quadtree-local fallback). Acceptable trade-off.
- **Installer unsigned** — SmartScreen will warn. Code-signing is v0.4 (~$300/yr in certs).
- **Windows-only installer** — macOS DMG + Linux AppImage are v0.4.
- **Embedding 10k still takes ~5 min** — Ollama CPU inference, not the script.

## Stack

Electron 31 · React 18 · TypeScript 5 · Tailwind 3 · better-sqlite3 12 · sqlite-vec 0.1 · Fastify 5 · D3 7 (force sim in a Web Worker, scale-adaptive) · Zustand 4 · Vitest 4. **399/399 tests passing.**

---

# Cortex v0.2.0 — "Correct, fast, and observable" (2026-06-05)

> All five v0.2.0 P0 items shipped. This is the release where the capture pipeline becomes correct (dedup), fast (FTS5 search, off-thread graph physics), and observable (opt-in local telemetry + feedback). **Ready for wider testing.** The one remaining gate is a third-party Windows 11 installer smoke test — see `docs/SMOKE-TEST-CHECKLIST.md`.

Privacy-first desktop app: captures AI conversations from Claude, ChatGPT, and Gemini into a local knowledge graph. Nothing leaves your machine.

## What's new in v0.2.0

- **P0 #1 — Conversation deduplication.** Canonical-URL upsert (`upsertMemoryByUrl`): the same chat captured twice updates one memory in place instead of forking the graph into duplicates.
- **P0 #2 — Smart capture filtering.** The content script drops empty, single-message, and system/tool-only chats before they ever reach the app.
- **P0 #3 — Graph, rebuilt.** Quadtree viewport culling + smooth label level-of-detail, then a full Obsidian-style canvas redesign. Force simulation moved **off the main thread into a Web Worker**. A catastrophic O(memories × files) mention-edge explosion (1.35M edges → black canvas at 10k memories + 5k files) was root-caused by live DevTools-protocol inspection and fixed with an inverted word→memory index (~1k edges, ~0.4s build, whole-word matching).
- **P0 #4 — Search latency < 200 ms p95 on a 10k vault.** `searchMemories` swapped from `LIKE` scans to FTS5 `MATCH`, plus `idx_memories_updated`. Measured **p95 = 86.6 ms** on 10,000 synthetic memories (long-phrase queries dropped ~99 ms → 0.2 ms).
- **P0 #5 — Feedback + opt-in local telemetry.** In-app feedback form (saved as JSON on disk) and an anonymous usage log that is **OFF by default, never leaves the machine, and is fully viewable / exportable / deletable** from Settings. Events are PII-redacted at write time (paths hashed, queries length-only); daily-rotated JSONL with 30-day retention.

### Bonus (shipped beyond the P0 scope)

- **Embedding seed parallelization** — request-batching + bounded concurrency + per-row fallback in `scripts/seed-10k-vault.mjs`. ~2.1× faster with zero data loss (Ollama is the remaining throughput ceiling).
- **Force-simulation Web Worker** — was scoped for v0.3; pulled forward because 10k-node culling alone wasn't enough.

## Verified this release

- **245/245** unit + integration tests green · `npm run build` clean (all three processes + worker chunk).
- **Settings UI** verified end-to-end against the live app: telemetry toggle persists across reads, feedback submit writes a JSON file to `%APPDATA%/Cortex/feedback/`, View/Export/Clear present.
- **Graph** verified rendering live: 6,603 non-background canvas pixels at 10k nodes (was 0 / black before the edge-explosion fix), worker streaming positions.

## Known limitations carried into v0.2.0

- **Installer unsigned** — SmartScreen will warn. Code-signing is v0.4 (~$300/yr in certs).
- **Windows-only installer** — macOS DMG + Linux AppImage are v0.4 (gated on Apple enrollment + Windows cert).
- **Extension is load-unpacked** — Chrome Web Store listing is v0.4.
- **No third-party installer smoke test yet** — the next action; checklist is in `docs/SMOKE-TEST-CHECKLIST.md`.
- **Embedding 10k still takes ~5 min** with `--embed` — Ollama CPU inference, not the script. A GPU or `OLLAMA_NUM_PARALLEL` closes the gap.

## Stack

Electron 31 · React 18 · TypeScript 5 · Tailwind 3 · better-sqlite3 12 · sqlite-vec 0.1 · Fastify 5 · D3 7 (force sim in a Web Worker) · Zustand 4 · Vitest 4. **245/245 tests passing.**

---

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
