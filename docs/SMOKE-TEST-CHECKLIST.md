# Cortex v0.2.0 — Windows 11 Installer Smoke Test

> The last open gate for v0.2.0. Everything else (245 tests, build, Settings UI,
> graph render) is verified on the dev machine. This checklist is for a **clean
> Windows 11 machine that has never run Cortex** — ideally someone else's. The
> goal is to catch packaging/first-run failures that don't show up in `npm run dev`.
>
> Record PASS/FAIL + a note per line. A single CRITICAL failure blocks the release.

## How to use

- Run top to bottom on a clean Win11 box (no prior Cortex install, no leftover
  `%APPDATA%\Cortex`).
- For each item: mark `[x]` pass, `[!]` fail, `[~]` partial; add a one-line note.
- "Expected" is the success criterion. "If it fails" is the likely cause to report.

---

## 0. Pre-test environment

- [ ] **Clean machine** — no `%APPDATA%\Cortex` folder exists. _Expected: absent. If present, delete it for a true first-run test._
- [ ] **OS** — Windows 11 x64, note the build number.
- [ ] **Network** — online for the optional Ollama download; the app itself must work fully offline.
- [ ] **No dev toolchain assumed** — tester does NOT have Node/npm. The installer must be self-contained.
- [ ] **(Optional) Ollama** — note whether installed. Semantic search needs it; keyword search must work without it.

## 1. Installer integrity + run

- [ ] **File present** — `Cortex Setup 0.2.0.exe` exists, ~80–90 MB. _Note actual size._
- [ ] **SmartScreen** — Windows warns "unrecognized app" (installer is unsigned — **expected for v0.2.0**). Tester clicks **More info → Run anyway**. _If no warning at all, note it (unusual)._
- [ ] **Install completes** — NSIS wizard finishes without error. _If it fails: check the asarUnpack of native modules (better-sqlite3, sqlite-vec)._
- [ ] **Install location** — app installed to `%LOCALAPPDATA%\Programs\Cortex` (per-user NSIS default). Start-menu shortcut created.
- [ ] **Launches from shortcut** — double-click opens the window. _If it crashes instantly: almost always a native-module load failure (better_sqlite3.node / sqlite-vec ABI). Check `%APPDATA%\Cortex\logs\main.log`._

## 2. First launch

- [ ] **Window renders** — Cortex opens to the editor/notes view, dark theme, sidebar visible. _Expected: no white screen, no devtools error overlay._
- [ ] **DB initialises** — `%APPDATA%\Cortex\memories.db` is created. _If absent: DB init failed; check main.log for the sqlite-vec load line._
- [ ] **sqlite-vec status** — Settings → AI Features shows "Vector search: Enabled" OR a graceful "Disabled — keyword fallback" (both acceptable; a crash is not).
- [ ] **Extension config written** — `%APPDATA%\Cortex\extension-config.json` exists with a token + port.
- [ ] **HTTP server up** — main.log shows `extension API on http://127.0.0.1:<port>` (port in 48729–48738 or an ephemeral fallback).
- [ ] **No first-run crash** — leave it open 60s; window stays responsive.

## 3. Vault + indexing

- [ ] **Pick a vault** — Settings → Vault Folder → choose an empty folder. _Expected: accepted, path shown, no error._
- [ ] **Watch folder (optional)** — point at a small folder with a few `.md`/`.txt` files. _Expected: files index, count shown, no freeze._

## 4. Extension pairing (if testing capture)

- [ ] **Load extension** — load-unpacked per `EXTENSION_SETUP.md`. _v0.2.0 is unpacked-only._
- [ ] **Pair** — Settings → "Pair Extension" (60s window) → open extension popup → authorize. _Expected: "Extension paired ✓"; token lands in the extension._
- [ ] **Capture a real chat** — open a short conversation on claude.ai (or chatgpt.com / gemini.google.com). _Expected: auto-saves; appears in the app without a manual refresh (memories:changed push)._
- [ ] **Dedup (P0 #1)** — capture the SAME conversation again. _Expected: it updates the existing memory, does NOT create a second node._
- [ ] **Filtering (P0 #2)** — open a brand-new empty chat (no messages) and confirm it is NOT captured.

## 5. Core flows

- [ ] **Search (P0 #4)** — type a query in Search. _Expected: results return effectively instantly (<200 ms) even with a populated vault; highlights show._
- [ ] **Graph (P0 #3)** — open the Graph tab. _Expected: nodes + edges render (NOT a black canvas); pan/zoom is smooth; hovering a node highlights it + neighbours; labels fade in as you zoom in. With a large vault, the window must NOT freeze while the layout settles (physics runs in a Web Worker)._
- [ ] **Graph at scale (if seeded large)** — confirm no black screen, no multi-second UI freeze on open.

## 6. Settings — telemetry + feedback (P0 #5)

- [ ] **Telemetry default OFF** — "Anonymous Usage Data" toggle starts unchecked. _Privacy default._
- [ ] **Toggle ON persists** — enable it, close & reopen Settings (or restart the app) — still ON. `%APPDATA%\Cortex\telemetry-config.json` shows `{"enabled":true}`.
- [ ] **Events captured** — with telemetry ON, run a search / open the graph, then Settings → "View All Events" shows events. Confirm **no raw query text, no file paths** (length/counts/hashes only).
- [ ] **Export** — "Export as JSON" downloads a file with metadata + events.
- [ ] **Clear** — "Clear All" empties the event list and the `telemetry/` JSONL files.
- [ ] **Toggle OFF stops capture** — disable, do actions, confirm no new events.
- [ ] **Feedback** — "Send Feedback" → fill Type/Title/Description → submit. _Expected: success toast; a JSON file appears in `%APPDATA%\Cortex\feedback\`._ "View Feedback" lists it.

## 7. Edge cases

- [ ] **Restart persistence** — close and reopen the app. Memories, vault path, and telemetry toggle all survive.
- [ ] **Offline** — disable network; app still launches, search (keyword) and graph still work. _Only semantic search / Ollama features degrade, silently._
- [ ] **Vault folder moved/deleted** — remove the chosen vault folder while the app is closed, relaunch. _Expected: graceful handling (prompt to re-pick), not a crash._
- [ ] **Second instance** — launch the app again while it's running. _Expected: single-instance lock — the second launch focuses the first, does not start a rival server._
- [ ] **Uninstall** — run the uninstaller. _Expected: removes the program; note whether `%APPDATA%\Cortex` user data is left behind (it should be, by NSIS default)._

## Success criteria

- **Release-blocking (CRITICAL):** installer runs, app launches without crash, DB initialises, graph renders (not black), search works, no data loss on restart.
- **Should-fix (HIGH):** pairing + capture + dedup work; telemetry/feedback persist correctly.
- **Acceptable known gaps (v0.2.0):** SmartScreen warning (unsigned), unpacked extension only, Windows-only, ~5 min embed backfill.

## Where to look when something breaks

- **Main process / startup / DB / native modules:** `%APPDATA%\Cortex\logs\main.log`
- **Renderer / graph / UI errors:** the in-app DevTools console (the dev build also exposes CDP on `127.0.0.1:9333`).
- **Extension API:** main.log request lines (`incoming request` / `request completed`).
- **Config state:** `%APPDATA%\Cortex\{extension-config,vault-config,telemetry-config}.json`.

---

_Report results back as a filled copy of this checklist. One CRITICAL failure = do not publish the GitHub release; file an issue with the relevant log excerpt._
