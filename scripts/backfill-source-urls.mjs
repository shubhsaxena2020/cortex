#!/usr/bin/env node
// scripts/backfill-source-urls.mjs
//
// One-shot migration helper for v0.2 P0 #1 (conversation dedup).
//
// PROBLEM
//   Memories captured in v0.1.x did NOT persist the source URL to the DB —
//   the URL only lived in the vault file's YAML frontmatter. The v0.2 dedup
//   pipeline keys on `memories.url`, so legacy rows need that field filled
//   in or they'll never dedup against future captures.
//
// HOW
//   1. Open the live cortex DB at %APPDATA%\Cortex\memories.db
//   2. Open the vault config to find the AI Conversations folder.
//   3. For every .md file under AI Conversations\**:
//        - Parse the YAML frontmatter (using the same parser the app uses,
//          src/main/frontmatter.ts is the canonical implementation — we
//          re-implement the line-oriented parser here because this script
//          must run with plain Node + better-sqlite3, no Electron context
//          and no .ts transpiler).
//        - Canonicalise the URL (same rules as src/main/url-canon.ts).
//        - Find the matching memory by reconstructing the expected filename
//          (date-slug.md from the memory's title + created_at) OR by matching
//          on title alone.
//        - UPDATE memories SET url = ? WHERE id = ? AND url IS NULL.
//   4. Report counts.
//
// USAGE
//   node scripts/backfill-source-urls.mjs --dry-run     # report only, no writes
//   node scripts/backfill-source-urls.mjs               # actually write
//   node scripts/backfill-source-urls.mjs --db <path>   # override DB path
//   node scripts/backfill-source-urls.mjs --vault <path># override vault path
//
// SAFETY
//   - Only updates rows where url IS NULL (idempotent; never overwrites).
//   - Wrapped in a single transaction; rolls back on any error.
//   - Dry-run is the default-safe option for the first invocation.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const dbArg = args[args.indexOf('--db') + 1]
const vaultArg = args[args.indexOf('--vault') + 1]

// ── 1. Locate DB + vault ──────────────────────────────────────────────────────

const APPDATA = process.env.APPDATA || ''
const dbPath = (args.includes('--db') && dbArg) || join(APPDATA, 'Cortex', 'memories.db')
const vaultConfigPath = join(APPDATA, 'Cortex', 'vault-config.json')

if (!existsSync(dbPath)) {
  console.error(`[backfill] DB not found: ${dbPath}`)
  console.error(`[backfill] Pass --db <path> to override.`)
  process.exit(1)
}

let vaultPath = (args.includes('--vault') && vaultArg) || null
if (!vaultPath) {
  if (!existsSync(vaultConfigPath)) {
    console.error(`[backfill] No vault config at ${vaultConfigPath} — pass --vault <path>.`)
    process.exit(1)
  }
  try {
    const cfg = JSON.parse(readFileSync(vaultConfigPath, 'utf8'))
    vaultPath = cfg.vaultPath
  } catch (e) {
    console.error(`[backfill] Bad vault config: ${e.message}`)
    process.exit(1)
  }
}

const conversationsRoot = join(vaultPath, 'AI Conversations')
if (!existsSync(conversationsRoot)) {
  console.error(`[backfill] No AI Conversations folder at ${conversationsRoot}`)
  process.exit(1)
}

console.log(`[backfill] DB:    ${dbPath}`)
console.log(`[backfill] Vault: ${vaultPath}`)
console.log(`[backfill] Mode:  ${DRY_RUN ? 'DRY-RUN (no writes)' : 'WRITE'}`)
console.log('')

// ── 2. Lazy-import better-sqlite3 (after path check) ──────────────────────────

let Database
try {
  Database = (await import('better-sqlite3')).default
} catch (e) {
  console.error(`[backfill] Failed to load better-sqlite3: ${e.message}`)
  console.error(`[backfill] Run from the project root (npm i must be done).`)
  process.exit(1)
}

const db = new Database(dbPath)

// Verify schema is at v2 (the version that added memories.url).
const ver = db.prepare('SELECT version FROM schema_version').get()
if (!ver || ver.version < 2) {
  console.error(`[backfill] DB schema version is ${ver ? ver.version : 'missing'}; need >= 2.`)
  console.error(`[backfill] Launch the Cortex app once to run the migration, then re-run this script.`)
  process.exit(1)
}

// Verify the url column actually exists (defensive — schema bump + column add should be atomic).
const cols = db.prepare(`PRAGMA table_info(memories)`).all()
if (!cols.some(c => c.name === 'url')) {
  console.error(`[backfill] memories table has no url column. Migration may have failed.`)
  process.exit(1)
}

// ── 3. Frontmatter parser (line-oriented, mirrors src/main/frontmatter.ts) ──

