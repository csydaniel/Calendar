// Design storage WITHOUT any external service. Named designs (designa, designb…)
// map to config codes in ./designs.json, committed to the repo. The wallpaper
// route reads that file at runtime — no token, no database, no network.
//
// Vercel's runtime filesystem is read-only, so "save" cannot rewrite the file
// on the server. Instead the save endpoint returns the exact JSON line to paste
// into designs.json. Reading always works.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, 'designs.json');

const clean = name => String(name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');

async function loadDesigns() {
  try {
    return JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Returns the config code string for a design name, or null. */
export async function readDesignCode(name) {
  const key = clean(name);
  if (!key) return null;
  const designs = await loadDesigns();
  return typeof designs[key] === 'string' ? designs[key] : null;
}

function send(res, status, body) {
  const s = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(s));
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.end(s);
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const q = req.query && Object.keys(req.query).length
      ? new URLSearchParams(req.query) : url.searchParams;

    // ---- list every saved design ----
    if (q.get('list')) {
      const designs = await loadDesigns();
      const slots = Object.keys(designs).map(name => ({ name }));
      return send(res, 200, { ok: true, slots });
    }

    // ---- "save": can't write the read-only FS, so return the line to paste ----
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body || '{}');
      else if (!body) {
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      }
      const name = clean(body?.slot);
      const code = String(body?.code || '');
      if (!name) return send(res, 400, { ok: false, error: 'missing or invalid design name' });
      if (!code) return send(res, 400, { ok: false, error: 'missing config code' });

      const designs = await loadDesigns();
      designs[name] = code;
      // Whole updated file, plus the single line, so the user can paste either.
      const line = `  ${JSON.stringify(name)}: ${JSON.stringify(code)}`;
      return send(res, 200, { ok: true, name, line, file: JSON.stringify(designs, null, 2) });
    }

    // ---- read one design's code ----
    const name = q.get('slot');
    const code = await readDesignCode(name);
    return send(res, 200, { ok: true, slot: clean(name) || null, code: code || null });
  } catch (err) {
    return send(res, 200, { ok: false, error: String(err?.message || err) });
  }
}
