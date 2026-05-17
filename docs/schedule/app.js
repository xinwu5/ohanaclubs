"use strict";

const WORKER = (window.WORKER_URL || "").replace(/\/$/, "");
const STORE_KEY = "ohanaclubs.schedule.teams.v1";

const $ = (id) => document.getElementById(id);
const status     = $("status");
const form       = $("teamform");
const selected   = $("selected");
const chips      = $("chips");
const sbCount    = $("sb-count");
const sbBadge    = $("sb-badge");
const subscribe  = $("subscribe");
const download   = $("download");
const copyBtn    = $("copy");
const urlEl      = $("url");
const previewEl  = $("preview");
const previewBody= $("preview-body");
const previewRefresh = $("preview-refresh");  // removed from DOM; reference kept for backward compatibility
const pickerDone = $("picker-done");
const syncToggle = $("sync-toggle");
const syncPanel = $("sync-panel");
const clearBtn   = $("clear");
const search     = $("search");
const picker     = $("picker-wrap");
const pickerCount= $("picker-count");

const SUBSCRIBED_KEY = "ohanaclubs.schedule.subscribed.v1";

if (!WORKER || WORKER.includes("YOUR-SUBDOMAIN")) {
  status.textContent =
    "API URL is not configured. Edit /schedule/config.js and set window.WORKER_URL.";
  status.style.color = "var(--coral-dark, #c00)";
}

// ---------- Persistence ---------------------------------------------------
//
// Selections are persisted in localStorage so a returning parent doesn't
// have to re-pick every visit. No URL state — keeps the address bar clean.

function teamsFromStorage() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function persistTeams(list) {
  try {
    if (list.length) localStorage.setItem(STORE_KEY, JSON.stringify(list));
    else localStorage.removeItem(STORE_KEY);
  } catch { /* full disk / safari private mode — best effort */ }
}

// ---------- Helpers -------------------------------------------------------

function selectedTeams() {
  return [...form.querySelectorAll("input[type=checkbox]:checked")].map(
    (i) => i.value,
  );
}

function calendarUrl(scheme) {
  const u = new URL(WORKER + "/calendar.ics");
  u.protocol = scheme;
  selectedTeams().forEach((t) => u.searchParams.append("team", t));
  return u.toString();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- UI: chips, selection bar, picker count -----------------------

function renderChips(teams) {
  chips.innerHTML = "";
  if (!teams.length) return;
  const fragment = document.createDocumentFragment();
  teams.forEach((t) => {
    const chip = document.createElement("span");
    chip.className = "chip removable";
    const label = document.createElement("span");
    label.className = "chip-label";
    label.textContent = t;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip-remove";
    btn.setAttribute("aria-label", `Remove ${t}`);
    btn.textContent = "×";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cb = form.querySelector(`input[value="${CSS.escape(t)}"]`);
      if (cb) {
        cb.checked = false;
        onSelectionChanged();
      }
    });
    chip.appendChild(label);
    chip.appendChild(btn);
    fragment.appendChild(chip);
  });
  chips.appendChild(fragment);
}

function updatePickerCount() {
  const total = form.querySelectorAll("input[type=checkbox]").length;
  const sel = selectedTeams().length;
  pickerCount.textContent = sel
    ? `${sel} selected · ${total} total`
    : total
      ? `${total} teams`
      : "";
}

// ---------- Preview rendering --------------------------------------------

let previewSeq = 0;       // race-safety: only render the latest fetch

async function loadPreview() {
  const teams = selectedTeams();
  if (!teams.length || !WORKER) return;
  const my = ++previewSeq;
  const u = new URL(WORKER + "/preview.json");
  teams.forEach((t) => u.searchParams.append("team", t));
  previewEl.classList.remove("hide");
  previewBody.classList.add("loading");
  try {
    const r = await fetch(u);
    if (my !== previewSeq) return;       // newer request superseded us
    if (!r.ok) throw new Error("HTTP " + r.status);
    const payload = await r.json();
    if (my !== previewSeq) return;
    // New shape: { events, warnings }. Old shape was a bare array.
    const data = Array.isArray(payload) ? payload : (payload.events || []);
    const warnings = Array.isArray(payload) ? [] : (payload.warnings || []);
    renderPreview(data);
    showWarnings(warnings);
  } catch (e) {
    if (my !== previewSeq) return;
    previewBody.innerHTML =
      `<p class="preview-empty">Couldn't load games: ${escapeHtml(e.message)}</p>`;
  } finally {
    if (my === previewSeq) previewBody.classList.remove("loading");
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
    // Insert above the selected/share bar
    const sel = document.getElementById("selected");
    sel.parentNode.insertBefore(banner, sel);
  }
  banner.innerHTML =
    `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/></svg>` +
    `<div>` +
    warnings.map((w) => `<div>${escapeHtml(w)}</div>`).join("") +
    `</div>` +
    `<button type="button" aria-label="Dismiss" onclick="this.parentNode.remove()">&times;</button>`;
}

