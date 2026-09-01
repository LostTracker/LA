# LostTracker

Repo: https://github.com/LostTracker/LA

A personal daily/weekly task tracker for Lost Ark — a roster x task grid that auto-resets
on schedule, plus a gold-tracking dashboard. Rosters import from lostark.bible.

## Status

| Piece | State |
|---|---|
| D1 database | **Live.** `losttracker-db` (`55ddd07a-8180-42f2-ae61-b39c0e4096be`), single `state` table |
| Worker API | **Written, builds clean, not deployed.** Needs `APP_KEY` set |
| Frontend | **Built.** `index.html` — checklist, dashboard, roster, setup |
| Roster import | **Built.** Parser verified against lostark.bible's live markup; end-to-end untested until deploy |

## Design

Single-user. There are no accounts, no OAuth, and no sessions: every request carries a
shared key checked against the `APP_KEY` secret. That is the entire access model, and it
is only adequate because this serves one person. Treat the key like a password.

All tracker data lives in D1. Nothing is cached on the client — the browser stores only
the API URL and key — so there is no offline mode by design.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | The tracker state (`null` before the first save) |
| PUT | `/api/state` | Replace it with the posted JSON object |
| GET | `/api/roster?name=X&region=CE\|NA` | Import a roster from lostark.bible |

## Roster import

lostark.bible publishes rosters at `/character/{REGION}/{NAME}/roster` as server-rendered
HTML, readable anonymously — no OAuth and no dependence on their hashed
`/_app/remote/<id>` endpoints, which change on every deploy of their site. The Worker
fetches that page and parses out each character's name and item level.

Caveats worth knowing:

- It is still HTML parsing, so a markup change on their side breaks it. The Worker returns
  an explicit error in that case rather than importing an empty roster.
- **Class is not imported** — the roster listing renders it as an unlabelled inline SVG.
  Class doesn't change, so it's set by hand once.
- Import matches on character name, so classes, gold flags, and progress survive a
  refresh. Characters missing from the roster are left alone, never deleted.
- Responses are cached for 5 minutes so repeated refreshes don't hammer their site.

## Layout

- `index.html` — the single-file frontend
- `worker.js` — the API
- `schema.sql` — mirrors the schema deployed to D1
- `wrangler.toml` — Worker config, bound to the live database

## Deploying

```
npx wrangler login                                              # once
npx wrangler secret put APP_KEY                                 # long and random
npx wrangler deploy
npx wrangler tail                                               # live logs
npx wrangler d1 execute losttracker-db --remote --file=schema.sql
```

Then open the app, go to Setup, and enter the Worker URL and the same key. Set
`APP_ORIGIN` in `wrangler.toml` to wherever the frontend is served from — it must match
the browser's `Origin` exactly.

## Notes

- Task names, raid names, and gold values are intentionally not baked in — Lost Ark's
  raid lineup and gold rewards change with patches. They're configured on the Setup tab.
