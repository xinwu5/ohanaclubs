/**
 * Oahu League schedule filter — Cloudflare Worker.
 *
 * Endpoints:
 *   GET /teams.json                             list of teams grouped by gender + age
 *   GET /calendar.ics?team=A&team=B[&age=...]   filtered + annotated iCal feed
 *   GET /preview.json?team=A&team=B             upcoming games preview (UI)
 *   GET /health                                 simple OK
 *
 * Caching: upstream HTML/iCal responses are cached for 15 minutes via
 * `caches.default` keyed by URL.
 */

const TOURNAMENT_GUID = "94D44303-F331-4505-92B2-813593B3FC50";
const BASE = "https://ol-spring-25-26.sportsaffinity.com/tour/public/info";
const LIST_URL = (show: string) =>
  `${BASE}/accepted_list.asp?tournamentguid=${TOURNAMENT_GUID}&show=${show}`;
const ICS_URL = (flight: string) =>
  `${BASE}/ischedule.aspx?flightguid=${flight}&tournamentguid=${TOURNAMENT_GUID}`;

const UPSTREAM_TTL = 60 * 15; // 15 min
const USER_AGENT =
  "oahu-soccer-schedule/1.0 (+https://github.com/xinwu5/ohanaclubs)";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

// ---------------------------------------------------------------------------
// HTTP fetch with edge cache
// ---------------------------------------------------------------------------

async function fetchUpstream(url: string): Promise<string> {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return await cached.text();

  const resp = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!resp.ok) throw new Error(`upstream ${resp.status} for ${url}`);
  const text = await resp.text();
  const cacheable = new Response(text, {
    headers: {
      "content-type": resp.headers.get("content-type") ?? "text/plain",
      "cache-control": `public, max-age=${UPSTREAM_TTL}`,
    },
  });
  await cache.put(cacheKey, cacheable);
  return text;
}

// ---------------------------------------------------------------------------
// Discover flights (age groups) for the tournament
// ---------------------------------------------------------------------------

interface Flight {
  age: string; // e.g. "G12U"
  gender: "girls" | "boys";
  flightGuid: string;
}

const FLIGHT_RE =
  /schedule_results2\.asp\?[^"']*?flightguid=([0-9A-F-]{36})/gi;
const AGE_RE = /\b([BG]\d{2}U)\b/g;

async function discoverFlights(): Promise<Flight[]> {
  const out: Flight[] = [];
  for (const gender of ["girls", "boys"] as const) {
    const html = await fetchUpstream(LIST_URL(gender));
    const ages: { pos: number; age: string }[] = [];
    for (const m of html.matchAll(AGE_RE)) {
      ages.push({ pos: m.index ?? 0, age: m[1].toUpperCase() });
    }
    for (const m of html.matchAll(FLIGHT_RE)) {
      const pos = m.index ?? 0;
      const guid = m[1].toUpperCase();
      // The age header for this guid is the most recent one before it.
      let age = "?";
      for (let i = ages.length - 1; i >= 0; i--) {
        if (ages[i].pos < pos) {
          age = ages[i].age;
          break;
        }
      }
      out.push({ age, gender, flightGuid: guid });
    }
  }
  // Deduplicate (same guid appears multiple times on the index page).
  const seen = new Set<string>();
  return out.filter((f) => {
    if (seen.has(f.flightGuid)) return false;
    seen.add(f.flightGuid);
    return true;
  });
}

// ---------------------------------------------------------------------------
// iCal parsing
// ---------------------------------------------------------------------------

function unfoldIcs(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length) {
      out[out.length - 1] += raw.slice(1);
    } else {
      out.push(raw);
    }
  }
  return out;
}

interface Event {
  rawLines: string[];
  summary: string;
  description: string;
  teams: [string, string] | null;
  age: string;
  gender: string;
}

const VS_RE = /^(.*?)\\n\s*vs\\n\s*(.*?)(?:\\n|$)/i;

function parseEvents(ics: string, age: string, gender: string): Event[] {
  const lines = unfoldIcs(ics);
  const events: Event[] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) {
      cur = [line];
    } else if (line.startsWith("END:VEVENT") && cur) {
      cur.push(line);
      let summary = "";
      let description = "";
      let depth = 0;
      for (const l of cur) {
        if (l.startsWith("BEGIN:")) {
          depth++;
          continue;
        }
        if (l.startsWith("END:")) {
          depth--;
          continue;
        }
        if (depth !== 1) continue;
        if (l.startsWith("SUMMARY:")) summary = l.slice("SUMMARY:".length);
        else if (l.startsWith("DESCRIPTION:"))
          description = l.slice("DESCRIPTION:".length);
      }
      let teams: [string, string] | null = null;
      const m = description.match(VS_RE);
      if (m) teams = [m[1].trim(), m[2].trim()];
      events.push({ rawLines: cur, summary, description, teams, age, gender });
      cur = null;
    } else if (cur) {
      cur.push(line);
    }
  }
  return events;
}