function renderPreview(data) {
  if (!data.length) {
    previewBody.innerHTML =
      `<p class="preview-empty">No upcoming games for the selected team(s).</p>`;
    return;
  }
  // Group by date for readability.
  const groups = new Map();
  data.forEach((ev) => {
    const dateKey = ev.when_pretty.split(",").slice(0, 2).join(",").trim()
                  || ev.when;
    if (!groups.has(dateKey)) groups.set(dateKey, []);
    groups.get(dateKey).push(ev);
  });

  const parts = [];
  for (const [date, games] of groups) {
    parts.push(`<div class="game-day"><h3>${escapeHtml(date)}</h3>`);
    for (const ev of games) {
      let kitClass = "kit-light", kitText = "HOME · LIGHT";
      if (ev.kit === "dark")        { kitClass = "kit-dark";  kitText = "AWAY · DARK"; }
      else if (ev.kit === "split")  { kitClass = "kit-split"; kitText = "BOTH"; }

      const time = (ev.when_pretty.split(",")[2] || "").trim();
      const ymd = ev.when && ev.when.length >= 8
        ? `${ev.when.slice(0,4)}-${ev.when.slice(4,6)}-${ev.when.slice(6,8)}`
        : "";
      const fieldLabel = parseFieldLabel(ev.location);
      const mapHref = ymd
        ? `/map/?date=${encodeURIComponent(ymd)}` +
          (fieldLabel ? `&highlight=${encodeURIComponent(fieldLabel)}` : "")
        : "/map/";

      parts.push(`
        <article class="game">
          <div class="game-time">${escapeHtml(time || ev.when_pretty)}</div>
          <div class="game-body">
            <div class="game-teams">
              <b>${escapeHtml(ev.teams[0])}</b>
              <span class="vs">vs</span>
              <b>${escapeHtml(ev.teams[1])}</b>
            </div>
            <div class="game-meta">
              <span class="kit ${kitClass}">${escapeHtml(kitText)}</span>
              <span class="dot">·</span>
              <span>${escapeHtml(ev.location || "TBD")}</span>
              <span class="dot">·</span>
              <span class="age">${escapeHtml(ev.age)} ${escapeHtml(ev.gender)}</span>
            </div>
            <div class="game-actions">
              <a class="map-link" href="${mapHref}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                See on map
              </a>
            </div>
          </div>
        </article>`);
    }
    parts.push(`</div>`);
  }
  previewBody.innerHTML = parts.join("");
}

// Mirrors the parser used in /map/. Returns "17A" / "12" / "" if not parseable.
function parseFieldLabel(loc) {
  if (!loc) return "";
  const m = String(loc).trim().match(/(\d{1,2})([A-Z]?)\s*$/);
  if (!m) return "";
  return m[1].replace(/^0+/, "") + (m[2] || "");
}

// ---------- Selection-changed master handler ------------------------------

const debouncedReload = debounce(() => loadPreview(), 350);

function onSelectionChanged() {
  const teams = selectedTeams();

  persistTeams(teams);

  if (!teams.length) {
    selected.classList.add("hide");
    previewEl.classList.add("hide");
    previewBody.innerHTML = "";
    if (syncPanel) syncPanel.classList.add("hide");
    if (syncToggle) syncToggle.setAttribute("aria-expanded", "false");
    updatePickerCount();
    return;
  }
  selected.classList.remove("hide");
  renderChips(teams);

  // Update the compact label: "1 team" / "2 teams" + comma-separated names
  if (sbCount) {
    sbCount.textContent = teams.length === 1 ? "1 team" : `${teams.length} teams`;
  }
  if (sbBadge) {
    const isSubscribed = localStorage.getItem(SUBSCRIBED_KEY) === "1";
    sbBadge.classList.toggle("hide", !isSubscribed);
  }

  const httpUrl = calendarUrl("https:");
  subscribe.href = calendarUrl("webcal:");
  download.href = httpUrl;
  urlEl.textContent = httpUrl;

  updatePickerCount();
  debouncedReload();
}

