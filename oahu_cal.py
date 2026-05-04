#!/usr/bin/env python3
"""
Oahu League Soccer schedule filter.

Pulls per-flight (age-group) iCal feeds from sportsaffinity.com,
parses each VEVENT, extracts the two team names from the DESCRIPTION,
and lets you:

  * list all teams (optionally filtered by substring or age group)
  * write a filtered .ics file containing only games involving the
    teams you care about (one or many)
  * serve that filtered .ics over HTTP so a calendar app can subscribe
    to it (auto-refreshing when you re-run the script or with --serve)

Usage examples:
  python oahu_cal.py list
  python oahu_cal.py list --age G12U
  python oahu_cal.py list --search leahi
  python oahu_cal.py ics --team "Leahi 14G East Blue" --team "RUSH 14G Black" -o my.ics
  python oahu_cal.py serve --team "Leahi 14G East Blue" --port 8000
"""

from __future__ import annotations

import argparse
import http.server
import re
import socketserver
import sys
import time
import urllib.request
from dataclasses import dataclass
from typing import Iterable

TOURNAMENT_GUID = "94D44303-F331-4505-92B2-813593B3FC50"
BASE = "https://ol-spring-25-26.sportsaffinity.com/tour/public/info"
LIST_URL = f"{BASE}/accepted_list.asp?tournamentguid={TOURNAMENT_GUID}&show={{show}}"
ICS_URL = f"{BASE}/ischedule.aspx?flightguid={{flight}}&tournamentguid={TOURNAMENT_GUID}"

USER_AGENT = "oahu-cal-filter/1.0 (+local script)"

CACHE_TTL = 15 * 60  # seconds
_cache: dict[str, tuple[float, str]] = {}


def http_get(url: str) -> str:
    now = time.time()
    cached = _cache.get(url)
    if cached and now - cached[0] < CACHE_TTL:
        return cached[1]
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    _cache[url] = (now, body)
    return body


# ---------------------------------------------------------------------------
# Discover flights (age groups) for the tournament
# ---------------------------------------------------------------------------

FLIGHT_RE = re.compile(
    r"schedule_results2\.asp\?[^\"']*?flightguid=([0-9A-F-]{36})",
    re.IGNORECASE,
)
AGE_HEADER_RE = re.compile(r"\b([BG]\d{2}U)\b")


@dataclass(frozen=True)
class Flight:
    age: str          # e.g. "G12U"
    gender: str       # "girls" or "boys"
    flight_guid: str

    @property
    def ics_url(self) -> str:
        return ICS_URL.format(flight=self.flight_guid)


def discover_flights(genders: Iterable[str] = ("girls", "boys")) -> list[Flight]:
    flights: list[Flight] = []
    for gender in genders:
        html = http_get(LIST_URL.format(show=gender))
        # Pair up age headers with the next schedule link that follows.
        # Easiest: scan token by token.
        ages = [(m.start(), m.group(1).upper()) for m in AGE_HEADER_RE.finditer(html)]
        guids = [(m.start(), m.group(1).upper()) for m in FLIGHT_RE.finditer(html)]
        for gpos, guid in guids:
            # The age header for this guid is the most recent one before it.
            age = next(
                (a for apos, a in reversed(ages) if apos < gpos),
                "?",
            )
            flights.append(Flight(age=age, gender=gender, flight_guid=guid))
    # Deduplicate: an age group sometimes lists multiple links (Brackets,
    # Schedule, Standings, Statistics) all with the same flightguid.
    seen: set[str] = set()
    unique: list[Flight] = []
    for f in flights:
        if f.flight_guid in seen:
            continue
        seen.add(f.flight_guid)
        unique.append(f)
    return unique


# ---------------------------------------------------------------------------
# iCal parsing
# ---------------------------------------------------------------------------


def unfold_ics(text: str) -> list[str]:
    # RFC 5545 line unfolding: a line starting with space or tab continues
    # the previous line.
    out: list[str] = []
    for raw in text.splitlines():
        if raw.startswith((" ", "\t")) and out:
            out[-1] += raw[1:]
        else:
            out.append(raw)
    return out


@dataclass
class Event:
    raw_lines: list[str]
    summary: str
    description: str
    teams: tuple[str, str] | None
    age: str
    gender: str

    def involves(self, team: str) -> bool:
        if not self.teams:
            return False
        t = team.strip().lower()
        return any(t == x.strip().lower() for x in self.teams)


