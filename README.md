# ohanaclubs

Free, parent-friendly subscription calendar for Oahu League youth soccer.
Pick the team(s) you care about, get one URL that auto-updates as the league
changes fields and times.

**Live:** https://ohanaclubs.com

## What parents see

- A web page (also installable as a PWA on iPhone / Android / desktop) with
  every team in the league grouped by gender and age, plus a search box.
- One "Subscribe" button that hands the calendar URL to Apple Calendar,
  Google Calendar, or Outlook. Once subscribed, games stay in sync
  automatically.
- Smart event titles like:
  - `Leahi 14G East Blue (LIGHT) vs RUSH 14G East`  (home, light kit)
  - `RUSH 14G Black (DARK BLUE) @ Leahi 14G West Blue`  (away, dark blue kit)
- Field names cleaned up (`9v9 12A` instead of `Oahu League Fields 9v9 12A`).

## Architecture

```
                                   fetch + parse + filter
sportsaffinity.com    ─────►   Cloudflare Worker   ─────►  api.ohanaclubs.com
   (source feeds)              (free tier)                 /calendar.ics
                                       ▲
                                       │ /teams.json /preview.json
                                       │
GitHub Pages   ──── docs/ ─────────────┘
ohanaclubs.com
   (UI / PWA)
```

* `docs/`     static UI (HTML + CSS + JS), served from GitHub Pages on
              `ohanaclubs.com`. Includes a service worker for offline use
              and PWA manifest for "Add to Home Screen".
* `worker/`   Cloudflare Worker on `api.ohanaclubs.com`. Fetches every
              age-group iCal feed, parses events, and serves
              `/teams.json`, `/preview.json`, and a filtered
              `/calendar.ics?team=...&team=...`. Caches upstream data for
              15 minutes.
* `oahu_cal.py`  standalone Python version. Same logic, runs as a CLI or a
              local web UI &mdash; useful for quick experiments without
              deploying anything.

## Local development

```bash
# 1. Worker
cd worker
npm install
npx wrangler dev --port 8787      # serves at http://localhost:8787

# 2. UI (point docs/config.js at http://localhost:8787 temporarily)
cd ../docs
python3 -m http.server 8000        # http://localhost:8000

# Or skip the Worker entirely and use the all-in-one Python script:
python3 oahu_cal.py serve --port 8000
```

## Deploying changes

```bash
# Worker
cd worker && npx wrangler deploy

# UI: just push to main; GitHub Pages redeploys in ~30 seconds.
git push
```

When you change the static shell (HTML/CSS/JS), bump `CACHE_VERSION` in
`docs/sw.js` so installed PWAs pick up the new files.

## Tournament / season rollover

The current season's tournament GUID is hardcoded in:

* `worker/src/index.ts` &rarr; `TOURNAMENT_GUID`, `BASE`
* `oahu_cal.py`         &rarr; `TOURNAMENT_GUID`, `BASE`

Update both when a new season starts on sportsaffinity.com, then redeploy
the Worker.

## Costs

| Service              | Plan       | Usage today | Limit       |
|----------------------|------------|-------------|-------------|
| Cloudflare Workers   | Free       | < 1k req/d  | 100k req/d  |
| GitHub Pages         | Free       | static      | 100 GB/mo   |
| `ohanaclubs.com`     | Registrar  | $10-ish/yr  | -           |

## License

MIT. See `LICENSE`.

## Disclaimer

Not affiliated with the Oahu League, HYSA, or sportsaffinity.com. Schedule
data belongs to the league; this is a convenience filter for parents.
