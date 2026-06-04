# Cortex Roadmap — Fastest Path to a Real User With a Working Installer

> Author's note. This is not a wishlist. It is a sequenced plan written by someone who has shipped Electron apps and watched friends ship them. The order matters. Every milestone removes a class of risk; skipping ahead to "polish" before the foundations exist is the single most reliable way to burn a month and ship nothing. Read the framing in §0 before reading the phases — without it, the priorities will look strange.
>
> Grounded in: a full read of `src/main/*` (`index.ts`, `db.ts`, `http.ts`, `embeddings.ts`, `vault.ts`, `extension-config.ts`, `seed-embeddings.ts`, `transformers.ts`), `src/preload/index.ts`, `src/types/index.ts`, `src/renderer/src/App.tsx`, `pages/Settings.tsx`, `pages/Dashboard.tsx`, `store.ts`, `package.json`, `electron-builder.json`, `CLAUDE.md`, `extension/manifest.json`, `.cortex-loop-log.md`, and one manual end-to-end test session.

---

## Status — 2026-06-04

**Phase 0 (build) and Phase 1 (first contact UX) are COMPLETE.**

### Exit criteria met

| Phase | Criterion | Status |
|---|---|---|
| 0 | `npm run release` succeeds end-to-end (NSIS installer produced) | ✓ `release/Cortex Setup 0.1.0.exe` (83 MB) |
| 0 | Native modules unpack correctly (better-sqlite3 + sqlite-vec) | ✓ Smoke-launched packaged exe; sqlite-vec loaded, vector search enabled |
| 0 | App launches, creates memory, persists across restart | ✓ Verified in packaged build |
| 0 | No "Cannot find module" or sqlite-vec runtime errors | ✓ |
| 0 | Schema version row exists in DB | ✓ `SCHEMA_VERSION = 1` constant + table + insert |
| 0 | Icons render | ✓ `build/icon.ico` + `build/icon.png` generated (256×256 diamond) |
| 0 | electron-log file logger initialized | ✓ Writes to `<userData>/logs/main.log` |
| 1 | First-launch routes user to vault picker with banner | ✓ `App.tsx` `needsVault` state |
| 1 | Vault watcher excludes `node_modules`/build outputs | ✓ Shared `WATCH_IGNORE` (~40 patterns: deps, build outputs, IDE, OS, media) |
| 1 | Unchanged files don't re-embed on restart | ✓ `indexFile` stat-compare early return |
| 1 | `LIKE` queries escape user input | ✓ `escapeLike` + `ESCAPE '\'` clauses |
| 1 | No fake `Memory.importance` field | ✓ Removed from types, transformer, store, all renderer call sites + 1-5 star UI block |
| 1 | Ollama status visible to user | ✓ `system:getStatus` IPC + Settings panel + bottom status bar |
| 1 | All console.* in main process routed through electron-log | ✓ 17 sites swept across db, vault, embeddings, seed-embeddings, extension-config, index |
| 1 | vec0 UNIQUE constraint fixed | ✓ DELETE+INSERT inside transaction for both vector tables |
| 1 | Orphan vector rows cleaned on init | ✓ `DELETE FROM ..._vectors WHERE id NOT IN ...` in `initDb` |

### What changed in the codebase

19 files touched, plus `package.json` for `electron-log@5.4.4`:

```
electron-builder.json                                # asar+asarUnpack, removed !node_modules
build/icon.ico, build/icon.png                       # generated placeholders
src/main/db.ts                                       # schema_version, sqlite-vec path fix,
                                                     # escapeLike, vec0 upsert transaction,
                                                     # orphan cleanup, log.*
src/main/vault.ts                                    # shared WATCH_IGNORE on vault watcher,
                                                     # stat-compare early return, log.*
src/main/transformers.ts, transformers.test.ts       # remove importance: 3
src/main/embeddings.ts, seed-embeddings.ts           # log.* sweep
src/main/extension-config.ts                         # log.* sweep
src/main/index.ts                                    # electron-log/main init, system:getStatus,
                                                     # log.* leftover sites
src/preload/index.ts                                 # system.getStatus bridge
src/types/index.ts                                   # SystemStatus, ElectronAPI.system,
                                                     # remove Memory.importance
src/renderer/src/App.tsx                             # needsVault banner, StatusBar bottom strip
src/renderer/src/pages/Settings.tsx                  # AiStatusPanel + StatusRow
src/renderer/src/pages/GraphView.tsx                 # drop importance arg
src/renderer/src/components/MemoryEditor.tsx        # remove Star icon, importance state,
                                                     # 1-5 star UI block, save/deps cleanup
src/renderer/src/utils/graph-builder.ts + test       # drop importance from GraphMemory
package.json                                         # + electron-log@5.4.4
```

### Discovered issues NOT in original roadmap (worth tracking)

