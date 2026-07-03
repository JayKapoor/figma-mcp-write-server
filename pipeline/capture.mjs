/**
 * Morph capture: URL -> design IR + downloaded assets.
 *
 * Usage: node capture.mjs <url> [outDir] [--width 1200]
 * Writes <outDir>/ir.json and <outDir>/assets/ (raw originals + b64 thumbs).
 *
 * Rules baked in (see pipeline/README.md — do NOT regress):
 *  1. Never cull a zero-size element that has children (display:contents
 *     wrappers hold the whole page on Framer/modern sites).
 *  2. Capture stacking metadata (position, z-index) so the builder can paint
 *     by stacking order, not DOM order.
 *  3. Font specs captured verbatim; mapping to installed Figma families
 *     happens in the builder via font-map.json.
 *
 * Plus: isolated browser context (no logged-in Framer editor chrome), Framer
 * loader/editorbar stripping, animation settle, video poster frames.
 */
import { chromium } from 'playwright';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const EXTRACT = () => {
  let count = 0; const MAX = 8000;
  const videos = Array.from(document.querySelectorAll('video'));
  function ex(el, depth) {
    if (count > MAX || depth > 22) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    const r = el.getBoundingClientRect();
    // RULE 1: only cull zero-size elements that are childless leaves.
    if (r.width < 1 && r.height < 1 && el.childElementCount === 0) return null;
    count++;
    const node = { tag: el.tagName.toLowerCase(), box: [Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)] };
    const fn = el.getAttribute('data-framer-name'); if (fn) node.name = fn;
    // RULE 2 metadata: stacking context info for the builder's paint order.
    if (cs.position !== 'static') node.pos = cs.position;
    if (cs.zIndex !== 'auto' && !isNaN(parseInt(cs.zIndex))) node.z = parseInt(cs.zIndex);
    if (parseFloat(cs.opacity) < 1) node.opacity = Math.round(parseFloat(cs.opacity) * 100) / 100;
    if (cs.display === 'contents') node.passthrough = true;
    else if (cs.display.includes('flex')) node.layout = { mode: 'flex', dir: cs.flexDirection, gap: cs.gap, justify: cs.justifyContent, align: cs.alignItems, pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(v => Math.round(parseFloat(v))), wrap: cs.flexWrap };
    else if (cs.display.includes('grid')) node.layout = { mode: 'grid', cols: cs.gridTemplateColumns, gap: cs.gap, pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(v => Math.round(parseFloat(v))) };
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') node.bg = cs.backgroundColor;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      const m = cs.backgroundImage.match(/url\("?([^")]+)"?\)/);
      if (m) { node.bgImageUrl = m[1]; node.fit = cs.backgroundSize === 'contain' ? 'contain' : 'cover'; }
      else if (cs.backgroundImage.includes('gradient')) node.gradient = cs.backgroundImage.slice(0, 200);
    }
    if (cs.borderRadius !== '0px') node.radius = cs.borderRadius;
    if (cs.boxShadow !== 'none') node.shadow = cs.boxShadow;
    if (cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none') node.border = { w: cs.borderTopWidth, color: cs.borderTopColor };
    const dt = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).filter(Boolean).join(' ');
    if (dt) { node.text = dt; node.font = { family: cs.fontFamily.split(',')[0].replace(/"/g, '').trim(), size: Math.round(parseFloat(cs.fontSize)), weight: cs.fontWeight, lh: cs.lineHeight, ls: cs.letterSpacing, color: cs.color, align: cs.textAlign, transform: cs.textTransform }; }
    if (el.tagName === 'IMG') { node.img = (el.currentSrc || el.src || ''); node.fit = cs.objectFit === 'contain' ? 'contain' : 'cover'; }
    if (el.tagName === 'VIDEO') node.video = { index: videos.indexOf(el), poster: el.poster || '' };
    if (el.tagName === 'svg') { const s = el.outerHTML; node.svg = s.length < 8000 ? s : 'TOO_LARGE:' + s.length; }
    if (el.tagName === 'A' && el.href) node.href = el.href;
    const kids = [];
    for (const c of el.children) { if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK'].includes(c.tagName)) continue; const cc = ex(c, depth + 1); if (cc) kids.push(cc); }
    if (kids.length) node.children = kids;
    return node;
  }
  const root = document.getElementById('main') || document.body;
  const tree = ex(root, 0);
  const colors = {}, fonts = {}; const imgs = new Set();
  (function w(n) { if (n.bg) colors[n.bg] = (colors[n.bg] || 0) + 1; if (n.img) imgs.add(n.img.split('?')[0]); if (n.font) { colors[n.font.color] = (colors[n.font.color] || 0) + 1; const k = n.font.family + '|' + n.font.weight + '|' + n.font.size; fonts[k] = (fonts[k] || 0) + 1; } (n.children || []).forEach(w); })(tree);
  return { url: location.href, title: document.title, viewport: { w: innerWidth, h: document.body.scrollHeight }, nodeCount: count, tokens: { colors, fonts, imageCount: imgs.size }, tree };
};

// In-page canvas re-encode: returns {b64 (raw base64, no dataURL prefix), fmt, w, h}
// or null (CORS taint / decode failure — caller falls back to raw bytes).
const THUMB = async ({ url, budget }) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  try { await img.decode(); } catch (e) { return null; }
  const draw = (cap, bg) => {
    const scale = Math.min(1, cap / Math.max(img.naturalWidth, img.naturalHeight, 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = c.getContext('2d');
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  };
  // detect REAL alpha by sampling pixels — extension is a lie (photos ship as
  // .png/.webp and PNG-encoding them explodes the size budget)
  let hasAlpha = false;
  try {
    const probe = draw(48);
    const d = probe.getContext('2d').getImageData(0, 0, probe.width, probe.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { hasAlpha = true; break; }
  } catch (e) { return null; } // tainted canvas — caller keeps the raw file
  for (const cap of [640, 480, 360, 240, 160]) {
    const c = draw(cap);
    const b64 = (hasAlpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.62)).split(',')[1];
    if (b64.length <= budget) return { b64, fmt: hasAlpha ? 'png' : 'jpg', w: c.width, h: c.height };
  }
  // last resort (huge true-alpha art): flatten onto near-black and JPEG it
  for (const cap of [480, 360, 240]) {
    const c = draw(cap, '#111');
    const b64 = c.toDataURL('image/jpeg', 0.6).split(',')[1];
    if (b64.length <= budget || cap === 240) return { b64, fmt: 'jpg', w: c.width, h: c.height };
  }
  return null;
};

function walkTree(tree, fn) { fn(tree); (tree.children || []).forEach(c => walkTree(c, fn)); }
const hashKey = url => createHash('sha1').update(url).digest('hex').slice(0, 10);
const extOf = url => { const m = url.split('?')[0].match(/\.([a-z0-9]{2,4})$/i); return m ? m[1].toLowerCase() : 'bin'; };

async function settle(page) {
  await page.addStyleTag({ content: `*,*::before,*::after{animation:none!important;transition:none!important;}` });
  await page.evaluate(async () => {
    document.querySelectorAll('[id^="__framer-editorbar"],[data-framer-name*="LOADER"],[data-framer-name="Loading Wrapper"]').forEach(el => el.style.display = 'none');
    document.querySelectorAll('[style*="opacity"]').forEach(el => { el.style.opacity = '1'; });
    const h = document.body.scrollHeight;
    for (let y = 0; y <= h; y += 500) { scrollTo(0, y); await new Promise(r => setTimeout(r, 40)); }
    scrollTo(0, 0); await new Promise(r => setTimeout(r, 400));
  });
}

async function collectAssets(page, context, ir, outDir, thumbBudget) {
  const assetsDir = path.join(outDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  const assets = {}; // key -> {url, file, thumb, fmt, w, h}
  const urls = new Map(); // url -> key

  walkTree(ir.tree, n => {
    for (const u of [n.img, n.bgImageUrl, n.video && n.video.poster]) {
      if (u && /^https?:/.test(u) && !urls.has(u)) urls.set(u, hashKey(u));
    }
    if (n.img && urls.has(n.img)) n.ak = urls.get(n.img);
    else if (n.bgImageUrl && urls.has(n.bgImageUrl)) n.ak = urls.get(n.bgImageUrl);
  });

  // 1) raw originals via the browser's request context (shares cookies, no CORS)
  for (const [url, key] of urls) {
    const entry = { url };
    try {
      const resp = await context.request.get(url, { timeout: 15000 });
      if (resp.ok()) {
        const buf = await resp.body();
        const file = `assets/${key}.${extOf(url)}`;
        fs.writeFileSync(path.join(outDir, file), buf);
        entry.file = file; entry.bytes = buf.length;
      }
    } catch (e) { entry.error = String(e).slice(0, 120); }
    // 2) size-budgeted b64 thumb via in-page canvas (skip svg — kept as vector)
    if (extOf(url) !== 'svg') {
      try {
        const t = await page.evaluate(THUMB, { url, budget: thumbBudget });
        if (t) {
          const thumbFile = `assets/thumb-${key}.${t.fmt}`;
          fs.writeFileSync(path.join(outDir, thumbFile), Buffer.from(t.b64, 'base64'));
          entry.thumb = thumbFile; entry.fmt = t.fmt; entry.w = t.w; entry.h = t.h;
        }
      } catch (e) { /* raw file still usable */ }
    }
    assets[key] = entry;
  }

  // 3) video poster frames: pause, seek to a representative frame, screenshot
  //    the element (works with or without a poster attribute).
  const videoCount = await page.evaluate(() => document.querySelectorAll('video').length);
  if (videoCount) {
    await page.evaluate(() => document.querySelectorAll('video').forEach(v => {
      try { v.pause(); if (v.duration && v.currentTime < 0.2) v.currentTime = Math.min(1, v.duration / 3); } catch (e) { }
    }));
    await page.waitForTimeout(400);
  }
  const videoKeys = {};
  for (let i = 0; i < videoCount; i++) {
    const key = `video-${i}`;
    const posterUrl = await page.evaluate(i => (document.querySelectorAll('video')[i] || {}).poster || '', i);
    if (posterUrl && urls.has(posterUrl)) { videoKeys[i] = urls.get(posterUrl); continue; }
    try {
      // rect-based clip screenshot: locator.screenshot() hangs on offscreen /
      // duplicate SSR videos waiting for stability. Scroll into view, clip.
      const rect = await page.evaluate(async i => {
        const v = document.querySelectorAll('video')[i];
        if (!v) return null;
        const r0 = v.getBoundingClientRect();
        if (r0.width < 8 || r0.height < 8) return null;
        v.scrollIntoView({ block: 'center' });
        await new Promise(res => setTimeout(res, 250));
        const r = v.getBoundingClientRect();
        return { x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.min(r.width, innerWidth - Math.max(0, r.x)), h: Math.min(r.height, innerHeight - Math.max(0, r.y)) };
      }, i);
      if (!rect || rect.w < 8 || rect.h < 8) continue;
      const file = `assets/${key}.png`;
      await page.screenshot({ path: path.join(outDir, file), clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h }, timeout: 10000 });
      // re-encode the screenshot to fit the thumb budget
      const t = await page.evaluate(THUMB, { url: 'data:image/png;base64,' + fs.readFileSync(path.join(outDir, file)).toString('base64'), budget: thumbBudget })
        .catch(() => null);
      const entry = { url: `video:${i}`, file };
      if (t) {
        const thumbFile = `assets/thumb-${key}.${t.fmt}`;
        fs.writeFileSync(path.join(outDir, thumbFile), Buffer.from(t.b64, 'base64'));
        Object.assign(entry, { thumb: thumbFile, fmt: t.fmt, w: t.w, h: t.h });
      }
      assets[key] = entry; videoKeys[i] = key;
    } catch (e) { assets[key] = { url: `video:${i}`, error: String(e).slice(0, 120) }; }
  }
  // link video nodes to their poster asset
  walkTree(ir.tree, n => { if (n.video && videoKeys[n.video.index] !== undefined) n.ak = videoKeys[n.video.index]; });

  ir.assets = assets;
  return assets;
}

export async function capture(url, outDir = null, { width = 1200, thumbBudget = 20000 } = {}) {
  outDir = outDir || path.join('captures', new URL(url).hostname.replace(/^www\./, ''));
  fs.mkdirSync(outDir, { recursive: true });
  // isolated context = clean visitor render (no logged-in editor chrome)
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  try { await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }); }
  catch (e) { await page.waitForTimeout(3000); } // networkidle can hang on long-poll sites; proceed after load
  await settle(page);
  const ir = await page.evaluate(EXTRACT);
  const assets = await collectAssets(page, context, ir, outDir, thumbBudget);
  await page.screenshot({ path: path.join(outDir, 'original-full.png'), fullPage: true });
  await browser.close();
  fs.writeFileSync(path.join(outDir, 'ir.json'), JSON.stringify(ir, null, 1));
  const withThumb = Object.values(assets).filter(a => a.thumb).length;
  console.log(`captured ${ir.nodeCount} nodes, ${Object.keys(assets).length} assets (${withThumb} thumbs) -> ${outDir}/`);
  return ir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const width = parseInt((process.argv.find(a => a.startsWith('--width')) || '').split('=')[1] || '1200');
  capture(args[0] || 'https://www.vscventures.com', args[1] || null, { width });
}
