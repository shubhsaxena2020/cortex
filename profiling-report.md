# Cortex Search Profiling — v0.2 P0 #4

Generated: 2026-06-05T06:54:27.388Z
Dataset: **10000 memories**, 0 vectors, 0 relationships
Config: warmup=3, queries=51, semantic=false

## Verdict

- Keyword p95: **86.58 ms** ✅ under 200ms target


## Keyword path

| Metric | Value (ms) |
|---|---|
| n      | 51 |
| min    | 0.02 |
| p50    | 70.72 |
| p95    | 86.58 |
| p99    | 91.43 |
| max    | 91.43 |
| mean   | 54.52 |

Breakdown (avg per query): prepare=0.071ms · execute=54.423ms · marshal=0.023ms

### By query kind

| Kind | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| common-1 | 10 | 83.79 | 91.43 | 91.43 | 91.43 |
| rare-1 | 9 | 71.47 | 74.21 | 74.21 | 74.21 |
| phrase | 15 | 70.72 | 76.67 | 76.67 | 76.67 |
| long | 6 | 0.20 | 3.59 | 3.59 | 3.59 |
| special | 4 | 0.03 | 0.04 | 0.04 | 0.04 |
| empty | 2 | 0.67 | 0.67 | 0.67 | 0.67 |
| filtered | 3 | 82.75 | 83.90 | 83.90 | 83.90 |
| tagged | 2 | 89.67 | 89.67 | 89.67 | 89.67 |



## Top bottlenecks

### 1. LIKE-based keyword search will not scale past 50k rows

**Evidence:** current size=10000; LIKE is O(n·content_len). Target is met today but extrapolation to 50k crosses 200ms.

**Fix:** Pre-emptive migration to FTS5 MATCH on fts_memories. Schema already exists; just swap the SELECT in searchMemories.

### 2. Tags stored as JSON string limit query options

**Evidence:** No structural index on tags; queries cannot use index for tag filtering today.

**Fix:** Normalise tags into a memory_tags table for fast tag-scoped lookup and aggregate UIs.

### 3. ORDER BY updatedAt without an index

**Evidence:** No idx on memories.updatedAt; SQLite sorts the matching row set in memory after the LIKE scan.

**Fix:** CREATE INDEX idx_memories_updated ON memories(updatedAt DESC). Small index, big benefit on filter+sort combos and on /api/recent.


## Recommended order of attack

1. **FTS5 swap** in `searchMemories` — biggest single win, zero schema migration, table already exists.
2. **Compound index** on `memories(updatedAt DESC)` — cheap, helps every filter+sort path including `/api/recent`.
3. **Normalise tags** to a join table — unblocks tag-scoped UIs and removes the JSON-LIKE hack.

## Reproduce

```bash
# seed
npm run seed-10k                 # 10k synthetic rows
npm run seed-10k -- --embed      # + embeddings (slow, ~10-15 min)

# profile
npm run profile-search           # keyword only
npm run profile-search -- --semantic   # also semantic
```

Raw samples: `profiling-results.json`