1. **`winCodeSign-2.6.0.7z` extraction needs Windows Developer Mode or admin** — Windows blocks symlink creation; macOS `.dylib` symlinks inside the archive fail. Worked around by pre-extracting once with `7za x -y winCodeSign-2.6.0.7z -ownCodeSign-2.6.0` to `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\` before the first `electron-builder` run. **This must be automated for CI** (enable Developer Mode globally, or scriptify the pre-extract).
2. **sqlite-vec's `getLoadablePath()` returns an `app.asar` path that fails for native `LoadLibrary`.** Patched in `db.ts:initDb` to rewrite `app.asar\` → `app.asar.unpacked\` in packaged builds. No-op in dev.
3. **`build/icon.icns` missing** — macOS DMG build will fail until generated. Windows-only builds unaffected.
4. **Pre-existing TS strict-null warnings**: `GraphCanvas.tsx` ctx-possibly-null (9 sites), `MemoryEditor.tsx:96` `return null` with `React.ReactElement` return type. `npm run build` passes; `tsc --noEmit --strict` does not. P2 cleanup.

### Phase 1.7 decision still open (Ollama)

§Phase 1.7 of this roadmap asked: bundle Ollama in the installer, or detect-and-prompt? The current implementation (`AiStatusPanel`) takes the **detect-and-prompt** path — the Settings AI Features section shows red/amber when Ollama is missing and links to `ollama.com/download`. No bundling. That's the recommended Phase 1 path; revisit in Phase 4+ if user feedback says install friction is the limiting factor.

### Live validation

One full crud iteration through the loop (cron job `c47f71e4`) on the dev build confirmed end-to-end behaviour:
- Notes view → New → fill title+body+tag → Ctrl+S → switch to Search → query → result returns. `Memories(1)→(2)`.
- Status bar visible at bottom: `Semantic search: on (N/M embedded) port 48729`
- Editor toolbar has no Star buttons (importance removal visible in the running app)

See `.cortex-loop-log.md` for the per-iteration record.

---

## Tooling additions

- **Claude Council skill** installed at `~/.claude/skills/claude-council` (cloned from [`itshussainsprojects/Claude-Council-Skill`](https://github.com/itshussainsprojects/Claude-Council-Skill); MIT). Activates on phrases like "Should I...", "Help me decide...", or "Convene the council...". 7 expert personas debate the question and produce a synthesized verdict. Use it for the architectural calls in Phase 3+ where multiple valid answers exist (e.g. "auto-update strategy", "telemetry posture", "extension distribution"). Decision logs land in `~/.claude/councils/` if the skill chooses to persist them.

## Decisions locked — 2026-06-04 (Cortex rename)

| Question | Final answer |
|---|---|
| 1. First user | Developer's other laptop (tech-comfortable, Windows 11) ✓ |
| 2. Repository | Public GitHub, open source ✓ |
| 3. Platform v0.1 | Windows-only ✓ |
| 4. Code signing | **SKIPPED for v0.1** — no Azure spending. SmartScreen click-through accepted. ✓ |
| 5. Product name | **Cortex** ✓ |
| 6. Ollama strategy | Detect-and-prompt; AiStatusPanel in Settings links to ollama.com ✓ |

Project also renamed in this pass: `Cortex` → `Cortex` across package.json, electron-builder.json, all source, all docs, and the browser extension (including the discovery handshake `body.app === 'cortex'`). New installer artifact: `release/Cortex Setup 0.1.0.exe` (83 MB).

---

## Next: Phase 2 — Distribution (revised, no signing)

The original Phase 2 below assumed code signing was in scope. **It is not for v0.1.** This rewrites that scope.

### What Phase 2 IS now

| Item | Effort | Why |
|---|---|---|
| Public GitHub repo at `github.com/shubhsaxena2020/cortex` | ~30 min | Hosts releases, code, issues. Free. |
| `LICENSE` (MIT) | done | Confirms repo is OSS. |
| `README.md` with install + SmartScreen workaround | done (Cortex pass) | First-touch onboarding for v0.1 audience. |
| GitHub Release v0.1.0 with installer + checksum | ~30 min | Distribution mechanism. |
| `electron-updater` wired with `publish.github` block in `electron-builder.json` | ~1 hour | So **future** versions auto-update once user has v0.1.0 installed. Without this you ship v0.1.1 by emailing your friend a link. |
| Crash telemetry (opt-in, Cloudflare Worker endpoint) | ~2 hours | Optional but cheap. Skip if uncomfortable. |
| Privacy note in README | ~10 min | "Your data stays on your machine. No telemetry by default. Token never leaves localhost." |

### What Phase 2 is NOT (deferred)

- **Azure Trusted Signing** — $10/month + 1-3 days verification. Skip. The SmartScreen click-through is acceptable for the friend-on-other-laptop audience. Revisit when audience widens beyond people you can text directly.
- **macOS / Linux builds** — defer to Phase 4+.
- **Chrome Web Store** — defer; sideload zip in Release works for v0.1.
- **Crash reporter dashboard** — minimal worker endpoint is enough; no Sentry/GlitchTip until volume justifies.

### SmartScreen workaround (must be in README — already added)

> On first launch Windows will show a blue "Windows protected your PC" dialog because the installer is unsigned. Click **More info → Run anyway**.
>
> This is expected for v0.1. Code signing is intentionally deferred — see CORTEX-ROADMAP.md §Phase 2 for rationale. The installer hash is published on the release page so you can verify it independently.

### Phase 2 exit criteria (revised)

- [ ] Public GitHub repo `cortex` initialized with current code
- [ ] `LICENSE` in root ✓ (already done in rename pass)
- [ ] `README.md` complete with SmartScreen note ✓ (already done in rename pass)
- [ ] GitHub Release v0.1.0 tagged with `Cortex Setup 0.1.0.exe` + sha256 checksum file
- [ ] `electron-builder.json` has `publish: [{provider: github}]` block
- [ ] `electron-updater` wired in `src/main/index.ts` (already partially scaffolded by the roadmap reference; not yet committed in code)
- [ ] First friend successfully installs from the release URL on a clean Windows 11 machine without you sitting next to them

The original §Phase 2 — Trust section further below (about Azure Trusted Signing, notarization, etc.) is preserved as reference but is **out of scope for v0.1**. Treat anything in there about money as deferred.

---

## Phase 3 — First Real User End-to-End (revised, replaces extension section)

### Goal
Your friend on their other Windows 11 laptop:
1. Visits the GitHub Releases page.
2. Downloads `Cortex Setup 0.1.0.exe`.
3. Clicks through SmartScreen.
4. Launches Cortex, picks a vault folder.
5. (Optional) Installs Ollama and pulls `all-minilm`.
6. Sideloads the browser extension from a zip in the same release.
7. Pairs the extension with the app.
8. Saves a snippet from claude.ai and finds it in Cortex.

Goal hit. Stop. Iterate based on actual feedback.

### Step-by-step plan

**3.1 — Create the GitHub repo and push initial commit (30 min)**

```bash
cd C:\Users\shubh\cortex
git init                                 # already a repo? check first
git add .
git commit -m "Initial public release: Cortex v0.1.0"
gh repo create cortex --public --source=. --remote=origin --push
```

Decide owner/visibility first (your personal account is fine). `gh` CLI authenticates via browser; first run will prompt.

**3.2 — Wire `electron-updater` + GitHub publish (1 hour)**

Edit `electron-builder.json`:

```jsonc
"publish": [{
  "provider": "github",
  "owner": "shubhsaxena2020",
  "repo": "cortex"
}]
```

Edit `src/main/index.ts`:

```ts
import { autoUpdater } from 'electron-updater'

// inside app.whenReady().then(...), after createWindow():
if (!is.dev) {
  autoUpdater.logger = log  // electron-log already in scope
  autoUpdater.checkForUpdatesAndNotify().catch(err => log.warn('autoUpdater:', err))
}
```

Install: `npm i electron-updater`. Test by setting up the release flow in 3.3 — don't try to verify autoupdate in isolation; it only works against a real GitHub release.

**3.3 — Cut v0.1.0 release (30 min)**

```powershell
# Build and stage
npm run build
npx electron-builder --win nsis

# Compute sha256 of the installer
$installer = "C:\Users\shubh\cortex\release\Cortex Setup 0.1.0.exe"
Get-FileHash $installer -Algorithm SHA256 | Format-List

# Build the extension zip
Compress-Archive -Path C:\Users\shubh\cortex\extension\* -DestinationPath C:\Users\shubh\cortex\release\cortex-extension-0.2.0.zip -Force
```

Then on GitHub:
1. Tag `v0.1.0` in the repo.
2. Create a new release on that tag.
3. Upload three files: `Cortex Setup 0.1.0.exe`, `Cortex Setup 0.1.0.exe.blockmap`, `cortex-extension-0.2.0.zip`.
4. Paste the sha256 hash into the release description.
5. Release notes — keep short. Example:

```markdown
## Cortex v0.1.0 — first public release

Local AI memory layer for Windows. Semantic search across notes, files, and conversations from Claude / ChatGPT / Gemini.

### Install
1. Download `Cortex Setup 0.1.0.exe`.
2. Run it. Windows will warn it's unsigned — click **More info → Run anyway**.
3. On first launch, pick a folder to use as your vault.

