# Cortex Codebase Snapshot

> Reference for v0.2 Part 2+ work. Generated at commit `c015dfe`. Re-run the scan that produced this doc if more than a few commits have landed since.

## 1. Directory structure

```
cortex/
├── src/
│   ├── main/                          # Node — DB, IPC, Fastify, embeddings, vault watcher
│   │   ├── index.ts            (432)  # App entry, IPC handlers, window lifecycle, DOCX read
│   │   ├── db.ts               (699)  # SQLite schema + queries + migrations
│   │   ├── db.test.disabled.ts (218)  # Parked — better-sqlite3 ABI mismatch (Phase 4 vitest-electron)
│   │   ├── db.migration-ordering.test.ts (161)  # Structural assertions on db.ts source
│   │   ├── http.ts             (376)  # Fastify routes (extension API + /pair + /health)
│   │   ├── http.test.ts        (503)  # API tests with mocked db
│   │   ├── vault.ts            (305)  # chokidar watcher, indexFile, frontmatter linking
│   │   ├── vault.test.ts       (271)
│   │   ├── extension-config.ts (115)  # token + port persistence (userData/extension-config.json)
│   │   ├── embeddings.ts        (83)  # Ollama all-minilm (384-dim); null-on-failure contract
│   │   ├── embeddings.test.ts  (150)
│   │   ├── seed-embeddings.ts   (56)  # Startup backfill — embed any memory missing a vector
│   │   ├── transformers.ts      (61)  # Row → API shape (toMemory, toRelationship, makeHighlight)
│   │   ├── transformers.test.ts (76)
│   │   ├── url-canon.ts         (88)  # NEW (P0 #1) — pure URL canonicalisation
│   │   ├── url-canon.test.ts   (133)
│   │   ├── frontmatter.ts      (105)  # NEW (P0 #1) — line-oriented YAML frontmatter reader
│   │   └── frontmatter.test.ts (138)
│   │
│   ├── preload/
│   │   └── index.ts             (70)  # contextBridge — only file touching both worlds
│   │
│   ├── renderer/
│   │   ├── index.html
│   │   └── src/
│   │       ├── main.tsx         (10)
│   │       ├── App.tsx         (246)  # Top nav, StatusBar (indexing progress UI), keyboard shortcuts
│   │       ├── store.ts        (178)  # Zustand
│   │       ├── pages/
│   │       │   ├── Dashboard.tsx  (46)
│   │       │   ├── GraphView.tsx (256)
│   │       │   ├── Search.tsx    (293)
│   │       │   └── Settings.tsx  (496)  # AI status, vault, watch folder, extension pairing
│   │       ├── components/
│   │       │   ├── Sidebar.tsx       (259)  # Memories / Files tabs
│   │       │   ├── GraphCanvas.tsx   (391)  # D3 force sim on <canvas>
│   │       │   ├── MemoryEditor.tsx  (208)
│   │       │   ├── FileTree.tsx      (386)
│   │       │   ├── FileViewer.tsx    (202)
│   │       │   └── InsightPopup.tsx   (83)
│   │       ├── utils/
│   │       │   ├── graph-builder.ts        (137)  # Pure transform: memories+relationships+files → D3 nodes/links
│   │       │   ├── graph-builder.test.ts   (194)
│   │       │   └── chat-formatter.test.ts  (161)
│   │       └── styles/
│   │
│   └── types/
│       └── index.ts            (122)  # Shared types (Memory, Relationship, VaultFile, ElectronAPI)
│
├── extension/                          # Chrome MV3 extension
│   ├── manifest.json            (36)
│   ├── background.js           (306)  # Service worker — pairing handshake, POST capture, badge state
│   ├── content.js              (465)  # Injected by popup.js — DOM extraction per provider
│   ├── popup.html               (62)
│   ├── popup.js                (613)  # UI + extractChat invocation + buildMarkdown
│   └── styles.css
│
├── scripts/
│   ├── backfill-source-urls.mjs       # P0 #1 backfill — vault frontmatter → memories.url
│   ├── verify-paste-mechanisms.mjs    # v0.3 switch-AI prep — prints DevTools probe
│   ├── integration-tests.mjs          # Live-process API + semantic search tests
│   ├── api-smoke-tests.mjs            # HTTP endpoint smoke tests
│   ├── test-embeddings.mjs            # Ollama embedding smoke tests
│   └── final-phase3-report.mjs
│
├── docs/
│   ├── DEDUP-IMPLEMENTATION.md        # P0 #1 design doc (parts 1 + 2)
│   ├── PASTE-MECHANISM-REFERENCE.md   # v0.3 prep
│   └── CODEBASE_SNAPSHOT.md           # this file
│
├── designs/
│   └── switch-ai-spec.md              # v0.3 switch-AI design spike
│
├── diagnostics/
│   └── truncation-report.json         # v0.1.0.1 hotfix root-cause (Claude AI-message extraction)
│
├── database/
│   └── schema.sql                     # Legacy/reference — runtime schema is in db.ts
│
├── electron.vite.config.ts
├── electron-builder.json              # appId com.cortex.app, productName Cortex
├── vitest.config.ts                   # node env, src/**/*.test.ts
├── tsconfig.json + tsconfig.web.json + tsconfig.node.json
├── package.json + package-lock.json + skills-lock.json
├── postcss.config.js + tailwind.config.js
├── SESSION.md + ROADMAP.md + RELEASE_NOTES.md + EXTENSION_SETUP.md
├── v0.2-FULL-ROADMAP.md + v0.2-P0-ROADMAP.md
└── README.md + LICENSE
```

