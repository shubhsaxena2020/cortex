# v0.2.0 — Graph Obsidian Match, Search 200ms p95, Web Worker Physics

Cortex v0.2.0 makes the capture pipeline **correct, fast, and observable**. All five P0 items shipped, plus the graph got a ground-up rebuild matched to Obsidian's exact rendering values. Privacy-first as always: nothing leaves your machine.

## What's New

- **Conversation deduplication (P0 #1)** — the same chat captured twice updates one memory in place instead of forking the graph into duplicates (canonical-URL upsert).
- **Smart capture filtering (P0 #2)** — empty, single-message, and system/tool-only chats are dropped at the content-script layer before they ever reach the app.
- **Graph, rebuilt (P0 #3)** — viewport culling + Obsidian-style rendering (node radius, label fade, hover dim all matched to Obsidian 1.4.3's source values), force simulation moved to a Web Worker, and a 1.35M-edge explosion that turned the canvas black at scale was root-caused and fixed (inverted word→memory index).
- **Search under 200ms p95 (P0 #4)** — keyword search swapped from LIKE scans to FTS5 MATCH with a dedicated index.
- **Feedback + opt-in local telemetry (P0 #5)** — in-app feedback form (saved to disk) and an anonymous usage log that is OFF by default, never leaves the machine, and is fully viewable / exportable / deletable from Settings. Events are PII-redacted at write time (paths hashed, queries length-only).

## Performance

- **Search:** p95 **86.6 ms** on a 10,000-memory vault (FTS5), down from ~107 ms. Long-phrase queries dropped from ~99 ms to ~0.2 ms.
- **Graph:** renders 10,000 nodes with physics on a **Web Worker** — the UI thread never blocks (Obsidian runs physics on the main thread and can stutter). Verified rendering live (non-background canvas pixels went from 0 / black to ~19k after the edge fix).
- **Embeddings:** full 10k embed backfill in **5.2 min** (≈2.1× faster after request-batching the Ollama calls; the remaining cost is Ollama's CPU inference, not Cortex).

## Downloads

- **Cortex-0.2.0-win-x64-portable.zip** (~123 MB) — **recommended for this release.** Portable Windows x64 build; no installer required.

> **NSIS installer (Cortex Setup 0.2.0.exe) is not in this release.** It could not be built on the current machine: Windows 11 **Smart App Control (Enforce mode)** blocks the unsigned NSIS installer during the build's uninstaller-extraction step ("An Application Control policy has blocked this file"). The fix is **code-signing**, which is the v0.4 distribution milestone (requires a ~$200–400/yr Windows code certificate). Until then, use the portable zip. Note that an unsigned build may also be blocked by Smart App Control on end-user machines that have it enabled.

## Known Issues

- **No signed installer / SmartScreen + Smart App Control.** The build is unsigned (code-signing is v0.4). On machines with Smart App Control enabled, even the portable build may be blocked until signed.
- **Graph node zoom-scale not matched.** Obsidian enlarges nodes when zoomed out (`nodeScale = sqrt(1/zoom)`); Cortex draws in simulation space where matching that explodes the hit-test envelope at low zoom. The larger 8–30px node radii recover most of the benefit. Deferred — see docs/OBSIDIAN-GAP-ANALYSIS.md.
- **Per-frame hover-alpha easing not implemented.** Cortex redraws on demand, not every frame; hover dim is instant rather than eased.
- **In-graph settings panel not built.** Obsidian's cog → force/size/fade sliders are deferred.
- **Embedding backfill is slow (~5 min for 10k)** — bound by local Ollama CPU inference, not Cortex. A GPU or OLLAMA_NUM_PARALLEL closes the gap.
- **Extension is load-unpacked only; Windows-only build.** Chrome Web Store listing and macOS/Linux builds are v0.4.

## How to Test

A full Windows 11 first-run checklist is in **docs/SMOKE-TEST-CHECKLIST.md** — installer/portable run, DB init, extension pairing, capture + dedup, search, graph, telemetry/feedback, and edge cases, with PASS/FAIL fields and a "where to look when it breaks" section.

## Installation

**Portable (recommended):** download Cortex-0.2.0-win-x64-portable.zip, extract it anywhere, and run **Cortex.exe** from the extracted folder. No install step. (On a machine with Smart App Control enabled you may need to right-click → Properties → Unblock, or the build must be signed.)

**Installer:** not available in this release — see the Downloads note above.

---

Stack: Electron 31 · React 18 · TypeScript 5 · better-sqlite3 12 · sqlite-vec 0.1 · Fastify 5 · D3 7 (force sim in a Web Worker) · Zustand 4. 245/245 tests passing.