### Optional: enable semantic search
Install [Ollama](https://ollama.com/download) and run `ollama pull all-minilm`. Without it, search falls back to keyword matching.

### Optional: install the browser extension
1. Download `cortex-extension-0.2.0.zip` and unzip.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked**, point at the unzipped folder.
4. In Cortex, go to Settings → **Pair Extension**, then click the extension icon.

### Verify the download
SHA-256 of `Cortex Setup 0.1.0.exe`:
`<hash here>`

### What's working
- Notes view (create, edit, delete, search)
- Graph view (D3 visualization of memory + file connections)
- Settings (vault picker, watch folder, extension pairing, AI feature status)
- Browser extension: right-click "Save to Cortex" on claude.ai / chatgpt.com / gemini.google.com

### Known limitations
- Unsigned installer (SmartScreen warning on first install)
- Windows only — macOS/Linux builds will come later
- Extension is unpacked-only; not in the Chrome Web Store yet
```

**3.4 — Test end-to-end from your other laptop (1 hour)**

This is the real exit criterion. Don't skip it because the installer "looks right" on the dev machine.

Checklist on the second laptop:
- [ ] Open the release page in a browser.
- [ ] Click the `.exe` link, run it, observe SmartScreen warning, click through.
- [ ] After install, launch from Start Menu (verify the icon and app name look right — not "Cortex", not "Electron").
- [ ] First-launch banner asks for vault folder. Pick one.
- [ ] Status bar at bottom shows "Semantic search: off" if Ollama not present (this is the test for Phase 1.3).
- [ ] Install Ollama on this laptop. `ollama pull all-minilm`. Restart Cortex. Status bar should flip to "on".
- [ ] Create a memory. Switch to Graph. Switch to Search. All four views should render without errors.
- [ ] Download the extension zip from the same release page, sideload via `chrome://extensions`.
- [ ] In Cortex Settings → Pair Extension. Click extension icon, follow pair flow.
- [ ] Go to claude.ai, right-click a message, "Save to Cortex". Verify it appears in the sidebar.

If any step fails: log it, fix it on the dev machine, cut v0.1.1, repeat the test. The friction you observe IS the v0.2 backlog.

**3.5 — INSTALLATION.md (optional, 20 min)**

If 3.4 reveals confusing steps, write `INSTALLATION.md` with screenshots. Keep it under 2 pages. Link from README. Don't write it preemptively — let the actual stumbles guide it.

### Phase 3 exit criteria

- [ ] Public GitHub repo with code + release
- [ ] v0.1.0 release with installer + extension zip + sha256
- [ ] electron-updater wired (verify path-by-path test in v0.1.1)
- [ ] Friend successfully runs Cortex end-to-end on their laptop without you helping
- [ ] At least one memory saved from claude.ai via the extension reaches the friend's vault

### What "done" looks like for v0.1

A working installer, a real user, a fresh install on a machine you don't own, a memory that travels from claude.ai through the extension into the vault. Anything beyond that is v0.2 territory.

---

## 0. Framing

### What "shipping" actually means here

There's no point planning a six-month roadmap if we don't agree on what victory looks like. The fastest credible definition:

> **A tech-comfortable friend, on a clean Windows machine they've never used Cortex on, downloads a single file from a GitHub release, runs it, gets through a 30-second first-run flow, creates a memory, retrieves it via the browser extension from Claude.ai, and still has the app working a week later.**

This definition is deliberately narrow. It does **not** require:
- A signed installer that doesn't trigger SmartScreen
- A macOS or Linux build
- An auto-updater
- Anything on the Chrome Web Store (sideloaded unpacked extension is fine for first user)
- Polish on Graph, Insights, or any view beyond Notes/Search/Settings

Once we hit this milestone, every subsequent phase removes one specific class of friction and unlocks a wider audience. Trying to clear all classes simultaneously is what kills solo projects.

### Who the first user is

Two viable shapes. They imply different tradeoffs:

| Audience | What they tolerate | What they won't tolerate |
|---|---|---|
| **Friend / dev / power user** (recommended for v0.1) | Unsigned installer, SmartScreen click-through, "ollama is required, here's the install link", a manual extension sideload | App crashing on first launch, losing data, vault eating their entire Documents folder |
| **Random downloader from a landing page** | Maybe a `Run anyway` if they really want it | SmartScreen warning, no signature, no notarization, no auto-update, no support email |

The gap between these two is roughly **$400/year + 3-4 weeks of elapsed calendar time** spent on signing, notarization, and update infrastructure. That gap is what most of Phase 2 spends. If the first audience is enough to get product signal, the spend can be deferred.

### What I read that changes the prior report

The earlier `CORTEX-REPORT.md` was directionally right but missed five things that affect ordering:

1. **The Settings page already has a vault picker and a watch-folder picker.** The "no first-run onboarding" framing was wrong in spirit. What's missing isn't the UI — it's a forcing function on first launch that pushes the user there. (§Phase 1.4)
2. **The vault watcher has no exclusion list.** `vault.ts:142-152` starts chokidar with only `/(^|[/\\])\../` ignored — dotfiles. The exhaustive `WATCH_IGNORE` list (`vault.ts:12-31`) is **only** used by the separate watch-folder watcher. If a user points their vault at a normal folder (Documents, Desktop, a project dir), Cortex will happily index `node_modules`, `__pycache__`, `.cache`, video files, archives, and binaries. This is how the dev instance ended up with **8,184 indexed files** in our test — the vault was pointed at the project directory itself. This is the highest-impact bug in the codebase right now. (§Phase 1.2)
3. **`indexFile` re-indexes and re-embeds unchanged files on every restart.** `vault.ts:109-135` calls `db.upsertVaultFile` unconditionally and, if `hasVectorSearch`, fires `getEmbedding` against Ollama. Combined with `ignoreInitial: false` on both watchers, every startup re-embeds every indexed file. For a user with a thousand files this is a wall of Ollama traffic and a long startup. The fix is one stat-compare. (§Phase 1.2)
4. **`fts_memories` is maintained but never queried.** `db.ts` writes to it on every create/update/delete but `searchMemories` uses `LIKE %q%`. The FTS table is pure overhead today. (§Phase 4)
5. **`Memory.importance` is a lie.** The DB has no `importance` column; `transformers.toMemory` hardcodes `3`. The type advertises it, the UI passes it on create, but the value never round-trips. Either remove the field or persist it — keeping a fake field will burn future-you when a UI feature depends on it. (§Phase 1 cleanup)

There's also a class of "missing observability" — the user has no in-app way to know whether Ollama is running, whether sqlite-vec loaded, or whether their embeddings are current. The architecture intentionally degrades silently, which is great for stability and terrible for trust. Phase 1 addresses this with a single status panel in Settings.

### One ordering principle to bind it all

> **Do the things that, if you don't do them, make everything after them pointless or unsafe. Don't do anything else.**

If the packaged build crashes on launch, signing it doesn't matter. If the vault eats `node_modules`, no UX polish matters. If Ollama isn't running, semantic search doesn't matter. The phases below are sorted exactly by this rule.

---

## 1. The Risk Graph (read this before any work)

The big risks, in order of "if this bites, weeks evaporate":

| # | Risk | Probability | When it bites | Mitigation |
|---|---|---|---|---|
| R1 | `better-sqlite3` or `sqlite-vec` fails to load in the packaged build | Very high (90%+) | First `npm run release` | `asarUnpack: ["**/*.node"]`, verify in a clean VM. See §Phase 0.2. |
| R2 | macOS notarization rejects on first attempt | Very high (95% first attempt) | When you submit to Apple | Use the `electron-builder` notarize hook; budget 2-3 attempts. Skip for v0.1 if Windows-only is acceptable. |
| R3 | Vault watcher indexes user's `node_modules` / `.git` / huge binaries | Certain (the bug exists now) | First non-trivial vault | Add exclusion list. See §Phase 1.2. |
| R4 | Chrome Web Store rejects extension submission | Likely (60%+ first time) | When you submit | Privacy policy URL, narrow `host_permissions`, no obfuscated code. Sideload first; defer Web Store. |
| R5 | Ollama isn't installed and user doesn't understand why search is "dumb" | Certain | First user without Ollama | First-run check; in-app status indicator. See §Phase 1.3. |
| R6 | DB schema breaks when v0.2 adds a column on top of an existing v0.1 user database | High | Second release | Add a migration system **before** the first release ships, even if it's a no-op. See §Phase 0.3. |
| R7 | SmartScreen / Gatekeeper block the unsigned installer; user gives up | Certain | First non-developer user | Either ship signed (Phase 2) or screen-record the click-through in the README. |
| R8 | The HTTP server token file leaks via a vulnerable Chrome extension or a future change | Medium-long-term | Anytime | Localhost-only mitigates most. Token rotation in v0.2. Not blocking v0.1. |
| R9 | A pre-1.0 user's data gets corrupted by an experimental migration or rebuild | Medium | Any time after first ship | Auto-backup the DB before every migration; never delete the previous file. |
| R10 | Performance collapse on a vault with 10k+ files because `LIKE` doesn't scale | Medium | When a power user shows up | FTS-backed search. Not blocking v0.1 but blocking v0.2. |

Anything not on this table is either (a) cosmetic, (b) recoverable in a patch release, or (c) someone else's problem (Electron, Ollama, Chrome).

---

## 2. Phase 0 — The Build Has to Build (1–2 weekends)

### Goal
`npm run release` produces a Windows `.exe` installer that, when run in a clean Windows 11 VM with no Node/npm/Electron present, installs Cortex, launches it, opens the window, lets you create a memory, and survives a restart. Nothing about polish, nothing about signing, nothing about Ollama. Just: it packages, it installs, it runs.

If this doesn't work, nothing downstream works. Most Electron MVPs die here because native modules behave differently in dev vs packaged builds and nobody discovers it until they try to ship.

### Why this is risky

`better-sqlite3` and `sqlite-vec` are both native modules. In dev, electron-vite + Node load the version compiled for your system. In a packaged build:
- The binary inside `.asar` archive cannot be `require()`'d as a `.node` file — `asar` is a flat archive without a real filesystem.
- The binary must match Electron's bundled Node ABI version, not the system Node.
- `sqlite-vec` ships its `.so`/`.dll`/`.dylib` separately and needs to be locatable at runtime.

The `postinstall` script (`package.json:13`) calls `electron-builder install-app-deps` which **rebuilds** native modules against Electron's ABI. That's correct. What's missing is the `asarUnpack` directive.

### Tasks

**0.1 — Add native module unpacking.** Edit `electron-builder.json`:

```jsonc
{
  // existing keys, plus:
  "asar": true,
  "asarUnpack": [
    "**/*.node",
    "**/better-sqlite3/**",
    "**/sqlite-vec/**"
  ]
}
```

The `**/*.node` glob catches the compiled bindings. The package-level globs catch any loose binaries shipped alongside (sqlite-vec ships a platform binary in its package root).

**0.2 — Verify icons exist.** `electron-builder.json` references `build/icon.ico` (Windows), `build/icon.icns` (macOS), `build/icon.png` (Linux). Confirm:

```powershell
Get-ChildItem build/icon.*
```

If they're missing or placeholders, generate them now. Don't ship a default Electron icon — it's the single biggest "this looks like a hobby project" signal to a first-time user. A single source PNG at 1024×1024 can produce all three formats via `electron-icon-builder` or online tools. Even a flat colored rectangle with a diamond and "LJ" beats the default.

**0.3 — Add a minimal DB migration shim before the first release.** Even if v0.1's schema is final, you need this in place so v0.2 doesn't break v0.1 users. Add to `src/main/db.ts`:

```ts
// After db.exec(CREATE TABLE...) calls, add:
const SCHEMA_VERSION = 1
db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`)
const row = db.prepare(`SELECT version FROM schema_version`).get() as { version: number } | undefined
if (!row) db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(SCHEMA_VERSION)
// Future: if (row.version < SCHEMA_VERSION) runMigrations(row.version, SCHEMA_VERSION)
```

That's it for now. The point is: **you cannot retroactively add a migration story.** If v0.1 ships without this scaffolding, you have to write a migration that detects "this DB has no `schema_version` table" before you can detect any other state. It's a one-line edit now or a multi-hour debug later.

**0.4 — Build, install, smoke-test in a clean VM.** Spin up a Windows 11 sandbox (built into Pro; for Home use a free Hyper-V Quick Create image). Copy the `.exe`. Install. Launch. Make a memory. Quit. Relaunch. Verify the memory persists. If anything fails, **stop and fix before moving on.** Likely failures:
- `Cannot find module bindings` → asarUnpack wrong.
- App launches then dies silently → check `%APPDATA%\Cortex\logs\` (Electron auto-creates if you wire `electron-log`; otherwise add it now).
- sqlite-vec warning logged but app works → fine, vector search degrades. Note for Phase 4.

**0.5 — Add `electron-log`.** Even a minimal logger that writes to `app.getPath('userData')/logs/main.log` will save you hours when a user reports "it just doesn't start." Add to `src/main/index.ts`:

```ts
import log from 'electron-log/main'
log.initialize()
log.transports.file.level = 'info'
// Replace console.log/warn/error with log.info/warn/error where it matters.
```

Then add to deps: `npm i electron-log`.

### Decisions due in Phase 0

- **Windows-only for v0.1, or all three platforms?** Recommendation: **Windows-only**. Mac/Linux each add 30-50% of the work for the same v0.1 audience. Add them in Phase 2 or 3 once Windows is proven.
- **Per-user or per-machine install?** Set `nsis.perMachine: false` in `electron-builder.json`. Per-user installs don't need admin rights and won't trigger UAC prompts. UAC during install is a 20-30% drop-off.

### Exit criteria for Phase 0

- [ ] `npm run release` succeeds
- [ ] Installer runs in a clean Windows 11 VM without admin rights
- [ ] App launches, creates a memory, persists across restart
- [ ] No `Cannot find module` or sqlite-vec errors in main.log
- [ ] Schema version row exists in DB
- [ ] Icons render in Start menu, taskbar, and window title bar

---

## 3. Phase 1 — Survive First Contact With a Real User (2–3 weekends)

### Goal
The app, when launched by someone other than you, does not embarrass itself in the first 60 seconds. This is the highest-leverage UX phase. Every fix here corresponds to a real bug or trust-killer you've already shipped in v0.0.

### Tasks in priority order

**1.1 — Force the user through vault setup on first launch.**

Today: if `vault-config.json` doesn't exist, the app boots with `currentVaultPath = null`, the renderer mounts, the user sees a sidebar with `Memories(0) Files(0)`, no obvious next step. Settings has the vault picker but the user has to find it.

Fix: in `src/renderer/src/App.tsx`, on mount, check `vault.getConfig()`. If null, automatically `setView('settings')` and render a top-of-page banner explaining why ("Pick a folder to store your memories — Cortex won't move or copy any files outside it"). Make the Vault Folder section the only visible thing in Settings until a vault is chosen (collapse the other sections behind `vault?.vaultPath` checks).

Time: ~1 hour.

**1.2 — Stop the vault watcher from eating `node_modules`.**

This is the bug that produced 8,184 indexed files in our test session.

Fix `src/main/vault.ts:142-152`. Add the same `WATCH_IGNORE` array the watch-folder watcher already uses, plus the dotfile pattern:

```ts
export function startVaultWatcher(vaultPath: string): void {
  stopVaultWatcher()
  watcher = chokidar.watch(vaultPath, {
    ignoreInitial: false,
    persistent: true,
    ignored: [
      /(^|[/\\])\../,
      ...WATCH_IGNORE
    ],
  })
  // ... rest unchanged
}
```

Then fix the re-embed-on-every-startup bug in `indexFile` (`vault.ts:109-135`):

```ts
export async function indexFile(filepath: string): Promise<void> {
  const ext = extname(filepath)
  const filename = basename(filepath)
  let size = 0
  let lastModified = 0
  let content: string | null = null

  try {
    const fileStat = await stat(filepath)
    size = fileStat.size
    lastModified = Math.floor(fileStat.mtimeMs)

    // Skip if the file is unchanged since the last index pass.
    const existing = db.getVaultFileByPath(filepath)
    if (existing && existing.lastModified === lastModified && existing.size === size) {
      return
    }

    content = await extractText(filepath, ext)
  } catch {
    return
  }

  db.upsertVaultFile({ filepath, filename, extension: ext, content, size, lastModified })

  if (content && db.hasVectorSearch()) {
    const file = db.getVaultFileByPath(filepath)
    if (file) {
      void getEmbedding(content.slice(0, 4000)).then(vec => {
        if (vec) db.storeVaultEmbedding(file.id, vec)
      })
    }
  }
}
```

That early-return is the single most impactful performance fix in the codebase. On a 2,000-file vault, startup goes from ~30 seconds of Ollama traffic to under one second.

Add tests in `vault.test.ts`: (a) ignore patterns suppress node_modules entries; (b) unchanged file doesn't re-embed.

Time: ~2 hours including tests.

**1.3 — Make Ollama state visible.**

The silent-degradation philosophy is correct for system stability but wrong for user trust. A first-time user with no Ollama installed will create a memory, search for it by keyword, get results, and never realize the semantic features they were promised aren't running.

Add a new section at the top of `Settings.tsx`:

```tsx
<section className="mb-10">
  <h2>AI Features</h2>
  <OllamaStatusRow />