async function fetchAllEvents(): Promise<Event[]> {
  const flights = await discoverFlights();
  const all = await Promise.all(
    flights.map(async (f) => {
      try {
        const ics = await fetchUpstream(ICS_URL(f.flightGuid));
        return parseEvents(ics, f.age, f.gender);
      } catch (e) {
        console.warn(`failed ${f.age}/${f.gender}: ${(e as Error).message}`);
        return [] as Event[];
      }
    }),
  );
  return all.flat();
}

// ---------------------------------------------------------------------------
// Filtering, annotation, output
// ---------------------------------------------------------------------------

function filterEvents(
  events: Event[],
  teams: string[],
  ages: string[],
): Event[] {
  let out = events;
  if (ages.length) {
    const set = new Set(ages.map((a) => a.toUpperCase()));
    out = out.filter((e) => set.has(e.age));
  }
  if (teams.length) {
    const set = new Set(teams.map((t) => t.trim().toLowerCase()));
    out = out.filter(
      (e) =>
        e.teams !== null &&
        (set.has(e.teams[0].trim().toLowerCase()) ||
          set.has(e.teams[1].trim().toLowerCase())),
    );
  }
  return out;
}

interface KitInfo {
  role: "HOME" | "AWAY" | "BOTH";
  kit: "light" | "dark" | "split";
  label: string;
  short: string;
}

function kitInfo(event: Event, selected: Set<string>): KitInfo | null {
  if (!event.teams) return null;
  const [home, away] = event.teams;
  const isHome = selected.has(home.trim().toLowerCase());
  const isAway = selected.has(away.trim().toLowerCase());
  if (!isHome && !isAway) return null;
  if (isHome && isAway) {
    return {
      role: "BOTH",
      kit: "split",
      label: `BOTH — ${home} wears LIGHT, ${away} wears DARK`,
      short: "BOTH",
    };
  }
  if (isHome) {
    return {
      role: "HOME",
      kit: "light",
      label: `HOME (${home}) — wear LIGHT`,
      short: "HOME / LIGHT",
    };
  }
  return {
    role: "AWAY",
    kit: "dark",
    label: `AWAY (${away}) — wear DARK`,
    short: "AWAY / DARK",
  };
}

function cleanField(name: string): string {
  return (
    name.replace(/^\s*Oahu League Fields?\s*/i, "").trim() || name
  );
}

function annotateEvent(event: Event, selected: Set<string>): Event {
  const info = kitInfo(event, selected);
  if (!info || !event.teams) return event;
  const [home, away] = event.teams;
  let title: string;
  if (info.role === "HOME") title = `${home} (LIGHT) vs ${away}`;
  else if (info.role === "AWAY") title = `${away} (DARK) @ ${home}`;
  else title = `${home} (LIGHT) vs ${away} (DARK)`;

  const newLines: string[] = [];
  let depth = 0;
  for (const l of event.rawLines) {
    if (l.startsWith("BEGIN:")) {
      depth++;
      newLines.push(l);
    } else if (l.startsWith("END:")) {
      depth--;
      newLines.push(l);
    } else if (depth === 1 && l.startsWith("SUMMARY:")) {
      newLines.push(`SUMMARY:${title}`);
    } else if (depth === 1 && l.startsWith("LOCATION:")) {
      newLines.push(`LOCATION:${cleanField(l.slice("LOCATION:".length))}`);
    } else if (depth === 1 && l.startsWith("DESCRIPTION:")) {
      let desc = l.slice("DESCRIPTION:".length);
      desc = desc.replace(/(Field:\s*)Oahu League Fields?\s*/i, "$1");
      newLines.push(`DESCRIPTION:>>> ${info.label} <<<\\n\\n${desc}`);
    } else {
      newLines.push(l);
    }
  }
  return { ...event, rawLines: newLines };
}

