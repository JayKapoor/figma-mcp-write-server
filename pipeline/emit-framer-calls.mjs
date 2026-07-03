/**
 * Morph: render flattened leaves into a Framer page via the Framer Server API.
 *
 * Usage: FRAMER_API_KEY=... node emit-framer-calls.mjs <captureDir> --project <url-or-id>
 *          [--path /morph] [--publish] [--limit N] [--dry]
 *
 * Reuses the shared upstream (ir.json + leaves.json + font-map.json) and the
 * stacking paint order from build-figma.mjs (rule 2). Differences vs the
 * Figma emitter: no 50k chunking (direct WebSocket RPC), images upload as
 * bytes from the captured asset files (no base64 thumbs in the payload), and
 * webfonts resolve against Framer's native font library FIRST, with
 * font-map.json only as fallback (rule 3 mostly dissolves here).
 *
 * Output structure: <page at --path> > breakpoint frame > "Morph <host>" root
 * frame > absolutely-positioned leaves. Re-runs wipe and rebuild the root
 * frame, so the page is idempotent.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connect } from 'framer-api';
import { mfOrder } from './build-figma.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};

const dir = args[0];
if (!dir) { console.error('usage: node emit-framer-calls.mjs <captureDir> --project <url-or-id> [--path /morph] [--publish] [--limit N] [--dry]'); process.exit(1); }
const PROJECT = flag('--project', process.env.FRAMER_PROJECT || '');
const PUBLISH = process.argv.includes('--publish');
const DRY = process.argv.includes('--dry');
const LIMIT = parseInt(flag('--limit', '0'));

const ir = JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8'));
const leaves = JSON.parse(fs.readFileSync(path.join(dir, 'leaves.json'), 'utf8'));
const fontMap = JSON.parse(fs.readFileSync(path.join(here, 'font-map.json'), 'utf8'));
const host = new URL(ir.url).hostname.replace(/^www\./, '');
const PAGE_PATH = flag('--path', '/morph-' + host.replace(/\./g, '-'));
const rootName = `Morph ${host}`;
const rootBg = ir.tree.bg || Object.entries(ir.tokens.colors || {}).sort((a, b) => b[1] - a[1]).map(e => e[0])[0] || 'rgb(0,0,0)';

const px = n => `${Math.round(n)}px`;
const baseOf = f => f.replace(/ (Regular|Bold|Medium|Light|Black|Thin|Italic)$/, '');
const suffixWeight = { Thin: 100, Light: 300, Regular: 400, Medium: 500, Bold: 700, Black: 900 };
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif' };

// drop leaves fully outside the page (marquee animation strips extend far
// offscreen); they cost RPCs and can never paint
const onPage = l => l.x + l.w > 0 && l.x < ir.viewport.w && l.y + l.h > 0 && l.y < ir.viewport.h;
let ordered = mfOrder(leaves.filter(onPage));
const culled = leaves.length - ordered.length;
if (LIMIT) ordered = ordered.slice(0, LIMIT);

// ---- font resolution: Framer's live font library first, font-map fallback
function fontResolver(libFonts) {
  const byFamily = new Map();
  for (const f of libFonts) {
    const k = f.family.toLowerCase();
    if (!byFamily.has(k)) byFamily.set(k, []);
    byFamily.get(k).push(f);
  }
  const cache = {};
  return (fam, fw) => {
    const key = fam + '|' + fw;
    if (cache[key]) return cache[key];
    const base = baseOf(fam);
    const suffix = (fam.match(/ (Bold|Medium|Light|Black|Thin)$/) || [])[1];
    const wanted = suffix ? suffixWeight[suffix] : (parseInt(fw) || 400);
    const mapped = (fontMap[fam] || fontMap[base] || {});
    let factor = 1;
    // exact family in Framer's library beats the map (Framer serves webfonts natively)
    let cands = byFamily.get(base.toLowerCase());
    if (!cands && mapped.family) { cands = byFamily.get(mapped.family.toLowerCase()); factor = mapped.factor || 1; }
    if (!cands) cands = byFamily.get('inter') || [];
    const uprights = cands.filter(f => f.style !== 'italic');
    const pool = uprights.length ? uprights : cands;
    const font = pool.slice().sort((a, b) => Math.abs((a.weight ?? 400) - wanted) - Math.abs((b.weight ?? 400) - wanted))[0] || null;
    cache[key] = { font, factor, family: font ? font.family : base };
    return cache[key];
  };
}

// ---- text styling: one Framer TextStyle per unique (font, size, color, ...)
// combo, applied via inlineTextStyle at node creation. setHTML is not exposed
// over the Server API ("Invalid method: INTERNAL_setHTMLForNode"), and text
// nodes carry no direct size/color attributes — TextStyles are the mechanism
// (this is also the plan's "tokens to styles_createTextStyle").
const hash36 = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0; return h.toString(36); };
const ALIGN = { left: 'left', start: 'left', center: 'center', right: 'right', end: 'right', justify: 'justify' };
const TRANSFORM = { uppercase: 'uppercase', capitalize: 'capitalize', lowercase: 'lowercase' };

function textStyleFactory(framer, existingStyles) {
  const byName = new Map(existingStyles.map(s => [s.name, s]));
  const cache = {};
  return async (l, res) => {
    const key = [res.family, res.font?.weight ?? l.fw, l.fs, l.col, l.lh || '', ALIGN[l.al] || 'left', TRANSFORM[l.tt] || 'none'].join('|');
    if (cache[key]) return cache[key];
    const name = `Morph/${host}/${hash36(key)}`;
    let style = byName.get(name); // reuse across runs (styles are project-global)
    if (!style) {
      style = await framer.createTextStyle({
        name, tag: 'p',
        fontSize: `${Math.max(1, Math.round(l.fs * res.factor * 10) / 10)}px`,
        color: l.col,
        ...(res.font ? { font: res.font } : {}),
        ...(l.lh ? { lineHeight: `${l.lh}px` } : {}),
        ...(ALIGN[l.al] && ALIGN[l.al] !== 'left' ? { alignment: ALIGN[l.al] } : {}),
        ...(TRANSFORM[l.tt] ? { transform: TRANSFORM[l.tt] } : {}),
      });
    }
    cache[key] = style;
    return style;
  };
}

// ---- image assets: upload captured bytes once per asset key
function assetBytes(ak) {
  const a = (ir.assets || {})[ak];
  if (!a) return null;
  for (const file of [a.file, a.thumb]) {
    if (!file) continue;
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) continue;
    const ext = file.split('.').pop().toLowerCase();
    if (!MIME[ext]) continue;
    return { bytes: new Uint8Array(fs.readFileSync(p)), mimeType: MIME[ext] };
  }
  return null;
}

const isConnDrop = e => /Connection closed|PROJECT_CLOSED|POOL_EXHAUSTED|TIMEOUT/i.test(String(e));
class ConnDrop extends Error { constructor(cause) { super('connection dropped'); this.cause = cause; } }

// One connection's worth of building — always a FULL rebuild.
//
// Server-API session quirk (probed, Jul 2026): node ops (createFrameNode
// parentId, setAttributes, setText) only take effect on a page CREATED in the
// same connection. Against any pre-existing page they silently misroute to
// the session's default page (nodes land on Home, attrs return null) —
// navigateTo/zoomIntoView are blocked in api mode and setSelection doesn't
// switch, so there is no way to re-enter an existing page. Hence: delete the
// page at PAGE_PATH and recreate it fresh each run; a mid-run connection drop
// restarts the whole build on a new page rather than resuming a cursor.
async function buildAttempt(state) {
  const framer = await connect(PROJECT);
  try {
    if (state.attempt === 1) console.log(`connected: ${(await framer.getProjectInfo()).name}`);

    // -- page: delete stale + recreate (creation binds it to this connection)
    const pages = await framer.getNodesWithType('WebPageNode');
    const stale = pages.filter(p => (p.path || '') === PAGE_PATH);
    if (stale.length) { await framer.removeNodes(stale.map(p => p.id)); console.log(`deleted ${stale.length} stale page(s) at ${PAGE_PATH}`); }
    const page = await framer.createWebPage(PAGE_PATH);
    console.log(`created page ${PAGE_PATH}`);

    // -- container: the page's (primary) breakpoint frame, else the page itself
    const kids = await framer.getChildren(page.id);
    const breakpoint = kids.find(k => k.isPrimaryBreakpoint) || kids.find(k => k.isBreakpoint) || kids[0];
    const containerId = breakpoint ? breakpoint.id : page.id;

    // the page publishes at the breakpoint frame's height (absolute children
    // don't grow flow, and 'fit-content' silently no-ops) — pin it and verify
    if (breakpoint) {
      await framer.setAttributes(breakpoint.id, { height: px(ir.viewport.h) });
      const check = (await framer.getChildren(page.id)).find(k => k.id === breakpoint.id);
      if (check && check.height !== px(ir.viewport.h)) console.error(`WARNING: breakpoint height did not apply (${check.height}) — page will clip`);
    }

    const root = await framer.createFrameNode({
      name: rootName, position: 'relative',
      width: px(ir.viewport.w), height: px(ir.viewport.h),
      backgroundColor: rootBg, overflow: 'hidden',
    }, containerId);
    if (!root) throw new Error('createFrameNode returned null for root');
    const rootParent = await framer.getParent(root.id);
    if (!rootParent || rootParent.id !== containerId) throw new Error(`root misparented (got ${rootParent?.id}, want ${containerId}) — session/page binding broke`);

    // -- fonts + text styles (styles reattach by name across connections)
    const resolve = fontResolver(await framer.getFonts());
    const styleFor = textStyleFactory(framer, await framer.getTextStyles());

    const queue = ordered; // mfOrder is back-to-front; later-created Framer siblings stack on top (verified), so create in paint order

    // -- image assets
    const assetCache = {};
    const aks = [...new Set(queue.filter(l => l.t === 'img' && l.ak).map(l => l.ak))];
    for (const ak of aks) {
      const b = assetBytes(ak);
      if (!b) continue;
      try { assetCache[ak] = await framer.uploadImage({ image: b, name: `morph-${ak}` }); }
      catch (e) { if (isConnDrop(e)) throw new ConnDrop(e); console.error(`upload failed ${ak}: ${String(e).slice(0, 100)}`); }
    }
    console.log(`uploaded ${Object.keys(assetCache).length}/${aks.length} image assets`);

    for (const l of queue) {
      const pins = { position: 'absolute', left: px(l.x), top: px(l.y) };
      try {
        if (l.t === 'rect') {
          await framer.createFrameNode({
            name: 'rect', ...pins, width: px(Math.max(l.w, 1)), height: px(Math.max(l.h, 1)),
            backgroundColor: l.bg,
            ...(l.rad ? { borderRadius: /^\d/.test(l.rad) ? l.rad.split(' ')[0] : '50%' } : {}),
            ...(l.bd ? { border: { width: l.bd.w || '1px', color: l.bd.color, style: 'solid' } } : {}),
          }, root.id);
        } else if (l.t === 'img') {
          await framer.createFrameNode({
            name: `IMG ${l.ak || '?'}`, ...pins, width: px(Math.max(l.w, 1)), height: px(Math.max(l.h, 1)),
            ...(assetCache[l.ak] ? { backgroundImage: assetCache[l.ak] } : { backgroundColor: 'rgb(56,56,56)' }),
            ...(l.rad ? { borderRadius: /^\d/.test(l.rad) ? l.rad.split(' ')[0] : '50%' } : {}),
          }, root.id);
        } else if (l.t === 'svg') {
          // inline svg markup -> uploaded vector asset on a frame (addSVG has no
          // positioning contract; an image fill keeps the box exact)
          const key = 'svg-' + hash36(l.svg);
          let asset = assetCache[key];
          if (asset === undefined) {
            try { asset = assetCache[key] = await framer.uploadImage({ image: { bytes: new Uint8Array(Buffer.from(l.svg)), mimeType: 'image/svg+xml' }, name: key }); }
            catch (e) { if (isConnDrop(e)) throw new ConnDrop(e); asset = assetCache[key] = null; }
          }
          await framer.createFrameNode({
            name: 'svg', ...pins, width: px(Math.max(l.w, 1)), height: px(Math.max(l.h, 1)),
            ...(asset ? { backgroundImage: asset } : {}),
          }, root.id);
        } else {
          const res = resolve(l.fam, l.fw);
          const style = await styleFor(l, res);
          // ORDER MATTERS: passing a freshly-created inlineTextStyle at
          // creation silently clobbers setText (content reads back empty and
          // the node never publishes). setText FIRST, then attach the style.
          const node = await framer.createTextNode({
            name: l.s.slice(0, 24), ...pins,
            // ~6% slack: mapped fallback fonts (Archivo for Helvetica Neue)
            // run wider than the captured metrics and wrap without it
            width: px(Math.min(Math.max(l.w, 1) * 1.06 + 8, ir.viewport.w - l.x)),
            height: 'fit-content',
          }, root.id);
          if (!node) throw new Error('createTextNode null');
          await node.setText(l.s);
          await framer.setAttributes(node.id, { inlineTextStyle: style });
          state.styled++;
        }
        state.placed++;
      } catch (e) {
        if (isConnDrop(e)) throw new ConnDrop(e);
        state.failed++;
        if (state.failed <= 5) console.error(`leaf failed (${l.t} @${l.x},${l.y}): ${String(e).slice(0, 140)}`);
      }
      if (state.placed % 50 === 0) console.log(`  ${state.placed}/${ordered.length} placed`);
    }
    console.log(`placed ${state.placed}, failed ${state.failed}, styled text ${state.styled}`);

    if (PUBLISH) {
      console.log('publishing...');
      // publish() alone deploys and returns the live hostnames; deploy() is
      // only for re-promoting an old deployment (and returns [] here).
      const result = await framer.publish();
      const urls = (result?.hostnames || []).filter(h => h.isPublished).map(h => `https://${h.hostname}${PAGE_PATH}`);
      console.log('published:\n' + urls.map(u => '  ' + u).join('\n'));
      // the CDN serves the previous deploy until optimization finishes
      for (let i = 0; i < 30; i++) {
        const status = (await framer.getPublishInfo().catch(() => null))?.production?.optimizationStatus;
        if (status === 'optimized') { console.log('optimization complete'); break; }
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  } finally {
    try { await framer.disconnect(); } catch (e) { /* already gone */ }
  }
}

async function main() {
  console.log(`${ordered.length} leaves (${culled} offscreen culled) -> Framer page ${PAGE_PATH} (project ${PROJECT || '(missing --project)'})`);
  if (DRY) {
    const counts = {};
    for (const l of ordered) counts[l.t] = (counts[l.t] || 0) + 1;
    console.log('dry run:', JSON.stringify(counts), `root ${rootName} ${ir.viewport.w}x${ir.viewport.h} bg ${rootBg}`);
    return;
  }
  if (!PROJECT) { console.error('missing --project (or FRAMER_PROJECT env)'); process.exit(1); }
  if (!process.env.FRAMER_API_KEY) { console.error('missing FRAMER_API_KEY env'); process.exit(1); }

  const MAX_ATTEMPTS = 3; // each retry is a full rebuild (see buildAttempt note)
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const state = { attempt, placed: 0, failed: 0, styled: 0 };
    try { await buildAttempt(state); return; }
    catch (e) {
      if ((e instanceof ConnDrop || isConnDrop(e)) && attempt < MAX_ATTEMPTS) {
        console.log(`connection dropped at ${state.placed}/${ordered.length}; full rebuild (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw e;
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
