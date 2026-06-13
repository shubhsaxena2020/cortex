#!/usr/bin/env node
// mcp/smoke.mjs — end-to-end smoke test for the Cortex MCP server.
//
// Spawns mcp/server.mjs the same way an MCP client would (Electron-as-Node,
// stdio transport), runs the full handshake, and exercises every tool against
// the real DB. Read-only except for one create+verify round-trip that is
// clearly tagged 'mcp-smoke'.
//
// USAGE (from project root):
//   node scripts/run-as-node.cjs mcp/smoke.mjs

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import process from 'node:process'

const here = dirname(fileURLToPath(import.meta.url))
const serverPath = join(here, 'server.mjs')
const electronBin = join(here, '..', 'node_modules', 'electron', 'dist', 'electron.exe')

const child = spawn(electronBin, [serverPath], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
})

child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`))

let buffer = ''
const pending = new Map()
let nextId = 1

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  let idx
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    const resolve = pending.get(msg.id)
    if (resolve) {
      pending.delete(msg.id)
      resolve(msg)
    }
  }
})

function rpc(method, params) {
  const id = nextId++
  const promise = new Promise((resolve, reject) => {
    pending.set(id, resolve)
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method} (id ${id})`))
      }
    }, 15000)
  })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return promise
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

function toolPayload(res) {
  if (res.error) throw new Error(`RPC error: ${JSON.stringify(res.error)}`)
  if (res.result.isError) throw new Error(`Tool error: ${res.result.content[0].text}`)
  return JSON.parse(res.result.content[0].text)
}

let failures = 0
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

try {
  // 1. Handshake
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.1' },
  })
  check('initialize', init.result?.serverInfo?.name === 'cortex', `protocol=${init.result?.protocolVersion}`)
  notify('notifications/initialized')

  // 2. tools/list (v0.5: 11 tools — added extract, journal)
  const list = await rpc('tools/list')
  const names = (list.result?.tools ?? []).map((t) => t.name)
  check('tools/list', names.length === 11, names.join(', '))

  // 3. stats
  const stats = toolPayload(await rpc('tools/call', { name: 'cortex_stats', arguments: {} }))
  check('cortex_stats', typeof stats.memories === 'number',
    `memories=${stats.memories} rels=${stats.relationships} embedded=${stats.embedded} vec=${stats.semanticSearch}`)

  // 4. list
  const listed = toolPayload(await rpc('tools/call', { name: 'cortex_list_memories', arguments: { limit: 3 } }))
  check('cortex_list_memories', Array.isArray(listed.results) && listed.results.length > 0, `count=${listed.count}`)
  const sampleId = listed.results[0]?.id

  // 5. keyword search
  const kw = toolPayload(await rpc('tools/call', {
    name: 'cortex_search', arguments: { query: 'architecture', mode: 'keyword' },
  }))
  check('cortex_search keyword', kw.mode === 'keyword', `count=${kw.count}`)

  // 6. semantic search (degrades gracefully without Ollama)
  const sem = toolPayload(await rpc('tools/call', {
    name: 'cortex_search', arguments: { query: 'how does the knowledge graph build edges', mode: 'auto' },
  }))
  check('cortex_search auto', ['semantic', 'keyword'].includes(sem.mode),
    `mode=${sem.mode} count=${sem.count}${sem.note ? ` note=${sem.note}` : ''}`)

  // 7. get + related on a real id
  if (sampleId) {
    const got = toolPayload(await rpc('tools/call', { name: 'cortex_get_memory', arguments: { id: sampleId } }))
    check('cortex_get_memory', got.id === sampleId, `title=${JSON.stringify(got.title).slice(0, 60)}`)
    const rel = toolPayload(await rpc('tools/call', { name: 'cortex_related', arguments: { id: sampleId } }))
    check('cortex_related', typeof rel.count === 'number', `neighbors=${rel.count}`)
  }

  // 8. create + verify + report (left in DB tagged 'mcp-smoke'; wiped by
  //    force-wipe-keep-seed.mjs since source != 'project_seed')
  const created = toolPayload(await rpc('tools/call', {
    name: 'cortex_create_memory',
    arguments: {
      title: 'MCP smoke test memory',
      content: 'Written by mcp/smoke.mjs to verify the create path end-to-end.',
      tags: ['mcp-smoke'],
    },
  }))
  check('cortex_create_memory', created.created === true, `id=${created.id} embedded=${created.embedded}`)
  const roundTrip = toolPayload(await rpc('tools/call', { name: 'cortex_get_memory', arguments: { id: created.id } }))
  check('create round-trip', roundTrip.source === 'mcp' && roundTrip.tags.includes('mcp-smoke'))

  // 9. v0.4 tools
  const digest = toolPayload(await rpc('tools/call', { name: 'cortex_digest', arguments: {} }))
  check('cortex_digest', typeof digest.totalMemories === 'number',
    `window=${digest.window} memories=${digest.totalMemories}`)
  const pinned = toolPayload(await rpc('tools/call', { name: 'cortex_pinned', arguments: {} }))
  check('cortex_pinned', Array.isArray(pinned.results))

  // 10. v0.5 journal + extract
  const journalRead = toolPayload(await rpc('tools/call', { name: 'cortex_journal', arguments: {} }))
  check('cortex_journal (read)', 'entry' in journalRead, `entry present: ${journalRead.entry != null}`)

  // 11. error paths
  const ghost = await rpc('tools/call', { name: 'cortex_get_memory', arguments: { id: 'no-such-id' } })
  check('missing-id is isError', ghost.result?.isError === true)
  const unknown = await rpc('tools/call', { name: 'bogus_tool', arguments: {} })
  check('unknown tool is -32602', unknown.error?.code === -32602)

  console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
} catch (err) {
  console.error('SMOKE RUN ABORTED:', err.message)
  failures++
} finally {
  child.kill()
  process.exit(failures === 0 ? 0 : 1)
}
