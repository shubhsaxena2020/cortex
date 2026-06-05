# Obsidian → Cortex Graph Gap Analysis

> Compares the patterns in `OBSIDIAN-GRAPH-PATTERNS.md` against Cortex's current
> graph. Cortex sources: `src/renderer/src/utils/graph-renderer.ts`,
> `graph-interaction.ts`, `workers/force-simulation.worker.ts`,
> `components/GraphCanvas.tsx`.
>
> Caveat: Obsidian uses a custom force engine + WebGL; Cortex uses `d3-force` +
> 2D canvas. Physics values are adapted (closest-feel), not copied 1:1. Visual
> formulas (radius, label fade, alpha) port exactly.

## Physics

| Param | Obsidian | Cortex (before) | Match? | Action |
|-------|----------|------------------|--------|--------|
| linkDistance | 250 | 50 | ❌ far too tight | **Adopt 250** (Obsidian's open, airy layout) |
| linkStrength | 1 | 0.7 | ~ | **Adopt 1** |
| repel/charge | repelStrength 10 (custom units) | `forceManyBody(-180)` | n/a units | Keep, retune for the larger linkDistance |
| center | centerStrength 0.1 | `forceCenter` + `forceX/Y(0.04)` | ~ | Keep (forceX/Y gives the same centering pull) |
| collide | (implicit in repel) | `forceCollide(nodeRadius+3)` | ✅ extra | Keep — prevents overlap at the bigger radii |

**Effort:** trivial (4 numbers in the worker). **Risk:** layout spreads out —
verify it doesn't drift off-viewport.

## Node rendering

| Pattern | Obsidian | Cortex (before) | Match? | Action |
|---------|----------|------------------|--------|--------|
| radius formula | `clamp(3·√(deg+1), 8, 30)` | `min(3 + log2(1+deg)·1.6, 14)` | ❌ | **Adopt Obsidian formula** |
| radius range | 8–30 px | 3–14 px | ❌ smaller | comes with the formula |
| zoom scale | `√(1/zoom)` (grow when zoomed out) | none (nodes shrink) | ❌ **signature gap** | **Add `√(1/zoom)` draw scaling** |

**Effort:** low. **Impact:** high — the `√(1/zoom)` scaling is the single most
recognisable Obsidian behaviour (nodes never vanish into points at far zoom).

## Labels

| Pattern | Obsidian | Cortex (before) | Match? | Action |
|---------|----------|------------------|--------|--------|
| fade curve | `clamp(log2(zoom)+1−textFade, 0, 1)` | smoothstep over [0.6, 1.4] | ❌ different | **Adopt Obsidian log2 ramp** |
| off below | zoom 0.5 | zoom 0.6 | close | falls out of the new formula |
| full at | zoom 1.0 | zoom 1.4 | ❌ | new formula → full at 1.0 |
| tunable | `textFadeMultiplier` slider | hardcoded | ❌ | expose later (medium-pri settings panel) |

**Effort:** trivial (rewrite one function). **Risk:** none.

## Interaction (hover/dim)

| Pattern | Obsidian | Cortex (before) | Match? | Action |
|---------|----------|------------------|--------|--------|
| dim alpha | **0.2** | 0.37 (`5e`) | ❌ | **Adopt 0.2** |
| neighbour test | 1-hop fwd+rev adjacency | 1-hop `highlightPath` set | ✅ | already matches |
| hovered alpha | 1.0 + 15px glow | 1.0 + glow ring | ✅ | already matches |
| transition | ease `cur·0.9 + tgt·0.1`/frame | instant (no ease) | ❌ | nice-to-have; canvas redraw-on-demand makes per-frame easing awkward — **defer** |

**Effort:** trivial for the alpha. The per-frame easing is a bigger change
(Cortex only redraws on demand, not every frame) — deferred, documented.

## Edges

| Pattern | Obsidian | Cortex (before) | Match? | Action |
|---------|----------|------------------|--------|--------|
| width | `lineSize/zoom` (screen-constant) | `widthPx/zoom` (screen-constant) | ✅ | already matches |
| arrows | off by default | none | ✅ | matches (Obsidian default is no arrows) |
| opacity | dims with node fade | dim/normal/highlight buckets | ✅ ~ | matches in spirit |

**Effort:** none — Cortex already matches Obsidian's edge defaults.

## Performance

| | Obsidian | Cortex |
|-|----------|--------|
| physics thread | **main thread** (can stutter on big graphs) | **Web Worker** (off main thread) |
| renderer | WebGL/PIXI | 2D canvas + quadtree cull |

Cortex keeps its structural advantage: physics never blocks the UI thread.

## Shipped this session (HIGH priority) — verified live

1. ✅ **Physics:** linkDistance 50→**250**, linkStrength 0.7→**1**, charge −180→−400
   (d3 n-body units; scaled up so the wider rest-length doesn't collapse).
   Verified: graph renders, central cluster + orphan ring, non-bg px 6,603→19,284.
2. ✅ **Node radius:** `clamp(3·√(deg+1), 8, 30)` (Obsidian exact). Bigger, √-scaled.
3. ✅ **Label fade:** `clamp(log2(zoom)+1, 0, 1)` (Obsidian exact); off at 0.5, full at 1.0.
4. ✅ **Hover dim alpha:** 0.37 → **0.2** (Obsidian `fQ` exact). The new 8–30px radii
   keep dimmed nodes readable at 20% (the reason the earlier 0.13→0.37 bump is no
   longer needed).
5. ✅ **Edges:** already matched Obsidian (screen-constant width, no arrows) — no change.

## Deferred (documented, NOT shipped — honest status)

- ❌ **Node zoom-scale `√(1/zoom)`** — the one HIGH item I did *not* ship. Obsidian
  draws in screen space with a separate `nodeScale`; Cortex draws in sim space
  (`ctx.scale(k)` then sim-radius), so matching it requires sim-radius `R·k^-1.5`,
  which **explodes the quadtree hit-test envelope at low zoom** (e.g. ~2,700 sim
  units at zoom 0.05) and would slow `getNodeAtPoint` on every mousemove. The
  larger 8–30px radii already recover most of the "nodes stay visible zoomed out"
  benefit. Revisit with a *bounded, draw-only* scale (cap ~3×) if far-zoom dots
  still read as too small.
- Per-frame alpha easing (`mQ`) — Cortex redraws on demand, not every frame; would
  need a continuous RAF. Revisit if hover transitions feel abrupt.
- In-graph settings panel (Obsidian's cog → sliders for nodeSizeMultiplier /
  textFadeMultiplier / forces). Medium priority, not attempted this session.
