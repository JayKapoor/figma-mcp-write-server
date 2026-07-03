/**
 * Morph: side-by-side comparison of the original capture vs a rebuilt page.
 *
 * Usage: node headtohead.mjs <captureDir> <rebuiltUrl> [outPng]
 * Screenshots <rebuiltUrl> full-page at the capture viewport width, then
 * composes <captureDir>/original-full.png | rebuild into one PNG via an
 * in-browser canvas (no native image deps).
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const [dir, url, outArg] = process.argv.slice(2);
if (!dir || !url) { console.error('usage: node headtohead.mjs <captureDir> <rebuiltUrl> [outPng]'); process.exit(1); }
const ir = JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8'));
const out = outArg || path.join(dir, 'framer-headtohead.png');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: ir.viewport.w, height: 900 } });
await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => page.waitForTimeout(4000));
// settle lazy content like capture.mjs does
await page.evaluate(async () => {
  const h = document.body.scrollHeight;
  for (let y = 0; y <= h; y += 600) { scrollTo(0, y); await new Promise(r => setTimeout(r, 30)); }
  scrollTo(0, 0); await new Promise(r => setTimeout(r, 300));
});
const rebuiltPng = path.join(dir, 'framer-rebuild-full.png');
await page.screenshot({ path: rebuiltPng, fullPage: true });

// compose side-by-side with an in-page canvas
const b64 = f => fs.readFileSync(f).toString('base64');
const composed = await page.evaluate(async ([a, b]) => {
  const load = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + src; });
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const scale = 800 / Math.max(ia.width, ib.width);
  const w = Math.round(Math.max(ia.width, ib.width) * scale), gap = 16;
  const h = Math.round(Math.max(ia.height, ib.height) * scale);
  const c = document.createElement('canvas'); c.width = w * 2 + gap; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#222'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(ia, 0, 0, Math.round(ia.width * scale), Math.round(ia.height * scale));
  ctx.drawImage(ib, w + gap, 0, Math.round(ib.width * scale), Math.round(ib.height * scale));
  return c.toDataURL('image/png').split(',')[1];
}, [b64(path.join(dir, 'original-full.png')), b64(rebuiltPng)]);
fs.writeFileSync(out, Buffer.from(composed, 'base64'));
await browser.close();
console.log(`original | rebuild -> ${out}`);
