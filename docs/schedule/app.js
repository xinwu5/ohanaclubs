"use strict";

const WORKER = (window.WORKER_URL || "").replace(/\/$/, "");
const STORE_KEY = "ohanaclubs.schedule.teams.v1";

const $ = (id) => document.getElementById(id);
const status     = $("status");
const form       = $("teamform");
const selected   = $("selected");
const chips      = $("chips");
const subscribe  = $("subscribe");
const download   = $("download");
const copyBtn    = $("copy");
const urlEl      = $("url");
const previewEl  = $("preview");
const previewBody= $("preview-body");
const previewRefresh = $("preview-refresh");
const clearBtn   = $("clear");
const search     = $("search");
const picker     = $("picker-wrap");
const pickerCount= $("picker-count");

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
  teams.forEach((t) => {
    const span = document.createElement("span");
    span.className = "chip";
    span.textContent = t;
    const x = document.createElement("button");
    x.type = "button";
    x.textContent = "\u00d7";
    x.title = "remove";
    x.setAttribute("aria-label", `Remove ${t}`);
    x.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cb = form.querySelector(`input[value="${CSS.escape(t)}"]`);
      if (cb) {
        cb.checked = false;
        onSelectionChanged();
      }
    };
    span.appendChild(x);
    chips.appendChild(span);
  });
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
    const data = await r.json();
    if (my !== previewSeq) return;
    renderPreview(data);
  } catch (e) {
    if (my !== previewSeq) return;
    previewBody.innerHTML =
      `<p class="preview-empty">Couldn't load games: ${escapeHtml(e.message)}</p>`;
  } finally {
    if (my === previewSeq) previewBody.classList.remove("loading");
  }
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
          </div>
        </article>`);
    }
    parts.push(`</div>`);
  }
  previewBody.innerHTML = parts.join("");
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
    updatePickerCount();
    return;
  }
  selected.classList.remove("hide");
  renderChips(teams);

  const httpUrl = calendarUrl("https:");
  subscribe.href = calendarUrl("webcal:");
  download.href = httpUrl;
  urlEl.textContent = httpUrl;

  updatePickerCount();
  debouncedReload();
}

// ---------- Wire up events -----------------------------------------------

form.addEventListener("change", onSelectionChanged);

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

previewRefresh.addEventListener("click", () => loadPreview());

// ---------- Boot: load teams, restore selections -------------------------

async function loadTeams() {
  if (!WORKER || WORKER.includes("YOUR-SUBDOMAIN")) return;
  try {
    const r = await fetch(WORKER + "/teams.json");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const idx = await r.json();
    renderTeams(idx);
    status.classList.add("hide");
    restoreSelection();
  } catch (e) {
    status.textContent = "Failed to load teams: " + e.message;
    status.style.color = "var(--coral-dark, #c00)";
  }
}

function renderTeams(idx) {
  form.innerHTML = "";
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
        const lbl = document.createElement("label");
        lbl.className = "team";
        lbl.dataset.name = t.toLowerCase();
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.value = t;
        const span = document.createElement("span");
        span.textContent = t;
        lbl.appendChild(cb);
        lbl.appendChild(span);
        block.appendChild(lbl);
      }
      det.appendChild(block);
      form.appendChild(det);
    }
  }
}

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

