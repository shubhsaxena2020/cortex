# Cortex — Session Notes

Snapshot for resuming work. Cortex is a privacy-first local AI memory layer: an Electron desktop app + Chrome extension that captures, indexes, and semantically searches notes, files, and AI chats (Claude, ChatGPT, Gemini).

## Project status

- **Phase 2: complete.** Vault watcher, file ingestion, embeddings, graph, search, and Chrome extension pairing all working.
- **Phase 3: ready to start.** Repo was renamed from Local Jenova → Cortex and moved to `C:\Users\shubh\cortex`. Vault folder renamed `JenovaBrain → cortex_brain` at `C:\Users\shubh\cortex_brain` (vault-config.json updated in `%APPDATA%\cortex`).
- **Tests:** `npm test` → **128/128 passing** across 6 test files (~5s).
- **Build:** all three Electron bundles (main / preload / renderer) compile green via `electron-vite`.
- **Next milestone:** first GitHub release.

## Stack

| Layer | Tech |
|---|---|
| Shell | Electron 31 |
| Bundler | electron-vite 2 (Vite 5) |
| UI | React 18 + Zustand 4 + Tailwind 3 + lucide-react |
| Graph | D3 7 (`GraphCanvas.tsx`) |
| Markdown | react-markdown + highlight.js |
| Backend (in main) | Fastify 5 on `127.0.0.1` |
| Storage | better-sqlite3 12 + `sqlite-vec` 0.1 (optional) |
| File watching | chokidar 3 |
| DOCX import | mammoth |
| AI | Ollama (local) — `all-minilm` 384-dim embeddings |
| Tests | Vitest 4 (node env) |
| Logging | electron-log |
| Packager | electron-builder 24 |

## Folder structure

```
cortex/
├── src/
│   ├── main/                # Node — DB, IPC, Fastify, embeddings, vault watcher
│   │   ├── index.ts         # App entry, IPC handlers, window lifecycle
│   │   ├── db.ts            # SQLite schema + queries (memories, relationships, FTS, vec)
│   │   ├── transformers.ts  # Row → Memory/Relationship mappers (pure, fully tested)
│   │   ├── http.ts          # Fastify server (extension API), pairing, bearer auth
│   │   ├── extension-config.ts # Token + port persistence (userData/extension-config.json)
│   │   ├── embeddings.ts    # Ollama client (returns null if unreachable)
│   │   ├── seed-embeddings.ts # Backfills embeddings on startup
│   │   └── vault.ts         # Vault config, chokidar watcher, file ingestion
│   ├── preload/index.ts     # contextBridge — only file that touches both worlds
│   ├── renderer/
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx, App.tsx, store.ts (Zustand)
│   │       ├── pages/       # Dashboard, GraphView, Search, Settings
│   │       ├── components/  # MemoryEditor, GraphCanvas, FileTree, FileViewer, Sidebar, InsightPopup
│   │       ├── utils/       # graph-builder, chat-formatter
│   │       └── styles/
│   └── types/index.ts       # Shared types (Memory, Relationship, VaultFile, ElectronAPI)
├── extension/               # Chrome MV3 extension (background, content, popup)
├── scripts/                 # api-smoke-tests, integration-tests, test-embeddings
├── database/                # local dev SQLite
├── build/                   # icons / installer resources
├── release/                 # electron-builder output
├── dist/                    # electron-vite output
├── electron.vite.config.ts
├── electron-builder.json
├── vitest.config.ts
├── tsconfig{,.node,.web}.json
├── package.json
└── CLAUDE.md / README.md / CORTEX-{REPORT,ROADMAP}.md / FINAL_PHASE3_REPORT.md / PHASE3_MANUAL_TESTS.md
```

## Process boundaries

```
Renderer (window.electron.*) → IPC → main/index.ts → db.ts → SQLite
Chrome extension → HTTPS-style fetch → Fastify (http.ts) → db.ts → SQLite
```

Renderer never touches Node or SQLite directly. `window.electron` is typed as `ElectronAPI` in `src/types/index.ts`; the preload script is the only place that wires `ipcRenderer.invoke` to it via `contextBridge`.

The store subscribes to `memories:changed` events pushed from main so memories created by the extension or vault watcher appear live without polling.

## Key modules

