import { put, list } from '@vercel/blob';

const KEY = 'onedot/config.json';

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
  'connect it to this project, then redeploy. Config codes keep working until then.';

/** Reads the saved config, or null when nothing has been stored yet. */
export async function readConfig() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  const { blobs } = await list({ prefix: KEY, limit: 1 });
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

    if (req.method === 'POST') {
      let body = req.body;
      if (!body || typeof body === 'string') {
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || String(req.body || '{}'));
      }
      if (!body || !body.state) return send(res, 400, { ok: false, error: 'missing state' });

      await put(KEY, JSON.stringify(body), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 0,
      });
      return send(res, 200, { ok: true, saved: new Date().toISOString() });
    }

    const found = await readConfig();
    return send(res, 200, { ok: true, config: found?.config || null, saved: found?.saved || null });
  } catch (err) {
    return send(res, 200, { ok: false, error: String(err?.message || err) });
  }
}
