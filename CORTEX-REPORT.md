# Cortex — Project Report

> Generated 2026-06-04. Grounded in `CLAUDE.md`, `package.json`, `electron-builder.json`, `src/` source layout, `.cortex-loop-log.md`, and one manual end-to-end test session. Sections marked **[inferred]** are extrapolations from the codebase and should be confirmed by the owner.

---

## 1. Project Overview

### What is Cortex?
Cortex is an **Electron desktop app** that acts as a **personal AI memory layer** living entirely on the user's machine. The `package.json` description states it bluntly:

> *"Universal AI memory layer — works across Claude, ChatGPT, Gemini."*

In practical terms it does three things:
1. **Stores notes/memories** in a local SQLite database, with tags, markdown body, and a source attribution (Manual / Claude / ChatGPT / Gemini).
2. **Indexes a vault folder on disk** (8,184 files indexed in the current dev instance) and exposes that index via search.
3. **Talks to AI assistants through a browser extension** — a paired Chrome extension can read and write memories over a localhost HTTP API, so context follows the user across Claude / ChatGPT / Gemini sessions.

### Problem it solves
Users of multiple AI assistants today re-explain themselves to each one. Memories captured in Claude don't appear in ChatGPT; ChatGPT's history doesn't surface in Gemini. Cortex proposes a **single local store** that any assistant can read/write via a thin extension, with semantic search on top so the right memory surfaces by meaning, not just keywords.

### Target user **[inferred]**
- Power users of LLM assistants who use more than one daily
- Privacy-conscious users who want their AI context on-device, not in a vendor cloud
- Devs/researchers/writers with a "second brain" workflow (Obsidian/Roam-adjacent) who want AI assistants to read from that brain

### End goal
A **standalone installer** (NSIS on Windows, DMG on macOS, AppImage on Linux — already wired in `electron-builder.json`) that an end user can download and run without touching a terminal.

### Current stage
**`v0.1.0` — pre-MVP, internal dev build.**
- Core CRUD, search, graph, vault, extension pairing all functional in dev mode (verified manually this session).
- No bundled Ollama, no auto-update channel, no code signing, no first-run onboarding wizard yet.
- No `README.md` in the project root.

---

## 2. Technical Stack

### Process layout (from `CLAUDE.md`)

| Process | Entry | Responsibility |
|---|---|---|
| **Main** | `src/main/index.ts` | Node.js — SQLite, IPC handlers, Fastify HTTP server, Ollama calls, vault watcher |
| **Preload** | `src/preload/index.ts` | Context bridge — the only file that can touch both Node and renderer worlds |
| **Renderer** | `src/renderer/src/main.tsx` | React 18 + Zustand UI — no direct Node/DB access |

Shared types live in `src/types/index.ts` and are imported by all three.

### Key dependencies and why they're there

| Package | Role |
|---|---|
| `electron` 31 + `electron-vite` 2 | Desktop shell + dev server with hot reload |
| `better-sqlite3` 12 | Synchronous local DB (fast, simple, no daemon) |
| `sqlite-vec` 0.1 | Optional vector-search virtual table; degrades gracefully if it fails to load |
| `fastify` 5 | Localhost HTTP server for the browser-extension API |
| `react` 18 + `react-dom` + `zustand` 4 | UI + state |
| `d3` 7 | Graph view layout (`GraphCanvas.tsx`) |
| `react-markdown` 9 + `highlight.js` 11 | Memory body rendering |
| `chokidar` 3 | Vault folder watcher |
| `mammoth` 1 | `.docx` text extraction for vault files |
| `lucide-react` 0.4 | Icons |
| `tailwindcss` 3 + `postcss` + `autoprefixer` | Styling |
| `vitest` 4 | Unit/integration tests (currently: transformers, embeddings, http, vault, graph-builder, chat-formatter) |
| `electron-builder` 24 | Installer packaging |

### Data flow