- **`db.ts`** — `memories`, `memory_relationships`, `fts_memories`, optional `memory_vectors` vec table. `initDb()` is idempotent. sqlite-vec loads best-effort; `hasVectorSearch()` gates vector paths.
- **`vault.ts`** — `loadVaultConfig` / `saveVaultConfig` / `initVault` plus chokidar `startVaultWatcher` and `startWatchFolderWatcher`. Ignores `node_modules`, build outputs, OS junk, binaries. Only ingests known text extensions (≤10 MB).
- **`embeddings.ts`** — Ollama `all-minilm` (dim 384). Every call returns `null` silently if Ollama is down; callers fall back to keyword search.
- **`seed-embeddings.ts`** — fire-and-forget startup backfill for any memory missing a vector.
- **`http.ts`** — Fastify on `127.0.0.1`, port range 48729–48738 → ephemeral fallback. Bearer auth on every route except `/health` and `/pair`. `/health` returns `{ app: 'cortex', ... }` — the extension handshake checks `body.app === 'cortex'`.
- **`extension-config.ts`** — token + port in `userData/extension-config.json`.
- **`graph-builder.ts`** — pure transform from memories + relationships + vault files → D3 nodes/links with source colors.
- **`chat-formatter.ts`** — formats captured AI conversations for display.
- **`transformers.ts`** — row → Memory/Relationship; parses JSON-string tags. The most heavily covered module.

## Optional / degradable paths

- **sqlite-vec missing** → `/api/related` uses keyword frequency ranking.
- **Ollama down** → embeddings disabled, semantic search falls back to FTS keyword.

Both degrade silently; no user-facing error.

## Extension pairing

`/pair` is public but only live during a short window opened by Settings → "Pair Extension" (`armPairing()`), closed on first successful pair. The token returned is written into the extension's storage. Extension manifest at `extension/manifest.json` (MV3, host permissions for `127.0.0.1:*` + claude.ai / chatgpt.com / chat.openai.com / gemini.google.com).

Handshake contract: extension calls `GET /health` and only proceeds if `body.app === 'cortex'`.

## Tests (128 passing)

| File | Covers |
|---|---|
| `src/main/transformers.test.ts` | row → domain mappers, tag parsing, highlight builder |
| `src/main/embeddings.test.ts` | Ollama availability + embed paths |
| `src/main/http.test.ts` | Fastify routes via `app.inject` — auth, search, capture, pair |
| `src/main/vault.test.ts` | config, ignore rules, file ingestion |
| `src/renderer/src/utils/graph-builder.test.ts` | node/link construction, filter modes |
| `src/renderer/src/utils/chat-formatter.test.ts` | conversation formatting |

`db.test.disabled.ts` is currently parked. PostToolUse hook in `.claude/settings.local.json` runs `npm test` after every edit.

## Commands

```bash
npm run dev          # electron-vite dev with hot reload
npm run build        # build all three bundles
npm run release      # build + electron-builder → release/
npm test             # vitest run
npm run test:watch
npx vitest run src/main/transformers.test.ts   # single file
```

## Next steps — GitHub Release

1. `git init && git add -A && git commit -m "chore: initial Cortex commit"`
2. `gh repo create cortex --public --source=. --remote=origin --push`
3. `npm run release` → produces installer in `release/`
4. `gh release create v0.1.0 release/*.exe -t "Cortex v0.1.0" -F CORTEX-REPORT.md`
5. Smoke-test the produced installer on a clean Windows session.
6. Update `extension/manifest.json` host_permissions / extension store listing if publishing publicly.

## Ollama integration notes

- Embedding model: `all-minilm` (dim 384). Pull via `ollama pull all-minilm` before first run.
- `isOllamaAvailable()` / `isEmbedModelAvailable()` gate every embedding call.
- All embedding code returns `null` on failure — never throws to the renderer.
- Settings page surfaces Ollama status; missing Ollama is a soft warning, not a blocker.

## Resolved cleanup (Phase 2 → Phase 3 handoff)

