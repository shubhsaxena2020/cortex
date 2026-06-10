// Regression test for the invisible-edges bug: mapRelationship() in db.ts
// dropped `strength` and `signal_type`, so toRelationship() in the IPC layer
// re-filled them with defaults (0 / 'manual'). The renderer then filtered
// every auto-edge via the `strength < 0.2` rule and colored survivors gray.
//
// Real better-sqlite3 can't run in vitest (ABI mismatch — see
// db.migration-ordering.test.ts), so this asserts the mapping structurally
// against the source of truth.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DB_SOURCE = readFileSync(join(__dirname, 'db.ts'), 'utf8')

function extractMapRelationship(src: string): string {
  const match = /function mapRelationship\([\s\S]*?\n\}/.exec(src)
  if (!match) throw new Error('Could not locate mapRelationship in db.ts')
  return match[0]
}

describe('db.ts mapRelationship (regression: edges rendered gray manual/0)', () => {
  const fn = extractMapRelationship(DB_SOURCE)

  it('passes strength through to the API shape', () => {
    expect(fn).toMatch(/strength:\s*r\.strength/)
  })

  it('passes signal_type through to the API shape', () => {
    expect(fn).toMatch(/signal_type:\s*r\.signal_type/)
  })

  it('still maps the core identity fields', () => {
    for (const field of ['id', 'sourceId', 'targetId', 'relationship']) {
      expect(fn).toContain(`${field}: r.${field}`)
    }
  })
})
