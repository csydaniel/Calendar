// Named-slot config storage. Each slot (e.g. "designA") holds a full builder
// state plus the flattened image config, so /api/wallpaper/designA renders it.
//
// @vercel/blob is imported lazily inside functions so importing this module
// never throws if the package is absent (wallpaper.js imports readSlot here).

const PREFIX = 'onedot/slot-';
const slotKey = name => PREFIX + String(name).toLowerCase().replace(/[^a-z0-9_-]/g, '') + '.json';

// The SDK's automatic OIDC resolution does not work in every runtime, which
// produces "Vercel Blob: No token found". Passing the token explicitly on every
// call is the reliable path. Vercel injects BLOB_READ_WRITE_TOKEN when a store
// is connected; if a custom env-var prefix was used, we also try common names.
const TOKEN =
  process.env.BLOB_READ_WRITE_TOKEN ||
  process.env.HELLO_READ_WRITE_TOKEN ||
  process.env.blob_READ_WRITE_TOKEN ||
  '';

const opts = extra => (TOKEN ? { token: TOKEN, ...extra } : { ...extra });

function send(res, status, body) {
  const s = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(s));
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.end(s);
}

const NO_TOKEN =
  'Vercel Blob token not found. In your Vercel project: Settings -> Environment ' +
  'Variables, confirm BLOB_READ_WRITE_TOKEN exists (the connected Blob store adds ' +
  'it automatically). If it is there, redeploy so the function picks it up.';

/** Reads one named slot's saved config, or null. Used by the wallpaper route. */
export async function readSlot(name) {
  if (!name) return null;
  try {
    const blob = await import('@vercel/blob');
    const { blobs } = await blob.list(opts({ prefix: slotKey(name), limit: 1 }));
    if (!blobs.length) return null;

    // get() works for public and private stores; fetch(url) only for public.
    let text = null;
    try {
      if (typeof blob.get === 'function') {
        const r = await blob.get(blobs[0].url, opts());
        if (r) text = typeof r.text === 'function' ? await r.text() : String(r);
      }
    } catch { /* fall through to fetch */ }
    if (text == null) {
      const r = await fetch(blobs[0].url, { cache: 'no-store' });
      if (!r.ok) return null;
      text = await r.text();
    }
    return { config: JSON.parse(text), saved: blobs[0].uploadedAt };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const q = req.query && Object.keys(req.query).length
      ? new URLSearchParams(req.query) : url.searchParams;

    if (!TOKEN) return send(res, 200, { ok: false, error: NO_TOKEN });

    const blob = await import('@vercel/blob');

    // ---- list every saved slot ----
    if (q.get('list')) {
      const { blobs } = await blob.list(opts({ prefix: PREFIX }));
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

      await blob.put(slotKey(name), JSON.stringify({ state: body.state, image: body.image }), opts({
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 0,
      }));
      return send(res, 200, { ok: true, slot: name, saved: new Date().toISOString() });
    }

    // ---- delete a slot ----
    if (req.method === 'DELETE') {
      const name = q.get('slot');
      if (!name) return send(res, 400, { ok: false, error: 'missing slot' });
      const { blobs } = await blob.list(opts({ prefix: slotKey(name), limit: 1 }));
      if (blobs.length) await blob.del(blobs[0].url, opts());
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