```
Renderer (window.electron.*)
        │ IPC
        ▼
Main process IPC handlers (src/main/index.ts)
        │
        ▼
db.ts ────────► SQLite tables: memories, memory_relationships,
                                fts_memories (full-text), memory_vectors (optional)
        │
        ▼
embeddings.ts ──► Ollama (all-minilm, dim=384) ──► sqlite-vec
                  └─ silently returns null if Ollama is down
                     → caller falls back to keyword search
```

### Extension surface (separate path)

```
Chrome extension (extension/manifest.json + content/background/popup scripts)
        │ HTTPS to 127.0.0.1
        ▼
Fastify on 127.0.0.1:<port>  (port probed in 48729-48738, fallback to ephemeral)
        │ Bearer token (set during pairing window)
        ▼
Same db.ts + embeddings.ts as IPC path
```

### HTTP API surface (from `src/main/http.test.ts`)

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness probe |
| `GET /pair` | none, **time-limited window** | Returns `{token, port}` once; window armed from Settings UI |
| `GET /api/recent` | bearer | List recent memories (with `?limit=`) |
| `GET /api/memories` | bearer | List all memories |
| `POST /api/memories` | bearer | Create a memory |
| `DELETE /api/memories/:id` | bearer | Delete a memory |
| `GET /api/search?q=&source=` | bearer | Keyword search |
| `GET /api/related?context=` | bearer | Semantic (vector) or keyword-fallback ranked relations |
| `GET /api/admin/embed-status?ids=` | bearer | Per-id embedding status (for debugging) |

### Renderer surface

`src/renderer/src/` contains:
- **Pages:** `Dashboard.tsx`, `Search.tsx`, `Settings.tsx`, `GraphView.tsx`
- **Components:** `Sidebar.tsx`, `MemoryEditor.tsx`, `GraphCanvas.tsx`, `FileTree.tsx`, `FileViewer.tsx`, `InsightPopup.tsx`
- **State:** `store.ts` (Zustand) — subscribes to `memories:changed` events from main so extension writes appear live without polling
- **Utilities:** `graph-builder.ts`, `chat-formatter.ts`
- **Keyboard nav:** Ctrl+1 Notes • Ctrl+2 Graph • Ctrl+3 Search • Ctrl+, Settings

### Installer config (`electron-builder.json`)
- Windows: NSIS, x64
- macOS: DMG
- Linux: AppImage
- App ID: `com.cortex.app`
- **Missing:** publish/update channel, code-signing config, ASAR settings, native-module unpack list. See §5 and §9.

---

## 3. What Works Right Now

**Verified end-to-end this session** (manual iteration through agent-browser → CDP):

| Flow | Status | Evidence |
|---|---|---|
| App launches via `npm run dev` | ✓ | electron-vite hot reload running, CDP exposed on :9333 (added this session) |
| Sidebar renders with live counters | ✓ | `Memories(0) → Memories(1)` updated reactively after save |
| Notes view (Ctrl+1) | ✓ | Editor opens with title, tag, markdown body fields, source dropdown, preview toggle |
| Memory create + save (Ctrl+S) | ✓ | Test memory `manual-test-010431` persisted, sidebar counter incremented |
| Tag input | ✓ | `#looptest` tag rendered after Enter |
| Search view (Ctrl+3) | ✓ | Dedicated semantic search textbox present |
| Search retrieval | ✓ | Query for `manual-test-010431` returned the just-created memory AND a related file match (`vault.test.ts`) |
| Graph view (Ctrl+2) | ✓ | D3 canvas mounts within 3s, no errors in snapshot |
| Settings view (Ctrl+,) | ✓ | "Settings" heading + "Pair Extension" button present |
| Vault file indexing | ✓ | 8,184 files indexed from `cortex/` |
| Keyboard navigation | ✓ | All four shortcuts switch views correctly |

