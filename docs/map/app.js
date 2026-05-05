"use strict";

const WORKER = (window.WORKER_URL || "").replace(/\/$/, "");
const STORE_KEY = "ohanaclubs.schedule.teams.v1";

const $ = (id) => document.getElementById(id);
const dateInput = $("date");
const filterEl = $("filter");
const statusEl = $("status");
const mapObj = $("map");
const cardsEl = $("game-cards");

// ---------- Field-name parsing ------------------------------------------
//
// The league publishes locations like "9v9 17A", "11AS 12", "7v7 02C",
// "ATH 2", "4v4 04Z". The number after the format token is the Waipio
// field number that's printed on our SVG (rect[data-field="N"]). Anything
// we can't parse, we treat as "elsewhere".

const WAIPIO_FIELDS = new Set([
  2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
]);

function parseFieldNumber(loc) {
  if (!loc) return null;
  // Field is always the LAST token, e.g. "9v9 04A" → 04A, "11AS 12" → 12.
  // Anchoring to end avoids the "9" in "9v9" being matched first.
  const m = String(loc).trim().match(/(\d{1,2})([A-Z]?)\s*$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!WAIPIO_FIELDS.has(n)) return null;
  return { num: n, half: m[2] || "", label: m[2] ? `${n}${m[2]}` : `${n}` };
}

// ---------- Selected teams (shared with /schedule/ via localStorage) -----

function loadSelectedTeams() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

const myTeams = new Set(loadSelectedTeams().map((t) => t.toLowerCase()));

function isMyGame(ev) {
  if (!ev || !ev.teams) return false;
  return (
    myTeams.has(String(ev.teams[0]).toLowerCase()) ||
    myTeams.has(String(ev.teams[1]).toLowerCase())
  );
}

// ---------- Date helpers --------------------------------------------------

function today() {
  const d = new Date();
  // YYYY-MM-DD in *Hawaii* time so the picker matches what parents see.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Honolulu",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(d);
}

function isOnDate(ev, ymd) {
  // ev.when looks like "20260510T093000". Normalize to YYYY-MM-DD.
  if (!ev.when || ev.when.length < 8) return false;
  const evYmd = `${ev.when.slice(0, 4)}-${ev.when.slice(4, 6)}-${ev.when.slice(6, 8)}`;
  return evYmd === ymd;
}

