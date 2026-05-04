# oahu-soccer-schedule

A free, public, parent-friendly way to subscribe to Oahu League soccer games
&mdash; only the team(s) you care about, automatically updated.

The official league site (sportsaffinity.com) only offers an iCal feed for an
**entire age group** (e.g. all of G12U). Parents can't filter to one team,
let alone two (e.g. siblings on different teams). This project fixes that.

## Architecture

```
                                 fetch + parse + filter
sportsaffinity.com  ───────►  Cloudflare Worker  ───────►  /calendar.ics
       (source)                  (free tier)              (per parent)
                                       ▲
                                       │ /teams.json
                                       │
GitHub Pages  ──── docs/index.html ────┘
   (UI)
```

* **GitHub Pages** hosts a static UI (`docs/`).
* **Cloudflare Worker** (`worker/`) does the live fetch + filter and serves
  the per-team `.ics` URL parents subscribe to.
* **Auto-refresh**: when the league changes a field or time, the Worker
  picks it up within 15 minutes; calendar apps then sync per their own
  refresh interval (Apple: configurable; Google: ~24h; Outlook: ~3h).

## One-time setup

You need:
* A free [Cloudflare](https://dash.cloudflare.com/sign-up) account.
* Node 18+ and `npm`.
* A GitHub repo with Pages enabled (Settings &rarr; Pages &rarr; serve from
  `main` branch, `/docs` folder).

### 1. Deploy the Worker

```bash
cd worker
npm install
npx wrangler login          # opens browser, one-time
npx wrangler deploy
```

Copy the URL it prints, e.g.
`https://oahu-soccer-schedule.YOUR-SUBDOMAIN.workers.dev`.

### 2. Point the UI at the Worker

Edit `docs/config.js` and paste the URL:

```js
window.WORKER_URL = "https://oahu-soccer-schedule.YOUR-SUBDOMAIN.workers.dev";
```

Commit and push. GitHub Pages will publish the UI within a minute.

### 3. Share the page

Send `https://YOUR-USERNAME.github.io/oahu-soccer-schedule/` to your team.

## Local development

Run the Worker locally:

```bash
cd worker
npx wrangler dev --port 8787
```

Run the UI locally (point `docs/config.js` at `http://localhost:8787`
temporarily):

```bash
cd docs
python3 -m http.server 8000
```

Open http://localhost:8000/.

There's also a **standalone Python version** (`oahu_cal.py`) that does
everything in one file (CLI + local web UI), useful for quick experiments
without deploying anything. See `python3 oahu_cal.py --help`.

## What parents get

* Pick one or many teams via checkboxes &mdash; with search and grouping by
  age/gender.
* A subscription URL they paste once into Apple Calendar, Google Calendar,
  or Outlook. Updates flow automatically.
* Calendar event titles are rewritten to be useful at a glance:
  * Home: `Leahi 14G East Blue (LIGHT) vs RUSH 14G East`
  * Away: `RUSH 14G Black (DARK BLUE) @ Leahi 14G West Blue`
  * Both your teams playing: `Team1 (LIGHT) vs Team2 (DARK BLUE)`
* Field names cleaned up (`9v9 12A` instead of `Oahu League Fields 9v9 12A`).
* Upcoming games preview directly in the page.

## Tournament / season

The current season's tournament GUID is hardcoded in
`worker/src/index.ts` and `oahu_cal.py` (look for `TOURNAMENT_GUID` and
`BASE`). Update both for a new season.

## Costs

* GitHub Pages: free (public repo).
* Cloudflare Workers: free tier covers 100,000 requests/day. With ~200
  parents subscribed and calendar apps polling every few hours, real
  traffic is well under 1,000/day. No card on file required.

## License

MIT. See `LICENSE`.

## Disclaimer

Not affiliated with the Oahu League, HYSA, or sportsaffinity.com. Source
data belongs to the league; this is just a convenience filter for parents.
