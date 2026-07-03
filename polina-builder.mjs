import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolveFont } from '/Users/jaykapoor/VSC Ventures Dropbox/Jay Kapoor/_Apps/Playdeck/pipeline/font-utils.mjs';

const PORT = 8765;
const IMG = '/Users/jaykapoor/nanobanana-images';

let pluginWs = null;
const pending = new Map();

const wss = new WebSocketServer({ port: PORT });
console.log(`🔌 Listening on ${PORT}...`);

wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'PLUGIN_HELLO') {
      pluginWs = ws;
      console.log(`✅ Plugin connected`);
      setTimeout(() => build(), 500);
      return;
    }
    if (msg.type === 'HEARTBEAT') {
      ws.send(JSON.stringify({ type: 'HEARTBEAT_ACK' }));
      return;
    }
    if (msg.type === 'LOG_MESSAGE') {
      console.log(`  [plugin] ${msg.payload?.message} ${msg.payload?.data || ''}`);
      return;
    }
    // Route responses
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.result) p.resolve(msg.result);
      else p.reject(new Error(JSON.stringify(msg.error || 'fail')));
    }
    if (msg.type === 'BATCH_RESPONSE' && msg.responses) {
      for (const r of msg.responses) {
        if (r.id && pending.has(r.id)) {
          const p = pending.get(r.id);
          pending.delete(r.id);
          if (r.result) p.resolve(r.result);
          else p.reject(new Error(JSON.stringify(r.error || 'fail')));
        }
      }
    }
  });
  ws.on('close', () => { if (ws === pluginWs) pluginWs = null; });
});

function send(type, payload) {
  return new Promise((resolve, reject) => {
    if (!pluginWs) return reject(new Error('No plugin'));
    const id = randomUUID();
    const t = setTimeout(() => { pending.delete(id); reject(new Error('Timeout')); }, 30000);
    pending.set(id, {
      resolve: (r) => { clearTimeout(t); resolve(r); },
      reject: (e) => { clearTimeout(t); reject(e); }
    });
    pluginWs.send(JSON.stringify({ id, type, payload }));
  });
}

function getId(r) {
  if (r?.results?.[0]?.id) return r.results[0].id;
  if (r?.nodeId) return r.nodeId;
  if (r?.id) return r.id;
  return null;
}

async function frame(name, x, y, w, h, opts = {}) {
  const r = await send('MANAGE_NODES', { operation: 'create_frame', name, x, y, width: w, height: h, clipsContent: true, ...opts });
  return getId(r);
}

async function rect(name, x, y, w, h, opts = {}) {
  const r = await send('MANAGE_NODES', { operation: 'create_rectangle', name, x, y, width: w, height: h, ...opts });
  return getId(r);
}

async function text(characters, x, y, opts = {}) {
  // Resolve fontWeight/italic → proper Figma fontStyle string
  const { fontFamily, fontStyle } = resolveFont(opts);
  const { fontWeight: _fw, italic: _it, ...rest } = opts;
  const r = await send('MANAGE_TEXT', {
    operation: 'create', characters, x, y,
    fontFamily, fontStyle,
    ...rest
  });
  return getId(r);
}

async function ellipse(name, x, y, w, h, opts = {}) {
  const r = await send('MANAGE_NODES', { operation: 'create_ellipse', name, x, y, width: w, height: h, ...opts });
  return getId(r);
}

async function img(nodeId, path) {
  const b64 = readFileSync(path).toString('base64');
  return send('MANAGE_FILLS', { operation: 'add_image', nodeId, imageBytes: b64, scaleMode: 'FILL' });
}

