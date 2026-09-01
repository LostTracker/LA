# LostTracker

Repo: https://github.com/LostTracker/LA

A daily/weekly task tracker for Lost Ark — a roster x task grid that auto-resets on
schedule, plus a gold-tracking dashboard.

## Status

| Piece | State |
|---|---|
| D1 database | **Live.** `losttracker-db` (`55ddd07a-8180-42f2-ae61-b39c0e4096be`), schema applied |
| Worker API | **Not deployed.** No `losttracker-api` Worker exists in the account yet |
| Frontend | **Not in repo.** Exists only as a chat artifact; needs to be added here |
| Discord OAuth app | Registration pending (Client ID + Secret) |
| LOA Logs importer | Not started; needs a real `encounters.db` to design against |

## Layout

- `schema.sql` — mirrors the schema actually deployed to D1
- `wrangler.toml` — Worker config, bound to the live database
- `worker.js` — API + Discord OAuth (to be added)
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

Set the Discord secrets as Worker secrets, never in source or a chat:

```
npx wrangler secret put DISCORD_CLIENT_SECRET
```

## Notes

- Task names, raid names, and gold values are intentionally not baked in — Lost Ark's
  raid lineup and gold rewards change with patches. They're configured in the app's Setup tab.
- The old `roster-watch-db` (`e63040b0-...`) from the earlier working name still exists in
  the account, unused and empty. It can be deleted once nothing references it.
