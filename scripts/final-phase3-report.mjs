// Phase 3 final reporter — runs both test suites, aggregates results,
// writes FINAL_PHASE3_REPORT.md.
//
// Run:  node scripts/final-phase3-report.mjs

import { writeFileSync } from 'node:fs'
import { run as runSmoke } from './api-smoke-tests.mjs'
import { run as runIntegration } from './integration-tests.mjs'

console.log('\n═══ Phase 3 — final report ═══\n')

console.log('▸ Running api-smoke-tests…')
const smoke = await runSmoke().catch(e => ({ name: 'api-smoke', error: e.message, results: [], passed: 0, failed: 0 }))
console.log(`  ${smoke.passed} passed, ${smoke.failed} failed${smoke.error ? `  (SUITE ERROR: ${smoke.error})` : ''}`)

console.log('\n▸ Running integration-tests…')
const integ = await runIntegration().catch(e => ({ name: 'integration', error: e.message, results: [], passed: 0, failed: 0 }))
console.log(`  ${integ.passed} passed, ${integ.failed} failed${integ.error ? `  (SUITE ERROR: ${integ.error})` : ''}`)

const totalPass = smoke.passed + integ.passed
const totalFail = smoke.failed + integ.failed
const suiteErrors = (smoke.error ? 1 : 0) + (integ.error ? 1 : 0)
const allGreen = totalFail === 0 && suiteErrors === 0

const status = allGreen ? 'COMPLETE' : 'NEEDS FIXES'
const statusEmoji = allGreen ? '🚀' : '⚠️'

function renderSuite(suite) {
  if (suite.error) {
    return `### ${suite.name}

**Suite did not run** — ${suite.error}
`
  }
  let md = `### ${suite.name}

**${suite.passed}/${suite.passed + suite.failed} passed**

`
  for (const r of suite.results) {
    md += `- ${r.ok ? '✅' : '❌'} **${r.name}**`
    if (r.detail) md += `  \n  _${r.detail}_`
    md += '\n'
  }
  return md
}

const ts = new Date().toISOString()
const report = `# Phase 3 — Automated Integration Test Report

_Generated: ${ts}_

## ${statusEmoji} Phase 3 status: ${status}

**Totals: ${totalPass} passed, ${totalFail} failed${suiteErrors ? `, ${suiteErrors} suite(s) errored` : ''}**

---

## ✅ Features under test

- \`sqlite-vec\` extension loads inside Electron's main process
- Ollama client (\`src/main/embeddings.ts\`) reaches \`http://127.0.0.1:11434/api/embed\`
- \`memory_vectors\` virtual table stores 384-dim Float32 vectors for each memory
- POST \`/api/memories\` triggers a fire-and-forget embedding write (no client-visible latency)
- GET \`/api/related\` performs vector KNN via sqlite-vec, returns semantically-ranked results
- Graceful fallback to keyword extraction when Ollama is unreachable or embeddings empty
- Existing endpoints (\`/health\`, \`/api/search\`, \`/api/recent\`) untouched and still pass smoke tests

---

## 📊 Test results

${renderSuite(smoke)}
${renderSuite(integ)}
---

## How these tests run

- They open the **same** \`memories.db\` the running app uses (WAL mode allows concurrent reads/writes).
- Test memories are tagged with \`[TEST-PHASE3]\` / \`[TEST-SMOKE]\` prefixes and removed at the end of each run.
- Pre-cleanup also removes leftover \`[TEST-PHASE3]\` rows from any previous crashed run.
- Tests hit the live HTTP API at the port from \`extension-config.json\`.

## Common causes of failure

- **Suite errored "extension-config.json missing"** → start the app: \`npm run dev\`
- **Suite errored "app unreachable"** → app crashed; check the dev terminal
- **"All 5 memories have vector embeddings stored" failed** → either:
  - Ollama isn't running (\`ollama serve\` or launch Ollama desktop)
  - \`all-minilm\` model not pulled (\`ollama pull all-minilm\`)
  - \`sqlite-vec\` npm package not installed in test process (run \`npm install sqlite-vec\`)
- **Semantic ranking tests fail** → embeddings landed but Ollama returned dim-mismatched vectors; check that \`CORTEX_EMBED_MODEL\` (if set) is 384-dim
${allGreen ? '\n## 🎉 Notes\n\nAll suites green. Phase 3 is functionally complete — vector search works end-to-end.\n' : ''}
`

writeFileSync('FINAL_PHASE3_REPORT.md', report, 'utf8')
console.log('\n▸ Wrote FINAL_PHASE3_REPORT.md')
console.log(`\n═══ Final: ${totalPass} passed, ${totalFail} failed ═══\n`)
process.exit(allGreen ? 0 : 1)