// ============================================================
async function build() {
  console.log('\n🎨 Building Polina Brand Board...\n');
  try {

    // Main frame
    console.log('📐 Main frame...');
    const main = await frame('Polina Brand Board — Mystique Recreation', -1248, 1071, 2494, 1942, { fillColor: '#111111' });
    console.log(`   ID: ${main}`);

    // Background texture
    console.log('🖼️  Background...');
    const bgId = await rect('Background', 0, 0, 2494, 1942, { parentId: main, fillColor: '#111111' });
    await img(bgId, `${IMG}/polina-background.png`);

    // ============ CARD 1: Wind Turbine (Top-Left) ============
    console.log('💨 Card 1: Wind Turbine...');
    const c1 = await frame('Card - Wind Turbine', 28, 28, 720, 980, { parentId: main, fillColor: '#4A90D9', cornerRadius: 24 });
    await img(c1, `${IMG}/polina-windturbine.png`);

    // Logo + brand on card 1
    await rect('Logo Mark', 580, 32, 42, 42, { parentId: c1, fillColor: '#CCFF00', cornerRadius: 8 });
    await text('Polina', 632, 40, { parentId: c1, fontSize: 22, fontFamily: 'Inter', fontWeight: 700, fillColor: '#FFFFFF' });
    await text('®', 700, 32, { parentId: c1, fontSize: 12, fontFamily: 'Inter', fillColor: '#FFFFFF' });

    // Headline text — "Lives with" is bold italic in the reference
    await text('Powering', 40, 800, { parentId: c1, fontSize: 48, fontFamily: 'Inter', fillColor: '#FFFFFF', lineHeight: 56 });
    await text('Lives with', 40, 855, { parentId: c1, fontSize: 48, fontFamily: 'Inter', fontWeight: 700, italic: true, fillColor: '#FFFFFF', lineHeight: 56 });
    await text('Solar', 40, 910, { parentId: c1, fontSize: 48, fontFamily: 'Inter', fillColor: '#FFFFFF', lineHeight: 56 });

    // ============ CARD 2: Phone Mockup (Center) ============
    console.log('📱 Card 2: Phone Mockup...');
    const c2 = await frame('Card - Phone Mockup', 768, 28, 870, 1180, { parentId: main, fillColor: '#CCFF00', cornerRadius: 24 });

    // Hamburger menu lines
    await rect('Line 1', 40, 40, 80, 4, { parentId: c2, fillColor: '#1A1A1A' });
    await rect('Line 2', 40, 52, 60, 4, { parentId: c2, fillColor: '#1A1A1A' });
    await rect('Line 3', 40, 64, 40, 4, { parentId: c2, fillColor: '#1A1A1A' });

    // Logo
    await rect('Logo Mark', 370, 36, 36, 36, { parentId: c2, fillColor: '#1A1A1A', cornerRadius: 6 });
    await text('Polina', 414, 42, { parentId: c2, fontSize: 20, fontFamily: 'Inter', fontWeight: 700, fillColor: '#1A1A1A' });
    await text('2h', 800, 42, { parentId: c2, fontSize: 18, fontFamily: 'Inter', fillColor: '#1A1A1A' });

    // Photo
    const photo = await frame('Solar Worker Photo', 40, 100, 790, 620, { parentId: c2, fillColor: '#333', cornerRadius: 20 });
    await img(photo, `${IMG}/polina-solarworker.png`);

    // Big text — tight line height on large display type
    await text('Explore', 40, 760, { parentId: c2, fontSize: 72, fontFamily: 'Inter', fillColor: '#1A1A1A', lineHeight: 80 });
    await text('solar panel', 40, 845, { parentId: c2, fontSize: 72, fontFamily: 'Inter', fontWeight: 700, fillColor: '#1A1A1A', lineHeight: 80 });
    await text('innovations', 40, 930, { parentId: c2, fontSize: 72, fontFamily: 'Inter', fontWeight: 700, fillColor: '#1A1A1A', lineHeight: 80 });

    // ============ CARD 3: Sustainable Energy (Top-Right) ============
    console.log('🌿 Card 3: Sustainable Energy...');
    const c3 = await frame('Card - Sustainable Energy', 1658, 28, 808, 720, { parentId: main, fillColor: '#1E1E1E', cornerRadius: 24 });

    // Logo
    await rect('Logo Mark', 40, 40, 48, 48, { parentId: c3, fillColor: '#CCFF00', cornerRadius: 8 });
    await text('Polina', 100, 48, { parentId: c3, fontSize: 28, fontFamily: 'Inter', fontWeight: 700, fillColor: '#CCFF00' });
    await text('®', 195, 40, { parentId: c3, fontSize: 14, fontFamily: 'Inter', fillColor: '#CCFF00' });

    // Headlines — tight line height
    await text('Shine with', 40, 120, { parentId: c3, fontSize: 40, fontFamily: 'Inter', fillColor: '#FFFFFF', lineHeight: 48 });
    await text('Sustainable', 40, 170, { parentId: c3, fontSize: 40, fontFamily: 'Inter', fontWeight: 700, fillColor: '#FFFFFF', lineHeight: 48 });
    await text('Energy', 40, 220, { parentId: c3, fontSize: 40, fontFamily: 'Inter', fillColor: '#FFFFFF', lineHeight: 48 });

    // Body text — looser line height, slight letter spacing for readability
    await text('We work towards a sustainable energy future with environmentally friendly solar system solutions. Our goal is to ensure efficient, reliable and affordable solar energy systems for your home or business.', 40, 290, {
      parentId: c3, fontSize: 13, fontFamily: 'Inter', fillColor: '#AAAAAA', width: 720, lineHeight: 20, letterSpacing: 0.2
    });

    // Hire Now button
    const btn = await frame('Hire Now Button', 40, 380, 180, 52, { parentId: c3, fillColor: '#CCFF00', cornerRadius: 26 });
    await ellipse('Dot', 16, 16, 20, 20, { parentId: btn, fillColor: '#1A1A1A' });
    await text('Hire Now', 48, 14, { parentId: btn, fontSize: 16, fontFamily: 'Inter', fontWeight: 600, fillColor: '#1A1A1A' });

    // Play button
    await ellipse('Play Button', 240, 380, 52, 52, { parentId: c3, fillColor: '#CCFF00' });
    await text('▶', 256, 394, { parentId: c3, fontSize: 18, fontFamily: 'Inter', fillColor: '#1A1A1A' });

    // Stats
    await text('Successful Projects', 40, 480, { parentId: c3, fontSize: 13, fontFamily: 'Inter', fillColor: '#AAAAAA' });
    await text('50,000+', 40, 500, { parentId: c3, fontSize: 40, fontFamily: 'Inter', fontWeight: 700, fillColor: '#FFFFFF' });
    await rect('Divider', 400, 480, 1, 80, { parentId: c3, fillColor: '#333333' });
    await text('Trusted Clients', 450, 480, { parentId: c3, fontSize: 13, fontFamily: 'Inter', fillColor: '#AAAAAA' });
    await text('500+', 450, 500, { parentId: c3, fontSize: 40, fontFamily: 'Inter', fontWeight: 700, fillColor: '#FFFFFF' });

    // ============ CARD 4: Brand Identity (Bottom-Left) ============
    console.log('👔 Card 4: Brand Identity...');
    const c4 = await frame('Card - Brand Identity', 28, 1028, 720, 886, { parentId: main, fillColor: '#1A1A1A', cornerRadius: 24 });
    await img(c4, `${IMG}/polina-jacket.png`);

    // Overlaid phone mockup
    const phone = await frame('Phone Overlay', 40, 380, 300, 450, { parentId: c4, fillColor: '#1A1A1A', cornerRadius: 20 });
    await rect('Phone BG', 0, 0, 300, 450, { parentId: phone, fillColor: '#1A1A1A' });
    await rect('Phone Logo', 20, 20, 28, 28, { parentId: phone, fillColor: '#CCFF00', cornerRadius: 4 });
    await text('Polina', 56, 24, { parentId: phone, fontSize: 14, fontFamily: 'Inter', fontWeight: 700, fillColor: '#FFFFFF' });
    await text('®', 110, 18, { parentId: phone, fontSize: 8, fontFamily: 'Inter', fillColor: '#FFFFFF' });
    await text('Your Solar', 20, 70, { parentId: phone, fontSize: 18, fontFamily: 'Inter', fillColor: '#FFFFFF' });
    await text('Journey Starts', 20, 95, { parentId: phone, fontSize: 18, fontFamily: 'Inter', fontWeight: 700, fillColor: '#FFFFFF' });
    await text('Here', 20, 120, { parentId: phone, fontSize: 18, fontFamily: 'Inter', fontWeight: 700, fillColor: '#FFFFFF' });

    const urlBar = await frame('URL Bar', 20, 370, 260, 40, { parentId: phone, fillColor: '#CCFF00', cornerRadius: 20 });
    await text('www.polina.com', 20, 10, { parentId: urlBar, fontSize: 13, fontFamily: 'Inter', fontWeight: 500, fillColor: '#1A1A1A' });

    await text('Brand Identity', 520, 840, { parentId: c4, fontSize: 14, fontFamily: 'Inter', fillColor: '#AAAAAA' });

    // ============ CARD 5: Large Logo (Bottom-Center) ============
    console.log('✨ Card 5: Large Logo...');
    const c5 = await frame('Card - Logo', 768, 1228, 870, 686, { parentId: main, fillColor: '#111111' });

    await rect('Logo Mark', 340, 280, 72, 72, { parentId: c5, fillColor: '#CCFF00', cornerRadius: 12 });
    await text('Polina', 424, 290, { parentId: c5, fontSize: 52, fontFamily: 'Inter', fontWeight: 700, fillColor: '#FFFFFF' });
    await text('©', 608, 278, { parentId: c5, fontSize: 18, fontFamily: 'Inter', fillColor: '#FFFFFF' });

    // ============ CARD 6: T-shirt (Bottom-Right) ============
    console.log('👕 Card 6: T-shirt...');
    const c6 = await frame('Card - T-shirt', 1658, 768, 808, 490, { parentId: main, fillColor: '#1E1E1E', cornerRadius: 24 });
    await img(c6, `${IMG}/polina-tshirt.png`);
    await text('Branding', 700, 30, { parentId: c6, fontSize: 14, fontFamily: 'Inter', fillColor: '#AAAAAA' });

    // ============ CARD 7a: Logo Icon (Bottom-Right) ============
    console.log('🔷 Card 7a: Logo Icon...');
    const c7a = await frame('Card - Logo Icon', 1658, 1278, 390, 636, { parentId: main, fillColor: '#CCFF00', cornerRadius: 24 });

    // Dark rounded square with inner logo shape
    await rect('Dark Square', 115, 218, 160, 160, { parentId: c7a, fillColor: '#1A1A1A', cornerRadius: 32 });
    // Two overlapping diamonds as simplified logo
    await rect('Diamond 1', 155, 248, 60, 60, { parentId: c7a, fillColor: '#CCFF00', cornerRadius: 8 });
    await rect('Diamond 2', 185, 278, 60, 60, { parentId: c7a, fillColor: '#CCFF00', cornerRadius: 8 });

    // ============ CARD 7b: Logo Construction (Bottom-Right) ============
    console.log('🔷 Card 7b: Logo Construction...');
    const c7b = await frame('Card - Logo Construction', 2068, 1278, 398, 636, { parentId: main, fillColor: '#1E1E1E', cornerRadius: 24 });

    // Grid lines
    for (let i = 0; i < 5; i++) {
      await rect(`V${i}`, 80 + i * 60, 120, 1, 380, { parentId: c7b, fillColor: '#CCFF00' });
    }
    for (let i = 0; i < 7; i++) {
      await rect(`H${i}`, 80, 120 + i * 60, 240, 1, { parentId: c7b, fillColor: '#CCFF00' });
    }

    // Logo outlines on grid
    await rect('Outline 1', 110, 180, 80, 80, { parentId: c7b, fillColor: '#CCFF0033', cornerRadius: 8 });
    await rect('Outline 2', 190, 260, 80, 80, { parentId: c7b, fillColor: '#CCFF0033', cornerRadius: 8 });

    // Grid dots at intersections
    const dots = [];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        dots.push([80 + col * 60, 120 + row * 60]);
      }
    }
    for (let i = 0; i < dots.length; i++) {
      await ellipse(`D${i}`, dots[i][0] - 4, dots[i][1] - 4, 8, 8, { parentId: c7b, fillColor: '#CCFF00' });
    }

    console.log('\n✅ BUILD COMPLETE!');
    console.log(`   Frame: ${main}`);
    console.log('   Check Figma — recreation is below the reference.\n');

  } catch (err) {
    console.error('❌ Failed:', err.message);
    console.error(err.stack);
  }

  setTimeout(() => { wss.close(); process.exit(0); }, 3000);
}
