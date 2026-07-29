import zlib from 'node:zlib';

/* ------------------------------------------------------------------ *
 * PNG encoding
 * ------------------------------------------------------------------ */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA bytes -> PNG buffer. Filter 0 on every row keeps this fast. */
export function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 4 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * PNG decoding — only what a background image needs
 * ------------------------------------------------------------------ */

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let p = 8, w = 0, h = 0, depth = 0, type = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const name = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (name === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; type = data[9];
    } else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6)) throw new Error('unsupported PNG format');

  const ch = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8ClampedArray(w * h * 4);
  const line = Buffer.alloc(stride);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch, d = (y * w + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
      out[d + 3] = ch === 4 ? line[s + 3] : 255;
    }
    prev = Buffer.from(line);
  }
  return { width: w, height: h, data: out };
}

/* ------------------------------------------------------------------ *
 * Surface
 * ------------------------------------------------------------------ */

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h.slice(0, 6);
  const n = parseInt(v, 16);
  return Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class Surface {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
  fill(hex) {
    const [r, g, b] = hexToRgb(hex);
    const d = this.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
  }
  blend(x, y, r, g, b, a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4, d = this.data, inv = 1 - a;
    d[i] = r * a + d[i] * inv;
    d[i + 1] = g * a + d[i + 1] * inv;
    d[i + 2] = b * a + d[i + 2] * inv;
    d[i + 3] = Math.max(d[i + 3], a * 255);
  }

  /** Signed distance to a rounded rectangle, optionally rotated 45°. */
  static sdf(px, py, cx, cy, hw, hh, r, spin) {
    let dx = px - cx, dy = py - cy;
    if (spin) { const s = Math.SQRT1_2; const nx = (dx + dy) * s, ny = (dy - dx) * s; dx = nx; dy = ny; }
    const qx = Math.abs(dx) - (hw - r), qy = Math.abs(dy) - (hh - r);
    const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
    return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
  }

  roundRect(cx, cy, w, h, r, hex, alpha = 1, spin = false) {
    const [cr, cg, cb] = hexToRgb(hex);
    const hw = w / 2, hh = h / 2;
    const rad = Math.min(r, Math.min(hw, hh));
    const reach = spin ? Math.hypot(hw, hh) : Math.max(hw, hh);
    const x0 = Math.max(0, Math.floor(cx - reach - 1)), x1 = Math.min(this.w - 1, Math.ceil(cx + reach + 1));
    const y0 = Math.max(0, Math.floor(cy - reach - 1)), y1 = Math.min(this.h - 1, Math.ceil(cy + reach + 1));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const sd = Surface.sdf(x + 0.5, y + 0.5, cx, cy, hw, hh, rad, spin);
        const cov = Math.min(1, Math.max(0, 0.5 - sd));
        if (cov > 0) this.blend(x, y, cr, cg, cb, cov * alpha);
      }
  }

  strokeRoundRect(cx, cy, w, h, r, lw, hex, alpha = 1, spin = false) {
    const [cr, cg, cb] = hexToRgb(hex);
    const hw = w / 2, hh = h / 2;
    const rad = Math.min(r, Math.min(hw, hh));
    const reach = (spin ? Math.hypot(hw, hh) : Math.max(hw, hh)) + lw;
    const x0 = Math.max(0, Math.floor(cx - reach - 1)), x1 = Math.min(this.w - 1, Math.ceil(cx + reach + 1));
    const y0 = Math.max(0, Math.floor(cy - reach - 1)), y1 = Math.min(this.h - 1, Math.ceil(cy + reach + 1));
    const half = lw / 2;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const sd = Math.abs(Surface.sdf(x + 0.5, y + 0.5, cx, cy, hw, hh, rad, spin)) - half;
        const cov = Math.min(1, Math.max(0, 0.5 - sd));
        if (cov > 0) this.blend(x, y, cr, cg, cb, cov * alpha);
      }
  }

  /** Three box passes approximate a gaussian closely enough for frosted glass. */
  blurRegion(rx, ry, rw, rh, radius) {
    if (radius < 1) return;
    rx = Math.max(0, Math.floor(rx)); ry = Math.max(0, Math.floor(ry));
    rw = Math.min(this.w - rx, Math.ceil(rw)); rh = Math.min(this.h - ry, Math.ceil(rh));
    if (rw <= 0 || rh <= 0) return;
    const r = Math.max(1, Math.round(radius / 3));
    let buf = new Float32Array(rw * rh * 3);
    for (let y = 0; y < rh; y++)
      for (let x = 0; x < rw; x++) {
        const s = ((ry + y) * this.w + rx + x) * 4, t = (y * rw + x) * 3;
        buf[t] = this.data[s]; buf[t + 1] = this.data[s + 1]; buf[t + 2] = this.data[s + 2];
      }
    const tmp = new Float32Array(buf.length);
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < rh; y++)
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let x = -r; x <= r; x++) sum += buf[(y * rw + Math.min(rw - 1, Math.max(0, x))) * 3 + c];
          for (let x = 0; x < rw; x++) {
            tmp[(y * rw + x) * 3 + c] = sum / (2 * r + 1);
            const add = Math.min(rw - 1, x + r + 1), sub = Math.max(0, x - r);
            sum += buf[(y * rw + add) * 3 + c] - buf[(y * rw + sub) * 3 + c];
          }
        }
      for (let x = 0; x < rw; x++)
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let y = -r; y <= r; y++) sum += tmp[(Math.min(rh - 1, Math.max(0, y)) * rw + x) * 3 + c];
          for (let y = 0; y < rh; y++) {
            buf[(y * rw + x) * 3 + c] = sum / (2 * r + 1);
            const add = Math.min(rh - 1, y + r + 1), sub = Math.max(0, y - r);
            sum += tmp[(add * rw + x) * 3 + c] - tmp[(sub * rw + x) * 3 + c];
          }
        }
    }
    for (let y = 0; y < rh; y++)
      for (let x = 0; x < rw; x++) {
        const s = ((ry + y) * this.w + rx + x) * 4, t = (y * rw + x) * 3;
        this.data[s] = buf[t]; this.data[s + 1] = buf[t + 1]; this.data[s + 2] = buf[t + 2];
      }
  }

  /** Draws a decoded image with cover / contain / fill behaviour. */
  drawImage(img, fit, alpha) {
    const ir = img.width / img.height, cr = this.w / this.h;
    let dw = this.w, dh = this.h;
    if (fit !== 'fill') {
      const wide = fit === 'cover' ? ir < cr : ir > cr;
      if (wide) { dw = this.w; dh = this.w / ir; } else { dh = this.h; dw = this.h * ir; }
    }
    const dx = (this.w - dw) / 2, dy = (this.h - dh) / 2;
    for (let y = 0; y < this.h; y++) {
      const sy = Math.floor((y - dy) / dh * img.height);
      if (sy < 0 || sy >= img.height) continue;
      for (let x = 0; x < this.w; x++) {
        const sx = Math.floor((x - dx) / dw * img.width);
        if (sx < 0 || sx >= img.width) continue;
        const s = (sy * img.width + sx) * 4;
        this.blend(x, y, img.data[s], img.data[s + 1], img.data[s + 2], (img.data[s + 3] / 255) * alpha);
      }
    }
  }

  /** Scanline fill of a flattened glyph outline, 4x vertical supersampling. */
  fillPolys(polys, hex, alpha = 1) {
    const [cr, cg, cb] = hexToRgb(hex);
    const edges = [];
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    for (const poly of polys)
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
        minY = Math.min(minY, a[1]); maxY = Math.max(maxY, a[1]);
        minX = Math.min(minX, a[0]); maxX = Math.max(maxX, a[0]);
      }
    if (!edges.length) return;
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(this.h - 1, Math.ceil(maxY));
    const x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(this.w - 1, Math.ceil(maxX));
    if (x1 < x0 || y1 < y0) return;
    const rowW = x1 - x0 + 1;
    const cov = new Float32Array(rowW);
    const SS = 4;

    for (let y = y0; y <= y1; y++) {
      cov.fill(0);
      for (let s = 0; s < SS; s++) {
        const sy = y + (s + 0.5) / SS;
        const xs = [];
        for (const [ax, ay, bx, by] of edges) {
          if (sy < Math.min(ay, by) || sy >= Math.max(ay, by)) continue;
          xs.push([ax + (sy - ay) / (by - ay) * (bx - ax), by > ay ? 1 : -1]);
        }
        if (!xs.length) continue;
        xs.sort((p, q) => p[0] - q[0]);
        let wind = 0;
        for (let i = 0; i < xs.length - 1; i++) {
          wind += xs[i][1];
          if (wind === 0) continue;
          let sx = xs[i][0], ex = xs[i + 1][0];
          if (ex <= x0 || sx >= x1 + 1) continue;
          sx = Math.max(sx, x0); ex = Math.min(ex, x1 + 1);
          const ip = Math.floor(sx), ep = Math.floor(ex);
          if (ip === ep) { cov[ip - x0] += (ex - sx) / SS; continue; }
          cov[ip - x0] += (ip + 1 - sx) / SS;
          for (let px = ip + 1; px < ep; px++) cov[px - x0] += 1 / SS;
          if (ep <= x1) cov[ep - x0] += (ex - ep) / SS;
        }
      }
      for (let i = 0; i < rowW; i++) {
        const a = Math.min(1, cov[i]) * alpha;
        if (a > 0.002) this.blend(x0 + i, y, cr, cg, cb, a);
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

const BEZ = 10;

/** opentype path -> closed polygons in device space. */
export function pathToPolys(path) {
  const polys = [];
  let cur = null, px = 0, py = 0;
  const push = (x, y) => { cur.push([x, y]); px = x; py = y; };
  for (const c of path.commands) {
    if (c.type === 'M') { if (cur && cur.length > 2) polys.push(cur); cur = []; push(c.x, c.y); }
    else if (c.type === 'L') push(c.x, c.y);
    else if (c.type === 'Q') {
      const sx = px, sy = py;
      for (let i = 1; i <= BEZ; i++) {
        const t = i / BEZ, u = 1 - t;
        push(u * u * sx + 2 * u * t * c.x1 + t * t * c.x, u * u * sy + 2 * u * t * c.y1 + t * t * c.y);
      }
    } else if (c.type === 'C') {
      const sx = px, sy = py;
      for (let i = 1; i <= BEZ; i++) {
        const t = i / BEZ, u = 1 - t;
        push(
          u*u*u*sx + 3*u*u*t*c.x1 + 3*u*t*t*c.x2 + t*t*t*c.x,
          u*u*u*sy + 3*u*u*t*c.y1 + 3*u*t*t*c.y2 + t*t*t*c.y
        );
      }
    } else if (c.type === 'Z') { if (cur && cur.length > 2) polys.push(cur); cur = null; }
  }
  if (cur && cur.length > 2) polys.push(cur);
  return polys;
}
