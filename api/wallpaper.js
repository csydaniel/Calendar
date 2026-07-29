import https from 'node:https';
import { readConfig } from './config.js';
import { Surface, encodePNG, decodePNG, pathToPolys } from './_render.js';

const DAY = 86400000;
const FONT_CACHE = new Map();
const IMG_CACHE = new Map();

const parse = s => {
  const [y, m, d] = String(s).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const between = (a, b) => Math.round((b - a) / DAY);

const LABELS = {
  en: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
  en2: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'],
  ko: ['일', '월', '화', '수', '목', '금', '토'],
};

function solve(n, w, h) {
  let best = { pitch: 0, cols: 1, rows: n };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const pitch = Math.min(w / cols, h / rows);
    if (pitch > best.pitch) best = { pitch, cols, rows };
  }
  return best;
}

/** [width, height, cornerRadius] for a dot of nominal size d. */
function dims(shape, d) {
  if (shape === 'pill') return [d, d * 0.5, d * 0.25];
  if (shape === 'circle') return [d, d, d / 2];
  if (shape === 'squircle') return [d, d, d * 0.28];
  return [d, d, 0];
}

/**
 * Node's fetch pools keep-alive sockets, and Lambda will not finish an
 * invocation while the event loop still has one open -- that is a timeout even
 * though the image was already built. node:https with keepAlive off closes the
 * socket, and destroy() on timeout guarantees nothing is left behind.
 */
function grab(url, ms, headers = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers,
      agent: new https.Agent({ keepAlive: false }),
      timeout: ms,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 3) {
        res.resume();
        return grab(res.headers.location, ms, headers, hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('http ' + res.statusCode)); }
      const parts = [];
      res.on('data', d => parts.push(d));
      res.on('end', () => resolve(Buffer.concat(parts)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', err => { req.destroy(); reject(err); });
    setTimeout(() => req.destroy(new Error('deadline')), ms + 200).unref();
  });
}