**Plumbing verified by source/tests (not re-run this session):**
- HTTP API has full Vitest coverage in `http.test.ts` (auth gating, CRUD, search, related, admin/embed-status, pairing window)
- `transformers.test.ts` covers row → object mapping
- `embeddings.test.ts` covers Ollama call shape and null-safety
- `vault.test.ts` covers vault config and watcher
- `graph-builder.test.ts` covers graph topology construction

**Architectural guarantees observed in code:**
- Renderer cannot reach SQLite or Node APIs — preload contextBridge is the only seam
- Ollama down → silent null → keyword fallback (no user-visible failure)
- sqlite-vec native module load failure → vector paths bypassed (no user-visible failure)
- Extension pairing endpoint is closed by default and only opened by the Settings UI for a bounded window

---

## 4. What Doesn't Work / Known Bugs

> The automated cron loop has produced **zero real findings yet** — it was scheduled but has not had time to fire. The list below is from one **manual** iteration plus static reading of the code/config.

### Confirmed issues

| Severity | Issue | Where | Notes |
|---|---|---|---|
| HIGH (tooling) | `agent-browser screenshot` times out against Electron CDP | n/a (test harness) | Snapshot/click/fill all work on the same connection; `Page.captureScreenshot` specifically hangs. Blocks pixel-level visual QA. Not a Cortex bug, but breaks the `views` scenario of the polish loop. |
| LOW | No project `README.md` at root | repo root | Users cloning the repo have no orientation. |
| LOW | Test memory `manual-test-010431` left in user's vault | DB | Artifact of this session's manual test; delete from Notes when convenient. |

### Gaps observed in code/config (not necessarily bugs, but blockers for "standalone installer")

| Severity | Gap | File |
|---|---|---|
| HIGH | No `publish` block — `electron-builder` cannot push to an update channel | `electron-builder.json` |
| HIGH | No code-signing config (Windows SmartScreen, macOS Gatekeeper will warn) | `electron-builder.json` |
| HIGH | Ollama is an external dependency the user must install separately — no bundled binary, no install prompt | runtime |
| MEDIUM | sqlite-vec ships as a native module — needs `electron-builder install-app-deps` (already in `postinstall`) but **no explicit `asarUnpack` for `*.node`** | `electron-builder.json` |
| MEDIUM | No first-run onboarding UI documented (vault picker, Ollama check, pairing tutorial) | `src/renderer/src/pages/` |
| MEDIUM | One disabled test file: `src/main/db.test.disabled.ts` — coverage gap on the DB layer | `src/main/` |
| LOW | No icon files referenced are confirmed to exist in `build/` (`icon.ico`, `icon.icns`, `icon.png`) | `electron-builder.json` references them |

### What the automated loop **has not yet** tested
- Multi-iteration soak (only iter 0 logged, and that was a tooling failure from the pre-restart attempt)
- Extension pairing end-to-end (Pair Extension button → /pair → bearer call to /api/memories)
- Editing an existing memory
- Deleting a memory
- Relationships UI (the code exists; no flow verified)
- Vault file viewer (`FileViewer.tsx`)
- Memory Insights popup (`InsightPopup.tsx`, button present in editor)
- Source attribution switching (Manual / Claude / ChatGPT / Gemini)

---

## 5. What Needs to Be Fixed (Priority Order)

### P0 — Must fix before any public installer

1. **Code signing on Windows and macOS.** Without it, every download triggers an OS-level warning that kills install conversion. `electron-builder.json` needs `win.certificateFile` (or Azure Trusted Signing) and `mac.identity`.
2. **Ollama story.** Decide: bundle Ollama binary in the installer, or detect-and-prompt-to-install on first run. Today the app launches fine without it (silent fallback), but search quality drops to keyword-only and users won't understand why.
3. **Native module unpacking.** Add `asarUnpack: ["**/*.node"]` to `electron-builder.json` or `better-sqlite3` / `sqlite-vec` will fail to load in the packaged build.
4. **Validate icons exist.** `electron-builder.json` references `build/icon.{ico,icns,png}` — confirm these are committed.

