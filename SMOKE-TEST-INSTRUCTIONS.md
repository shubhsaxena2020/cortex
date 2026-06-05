# v0.2.0 Smoke Test Instructions

**Target Machine:** Windows 11 (clean, or a secondary machine)
**Artifact:** Cortex-0.2.0-win-x64-portable.zip (from the GitHub release)
**Release:** https://github.com/shubhsaxena2020/cortex/releases/tag/v0.2.0
**Time:** ~30 min

## Before You Start

**If you get "Windows protected your PC", "Smart App Control blocked this", or "An Application Control policy has blocked this file":**
1. Right-click the .zip (before extracting) or the extracted Cortex.exe
2. Select "Properties"
3. Check "Unblock" at the bottom
4. Click "Apply" -> "OK"
5. Try again

This is expected for unsigned builds. On a machine with **Smart App Control in Enforce mode**, Unblock may not be enough and the app may stay blocked until the build is code-signed (a v0.4 item). If so, test on a machine where Smart App Control is Off, or wait for a signed build.

## Setup

1. Extract `Cortex-0.2.0-win-x64-portable.zip` to a clean folder (e.g., `C:\cortex-test\`)
2. Run `Cortex.exe` directly (no installer needed)
3. The app should launch and show the main window

## Test Checklist

See `docs/SMOKE-TEST-CHECKLIST.md` in the repo for the full checklist. Quick summary:

- [ ] App launches without crashes
- [ ] Database initializes (check `%APPDATA%\Cortex\memories.db` exists)
- [ ] Chrome extension pairs successfully (pairing key displayed)
- [ ] Capture a test conversation from ChatGPT (dedup should work on a second capture)
- [ ] Search finds the captured memory (should feel fast, p95 target <200ms)
- [ ] Graph renders with 10+ nodes (visible nodes + edges, NOT a black canvas)
- [ ] Feedback form saves (Settings -> Feedback, submit, check `%APPDATA%\Cortex\feedback\`)
- [ ] Telemetry toggle works (Settings -> toggle on/off, verify it persists on restart)
- [ ] Uninstall: just delete the folder (portable, no registry, no installer)

## Report Back

- PASS / FAIL for each checklist item
- Any error messages or unexpected behavior (check `%APPDATA%\Cortex\logs\main.log`)
- Performance observations (search speed, graph responsiveness, no UI freeze on the graph)
- Screenshot of the graph (if possible)

---

**Known Issues:**
- Smart App Control may block the unsigned app; see "Before You Start" above.
- Node zoom-scale deferred (nodes do not grow when you zoom out, but the larger 8-30px radii keep them visible at all zoom levels).
- NSIS installer is not in this release (blocked by Smart App Control during build; fixed by code-signing in v0.4).

Good luck!