/** Google Fonts serves TTF only to old user agents; opentype needs TTF. */
async function loadFont(family, weight, italic) {
  const key = `${family}|${weight}|${italic ? 1 : 0}`;
  if (FONT_CACHE.has(key)) return FONT_CACHE.get(key);

  const url = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(family) +
    ':ital,wght@' + (italic ? '1,' : '0,') + weight;
  const css = (await grab(url, 2500, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; rv:2.0) Gecko/20100101 Firefox/4.0',
  })).toString('utf8');

  const m = css.match(/src:\s*url\(([^)]+)\)\s*format\(['"]?(truetype|opentype)/);
  if (!m) throw new Error('no ttf for ' + family);

  const buf = await grab(m[1], 3000);
  const opentype = (await import('opentype.js')).default;
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  FONT_CACHE.set(key, font);
  return font;
}

async function loadImage(url) {
  if (IMG_CACHE.has(url)) return IMG_CACHE.get(url);
  const buf = await grab(url, 4000);
  const img = decodePNG(buf);
  IMG_CACHE.set(url, img);
  return img;
}

function decode(raw) {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
}

/** Vercel's Node runtime gives (req, res); the response must be written here. */
function send(res, status, type, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.end(body);
}

export default async function handler(req, res) {
  const t0 = Date.now();
  const mark = {};
  try {
    const q = req.query && Object.keys(req.query).length
      ? new URLSearchParams(req.query)
      : new URL(req.url || '/', 'http://localhost').searchParams;

    // A truncated or mangled code must fail loudly. Silently drawing defaults
    // looks like "my settings were ignored" and hides the real problem.
    let c = null;
    let source = 'defaults';
    const rawC = q.get('c');

    // No code in the URL: fall back to whatever was last saved on the site, so
    // the plain /api/wallpaper address stays correct forever.
    if (!rawC) {
      try {
        const saved = await readConfig();
        if (saved?.config?.image) { c = saved.config.image; source = 'stored'; }
      } catch { /* storage not configured; defaults are fine */ }
    }
    if (!c) c = { s: '2026-01-01', e: '2026-12-31' };
    if (rawC) {
      source = 'url';
      try { c = decode(rawC); }
      catch {
        return send(res, 400, 'text/plain',
          'The config code in this URL is incomplete or damaged (' + rawC.length +
          ' characters received). Copy the Shortcut URL again with the Copy button rather than by selecting the text.');
      }
    }

    const col   = { bg: '#000000', past: '#ffffff', left: '#2e2e33', today: '#ff9f0a', ...(c.col || {}) };
    const dot   = { shape: 'circle', fill: 62, ...(c.dot || {}) };
    const pad   = { t: 27, b: 22, x: 8, ...(c.pad || {}) };
    const off   = { x: 0, y: 0, ...(c.off || {}) };
    const week  = { on: false, start: 0, set: 'en', size: 34, color: '#8a8a90', ...(c.week || {}) };
    const bgi   = { url: '', fit: 'cover', op: 100, ...(c.bgi || {}) };
    const glass = { on: false, tint: '#ffffff', op: 12, r: 44, pad: 4, border: 18, blur: 40, ...(c.glass || {}) };
    const stat  = { on: false, fmt: '{done} / {total}', font: 'Inter', size: 44, b: 0, i: 0, c: '#ffffff', x: 50, y: 88, ...(c.stat || {}) };
    const texts = c.txt || [];
    const hls   = c.hl || [];

    const k = Math.min(1, Math.max(0.25, Number(q.get('scale') || 1)));
    const [BW, BH] = (c.size || '1290x2796').split('x').map(Number);
    const W = Math.round(BW * k), H = Math.round(BH * k);

    const start = parse(c.s || '2026-01-01');
    const end = parse(c.e || '2026-12-31');
    const tz = Number(c.tz ?? 9);
    const now = new Date(Date.now() + tz * 3600000);
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    const n = Math.max(1, between(start, end) + 1);
    const passed = Math.min(Math.max(between(start, today), -1), n);
    const done = Math.min(Math.max(passed + 1, 0), n);

    if (q.get('debug')) {
      return send(res, 200, 'application/json', JSON.stringify({
        ok: true, n, done, tz, size: [W, H],
        serverNowUTC: new Date().toISOString(),
        cachedFonts: [...FONT_CACHE.keys()], config: c,
      }, null, 2));
    }

    const fmt = s => String(s)
      .replace(/{done}/g, done).replace(/{total}/g, n).replace(/{left}/g, n - done)
      .replace(/{pct}/g, (done / n * 100).toFixed(1) + '%')
      .replace(/{date}/g, new Date(today).toISOString().slice(0, 10));

    // ---- fonts up front so text can be measured ----
    const items = [...texts.map(t => ({ ...t })), ...(stat.on ? [{ ...stat, s: stat.fmt }] : [])];
    const labelSet = LABELS[week.set] || LABELS.en;
    const labelFont = week.set === 'ko' ? 'Noto Sans KR' : 'Inter';
    if (week.on) items.push({ s: '', font: labelFont, b: 0, i: 0, _label: true });

    const wanted = new Map();
    for (const t of items) wanted.set(`${t.font}|${t.b ? 700 : 400}|${t.i ? 1 : 0}`, t);
    const loaded = new Map();
    if (!q.get('nofont')) {
      await Promise.all([...wanted.entries()].map(async ([kk, t]) => {
        try { loaded.set(kk, await loadFont(t.font, t.b ? 700 : 400, !!t.i)); } catch {}
      }));
    }
    mark.fonts = Date.now() - t0;

    // ---- geometry ----
    const areaX = W * pad.x / 100, areaW = W * (1 - 2 * pad.x / 100);
    const areaY = H * pad.t / 100, areaH = H * (1 - pad.t / 100 - pad.b / 100);
    const labelSize = week.size * k;
    const labelH = week.on ? labelSize * 1.9 : 0;

    let cols, rows, pitch, lead = 0;
    if (week.on) {
      cols = 7;
      lead = (new Date(start).getUTCDay() - Number(week.start) + 7) % 7;
      rows = Math.ceil((lead + n) / 7);
      pitch = Math.min(areaW / 7, (areaH - labelH) / rows);
    } else {
      const r = solve(n, areaW, areaH);
      cols = r.cols; rows = r.rows; pitch = r.pitch;
    }

    const d = pitch * dot.fill / 100;
    const [dw, dh, dr] = dims(dot.shape, d);
    const spin = dot.shape === 'diamond';
    const gridW = cols * pitch, gridH = rows * pitch + labelH;
    const ox = areaX + (areaW - gridW) / 2 + W * off.x / 100;
    const oy = areaY + (areaH - gridH) / 2 + H * off.y / 100;

    // ---- paint ----
    const surf = new Surface(W, H);
    surf.fill(col.bg);

    if (bgi.url) {
      try { surf.drawImage(await loadImage(bgi.url), bgi.fit, bgi.op / 100); }
      catch { /* leave the flat background in place */ }
    }
    mark.bg = Date.now() - t0;

    if (glass.on) {
      const gp = glass.pad / 100 * W;
      const gx = ox - gp, gy = oy - gp, gw = gridW + gp * 2, gh = gridH + gp * 2;
      if (glass.blur > 0) surf.blurRegion(gx, gy, gw, gh, glass.blur * k);
      surf.roundRect(gx + gw / 2, gy + gh / 2, gw, gh, glass.r * k, glass.tint, glass.op / 100);
      surf.strokeRoundRect(gx + gw / 2, gy + gh / 2, gw, gh, glass.r * k, Math.max(1, 2 * k), '#ffffff', glass.border / 100);
    }

    const ringFor = i => hls.find(h => {
      if (!h.f || !h.t) return false;
      const a = between(start, parse(h.f)), b = between(start, parse(h.t));
      return i >= Math.min(a, b) && i <= Math.max(a, b);
    });

    for (let i = 0; i < n; i++) {
      const idx = lead + i;
      const cx = ox + (idx % cols) * pitch + pitch / 2;
      const cy = oy + labelH + Math.floor(idx / cols) * pitch + pitch / 2;
      surf.roundRect(cx, cy, dw, dh, dr, i < passed ? col.past : i === passed ? col.today : col.left, 1, spin);
      const hit = ringFor(i);
      if (hit) {
        const rw = Math.max(1, (hit.w ?? 8) / 100 * pitch);
        const gap = (hit.g ?? 8) / 100 * pitch;
        surf.strokeRoundRect(cx, cy, dw + (gap + rw) * 2, dh + (gap + rw) * 2,
          dr > 0 ? dr + gap + rw : 0, rw, hit.c, 1, spin);
      }
    }
    mark.dots = Date.now() - t0;

    const drawText = (font, str, size, color, cx, baseline) => {
      if (!font || !str) return;
      const wpx = font.getAdvanceWidth(str, size);
      const p = font.getPath(str, cx - wpx / 2, baseline, size);
      surf.fillPolys(pathToPolys(p), color);
    };

    if (week.on) {
      const font = loaded.get(`${labelFont}|400|0`);
      for (let i = 0; i < 7; i++)
        drawText(font, labelSet[(i + Number(week.start)) % 7], labelSize, week.color,
          ox + i * pitch + pitch / 2, oy + labelH / 2 + labelSize * 0.35);
    }

    for (const t of items) {
      if (t._label) continue;
      const font = loaded.get(`${t.font}|${t.b ? 700 : 400}|${t.i ? 1 : 0}`);
      const size = t.size * k;
      drawText(font, fmt(t.s), size, t.c, W / 2 + (t.x - 50) / 100 * W, t.y / 100 * H + size * 0.8);
    }
    mark.text = Date.now() - t0;

    const png = encodePNG(W, H, surf.data);
    mark.encode = Date.now() - t0;

    if (q.get('timing')) {
      return send(res, 200, 'application/json', JSON.stringify({
        marks: mark, bytes: png.length, days: n, fonts: [...loaded.keys()],
      }, null, 2));
    }

    res.setHeader('x-render-ms', String(Date.now() - t0));
    res.setHeader('x-config', source);
    return send(res, 200, 'image/png', png);
  } catch (err) {
    return send(res, 500, 'text/plain',
      'Wallpaper error after ' + (Date.now() - t0) + 'ms: ' + (err?.stack || String(err)));
  }
}
