import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

const DAY = 86400000;

const parse = s => {
  const [y, m, d] = String(s).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const between = (a, b) => Math.round((b - a) / DAY);

/** Element helper — satori reads this shape directly, so no JSX is needed. */
const el = (style, children) => ({ type: 'div', props: { style, children } });

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

export default function handler(req) {
  try {
    const q = new URL(req.url).searchParams;
    const g = (k, d) => q.get(k) ?? d;
    const hex = (k, d) => '#' + g(k, d).replace('#', '');

    const [W, H] = g('size', '1290x2796').split('x').map(Number);
    const start = parse(g('start', '2026-01-01'));
    const end = parse(g('end', '2026-12-31'));

    // Server clock is UTC; tz shifts it so the dot turns over at local midnight.
    const tz = Number(g('tz', '9'));
    const now = new Date(Date.now() + tz * 3600000);
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    const n = Math.max(1, between(start, end) + 1);
    const passed = Math.min(Math.max(between(start, today), -1), n);

    const topPct = Number(g('top', '27')) / 100;
    const botPct = Number(g('bottom', '22')) / 100;
    const sidePct = Number(g('side', '8')) / 100;

    const areaW = W * (1 - 2 * sidePct);
    const areaH = H * (1 - topPct - botPct);
    const { pitch, cols } = solve(n, areaW, areaH);

    const shape = g('shape', 'circle');
    const d = pitch * (Number(g('fill', '62')) / 100);
    const ringW = Math.max(1.5, pitch * 0.075);
    const ringSize = d + ringW * 3.2;

    const rings = q.getAll('hl').map(s => {
      const [from, to, color] = s.split(':');
      const a = between(start, parse(from));
      const b = between(start, parse(to));
      return { lo: Math.min(a, b), hi: Math.max(a, b), color: '#' + color };
    });

    const cPast = hex('past', 'ffffff');
    const cToday = hex('today', 'ff9f0a');
    const cLeft = hex('left', '2e2e33');

    const cells = [];
    for (let i = 0; i < n; i++) {
      const fill = i < passed ? cPast : i === passed ? cToday : cLeft;
      const hit = rings.find(r => i >= r.lo && i <= r.hi);
      const outer = hit ? ringSize : d;

      cells.push(
        el(
          { display: 'flex', width: pitch, height: pitch, alignItems: 'center', justifyContent: 'center' },
          el(
            {
              display: 'flex',
              width: outer,
              height: outer,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius(shape, outer / 2),
              border: hit ? ringW + 'px solid ' + hit.color : '0px solid transparent',
            },
            el({
              display: 'flex',
              width: d,
              height: d,
              borderRadius: radius(shape, d / 2),
              backgroundColor: fill,
              transform: shape === 'diamond' ? 'rotate(45deg)' : 'none',
            })
          )
        )
      );
    }

    const tree = el(
      {
        display: 'flex',
        width: W,
        height: H,
        backgroundColor: hex('bg', '000000'),
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: H * topPct,
        paddingBottom: H * botPct,
        paddingLeft: W * sidePct,
        paddingRight: W * sidePct,
      },
      el(
        {
          display: 'flex',
          flexWrap: 'wrap',
          width: cols * pitch,
          alignContent: 'center',
          justifyContent: 'flex-start',
        },
        cells
      )
    );

    return new ImageResponse(tree, {
      width: W,
      height: H,
      headers: { 'cache-control': 'public, max-age=0, s-maxage=300' },
    });
  } catch (err) {
    return new Response('Wallpaper error: ' + err.message, {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    });
  }
}