**No `mcp/` directory and no `mcp*.json` files** — Cortex does not currently host an MCP server. It consumes MCPs only during development through the Claude Code session that's editing it.

**Total source LOC:** ~7,708 TS/TSX (excluding extension JS, which adds ~1,400). Largest file: `src/main/db.ts` at 699 lines.

## 2. File-content read / processing call sites

Where bytes turn into structured data. Grouped by layer.

### 2.1 Browser → text (Chrome extension)

**`extension/content.js`** — injected per provider DOM. Returns `{ messages: [{ role, content, index }], source, title }`.

| Line | What | Layer |
|---|---|---|
| 5 | `extractChat()` — top-level dispatcher, picks per-provider extractor by `location.hostname` | router |
| 48 | `extractClaude()` — 5 strategies (Strategy 0 = action-bar anchor, the v0.1.0.1 fix; 1-4 = legacy fallbacks) | provider |
| 255 | `extractChatGPT()` — `[data-message-author-role]` primary, `article[data-testid^="conversation-turn"]` fallback | provider |
| 303 | `extractGemini()` — `user-query` / `model-response` web components, conversation-bubble fallback | provider |
| 352 | `extractTextFromElement(el)` → calls `domToMarkdown(el).trim()` | text |
| ~360 | `domToMarkdown(node)` — recursive walk; handles `<strong>`, `<em>`, `<code>`, `<pre>`, `<a>`, `<h1-6>`, `<li>`, tables, paragraphs | text |
| ~420 | `convertTable(table)` — Markdown table emit | text |

**`extension/popup.js`** — drives extraction + ships to backend.

| Line | What |
|---|---|
| 464 | `chrome.scripting.executeScript({ file: 'content.js' })` — invokes the extractor in the tab's context |
| 470 | Validates `extracted.messages.length > 0`; otherwise reports the per-provider error |
| 483 | `buildMarkdown(messages, source, title, tab.url)` — assembles the final `.md` (quotes humans with `> `, leaves AI plain) |
| 527 | `buildMarkdown` body — this is where the YAML frontmatter is emitted |

**`extension/background.js`** — service worker; POSTs to Cortex.

| Line | What |
|---|---|
| 60-100 | `saveSelection()` — alternate path for highlight-and-save (different from full-conversation capture) |
| 98 | `fetch('http://127.0.0.1:<port>/api/memories', POST, Bearer)` — the single ingest point |
| 130 | `deriveTitle(text)` — `.slice(0, 57)` — title-only truncation; the only `slice` on text content anywhere |