VS_RE = re.compile(r"^(.*?)\\n\s*vs\\n\s*(.*?)(?:\\n|$)", re.IGNORECASE)


def parse_events(ics_text: str, age: str, gender: str) -> list[Event]:
    lines = unfold_ics(ics_text)
    events: list[Event] = []
    cur: list[str] | None = None
    for line in lines:
        if line.startswith("BEGIN:VEVENT"):
            cur = [line]
        elif line.startswith("END:VEVENT") and cur is not None:
            cur.append(line)
            summary = ""
            description = ""
            depth = 0
            for l in cur:
                if l.startswith("BEGIN:"):
                    depth += 1
                    continue
                if l.startswith("END:"):
                    depth -= 1
                    continue
                # Only capture properties at the VEVENT level (depth==1),
                # not nested VALARM (depth==2) which has its own DESCRIPTION.
                if depth != 1:
                    continue
                if l.startswith("SUMMARY:"):
                    summary = l[len("SUMMARY:") :]
                elif l.startswith("DESCRIPTION:"):
                    description = l[len("DESCRIPTION:") :]
            teams: tuple[str, str] | None = None
            m = VS_RE.match(description)
            if m:
                teams = (m.group(1).strip(), m.group(2).strip())
            events.append(
                Event(
                    raw_lines=cur,
                    summary=summary,
                    description=description,
                    teams=teams,
                    age=age,
                    gender=gender,
                )
            )
            cur = None
        elif cur is not None:
            cur.append(line)
    return events


def fetch_all_events(genders: Iterable[str] = ("girls", "boys")) -> list[Event]:
    events: list[Event] = []
    for f in discover_flights(genders):
        try:
            ics = http_get(f.ics_url)
        except Exception as e:
            print(f"warn: failed to fetch {f.age} ({f.gender}): {e}", file=sys.stderr)
            continue
        events.extend(parse_events(ics, f.age, f.gender))
    return events


# ---------------------------------------------------------------------------
# Output: filter + emit a clean .ics
# ---------------------------------------------------------------------------


def filter_events(
    events: list[Event],
    teams: list[str],
    ages: list[str] | None = None,
) -> list[Event]:
    if ages:
        ages_set = {a.upper() for a in ages}
        events = [e for e in events if e.age in ages_set]
    if not teams:
        return events
    teams_lc = {t.strip().lower() for t in teams}
    return [
        e
        for e in events
        if e.teams
        and (
            e.teams[0].strip().lower() in teams_lc
            or e.teams[1].strip().lower() in teams_lc
        )
    ]


def kit_info(event: Event, selected: set[str]) -> dict | None:
    """Given the user's selected teams, figure out role+kit for this game.

    Convention from the source feed: the first team in the matchup is HOME,
    the second is AWAY. Home wears LIGHT; away wears DARK.
    Returns None if the event doesn't involve any selected team.
    """
    if not event.teams:
        return None
    sel = {t.strip().lower() for t in selected}
    home, away = event.teams
    is_home = home.strip().lower() in sel
    is_away = away.strip().lower() in sel
    if not (is_home or is_away):
        return None
    if is_home and is_away:
        # Both selected teams play each other.
        return {
            "role": "BOTH",
            "kit": "split",
            "label": f"BOTH \u2014 {home} wears LIGHT, {away} wears DARK",
            "short": "BOTH",
        }
    if is_home:
        return {
            "role": "HOME",
            "kit": "light",
            "label": f"HOME ({home}) \u2014 wear LIGHT",
            "short": "HOME / LIGHT",
        }
    return {
        "role": "AWAY",
        "kit": "dark",
        "label": f"AWAY ({away}) \u2014 wear DARK",
        "short": "AWAY / DARK",
    }


def _clean_field(name: str) -> str:
    """Strip the noisy 'Oahu League Fields ' prefix from a field name."""
    return re.sub(r"^\s*Oahu League Fields?\s*", "", name, flags=re.IGNORECASE).strip() or name


