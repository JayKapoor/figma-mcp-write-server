# Morph Pipeline (URL → IR → Figma / Framer / Code)

Reverse engineer a live website into a design **IR** (intermediate representation),
then rebuild it in Figma, Framer, or code. All builders consume the same IR, so
Figma is optional on the Framer and code paths.

Status: **spike passed** on vscventures.com (Jul 3 2026). Capture is essentially
solved. Figma builder is a working seed, ~2 sessions from production.

## Flow

1. **capture.mjs** — Playwright renders the URL, settles animations to their final
   state, and walks the DOM into `ir.json` (tree of nodes: box, flex/grid layout,
   fills, text runs with font specs, images, svgs).
2. **flatten.py** — collapses the IR tree into absolute-positioned paint leaves
   (`text` / `rect` / `img`) and rolls up color + font tokens.
3. **build-figma.mjs** — the body of a `use_figma` call: renders leaves into a Figma
   frame with font mapping and correct paint order. (Framer builder is the same
   leaf list fed to framer-mcp; not yet written.)

## Three rules the vscventures.com spike burned in (do NOT regress these)

1. **Never cull a zero-size element that has children.** Framer (and most modern
   frameworks) wrap the whole page in `display:contents` (0×0 box, thousands of
   descendants). Only cull zero-size *leaves*. Missing this returned 14 nodes for a
   1,400-node page.
2. **Paint order is stacking order, not DOM order.** Emit large background rects to
   the back, then images, then text on top. DOM order lets a full-bleed hero cover
   the nav.
3. **Font mapping table.** Live sites use webfonts Figma does not have (e.g.
   Helvetica Neue). Map to the nearest installed family (Helvetica Neue → Archivo)
   and fall back to Inter. A metric-based size nudge is a TODO.

## Known Phase-1/2 work

- The persistent Playwright Chrome profile is logged into Framer, so live Framer
  sites inject an editor bar. Capture from an isolated context, or strip
  `[id^="__framer-editorbar"]` and `[data-framer-name*="LOADER"]`.
- Hero backgrounds are often `<video>`; capture the poster frame, not a black box.
- Real image embed via `figma.createImage(figma.base64Decode(b64))` (Plugin API
  supports it; thumbnails are small enough to inline).
- Full-page builds exceed the 50k `use_figma` char limit (~63KB of leaves for VSC);
  chunk into 2–3 calls.

See `spike/` for the vscventures.com capture (`vsc-ir.json`), flattened leaves, and
the `vsc-headtohead.png` original-vs-rebuild comparison.
