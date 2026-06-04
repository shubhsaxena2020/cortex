# Cortex — Status Report

> Living document. Last verified against actual code at commit `dc89a7a` (2026-06-04). Every "shipped" claim below is grounded in a commit hash; every "missing" claim has been checked against the file it would live in. If you spot drift, the source-of-truth files are listed in §11.

## 1. Project identity

- **Official name:** Cortex (renamed from "Local Jenova" mid-development)
- **Tagline:** Privacy-first desktop application that auto-captures AI conversations from Claude, ChatGPT, and Gemini and stores them locally as a searchable, visualisable knowledge graph
- **Repo:** <https://github.com/shubhsaxena2020/cortex>
- **Latest release:** [`v0.1.0-beta`](https://github.com/shubhsaxena2020/cortex/releases/tag/v0.1.0-beta) (GitHub Pre-Release, Windows NSIS installer, 2026-06-04)
- **Branch:** `main`, currently at `dc89a7a`
- **Tests:** 198 passing across 10 files
- **License:** MIT

## 2. The journey — what it was, how it got here

| Phase | Outcome |
|---|---|
| Origin | Personal tool to capture Claude.ai conversations locally; "Local Jenova" working name |
| Phase 1-2 | Electron + React scaffold, SQLite storage, Chrome extension capture pipeline, vault folder watcher, D3 knowledge graph, basic pairing handshake |
| Project rename | Local Jenova → Cortex; `JenovaBrain/` → `cortex_brain/`; full source scrub |
| Phase 3 | First GitHub Pre-Release (`v0.1.0-beta`), installer built (~83 MB), Claude Council–vetted roadmap committed (`98a9192`) |
| Hotfix v0.1.0.1 | Claude extraction was dropping all AI responses (`eeb3c86`) — root cause was DOM selector drift; fix uses action-bar buttons as stable anchors |
| v0.2 in progress | P0 #1 (dedup) and P0 #2 (filtering) shipped 2026-06-04; P0 #4, #3, #5 + P1 #4 queued per `v0.2-FULL-ROADMAP.md` |

## 3. Architecture and stack

### Three-process Electron app

```
   Renderer (React 18 + Zustand + D3)
        │  IPC (contextBridge in src/preload/index.ts)
   ┌────▼──────────────────────────────┐
   │   Main (Node, src/main/)           │
   │   - Fastify 5 HTTP on 127.0.0.1   │ ◄──── Chrome extension (MV3)
   │   - SQLite via better-sqlite3      │
   │   - sqlite-vec (optional, vector)  │
   │   - chokidar (vault watcher)       │
   │   - Ollama HTTP client (embeddings)│ ◄──── User's local Ollama (optional)
   │   - mammoth (.docx text extraction)│
   └────────────────────────────────────┘
        │
   SQLite file (memories.db) + vault folder on disk
```

### Stack at a glance

| Layer | Tech | Version |
|---|---|---|
| Shell | Electron | 31.3 |
| Build | electron-vite (Vite 5) | 2.3 |
| UI | React + TypeScript + Tailwind | 18.3 / 5.5 / 3.4 |
| State | Zustand | 4.5 |
| Graph | D3 (on `<canvas>`, NOT SVG — important for perf work) | 7.9 |
| Markdown | react-markdown + highlight.js | 9.0 / 11.11 |
| Backend | Fastify | 5.8 |
| DB | better-sqlite3 | 12.10 |
| Vectors | sqlite-vec (optional, graceful degrade to FTS/LIKE) | 0.1 |
| Watcher | chokidar | 3.6 |
| DOCX | mammoth | 1.12 |
| Local AI | Ollama via HTTP (model: `all-minilm`, 384-dim) | external |
| Tests | vitest (node env default; jsdom per-file for DOM tests) | 4.1 |
| Logging | electron-log | 5.4 |
| Packager | electron-builder | 24.13 |

### Design principles (held to in code, not just stated)

- **Privacy-first.** No cloud telemetry. No external API calls for core capture/storage. Ollama is local; everything else is local.
- **Single source of truth for schema.** `src/main/db.ts initDb()` is the only place tables are declared; `runMigrations()` is the only place they evolve. `database/schema.sql` is legacy reference, not authoritative.
- **Idempotent migrations.** Every step is PRAGMA-guarded; structural assertions in `db.migration-ordering.test.ts` enforce this at PR time.
- **Evidence-grounded edits.** Three times this session we caught and rejected work scoped against premises that didn't match the code (truncation bug had no `.substring()`, "Memories tab" already existed, graph wasn't on SVG). Council-review process documented in `designs/`.
- **Graceful degrade.** Ollama down → semantic search falls back to FTS keyword. sqlite-vec missing → vector path skipped silently. No user-facing crashes from optional component absence.