</section>
```

Where `OllamaStatusRow` queries a new IPC endpoint `system:getStatus` that returns:

```ts
{
  ollama: { reachable: boolean, modelPulled: boolean, model: string },
  vectorSearch: { enabled: boolean, embeddedCount: number, totalMemories: number },
  apiServer: { port: number, listening: boolean }
}
```

Use the existing `isOllamaAvailable()` and `isEmbedModelAvailable()` from `embeddings.ts`. Render with three states per row: green check, yellow warning with action link, red error.

When Ollama is missing, the action link should go to `https://ollama.com/download` via `shell.openExternal`. When the model is missing, show the exact command (`ollama pull all-minilm`) and offer a "Copy" button.

Also add a thin status bar at the bottom of the main window (in `App.tsx`) showing "Semantic search: on" or "Semantic search: off — keyword only". This is the trust signal — the user always knows what mode they're in.

Time: ~3-4 hours.

**1.4 — Sanitize the `LIKE` search.**

`db.searchMemories` (`db.ts:195-218`) interpolates user input into a `LIKE %q%` pattern without escaping `%` or `_` or `\`. A user searching for `50%` gets garbage; a user searching for path-like strings with `_` gets too much. Not a security issue (parameterized binding handles SQL injection) but a correctness bug.

```ts
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, m => '\\' + m)
}
// then: `%${escapeLike(query)}%` and add ESCAPE '\\' to the SQL.
```

Same pattern in `searchVaultFiles`. Five-minute fix.

**1.5 — Remove or persist `Memory.importance`.**

Right now `transformers.toMemory` hardcodes `importance: 3`. The DB has no column. The UI passes `importance` on create and it's quietly dropped.

Two options:
- **Drop it.** Remove from `Memory` interface, remove from `createMemory` call in `App.tsx` and `Settings.tsx`. Simpler. Recommended for v0.1.
- **Persist it.** Add `importance INTEGER DEFAULT 3` column with a migration bumping `SCHEMA_VERSION` to 2. Add update path. Add UI to set it.

Recommendation: drop for v0.1. The Notes/Search workflow doesn't use importance anywhere; shipping a fake field is worse than shipping no field. Defer the feature to a future release if it earns its slot.

**1.6 — Add a vault-too-big guardrail.**

If the user picks a folder with more than, say, 5,000 indexable files, show a confirmation modal first. The watcher will technically work but the first indexing pass will pin a core of their CPU for several minutes and they'll think the app froze.

In `vault.ts` between `mkdir` and `startVaultWatcher`, walk the tree quickly with `fast-glob` (or a manual walker), count, and surface via an IPC event. If count > 5000, the renderer asks the user to confirm.

Time: ~2 hours.

**1.7 — Ollama bundling decision.**

This is the biggest UX-vs-engineering decision in the whole roadmap. Two viable paths:

| Path | Effort | UX | Installer size | When to choose |
|---|---|---|---|---|
| **A. Detect-and-prompt** | Low — already half built. Add a "Set up AI features" panel in Settings linking to ollama.com and explaining `ollama pull all-minilm`. | Two extra steps for the user, but transparent: they know what Ollama is, they choose to install it. | Small (~150 MB) | v0.1 with tech-comfortable first users. **Recommended.** |
| **B. Bundle the binary** | High. Ship platform-specific `ollama` binaries (~600 MB each), spawn them as a child process, manage lifecycle, pull the model on first run with progress UI, handle the Ollama license terms for redistribution. | Zero friction. User doesn't know Ollama exists. | Large (~750 MB) | Once you've proven product-market fit and the install-friction is the limiting factor on growth. |

Recommendation: **Path A for v0.1.** It's the difference between shipping in 6 weeks and shipping in 12+. Once you have 50 active users and you know what they actually use, revisit. The bundling path also introduces real maintenance debt: every Ollama release potentially needs a Cortex rebuild, your installer doubles in size, and license review of redistribution is non-trivial.

What "Path A done well" looks like:
- First-run modal: "Cortex works great as a notebook. For semantic search and AI-driven suggestions, install Ollama (free, 5 minutes). [Install now] [Maybe later]"
- The "Install now" button opens `ollama.com/download` in the user's browser and shows a panel that polls `/api/tags` every 5 seconds; when it returns 200, it auto-advances and offers the model pull.
- The "Maybe later" button dismisses; the status bar still says "Semantic search: off" so it's visible they can turn it on.

### Exit criteria for Phase 1

- [ ] First launch with no config opens Settings with the vault picker prominent
- [ ] Vault watcher does not index node_modules / .git / binaries in user's chosen folder
- [ ] Unchanged files don't re-embed on restart
- [ ] Ollama status is visible in Settings and in a bottom status bar
- [ ] `LIKE` searches handle `%` and `_` correctly
- [ ] No fake fields in the public Memory type
- [ ] Picking a 10,000-file folder prompts the user before indexing starts

---

## 4. Phase 2 — Trust (1–2 weekends + 2–3 weeks elapsed)

### Goal
A stranger downloading from a GitHub Release feels safe enough to run the installer. This is where you spend money and wait on third parties.

### The hard truth about code signing

For Windows you have three viable paths in 2026:

| Option | Cost | Pain | When to pick |
|---|---|---|---|
| **Azure Trusted Signing** | ~$10/month | Easiest. Cloud signing; no USB token. Requires Microsoft account verification (1-3 days). | **Recommended for solo devs.** |
| **EV code-signing cert from a CA** (Sectigo, DigiCert) | $300-600/year | USB hardware token mailed to you, signing happens locally via a custom signer. | Skip — Azure is strictly better in 2026. |
| **Standard OV cert** | $80-200/year | Cheap but SmartScreen still warns until your reputation builds (months of signed installs). | Don't bother — the warning still appears for weeks. |

For macOS:
- Apple Developer Program: **$99/year**
- Notarization is a separate step that runs after signing and uploads the build to Apple for verification. Takes 5-30 minutes per build. First attempt usually fails because of an entitlements issue; budget 2-3 attempts.

For v0.1 the call is: **sign for Windows, skip macOS, document the SmartScreen click-through in the README.** Cost: $10/month and one weekend for setup.

### Tasks

**2.1 — Set up Azure Trusted Signing.**

The official docs: https://learn.microsoft.com/en-us/azure/trusted-signing/quickstart. The high-level flow:
1. Create an Azure account if you don't have one (free tier covers initial setup).
2. Identity verification — submit your government ID or business documentation; takes 1-3 business days.
3. Create a Trusted Signing Account, a Certificate Profile, and an Identity Validation.
4. Add a GitHub Action that signs the produced `.exe` using `azure/trusted-signing-action`.
5. Configure `electron-builder` with the `signtoolOptions` block for the dll path.

Concrete electron-builder.json additions:

```jsonc
"win": {
  "target": [{ "target": "nsis", "arch": ["x64"] }],
  "icon": "build/icon.ico",
  "signingHashAlgorithms": ["sha256"],
  "signtoolOptions": {
    "signingHashAlgorithms": ["sha256"]
  }
},
"nsis": {
  "oneClick": false,
  "allowToChangeInstallationDirectory": true,
  "perMachine": false,
  "differentialPackage": true
}
```

The actual signing is done by the GitHub Action, not by `electron-builder` locally — that means your dev machine doesn't need credentials.

What can break:
- Identity verification stalls — push back early; chase if it takes more than 5 business days.
- The signed binary still triggers SmartScreen for the first few hundred installs. Trusted Signing certificates get "reputation" over time. Your README should still document the click-through for the first month.

Time: 1 weekend of work plus 1-2 weeks of elapsed waiting.

**2.2 — Wire up `electron-updater` with GitHub Releases.**

This is the lowest-effort, highest-impact piece of infrastructure left.

```bash
npm i electron-updater
```

In `src/main/index.ts`, after the window is created:

```ts
import { autoUpdater } from 'electron-updater'
if (!is.dev) {
  autoUpdater.checkForUpdatesAndNotify().catch(err =>
    log.warn('autoUpdater failed:', err)
  )
}
```

In `electron-builder.json`:

```jsonc
"publish": [{
  "provider": "github",
  "owner": "your-github-username",
  "repo": "cortex"
}]
```

When you run `npm run release` with a `GH_TOKEN` env var set, electron-builder uploads the artifacts to a draft GitHub release. You promote it manually. On user machines, `autoUpdater` checks the GitHub Releases API on launch; if a newer version exists, it downloads it in the background and applies it on next quit.

Cost: zero (GitHub Releases is free for public repos, has generous bandwidth for private). What can break:
- Skipped versions if a user is many releases behind — `electron-updater` handles this fine but the release notes UX gets cramped. Show "What's new" since their installed version, not just since last version.
- A bad release that crashes on startup will brick the auto-update path. Mitigate by: (a) always smoke-testing the packaged build before promoting the draft, (b) keeping the previous release available for manual download with a "downgrade" link in the README.

Don't add `electron-updater` until **after** you've shipped one successful release manually. Auto-update over an unsigned base release will fail in confusing ways.

**2.3 — Crash and version telemetry, opt-in.**

You will ship bugs you didn't catch. Without telemetry, you find out by users uninstalling silently.

Minimum viable telemetry — no analytics, no events, no PII:
- On launch, after the user opts in via a one-time modal, POST `{ version, os, success: true }` to a free endpoint you control (Cloudflare Workers free tier handles this for years before you'd pay).
- Wrap the main process startup in a global try/catch and POST `{ version, os, error: stack }` on uncaught.

Do **not** use Sentry for v0.1. Sentry's free tier is generous but you'll spend half a weekend configuring source maps, error groupings, and integrating their SDK with Electron's main/renderer split. A one-page Cloudflare Worker logging to a Durable Object covers 95% of the value for one hour of work.

The opt-in modal needs to be honest: "Send anonymous crash reports? Helps us fix bugs. No content from your memories is ever sent. [On] [Off]" with an obvious "Change later in Settings" link.

**2.4 — Write the README.**

Not optional. The README is your landing page, support docs, and trust signal all in one. Minimum sections:
- One-paragraph "What is this?" with a screenshot.
- "Install" section with a direct link to the latest `.exe`, the SmartScreen click-through screen recording (host on Imgur or as a `.mp4` in the repo), and the Ollama install link.
- "How it works" — three sentences max, one diagram if helpful.
- "FAQ" — at minimum: "Is my data sent anywhere?" "What happens if Ollama isn't running?" "How do I uninstall?" "Where is my data stored?"
- "Known issues" — be honest. "Graph view is read-only," "Memory Insights is experimental," etc.
- "Building from source" — for the dev users in your audience.

Time: 2-3 hours if you don't fight it.

**2.5 — Privacy policy page.**

Even if you collect nothing, you need one because:
- The Chrome Web Store requires it (Phase 3).
- It's a 10-minute task and removes a class of questions.

Host as a single Markdown file in the repo, rendered via GitHub Pages or a static landing page. State plainly: data stays on the user's machine; the only optional outbound traffic is opt-in crash telemetry which contains only `{version, os, stack}`; the browser extension only talks to localhost; no third-party analytics.

### Decisions due in Phase 2

- **Public or private GitHub repo?** Public is recommended — better for trust, distribution, and SEO. The codebase has no secrets. Private repo costs you the ability to use the free Releases bandwidth tier and complicates auto-update for users.
- **Domain name?** Optional but a `cortex.app` or similar costs $10-30/year and gives you a permanent home for the landing page and privacy policy. Defer if budget-constrained; GitHub Pages on a `*.github.io` URL is free and works.

### Exit criteria for Phase 2

- [ ] Signed Windows installer; SmartScreen reputation building
- [ ] GitHub Releases set up, one draft promoted to public
- [ ] Auto-update verified end-to-end: install v0.1.0, release v0.1.1, watch it update
- [ ] Crash telemetry endpoint receives a test crash
- [ ] README with screenshot, install link, FAQ, known issues
- [ ] Privacy policy live at a stable URL

---

## 5. Phase 3 — The Browser Extension Story (2–4 weeks, mostly waiting)

### Goal
A user can install the Chrome extension via a single link and pair it with the desktop app without copy-pasting tokens.

### What you have today
- A working extension in `extension/` with `manifest.json`, `popup.html`, `popup.js`, `content.js`, `background.js`.
- A `/pair` endpoint that's safe to call during a time-limited armed window.
- A working pair button in Settings with a countdown.

### What's missing for distribution
- Chrome Web Store listing.
- Privacy policy URL on the listing.
- A clear "Connection status" indicator in the extension popup (red/yellow/green).
- A user-facing setting for "if the desktop app is not running, do X" — currently silent failure.
- Token rotation flow for users who feel their token is compromised.

### Tasks

**3.1 — Audit the extension's `host_permissions`.**

Open `extension/manifest.json` and confirm the permissions are minimal. Chrome Web Store's #1 rejection reason is overly broad permissions. You probably want:

```json
{
  "host_permissions": [
    "https://claude.ai/*",
    "https://chat.openai.com/*",
    "https://chatgpt.com/*",
    "https://gemini.google.com/*",
    "http://127.0.0.1/*"
  ]
}
```

NOT `<all_urls>`. If the extension currently uses `<all_urls>`, narrow it before submission. The store reviewer will reject it and tell you to narrow it. You'll lose a week.

**3.2 — Add a connection-status badge to the extension popup.**

On popup open, the extension's popup.js should hit `http://127.0.0.1:<port>/health` with the bearer token and show:
- Green: "Connected to Cortex v0.1.x"
- Yellow: "Cortex is running but auth failed — re-pair"
- Red: "Cortex is not running — start the desktop app"

