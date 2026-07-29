import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

const DAY = 86400000;
const el = (style, children) => ({ type: 'div', props: { style, children } });

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

/** Largest dot pitch that fits n cells inside w x h. */
function solve(n, w, h) {
  let best = { pitch: 0, cols: 1, rows: n };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const pitch = Math.min(w / cols, h / rows);
    if (pitch > best.pitch) best = { pitch, cols, rows };
  }
  return best;
}

const radius = (shape, r) =>
  shape === 'circle' ? r : shape === 'squircle' ? r * 0.42 : 0;

/**
 * Google Fonts serves TTF (which satori needs) only to old user agents.
 * `text` subsets the file so Korean families stay small.
 */
async function loadFont(family, weight, italic, text) {
  const url =
    'https://fonts.googleapis.com/css2?family=' +
    encodeURIComponent(family) +
    ':ital,wght@' + (italic ? '1,' : '0,') + weight +
    '&text=' + encodeURIComponent(text) +
    '&display=swap';

  const css = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; rv:2.0) Gecko/20100101 Firefox/4.0' },
  }).then(r => (r.ok ? r.text() : ''));

  const src = css.match(/src:\s*url\(([^)]+)\)\s*format\(['"]?(truetype|opentype)/);
  if (!src) return null;
  const data = await fetch(src[1]).then(r => r.arrayBuffer());
  return { name: family, data, weight, style: italic ? 'italic' : 'normal' };
}

function decode(raw) {
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default async function handler(req) {
  try {
    const q = new URL(req.url).searchParams;
    const c = q.get('c') ? decode(q.get('c')) : { s: '2026-01-01', e: '2026-12-31' };

    const col  = { bg: '#000000', past: '#ffffff', left: '#2e2e33', today: '#ff9f0a', ...(c.col || {}) };
    const dot  = { shape: 'circle', fill: 62, ...(c.dot || {}) };
    const pad  = { t: 27, b: 22, x: 8, ...(c.pad || {}) };
    const off  = { x: 0, y: 0, ...(c.off || {}) };
    const week = { on: false, start: 0, set: 'en', size: 34, color: '#8a8a90', ...(c.week || {}) };
    const bgi  = { url: '', fit: 'cover', op: 100, ...(c.bgi || {}) };
    const stat = { on: false, fmt: '{done} / {total}', font: 'Inter', size: 44, b: 0, i: 0, c: '#ffffff', x: 50, y: 88, ...(c.stat || {}) };
    const texts = c.txt || [];
    const hls = c.hl || [];

    const [W, H] = (c.size || '1290x2796').split('x').map(Number);
    const start = parse(c.s || '2026-01-01');
    const end = parse(c.e || '2026-12-31');

    // Server clock is UTC; tz shifts it so the dot turns over at local midnight.
    const tz = Number(c.tz ?? 9);
    const now = new Date(Date.now() + tz * 3600000);
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    const n = Math.max(1, between(start, end) + 1);
    const passed = Math.min(Math.max(between(start, today), -1), n);
    const done = Math.min(Math.max(passed + 1, 0), n);

    if (q.get('debug')) {
      return new Response(
        JSON.stringify({ n, done, passed, tz, serverNow: new Date().toISOString(), config: c }, null, 2),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    // ---- geometry ----
    const areaX = W * (pad.x / 100);
    const areaW = W * (1 - 2 * pad.x / 100);
    const areaY = H * (pad.t / 100);
    const areaH = H * (1 - pad.t / 100 - pad.b / 100);

    const labelSet = LABELS[week.set] || LABELS.en;
    const labelH = week.on ? week.size * 1.9 : 0;

    let cols, rows, pitch, lead = 0;
    if (week.on) {
      cols = 7;
      lead = (new Date(start).getUTCDay() - week.start + 7) % 7;
      rows = Math.ceil((lead + n) / 7);
      pitch = Math.min(areaW / 7, (areaH - labelH) / rows);
    } else {
      const s = solve(n, areaW, areaH);
      cols = s.cols; rows = s.rows; pitch = s.pitch;
    }

    const d = pitch * (dot.fill / 100);
    const gridW = cols * pitch;
    const gridH = rows * pitch + labelH;
    const ox = areaX + (areaW - gridW) / 2 + W * (off.x / 100);
    const oy = areaY + (areaH - gridH) / 2 + H * (off.y / 100);

    const ringFor = i => hls.find(h => {
      const a = between(start, parse(h.f)), b = between(start, parse(h.t));
      return i >= Math.min(a, b) && i <= Math.max(a, b);
    });

    const cells = [];
    for (let k = 0; k < lead; k++) cells.push(el({ display: 'flex', width: pitch, height: pitch }));

    for (let i = 0; i < n; i++) {
      const fill = i < passed ? col.past : i === passed ? col.today : col.left;
      const hit = ringFor(i);
      const rw = hit ? Math.max(1, (hit.w ?? 7.5) / 100 * pitch) : 0;
      const gap = hit ? (hit.g ?? 8) / 100 * pitch : 0;
      const outer = hit ? d + (gap + rw) * 2 : d;

      cells.push(
        el(
          { display: 'flex', width: pitch, height: pitch, alignItems: 'center', justifyContent: 'center' },
          el(
            {
              display: 'flex', width: outer, height: outer,
              alignItems: 'center', justifyContent: 'center',
              borderRadius: radius(dot.shape, outer / 2),
              border: hit ? rw + 'px solid ' + hit.c : '0px solid transparent',
            },
            el({
              display: 'flex', width: d, height: d,
              borderRadius: radius(dot.shape, d / 2),
              backgroundColor: fill,
              transform: dot.shape === 'diamond' ? 'rotate(45deg)' : 'none',
            })
          )
        )
      );
    }

    const layers = [];

    if (bgi.url) {
      layers.push({
        type: 'img',
        props: {
          src: bgi.url,
          style: {
            position: 'absolute', left: 0, top: 0, width: W, height: H,
            objectFit: bgi.fit, opacity: bgi.op / 100,
          },
        },
      });
    }

    if (week.on) {
      layers.push(
        el(
          { position: 'absolute', left: ox, top: oy, display: 'flex', width: gridW, height: labelH },
          labelSet.map((_, k) =>
            el(
              {
                display: 'flex', width: pitch, height: labelH,
                alignItems: 'center', justifyContent: 'center',
                color: week.color, fontSize: week.size, fontFamily: 'Inter',
              },
              labelSet[(k + week.start) % 7]
            )
          )
        )
      );
    }

    layers.push(
      el(
        { position: 'absolute', left: ox, top: oy + labelH, display: 'flex', flexWrap: 'wrap', width: gridW, alignContent: 'flex-start' },
        cells
      )
    );

    const fmt = s =>
      String(s)
        .replace(/{done}/g, done)
        .replace(/{total}/g, n)
        .replace(/{left}/g, n - done)
        .replace(/{pct}/g, ((done / n) * 100).toFixed(1) + '%')
        .replace(/{date}/g, new Date(today).toISOString().slice(0, 10));

    const place = t =>
      el(
        { position: 'absolute', left: 0, top: 0, width: W, height: H, display: 'flex', alignItems: 'flex-start', justifyContent: 'center' },
        el(
          {
            display: 'flex',
            transform: `translate(${(t.x - 50) / 100 * W}px, ${t.y / 100 * H}px)`,
            color: t.c,
            fontSize: t.size,
            fontFamily: t.font,
            fontWeight: t.b ? 700 : 400,
            fontStyle: t.i ? 'italic' : 'normal',
            whiteSpace: 'pre',
          },
          fmt(t.s)
        )
      );

    for (const t of texts) layers.push(place(t));
    if (stat.on) layers.push(place({ ...stat, s: stat.fmt }));

    // ---- load only the font faces actually used ----
    const used = new Map();
    const need = (family, weight, italic, text) => {
      const key = family + '|' + weight + '|' + (italic ? 1 : 0);
      if (!used.has(key)) used.set(key, { family, weight, italic, text: '' });
      used.get(key).text += text;
    };
    for (const t of texts) need(t.font, t.b ? 700 : 400, !!t.i, fmt(t.s));
    if (stat.on) need(stat.font, stat.b ? 700 : 400, !!stat.i, fmt(stat.fmt));
    if (week.on) need('Inter', 400, false, labelSet.join(''));
    if (!used.size) need('Inter', 400, false, 'A');

    const fonts = (
      await Promise.all(
        [...used.values()].map(f =>
          loadFont(f.family, f.weight, f.italic, f.text + '0123456789/%.,:- ').catch(() => null)
        )
      )
    ).filter(Boolean);

    return new ImageResponse(
      el({ position: 'relative', display: 'flex', width: W, height: H, backgroundColor: col.bg }, layers),
      {
        width: W,
        height: H,
        fonts: fonts.length ? fonts : undefined,
        headers: { 'cache-control': 'no-store, max-age=0' },
      }
    );
  } catch (err) {
    return new Response('Wallpaper error: ' + (err && err.stack ? err.stack : err), {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    });
  }
}