// ---------- Wire up events -----------------------------------------------

if (pickerDone) {
  pickerDone.addEventListener("click", () => {
    picker.open = false;
    // Scroll the picker title into view so the next thing the user sees
    // is the preview/games list, not the middle of the form.
    picker.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

if (syncToggle && syncPanel) {
  syncToggle.addEventListener("click", () => {
    const open = syncPanel.classList.toggle("hide");
    // toggle returns true if class was added (i.e. now hidden)
    const expanded = !open;
    syncToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    syncPanel.setAttribute("aria-hidden", expanded ? "false" : "true");
  });
}

form.addEventListener("change", onSelectionChanged);

// When user clicks Subscribe: mark "subscribed", show the green check, and
// (one-time per device) show an iPhone-only toast reminding them to set the
// fetch interval to Daily — Apple's default is weekly, which is the #1 cause
// of "my calendar didn't update" complaints.
const TOAST_SHOWN_KEY = "ohanaclubs.schedule.toastShown.v1";
const isIos = /iP(hone|ad|od)/.test(navigator.userAgent);

function showSubscribeToast() {
  if (!isIos) return;
  if (localStorage.getItem(TOAST_SHOWN_KEY) === "1") return;
  try { localStorage.setItem(TOAST_SHOWN_KEY, "1"); } catch {}

  const toast = document.createElement("div");
  toast.className = "subscribe-toast";
  toast.innerHTML = `
    <button class="close" aria-label="Dismiss" onclick="this.parentNode.remove()">&times;</button>
    <div>
      <b>📱 One more step on iPhone</b><br>
      Apple defaults subscribed calendars to refresh <b>weekly</b>. To see field/time changes the same day:<br>
      <small style="opacity:0.85">Settings → Calendar → Accounts → Subscribed Calendars → ohanaclubs → Fetch → <b>Daily</b></small>
      <br>
      <button onclick="this.closest('.subscribe-toast').remove()">Got it</button>
    </div>`;
  document.body.appendChild(toast);
  // Auto-dismiss after 30s if user ignores
  setTimeout(() => toast.remove(), 30000);
}

if (subscribe) {
  subscribe.addEventListener("click", () => {
    try { localStorage.setItem(SUBSCRIBED_KEY, "1"); } catch {}
    if (sbBadge) sbBadge.classList.remove("hide");
    showSubscribeToast();
  });
}

clearBtn.addEventListener("click", (e) => {
  e.preventDefault();
  form.querySelectorAll("input:checked").forEach((i) => (i.checked = false));
  onSelectionChanged();
});

search.addEventListener("input", () => {
  const q = search.value.trim().toLowerCase();
  let anyVisible = false;
  form.querySelectorAll("label.team").forEach((l) => {
    const visible = !q || l.dataset.name.includes(q);
    l.classList.toggle("hide", !visible);
    if (visible) anyVisible = true;
  });
  form.querySelectorAll("details.age-group").forEach((d) => {
    const any = [...d.querySelectorAll("label.team")].some(
      (l) => !l.classList.contains("hide"),
    );
    d.classList.toggle("hide", !any);
    if (q && any) d.open = true;
  });
  if (q && !picker.open) picker.open = true;
});

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const orig = btn.dataset.label || btn.textContent.trim();
      btn.dataset.label = orig;
      btn.dataset.flash = "1";
      // Flash text only on the last child text node so any inner SVG stays.
      const labelNode = [...btn.childNodes].reverse().find(
        (n) => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim(),
      );
      if (labelNode) {
        const original = labelNode.nodeValue;
        labelNode.nodeValue = " Copied!";
        setTimeout(() => { labelNode.nodeValue = original; }, 1200);
      }
    }
    return true;
  } catch {
    return false;
  }
}

