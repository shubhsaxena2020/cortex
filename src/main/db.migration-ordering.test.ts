// Regression test for the migration-ordering bug that crashed the app on
// existing-vault startup with `SqliteError: no such column: url`.
//
// We can't run real better-sqlite3 in vitest (see db.test.disabled.ts — ABI
// mismatch between Electron's Node 125 and vitest's Node 127). So instead of
// driving an actual SQLite, this test reads db.ts as TEXT and asserts the
// architectural rules that prevent the regression:
//
//   1. The initial db.exec() block must NOT reference `memories(url)` — that
//      column doesn't exist yet on existing v1 databases, and the index
//      creation would throw before runMigrations() can ALTER the table.
//   2. The migration step for v2 MUST create the partial index.
//   3. The migration MUST guard the ALTER with a PRAGMA check (idempotent).
//   4. The schema-version handling MUST treat absent row as version 0 so
//      fresh installs run the migration chain too — otherwise the index
//      never lands on first launch.
//
// These are structural assertions on the source of truth. If a future edit
// reintroduces the bug (e.g. someone adds the index to the wrong block), the
// test fails at PR time instead of at user app-launch time.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DB_SOURCE = readFileSync(join(__dirname, 'db.ts'), 'utf8')

describe('db.ts schema migration ordering (regression: no such column: url)', () => {
  // Helper: extract the contents of the FIRST `db.exec(\`...\`)` block in
  // initDb (the one that runs CREATE TABLE IF NOT EXISTS for every table).
  // We deliberately match the first long-template block so we don't catch
  // smaller migration-internal exec calls.
  function extractInitialExecBlock(src: string): string {
    // Match `db.exec(\`` ... matching closing `\`)` — non-greedy.
    const match = /db\.exec\(`([\s\S]*?)`\)/.exec(src)
    if (!match) throw new Error('Could not locate initial db.exec block in db.ts')
    return match[1]
  }

  function extractMigrationFunction(src: string): string {
    const match = /function runMigrations[\s\S]*?\n}\n/.exec(src)
    if (!match) throw new Error('Could not locate runMigrations() in db.ts')
    return match[0]
  }

  it('does NOT create idx_memories_url in the initial CREATE TABLE block', () => {
    // This is the load-bearing assertion. The initial exec runs on every
    // launch BEFORE migrations get a chance to ALTER the table; referencing
    // memories(url) here on an existing v1 DB throws "no such column: url"
    // and kills the app before migration can heal it.
    const block = extractInitialExecBlock(DB_SOURCE)
    expect(block).not.toMatch(/idx_memories_url/)
  })

  it('creates idx_memories_url inside runMigrations() instead', () => {
    const mig = extractMigrationFunction(DB_SOURCE)
    expect(mig).toMatch(/CREATE INDEX IF NOT EXISTS\s+idx_memories_url/)
  })

  it('guards the v2 ALTER TABLE with a PRAGMA table_info check (idempotent re-run safety)', () => {
    const mig = extractMigrationFunction(DB_SOURCE)
    // The check + ALTER should appear together — the ALTER must be inside a
    // conditional driven by PRAGMA table_info.
    expect(mig).toMatch(/PRAGMA table_info\(memories\)/)
    expect(mig).toMatch(/ALTER TABLE memories ADD COLUMN url TEXT/)
    // The ALTER must come AFTER the PRAGMA in source order, gated by
    // `!cols.some(c => c.name === 'url')`. Cheap structural check:
    const pragmaIdx = mig.indexOf('PRAGMA table_info(memories)')
    const alterIdx = mig.indexOf('ALTER TABLE memories ADD COLUMN url TEXT')
    expect(pragmaIdx).toBeGreaterThan(-1)
    expect(alterIdx).toBeGreaterThan(pragmaIdx)
  })

  it('treats absent schema_version row as version 0 so fresh installs run the migration chain', () => {
    // Fresh installs need the migration to run too — the initial CREATE TABLE
    // gives them the columns, but objects like idx_memories_url that live in
    // the migration step would otherwise never be created.
    expect(DB_SOURCE).toMatch(/row\?\.version\s*\?\?\s*0/)
  })

  it('runMigrations writes schema_version row itself (handles fresh-install INSERT and upgrade UPDATE)', () => {
    // Sole owner of the schema_version row. If initDb tried to also INSERT,
    // we could double-insert or split the transaction boundary.
    const mig = extractMigrationFunction(DB_SOURCE)
    expect(mig).toMatch(/UPDATE schema_version SET version = \?/)
    expect(mig).toMatch(/INSERT INTO schema_version \(version\) VALUES \(\?\)/)
  })

  it('runs the whole migration inside a transaction so partial failures roll back', () => {
    const mig = extractMigrationFunction(DB_SOURCE)
    expect(mig).toMatch(/d\.transaction\(/)
  })

  it('logs migration failure loudly instead of swallowing the error', () => {
    const mig = extractMigrationFunction(DB_SOURCE)
    expect(mig).toMatch(/SCHEMA MIGRATION FAILED/)
    expect(mig).toMatch(/throw err/)
  })

  it('bumps SCHEMA_VERSION constant to 2 (or higher) — required for v0.2 dedup', () => {
    expect(DB_SOURCE).toMatch(/SCHEMA_VERSION\s*=\s*(?:[2-9]|\d{2,})\b/)
  })
})
