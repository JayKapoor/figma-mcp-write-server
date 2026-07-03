/**
 * Morph: render flattened leaves into a Figma frame.
 *
 * This is the BODY of a `use_figma` call (official Figma MCP). The `leaves`
 * array is injected inline; for a full page split leaves across 2-3 calls
 * (the use_figma payload caps at 50k chars).
 *
 * Rules baked in: paint order by stacking (rule 2), font mapping (rule 3).
 */

// --- injected per call ---
// const leaves = [ ...flattened paint leaves... ];
// const FONT_MAP = { 'Helvetica Neue Regular': {family:'Archivo', style:'Regular'}, ... };

function parseColor(s) {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return { c: { r: 0, g: 0, b: 0 }, o: 1 };
  const p = m[1].split(',').map(x => parseFloat(x));
  return { c: { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255 }, o: p[3] === undefined ? 1 : p[3] };
}

async function resolveFont(fam, FONT_MAP) {
  const mapped = FONT_MAP[fam] ||
    { family: fam.replace(/ (Regular|Bold|Medium)$/, ''), style: (fam.match(/(Bold|Medium)$/) || [])[0] || 'Regular' };
  for (const cand of [mapped, { family: 'Inter', style: mapped.style || 'Regular' }, { family: 'Inter', style: 'Regular' }]) {
    try { await figma.loadFontAsync(cand); return cand; } catch (e) { /* try next */ }
  }
}

export async function buildFrame(page, leaves, FONT_MAP, { name = 'Morph rebuild', w = 1186, h = 860 } = {}) {
  const fams = [...new Set(leaves.filter(l => l.t === 'text').map(l => l.fam))];
  const fontMap = {};
  for (const f of fams) fontMap[f] = await resolveFont(f, FONT_MAP);

  const frame = figma.createFrame();
  frame.name = name; frame.resize(w, h); frame.x = 0; frame.y = 0;
  frame.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]; frame.clipsContent = true;
  page.appendChild(frame);

  // RULE 2: paint order = big rects to back, images, then text on top
  const rank = l => l.t === 'text' ? 3 : (l.t === 'img' ? 2 : 1);
  const ordered = leaves.map((l, i) => ({ l, i })).sort((a, b) => {
    if (rank(a.l) !== rank(b.l)) return rank(a.l) - rank(b.l);
    if (a.l.t === 'rect') return (b.l.w * b.l.h) - (a.l.w * a.l.h);
    return a.i - b.i;
  }).map(o => o.l);

  for (const l of ordered) {
    if (l.t === 'rect') {
      const r = figma.createRectangle(); r.resize(Math.max(l.w, 1), Math.max(l.h, 1)); r.x = l.x; r.y = l.y;
      const pc = parseColor(l.bg); r.fills = [{ type: 'SOLID', color: pc.c, opacity: pc.o }];
      if (l.rad) { const rv = parseFloat(l.rad); r.cornerRadius = isNaN(rv) ? Math.min(l.w, l.h) / 2 : Math.min(rv, Math.min(l.w, l.h) / 2); }
      frame.appendChild(r);
    } else if (l.t === 'img') {
      // TODO Phase 2: figma.createImage(figma.base64Decode(bytes)) from downloaded asset
      const r = figma.createRectangle(); r.resize(l.w, l.h); r.x = l.x; r.y = l.y;
      r.fills = [{ type: 'SOLID', color: { r: 0.22, g: 0.22, b: 0.22 } }]; r.name = 'IMG ' + (l.src || '');
      frame.appendChild(r);
    } else {
      const t = figma.createText(); t.fontName = fontMap[l.fam]; t.fontSize = l.fs; t.characters = l.s;
      t.x = l.x; t.y = l.y; const pc = parseColor(l.col); t.fills = [{ type: 'SOLID', color: pc.c, opacity: pc.o }];
      if (l.al === 'right' || l.al === 'end') { t.textAutoResize = 'NONE'; t.resize(l.w, l.h); t.textAlignHorizontal = 'RIGHT'; }
      frame.appendChild(t);
    }
  }
  return { frameId: frame.id, fontsResolved: fontMap };
}