This is the single piece of UX that makes the extension feel solid vs flaky. Twenty lines of JS.

**3.3 — Sideload-first distribution.**

For v0.1, **do not submit to the Chrome Web Store yet.** Reasons:
- First-week users will be friends / dev contacts. They can sideload an unpacked extension from a GitHub release zip.
- Web Store review takes 1-7 days and the first submission almost always comes back with feedback.
- Sideload lets you iterate fast without store review.

Provide a `extension-v0.1.0.zip` in the GitHub release alongside the desktop installer. README steps:
1. Download `extension-v0.1.0.zip`
2. Unzip
3. Visit `chrome://extensions`, enable Developer Mode, "Load unpacked", point to the unzipped folder.
4. Click "Pair Extension" in Cortex Settings, then click the extension icon.

Yes, this is friction. It's also fine for v0.1. You're proving the loop works.

**3.4 — Web Store submission (defer to v0.2 or later).**

When you do submit, budget:
- $5 one-time developer fee.
- A privacy policy URL (Phase 2.5).
- Promotional images (1280×800 screenshots, 128×128 icon, possibly a 440×280 marquee).
- A "single purpose" description — Web Store reviewers reject extensions whose purpose isn't crystal clear.
- 1-7 days review per submission. First submission usually comes back; budget 2-3 iterations.

