# Morph Pipeline (URL → IR → Figma / Framer / Code)

Reverse engineer a live website into a design **IR** (intermediate representation),
then rebuild it in Figma, Framer, or code. All builders consume the same IR, so
Figma is optional on the Framer and code paths.

Status: **Framer builder LIVE** (Jul 3 2026) — vscventures.com stands as a
published Framer preview, built and published headlessly via the Server API.
Capture is essentially solved. Figma builder is a working seed.

## Flow

1. **capture.mjs** — Playwright renders the URL, settles animations to their final
   state, and walks the DOM into `ir.json` (tree of nodes: box, flex/grid layout,
   fills, text runs with font specs, images, svgs).
2. **flatten.py** — collapses the IR tree into absolute-positioned paint leaves
   (`text` / `rect` / `img`) and rolls up color + font tokens, deduping Framer
   SSR responsive-variant doubles (same content, heavy overlap).
3. Builders (shared paint order via `mfOrder` in build-figma.mjs):
   - **emit-framer-calls.mjs** — renders leaves into a Framer page over the
     **Framer Server API** (`framer-api` npm, WebSocket, headless) and publishes:
     `FRAMER_API_KEY=… node emit-framer-calls.mjs <captureDir> --project <url> [--publish] [--path /p] [--dry]`
     Text styles via `createTextStyle` + `inlineTextStyle`, images upload as
     bytes from the captured assets, native web fonts resolve first with
     font-map.json as fallback.
   - **build-figma.mjs** — the body of a `use_figma` call: renders leaves into a
     Figma frame with font mapping and correct paint order (chunked by
     emit-figma-calls.mjs).
4. **headtohead.mjs** — screenshots the rebuilt URL and composes an
   original-vs-rebuild side-by-side for QA.

## Framer Server API gotchas (probed Jul 2026, do NOT relearn these)

- **Session/page binding:** node ops (createFrameNode parentId, setAttributes,
  setText) only take effect on a page CREATED in the same connection. Against a
  pre-existing page they silently misroute (nodes land on the Home page, attrs
  return null). navigateTo/zoomIntoView are blocked in api mode; setSelection
  doesn't switch pages. So the builder deletes + recreates its page every run.
- **setText ordering:** passing a freshly-created inlineTextStyle at
  createTextNode time silently clobbers setText (reads back empty, publishes
  nothing). Create → setText → setAttributes({inlineTextStyle}).
- **publish():** publishes and returns live hostnames itself; deploy() is only
  for re-promoting old deployments (returns [] here). The CDN serves the
  previous deploy until optimizationStatus flips to "optimized".
- **Page height:** pages publish at the breakpoint frame's fixed height —
  absolute children don't grow flow and 'fit-content' no-ops. Pin the
  breakpoint height explicitly (works on a same-connection page).
- **Stacking:** later-created siblings render on top (verified with overlap
  probe) — create in back-to-front paint order, same as Figma.

## Three rules the vscventures.com spike burned in (do NOT regress these)

1. **Never cull a zero-size element that has children.** Framer (and most modern
   frameworks) wrap the whole page in `display:contents` (0×0 box, thousands of
   descendants). Only cull zero-size *leaves*. Missing this returned 14 nodes for a
   1,400-node page.
2. **Paint order is stacking order, not DOM order.** Emit large background rects to
   the back, then full-bleed background images (hero video posters), then images,
   then text on top. DOM order lets a full-bleed hero cover the nav.
3. **Font mapping table.** Live sites use webfonts Figma does not have (e.g.
   Helvetica Neue). Map to the nearest installed family (Helvetica Neue → Archivo)
   and fall back to Inter. Framer largely dissolves this (native web fonts), but
   mapped fallbacks still need ~6% width slack to avoid wrapping.

## Known remaining work

- Gradients: capture records `node.gradient` but flatten does not paint it —
  hero overlays are lost (why the rebuilt hero is brighter than the original).
- Stacking paths: a full CSS stacking-context model (ancestor z chains) would
  replace the big-rect/full-bleed-image heuristics.
- Framer builder: map IR flex/grid onto Framer stack/grid for editability
  (current output is pixel-accurate absolute positioning).
- A mid-run WebSocket drop restarts the Framer build from scratch (page
  recreate); a resume would need Framer to allow re-entering an existing page.
- Full-page Figma builds exceed the 50k `use_figma` char limit (~63KB of leaves
  for VSC); chunk into 2–3 calls (emit-figma-calls.mjs).

See `spike/` for the vscventures.com capture (`vsc-ir.json`), flattened leaves, and
the `vsc-headtohead.png` original-vs-rebuild comparison.
