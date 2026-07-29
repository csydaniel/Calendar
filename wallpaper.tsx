import { ImageResponse } from '@vercel/og';

export const config = { runtime: 'edge' };

const DAY = 86400000;
const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const between = (a: number, b: number) => Math.round((b - a) / DAY);

/** Largest dot pitch that fits n cells inside w × h. */
function solve(n: number, w: number, h: number) {
  let best = { pitch: 0, cols: 1, rows: n };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const pitch = Math.min(w / cols, h / rows);
    if (pitch > best.pitch) best = { pitch, cols, rows };
  }
  return best;
}

const radius = (shape: string, r: number) =>
  shape === 'circle' ? r : shape === 'squircle' ? r * 0.42 : 0;

export default function handler(req: Request) {
  const q = new URL(req.url).searchParams;
  const g = (k: string, d: string) => q.get(k) ?? d;
  const hex = (k: string, d: string) => '#' + g(k, d).replace('#', '');

  const [W, H] = g('size', '1290x2796').split('x').map(Number);
  const start = parse(g('start', '2026-01-01'));
  const end = parse(g('end', '2026-12-31'));

  // Server clock is UTC; tz is an hour offset so midnight lands locally.
  const tz = Number(g('tz', '8'));
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

  const cells = [];
  for (let i = 0; i < n; i++) {
    const fill =
      i < passed ? hex('past', 'ffffff')
      : i === passed ? hex('today', 'ff9f0a')
      : hex('left', '2e2e33');
    const hit = rings.find(r => i >= r.lo && i <= r.hi);

    cells.push(
      <div
        key={i}
        style={{
          display: 'flex',
          width: pitch,
          height: pitch,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            display: 'flex',
            width: hit ? ringSize : d,
            height: hit ? ringSize : d,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radius(shape, (hit ? ringSize : d) / 2),
            border: hit ? `${ringW}px solid ${hit.color}` : 'none',
          }}
        >
          <div
            style={{
              width: d,
              height: d,
              borderRadius: radius(shape, d / 2),
              background: fill,
              transform: shape === 'diamond' ? 'rotate(45deg)' : 'none',
            }}
          />
        </div>
      </div>
    );
  }

  return new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          width: W,
          height: H,
          background: hex('bg', '000000'),
          alignItems: 'center',
          justifyContent: 'center',
          paddingTop: H * topPct,
          paddingBottom: H * botPct,
          paddingLeft: W * sidePct,
          paddingRight: W * sidePct,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            width: cols * pitch,
            alignContent: 'center',
            justifyContent: 'flex-start',
          }}
        >
          {cells}
        </div>
      </div>
    ),
    {
      width: W,
      height: H,
      headers: { 'cache-control': 'public, max-age=0, s-maxage=300' },
    }
  );
}