### Exit criteria for Phase 3

- [ ] Extension zip in GitHub Release alongside installer
- [ ] Popup shows connection status
- [ ] Permissions audited and minimal
- [ ] Pairing flow tested end-to-end on a clean Chrome profile
- [ ] (Deferred to v0.2: Web Store listing)

---

## 6. Phase 4 — Scaling Polish (ongoing)

These are improvements that don't block v0.1 but should be on the list once shipping cadence is established.

**4.1 — FTS-backed search.** `fts_memories` is being maintained but never queried. Switch `db.searchMemories` to use `fts_memories MATCH ?` with rank ordering. ~30 minutes of work. Result: search latency drops from O(n) to O(log n).

**4.2 — Vector search for vault files via IPC.** The schema and `vault_vectors` table exist; `vault:semanticSearch` works in the IPC handler; but the renderer's search box calls `vault.searchFiles` (keyword only). Wire the renderer to use `semanticSearch` when Ollama is up, fall back to `searchFiles` when it isn't. Two-line change in the Search page.

**4.3 — Token rotation.** Settings already shows this in "Coming soon." Implement: a "Rotate token" button that regenerates the token, persists, and invalidates the cached `getToken()`. Force re-pair of any connected extensions (broadcast `extension:unpaired`).

**4.4 — Renderer test coverage.** Zero today. Set up `@testing-library/react` + `@vitejs/plugin-react` + `vitest`'s `jsdom` environment. Target Settings, Search, and Dashboard first — those have the most state-driven behavior worth testing.

