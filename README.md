# One Dot — daily wallpaper

## Deploy (free)
1. Put these files in a GitHub repo.
2. vercel.com → Add New Project → import the repo → Deploy. No settings to change.
3. Open your new URL, set your dates and colors, press **Copy Shortcut URL**.

Google Sites can only host static pages, so it can serve the builder but not the
image endpoint. Vercel's free tier does both from one deploy.

## Files
- `index.html` — the builder. Live preview, colors, checkpoints, PNG download.
- `api/wallpaper.tsx` — returns the wallpaper as a PNG for today's date.

## Endpoint parameters
start, end, size, bg, past, left, today, shape, fill, top, bottom, side, tz,
and `hl` (repeatable): `YYYY-MM-DD:YYYY-MM-DD:RRGGBB`

Add `&tz=9` for Korea so the dot turns over at local midnight.
