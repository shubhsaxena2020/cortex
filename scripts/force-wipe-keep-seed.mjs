#!/usr/bin/env node
// scripts/force-wipe-keep-seed.mjs
//
// Deletes every row in memories where source != 'project_seed',
// and clears memory_relationships entirely (edges rebuild on app start).
// Preserves the 13 project_seed memories seeded by seed-project-brain.mjs.
//
// USAGE (from project root, with Cortex app CLOSED):
//   node scripts/run-as-node.cjs scripts/force-wipe-keep-seed.mjs

import { existsSync } from 'node:fs'
import process from 'node:process'

// Expand %APPDATA% explicitly — do NOT pass the env-var string to SQLite.
const APPDATA = process.env.APPDATA
if (!APPDATA) {
  console.error('[wipe] APPDATA env var is not set — cannot locate DB')
  process.exit(1)
}
const DB_PATH = `${APPDATA}\\Cortex\\memories.db`

if (!existsSync(DB_PATH)) {
  console.error(`[wipe] DB not found: ${DB_PATH}`)
  process.exit(1)
}
console.log(`[wipe] DB: ${DB_PATH}`)

// ── Load better-sqlite3 ───────────────────────────────────────────────────────

let Database
try {
  Database = (await import('better-sqlite3')).default
} catch (e) {
  console.error(`[wipe] Failed to load better-sqlite3: ${e.message}`)
  process.exit(1)
}

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

// ── Step 1: Count before ──────────────────────────────────────────────────────

const totalMem = db.prepare('SELECT COUNT(*) as n FROM memories').get().n
const seedMem  = db.prepare("SELECT COUNT(*) as n FROM memories WHERE source = 'project_seed'").get().n
const otherMem = totalMem - seedMem
const totalRel = db.prepare('SELECT COUNT(*) as n FROM memory_relationships').get().n

console.log(`[wipe] Before:`)
console.log(`[wipe]   memories total:          ${totalMem}`)
console.log(`[wipe]   memories (project_seed): ${seedMem}  ← will be kept`)
console.log(`[wipe]   memories (other):        ${otherMem}  ← will be deleted`)
console.log(`[wipe]   memory_relationships:    ${totalRel}  ← will be cleared`)

if (seedMem === 0) {
  console.error(`[wipe] No project_seed memories found — run seed-project-brain.mjs first`)
  db.close()
  process.exit(1)
}

if (otherMem === 0 && totalRel === 0) {
  console.log(`[wipe] Nothing to do — DB is already clean.`)
  db.close()
  process.exit(0)
}

// ── Step 2: Wipe ──────────────────────────────────────────────────────────────
//
// PRAGMA foreign_keys must be changed OUTSIDE a transaction (it is a no-op
// inside one). We suspend enforcement, do the deletes, restore, then VACUUM.

db.pragma('foreign_keys = OFF')

try {
  // Clear all relationships (they rebuild automatically at app startup)
  const r1 = db.prepare('DELETE FROM memory_relationships').run()
  console.log(`[wipe]   deleted ${r1.changes} row(s) from memory_relationships`)

  // Clear FTS rows for non-seed memories
  // memories_fts doesn't have a direct foreign key but orphan rows bloat search
  try {
    const r2 = db.prepare(
      "DELETE FROM memories_fts WHERE memory_id NOT IN (SELECT id FROM memories WHERE source = 'project_seed')"
    ).run()
    console.log(`[wipe]   deleted ${r2.changes} row(s) from memories_fts (non-seed)`)
  } catch (e) {
    console.log(`[wipe]   memories_fts cleanup skipped: ${e.message.slice(0, 80)}`)
  }

  // Unlink vault files that point at non-seed memories
  try {
    const r3 = db.prepare(`
      UPDATE vault_files SET linked_memory_id = NULL
      WHERE linked_memory_id IS NOT NULL
      AND linked_memory_id NOT IN (SELECT id FROM memories WHERE source = 'project_seed')
    `).run()
    if (r3.changes > 0) console.log(`[wipe]   unlinked ${r3.changes} vault file(s)`)
  } catch {
    // vault_files may not exist
  }

  // Delete non-seed memories
  const r4 = db.prepare("DELETE FROM memories WHERE source != 'project_seed'").run()
  console.log(`[wipe]   deleted ${r4.changes} row(s) from memories`)

} finally {
  db.pragma('foreign_keys = ON')
}

// ── Step 3: VACUUM ────────────────────────────────────────────────────────────

db.exec('VACUUM')
console.log(`[wipe] VACUUM complete`)

// ── Step 4: Verify ────────────────────────────────────────────────────────────

const afterTotal = db.prepare('SELECT COUNT(*) as n FROM memories').get().n
const afterRel   = db.prepare('SELECT COUNT(*) as n FROM memory_relationships').get().n
const bySource   = db.prepare('SELECT source, COUNT(*) as n FROM memories GROUP BY source').all()

console.log(`\n[wipe] After:`)
console.log(`[wipe]   memories:             ${afterTotal}`)
console.log(`[wipe]   memory_relationships: ${afterRel}`)
console.log(`[wipe]   by source:            ${JSON.stringify(bySource)}`)

let ok = true
if (afterTotal !== seedMem) {
  console.error(`[wipe] FAIL: expected ${seedMem} memories, got ${afterTotal}`)
  ok = false
}
if (bySource.length !== 1 || bySource[0].source !== 'project_seed') {
  console.error(`[wipe] FAIL: unexpected sources in memories table`)
  ok = false
}

if (ok) {
  console.log(`\n[wipe] PASS — ${afterTotal} project_seed memories preserved, everything else gone.`)
  console.log(`[wipe] Edges will rebuild automatically when Cortex next starts.`)
}

db.close()
if (!ok) process.exit(1)