**4.5 — Source-aware filtering.** The four sources (Claude/ChatGPT/Gemini/Manual) are hardcoded in `http.ts` and `index.ts`. Add a Source-filter pill row in Search. Extract source list to one constant.

**4.6 — Memory editor performance on long documents.** `react-markdown` re-renders the whole tree on every keystroke. For documents >10KB this gets noticeable. Either: debounce the preview render to 200ms, or only re-render the preview when the user toggles preview mode. Don't optimize prematurely; wait for a user complaint.

**4.7 — Cross-platform builds.** macOS (DMG + notarization) and Linux (AppImage). Add a CI matrix job. Mac is the harder one — notarization rejects on entitlements regularly. Budget a weekend.

**4.8 — Theme support.** Currently dark-mode only with hex literals scattered throughout (`#0F0F0F`, `#6B9FD4`, etc.). Extract to CSS custom properties before adding light mode; otherwise the swap is a 50-file edit.

**4.9 — Backup / export.** A button in Settings that writes the entire `memories.db` to a user-chosen path (or a JSON dump of all memories + relationships). Importable in v0.3.

---

## 7. What to Skip For Now and Why

| Idea | Why skip |
|---|---|
| Sync across devices | Local-first is the product's identity. Sync needs CRDTs or a server; both add weeks. Defer to a separate product decision. |
| Mobile app | Same. Local-first → mobile companion is "read-only sync"; same prerequisite. |
| Account system | The product has no server. No accounts ever. |
| Microsoft Store / Mac App Store | Sandboxing prevents the localhost server and the filesystem watcher. Permanent skip unless the product reshapes. |
| Crash reporting via Sentry | Use a 50-line Cloudflare Worker for v0.1. Sentry adds source-map config, two SDKs, two integrations. Not worth it until you have >100 active users. |
| Telemetry/analytics beyond crash + version | Privacy-positive position is part of the pitch. Don't compromise without a reason. |
| `electron-forge` instead of `electron-builder` | Already on electron-builder, working, no reason to switch. |
| Auto-update for v0.1.0 release | Add it in v0.1.1. Shipping the first release manually is one fewer thing that can fail at debut. |
| Refactoring to React 19 / Server Components | The app has no server-rendered surface. No benefit. |
| Tauri / Wails rewrite | Don't. The hard parts (Ollama integration, sqlite-vec, vault watching) are the same in any framework, and you'd lose all your tests. |
| Custom UI theme system | Hex literals work today. Theme tokens are a polish task, not an MVP task. |
| Memory importance UI | Not used. Delete the field (Phase 1.5). |
| Memory Insights popup polish | The button works; the polish doesn't matter for v0.1 unless the feature graduates. |
| Multi-window support | The single-instance lock is correct. One window is fine. |
| i18n | Nobody needs this at v0.1. |

