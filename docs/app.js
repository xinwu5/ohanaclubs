"use strict";

const WORKER = (window.WORKER_URL || "").replace(/\/$/, "");

const $ = (id) => document.getElementById(id);
const status = $("status");
const form = $("teamform");
const selected = $("selected");
const chips = $("chips");
const subscribe = $("subscribe");
const download = $("download");
const copyBtn = $("copy");
const urlEl = $("url");
const previewBtn = $("preview-btn");
const previewEl = $("preview");
const previewBody = $("preview-body");
const clearBtn = $("clear");
const search = $("search");

if (!WORKER || WORKER.includes("YOUR-SUBDOMAIN")) {
  status.textContent =
    "Worker URL is not configured. Edit docs/config.js with the URL you got from `wrangler deploy`.";
  status.style.color = "#c00";
}

function buildUrl(scheme, path = "/calendar.ics") {
  const u = new URL(WORKER + path);
  u.protocol = scheme;
  selectedTeams().forEach((t) => u.searchParams.append("team", t));
  return u.toString();
}

function selectedTeams() {
  return [...form.querySelectorAll("input[type=checkbox]:checked")].map(
    (i) => i.value,
  );
}

function refresh() {
  const teams = selectedTeams();
  if (!teams.length) {
    selected.classList.add("hide");
    previewEl.classList.add("hide");
    return;
  }
  selected.classList.remove("hide");
  chips.innerHTML = "";
  teams.forEach((t) => {
    const span = document.createElement("span");
    span.className = "chip";
    span.textContent = t;
    const x = document.createElement("button");
    x.textContent = "\u00d7";
    x.title = "remove";
    x.onclick = () => {
      const cb = form.querySelector(`input[value="${CSS.escape(t)}"]`);
      if (cb) {
        cb.checked = false;
        refresh();
      }
    };
    span.appendChild(x);
    chips.appendChild(span);
  });
  const httpUrl = buildUrl("https:");
  const webcal = buildUrl("webcal:");
  subscribe.href = webcal;
  download.href = httpUrl;
  urlEl.textContent = httpUrl;
}

form.addEventListener("change", refresh);
clearBtn.addEventListener("click", (e) => {
  e.preventDefault();
  form.querySelectorAll("input:checked").forEach((i) => (i.checked = false));
  refresh();
});

search.addEventListener("input", () => {
  const q = search.value.trim().toLowerCase();
  form.querySelectorAll("label.team").forEach((l) => {
    const name = l.dataset.name;
    l.classList.toggle("hide", !!q && !name.includes(q));
  });
  form.querySelectorAll("details").forEach((d) => {
    const any = [...d.querySelectorAll("label.team")].some(
      (l) => !l.classList.contains("hide"),
    );
    d.classList.toggle("hide", !any);
    if (q && any) d.open = true;
  });
});

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(urlEl.textContent);
  copyBtn.textContent = "Copied!";
  setTimeout(() => (copyBtn.textContent = "Copy URL"), 1200);
});

previewBtn.addEventListener("click", async () => {
  const teams = selectedTeams();
  if (!teams.length) return;
  const u = new URL(WORKER + "/preview.json");
  teams.forEach((t) => u.searchParams.append("team", t));
  previewBtn.textContent = "Loading\u2026";
  try {
    const r = await fetch(u);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    previewBody.innerHTML = "";
    if (!data.length) {
      previewBody.innerHTML = `<tr><td colspan="4">No upcoming games.</td></tr>`;
    }
    data.forEach((ev) => {
      const tr = document.createElement("tr");
      let kitHtml = "";
      if (ev.kit === "light")
        kitHtml = '<span class="kit kit-light">HOME &middot; LIGHT</span>';
      else if (ev.kit === "dark_blue")
        kitHtml = '<span class="kit kit-dark">AWAY &middot; DARK BLUE</span>';
      else if (ev.kit === "split")
        kitHtml = '<span class="kit kit-split">BOTH (split)</span>';
      tr.innerHTML = `<td>${ev.when_pretty}</td>
        <td><b>${escapeHtml(ev.teams[0])}</b> <i>vs</i> <b>${escapeHtml(ev.teams[1])}</b><br>
            <small>${ev.age} ${ev.gender}</small></td>
        <td>${kitHtml}</td>
        <td>${escapeHtml(ev.location || "")}</td>`;
      previewBody.appendChild(tr);
    });
    previewEl.classList.remove("hide");
  } catch (e) {
    alert("Failed to load preview: " + e.message);
  } finally {
    previewBtn.textContent = "Refresh upcoming games";
  }
});

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

async function loadTeams() {
  if (!WORKER || WORKER.includes("YOUR-SUBDOMAIN")) return;
  try {
    const r = await fetch(WORKER + "/teams.json");
    if (!r.ok) throw new Error("HTTP " + r.status);
    const idx = await r.json();
    renderTeams(idx);
    status.classList.add("hide");
  } catch (e) {
    status.textContent = "Failed to load teams: " + e.message;
    status.style.color = "#c00";
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
      det.open = false;
      const sum = document.createElement("summary");
      sum.innerHTML = `${age} <small>(${teams.length} teams)</small>`;
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

loadTeams();

// ---- PWA: register service worker + Install button ---------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => {
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