copyBtn.addEventListener("click", async () => {
  const ok = await copyToClipboard(urlEl.textContent, copyBtn);
  if (!ok) {
    const range = document.createRange();
    range.selectNodeContents(urlEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
});

if (previewRefresh) previewRefresh.addEventListener("click", () => loadPreview());

// ---------- Boot: load teams, restore selections -------------------------

async function loadTeams() {
  if (!WORKER || WORKER.includes("YOUR-SUBDOMAIN")) return;
  try {
    const r = await fetch(WORKER + "/teams.json");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const payload = await r.json();
    // New shape: { teams, warnings }. Old shape was the team dict directly.
    const idx = payload.teams || payload;
    const warnings = payload.warnings || [];
    renderTeams(idx);
    status.classList.add("hide");
    showWarnings(warnings);
    restoreSelection();
  } catch (e) {
    status.textContent = "Failed to load teams: " + e.message;
    status.style.color = "var(--coral-dark, #c00)";
  }
}

// Returns true for tournament-bracket placeholders that aren't real
// subscribable teams (e.g. "Winner SF Game# 602413", "1st A", "WC").
function isPlaceholder(team) {
  const s = String(team).trim();
  if (/^Winner\s+SF\s+Game#/i.test(s)) return true;
  if (/^(?:\d+(?:st|nd|rd|th)|WC)\b/i.test(s)) return true;
  return false;
}

// Extract club name from a team string. Returns "" if no club can be parsed,
// in which case the caller should bucket the team under "Miscellaneous".
function parseClub(team) {
  let s = String(team).trim();

  // Normalize aliases / case variants
  s = s.replace(/^808FC\b/i, "808 FC");
  s = s.replace(/^RUSH\b/i, "RUSH");
  s = s.replace(/^Rush\b/, "RUSH");

  // Normalize separators (hyphens, en/em dashes, underscores) to spaces so
  // tokens like "-08/07B" and "11G_Gold" split cleanly.
  s = s.replace(/[\-–—_]/g, " ").replace(/\s+/g, " ").trim();

  // Tokenize and cut at the first token that looks like an age / squad marker.
  // Skip index 0 so single-number clubs like "808 FC" aren't truncated.
  const tokens = s.split(" ");
  const colorWord = /^(?:Boys|Girls|Blue|Red|White|Black|Gold|Green|Yellow|Grey|Gray|Silver|Premier|Academy|Select|East|West|North|South|Elite|Navy|Orange|Maroon|Sky|Royal|Purple|Pink|Aqua|Teal)$/i;
  const ageToken = /^(?:U\d{1,2}[A-Z]*|[BG]U\d{1,2}[A-Z]*|[BG]\d{1,2}[A-Z]*|\d{1,2}[BG][A-Z]*|\d{4}[BG]|\d{2}\/\d{2}[BG]|\d{1,2}[BG]\/\d{1,2}[BG]|\d{4}\/\d{4}[BG]|OA)$/i;

  let cutIdx = -1;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (ageToken.test(t)) { cutIdx = i; break; }
    if (/^\d{4}$/.test(t)) { cutIdx = i; break; }
    if (/^\d{2}\/\d{2}$/.test(t)) { cutIdx = i; break; }
    if (/^\d{1,2}$/.test(t) && i + 1 < tokens.length &&
        (colorWord.test(tokens[i + 1]) || ageToken.test(tokens[i + 1]) || /^\d/.test(tokens[i + 1]))) {
      cutIdx = i; break;
    }
  }
  if (cutIdx > 0) s = tokens.slice(0, cutIdx).join(" ");

  return s.trim().replace(/[\s\-]+$/g, "");
}

// Track the last fetched team index so the view tabs can re-render without refetching.
let currentTeamIdx = null;
let currentView = "club"; // "club" | "age"

// Build a flat list of { team, gender, age } objects, filtering placeholders
// and deduping by team name (a team that appears under multiple ages keeps
// the first one we saw).
function flattenTeams(idx) {
  const seen = new Map(); // team -> {team, gender, age}
  for (const gender of Object.keys(idx)) {
    for (const age of Object.keys(idx[gender])) {
      for (const t of idx[gender][age]) {
        if (isPlaceholder(t)) continue;
        if (!seen.has(t)) seen.set(t, { team: t, gender, age });
      }
    }
  }
  return [...seen.values()];
}

function teamLabel(entry) {
  const lbl = document.createElement("label");
  lbl.className = `team ${entry.gender}`;
  lbl.dataset.name = entry.team.toLowerCase();
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.value = entry.team;
  const span = document.createElement("span");
  span.textContent = entry.team;
  lbl.appendChild(cb);
  lbl.appendChild(span);
  return lbl;
}

function renderClubView(entries) {
  // Club -> { display, byGender: { boys: [], girls: [] } }
  const clubs = new Map();
  for (const e of entries) {
    const club = parseClub(e.team) || "Others";
    const key = club.toLowerCase();
    if (!clubs.has(key)) {
      clubs.set(key, { display: club, byGender: { boys: [], girls: [] } });
    }
    const bucket = clubs.get(key).byGender;
    (bucket[e.gender] ??= []).push(e);
  }

  // Sort clubs alphabetically; always push "Others" to the end.
  const list = [...clubs.values()].sort((a, b) => {
    const aOther = a.display === "Others";
    const bOther = b.display === "Others";
    if (aOther !== bOther) return aOther ? 1 : -1;
    return a.display.toLowerCase().localeCompare(b.display.toLowerCase());
  });

  for (const club of list) {
    const total =
      (club.byGender.boys?.length || 0) + (club.byGender.girls?.length || 0);
    const det = document.createElement("details");
    det.className = "age-group";
    det.open = false;
    const sum = document.createElement("summary");
    sum.innerHTML = `<span>${escapeHtml(club.display)}</span> <small>${total} team${total === 1 ? "" : "s"}</small>`;
    det.appendChild(sum);

    // Render each gender that has teams as its own subsection.
    for (const gender of ["boys", "girls"]) {
      const list = club.byGender[gender];
      if (!list || !list.length) continue;
      const section = document.createElement("div");
      section.className = `gender-section ${gender}`;
      const head = document.createElement("div");
      head.className = "gender-section-label";
      head.textContent = `${gender} (${list.length})`;
      section.appendChild(head);
      const block = document.createElement("div");
      block.className = "age-block";
      list
        .slice()
        .sort((a, b) => a.team.toLowerCase().localeCompare(b.team.toLowerCase()))
        .forEach((entry) => block.appendChild(teamLabel(entry)));
      section.appendChild(block);
      det.appendChild(section);
    }

    form.appendChild(det);
  }
}

function renderAgeView(idx) {
  // Original gender > age > teams shape.
  const genders = Object.keys(idx).sort();
  for (const g of genders) {
    const h = document.createElement("h2");
    h.className = "gender-h";
    h.textContent = g;
    form.appendChild(h);
    const ages = Object.keys(idx[g]).sort();
    for (const age of ages) {
      const teams = idx[g][age];
      const det = document.createElement("details");
      det.className = "age-group";
      det.open = false;
      const sum = document.createElement("summary");
      sum.innerHTML = `<span>${escapeHtml(age)}</span> <small>${teams.length} teams</small>`;
      det.appendChild(sum);
      const block = document.createElement("div");
      block.className = "age-block";
      for (const t of teams) {
        if (isPlaceholder(t)) continue;
        block.appendChild(teamLabel({ team: t, gender: g, age }));
      }
      det.appendChild(block);
      form.appendChild(det);
    }
  }
}

function renderTeams(idx) {
  currentTeamIdx = idx;
  form.innerHTML = "";
  if (currentView === "age") {
    renderAgeView(idx);
  } else {
    renderClubView(flattenTeams(idx));
  }
  // Re-apply selections from storage after a re-render (e.g., tab switch).
  restoreSelectionsFromStorage();
}

function restoreSelectionsFromStorage() {
  const stored = teamsFromStorage();
  if (!stored.length) return;
  for (const t of stored) {
    const cb = form.querySelector(`input[value="${CSS.escape(t)}"]`);
    if (cb) cb.checked = true;
  }
}

function setView(view) {
  if (view === currentView) return;
  currentView = view;
  document.querySelectorAll(".view-tab").forEach((btn) => {
    const active = btn.dataset.view === view;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  if (currentTeamIdx) renderTeams(currentTeamIdx);
  // Re-apply current filter (search) after re-render.
  if (search.value) search.dispatchEvent(new Event("input"));
}

document.querySelectorAll(".view-tab").forEach((btn) => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

function restoreSelection() {
  const stored = teamsFromStorage();
  if (!stored.length) {
    updatePickerCount();
    return;
  }
  let restored = 0;
  for (const t of stored) {
    const cb = form.querySelector(`input[value="${CSS.escape(t)}"]`);
    if (cb) {
      cb.checked = true;
      restored++;
      const parent = cb.closest("details.age-group");
      if (parent) parent.open = true;
    }
  }
  if (restored > 0) {
    onSelectionChanged();
    // Auto-collapse picker so the preview is the focal point.
    picker.open = false;
  } else {
    updatePickerCount();
  }
}

loadTeams();

// ---------- PWA: SW + install button --------------------------------------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("SW registration failed", err);
    });
  });
}

let deferredInstallPrompt = null;
const installBtn = document.getElementById("install");
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (installBtn) installBtn.classList.remove("hide");
});
if (installBtn) {
  installBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn.classList.add("hide");
  });
}
window.addEventListener("appinstalled", () => {
  if (installBtn) installBtn.classList.add("hide");
});