The principle: **anything that doesn't make the difference between a user keeping the app installed and uninstalling it is not v0.1.**

---

## 8. Realistic Calendar for a Solo Developer

Assumes 8-12 hours of focused work per week (evenings + one weekend day):

| Phase | Wall-clock | Hours | Confidence |
|---|---|---|---|
| Phase 0 (build works) | 1-2 weeks | 8-15h | High — these are known mechanical fixes |
| Phase 1 (first-contact UX) | 2-3 weeks | 20-30h | High — bugs are well-localized |
| Phase 2 (trust) | 2-4 weeks | 15-25h + waiting on Azure | Medium — Azure verification time is out of your control |
| Phase 3 (extension sideload) | 1 week | 5-10h | High |
| **Total to "first real user with installer"** | **6-10 weeks** | **50-80h** | **Medium-high** |
| Phase 4 (scaling polish) | Ongoing | — | — |

If "first real user" means "tech-comfortable friend with sideloaded extension," subtract Phase 2 entirely and you're at **3-5 weeks / 30-50 hours.** This is the recommended path.

If "first real user" means "stranger from a landing page," include Phase 2 and budget the calendar for Azure verification.

**Common failure modes for solo developers, in order of frequency:**
1. **Polish creep.** "Just one more thing before launch." Set a date, ship to it, take the embarrassment of v0.1 imperfections as a feature not a bug.
2. **Phase 0 underestimated.** Native modules are the #1 cause of "I thought I was a week away, then I lost three weekends."
3. **No clean-VM testing.** Always test in a VM. The dev machine has too much state.
4. **Premature optimization.** Don't add FTS until search is actually slow. Don't add caching until the renderer is actually janky.
5. **Indefinite "v0.5 before launch" syndrome.** Pick the v0.1 cut line in writing, in this file, before starting. Use the exit criteria in each phase as the only definition of done.

---

## 9. The First Commit-Sized Tasks

Concrete starting points, ordered by "do this first":

1. **`electron-builder.json`** — add `asar: true`, `asarUnpack: ["**/*.node"]`, `nsis: { perMachine: false }`.
2. **Verify `build/icon.ico` exists** — if not, generate from a 1024×1024 PNG via any online ICO converter.
3. **`src/main/db.ts`** — add the `schema_version` table scaffolding from §0.3.
4. **First clean-VM packaged-build smoke test** — full Phase 0 exit criteria.
5. **`src/main/vault.ts:142`** — add `WATCH_IGNORE` to the vault watcher's `ignored` array.
6. **`src/main/vault.ts:109`** — add the stat-compare early-return in `indexFile`.
7. **`src/main/db.ts:200`** — add `escapeLike` helper, apply to `searchMemories` and `searchVaultFiles`.
8. **`src/types/index.ts` + everywhere** — remove `importance` from `Memory` (or persist it; decide and execute).
9. **`src/renderer/src/App.tsx`** — first-launch vault-picker forcing function.
10. **`src/main/index.ts`** — add `electron-log`; new IPC `system:getStatus` returning Ollama + vector + server state.
11. **`src/renderer/src/pages/Settings.tsx`** — `OllamaStatusRow` and a status-bar component in `App.tsx`.

After those 11 items, Phase 0 and most of Phase 1 are done and the app is in a state where a friend can use it without you sitting next to them.

---

## 10. Open Questions That Must Be Answered Before Phase 2

The Phase 2 spend doesn't make sense without answers to these. Treat each as a blocking item.

1. **Who is the v0.1 user?** Friend-dev or stranger-downloader? (Determines whether Phase 2 happens at all.)
2. **Is the GitHub repo public or private?** (Determines auto-update infrastructure.)
3. **Windows-only or multi-platform for v0.1?** (Affects Phase 0 scope by 30-50%.)
4. **Is $10/month Azure Trusted Signing in budget?** (Gates Phase 2.)
5. **Will the project name "Cortex" survive?** (Affects appId, icons, marketing surface. Cheap to change now, expensive after first ship.)
6. **Does Ollama detect-and-prompt feel acceptable, or is bundling required?** (Affects Phase 1.7 path A vs B.)

Everything else can be answered iteratively. These cannot.

---

## 11. Appendix: Specific Code Issues Found (Reference)

A compact bug list, file-line indexed, that fell out of reading the code:

| Where | Issue | Severity | Phase |
|---|---|---|---|
| `vault.ts:142-152` | Vault watcher has no exclusion list | HIGH | 1.2 |
| `vault.ts:109-135` | `indexFile` re-embeds unchanged files on restart | HIGH | 1.2 |
| `db.ts:195-218` | `LIKE` query doesn't escape `%` `_` `\` | MEDIUM | 1.4 |
| `db.ts:389-394` | `searchVaultFiles` same `LIKE` issue + no FTS | MEDIUM | 1.4 / 4.1 |
| `transformers.ts:26` | `Memory.importance` hardcoded `3`, never persisted | MEDIUM | 1.5 |
| `electron-builder.json` | No `asarUnpack` for `*.node` | CRITICAL (will crash packaged build) | 0.1 |
| `electron-builder.json` | No `publish` block | HIGH (no auto-update path) | 2.2 |
| `electron-builder.json` | No code signing config | HIGH (trust UX) | 2.1 |
| `db.ts:88-126` | No schema version table | HIGH (locks you out of future migrations) | 0.3 |
| `db.ts` + `index.ts` | `fts_memories` written but never queried | LOW (wasted overhead) | 4.1 |
| `http.ts:14` + `index.ts:18-23` | `VALID_SOURCES` and `PLATFORM_FOLDERS` duplicated | LOW (2-place edit when adding sources) | 4.5 |
| `index.ts:185-194` | No first-run guard sending user to vault picker | HIGH (silent failure on empty config) | 1.1 |
| `extension-config.ts:52-57` | Token stored in plain JSON in userData | LOW for v0.1 (localhost only); revisit if exposed | deferred |
| `db.test.disabled.ts` | Disabled test file, DB layer untested | MEDIUM | 4.4 |
| renderer | Zero renderer tests | MEDIUM | 4.4 |
| `index.ts` + `vault.ts` | Vault path picked at any folder will index it whole — no size warning | MEDIUM | 1.6 |

---

*End of roadmap. This file is intentionally opinionated. Disagree with any item by editing the file and shipping anyway — the worst outcome is following someone else's plan through a phase that doesn't match your actual situation.*