## 4. What Cortex can do — capabilities by area

Each ✅ is verified against a commit or file. No aspirational claims.

### 4.1 Conversation capture (Chrome extension)

- ✅ Auto-capture **Claude.ai** conversations — Strategy 0 (action-bar anchor) shipped in `eeb3c86`; survives Claude's DOM-class renames
- ✅ Auto-capture **ChatGPT.com** — `[data-message-author-role]` (symmetric user + assistant); `article[data-testid^="conversation-turn"]` fallback
- ✅ Auto-capture **Gemini** — `user-query` / `model-response` web components; conversation-bubble fallback
- ✅ DOM-to-Markdown extraction preserving `<strong>`, `<em>`, `<code>`, `<pre>`, `<a>`, `<h1-6>`, lists, tables (`extension/content.js domToMarkdown`)
- ✅ **Smart filtering on ChatGPT** (commit `9f24fb8`): drops `data-message-author-role="system"` (Custom Instructions) and `"tool"` (tool-use blocks) before extraction
- ✅ Shared **placeholder text filter** across all providers — drops empty/ellipsis-only/`Loading…`-style noise that slips past the length guard; tested NOT to drop legitimate AI refusals
- ✅ Markdown frontmatter on every saved file: `source`, `captured`, `url`, `tags`

### 4.2 Data management

- ✅ **URL-based deduplication.** Same conversation captured twice → one row, `updatedAt` bumps, graph node stays stable. URL canonicalisation strips `utm_*`, `fbclid`, `gclid`, `msclkid`, `ref`, `ref_src`, `_ga`, `mc_(cid|eid)`; lowercases host; drops fragments; sorts remaining query params for determinism. (commits `1d7d0e1`, `f88d37a`)
- ✅ **Cross-pipeline absorption** (commit `c015dfe`): when the vault watcher indexes a `.md` whose frontmatter URL matches an existing memory's URL, the file is linked and suppressed from the Files tab + graph. The memory becomes the canonical representation; no duplicate nodes.
- ✅ **Race-safe linking.** If a file is indexed *before* the matching memory exists, the next memory create retroactively links it (`UPDATE vault_files SET linked_memory_id WHERE frontmatter_url AND linked_memory_id IS NULL`).
- ✅ **Self-heal on schema upgrade.** Files indexed on v2 (no frontmatter columns) get re-processed on next launch under v3 to populate the new columns; subsequent launches skip normally.
- ✅ **App-layer FK enforcement.** `deleteMemory` nulls any `linked_memory_id` referencing the deleted memory so suppressed files reappear. Covers existing installs where SQLite's `ALTER TABLE ADD COLUMN` couldn't carry the FK declaration.
- ✅ **Schema migrations** v1 → v2 → v3 with regression-guard tests (`db.migration-ordering.test.ts`)
- ✅ **Persistent vault** at `%APPDATA%\Cortex\memories.db` (DB) + user-chosen folder for `.md` files (default suggestion: `cortex_brain`)
- ✅ **Watch folder** indexing for any folder the user points at — chokidar-based, debounced
- ✅ **Backfill script** for legacy rows: `npm run backfill-source-urls -- --dry-run`

### 4.3 Search

- ✅ **Keyword search** — FTS-style LIKE on `memories.title` + `memories.content`, source + tag filters
- ✅ **Semantic search** via Ollama embeddings + sqlite-vec — `/api/related` runs vector KNN first, falls back to keyword if Ollama or sqlite-vec are unavailable. (Yes — this is shipped today; it just requires the user to have Ollama running with `all-minilm` pulled. Setup is documented in `RELEASE_NOTES.md`.)
- ✅ Search highlighting (`<mark>` substring; HTML-escapes user content)
- ✅ Combined memory + vault-file search in the UI (`Search.tsx`)

