/**
 * Morph: render flattened leaves into a Figma frame.
 *
 * The section between the ---8<--- markers is plain plugin-sandbox JS. It is
 * embedded VERBATIM into every `use_figma` call by emit-figma-calls.mjs, so it
 * must not use imports, Node APIs, or top-level figma calls.
 *
 * Rules baked in: paint order by stacking (rule 2: mfOrder), font mapping
 * with weight-derived styles + metric size factor (rule 3: mfFont).
 * Real images: figma.createImage(figma.base64Decode(b64)) with the resulting
 * hash cached in frame pluginData, so each asset uploads once across chunks.
 */

// ---8<--- renderer start
function mfParseColor(s) {
  const m = (s || '').match(/rgba?\(([^)]+)\)/);
  if (!m) return { c: { r: 0, g: 0, b: 0 }, o: 1 };
  const p = m[1].split(',').map(x => parseFloat(x));
  return { c: { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255 }, o: p[3] === undefined ? 1 : p[3] };
}

function mfWeightStyle(fw) {
  const n = parseInt(fw) || 400;
  if (n >= 800) return ['ExtraBold', 'Extra Bold', 'Bold'];
  if (n >= 700) return ['Bold'];
  if (n >= 600) return ['SemiBold', 'Semi Bold', 'Medium', 'Bold'];
  if (n >= 500) return ['Medium', 'Regular'];
  if (n <= 300) return ['Light', 'Regular'];
  return ['Regular'];
}

async function mfFont(fam, fw, FONT_MAP, cache) {
  const key = fam + '|' + fw;
  if (cache[key]) return cache[key];
  // webfont families often carry the weight in the name ("Helvetica Neue Bold")
  const base = fam.replace(/ (Regular|Bold|Medium|Light|Black|Thin|Italic)$/, '');
  const suffix = (fam.match(/ (Bold|Medium|Light|Black|Thin)$/) || [])[1];
  const m = FONT_MAP[fam] || FONT_MAP[base] || {};
  const styles = [...new Set([...(suffix ? [suffix] : []), ...mfWeightStyle(fw)])];
  const cands = [];
  for (const family of [m.family || base, 'Inter']) {
    for (const style of styles) cands.push({ family, style });
    cands.push({ family, style: 'Regular' });
  }
  for (const c of cands) {
    try { await figma.loadFontAsync(c); cache[key] = { font: c, factor: m.factor || 1 }; return cache[key]; }
    catch (e) { /* try next */ }
  }
  cache[key] = { font: { family: 'Inter', style: 'Regular' }, factor: 1 };
  return cache[key];
}

// RULE 2: paint order = stacking order, not DOM order.
// Big rects to the back, then full-bleed background images (hero video
// posters etc. — often DOM-late but visually behind everything), then
// images/svgs, text on top; explicit z breaks ties.
function mfOrder(leaves) {
  const area = l => l.w * l.h;
  const rank = l => l.t === 'text' ? 4
    : (l.t === 'img' || l.t === 'svg') ? (area(l) > 400000 ? 2 : 3)
      : 1;
  return leaves.map((l, i) => ({ l, i })).sort((a, b) => {
    if (rank(a.l) !== rank(b.l)) return rank(a.l) - rank(b.l);
    if (rank(a.l) <= 2 && area(a.l) !== area(b.l)) return area(b.l) - area(a.l);
    const za = a.l.z || 0, zb = b.l.z || 0;
    if (za !== zb) return za - zb;
    return a.i - b.i;
  }).map(o => o.l);
}

async function mfFrame(name, w, h, bg, pageName) {
  if (pageName) {
    let page = figma.root.children.find(p => p.name === pageName);
    if (!page) { page = figma.createPage(); page.name = pageName; }
    await figma.setCurrentPageAsync(page);
  }
  let f = figma.currentPage.findChild(n => n.type === 'FRAME' && n.name === name);
  if (!f) {
    f = figma.createFrame(); f.name = name; f.resize(w, h); f.x = 0; f.y = 0; f.clipsContent = true;
    f.fills = [{ type: 'SOLID', color: mfParseColor(bg || 'rgb(0,0,0)').c }];
    figma.currentPage.appendChild(f);
  }
  return f;
}

