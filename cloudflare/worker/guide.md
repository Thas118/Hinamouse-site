# HinaMouse Twitch media Worker

This Worker keeps a public, cached index of HinaMouse clips. Clip playback uses Twitch's official embedded player.

## Deploy

1. Create a Twitch application in the Twitch Developer Console. The app credentials stay in Cloudflare and are never added to the website or this repository.
2. From this directory, create a KV namespace:

   ```powershell
   npx wrangler kv namespace create HINAMOUSE_MEDIA_CACHE
   ```

3. Copy the namespace ID returned by Wrangler into `wrangler.jsonc`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.
4. Add the Twitch app credentials as Worker secrets:

   ```powershell
   npx wrangler secret put TWITCH_CLIENT_ID
   npx wrangler secret put TWITCH_CLIENT_SECRET
   ```

5. Deploy the Worker:

   ```powershell
   npx wrangler deploy
   ```

6. Copy the deployed `workers.dev` URL into the `content` value of the `meta[name="twitch-status-api"]` element in `index.html` to enable live/offline status. The Worker also provides the clips API at `/api/clips` when that section is reactivated.
7. Deploy the static site to Cloudflare Pages with the repository root as the output directory and no build command.

The Worker refreshes its KV indexes every 15 minutes. On a cold cache, the first media request also attempts a refresh and reports any Twitch/API configuration error explicitly.

## API

- `GET /api/clips?sort=recent` — newest clips, searching backward through up to 40 seven-day Twitch API ranges to collect as many as 100.
- `GET /api/clips?sort=popular&range=all` — up to 100 most-viewed clips of all time.
- `GET /api/clips?sort=popular&range=30d` — top clips by views across the last 30 days.
- `GET /api/clips?sort=popular&range=7d` — top clips by views across the last seven days.
- `GET /api/clips?sort=popular&range=24h` — top clips by views across the last 24 hours.
- `GET /api/status` — current live/offline status for HinaMouse, including stream title and game when live.

The top filters refresh every 15 minutes and sort the returned clips by Twitch's view counts. The Twitch API allows bounded date ranges of up to seven days, so the 30-day period is collected in weekly slices and merged before sorting.

The recent clip search is bounded to 40 Twitch API requests per refresh. If the channel has too many clips inside one date range for that budget, the Worker keeps the last successful cache and logs the refresh error instead of silently replacing it with incomplete data.

Twitch embeds require the site to run on HTTP/HTTPS and the Worker to receive the site's host as the `parent` parameter.

## Tests

Run the Worker unit tests with:

```powershell
npm test
```
