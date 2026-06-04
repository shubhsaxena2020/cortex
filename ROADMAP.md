# Cortex Roadmap

> Living document. Phase tags are intent, not contract. Reviewed via Claude Council; see commit history for prior versions.

## What Cortex is (and what the roadmap is for)

The moat is the **capture pipeline**: a Chrome extension + Electron app that pulls AI conversations out of the walled gardens of Claude / ChatGPT / Gemini and stores them as plain Markdown in a local SQLite-backed knowledge graph. Search, graph view, and embeddings are *how you use* what was captured — they are not the differentiator.

Every phase below earns the right to exist by sharpening or extending that capture-to-retrieval loop. If a feature doesn't, it gets cut.

## v0.1.0 — Infrastructure (current, GitHub Pre-Release `v0.1.0-beta`)

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

## v0.2.0 — "The capture pipeline is correct, fast, and observable"

Five P0 items. That is the entire scope. Everything previously in v0.2 that isn't on this list moved to v0.3 or later. The council reviewed this list and called it out as the smallest credible MVP that still defends the moat.

- [ ] **Conversation deduplication** — same chat captured twice never creates two memories. Without this, the graph becomes a landfill within a week of real LLM usage. (P0 because correctness, not polish.)
- [ ] **Smart capture filtering** — skip empty / single-message / system-error chats at the content-script layer.
- [ ] **Graph LOD + viewport culling** — graph stays usable past 8k nodes. Web-worker force simulation is deferred to v0.3 unless culling alone isn't enough.
- [ ] **<200 ms p95 search latency on a 10k-memory vault** — measured, not guessed. Keyword path first; vector path opportunistic.
- [ ] **In-app feedback link + opt-in, local-only usage log** — the only realistic research instrument for a solo dev with zero users. User can read, export, and wipe the log from Settings. **Never leaves the machine.** This is how v0.3 priorities get set from real signal, not guesswork.

### v0.2 kill criteria

- Ships by **end of Q3 2026** *or* the phase is reframed.
- If <10 stars / 0 unsolicited installs by 30 days post-Pre-Release, v0.3 work stops and we do a positioning rewrite (README + landing) before more features.
- If dedup + filtering land but the rest doesn't, ship as v0.2.0 anyway and call v0.3 the perf+search release. **Don't slip the release to ship the bullet.**

## v0.3.0 — "It feels smart"

The features the name "Cortex" implies. Earns the right to exist after v0.2 proves the pipeline is correct.

- [ ] **Bidirectional `[[wiki]]` links + backlinks panel** — promoted from v0.4. Every prior-art comparator (Obsidian, Roam, Logseq) has these; their absence reads as incomplete, not minimalist.
- [ ] Conversation summarization via local Ollama (`llama3.2:3b` or equivalent) — one-line + paragraph summaries
- [ ] Auto-tagging from content; user can edit / lock tags
- [ ] Multi-model Ollama picker (swap embedding + summarization models from Settings)
- [ ] Graph force simulation in a web worker (only if v0.2 culling proved insufficient)
- [ ] Embedding backfill UI — visible progress, pause/resume
- [ ] Saved searches / smart folders
- [ ] `db.test.disabled.ts` → vitest-electron — proper Electron-Node test runner; CI-green DB integration tests

### v0.3 kill criteria

- Ship at most 5 of these 8. The other 3 slip publicly to v0.4 with a one-line "why."

## v0.4.0 — Polish + Distribution (the boring, expensive layer)

Boring because nobody downloads an app for "consistent dark mode." Expensive because code signing + notarization + Web Store enrollment is real money and real lead time.

- [ ] **Distribution prerequisites — actual money, actual time:**
  - macOS DMG signed + notarized — requires **Apple Developer Program enrollment ($99/yr + ~24-48h provisioning)**
  - Windows code-signing certificate — **$200-400/yr from a CA**, kills SmartScreen warning
  - Chrome Web Store listing — **$5 one-time + 3-7 day review**
- [ ] Linux AppImage
- [ ] Auto-update via electron-updater (requires the signed builds above)
- [ ] Export graph as PNG / SVG / PDF
- [ ] Dark / light theme toggle (currently dark-only)
- [ ] Keyboard navigation through graph
- [ ] Accessibility pass — focus traps, reduced-motion, ARIA on graph canvas

### v0.4 kill criteria

- If certs aren't bought by start of phase, distribution items defer indefinitely. Ship unsigned to GitHub Releases as a workable fallback.

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
