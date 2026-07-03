/**
 * Morph capture: URL -> design IR.
 *
 * Runnable standalone (node capture.mjs <url> [out.json]) OR the page.evaluate
 * body can be lifted into a Playwright-MCP run_code_unsafe call.
 *
 * Rules baked in (see pipeline/README.md):
 *  - cull zero-size elements only when they are childless leaves (keeps
 *    display:contents wrappers, which hold the whole page)
 *  - settle animations to final state before walking
 *  - strip Framer editor/loader chrome
 */
import { chromium } from 'playwright';

const EXTRACT = () => {
  let count = 0; const MAX = 8000;
  function ex(el, depth) {
    if (count > MAX || depth > 22) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1 && el.childElementCount === 0) return null; // RULE 1
    count++;
    const node = { tag: el.tagName.toLowerCase(), box: [Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)] };
    const fn = el.getAttribute('data-framer-name'); if (fn) node.name = fn;
    if (cs.display === 'contents') node.passthrough = true;
    else if (cs.display.includes('flex')) node.layout = { mode: 'flex', dir: cs.flexDirection, gap: cs.gap, justify: cs.justifyContent, align: cs.alignItems, pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(v => Math.round(parseFloat(v))), wrap: cs.flexWrap };
    else if (cs.display.includes('grid')) node.layout = { mode: 'grid', cols: cs.gridTemplateColumns, gap: cs.gap, pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(v => Math.round(parseFloat(v))) };
    if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') node.bg = cs.backgroundColor;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') { const m = cs.backgroundImage.match(/url\("?([^")]+)"?\)/); if (m) node.bgImageUrl = m[1]; else if (cs.backgroundImage.includes('gradient')) node.gradient = cs.backgroundImage.slice(0, 200); }
    if (cs.borderRadius !== '0px') node.radius = cs.borderRadius;
    if (cs.boxShadow !== 'none') node.shadow = cs.boxShadow;
    if (cs.borderTopWidth !== '0px' && cs.borderTopStyle !== 'none') node.border = { w: cs.borderTopWidth, color: cs.borderTopColor };
    const dt = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).filter(Boolean).join(' ');
    if (dt) { node.text = dt; node.font = { family: cs.fontFamily.split(',')[0].replace(/"/g, '').trim(), size: Math.round(parseFloat(cs.fontSize)), weight: cs.fontWeight, lh: cs.lineHeight, ls: cs.letterSpacing, color: cs.color, align: cs.textAlign, transform: cs.textTransform }; }
    if (el.tagName === 'IMG') node.img = el.currentSrc || el.src || '';
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

export async function capture(url) {
  // isolated context = clean visitor render (no logged-in editor chrome)
  const browser = await chromium.launch();
  const page = await browser.newContext({ viewport: { width: 1200, height: 900 } }).then(c => c.newPage());
  await page.goto(url, { waitUntil: 'networkidle' });
  await settle(page);
  const ir = await page.evaluate(EXTRACT);
  await browser.close();
  return ir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2] || 'https://www.vscventures.com';
  const out = process.argv[3] || 'ir.json';
  capture(url).then(async ir => { (await import('fs')).writeFileSync(out, JSON.stringify(ir, null, 1)); console.log(`captured ${ir.nodeCount} nodes -> ${out}`); });
}