- **Vault rename:** `C:\Users\shubh\JenovaBrain` → `C:\Users\shubh\cortex_brain`. `%APPDATA%\cortex\vault-config.json` rewritten to the new path. No source code had a hardcoded vault path (vault is user-configured at runtime), so no `src/` changes were needed.
- **`db.test.disabled.ts`:** kept parked. The file header explains why — `better-sqlite3` is compiled against Electron's Node ABI (125) and vitest runs on plain Node (ABI 127), so the .node binary refuses to load. Fixing this is a `vitest-electron` infra decision flagged for Phase 4+. The same DB code is fully exercised by `scripts/integration-tests.mjs` against the live Electron process. **Not deleted** — it's a complete spec ready to run once the runner is swapped.
- **`electron-builder.json` appId:** already `com.cortex.app`, productName `Cortex`. No change needed. Verified via `npm run build` → all 3 bundles green.
- **"Local Jenova" / `local-jenova` / `JENOVA_*` scrub:** 4 source files updated (all in `scripts/`):
  - `scripts/api-smoke-tests.mjs` — header comment, `%APPDATA%\Cortex` path, `/health` check now expects `app === 'cortex'`.
  - `scripts/integration-tests.mjs` — `%APPDATA%\Cortex` path.
  - `scripts/test-embeddings.mjs` — `CORTEX_EMBED_MODEL` env var, `cortex-test-` temp prefix, `%APPDATA%\Cortex` path.
  - `scripts/final-phase3-report.mjs` — `CORTEX_EMBED_MODEL` reference.
  Remaining matches are intentional history: `.cortex-shots/*.snap.txt` (frozen Phase-2 UI snapshots) and `release/builder-debug.yml` (one-shot electron-builder debug log). Both are build artifacts, not code.
- **Tests:** `npm test` → **128/128 passing** post-cleanup.
- **Build:** `npm run build` → main (118.74 kB) + preload (3.81 kB) + renderer (913.27 kB) all green.

## Tooling

- **Claude Council skill** installed at `~/.claude/skills/council-review/SKILL.md` (cloned from `ngmeyer/council-review`). Run `/council-review "<question>"` (or `--quick` for 3-advisor mode) to bounce Phase-3 decisions / docs off the 5-advisor LLM panel before committing.

## Phase 3 — Release prep (in progress)

### What's done locally
- Settings page scroll bug fixed (`<main>` now `flex flex-col`; child views with `flex-1 overflow-y-auto` get bounded height).
- `.gitignore` written; `git init -b main`; identity set to `shubh.saxena2020@gmail.com`; **single initial commit** `1b46ec7 chore: initial Cortex commit`.
- `RELEASE_NOTES.md`, `ROADMAP.md`, `EXTENSION_SETUP.md` written.
- Build + tests still green post-Settings-fix: **128/128 passing**, 3 bundles compile.
- Vault path UI is dynamic — already reflects `cortex_brain` from `%APPDATA%\cortex\vault-config.json`; no UI code change needed.

### Council #1 verdict — release strategy
**Ship as GitHub Pre-Release (`v0.1.0-beta`), not as standard `v0.1.0`.** Devil's Advocate's "shipping creates the forcing function" rebuttal won — but the framing of `v0.1.0` as a normal release lost on first-impression grounds. Pre-Release gives momentum without the half-baked-product risk.

Required before publishing:
- **Clean-Windows-VM installer smoke test** (~30 min) — the only universally-flagged hard blocker.
- README + 1 screenshot/GIF — README already exists and is decent; screenshot is missing.
- `gh` CLI install on the user's local machine (not present in this shell session).

### Council #2 verdict — roadmap
**Rewrote `ROADMAP.md` per council.** v0.2 cut from 11 items to 5 P0s; summarization / auto-tagging / multi-platform distribution / Chrome Web Store / auto-update moved to v0.3 or v0.4. Bidirectional links promoted from v0.4 → v0.3 (cheap legibility win). Kill criteria added to every phase. Cert costs ($99 Apple + $200-400 Win + $5 Chrome Store) called out as explicit prerequisites. `Out of scope: telemetry` reframed — cloud telemetry forever no, opt-in local-only usage log added to v0.2 P0 as the only realistic research instrument.

### Blocked on user
1. `gh` CLI is not installed in this shell. The actual `gh repo create cortex --public --source=. --remote=origin --push` and `gh release create v0.1.0-beta --prerelease ...` commands must be run by the user on their own machine.
2. Clean-VM installer smoke test must happen before publishing.
3. Optional: one screenshot or short GIF in the repo before the pre-release goes public.