def annotate_event(event: Event, selected: set[str]) -> Event:
    """Return a copy of `event` with kit info woven into SUMMARY/DESCRIPTION."""
    info = kit_info(event, selected)
    if not info:
        return event
    new_lines: list[str] = []
    depth = 0
    for l in event.raw_lines:
        if l.startswith("BEGIN:"):
            depth += 1
            new_lines.append(l)
            continue
        if l.startswith("END:"):
            depth -= 1
            new_lines.append(l)
            continue
        if depth == 1 and l.startswith("SUMMARY:"):
            home, away = event.teams
            if info["role"] == "HOME":
                title = f"{home} (LIGHT) vs {away}"
            elif info["role"] == "AWAY":
                title = f"{away} (DARK) @ {home}"
            else:  # BOTH
                title = f"{home} (LIGHT) vs {away} (DARK)"
            new_lines.append(f"SUMMARY:{title}")
        elif depth == 1 and l.startswith("LOCATION:"):
            new_lines.append("LOCATION:" + _clean_field(l[len("LOCATION:"):]))
        elif depth == 1 and l.startswith("DESCRIPTION:"):
            desc = l[len("DESCRIPTION:") :]
            # Also clean the "Field: ..." portion inside the description.
            desc = re.sub(
                r"(Field:\s*)Oahu League Fields?\s*",
                r"\1",
                desc,
                flags=re.IGNORECASE,
            )
            # Prepend the kit reminder so it shows at the top of event details.
            new_lines.append(
                f"DESCRIPTION:>>> {info['label']} <<<\\n\\n" + desc
            )
        else:
            new_lines.append(l)
    return Event(
        raw_lines=new_lines,
        summary=event.summary,
        description=event.description,
        teams=event.teams,
        age=event.age,
        gender=event.gender,
    )


def build_ics(
    events: list[Event],
    cal_name: str = "Oahu League (filtered)",
    selected_teams: list[str] | None = None,
) -> str:
    sel = {t.strip().lower() for t in (selected_teams or [])}
    out = [
        "BEGIN:VCALENDAR",
        "PRODID:-//oahu-cal-filter//EN",
        "CALSCALE:GREGORIAN",
        "VERSION:2.0",
        f"X-WR-CALNAME:{cal_name}",
        "METHOD:PUBLISH",
    ]
    for e in events:
        ev = annotate_event(e, sel) if sel else e
        out.extend(ev.raw_lines)
    out.append("END:VCALENDAR")
    return "\r\n".join(out) + "\r\n"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def cmd_list(args: argparse.Namespace) -> int:
    events = fetch_all_events()
    teams: dict[str, set[str]] = {}  # team -> {age}
    for e in events:
        if not e.teams:
            continue
        for t in e.teams:
            teams.setdefault(t, set()).add(f"{e.age}/{e.gender[0].upper()}")
    rows = sorted(teams.items(), key=lambda kv: (sorted(kv[1]), kv[0].lower()))
    needle = (args.search or "").lower()
    age_filter = (args.age or "").upper()
    shown = 0
    for name, ages in rows:
        if needle and needle not in name.lower():
            continue
        if age_filter and not any(a.startswith(age_filter) for a in ages):
            continue
        print(f"  [{','.join(sorted(ages))}]  {name}")
        shown += 1
    print(f"\n{shown} team(s) shown out of {len(rows)} total.", file=sys.stderr)
    return 0


def cmd_ics(args: argparse.Namespace) -> int:
    events = fetch_all_events()
    filtered = filter_events(events, args.team, args.age)
    ics = build_ics(
        filtered,
        cal_name=args.name or "Oahu League (filtered)",
        selected_teams=args.team,
    )
    if args.output == "-" or not args.output:
        sys.stdout.write(ics)
    else:
        with open(args.output, "w", encoding="utf-8", newline="") as f:
            f.write(ics)
        print(
            f"wrote {len(filtered)} event(s) to {args.output}",
            file=sys.stderr,
        )
    return 0


def _team_index(events: list[Event]) -> dict[str, dict[str, set[str]]]:
    """Return {gender: {age: {team_name, ...}}}."""
    idx: dict[str, dict[str, set[str]]] = {}
    for e in events:
        if not e.teams:
            continue
        for t in e.teams:
            idx.setdefault(e.gender, {}).setdefault(e.age, set()).add(t)
    return idx


def _event_for_preview(e: Event) -> dict:
    # Pull DTSTART/LOCATION out of raw_lines for preview
    dt = ""
    loc = ""
    for l in e.raw_lines:
        if l.startswith("DTSTART"):
            dt = l.split(":", 1)[-1]
        elif l.startswith("LOCATION:"):
            loc = l[len("LOCATION:") :]
    return {
        "when": dt,
        "teams": e.teams or ("?", "?"),
        "age": e.age,
        "gender": e.gender,
        "location": _clean_field(loc),
    }


INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Oahu League Schedule Filter</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 980px;
         margin: 1rem auto; padding: 0 1rem; line-height: 1.4; }
  h1 { margin: 0.2rem 0 0.4rem; font-size: 1.5rem; }
  .sub { color: #666; font-size: 0.9rem; margin-bottom: 1rem; }
  .controls { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;
              position: sticky; top: 0; background: var(--bg, white);
              padding: 0.5rem 0; border-bottom: 1px solid #ddd; z-index: 10; }
  @media (prefers-color-scheme: dark) { .controls { background: #111; } }
  input[type=search] { padding: 0.4rem 0.6rem; flex: 1; min-width: 180px;
                       border: 1px solid #888; border-radius: 4px; font-size: 1rem; }
  button, .btn { padding: 0.4rem 0.8rem; border: 1px solid #888; border-radius: 4px;
                 background: #f3f3f3; cursor: pointer; font-size: 0.95rem; color: #111;
                 text-decoration: none; display: inline-block; }
  button:hover, .btn:hover { background: #e3e3e3; }
  .primary { background: #2a7; color: white; border-color: #185; }
  .primary:hover { background: #1c6; }
  details { margin: 0.4rem 0; border: 1px solid #ddd; border-radius: 6px;
            padding: 0.4rem 0.7rem; }
  details > summary { cursor: pointer; font-weight: 600; }
  .age-block { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
               gap: 0.2rem 1rem; margin-top: 0.5rem; }
  label.team { display: flex; gap: 0.4rem; align-items: center; padding: 0.15rem 0;
               cursor: pointer; }
  label.team input { transform: scale(1.1); }
  .selected-bar { padding: 0.5rem; background: #fffbe6; border: 1px solid #ddc; border-radius: 6px;
                  margin: 0.6rem 0; }
  @media (prefers-color-scheme: dark) { .selected-bar { background: #2a260f; border-color: #554; } }
  .chip { display: inline-block; background: #def; color: #036; padding: 0.1rem 0.5rem;
          border-radius: 999px; margin: 0.1rem 0.2rem; font-size: 0.85rem; }
  .chip button { background: transparent; border: none; padding: 0 0 0 0.3rem;
                 color: #036; cursor: pointer; font-size: 1rem; }
  .url { word-break: break-all; font-family: ui-monospace, monospace; font-size: 0.85rem;
         padding: 0.4rem; background: #f6f6f6; border-radius: 4px; }
  @media (prefers-color-scheme: dark) { .url { background: #1c1c1c; } }
  .preview { margin-top: 1rem; }
  .preview table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  .preview th, .preview td { border-bottom: 1px solid #ddd; text-align: left;
                              padding: 0.3rem 0.5rem; vertical-align: top; }
  .hide { display: none !important; }
  .age-h { font-size: 0.95rem; color: #888; margin: 0.2rem 0 0; }
  .kit { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px;
         font-size: 0.8rem; font-weight: 600; white-space: nowrap; }
  .kit-light { background: #fffbe0; color: #6b5800; border: 1px solid #d8c97a; }
  .kit-dark  { background: linear-gradient(135deg,#2a3640,#0e1a22); color: #fff; border: 1px solid #0a141b; }
  .kit-split { background: #efe6ff; color: #4a2a99; border: 1px solid #b69cff; }
</style>
</head>
<body>
  <h1>Oahu League Schedule Filter</h1>
  <div class="sub">Pick one or more teams &mdash; subscribe in your calendar app and it will stay in sync.<br>
  <small>Kit reminder: <b>HOME</b> (team listed first) wears <b>LIGHT</b>; <b>AWAY</b> wears <b>DARK</b> (their team color).</small></div>

  <div class="controls">
    <input id="search" type="search" placeholder="Filter teams (e.g. leahi, rush, 14g)" autofocus>
    <button id="clear">Clear all</button>
  </div>

  <div id="selected" class="selected-bar hide">
    <div><b>Selected teams:</b> <span id="chips"></span></div>
    <div style="margin-top:0.5rem; display:flex; gap:0.5rem; flex-wrap:wrap;">
      <a id="subscribe" class="btn primary" href="#">Subscribe (webcal)</a>
      <a id="download"  class="btn"          href="#" download="oahu.ics">Download .ics</a>
      <button id="copy">Copy URL</button>
      <button id="preview-btn">Show upcoming games</button>
    </div>
    <div style="margin-top:0.5rem;">URL: <span id="url" class="url"></span></div>
  </div>

  <form id="teamform">
    __AGE_BLOCKS__
  </form>

  <div id="preview" class="preview hide">
    <h2>Upcoming games</h2>
    <table><thead><tr><th>When</th><th>Match</th><th>Kit</th><th>Field</th></tr></thead>
      <tbody id="preview-body"></tbody></table>
  </div>

<script>
const search    = document.getElementById('search');
const form      = document.getElementById('teamform');
const selected  = document.getElementById('selected');
const chips     = document.getElementById('chips');
const subscribe = document.getElementById('subscribe');
const download  = document.getElementById('download');
const copyBtn   = document.getElementById('copy');
const urlEl     = document.getElementById('url');
const previewBtn= document.getElementById('preview-btn');
const previewEl = document.getElementById('preview');
const previewBody = document.getElementById('preview-body');
const clearBtn  = document.getElementById('clear');

function selectedTeams() {
  return [...form.querySelectorAll('input[type=checkbox]:checked')].map(i => i.value);
}

function buildUrl(scheme) {
  const teams = selectedTeams();
  const u = new URL(window.location.href);
  u.protocol = scheme;
  u.pathname = '/calendar.ics';
  u.search = '';
  teams.forEach(t => u.searchParams.append('team', t));
  return u.toString();
}

function refresh() {
  const teams = selectedTeams();
  if (!teams.length) { selected.classList.add('hide'); previewEl.classList.add('hide'); return; }
  selected.classList.remove('hide');
  chips.innerHTML = '';
  teams.forEach(t => {
    const span = document.createElement('span');
    span.className = 'chip';
    span.textContent = t;
    const x = document.createElement('button');
    x.textContent = '\u00d7'; x.title = 'remove';
    x.onclick = () => {
      const cb = form.querySelector(`input[value="${CSS.escape(t)}"]`);
      if (cb) { cb.checked = false; refresh(); }
    };
    span.appendChild(x);
    chips.appendChild(span);
  });
  const httpUrl = buildUrl(window.location.protocol);
  const webcal  = buildUrl('webcal:');
  subscribe.href = webcal;
  download.href  = httpUrl;
  urlEl.textContent = httpUrl;
}

form.addEventListener('change', refresh);
clearBtn.addEventListener('click', e => {
  e.preventDefault();
  form.querySelectorAll('input:checked').forEach(i => i.checked = false);
  refresh();
});

search.addEventListener('input', () => {
  const q = search.value.trim().toLowerCase();
  form.querySelectorAll('label.team').forEach(l => {
    const name = l.dataset.name;
    l.classList.toggle('hide', q && !name.includes(q));
  });
  // Hide details that have no visible teams.
  form.querySelectorAll('details').forEach(d => {
    const any = [...d.querySelectorAll('label.team')].some(l => !l.classList.contains('hide'));
    d.classList.toggle('hide', !any);
    if (q && any) d.open = true;
  });
});

copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(urlEl.textContent);
  copyBtn.textContent = 'Copied!';
  setTimeout(() => copyBtn.textContent = 'Copy URL', 1200);
});

previewBtn.addEventListener('click', async () => {
  const teams = selectedTeams();
  if (!teams.length) return;
  const u = new URL('/preview.json', window.location.href);
  teams.forEach(t => u.searchParams.append('team', t));
  previewBtn.textContent = 'Loading...';
  try {
    const r = await fetch(u);
    const data = await r.json();
    previewBody.innerHTML = '';
    data.forEach(ev => {
      const tr = document.createElement('tr');
      let kitHtml = '';
      if (ev.kit === 'light')      kitHtml = '<span class="kit kit-light">HOME &middot; LIGHT</span>';
      else if (ev.kit === 'dark') kitHtml = '<span class="kit kit-dark">AWAY &middot; DARK</span>';
      else if (ev.kit === 'split') kitHtml = '<span class="kit kit-split">BOTH (split)</span>';
      tr.innerHTML = `<td>${ev.when_pretty}</td>
                      <td><b>${ev.teams[0]}</b> <i>vs</i> <b>${ev.teams[1]}</b><br><small>${ev.age} ${ev.gender}</small></td>
                      <td>${kitHtml}</td>
                      <td>${ev.location || ''}</td>`;
      previewBody.appendChild(tr);
    });
    previewEl.classList.remove('hide');
  } finally {
    previewBtn.textContent = 'Refresh upcoming games';
  }
});
</script>
</body></html>
"""


def _render_age_blocks(idx: dict[str, dict[str, set[str]]]) -> str:
    import html as _html

    parts: list[str] = []
    for gender in sorted(idx):
        parts.append(f"<h2 class='age-h'>{_html.escape(gender.title())}</h2>")
        for age in sorted(idx[gender]):
            teams = sorted(idx[gender][age], key=str.lower)
            parts.append(
                f"<details open><summary>{_html.escape(age)} "
                f"<small>({len(teams)} teams)</small></summary>"
                "<div class='age-block'>"
            )
            for t in teams:
                te = _html.escape(t)
                parts.append(
                    f"<label class='team' data-name='{te.lower()}'>"
                    f"<input type='checkbox' value='{te}'>"
                    f"<span>{te}</span></label>"
                )
            parts.append("</div></details>")
    return "\n".join(parts)


def cmd_serve(args: argparse.Namespace) -> int:
    teams_arg = args.team
    ages_arg = args.age

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, fmt, *a):  # quiet default logging
            sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % a))

        def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            from urllib.parse import urlparse, parse_qs

            url = urlparse(self.path)
            q = parse_qs(url.query)
            try:
                if url.path in ("/", "/index.html"):
                    events = fetch_all_events()
                    idx = _team_index(events)
                    html = INDEX_HTML.replace("__AGE_BLOCKS__", _render_age_blocks(idx))
                    self._send(200, html.encode("utf-8"), "text/html; charset=utf-8")
                    return

                if url.path in ("/calendar.ics", "/oahu.ics"):
                    req_teams = q.get("team", teams_arg) or []
                    req_ages = q.get("age", ages_arg) or []
                    events = fetch_all_events()
                    filtered = filter_events(events, req_teams, req_ages)
                    body = build_ics(
                        filtered,
                        cal_name=q.get("name", ["Oahu League (filtered)"])[0],
                        selected_teams=req_teams,
                    ).encode("utf-8")
                    self._send(
                        200, body, "text/calendar; charset=utf-8",
                        {"Content-Disposition": 'inline; filename="oahu.ics"'},
                    )
                    return

                if url.path == "/preview.json":
                    import json
                    from datetime import datetime, timezone

                    req_teams = q.get("team", teams_arg) or []
                    req_ages = q.get("age", ages_arg) or []
                    events = fetch_all_events()
                    filtered = filter_events(events, req_teams, req_ages)
                    items = []
                    now = datetime.now()
                    sel_set = set(req_teams)
                    for e in filtered:
                        prev = _event_for_preview(e)
                        when = prev["when"]
                        try:
                            dt = datetime.strptime(when[:15], "%Y%m%dT%H%M%S")
                        except Exception:
                            dt = None
                        if dt and dt < now:
                            continue
                        info = kit_info(e, sel_set) or {}
                        items.append({
                            "when": when,
                            "when_pretty": dt.strftime("%a %b %-d, %-I:%M %p") if dt else when,
                            "teams": list(prev["teams"]),
                            "age": prev["age"],
                            "gender": prev["gender"],
                            "location": prev["location"],
                            "role": info.get("role", ""),
                            "kit": info.get("kit", ""),
                            "kit_short": info.get("short", ""),
                            "_sort": dt.isoformat() if dt else when,
                        })
                    items.sort(key=lambda x: x["_sort"])
                    body = json.dumps(items[:200]).encode("utf-8")
                    self._send(200, body, "application/json")
                    return

                self._send(404, b"not found\n", "text/plain")
            except Exception as e:
                self._send(500, f"error: {e}\n".encode("utf-8"), "text/plain")

    addr = ("", args.port)
    with socketserver.TCPServer(addr, Handler) as srv:
        print(
            f"open http://localhost:{args.port}/  in your browser",
            file=sys.stderr,
        )
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("list", help="list teams")
    pl.add_argument("--search", help="case-insensitive substring filter")
    pl.add_argument("--age", help="age group prefix filter, e.g. G12 or B10")
    pl.set_defaults(func=cmd_list)

    pi = sub.add_parser("ics", help="write filtered .ics to stdout or a file")
    pi.add_argument("--team", action="append", default=[], help="team name (repeatable)")
    pi.add_argument("--age", action="append", default=[], help="age group, e.g. G12U (repeatable)")
    pi.add_argument("-o", "--output", default="-", help="output path or '-' for stdout")
    pi.add_argument("--name", help="X-WR-CALNAME for the generated calendar")
    pi.set_defaults(func=cmd_ics)

    ps = sub.add_parser("serve", help="serve filtered .ics over HTTP")
    ps.add_argument("--team", action="append", default=[], help="default team filter")
    ps.add_argument("--age", action="append", default=[], help="default age filter")
    ps.add_argument("--port", type=int, default=8000)
    ps.set_defaults(func=cmd_serve)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
