# oahu-soccer-schedule

A tiny tool that lets Oahu League soccer parents subscribe to a calendar of
**only the games they care about**, instead of the entire age group.

The official league site (sportsaffinity.com) publishes one big iCal feed per
age group. There's no way to filter to a single team, much less to multiple
teams at once (e.g. parents with two kids, or coaches helping out other
teams). This tool fixes that.

## What you get

- A simple **web UI** to pick one or more teams, with search, grouping by
  age/gender, and an upcoming-games preview.
- A subscription URL you can paste into Apple Calendar, Google Calendar, or
  Outlook so the schedule **stays in sync automatically** when the league
  updates fields/times.
- Calendar event titles rewritten to be useful at a glance, e.g.
  - `Leahi 14G East Blue (LIGHT) vs RUSH 14G East`  (home, light kit)
  - `RUSH 14G Black (DARK BLUE) @ Leahi 14G West Blue`  (away, dark blue kit)
- Field names cleaned up (`9v9 12A` instead of `Oahu League Fields 9v9 12A`).
- A CLI for one-shot `.ics` exports and team listings.

## Requirements

Python 3.9+ (uses only the standard library; no `pip install` needed).

## Quick start

```bash
git clone <your-fork-url> oahu-soccer-schedule
cd oahu-soccer-schedule

# Web UI (recommended)
python3 oahu_cal.py serve --port 8000
# then open http://localhost:8000/

# List teams from the terminal
python3 oahu_cal.py list --age G12

# One-shot .ics export
python3 oahu_cal.py ics \
  --team "Leahi 14G East Blue" \
  --team "RUSH 14G Black" \
  -o myteams.ics
```

## Subscribing in your calendar app

Once `serve` is running, the UI builds a URL that looks like:

```
http://localhost:8000/calendar.ics?team=Leahi+14G+East+Blue&team=RUSH+14G+Black
```

- **Apple Calendar:** File &rarr; New Calendar Subscription &rarr; paste the
  `webcal://` version of the URL (the UI's "Subscribe" button does this for you).
- **Google Calendar:** Other calendars &rarr; From URL &rarr; paste the `http://`
  version. (Google needs a publicly reachable URL, so for Google you'll want to
  host this somewhere; see "Hosting" below.)
- **Outlook:** Add calendar &rarr; Subscribe from web &rarr; paste the URL.

## How it works

1. Discover all flights (age groups) by scraping the tournament's accepted
   teams page once.
2. Fetch each flight's iCal feed (the same one the league offers for download).
3. Parse `VEVENT` blocks, extract the matchup teams from each event's
   `DESCRIPTION` field.
4. Filter to events involving the requested teams, annotate the title and
   description with home/away + kit color, and re-emit a clean `VCALENDAR`.

A 15-minute in-process cache keeps things polite to the upstream server.

## Hosting (sharing with the rest of the team)

The local server is fine for one family, but if you want the whole team to
subscribe from their phones you'll need a publicly reachable URL. Easy paths:

- **Cloudflare Workers** (free) — port `oahu_cal.py` to TypeScript; the URL
  contract (`/calendar.ics?team=...`) is already designed for this.
- **Fly.io / Render free tier** — drop a `Dockerfile`, deploy as-is.
- **Tailscale Funnel / ngrok** — quickest hack to expose your laptop.

PRs welcome.

## Tournament / season

Currently hardcoded to the 2025/26 Oahu League Spring Season tournament GUID
in `oahu_cal.py`. Update `TOURNAMENT_GUID` and `BASE` for a different season.

## License

MIT. See `LICENSE`.

## Disclaimer

Not affiliated with the Oahu League, HYSA, or sportsaffinity.com. The data is
the league's; this is just a convenience filter for parents.
