#!/usr/bin/env node
// scripts/purge-test-data.mjs
//
// Phase 1: Purge ALL rows from memories and memory_relationships, then VACUUM.
// Run this before seeding project knowledge so the graph starts from a clean slate.
//
// USAGE (from project root):
//   node scripts/run-as-node.cjs scripts/purge-test-data.mjs
//
// SAFETY: Run while the Electron app is CLOSED. better-sqlite3 takes an
// exclusive write lock; having both the app and this script open the same
// WAL database concurrently is safe from a consistency standpoint but the
// app may show stale data until it restarts.

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import process from 'node:process'

const APPDATA = process.env.APPDATA || ''
const dbPath = join(APPDATA, 'Cortex', 'memories.db')

if (!existsSync(dbPath)) {
  console.error(`[purge] DB not found: ${dbPath}`)
  console.error(`[purge] Launch the Cortex app at least once to create it.`)
  process.exit(1)
}
console.log(`[purge] DB: ${dbPath}`)

let Database
try {
  Database = (await import('better-sqlite3')).default
} catch (e) {
  console.error(`[purge] Failed to load better-sqlite3: ${e.message}`)
  console.error(`[purge] Run from the project root (node_modules must be present).`)
  process.exit(1)
}

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')  // default; we'll suspend during the bulk wipe below

// ── Step 1: Count before ──────────────────────────────────────────────────────

const memBefore  = db.prepare('SELECT COUNT(*) as n FROM memories').get().n
const relBefore  = db.prepare('SELECT COUNT(*) as n FROM memory_relationships').get().n

console.log(`[purge] Before purge:`)
console.log(`[purge]   memories:             ${memBefore}`)
console.log(`[purge]   memory_relationships: ${relBefore}`)

// ── Step 2: Delete ────────────────────────────────────────────────────────────
//
// Suspend FK enforcement for the bulk wipe. PRAGMA foreign_keys may only be
// changed outside a transaction (it is a no-op inside one). We own both sides
// of every FK relationship here so skipping enforcement is safe; it is restored
// unconditionally after the wipe completes.

db.pragma('foreign_keys = OFF')

try {
  const doPurge = db.transaction(() => {
    // Relationships
    const rr = db.prepare('DELETE FROM memory_relationships').run()
    console.log(`[purge]   deleted ${rr.changes} row(s) from memory_relationships`)

    // FTS5 index (memories_fts)
    try {
      const fr = db.prepare('DELETE FROM memories_fts').run()
      console.log(`[purge]   deleted ${fr.changes} row(s) from memories_fts`)
    } catch (e) {
      console.log(`[purge]   memories_fts cleanup skipped (${e.message.slice(0, 80)})`)
    }

    // Unlink vault files
    try {
      const vr = db.prepare(
        'UPDATE vault_files SET linked_memory_id = NULL WHERE linked_memory_id IS NOT NULL'
      ).run()
      if (vr.changes > 0) console.log(`[purge]   unlinked ${vr.changes} vault file(s)`)
    } catch {
      // vault_files may not exist on a very fresh install
    }

    // Memories
    const mr = db.prepare('DELETE FROM memories').run()
    console.log(`[purge]   deleted ${mr.changes} row(s) from memories`)
  })

  doPurge()
} finally {
  // Always restore FK enforcement, even if the transaction threw
  db.pragma('foreign_keys = ON')
}

// Note: memory_vectors is a sqlite-vec virtual table. Loading the extension
// in a standalone script is fragile (ABI / path differences). The app already
// runs `DELETE FROM memory_vectors WHERE memory_id NOT IN (SELECT id FROM memories)`
// at startup — any orphaned vector rows will be reaped automatically on next launch.

// ── Step 3: VACUUM ────────────────────────────────────────────────────────────

db.exec('VACUUM')
console.log(`[purge] VACUUM complete — disk space reclaimed`)

// ── Step 4: Verify ────────────────────────────────────────────────────────────

const memAfter = db.prepare('SELECT COUNT(*) as n FROM memories').get().n
const relAfter = db.prepare('SELECT COUNT(*) as n FROM memory_relationships').get().n

console.log(`[purge] After purge:`)
console.log(`[purge]   memories:             ${memAfter}`)
console.log(`[purge]   memory_relationships: ${relAfter}`)

if (memAfter !== 0 || relAfter !== 0) {
  console.error(`[purge] FAIL: expected 0 / 0, got ${memAfter} / ${relAfter}`)
  db.close()
  process.exit(1)
}

console.log(`[purge] PASS — both tables are empty. Safe to run seed-project-brain.mjs.`)
db.close()
