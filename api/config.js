// Named-slot config storage. Each slot (e.g. "designA") holds a full builder
// state plus the flattened image config, so /api/wallpaper/designA renders it.
//
// @vercel/blob is imported lazily inside functions: if the package isn't
// installed, importing this module must not throw (wallpaper.js imports
// readSlot from here).

const PREFIX = 'onedot/slot-';
const slotKey = name => PREFIX + String(name).toLowerCase().replace(/[^a-z0-9_-]/g, '') + '.json';

function send(res, status, body) {
  const s = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(s));
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.end(s);
}

const NOT_SET_UP =
  'Blob storage is not connected. In Vercel: Storage tab -> Create Database -> Blob -> ' +
  'connect it to this project, then redeploy.';

/** Reads one named slot's saved config, or null. Used by the wallpaper route. */
export async function readSlot(name) {
  if (!process.env.BLOB_READ_WRITE_TOKEN || !name) return null;
  const { list } = await import('@vercel/blob');
  const key = slotKey(name);
  const { blobs } = await list({ prefix: key, limit: 1 });
  if (!blobs.length) return null;
  const r = await fetch(blobs[0].url, { cache: 'no-store' });
  if (!r.ok) return null;
  return { config: await r.json(), saved: blobs[0].uploadedAt };
}

export default async function handler(req, res) {
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return send(res, 200, { ok: false, error: NOT_SET_UP });
    }

    const url = new URL(req.url || '/', 'http://localhost');
    const q = req.query && Object.keys(req.query).length
      ? new URLSearchParams(req.query) : url.searchParams;

    // ---- list every saved slot ----
    if (q.get('list')) {
      const { list } = await import('@vercel/blob');
      const { blobs } = await list({ prefix: PREFIX });
      const slots = blobs.map(b => ({
        name: b.pathname.replace(PREFIX, '').replace(/\.json$/, ''),
        saved: b.uploadedAt,
      }));
      return send(res, 200, { ok: true, slots });
    }

    // ---- save a slot ----
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        body = JSON.parse(body || '{}');
      } else if (!body) {
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      }
      const name = String(body?.slot || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!name) return send(res, 400, { ok: false, error: 'missing or invalid slot name' });
      if (!body.state) return send(res, 400, { ok: false, error: 'missing state' });

      const { put } = await import('@vercel/blob');
      await put(slotKey(name), JSON.stringify({ state: body.state, image: body.image }), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 0,
      });
      return send(res, 200, { ok: true, slot: name, saved: new Date().toISOString() });
    }

    // ---- delete a slot ----
    if (req.method === 'DELETE') {
      const name = q.get('slot');
      if (!name) return send(res, 400, { ok: false, error: 'missing slot' });
      const { del, list } = await import('@vercel/blob');
      const { blobs } = await list({ prefix: slotKey(name), limit: 1 });
      if (blobs.length) await del(blobs[0].url);
      return send(res, 200, { ok: true, deleted: name });
    }

    // ---- read one slot ----
    const name = q.get('slot');
    const found = await readSlot(name);
    return send(res, 200, { ok: true, slot: name || null, config: found?.config || null, saved: found?.saved || null });
  } catch (err) {
    return send(res, 200, { ok: false, error: String(err?.message || err) });
  }
}
