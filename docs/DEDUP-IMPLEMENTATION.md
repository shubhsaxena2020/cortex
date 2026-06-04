# Dedup Implementation (v0.2 P0 #1, part 1 of 2)

> Status: **Same-pipeline dedup shipped.** Cross-pipeline absorption (vault-file ↔ memory linking) is part 2, sequenced after Shubh verifies part 1.

## What ships in this commit

When the extension POSTs the same conversation twice — same Claude/ChatGPT/Gemini URL, different capture moments — Cortex now keeps a single `memories` row instead of two. Same row id, latest content wins, `updatedAt` bumps, the graph node stays put.

## Architecture (3 layers, each independently testable)

### Layer 1 — Pure URL canonicalisation (`src/main/url-canon.ts`)
Turns `https://CLAUDE.AI/chat/abc/?utm_source=email#section` into `https://claude.ai/chat/abc`. Strips tracking params (utm_*, fbclid, gclid, msclkid, ref, ref_src, _ga, mc_cid/eid), lowercases host, drops fragments, removes trailing slash, sorts remaining query params for determinism. **Pure function. No I/O. Fully unit-tested** (`url-canon.test.ts`, 18 cases).

### Layer 2 — Schema (`src/main/db.ts`)
- New column: `memories.url TEXT NULL` (nullable so existing rows aren't broken)
- New index: `idx_memories_url ON memories(url) WHERE url IS NOT NULL` (partial — most legacy rows have NULL; full index would waste space)
- Bumped `SCHEMA_VERSION` from 1 to 2
- Added `runMigrations(db, from, to)` — idempotent, transactional, forward-only. The contract: every existing user runs every migration step from their stored version forward exactly once, on app launch.
- Fresh installs get the column via the `CREATE TABLE IF NOT EXISTS` statement directly; existing users get it via the migration.

### Layer 3 — Upsert path (`src/main/db.ts` + `src/main/http.ts`)
- New `upsertMemoryByUrl(...)` in `db.ts` — if canonical URL is non-null AND already exists, UPDATE in place (preserving id + timestamp, bumping updatedAt). Otherwise plain INSERT.
- POST `/api/memories` handler now canonicalises `body.url` and routes through `upsertMemoryByUrl`. Returns `{ memory, action: 'created' | 'updated' }`. Status code is `201` for create, `200` for update — standard REST semantics. **API contract change is additive** — existing extension code that ignores `action` still works.

## What didn't change (deliberate)

- **No new tables.** All work fits in the existing `memories` table.
- **No content de-duplication.** If a user POSTs two genuinely different chats that happen to be at the same URL (Claude.ai sometimes routes new chats through the same root URL before issuing an ID), they merge by URL. This is the right default — the alternative (content-hash dedup) is more expensive and produces worse UX (legitimate edits get rejected).
- **No deletion of `vault_files` rows.** Same conversation still appears in BOTH `memories` and `vault_files` for now — cross-pipeline absorption is part 2 of P0 #1.
- **Backfill is offline.** Doesn't run on app launch (would slow startup for users with large vaults). User opts in via `npm run backfill-source-urls -- --dry-run` then without `--dry-run`.

## Backfill (`scripts/backfill-source-urls.mjs`)

Single-shot script that:
1. Opens the live DB at `%APPDATA%\Cortex\memories.db`
2. Reads `vault-config.json` to find the vault path
3. Walks `<vault>/AI Conversations/**.md`, parses each file's frontmatter, extracts the URL
4. Indexes URLs by the *expected filename* the app would have written (reconstructed from each memory's title + created_at via the same slug algorithm used in `src/main/index.ts:saveConversationToVault`)
5. For each memory with `url IS NULL`, looks up the expected filename → URL; UPDATEs if found
6. Reports counts: already-had / matched / unmatched

**Safety:**
- `--dry-run` is the recommended first invocation; prints up to 10 sample updates without writing
- Single transaction; rolls back atomically on error
- Only updates rows where `url IS NULL` (idempotent; never overwrites)
- Refuses to run if schema_version < 2 (forces user to launch the app once first so the migration runs)

## Tests

| File | Type | Run by |
|---|---|---|
| `src/main/url-canon.test.ts` | Unit (pure functions) | `npm test` — vitest |
| `src/main/frontmatter.test.ts` | Unit (pure functions) | `npm test` — vitest |
| Live-DB dedup integration | E2E via Fastify | `scripts/integration-tests.mjs` (manual — better-sqlite3 ABI prevents vitest) |

**Why no `dedup.test.ts` in vitest:** `db.test.disabled.ts` documents that better-sqlite3 is compiled against Electron's Node ABI (125), vitest runs on plain Node (ABI 127), and the native binary won't load. Any test that touches `db.ts` functions can't run in vitest until we adopt `vitest-electron` (v0.3 item per Council #2). The pure-logic layers (url-canon, frontmatter) are fully unit-tested; the dedup path itself is verified via the live integration script + manual smoke.

## Trade-offs and what they buy us

| Decision | Trade-off | Why |
|---|---|---|
| URL-based dedup key (not content hash) | Edits to the same chat replace the memory | Aligns with user mental model ("re-capture this chat") + much cheaper |
| Canonicalise + strip tracking params | Two captures from email link vs direct share land on same key | Matches user expectation; tracking params are noise by definition |
| In-place UPDATE preserves id | Stable graph nodes across re-captures | Edges, embeddings, relationships all hang off the id |
| Migration adds nullable column | Some legacy rows never get a URL (backfill misses unmatched files) | Backfill is best-effort; unmatched rows simply never dedup with future captures, which is harmless |
| Pure logic in separate files | Two new tiny modules + two test files | Worth it: url-canon and frontmatter are reusable + the only fully-testable parts of P0 #1 |

## Regression fixed in `1d7d0e1 → <follow-up>`

The first cut shipped a sequencing bug — `CREATE INDEX ... ON memories(url)` lived in the initial `db.exec()` block, which ran before `runMigrations()` could `ALTER TABLE` to add the column. On any existing v1 database the index creation threw `SqliteError: no such column: url` and crashed `initDb()` before the migration could heal it.

**Fix:** moved the index creation **into the migration step** (where the ALTER lives), and changed `initDb` to treat an absent `schema_version` row as version 0 so fresh installs also run the migration chain (since the index now only exists inside `runMigrations`).

**Regression guard:** `src/main/db.migration-ordering.test.ts` reads `db.ts` as text and asserts the architectural rules — initial `db.exec` block must not reference `idx_memories_url`, migration must create it, ALTER must be PRAGMA-guarded, version handling must default to 0 for absent rows. Any future edit that reintroduces the bug fails CI at PR time, not on user startup.

## Rollback path

If P0 #1 part 1 misbehaves in production:

```sql
-- Revert migration manually (sqlite shell against memories.db)
UPDATE schema_version SET version = 1;
-- The column itself can stay; nothing reads it if the app code is reverted.
-- SQLite has no DROP COLUMN before 3.35; live with the dead column.
```

Then revert the commit. The dead `url` column on existing rows is harmless — it's nullable, unindexed (the partial index has zero entries if the app stops writing URLs), and ignored by all read paths in pre-v0.2 code.

## Part 2 — Cross-pipeline absorption (shipped)

Resolves the absorbed `v0.2-FULL-ROADMAP.md` issue: same conversation appearing twice (as a Memory node *and* a File node) because Extension POST and vault-watcher are two separate ingestion paths into two separate tables.

### Schema (v2 → v3)

```sql
ALTER TABLE vault_files ADD COLUMN frontmatter_url  TEXT;
ALTER TABLE vault_files ADD COLUMN linked_memory_id TEXT;  -- REFERENCES on fresh installs only (SQLite ALTER limitation)
CREATE INDEX IF NOT EXISTS idx_vault_frontmatter_url
  ON vault_files(frontmatter_url) WHERE frontmatter_url IS NOT NULL;
```

`ON DELETE SET NULL` is declared on the column for fresh installs (via the initial `CREATE TABLE`). Existing installs get the column via `ALTER TABLE`, which SQLite forbids from carrying FK constraints — so the integrity guarantee is enforced at the app layer in `deleteMemory()` via `UPDATE vault_files SET linked_memory_id = NULL WHERE linked_memory_id = ?`. Both paths converge on the same observable behaviour.

### Linking, on file ingest (`vault.ts indexFile`)

When the vault watcher sees a `.md` file:
1. Parse YAML frontmatter via the same `parseFrontmatter` module Part 1 introduced.
2. Canonicalise the `url:` field via the same `canonicalUrl` module.
3. Look up `findMemoryByCanonicalUrl(canonical)` — if a memory exists, set `linked_memory_id` on the new vault row.
4. Either way, `frontmatter_url` (the canonicalised URL) gets stored so future memory creates can backlink.

**Self-heal on upgrade.** The existing skip-if-unchanged guard (`if (lastModified === lastModified && size === size) return`) prevents v2 vault rows from ever being re-processed. The migration would land but the existing rows would never get their `frontmatter_url` populated. Workaround: on the next launch after upgrade, `indexFile` re-processes any `.md` file whose existing row has `frontmatterUrl == null`. One-shot extra work; subsequent launches skip normally.

### Race-condition handling (memory created after file)

Reverse order — file gets indexed *before* the matching memory exists — is handled by `upsertMemoryByUrl` retroactively linking:

```sql
UPDATE vault_files SET linked_memory_id = ?
  WHERE frontmatter_url = ? AND linked_memory_id IS NULL
```

Runs only on the `'created'` branch (UPDATE branch already linked; new content for an existing memory doesn't change the file's link). Idempotent.

### Hiding linked files (read paths)

Filter happens at `db.ts` so every consumer inherits it — graph, Sidebar Files tab, search, IPC `vault:getFiles`. Single source of truth:

```sql
SELECT * FROM vault_files WHERE linked_memory_id IS NULL ORDER BY ...
```

If a future admin tool or "show linked" toggle needs the suppressed rows, that's a *new* db function (`getAllVaultFilesIncludingLinked`) — not a flag on this one. Keeps the default safe.

### Regression guard (Part 2 additions)

`src/main/db.migration-ordering.test.ts` adds 6 new structural assertions:
- v3 index NOT in initial CREATE TABLE block (same regression class as v2 — index would reference a column the ALTER hasn't added yet)
- v3 migration MUST create the index
- v3 ALTERs MUST be PRAGMA-guarded
- v3 `linked_memory_id` ALTER MUST NOT include REFERENCES (SQLite silently drops it; documented invariant)
- `deleteMemory` MUST null linked references at app layer
- Both `getAllVaultFiles` and `searchVaultFiles` MUST filter on `linked_memory_id IS NULL`

Total tests: 179.

### Rollback path

```sql
UPDATE schema_version SET version = 2;
-- v3 columns + index are harmless dead weight at v2.
```

Then revert the commit; `linked_memory_id` filters become no-ops because the column is always NULL in v2 code, all vault files re-appear.

### Out of scope for Part 2

- **No UI "from chat" pill** on memory nodes indicating they have an underlying file. Pure absorption — the user shouldn't need to know the storage shape; they have a memory, end of story. If discoverability becomes a real complaint, that's a v0.3 affordance, not a v0.2 dedup concern.
- **No bulk backfill script** for existing vault files that have URLs but were ingested before v3. The self-heal-on-next-index path covers them — they get linked the next time the watcher touches them, which is the next launch.

## Verification checklist (for Shubh)

- [ ] `npm test` passes (128 + ~30 new = ~158 expected)
- [ ] `npm run build` green on all three bundles
- [ ] Launch the app — log line `[db] migrated schema 1 → 2` appears in electron-log (or fresh-install lands at version 2 directly)
- [ ] `npm run backfill-source-urls -- --dry-run` reports plausible counts
- [ ] `npm run backfill-source-urls` applies cleanly; re-running it shows 0 new updates (idempotency)
- [ ] Capture the same Claude conversation twice via the extension; `SELECT id, url, updated_at FROM memories WHERE url = 'https://claude.ai/chat/<uuid>'` returns exactly 1 row with `updated_at` bumped
- [ ] Capture two genuinely different conversations; both rows present
- [ ] Capture from a URL with `?utm_source=...`; capture again from the clean URL; still 1 row (canonicalisation working)
