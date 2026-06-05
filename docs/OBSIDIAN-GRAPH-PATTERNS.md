# Obsidian Graph Patterns (extracted from source)

> Reverse-engineered from the bundled, **minified** renderer in Obsidian's
> `obsidian.asar` → `app.js` (version hint `1.4.3`, installed at
> `C:\Program Files\Obsidian`). Byte offsets into `app.js` are given for
> traceability. Symbol names are the minifier's (`fQ`, `mQ`, `SJ`, `IJ`, …);
> the human names are inferred from adjacent strings and the settings UI.
>
> **Key structural fact:** Obsidian's graph does **not** use `d3-force`. There
> is zero `forceSimulation`/`forceLink`/`forceManyBody` in the bundle. It ships
> a **custom force engine** + a **WebGL (PIXI) renderer**. So the physics
> numbers below are Obsidian's own units and map only *conceptually* onto
> Cortex's `d3-force` setup — they are not drop-in d3 values.

## Physics — force defaults

From the forces-settings defaults object `IJ` (@2568761):

```js
IJ = { centerStrength: SJ(.1,.01), repelStrength: 10, linkStrength: SJ(1,.01), linkDistance: 250 }
```

| Force            | Default (UI value) | Notes |
|------------------|--------------------|-------|
| `centerStrength` | **0.1**            | pull toward graph center |
| `repelStrength`  | **10**             | n-body repulsion (charge analogue) |
| `linkStrength`   | **1**              | edge spring stiffness |
| `linkDistance`   | **250**            | edge rest length (px) — **much larger than d3's ~30** |

The slider transform (@2549401) maps a UI value to an internal coefficient:

```js
SJ = (e, t) => 1 - Math.log(e*(1-t)+t) / Math.log(t)   // e = display value, t = step/min
```

So `centerStrength` and `linkStrength` are passed through `SJ` (log-shaped
slider response); `repelStrength` and `linkDistance` are used raw.

## Render options — defaults

Display-settings defaults (@2567034):

```js
{ showArrow: false, textFadeMultiplier: 0, nodeSizeMultiplier: 1, lineSizeMultiplier: 1 }
```

| Option               | Default | Meaning |
|----------------------|---------|---------|
| `nodeSizeMultiplier` | **1**   | scales node radius |
| `lineSizeMultiplier` | **1**   | scales edge width |
| `textFadeMultiplier` | **0**   | shifts the label-fade zoom threshold |
| `showArrow`          | **false** | **no directional arrows by default** |

## Node rendering

**Radius formula** (@2215514) — `weight` is the node's degree (link count):

```js
radius = fNodeSizeMult * Math.max(8, Math.min(3 * Math.sqrt(weight + 1), 30))
```

- Base radius = `3·√(degree+1)`, **clamped to [8, 30] px**, times `nodeSizeMultiplier`.
- `√` scaling (not log): a 0-degree node is `3·√1 = 3 → clamped up to 8`; a
  100-degree node is `3·√101 ≈ 30 → clamped at 30`.

**Zoom compensation** (@`setScale`, ~2231600):

```js
this.scale     = zoom
this.nodeScale = Math.sqrt(1 / zoom)        // nodes grow as you zoom OUT
this.textAlpha = Math.clamp(Math.log(zoom)/Math.log(2) + 1 - fTextShowMult, 0, 1)
```

- **`nodeScale = √(1/zoom)`** is *the* reason Obsidian nodes never shrink to
  invisible specks when zoomed out — the drawn radius is multiplied by it, so
  far-zoom nodes stay readable dots.

## Labels

**Fade** (from `textAlpha` above):

```js
textAlpha = clamp( log2(zoom) + 1 - textFadeMultiplier, 0, 1 )
```

With default `textFadeMultiplier = 0`:

| zoom | log2(zoom) | textAlpha |
|------|-----------|-----------|
| 0.5  | −1        | **0** (labels gone) |
| 0.7  | −0.51     | 0.49 |
| 1.0  | 0         | **1** (full) |
| 2.0  | +1        | 1 (clamped) |

So labels fade **linearly in log2(zoom)** between zoom 0.5 (off) and 1.0 (full).
The `textFadeMultiplier` slider shifts this whole ramp left/right.

## Interaction — hover / focus dim

From the per-node render pass (@2214145) and constants (@2210786):

```js
fQ = 0.2                                   // dim alpha target for non-neighbours
mQ = (cur, target, n = 0.9) => cur*n + target*(1-n)   // per-frame easing toward target

// per node, with p = hovered node, d = (this node === hovered):
v = fQ
if (!p || d || forward[p.id] || reverse[p.id]) v = 1   // hovered, neighbours, or no-hover → full
fadeAlpha = mQ(fadeAlpha, v)               // ease current alpha toward v each frame
textAlpha *= fadeAlpha
if (d) textAlpha = 1                        // hovered node's label always full
glow = d ? 15 : 0                           // hovered node gets a 15px glow ring
```

| State                         | Alpha |
|-------------------------------|-------|
| no hover (idle)               | 1.0   |
| hovered node                  | 1.0 + 15px glow, label forced on |
| 1-hop neighbour of hovered    | 1.0   |
| everything else (dimmed)      | **0.2** |
| transition                    | exponential ease, **0.9** retain / 0.1 approach per frame |

Neighbour test uses precomputed `forward` / `reverse` adjacency maps (1-hop,
both directions).

## Edges

```js
lineWidth   = fLineSizeMult / scale          // (@2217091) screen-constant width
arrowScale  = 2 * Math.sqrt(fLineSizeMult) / scale   // (@2217816) only if showArrow
```

- Edge width is `lineSizeMultiplier / zoom` → constant in **screen** pixels
  (default multiplier 1).
- **Arrows off by default** (`showArrow = false`).

## Summary table (the numbers that matter)

| Pattern            | Obsidian value |
|--------------------|----------------|
| linkDistance       | 250 |
| linkStrength       | 1 |
| repelStrength      | 10 |
| centerStrength     | 0.1 |
| node radius        | `clamp(3·√(deg+1), 8, 30)` |
| node zoom scale    | `√(1/zoom)` |
| label fade         | `clamp(log2(zoom)+1−textFade, 0, 1)` |
| dim alpha          | **0.2** |
| hover ease         | `cur·0.9 + tgt·0.1` per frame |
| hover glow         | 15 px |
| edge width         | `1/zoom` (screen-constant) |
| arrows             | off |