function parseHHMM(when) {
  // "20260510T093000" -> "9:30 AM"
  if (!when || when.length < 13) return "";
  const h = parseInt(when.slice(9, 11), 10);
  const m = when.slice(11, 13);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${m} ${ampm}`;
}

// ---------- Fetch all games and split by date ---------------------------
//
// We pull a giant /preview.json without team filters so the date picker
// can show every game on the chosen day. The endpoint sorts by time
// already.

let allGames = [];

async function loadAllGames() {
  if (!WORKER) {
    statusEl.textContent = "API URL is not configured.";
    return;
  }
  try {
    const r = await fetch(WORKER + "/preview.json");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const payload = await r.json();
    // New shape: { events, warnings }. Old shape was a bare array.
    allGames = Array.isArray(payload) ? payload : (payload.events || []);
    const warnings = Array.isArray(payload) ? [] : (payload.warnings || []);
    statusEl.classList.add("hide");
    showWarnings(warnings);
    render();
  } catch (e) {
    statusEl.textContent = "Couldn't load games: " + e.message;
    statusEl.style.color = "var(--coral-dark, #c00)";
  }
}

function showWarnings(warnings) {
  let banner = document.getElementById("warnings-banner");
  if (!warnings || !warnings.length) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "warnings-banner";
    banner.className = "warnings-banner";
    const target = document.querySelector(".controls");
    if (target) target.parentNode.insertBefore(banner, target.nextSibling);
  }
  banner.innerHTML =
    `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/></svg>` +
    `<div>` +
    warnings.map((w) => `<div>${escapeHtml(w)}</div>`).join("") +
    `</div>` +
    `<button type="button" aria-label="Dismiss" onclick="this.parentNode.remove()">&times;</button>`;
}

// ---------- Render: highlight fields, list games -----------------------

function render() {
  const ymd = dateInput.value || today();
  const filterMine = filterEl.value === "mine";

  let games = allGames.filter((g) => isOnDate(g, ymd));
  if (filterMine) games = games.filter(isMyGame);

  // Build a per-field bucket
  const byField = new Map();
  const elsewhere = [];
  for (const g of games) {
    const info = parseFieldNumber(g.location);
    if (info == null) {
      elsewhere.push(g);
    } else {
      g._field = info.num;
      g._fieldLabel = info.label;
      if (!byField.has(info.num)) byField.set(info.num, []);
      byField.get(info.num).push(g);
    }
  }

  paintMap(byField);
  paintList(byField, elsewhere);
}

function paintMap(byField) {
  const svgDoc = mapObj.contentDocument;
  if (!svgDoc) return;
  // Reset
  svgDoc.querySelectorAll(".field").forEach((rect) => {
    rect.classList.remove("active", "mine");
    rect.removeAttribute("data-tooltip");
  });
  // Apply
  for (const [n, games] of byField) {
    const rect = svgDoc.querySelector(`rect[data-field="${n}"]`);
    if (!rect) continue;
    const anyMine = games.some(isMyGame);
    rect.classList.add(anyMine ? "mine" : "active");
    const summary = games
      .map((g) => `${parseHHMM(g.when)}  ${g.teams[0]} vs ${g.teams[1]}`)
      .join("\n");
    const t = svgDoc.createElementNS("http://www.w3.org/2000/svg", "title");
    t.textContent = summary;
    // Replace any existing <title> child
    const existing = rect.querySelector("title");
    if (existing) existing.remove();
    rect.appendChild(t);
  }
}

function paintList(byField, elsewhere) {
  const ymd = dateInput.value || today();
  const total = [...byField.values()].reduce((a, b) => a + b.length, 0)
              + elsewhere.length;

  if (!total) {
    cardsEl.innerHTML = `<div class="empty-msg">No games scheduled at Waipio on ${ymd}.</div>`;
    return;
  }

  // Flatten back into a single sorted list for the right panel
  const flat = [];
  for (const [n, games] of byField) {
    for (const g of games) flat.push(g);   // already has _field + _fieldLabel
  }
  for (const g of elsewhere) flat.push({ ...g, _field: null, _fieldLabel: null });
  flat.sort((a, b) => String(a.when).localeCompare(String(b.when)));

  const mine = flat.filter(isMyGame);
  const others = flat.filter((g) => !isMyGame(g));

  function cardHtml(g) {
    const isMine = isMyGame(g);
    const fieldLabel = g._field != null
      ? `<span class="field-pill">FIELD ${escapeHtml(g._fieldLabel)}</span>`
      : `<span class="field-pill" style="background:#eee;color:#666;">ELSEWHERE</span>`;
    return `
      <div class="game-card ${isMine ? "mine" : ""} ${g._field == null ? "unmapped" : ""}"
           data-field="${g._field ?? ""}">
        <div class="gc-time">${parseHHMM(g.when)}</div>
        <div class="gc-teams">
          <b>${escapeHtml(g.teams[0])}</b><span class="vs">vs</span><b>${escapeHtml(g.teams[1])}</b>
        </div>
        <div class="gc-meta">
          ${fieldLabel}
          &nbsp;${escapeHtml(g.location || "")}
          &middot; ${escapeHtml(g.age)} ${escapeHtml(g.gender)}
        </div>
      </div>`;
  }

  const sections = [];
  if (mine.length) {
    sections.push(
      `<h3 class="section-h mine-h">My teams (${mine.length})</h3>` +
      mine.map(cardHtml).join("")
    );
  }
  if (others.length) {
    sections.push(
      `<h3 class="section-h">${mine.length ? "Other games" : "All games"} (${others.length})</h3>` +
      others.map(cardHtml).join("")
    );
  }
  cardsEl.innerHTML = sections.join("");

  // Click a card → flash the corresponding field on the map
  cardsEl.querySelectorAll(".game-card[data-field]").forEach((c) => {
    const n = c.dataset.field;
    if (!n) return;
    c.addEventListener("click", () => {
      const svgDoc = mapObj.contentDocument;
      if (!svgDoc) return;
      const rect = svgDoc.querySelector(`rect[data-field="${n}"]`);
      if (!rect) return;
      rect.style.transition = "filter 200ms ease";
      rect.style.filter = "brightness(1.4) drop-shadow(0 0 8px #ff7e6b)";
      setTimeout(() => { rect.style.filter = ""; }, 800);
      // Scroll the map into view on mobile.
      mapObj.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ---------- Boot ----------------------------------------------------------

// Allow /map/?date=YYYY-MM-DD&highlight=17A to deep-link from the schedule.
const params = new URLSearchParams(window.location.search);
const initialDate = params.get("date");
const initialHighlight = params.get("highlight");

dateInput.value = (initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate))
  ? initialDate
  : today();
dateInput.addEventListener("change", render);
filterEl.addEventListener("change", render);

// Race-safe boot: kick off games fetch immediately AND attach a SVG-load
// listener that re-paints the map once the SVG is ready. Whichever finishes
// last completes the picture; paintMap() no-ops cleanly if either side
// isn't ready.

let svgReady = false;

mapObj.addEventListener("load", () => {
  svgReady = true;
  // Re-render now that the SVG can be queried; renders the field colors
  // even if the games fetch finished first.
  if (allGames.length) render();
  if (initialHighlight) {
    setTimeout(() => flashField(initialHighlight), 50);
  }
});

// Sometimes the SVG is already loaded by the time the script runs; in that
// case the 'load' event won't fire. Fall back to checking readyState.
if (mapObj.contentDocument && mapObj.contentDocument.readyState === "complete") {
  svgReady = true;
}

loadAllGames().then(() => {
  // If the SVG was already ready when games arrived, render() above already
  // painted. If not, the SVG-load handler will re-render. Either way, kick
  // the highlight only after the second condition is satisfied.
  if (svgReady && initialHighlight) {
    setTimeout(() => flashField(initialHighlight), 50);
  }
});

function flashField(label) {
  // Strip the half letter for the SVG lookup (rect[data-field="N"]).
  const m = String(label).match(/^(\d+)/);
  if (!m) return;
  const n = m[1];
  const svgDoc = mapObj.contentDocument;
  if (!svgDoc) return;
  const rect = svgDoc.querySelector(`rect[data-field="${n}"]`);
  if (!rect) return;
  rect.style.transition = "filter 200ms ease";
  rect.style.filter = "brightness(1.4) drop-shadow(0 0 10px #ff7e6b)";
  setTimeout(() => { rect.style.filter = ""; }, 1500);
  mapObj.scrollIntoView({ behavior: "smooth", block: "center" });
}