function buildIcs(
  events: Event[],
  calName: string,
  selectedTeams: string[],
): string {
  const sel = new Set(selectedTeams.map((t) => t.trim().toLowerCase()));
  const out: string[] = [
    "BEGIN:VCALENDAR",
    "PRODID:-//oahu-soccer-schedule//EN",
    "CALSCALE:GREGORIAN",
    "VERSION:2.0",
    `X-WR-CALNAME:${calName}`,
    "METHOD:PUBLISH",
  ];
  for (const e of events) {
    const ev = sel.size ? annotateEvent(e, sel) : e;
    out.push(...ev.rawLines);
  }
  out.push("END:VCALENDAR");
  return out.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

function teamIndex(events: Event[]): Record<string, Record<string, string[]>> {
  const idx: Record<string, Record<string, Set<string>>> = {};
  for (const e of events) {
    if (!e.teams) continue;
    for (const t of e.teams) {
      ((idx[e.gender] ??= {})[e.age] ??= new Set()).add(t);
    }
  }
  const out: Record<string, Record<string, string[]>> = {};
  for (const g of Object.keys(idx).sort()) {
    out[g] = {};
    for (const a of Object.keys(idx[g]).sort()) {
      out[g][a] = [...idx[g][a]].sort((x, y) =>
        x.toLowerCase().localeCompare(y.toLowerCase()),
      );
    }
  }
  return out;
}

function parseDtstart(s: string): Date | null {
  // e.g. "20260103T093000" or "20260103T093000Z"
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(
    `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}-10:00`,
  );
}

function eventPreviewRow(
  e: Event,
  selected: Set<string>,
): Record<string, unknown> | null {
  let dtRaw = "";
  let loc = "";
  for (const l of e.rawLines) {
    if (l.startsWith("DTSTART")) dtRaw = l.split(":").slice(1).join(":");
    else if (l.startsWith("LOCATION:")) loc = l.slice("LOCATION:".length);
  }
  const dt = parseDtstart(dtRaw);
  if (dt && dt.getTime() < Date.now()) return null;
  const info = kitInfo(e, selected);
  return {
    when: dtRaw,
    when_iso: dt?.toISOString() ?? null,
    when_pretty: dt
      ? dt.toLocaleString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZone: "Pacific/Honolulu",
        })
      : dtRaw,
    teams: e.teams ?? ["?", "?"],
    age: e.age,
    gender: e.gender,
    location: cleanField(loc),
    role: info?.role ?? "",
    kit: info?.kit ?? "",
    kit_short: info?.short ?? "",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      ...CORS_HEADERS,
    },
  });
}

function textResponse(
  body: string,
  ctype: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(body, {
    headers: {
      "content-type": ctype,
      "cache-control": "public, max-age=300",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(req.url);
    const teams = url.searchParams.getAll("team");
    const ages = url.searchParams.getAll("age");
    const calName =
      url.searchParams.get("name") ?? "Oahu League (filtered)";
    try {
      switch (url.pathname) {
        case "/health":
          return new Response("ok\n", { headers: CORS_HEADERS });

        case "/teams.json": {
          const events = await fetchAllEvents();
          return jsonResponse(teamIndex(events));
        }

        case "/calendar.ics":
        case "/oahu.ics": {
          const events = await fetchAllEvents();
          const filtered = filterEvents(events, teams, ages);
          const ics = buildIcs(filtered, calName, teams);
          return textResponse(ics, "text/calendar; charset=utf-8", {
            "content-disposition": 'inline; filename="oahu.ics"',
          });
        }

        case "/preview.json": {
          const events = await fetchAllEvents();
          const filtered = filterEvents(events, teams, ages);
          const sel = new Set(teams.map((t) => t.trim().toLowerCase()));
          const rows = filtered
            .map((e) => eventPreviewRow(e, sel))
            .filter((x): x is Record<string, unknown> => x !== null)
            .sort(
              (a, b) =>
                String(a.when_iso ?? a.when).localeCompare(
                  String(b.when_iso ?? b.when),
                ),
            )
            .slice(0, 200);
          return jsonResponse(rows);
        }

        case "/":
          return new Response(
            "Oahu League schedule filter API.\n" +
              "Endpoints: /teams.json /calendar.ics?team=... /preview.json /health\n",
            { headers: { "content-type": "text/plain", ...CORS_HEADERS } },
          );

        default:
          return new Response("not found\n", {
            status: 404,
            headers: CORS_HEADERS,
          });
      }
    } catch (e) {
      return new Response(`error: ${(e as Error).message}\n`, {
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  },
};