### 4.4 Knowledge graph

- ✅ **D3 force-directed graph on `<canvas>`** (not SVG — important nuance for upcoming perf work). Pan, zoom, drag.
- ✅ Memory nodes coloured by source (Claude / ChatGPT / Gemini / manual)
- ✅ File nodes coloured by extension family (code / docs / data / text / images)
- ✅ **Auto-edges, memory↔file** (`'mention'` type): a memory mentions a file if its content contains the file's stem. Cheap heuristic; lives in `graph-builder.ts`.
- ✅ **Manual edges, memory↔memory** via `createRelationship` IPC. **No auto-edge algorithm yet** — that's P1 #4.
- ✅ Filter mode toggle: memories only / files only / both

### 4.5 Settings & configuration

- ✅ AI status panel (Ollama reachable, model pulled, vector search enabled, embedded count)
- ✅ Vault folder picker
- ✅ Watch folder picker
- ✅ Browser extension pairing flow (one-time 60s armed window; HMAC bearer token after)
- ✅ **Real-time indexing progress** (commit `4bb9686`): pulsing-dot + determinate progress bar in StatusBar takes over during indexing; inline progress card in Settings → Watch Folder section. ARIA `progressbar` semantics.

### 4.6 Quality

- ✅ **198 tests passing** across 10 files. Coverage areas: URL canonicalisation, frontmatter parsing, migration ordering, capture filters, transformers, HTTP API surface, vault watcher logic, graph-builder, chat-formatter, embeddings.
- ✅ Migration regression tests are *structural* — read `db.ts` as text and assert the architectural invariants. Catches "CREATE INDEX before ALTER TABLE adds the column" at PR time, not user startup time.
- ✅ Privacy guard pattern in place for future telemetry (P0 #5 plan documented in `docs/DEDUP-IMPLEMENTATION.md` style)

## 5. What Cortex cannot do yet — honest gaps

Marked by where it would live, why it's not there, and which roadmap item lands it.

### 5.1 Extraction & capture

| Gap | Why | Roadmap |
|---|---|---|
| Claude system-message filtering | Claude.ai doesn't expose system prompts in the user-visible DOM today; no reproducer to write a rule against | Harness ready (`extension/filters.js shouldSkipClaudeElement`); add rule + fixture when a real noise sample arrives |
| Gemini system/tool filtering | Same — Web Components are symmetric; no observed noise | Same — harness ready (`shouldSkipGeminiElement`) |
| Streaming capture | Extension captures by reading the rendered DOM on user click; mid-stream conversations work but partial responses get captured at whatever state they're in | Architectural — would need a different model (watch the DOM via MutationObserver and ship deltas) |
| Multi-thread chats | Linear extraction only; Claude/ChatGPT branched conversations get captured as the currently-selected branch | Not on roadmap |

### 5.2 Knowledge graph

| Gap | Why | Roadmap |
|---|---|---|
| Auto memory↔memory edges | No code path auto-populates `relationships` table; only manual `createRelationship` IPC | **P1 #4** in v0.2-FULL-ROADMAP.md — three-signal algorithm spec'd (shared tags → keyword Jaccard → embedding cosine), 8-12 hrs |
| LOD / viewport culling for 8000+ nodes | All nodes render every tick; canvas is fast but force sim slows down | **P0 #3** — 6-9 hrs (canvas is already in place; pure quadtree + LOD layer on top) |
| Graph export (PNG / SVG / PDF) | Not implemented | v0.4 polish per `ROADMAP.md` |
| Custom node colors / labels | No UI; the source-color mapping is hard-coded in `graph-builder.ts` | v0.4 polish |

### 5.3 Search & discovery

| Gap | Why | Roadmap |
|---|---|---|
| Sub-200ms p95 search latency on 10k+ vaults | No profiling done; current keyword path is unbounded LIKE, semantic path makes a fresh Ollama call per query | **P0 #4** — 7-10 hrs, profile-first |
| Date / advanced filter UI | Backend supports source + tag filters; UI doesn't surface them | v0.4 polish |
| Conversation comparison (side-by-side) | Not built | v0.3 Switch-AI work touches this indirectly |
| Fuzzy search | LIKE matches exact substrings only | Open backlog |

### 5.4 AI / model features

| Gap | Why | Roadmap |
|---|---|---|
| Switch AI handoff (Claude → ChatGPT etc.) | Designed in `designs/switch-ai-spec.md`; not built | v0.3.x — 6-10 hrs |
| Conversation summarisation | Would need a local instruct model via Ollama; we currently only run the embedding model | v0.3 deferred per Council #2 |
| Auto-tagging | Same — needs an instruct model + UX for user-locks | v0.3 deferred |
| Model training on user conversations | **Not on the roadmap.** Ollama is inference, not training; on-device fine-tuning of LLMs is out-of-charter for this product. |

### 5.5 Extensibility & distribution

| Gap | Why | Roadmap |
|---|---|---|
| macOS DMG (signed + notarized) | Apple Developer Program enrollment ($99/yr) not done | v0.4 — gated on cert purchase |
| Linux AppImage | Configured in electron-builder, not built | v0.4 |
| Windows code-signing | Cert ($200-400/yr) not purchased; SmartScreen warning on first install | v0.4 |
| Chrome Web Store listing | Load-unpacked only today | v0.4 — gated on $5 Store fee + 3-7d review |
| Auto-update | electron-updater wiring required signed builds | v0.4 — depends on signing certs |
| MCP server (Cortex as a queryable AI tool) | No `mcp/` directory; design call deferred per recent design pushback | Not on v0.x roadmap |
| Plugin system | Documented in v1.0 entry of ROADMAP.md, but gated on real "I'd build X if I could" requests |

### 5.6 Privacy & security

- Local vault is **plaintext SQLite**. No encryption at rest. Acceptable for "your machine, your data"; not acceptable for shared-machine scenarios.
- Extension paired token lives in Chrome extension storage; rotates on re-pair, but **does not auto-rotate on schedule**.
- Vault deletion in Cortex does NOT clear Chrome extension storage. User must clear browser data manually if revoking access.

## 6. Known technical limitations

- **better-sqlite3 ABI mismatch.** Compiled for Electron 31's Node ABI (125); standalone Node is ABI 127. DB code can't be vitest-tested directly (`db.test.disabled.ts` is parked). Workaround: pure logic in separate testable modules (`url-canon.ts`, `frontmatter.ts`); structural assertions on `db.ts` source code; live integration tests in `scripts/integration-tests.mjs`. **Proper fix:** adopt `vitest-electron` — Council #2 item for v0.3.
- **vitest default env is `node`.** Files needing DOM declare `@vitest-environment jsdom` header (`extension/filters.test.js` is the established pattern). No global React-component test setup yet — flagged as a gap when v0.2 P0 #5 (telemetry UI) lands.
- **SQLite single-writer.** Not a constraint for a single-user local app, but worth knowing if "Cortex on a NAS for a family" ever becomes a real ask.
- **No linter in `package.json`.** No eslint/biome/prettier. Strictness comes from `tsconfig.{node,web}.json strict: true` + manual code review.

## 7. Roadmap — what's next

### Phase v0.2.0 (in flight)

Per `v0.2-FULL-ROADMAP.md`, Council #2 vetted. Numbers are realistic ranges, not estimates I'm padding.

| # | Item | Effort | Status |
|---|---|---|---|
| 1 | P0 #1 — Dedup + cross-pipeline absorption | 9-12 hrs | ✅ **DONE** (1d7d0e1 → f88d37a → c015dfe) |
| 2 | P0 #2 — Smart capture filtering | 6-9 hrs | ✅ **DONE** (9f24fb8) — ChatGPT live; Claude/Gemini predicates ready, pending real noise samples |
| 3 | P0 #4 — Search latency <200ms p95 on 10k vault | 7-10 hrs | **NEXT** — profile first via `scripts/seed-10k-vault.mjs` (30-min infra), then scope optimisation |
| 4 | P0 #3 — Graph LOD + viewport culling | 6-9 hrs | Queued (after P0 #4 seed vault) — canvas already in place |
| 5 | P1 #4 — Memory↔memory auto-edges | 8-12 hrs | Queued — unblocked by P0 #1 — algorithm spec in roadmap |
| 6 | P0 #5 — In-app feedback + opt-in local telemetry | 9-12 hrs | Queued — saves for last so events ship in final shape |

**Total v0.2.0 budget:** 45-64 hrs. **Shipped: ~15-21 hrs.** Remaining: ~30-43 hrs.

### Phase v0.2.1 (polish, after v0.2.0)

- #7 Frontend redesign (needs aesthetic-direction call from Shubh; `frontend-design` skill installed)

### Phase v0.3 (feature tier)

- Switch-AI handoff (interpretation A from design spike — open my Claude chat in ChatGPT with context pre-pasted)
- Bidirectional `[[wiki]]` links + backlinks panel
- Conversation summarisation via local Ollama instruct model
- Auto-tagging
- Multi-model Ollama picker
- `vitest-electron` adoption (unparks `db.test.disabled.ts`)
- Saved searches

### Phase v0.4 (distribution + polish)

- macOS DMG signed + notarized
- Windows code-signing cert
- Linux AppImage
- Chrome Web Store listing
- Auto-update via electron-updater
- Graph export PNG / SVG / PDF
- Dark/light theme toggle
- Keyboard graph navigation
- Accessibility pass (focus traps, reduced-motion, ARIA on graph)

### Phase v0.5 (connect)

- Daily / weekly digest view
- Local read-only LAN companion
- Optional encrypted P2P sync between *your own* machines (Syncthing-style; never a server)

### Phase v1.0 (stable)

- Documented plugin API — only if v0.3-0.5 produced unsolicited "I'd build X if I could" requests
- CI perf benchmark suite
- Schema migration story locked
- Non-AI source adapters (Obsidian vault, RSS, email-to-vault)
- Comprehensive user docs + screencast

### Explicit out-of-scope

- **Cloud vault.** Local-first by design. P2P sync between user's own devices only.
- **Cloud telemetry.** Hard no. Local-only opt-in usage log is the P0 #5 alternative.
- **Mobile clients.** Not in the first year.
- **LLM hosting.** Cortex integrates with Ollama; it doesn't ship inference.
- **Model training on user data.** Out-of-charter. Misreading "Ollama integration" as "training" elides the inference/training distinction.

## 8. Vision

### What problem this solves

Conversations with Claude / ChatGPT / Gemini are *valuable knowledge work* — and they evaporate. They live in browser tabs you close, in providers' archives you can't search across, in conversation histories the provider can quietly delete. Cortex keeps every conversation you care about as a plain Markdown file on your disk, indexed and graphed locally, searchable forever — even if Anthropic / OpenAI / Google change their terms tomorrow.

### Why local-first is the right shape

| Property | Cortex | Cloud "chat archiver" SaaS |
|---|---|---|
| Your data leaves your machine? | Never (Ollama is local; even sync would be P2P) | Yes — third party reads every conversation |
| Vendor lock-in? | None — vault is plain Markdown + SQLite | Their schema, their export format |
| Subscription? | None | $5-20/mo typical |
| Offline-capable? | Fully | No |
| Privacy guarantees | Verifiable (you can read every line of the code that touches your data) | Trust-based |
| Search latency | Local disk + RAM | Network RTT + their infra |

### Long-term aim

Cortex earns the right to be called a "second brain" for AI-assisted knowledge work — the place where the questions you asked Claude six months ago can be found, related to today's question, and re-surfaced. Where the answer to "have I researched this before?" is decided by your own vault, not by which provider you happened to be using that week.

The v1.0 north star is *invisibility* — Cortex captures everything in the background, surfaces it when you search, links it without you having to organise. The most successful version of Cortex is the one users forget is running until they need to find something.

### What success looks like (not promises, north-star markers)

- Real users reporting they replaced a paid alternative with Cortex
- Outside contributors fixing extraction quirks for providers we haven't touched
- An ecosystem of small per-provider extractor PRs as Claude/ChatGPT/Gemini DOMs evolve
- Zero cloud infrastructure forever

## 9. How to verify this report

```powershell
cd C:\Users\shubh\cortex

# Confirm "shipped" claims
git log --oneline | head -20             # all commit hashes referenced above are real
npm test                                  # 198/198 passing
npm run build                             # all three bundles green

# Confirm "in-progress" claims
cat v0.2-FULL-ROADMAP.md                 # status column matches §7 above
cat docs/CODEBASE_SNAPSHOT.md             # full file-by-file architecture map

# Confirm extension capability
# 1. chrome://extensions → reload Cortex extension
# 2. Open claude.ai / chatgpt.com / gemini.google.com chat
# 3. Extension popup → "Save This Chat"
# 4. Check %APPDATA%\Cortex\memories.db has the row + cortex_brain/ has the .md
# 5. Re-capture same chat → only 1 row (dedup working)
```

## 10. Corrections from the initial draft

For the record (so future readers of git blame understand the report's provenance):

| Original claim | Reality |
|---|---|
| "❌ Ollama installed but unused" | **WRONG.** Ollama is shipped and active (`src/main/embeddings.ts`, model `all-minilm`). Used for semantic search via sqlite-vec. Setup is documented in `RELEASE_NOTES.md`. |
| "❌ Local model training (Ollama installed but unused; P1 #6 planned)" | **WRONG class of feature.** Ollama is inference, not training. On-device LLM fine-tuning is out-of-charter for Cortex. Removed from the missing-features list entirely. |
| "❌ ChatGPT system message filtering (not yet implemented)" | **WRONG.** Shipped in `9f24fb8` (P0 #2). Moved to the ✅ list. |
| "❌ Semantic search (would need embeddings; Ollama integration pending)" | **WRONG.** Semantic search is shipped via the same Ollama + sqlite-vec path. Moved to ✅. |
| "P1 #2: Watch folder progress indicator" in v0.2.1 polish list | **Already shipped** (`4bb9686`, the indexing progress UI in StatusBar + Settings). Removed from queue. |
| "P0 #3 Graph LOD: 14-18 hrs" | **Stale number.** Roadmap says 6-9 hrs because canvas is already in place; the "canvas migration" was never required (documented in CODEBASE_SNAPSHOT.md §2.5). |
| "P0 #4 Search latency: 8-12 hrs" | **Mild correction:** roadmap says 7-10 hrs. |
| "P0 #5 Telemetry: 6-8 hrs" | **Mild correction:** roadmap says 9-12 hrs. |

These corrections matter because the audience listed in the original draft (contributors, potential users, collaborators, investors) will use this doc to form an accurate picture. Overclaiming what's shipped (Ollama untouched, semantic search missing) would make Cortex look less mature than it is; underclaiming (model-training feature) would set expectations the project can't and won't meet.

## 11. Source-of-truth files (if this doc drifts, here's where to re-derive it)

| Claim type | Source file |
|---|---|
| Current architecture, dependencies, IPC + route surface | `docs/CODEBASE_SNAPSHOT.md` (commit `81d9510`) |
| v0.2 P0 status + effort estimates | `v0.2-FULL-ROADMAP.md` |
| v0.1 → v1.0 macro vision + out-of-scope list | `ROADMAP.md` |
| Schema migrations + dedup design | `docs/DEDUP-IMPLEMENTATION.md` |
| Switch-AI v0.3 spike | `designs/switch-ai-spec.md` |
| Truncation root-cause + fix | `diagnostics/truncation-report.json` + commit `eeb3c86` |
| Paste-mechanism prep for v0.3 | `docs/PASTE-MECHANISM-REFERENCE.md` |

## 12. Document metadata

- **Generated:** 2026-06-04 (after v0.2 P0 #1 + #2 ship)
- **Verified against commit:** `dc89a7a` on `main`
- **Next review trigger:** when P0 #4 ships, or when any §4 ✅ claim becomes false
- **Audience:** contributors, potential users, collaborators, anyone evaluating the project's maturity
- **Authoring guidance for future updates:** verify every ✅ against a commit before writing it; verify every ❌ against the file where the feature would live; correct earlier drafts in §10 with a one-line explanation so reviewers can see the provenance
