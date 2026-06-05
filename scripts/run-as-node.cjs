#!/usr/bin/env node
// Tiny cross-platform launcher: runs the given script under Electron's
// bundled Node so native modules (better-sqlite3, sqlite-vec) built against
// Electron's NODE_MODULE_VERSION can be loaded outside the app.
//
// Why this exists: npm scripts can't portably set env vars across cmd/sh.
// `cross-env` would work but adding a dev dep just to set ONE flag is silly.

const { spawnSync } = require('child_process')
const electron = require('electron')

const [, , script, ...rest] = process.argv
if (!script) {
  console.error('usage: node scripts/run-as-node.cjs <script.mjs> [args...]')
  process.exit(2)
}

const res = spawnSync(electron, [script, ...rest], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
process.exit(res.status ?? 1)