function parseFrontmatter(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const normalised = text.replace(/\r\n?/g, '\n')
  const body = normalised.startsWith('﻿') ? normalised.slice(1) : normalised
  if (!body.startsWith('---')) return null
  const firstNewline = body.indexOf('\n')
  if (firstNewline === -1) return null
  if (body.slice(0, firstNewline).trim() !== '---') return null
  const rest = body.slice(firstNewline + 1)
  const closingMatch = /\n---\s*(\n|$)/.exec(rest)
  if (!closingMatch) return null
  const block = rest.slice(0, closingMatch.index)
  const fields = {}
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    if (key === '') continue
    let value = line.slice(colonIdx + 1).trim()
    const commentIdx = value.indexOf(' # ')
    if (commentIdx !== -1) value = value.slice(0, commentIdx).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) value = value.slice(1, -1)
    fields[key] = value
  }
  return fields
}

// ── 4. URL canonicaliser (mirrors src/main/url-canon.ts) ─────────────────────

const TRACKING = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^msclkid$/i, /^ref$/i, /^ref_src$/i, /^_ga$/i, /^mc_(cid|eid)$/i]
function canonicalUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') return null
  let p
  try { p = new URL(input.trim()) } catch { return null }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return null
  const cleanParams = []
  for (const [k, v] of p.searchParams.entries()) {
    if (!TRACKING.some(re => re.test(k))) cleanParams.push([k, v])
  }
  cleanParams.sort(([a], [b]) => a.localeCompare(b))
  let path = p.pathname.replace(/\/{2,}/g, '/')
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  const query = cleanParams.length === 0
    ? ''
    : '?' + cleanParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  return `${p.protocol}//${p.hostname.toLowerCase()}${path}${query}`
}

// ── 5. Filename slug helper (mirrors src/main/index.ts saveConversationToVault) ──

function expectedFilename(memory) {
  const date = memory.timestamp ? new Date(memory.timestamp).toISOString().slice(0, 10) : '1970-01-01'
  const slug = (memory.title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50)
  return `${date}-${slug || 'untitled'}.md`
}

// ── 6. Walk vault, build URL index keyed by filename ─────────────────────────

function walkMd(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walkMd(full))
    else if (st.isFile() && entry.toLowerCase().endsWith('.md')) out.push(full)
  }
  return out
}

const files = walkMd(conversationsRoot)
console.log(`[backfill] Found ${files.length} .md file(s) under AI Conversations/`)

const urlByFilename = new Map()  // expected filename → canonical URL
let filesWithUrl = 0
let filesWithoutUrl = 0

for (const filepath of files) {
  let raw
  try { raw = readFileSync(filepath, 'utf8') } catch { continue }
  const fm = parseFrontmatter(raw)
  if (!fm) { filesWithoutUrl++; continue }
  const canon = canonicalUrl(fm.url)
  if (!canon) { filesWithoutUrl++; continue }
  const base = filepath.split(/[/\\]/).pop()
  urlByFilename.set(base, canon)
  filesWithUrl++
}

console.log(`[backfill]   ${filesWithUrl} file(s) have a parseable URL`)
console.log(`[backfill]   ${filesWithoutUrl} file(s) have no URL (or no frontmatter)`)
console.log('')

// ── 7. Iterate memories, try to match each to a file, plan updates ───────────

const memories = db.prepare('SELECT id, title, timestamp, source, url FROM memories').all()
let alreadyHad = 0
let plannedUpdates = 0
let unmatched = 0
const updates = []

for (const m of memories) {
  if (m.url) { alreadyHad++; continue }
  const fname = expectedFilename(m)
  const canon = urlByFilename.get(fname)
  if (canon) {
    plannedUpdates++
    updates.push({ id: m.id, title: m.title, url: canon, filename: fname })
  } else {
    unmatched++
  }
}

console.log(`[backfill] Memories in DB:          ${memories.length}`)
console.log(`[backfill]   already had a url:     ${alreadyHad}`)
console.log(`[backfill]   matched a vault file:  ${plannedUpdates}  ← will be backfilled`)
console.log(`[backfill]   no file match:         ${unmatched}      ← skipped (manual review)`)
console.log('')

// ── 8. Apply or dry-run-print ────────────────────────────────────────────────

if (updates.length === 0) {
  console.log(`[backfill] Nothing to do. Exiting.`)
  process.exit(0)
}

if (DRY_RUN) {
  console.log(`[backfill] DRY-RUN — first 10 updates that WOULD be applied:`)
  for (const u of updates.slice(0, 10)) {
    console.log(`  ${u.id.slice(0, 8)}…  ${u.url}`)
    console.log(`     title: ${u.title.slice(0, 60)}`)
    console.log(`     file:  ${u.filename}`)
  }
  if (updates.length > 10) console.log(`  … and ${updates.length - 10} more`)
  console.log('')
  console.log(`[backfill] Re-run without --dry-run to apply.`)
  process.exit(0)
}

const stmt = db.prepare('UPDATE memories SET url = ? WHERE id = ? AND url IS NULL')
const tx = db.transaction(() => {
  let applied = 0
  for (const u of updates) {
    const r = stmt.run(u.url, u.id)
    if (r.changes > 0) applied++
  }
  return applied
})

const applied = tx()
console.log(`[backfill] Applied ${applied} update(s) in one transaction. Done.`)
process.exit(0)