### P1 — Strongly recommended before public installer

5. **Re-enable or rewrite `db.test.disabled.ts`.** SQLite layer is the hottest code path and the only major module without direct unit tests.
6. **First-run onboarding.** A 3-step wizard: pick vault folder → check Ollama presence → optional extension pairing. The IPC handlers (`vault:choosePath`, `vault:initVault`) already exist.
7. **Project README.** Even a short one. Today the only doc is `CLAUDE.md`, which is agent-facing.
8. **`publish` channel in `electron-builder.json`.** Without it, no auto-update mechanism.

### P2 — Polish

9. Investigate the agent-browser screenshot timeout (or accept snapshot-only QA and remove screenshot steps from the loop).
10. Wire up an error overlay or status bar that surfaces "Ollama unreachable — search degraded" rather than failing silently.
11. Cover the untested UI flows in §4 with explicit tests.

---

## 6. What Should Be Added (Features) **[inferred]**

> These are recommendations based on what the codebase implies, not from any documented roadmap. Treat as a starting list, not a commitment.

### For MVP installer
- First-run onboarding wizard (vault folder, Ollama check, extension pair)
- "About / Updates" panel in Settings (version, check for updates)
- Backup / export memories (JSON or markdown bundle)
- Import from other tools (Obsidian, Apple Notes, etc.) — the vault watcher already eats markdown
- Visible Ollama/embedding status indicator
- Empty-state and zero-data UX for Notes / Graph / Search

