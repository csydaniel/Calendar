import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const DAY = 86400000;

/** Survives between warm invocations, so fonts are fetched once per instance. */
const FONT_CACHE = new Map();

/** Google's Korean fonts are megabytes, so those stay subsetted. */
const SUBSET_ONLY = /Noto Sans KR|Noto Sans JP|Noto Sans SC|Noto Sans TC/;

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

const rgba = (hex, a) => {
  const h = String(hex).replace('#', '');
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(v, 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
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

const timed = (ms, p) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
]);

/**
 * Google Fonts serves TTF (which satori needs) only to old user agents.
 * Latin families are fetched whole so the cache works across different text;
 * CJK families stay subsetted because the full files are far too large.
 */
async function loadFont(family, weight, italic, text) {
  const subset = SUBSET_ONLY.test(family);
  const key = family + '|' + weight + '|' + (italic ? 1 : 0) + (subset ? '|' + text : '');
  if (FONT_CACHE.has(key)) return FONT_CACHE.get(key);

  const url =
    'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(family) +
    ':ital,wght@' + (italic ? '1,' : '0,') + weight +
    (subset ? '&text=' + encodeURIComponent(text) : '');

  const css = await timed(3500, fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; rv:2.0) Gecko/20100101 Firefox/4.0' },
  }).then(r => (r.ok ? r.text() : '')));

  const m = css.match(/src:\s*url\(([^)]+)\)\s*format\(['"]?(truetype|opentype)/);
  if (!m) throw new Error('no ttf for ' + family);

  const data = await timed(4000, fetch(m[1]).then(r => r.arrayBuffer()));
  const face = { name: family, data, weight, style: italic ? 'italic' : 'normal' };
  FONT_CACHE.set(key, face);
  return face;
}

function decode(raw) {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(Buffer.from(pad, 'base64'))));
}