### 2.2 Disk → DB (main process)

**`src/main/vault.ts`** — vault watcher + file ingestion.

| Line | What |
|---|---|
| 7-10 | Imports `db`, `getEmbedding`, `canonicalUrl`, `parseFrontmatter` |
| ~125 | `extractText(filepath, ext)` — `readFile(filepath, 'utf-8')`; size-capped at `MAX_FILE_SIZE` (10 MB) |
| ~140-180 | `indexFile(filepath)` — the core ingest function |
| (within indexFile) | Skip-if-unchanged: `existing.lastModified === lastModified && existing.size === size` UNLESS `frontmatterUrl == null && ext === '.md'` (P0 #1 part 2 self-heal path) |
| (within indexFile) | Parse YAML frontmatter on `.md` files → `parseFrontmatter(content)` |
| (within indexFile) | Canonicalise `fm.url` → `canonicalUrl(...)` |
| (within indexFile) | Link to memory if found → `db.findMemoryByCanonicalUrl(...)` → store `linked_memory_id` |
| (within indexFile) | `db.upsertVaultFile({ ...data, frontmatterUrl, linkedMemoryId })` |
| (within indexFile) | If text + vector search enabled: async `getEmbedding(content.slice(0, 4000))` → `storeVaultEmbedding` |
| 209 | `chokidar.watch(vaultPath)` — vault folder watcher (writes by extension + manual file ops) |
| 283 | `chokidar.watch(watchPath)` — secondary watch-folder watcher (user-pointed external folder) |

**`src/main/index.ts`** — process glue.

| Line | What |
|---|---|
| 15 | `const mammoth = require('mammoth') as typeof import('mammoth')` — DOCX text extraction |
| 27-61 | `saveConversationToVault(memory, url?)` — writes `.md` with frontmatter (source, captured, url, tags) + memory.content; called from `onMemoryCreated` after POST |
| 373 | IPC `vault:readFile` — `readFile(filepath, 'utf-8')` for the renderer's FileViewer |
| 404 | IPC `vault:extractDocText` — `mammoth.extractRawText({ path: filepath })` for `.docx` |

### 2.3 DB → API / renderer (main process)

**`src/main/db.ts`** — full SQL surface. All read paths return mapped rows via `mapMemory` / `mapVaultFile` / `mapRelationship`.

| Line | Query | Filter notes |
|---|---|---|
| 179 | `SELECT version FROM schema_version` — once per `initDb` |
| 222, 239 | `PRAGMA table_info(memories)` / `PRAGMA table_info(vault_files)` — migration idempotency guards |
| 312 | `SELECT * FROM memories WHERE url = ?` — `findMemoryByCanonicalUrl` (P0 #1) |
| 322 | `UPDATE memories SET url = ? WHERE id = ?` — `setMemoryUrl` (backfill) |
| 355 | `UPDATE vault_files SET linked_memory_id = ? WHERE frontmatter_url = ? AND linked_memory_id IS NULL` — retroactive link on memory create (P0 #1 part 2) |
| 387 | `SELECT * FROM memories WHERE id = ?` |
| 392 | `SELECT * FROM memories ORDER BY updatedAt DESC` — `getAllMemories` |
| ~290 | `SELECT * FROM memories WHERE title LIKE ? OR content LIKE ? [+ source + tags filters] ORDER BY updatedAt DESC LIMIT 50` — `searchMemories` (LIKE-escaped; not FTS) |
| 425 | `UPDATE vault_files SET linked_memory_id = NULL WHERE linked_memory_id = ?` — `deleteMemory` cleanup (P0 #1 part 2 app-layer FK enforcement) |
| 485-486 | `SELECT COUNT(*) ... FROM memories` + `... GROUP BY source` — `getStats` |
| 525 | `INSERT INTO memory_vectors` — DELETE-then-INSERT pattern (sqlite-vec doesn't honor `INSERT OR REPLACE`) |
| 548 | `SELECT memory_id FROM memory_vectors` |
| 612 | `SELECT * FROM vault_files WHERE filepath = ?` |
| **571** | **`SELECT * FROM vault_files WHERE linked_memory_id IS NULL ORDER BY last_modified DESC`** — `getAllVaultFiles`. **Filters linked files.** |
| **594** | **`SELECT * FROM vault_files WHERE linked_memory_id IS NULL AND (filename LIKE ? OR content LIKE ?) ORDER BY last_modified DESC LIMIT 50`** — `searchVaultFiles`. **Filters linked files.** |

The two **bolded** SELECTs are the single source of truth for "which vault files are visible." Adding a third read path that forgets the filter is a P0 #1 part 2 regression — see `db.migration-ordering.test.ts:154` for the structural assertion that catches it.

### 2.4 Search (main + renderer)

| Where | What |
|---|---|
| `http.ts:145` POST `/api/search` | LIKE-based via `db.searchMemories(q, source, tags)` |
| `http.ts:163` POST `/api/related` | Vector path first (`getEmbedding` → `db.vectorSearch`), falls back to keyword via `db.searchMemories(kw)` |
| `index.ts:283` IPC `memories:search` | Same LIKE path as `/api/search` |
| `index.ts:391` IPC `vault:semanticSearch` | `getEmbedding` → `db.vectorSearchVaultFiles(vec, 20)` |
| `Search.tsx:293` | UI — combines memory + file results client-side |
| `transformers.ts:46` `makeHighlight(content, query)` | Substring highlighting with `<mark>` for search hits; HTML-escapes user content |

### 2.5 Graph build (renderer)

**`src/renderer/src/utils/graph-builder.ts`** — pure transform. Receives `memories`, `relationships`, `vaultFiles` from the store (already filtered by `db.getAllVaultFiles`'s `linked_memory_id IS NULL`). Returns `{ nodes, links }`.

| Line | What |
|---|---|
| 64 | `buildGraph(memories, relationships, vaultFiles, filter, watchPath?)` — entry |
| 75-87 | Memory nodes (color by source: claude/chatgpt/gemini/manual) |
| 90-105 | File nodes (color by extension family) |
| 109-113 | Memory↔memory edges from `relationships` table — **only manually-created today; no auto-edge code anywhere** (this is P1 #4 in `v0.2-FULL-ROADMAP.md`) |
| 115-125 | Memory↔file `'mention'` edges — automatic, semantic: a memory mentions a file if its content contains the file's stem (cheap heuristic; lives only in the renderer) |
| 127-134 | Edge counting → `connections` per node (drives sizing in GraphCanvas) |

`GraphCanvas.tsx` renders on `<canvas>` with D3 force simulation drawn manually (not SVG — important context for P0 #3 LOD work; the spec's "canvas migration" item doesn't exist).

## 3. Dependencies (`package.json`)

### Runtime

| Package | Version | Why |
|---|---|---|
| `electron` (devDep) | ^31.3.1 | Desktop shell |
| `react` + `react-dom` | ^18.3.1 | UI |
| `zustand` | ^4.5.5 | Renderer state |
| `lucide-react` | ^0.427.0 | Icons |
| `d3` | ^7.9.0 | Force simulation + quadtree (latter unused; future LOD work) |
| `react-markdown` | ^9.0.1 | Memory + file viewer rendering |
| `highlight.js` | ^11.11.1 | Code blocks inside markdown |
| `fastify` | ^5.8.5 | Local extension API on 127.0.0.1 |
| `better-sqlite3` | ^12.10.0 | DB; synchronous = simpler IPC model. **Native binary; ABI 125 on Electron 31** |
| `sqlite-vec` | ^0.1.9 | Vector search extension; loaded best-effort, degrades to FTS/LIKE |
| `chokidar` | ^3.6.0 | Vault + watch-folder watchers |
| `mammoth` | ^1.12.0 | `.docx` text extraction |
| `electron-log` | ^5.4.4 | Centralised logging (electron-log/main + auto rotation) |
| `@electron-toolkit/preload` + `@electron-toolkit/utils` | ^3.0.0 | preload helpers + `is.dev` |

### Dev

`@types/*`, `vite` 5, `@vitejs/plugin-react` 4, `electron-vite` 2, `electron-builder` 24, `vitest` 4, `tailwindcss` 3, `postcss` 8, `autoprefixer` 10, `typescript` 5.5.

**No** linter (eslint/biome) wired in. **No** prettier in package.json. **No** husky / lint-staged.

## 4. MCP servers

**None hosted by this repo.** No `mcp/` directory, no `mcp.json`, no `*.mcp.json`. Cortex does not currently:
- Expose any MCP server (e.g. for letting other AIs query the vault)
- Consume MCP servers at runtime

MCP only enters the picture through the Claude Code session editing the codebase. If "Cortex as MCP server" becomes a real product direction, that's net-new work, sequenced after v0.2 P0.

## 5. TypeScript configuration

Three-file split (composite project references):

**`tsconfig.json` (root)** — references only; no own emit.

```json
{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }] }
```

**`tsconfig.node.json`** — main + preload + types.
- `target: ES2022`, `module: CommonJS`, `moduleResolution: node`
- `composite: true`, `strict: true`, `outDir: dist`
- `include: electron.vite.config.*, src/main/**/*, src/preload/**/*, src/types/**/*, package.json`
- `exclude: src/main/**/*.test.ts, src/main/**/*.test.disabled.ts`
- Path alias: `@types/*` → `src/types/*`

**`tsconfig.web.json`** — renderer + types.
- `target: ES2020`, `module: ESNext`, `moduleResolution: bundler`, `jsx: react-jsx`
- `lib: ES2020, DOM, DOM.Iterable`
- Path aliases: `@renderer/*` → `src/renderer/src/*`, `@types/*` → `src/types/*`
- `include: src/renderer/src/**/*, src/types/**/*`

**Both have `strict: true`.** No `any` slipping through. `composite: true` enables `tsc -b` incremental builds — already used by the recommended `--incremental` hook pattern in `~/.claude/rules/ecc/web/hooks.md`.

## 6. Build system

**`electron-vite` 2.3** — wraps Vite 5 for Electron's three-process boundary.

`electron.vite.config.ts`:
- **main bundle** → `dist/main/index.js` (entry: `src/main/index.ts`). Externals: `electron`, `better-sqlite3`, `fastify`, `sqlite-vec`, `chokidar`, `mammoth` (native or large; kept out of the bundle, resolved at runtime).
- **preload bundle** → `dist/preload/index.js` (entry: `src/preload/index.ts`). External: `electron`.
- **renderer bundle** → `dist/renderer/` (root: `src/renderer`, entry: `src/renderer/index.html`). Plugin: `@vitejs/plugin-react`.

`electron-builder.json`:
- `appId: com.cortex.app`, `productName: Cortex`
- `asar: true` with `asarUnpack: **/*.node, **/*.dll, **/better-sqlite3/**, **/sqlite-vec*/**` (native bins can't live inside asar)
- Targets: Windows NSIS x64 (only one shipped), macOS DMG, Linux AppImage (latter two configured but not built)
- Publish: GitHub `shubhsaxena2020/cortex`

`vitest.config.ts`: `environment: 'node'`, `include: ['src/**/*.test.ts', 'src/**/*.spec.ts']`. **No DOM environment** — renderer components aren't tested with React Testing Library; coverage for renderer-side logic comes from pure utility tests (`graph-builder.test.ts`, `chat-formatter.test.ts`).

**No webpack, no esbuild config separate from Vite's, no rollup config separate from Vite's.**

## 7. Bonus reference — full IPC + Fastify route surface

For any v0.2 Part 2+ work touching the renderer ↔ main ↔ extension boundary, this is the contract surface in one place.

### IPC handlers (`src/main/index.ts`)

| Channel | Args | Returns |
|---|---|---|
| `memories:getAll` | — | `Memory[]` |
| `memories:get` | `id` | `Memory \| null` |
| `memories:create` | `{ title, content, source, tags }` | `Memory` |
| `memories:update` | `id, { title, content, tags }` | `Memory` |
| `memories:delete` | `id` | `{ success: true }` |
| `memories:search` | `query, tags?, source?` | `SearchResult[]` |
| `relationships:getAll` | — | `Relationship[]` |
| `relationships:getForMemory` | `memoryId` | `Relationship[]` |
| `relationships:create` | `{ memory_a_id, memory_b_id, relationship_type }` | `Relationship` |
| `relationships:delete` | `id` | `{ success: true }` |
| `extension:getConfig` | — | `ExtensionConfig` |
| `extension:armPairing` | `durationMs?` | `number` (deadline ms) |
| `system:getStatus` | — | `SystemStatus` (Ollama, vector search, API server) |
| `vault:getConfig` | — | `VaultConfig \| null` |
| `vault:choosePath` | — | `string \| null` |
| `vault:initVault` | `vaultPath` | `void` |
| `vault:getFiles` | — | `VaultFile[]` (linked files filtered) |
| `vault:searchFiles` | `query` | `VaultFile[]` (linked files filtered) |
| `vault:deleteFile` | `id` | `void` |
| `vault:openInExplorer` | `filepath` | `void` |
| `vault:readFile` | `filepath` | `string` |
| `vault:createFile` | `dirPath, filename` | result |
| `vault:createFolder` | `dirPath, name` | result |
| `vault:rename` | `oldPath, newPath` | `void` |
| `vault:deleteItem` | `itemPath` | `void` |
| `vault:openFile` | `filepath` | `void` |
| `vault:semanticSearch` | `query` | `VaultFile[]` (via Ollama + sqlite-vec) |
| `vault:extractDocText` | `filepath` | `string` (mammoth, .docx) |
| `vault:copyToVault` | `sourcePaths, destDir` | result |
| `vault:setWatchPath` | `watchPath` | `void` |

Plus three push events (main → renderer): `memories:changed`, `vault:changed`, `vault:indexProgress`.

### Fastify routes (`src/main/http.ts`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | Handshake — returns `{ ok, app: 'cortex', version, apiVersion }` |
| GET | `/pair` | none, **only during armed window** | Returns `{ token }` once; window opened by Settings → Pair Extension |
| GET | `/api/search` | Bearer | Querystring `q, source?, tags?` |
| GET | `/api/related` | Bearer | Querystring `context` — vector path first, FTS fallback |
| POST | `/api/memories` | Bearer | **Dedup via canonicalUrl + upsertMemoryByUrl** (P0 #1 part 1). Returns `{ memory, action: 'created' \| 'updated' }`, status 201/200 |
| GET | `/api/recent` | Bearer | Querystring `limit?` (1-50, default 10) |
| DELETE | `/api/memories/:id` | Bearer | 204 on success, 404 if absent |
| GET | `/api/admin/embed-status` | Bearer | Querystring `ids?` — embedding presence per id |
| GET | `/api/vault/check-url` | Bearer | Querystring `url` — used by extension to detect existing capture before re-saving |
| POST | (vault-save) | Bearer | (line 310) — full path TBD on next scan |

## 8. Things deliberately NOT in this snapshot

- **`node_modules/`, `dist/`, `release/`, `build/`** — generated. Inspect `electron.vite.config.ts` for build behaviour; inspect `electron-builder.json` for packaging.
- **`.cortex-shots/`** — frozen Phase-2 UI snapshots; historical, gitignored.
- **Settings UI internals** — Settings.tsx is 496 lines; functions are documented at the top of the file. Re-grep when working on it.
- **Test fixtures directory** — none yet at `tests/fixtures/`. v0.2 P0 #2 part 1 added a synthetic minimal fixture inline in `extension/filters.test.js`. When you capture a real ChatGPT/Claude/Gemini conversation that exhibits noise, extract its outerHTML into `tests/fixtures/capture-{provider}.html` and import from the existing test file — the harness is identical.

### Updates since generation

- `extension/filters.js` + `extension/filters.test.js` added by P0 #2 (Smart capture filtering). Tests count: 179 → 198. jsdom added as dev dep. vitest now includes `extension/**/*.test.{js,ts}`.
