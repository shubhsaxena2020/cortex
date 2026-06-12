#!/usr/bin/env node
// scripts/cortex-dump.mjs
//
// Dumps Cortex memories to stdout in a format ready to paste into any Claude
// chat session as context. Supports optional keyword search.
//
// USAGE (from project root):
//   node scripts/run-as-node.cjs scripts/cortex-dump.mjs            # all memories
//   node scripts/run-as-node.cjs scripts/cortex-dump.mjs "auto-edges"  # keyword search
//   node scripts/run-as-node.cjs scripts/cortex-dump.mjs --tags "bug,p1"  # tag filter

import { existsSync } from 'node:fs'
import process from 'node:process'

const DB_PATH = `${process.env.APPDATA}\\Cortex\\memories.db`
if (!existsSync(DB_PATH)) { console.error('DB not found:', DB_PATH); process.exit(1) }

const Database = (await import('better-sqlite3')).default
const db = new Database(DB_PATH, { readonly: true })

// Parse args
const args = process.argv.slice(2)
const tagsIdx = args.indexOf('--tags')
const filterTags = tagsIdx !== -1 ? args[tagsIdx + 1].split(',').map(t => t.trim()) : []
const keyword = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--tags') ?? null

let rows

if (keyword) {
  // FTS5 keyword search — use memories_fts, join on memory_id (not rowid)
  const phrase = `"${keyword.trim().replace(/"/g, '""')}"`
  try {
    rows = db.prepare(`
      SELECT m.* FROM memories m
      JOIN memories_fts f ON f.memory_id = m.id
      WHERE memories_fts MATCH ?
      ORDER BY m.updatedAt DESC
    `).all(phrase)
  } catch {
    // Fall back to LIKE on parse error
    rows = db.prepare(
      "SELECT * FROM memories WHERE title LIKE ? OR content LIKE ? ORDER BY updatedAt DESC"
    ).all(`%${keyword}%`, `%${keyword}%`)
  }
} else if (filterTags.length > 0) {
  let sql = 'SELECT * FROM memories WHERE 1=1'
  const params = []
  for (const t of filterTags) { sql += ` AND tags LIKE ?`; params.push(`%"${t}"%`) }
  sql += ' ORDER BY updatedAt DESC'
  rows = db.prepare(sql).all(...params)
} else {
  rows = db.prepare('SELECT * FROM memories ORDER BY updatedAt DESC').all()
}

// Output
const label = keyword ? `CORTEX SEARCH: "${keyword}"` : filterTags.length ? `CORTEX TAG FILTER: ${filterTags.join(', ')}` : 'CORTEX PROJECT MEMORIES'
console.log(`\n${'='.repeat(64)}`)
console.log(label)
console.log(`DB: ${DB_PATH}`)
console.log(`${'='.repeat(64)}\n`)

if (rows.length === 0) {
  console.log('No matching memories found.')
} else {
  rows.forEach((r, i) => {
    const tags = JSON.parse(r.tags || '[]').join(', ')
    console.log(`[${i + 1}/${rows.length}] ${r.title}`)
    console.log(`Source: ${r.source} | Tags: ${tags || '(none)'}`)
    console.log(r.content)
    console.log()
  })
}

console.log(`${'='.repeat(64)}`)
console.log(`Total: ${rows.length} memor${rows.length === 1 ? 'y' : 'ies'}`)
console.log(`${'='.repeat(64)}\n`)

db.close()