function mfImageHash(frame, ak, ASSETS) {
  // shared plugin data: use_figma does not support get/setPluginData
  let hash = frame.getSharedPluginData('morph', 'img:' + ak);
  if (!hash && ASSETS[ak]) {
    hash = figma.createImage(figma.base64Decode(ASSETS[ak].b64)).hash;
    frame.setSharedPluginData('morph', 'img:' + ak, hash);
  }
  return hash || null;
}

function mfRadius(node, rad, w, h) {
  const rv = parseFloat(rad);
  if (!isNaN(rv)) node.cornerRadius = Math.min(rv, Math.min(w, h) / 2);
  else node.cornerRadius = Math.min(w, h) / 2; // e.g. "50%"
}

async function mfRender(frame, leaves, FONT_MAP, ASSETS) {
  const cache = {};
  let imgs = 0, missing = 0;
  for (const l of mfOrder(leaves)) {
    if (l.t === 'rect') {
      const r = figma.createRectangle(); r.resize(Math.max(l.w, 1), Math.max(l.h, 1)); r.x = l.x; r.y = l.y;
      const pc = mfParseColor(l.bg); r.fills = [{ type: 'SOLID', color: pc.c, opacity: pc.o }];
      if (l.rad) mfRadius(r, l.rad, l.w, l.h);
      if (l.bd) { const bc = mfParseColor(l.bd.color); r.strokes = [{ type: 'SOLID', color: bc.c, opacity: bc.o }]; r.strokeWeight = parseFloat(l.bd.w) || 1; }
      frame.appendChild(r);
    } else if (l.t === 'img') {
      const r = figma.createRectangle(); r.resize(Math.max(l.w, 1), Math.max(l.h, 1)); r.x = l.x; r.y = l.y;
      const hash = mfImageHash(frame, l.ak, ASSETS);
      if (hash) { r.fills = [{ type: 'IMAGE', scaleMode: l.fit === 'contain' ? 'FIT' : 'FILL', imageHash: hash }]; imgs++; }
      else { r.fills = [{ type: 'SOLID', color: { r: 0.22, g: 0.22, b: 0.22 } }]; missing++; }
      r.name = 'IMG ' + (l.ak || '?');
      if (l.rad) mfRadius(r, l.rad, l.w, l.h);
      frame.appendChild(r);
    } else if (l.t === 'svg') {
      try {
        const n = figma.createNodeFromSvg(l.svg);
        n.x = l.x; n.y = l.y;
        if (n.width && n.height && l.w >= 1 && l.h >= 1) n.resize(Math.max(l.w, 1), Math.max(l.h, 1));
        frame.appendChild(n);
      } catch (e) { missing++; }
    } else {
      const { font, factor } = await mfFont(l.fam, l.fw, FONT_MAP, cache);
      const t = figma.createText(); t.fontName = font;
      t.fontSize = Math.max(1, Math.round(l.fs * factor * 10) / 10);
      t.characters = l.s;
      if (l.tt === 'uppercase') t.textCase = 'UPPER'; else if (l.tt === 'capitalize') t.textCase = 'TITLE';
      if (l.lh) t.lineHeight = { value: l.lh, unit: 'PIXELS' };
      t.x = l.x; t.y = l.y;
      const pc = mfParseColor(l.col); t.fills = [{ type: 'SOLID', color: pc.c, opacity: pc.o }];
      if (l.al === 'right' || l.al === 'end') { t.textAutoResize = 'HEIGHT'; t.resize(l.w, l.h); t.textAlignHorizontal = 'RIGHT'; }
      else if (l.al === 'center') { t.textAutoResize = 'HEIGHT'; t.resize(l.w, l.h); t.textAlignHorizontal = 'CENTER'; }
      frame.appendChild(t);
    }
  }
  return { placed: leaves.length, imgs, missing };
}
// ---8<--- renderer end

export { mfOrder };
export function rendererSource(selfSource) {
  const m = selfSource.match(/\/\/ ---8<--- renderer start([\s\S]*)\/\/ ---8<--- renderer end/);
  return m[1].trim();
}