### Nice-to-have post-MVP
- More LLM source integrations (Perplexity, Mistral, local llama.cpp)
- iOS/Android companion (read-only first) syncing via end-to-end-encrypted blob
- Cross-device sync (CRDT or simple file-sync via the user's iCloud/Dropbox)
- Tagging suggestions from embeddings
- Memory "decay" / archive flow for stale notes
- Shareable read-only memory links

### Things end users typically expect in a standalone app
- Auto-update with release notes
- Crash reporting (opt-in)
- A real app icon and a polished installer screen
- Light/dark theme follow OS
- Global hotkey to quick-capture a memory
- System tray / menu bar presence
- Settings export/import

---

## 7. What We Did This Session

### Tools installed globally
| Tool | Method | Purpose |
|---|---|---|
| `uipro-cli` 2.2.3 | `npm i -g uipro-cli` | UI/UX Pro Max skill installer for any project |
| `agent-browser` 0.27.0 | `npm i -g agent-browser` + `agent-browser install` (downloaded Chrome 149) | CDP-based browser/Electron automation CLI |
| `@wonderwhy-er/desktop-commander` | `npm i -g`, registered via `claude mcp add desktop-commander --scope user` | MCP server for terminal + filesystem control. Loads on next Claude Code session. |
| Computer Use MCP | already built in | Disconnected during this session — never used end-to-end |

### Automation set up
- Cron job **`c47f71e4`** registered, fires every 5 minutes, recurring (auto-expires in 7 days). Loop body uses `agent-browser` (not Computer Use) to drive the Electron app. Replaces earlier cancelled job `dd54d47b`.

### Code changes to Cortex
- **`src/main/index.ts`** — added one block before `app.whenReady()`:
  ```ts
  if (is.dev) {
    app.commandLine.appendSwitch('remote-debugging-port', '9333')
  }
  ```
  This exposes Electron's CDP on port 9333 in dev mode only (not production). Required for agent-browser to attach.

### Files created
- `.cortex-loop-state.json` — loop iteration counter and findings
- `.cortex-loop-log.md` — one-line-per-iteration log
- `.cortex-shots/` — text snapshots from the manual iteration (00 baseline through 07 settings), plus failed screenshot placeholders
- `.agents/skills/agent-browser/` — agent-browser skill installed into project (symlinked into Claude Code)

### Manual end-to-end test results
See §3 — created a memory, searched and found it, switched to Graph (canvas mounted), opened Settings. **All four primary views functional.** One bug found in the test harness (not the app): `agent-browser screenshot` times out against Electron CDP. Worked around by capturing snapshots as text — actually richer than pixel screenshots for functional QA.

---

## 8. What Needs to Be Done Next

### This week
- [ ] Decide screenshot strategy: investigate CDP timeout, or accept snapshot-only QA (recommendation: accept; snapshot is stronger signal for bot QA)
- [ ] Let the cron loop run for several hours and review its findings
- [ ] Delete `manual-test-010431` from the vault (or keep as marker)
- [ ] Write a real project `README.md`
- [ ] Verify `build/icon.{ico,icns,png}` exist and look right
- [ ] Confirm `asarUnpack` for native modules before any packaged-build attempt

### This month
- [ ] Re-enable or rewrite `db.test.disabled.ts`
- [ ] Build first-run onboarding wizard (vault, Ollama check, pairing tutorial)
- [ ] Set up code signing (Windows: Azure Trusted Signing is cheapest viable path; macOS: developer ID + notarization)
- [ ] Decide Ollama bundling vs detect-and-prompt; implement the chosen path
- [ ] Wire up `publish` channel in `electron-builder.json` (GitHub releases is the lowest-friction default)
- [ ] First successful packaged build on at least Windows; smoke-test the installer in a clean VM

### To reach standalone installer
- [ ] All P0/P1 items from §5 closed
- [ ] First-run UX tested by someone who has never seen the app
- [ ] Auto-update verified end to end (release v0.1.1 over v0.1.0)
- [ ] Crash reporting decided (Sentry, opt-in self-hosted, or none)
- [ ] Privacy/security review of the localhost HTTP server (token rotation, log redaction)
- [ ] Distribution channel chosen (see §9)

---

## 9. Future Roadmap **[inferred]**

### Bundling Ollama
Two viable paths:
1. **Bundle:** Ship the `ollama` binary inside the installer, manage its lifecycle from the main process (start on app launch, stop on quit), pull `all-minilm` on first run with a progress UI. Pro: zero user friction. Con: ~600 MB installer, platform-specific binaries, license review needed for redistribution.
2. **Detect + prompt:** First-run wizard checks `http://127.0.0.1:11434/api/tags`, links to ollama.com if missing, then pulls the model. Pro: tiny installer. Con: extra step for non-technical users.

Recommendation: start with (2) for v0.1.x, evaluate (1) once user feedback comes in.

### electron-builder packaging
Current `electron-builder.json` is minimal. To reach release-ready:
```jsonc
{
  // existing keys plus:
  "asar": true,
  "asarUnpack": ["**/*.node"],
  "publish": [{ "provider": "github", "owner": "...", "repo": "cortex" }],
  "win": { "...": "...", "signtoolOptions": { ... }, "verifyUpdateCodeSignature": true },
  "mac": { "...": "...", "hardenedRuntime": true, "gatekeeperAssess": false, "entitlements": "build/entitlements.mac.plist", "notarize": true },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true, "perMachine": false }
}
```

### Auto-update system
- `electron-updater` (peer of electron-builder) is the standard choice
- Pair with GitHub Releases as the channel (free, no infra)
- Add an in-app "check for updates" + automatic background check
- Communicate update notes to user before applying

### First-run onboarding wizard
3 steps:
1. **Vault** — pick a folder; explain that it's just a folder on disk, no lock-in
2. **AI features** — detect Ollama, offer to install if missing, pull `all-minilm` with progress
3. **Browser extension** — link to Chrome Web Store (once published), then guide through Settings → Pair

### Distribution plan **[needs decision]**
- **Direct download** from a marketing site (cortex.app or similar) — most control, you handle hosting
- **GitHub Releases** only — zero cost, dev-audience friendly, no marketing surface
- **Microsoft Store / Mac App Store** — discoverability, but sandboxing constraints will hurt the filesystem watcher and the localhost server (App Store will likely reject)
- **Homebrew (mac) / winget (Windows)** — power-user channels, cheap to set up after primary distribution exists

Recommendation: GitHub Releases for v0.1 (dev users), then add direct-download + a landing page when you're ready for non-dev users.

---

## 10. Automation Status

### Current loop
- **Cron job ID:** `c47f71e4`
- **Cadence:** every 5 minutes (`*/5 * * * *`)
- **Lifetime:** session-only (dies when this Claude Code session exits), auto-expires after 7 days
- **What it tests:** rotates per iteration through three scenarios — `crud` (create+save+search verify), `views` (cycle four views with snapshots), `extension` (pair + bearer-call /api/memories)
- **Stop conditions:** user `CronDelete c47f71e4`, OR 3 consecutive `needs human` findings → loop writes `STOP` flag and aborts
- **Output:** `.cortex-loop-state.json` (counter + findings) and `.cortex-loop-log.md` (one line per iteration)

### What the loop catches automatically
- Launch failures (CDP not responding)
- Navigation regressions (a view that no longer mounts)
- Search regressions (created memory doesn't surface)
- Visible error banners or stack traces in the a11y tree
- Extension API regressions (pair endpoint or `/api/memories` returning non-2xx)
- It will attempt **single-file, single-line root-cause fixes** for HIGH severity findings and revert via `git checkout --` if the fix doesn't stick. Multi-file root causes are logged as `needs human`.

### What the loop does NOT do
- Pixel-level visual regression (screenshot path is broken — see §4)
- Performance/load testing
- Network failure simulation (Ollama up/down, sqlite-vec native module missing)
- Multi-window or extension-side testing
- Anything outside `C:\Users\shubh\cortex`

### How to restart after Claude Code session ends
The cron job lives in-process. After Claude Code exits:
1. Relaunch Cortex: `cd C:\Users\shubh\cortex ; npm run dev` (CDP on :9333 now wired in)
2. Reconnect agent-browser: `agent-browser connect 9333`
3. Re-issue the `/loop` command — the prompt body is preserved in `.cortex-loop-log.md` headers and can be re-pasted, or stored as a slash command for convenience

For **durable** scheduling that survives Claude Code restarts, use the cloud-scheduled `/schedule` skill instead (referenced in `/loop`'s own docs). That requires a connected Anthropic cloud account.

---

## 11. Open Questions

> Decisions blocking progress. Owner input needed.

1. **Ollama bundling:** bundle the binary or detect-and-prompt? (§9)
2. **Distribution channel for v0.1:** GitHub Releases only, or also direct download + landing page? (§9)
3. **Code signing budget:** Windows Trusted Signing is ~$10/mo; macOS Apple Developer is $99/yr. Confirm both are in scope before P0 work starts.
4. **Crash reporting:** Sentry SaaS, self-hosted GlitchTip, or none for v0.1?
5. **Source attribution roadmap:** the editor exposes a Manual/Claude/ChatGPT/Gemini dropdown — what's the intended UX for source-aware filtering? Is there a planned per-source view?
6. **Memory Insights:** there's a "Memory Insights" button in the editor (`InsightPopup.tsx`). What does it do today, and what should it do at MVP?
7. **Relationships:** schema and IPC handlers exist (`memory_relationships`, `relationships:create/delete/getForMemory`) but no UI was exercised in this session. Is the relationships feature in-scope for v0.1?
8. **Browser extension distribution:** Chrome Web Store submission, or unpacked-dev only at launch?
9. **Privacy posture for the localhost server:** the bearer token is on disk in `userData/extension-config.json`. Should this be in the OS keychain instead?
10. **Telemetry stance:** any analytics at all, even anonymous install pings?

---

*End of report. File: `CORTEX-REPORT.md` in project root. Update via re-running this generation; do not hand-edit if regeneration is planned.*
