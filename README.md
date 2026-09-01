# LostTracker

Repo: https://github.com/LostTracker/LA

A daily/weekly task tracker for Lost Ark — a roster x task grid that auto-resets on
schedule, plus a gold-tracking dashboard.

## Status

| Piece | State |
|---|---|
| D1 database | **Live.** `losttracker-db` (`55ddd07a-8180-42f2-ae61-b39c0e4096be`), schema applied |
| Worker API | **Written, builds clean, not yet deployed.** Needs the Discord credentials first |
| Frontend | **Not in repo.** Exists only as a chat artifact; needs to be added here |
| Discord OAuth app | Registration pending (Client ID + Secret) |
| LOA Logs importer | Not started; needs a real `encounters.db` to design against |

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/login` | Redirect to Discord's consent screen |
| GET | `/auth/callback` | Exchange the code, open a session, bounce back to the app |
| POST | `/auth/logout` | Drop the session |
| GET | `/api/me` | The signed-in user, or 401 |
| GET | `/api/state` | This user's saved tracker state (`null` if never saved) |
| PUT | `/api/state` | Replace it with the posted JSON object |

The whole tracker state is stored as one JSON blob per user in `app_state`. That keeps the
schema indifferent to how the frontend organizes roster, tasks, and progress — which is
still in flux — at the cost of no server-side querying of individual tasks.

Sessions are cookie-based: a random 256-bit token, of which only the SHA-256 hash is
stored, so a leaked database dump cannot be replayed as a login. OAuth uses a `state`
cookie to reject forged callbacks.

## Layout

- `worker.js` — the API: Discord OAuth + state persistence
- `schema.sql` — mirrors the schema actually deployed to D1
- `wrangler.toml` — Worker config, bound to the live database
- `index.html` — the single-file frontend (to be added)

## Deploying

Node 24 LTS is installed, so wrangler runs locally and `wrangler.toml` already points at
the real database:

```
npx wrangler login                                              # once
npx wrangler deploy                                             # deploy the Worker
npx wrangler tail                                               # live logs
npx wrangler d1 execute losttracker-db --remote --file=schema.sql
```

Before the first real deploy:

1. Set `DISCORD_CLIENT_ID` in `wrangler.toml` (not a secret, safe to commit).
2. `npx wrangler secret put DISCORD_CLIENT_SECRET` — never put this in source or a chat.
3. Add `https://<worker-host>/auth/callback` as a redirect URI in the Discord app.
4. Set `APP_ORIGIN` to wherever the frontend is actually served from. It must match the
   browser's `Origin` exactly, or the credentialed CORS response is rejected.

## Notes

- The app and API live on different origins, so the session cookie is `SameSite=None;
  Secure`. Both sides must be HTTPS.
- Task names, raid names, and gold values are intentionally not baked in — Lost Ark's
  raid lineup and gold rewards change with patches. They're configured in the app's Setup tab.