export default async function handler(req) {
  const t0 = Date.now();
  const mark = {};
  try {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const c = q.get('c') ? decode(q.get('c')) : { s: '2026-01-01', e: '2026-12-31' };

    const col   = { bg: '#000000', past: '#ffffff', left: '#2e2e33', today: '#ff9f0a', ...(c.col || {}) };
    const dot   = { shape: 'circle', fill: 62, ...(c.dot || {}) };
    const pad   = { t: 27, b: 22, x: 8, ...(c.pad || {}) };
    const off   = { x: 0, y: 0, ...(c.off || {}) };
    const week  = { on: false, start: 0, set: 'en', size: 34, color: '#8a8a90', ...(c.week || {}) };
    const bgi   = { url: '', fit: 'cover', op: 100, ...(c.bgi || {}) };
    const glass = { on: false, tint: '#ffffff', op: 12, r: 44, pad: 4, border: 18, ...(c.glass || {}) };
    const stat  = { on: false, fmt: '{done} / {total}', font: 'Inter', size: 44, b: 0, i: 0, c: '#ffffff', x: 50, y: 88, ...(c.stat || {}) };
    const texts = c.txt || [];
    const hls   = c.hl || [];

    const scale = Math.min(1, Math.max(0.25, Number(q.get('scale') || 1)));
    const [BW, BH] = (c.size || '1290x2796').split('x').map(Number);
    const W = Math.round(BW * scale), H = Math.round(BH * scale);
    const k = scale;

    const start = parse(c.s || '2026-01-01');
    const end = parse(c.e || '2026-12-31');

    const tz = Number(c.tz ?? 9);
    const now = new Date(Date.now() + tz * 3600000);
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    const n = Math.max(1, between(start, end) + 1);
    const passed = Math.min(Math.max(between(start, today), -1), n);
    const done = Math.min(Math.max(passed + 1, 0), n);

    if (q.get('debug')) {
      return new Response(JSON.stringify({
        ok: true, n, done, tz, size: [W, H],
        serverNowUTC: new Date().toISOString(),
        fontsCached: [...FONT_CACHE.keys()], config: c,
      }, null, 2), { headers: { 'content-type': 'application/json' } });
    }

    // ---- geometry ----
    const areaX = W * pad.x / 100;
    const areaW = W * (1 - 2 * pad.x / 100);
    const areaY = H * pad.t / 100;
    const areaH = H * (1 - pad.t / 100 - pad.b / 100);

    const labelSet = LABELS[week.set] || LABELS.en;
    const labelFont = week.set === 'ko' ? 'Noto Sans KR' : 'Inter';
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
    const gridW = cols * pitch;
    const gridH = rows * pitch + labelH;
    const ox = areaX + (areaW - gridW) / 2 + W * off.x / 100;
    const oy = areaY + (areaH - gridH) / 2 + H * off.y / 100;

    const ringFor = i => hls.find(h => {
      if (!h.f || !h.t) return false;
      const a = between(start, parse(h.f)), b = between(start, parse(h.t));
      return i >= Math.min(a, b) && i <= Math.max(a, b);
    });

    const kids = [];
    const box = (style, children) =>
      kids.push({ type: 'div', props: { style: { position: 'absolute', ...style }, children } });

    if (bgi.url) {
      kids.push({
        type: 'img',
        props: {
          src: bgi.url,
          style: { position: 'absolute', left: 0, top: 0, width: W, height: H, objectFit: bgi.fit, opacity: bgi.op / 100 },
        },
      });
    }

    if (glass.on) {
      const gp = glass.pad / 100 * W;
      box({
        left: ox - gp, top: oy - gp, width: gridW + gp * 2, height: gridH + gp * 2,
        borderRadius: glass.r * k, backgroundColor: rgba(glass.tint, glass.op / 100),
        border: `${Math.max(1, 2 * k)}px solid ${rgba('#ffffff', glass.border / 100)}`,
        display: 'flex',
      });
    }

    if (week.on) {
      for (let i = 0; i < 7; i++) {
        box({
          left: ox + i * pitch, top: oy, width: pitch, height: labelH,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: week.color, fontSize: labelSize, fontFamily: labelFont,
        }, labelSet[(i + Number(week.start)) % 7]);
      }
    }

    for (let i = 0; i < n; i++) {
      const idx = lead + i;
      const cx = ox + (idx % cols) * pitch + pitch / 2;
      const cy = oy + labelH + Math.floor(idx / cols) * pitch + pitch / 2;
      const spin = dot.shape === 'diamond' ? 'rotate(45deg)' : 'none';

      box({
        left: cx - dw / 2, top: cy - dh / 2, width: dw, height: dh,
        borderRadius: dr, backgroundColor: i < passed ? col.past : i === passed ? col.today : col.left,
        display: 'flex', transform: spin,
      });

      const hit = ringFor(i);
      if (hit) {
        const rw = Math.max(1, (hit.w ?? 8) / 100 * pitch);
        const gap = (hit.g ?? 8) / 100 * pitch;
        const ow = dw + (gap + rw) * 2, oh = dh + (gap + rw) * 2;
        box({
          left: cx - ow / 2, top: cy - oh / 2, width: ow, height: oh,
          borderRadius: dr > 0 ? dr + gap + rw : 0,
          border: `${rw}px solid ${hit.c}`, display: 'flex', transform: spin,
        });
      }
    }

    const fmt = s => String(s)
      .replace(/{done}/g, done).replace(/{total}/g, n).replace(/{left}/g, n - done)
      .replace(/{pct}/g, (done / n * 100).toFixed(1) + '%')
      .replace(/{date}/g, new Date(today).toISOString().slice(0, 10));

    const place = t => box(
      { left: 0, top: 0, width: W, height: H, display: 'flex', alignItems: 'flex-start', justifyContent: 'center' },
      {
        type: 'div',
        props: {
          style: {
            display: 'flex',
            transform: `translate(${(t.x - 50) / 100 * W}px, ${t.y / 100 * H}px)`,
            color: t.c, fontSize: t.size * k, fontFamily: t.font,
            fontWeight: t.b ? 700 : 400, fontStyle: t.i ? 'italic' : 'normal',
            whiteSpace: 'pre',
          },
          children: fmt(t.s),
        },
      }
    );

    for (const t of texts) place(t);
    if (stat.on) place({ ...stat, s: stat.fmt });
    mark.build = Date.now() - t0;

    // ---- fonts, with a hard ceiling on total time ----
    let fonts = [];
    if (!q.get('nofont')) {
      const want = new Map();
      const need = (family, weight, italic, text) => {
        const kk = family + '|' + weight + '|' + (italic ? 1 : 0);
        if (!want.has(kk)) want.set(kk, { family, weight, italic, text: '' });
        want.get(kk).text += text;
      };
      for (const t of texts) need(t.font, t.b ? 700 : 400, !!t.i, fmt(t.s));
      if (stat.on) need(stat.font, stat.b ? 700 : 400, !!stat.i, fmt(stat.fmt));
      if (week.on) need(labelFont, 400, false, labelSet.join(''));
      if (!want.size) need('Inter', 400, false, 'A');

      const jobs = [...want.values()].map(f =>
        loadFont(f.family, f.weight, f.italic, f.text + '0123456789/%.,:- ').catch(() => null)
      );
      // Whatever has arrived within the budget gets used; the rest is dropped.
      const budget = new Promise(res => setTimeout(() => res(null), 9000));
      await Promise.race([Promise.all(jobs), budget]);
      fonts = (await Promise.all(jobs.map(j => Promise.race([j, Promise.resolve(null)])))).filter(Boolean);
    }
    mark.fonts = Date.now() - t0;

    if (q.get('timing')) {
      return new Response(JSON.stringify({
        marks: mark, elements: kids.length, fontsLoaded: fonts.map(f => f.name + ' ' + f.weight),
      }, null, 2), { headers: { 'content-type': 'application/json' } });
    }

    return new ImageResponse(
      {
        type: 'div',
        props: {
          style: { position: 'relative', display: 'flex', width: W, height: H, backgroundColor: col.bg },
          children: kids,
        },
      },
      {
        width: W, height: H,
        fonts: fonts.length ? fonts : undefined,
        headers: {
          'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
          'x-render-ms': String(Date.now() - t0),
        },
      }
    );
  } catch (err) {
    return new Response('Wallpaper error after ' + (Date.now() - t0) + 'ms: ' + (err?.stack || String(err)), {
      status: 500, headers: { 'content-type': 'text/plain' },
    });
  }
}
