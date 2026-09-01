# LostTracker

Repo: https://github.com/LostTracker/LA

A daily/weekly task tracker for Lost Ark — a roster x task grid that auto-resets on
schedule, plus a gold-tracking dashboard.

## Status

| Piece | State |
|---|---|
| D1 database | **Live.** `roster-watch-db` (`e63040b0-8df9-472c-a8c6-578eb98ab42f`), schema applied |
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

There is no Node on this machine, so `wrangler` cannot run locally. Either:

1. **Install Node**, then `npx wrangler deploy` works straight from this directory
   (`wrangler.toml` is already pointed at the real database), or
2. **Use the Cloudflare dashboard** — Workers & Pages > Create Worker, paste `worker.js`,
   bind D1 as `DB` to `roster-watch-db`, and set the Discord secrets there.

Never paste the Discord Client Secret into a chat — set it as a Worker secret directly.

## Notes

- Task names, raid names, and gold values are intentionally not baked in — Lost Ark's
  raid lineup and gold rewards change with patches. They're configured in the app's Setup tab.
- The database is still named `roster-watch-db` from an earlier working name. D1 has no
  rename, so it either stays as a cosmetic mismatch or gets recreated as `losttracker-db`.
