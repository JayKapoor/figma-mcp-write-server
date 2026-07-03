/**
 * Morph: package flattened leaves + base64 assets into chunked `use_figma`
 * call bodies (each under the ~50k char payload limit).
 *
 * Usage: node emit-figma-calls.mjs <captureDir> [--frame "Name"] [--budget 42000]
 * Reads <captureDir>/{ir.json,leaves.json} + pipeline/font-map.json.
 * Writes <captureDir>/calls/call-01.js ... call-NN.js — paste each, in order,
 * as the body of a use_figma call.
 *
 * Leaves are ordered GLOBALLY by stacking (rule 2) before chunking, so
 * appending chunk after chunk preserves paint order. Each unique image asset's
 * base64 ships in exactly one chunk; later chunks reuse the createImage hash
 * cached in frame pluginData.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { mfOrder, rendererSource } from './build-figma.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};

const dir = args[0];
if (!dir) { console.error('usage: node emit-figma-calls.mjs <captureDir> [--frame Name] [--page Name] [--budget 42000]'); process.exit(1); }
const BUDGET = parseInt(flag('--budget', '42000'));
const pageName = flag('--page', '');
// --placeholders: emit no base64 — image leaves render as gray rects named
// "IMG <ak>" so a second pass (figma-write figma_fills from local files) can
// swap in full-res pixels without burning tokens on inline b64.
const PLACEHOLDERS = process.argv.includes('--placeholders');

const ir = JSON.parse(fs.readFileSync(path.join(dir, 'ir.json'), 'utf8'));
const leaves = JSON.parse(fs.readFileSync(path.join(dir, 'leaves.json'), 'utf8'));
const fontMapAll = JSON.parse(fs.readFileSync(path.join(here, 'font-map.json'), 'utf8'));
const frameName = flag('--frame', `Morph — ${new URL(ir.url).hostname.replace(/^www\./, '')}`);

// font map trimmed to families actually used (weight-suffixed names resolve
// through their base family: "Helvetica Neue Bold" -> map["Helvetica Neue"])
const baseOf = f => f.replace(/ (Regular|Bold|Medium|Light|Black|Thin|Italic)$/, '');
const fams = [...new Set(leaves.filter(l => l.t === 'text').map(l => l.fam))];
const fontMap = {};
for (const f of fams) { const e = fontMapAll[f] || fontMapAll[baseOf(f)]; if (e) fontMap[f] = e; }

// frame background: root node bg, else most frequent captured color
const rootBg = ir.tree.bg || Object.entries(ir.tokens.colors || {}).sort((a, b) => b[1] - a[1]).map(e => e[0])[0] || 'rgb(0,0,0)';

// asset b64 lookup (thumbs preferred; raw file fallback if small)
const b64Of = ak => {
  const a = (ir.assets || {})[ak];
  if (!a) return null;
  const file = a.thumb || ((a.bytes || 1e9) < 30000 && a.file && !a.file.endsWith('.svg') ? a.file : null);
  if (!file) return null;
  try { return { b64: fs.readFileSync(path.join(dir, file)).toString('base64'), fit: a.fit }; }
  catch (e) { return null; }
};

const renderer = rendererSource(fs.readFileSync(path.join(here, 'build-figma.mjs'), 'utf8'));
const ordered = mfOrder(leaves);

const preamble = k => `// Morph call ${k} — body of a use_figma call (frame: ${JSON.stringify(frameName)})\n${renderer}\n`;
const driver = (k, leavesJson, assetsJson) =>
  `const FONT_MAP = ${JSON.stringify(fontMap)};\n` +
  `const ASSETS = ${assetsJson};\n` +
  `const LEAVES = ${leavesJson};\n` +
  `const frame = await mfFrame(${JSON.stringify(frameName)}, ${ir.viewport.w}, ${ir.viewport.h}, ${JSON.stringify(rootBg)}, ${JSON.stringify(pageName)});\n` +
  `const res = await mfRender(frame, LEAVES, FONT_MAP, ASSETS);\n` +
  `return { call: ${k}, frameId: frame.id, ...res };\n`;

const FIXED = preamble(99).length + driver(99, '[]', '{}').length;
const shipped = new Set();
const calls = [];
let chunk = [], assets = {}, cost = FIXED;

const flush = () => {
  if (!chunk.length) return;
  calls.push({ leaves: chunk, assets });
  chunk = []; assets = {}; cost = FIXED;
};

for (const l of ordered) {
  let leafCost = JSON.stringify(l).length + 2;
  let asset = null;
  if (!PLACEHOLDERS && l.t === 'img' && l.ak && !shipped.has(l.ak)) {
    asset = b64Of(l.ak);
    if (asset) leafCost += asset.b64.length + l.ak.length + 20;
  }
  if (cost + leafCost > BUDGET && chunk.length) flush();
  chunk.push(l); cost += leafCost;
  if (asset) { assets[l.ak] = { b64: asset.b64 }; shipped.add(l.ak); }
}
flush();

const outDir = path.join(dir, 'calls');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
calls.forEach((c, i) => {
  const k = i + 1;
  const body = preamble(k) + driver(k, JSON.stringify(c.leaves), JSON.stringify(c.assets));
  const file = path.join(outDir, `call-${String(k).padStart(2, '0')}.js`);
  fs.writeFileSync(file, body);
  console.log(`${path.basename(file)}  ${String(body.length).padStart(6)} chars  ${String(c.leaves.length).padStart(4)} leaves  ${Object.keys(c.assets).length} new assets`);
});
const noB64 = [...new Set(ordered.filter(l => l.t === 'img' && (!l.ak || !shipped.has(l.ak))).map(l => l.ak || '(none)'))];
if (noB64.length) console.log(`assets with NO embeddable image (placeholder fill): ${noB64.join(', ')}`);
console.log(`${calls.length} calls, frame ${JSON.stringify(frameName)} ${ir.viewport.w}x${ir.viewport.h}, bg ${rootBg}`);
