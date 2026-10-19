/* Rack frontend (multi-process model) */

const $ = (id) => document.getElementById(id);

let appsList = [];
let conflictsList = [];
// null = the Overview page. Remembered per browser, so a phone reopens where it was.
let selectedId = (() => {
  try { return localStorage.getItem("selected") || null; } catch { return null; }
})();
let uptimeTimer = null;
let visibleCount = 2;
let consolesKey = ""; // identity of the currently-built console DOM

/* ------------------------------------------------------------- theme */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("theme", theme);
  const label = document.querySelector("#btn-theme span");
  if (label) label.textContent = `Theme: ${theme}`;
}
applyTheme(
  localStorage.getItem("theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
);
$("btn-theme").onclick = () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

/* ------------------------------------------------------------- settings menu */

const settingsMenu = $("settings-menu");
$("btn-settings").onclick = (e) => {
  e.stopPropagation();
  settingsMenu.hidden = !settingsMenu.hidden;
  // The menu says whether there's an update, so make sure that's fresh.
  if (!settingsMenu.hidden && !updates.checking && Date.now() - (updates.checkedAt || 0) > STALE_CHECK_MS) checkNow();
};
document.addEventListener("click", (e) => {
  if (!settingsMenu.hidden && !e.target.closest(".sidebar-header")) settingsMenu.hidden = true;
});

/* ------------------------------------------------------------- apps folder */

// Where "Install from GitHub" clones to. Lives server-side so every browser
// pointed at this controller agrees on it.
let appsDir = null;
let gitOk = true;

function renderAppsDir() {
  const btn = $("install-dir");
  if (btn) {
    btn.textContent = appsDir || "not set — pick one";
    btn.title = appsDir || "";
  }
  const install = $("btn-install");
  if (install) install.title = gitOk ? "" : "git isn't installed, or isn't on PATH";
}
async function loadSettings() {
  try {
    const s = await fetch("/api/settings").then((r) => r.json());
    appsDir = s.appsDir || null;
    gitOk = s.git !== false;
    renderAppsDir();
    setKeepLabel(s.keepApps !== false);
  } catch {}
}
loadSettings();

/* ------------------------------------------------- keep apps running on update */
// On: each process runs under a small host of its own, so ⟳ Update Rack (or Rack
// crashing) doesn't stop it, and Rack reconnects to it when it comes back.
// Closing Rack still stops everything.
function setKeepLabel(on) {
  const b = $("btn-keep");
  b.querySelector("span").textContent = `Keep apps running on update: ${on ? "on" : "off"}`;
  b.classList.toggle("on", !!on);
}
$("btn-keep").onclick = async () => {
  const on = !$("btn-keep").classList.contains("on");
  const res = await api("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keepApps: on }),
  });
  if (res.error) return alert("Couldn't change that: " + res.error);
  setKeepLabel(res.keepApps);
};

const folderModal = $("folder-modal");
function openFolderModal() {
  settingsMenu.hidden = true;
  $("folder-input").value = appsDir || "";
  $("folder-error").hidden = true;
  folderModal.hidden = false;
  $("folder-input").focus();
}
$("btn-folder").onclick = openFolderModal;
$("install-dir").onclick = openFolderModal;
$("folder-cancel").onclick = () => (folderModal.hidden = true);
folderModal.onclick = (e) => { if (e.target === folderModal) folderModal.hidden = true; };
$("folder-save").onclick = async () => {
  const res = await api("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appsDir: $("folder-input").value }),
  });
  if (res.error) {
    $("folder-error").textContent = res.error;
    $("folder-error").hidden = false;
    return;
  }
  appsDir = res.appsDir || null;
  gitOk = res.git !== false;
  renderAppsDir();
  folderModal.hidden = true;
};

/* ------------------------------------------------------------- run on boot */

function setBootLabel(on) {
  const b = $("btn-boot");
  const span = b.querySelector("span");
  if (span) span.textContent = `Run on boot: ${on ? "on" : "off"}`;
  b.classList.toggle("on", !!on);
}
async function loadBoot() {
  try {
    const { enabled } = await fetch("/api/boot").then((r) => r.json());
    setBootLabel(enabled);
  } catch {}
}
$("btn-boot").onclick = async () => {
  const turningOn = !$("btn-boot").classList.contains("on");
  const res = await fetch("/api/boot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enable: turningOn }),
  }).then((r) => r.json());
  if (res.error) return alert("Couldn't change boot setting: " + res.error);
  setBootLabel(res.enabled);
};
loadBoot();

/* ------------------------------------------------------------- version / self-update */

async function loadVersion() {
  try {
    const { version } = await fetch("/api/version").then((r) => r.json());
    const v = document.querySelector(".settings-version");
    if (v) v.textContent = `Rack v${version}`;
  } catch {}
}
loadVersion();

/* ------------------------------------------------------------- update checks */

// "Is there anything new to pull?" for Rack and for every app — answered by the
// controller (git fetch + compare), shown as badges so nothing has to be run to
// find out.
let updates = { checking: false, checkedAt: null, rack: null, apps: [] };

function updatesFor(id) {
  return updates.apps.find((a) => a.id === id) || null;
}
const hasUpdate = (info) => !!(info && info.repo && info.behind > 0);

function fmtAgo(ts) {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

// A one-line "what's new" summary for a tooltip.
function updateTitle(info, what) {
  if (!info) return "";
  if (info.reason) return `${what}: can't check — ${info.reason}.`;
  if (info.error && !info.repo) return `${what}: ${info.error}`;
  if (!hasUpdate(info)) {
    return `${what} is up to date${info.head ? ` (${info.head})` : ""}${
      info.error ? ` — ${info.error}` : ""
    }`;
  }
  const lines = [`${what}: ${info.behind} new commit${info.behind === 1 ? "" : "s"} on ${info.upstream}`];
  if (info.commits && info.commits.length) lines.push(...info.commits);
  if (info.error) lines.push(info.error);
  return lines.join("\n");
}

// One menu item that just says where things stand. It's the Update Rack button
// when Rack has something new, and otherwise a status line — there's nothing to
// press to check, Rack keeps the answer fresh itself.
function renderUpdateMenu() {
  const btn = $("btn-update-rack");
  const behindApps = updates.apps.filter((a) => hasUpdate(a));
  const rackBehind = hasUpdate(updates.rack);
  const apps = `${behindApps.length} app${behindApps.length === 1 ? " has" : "s have"} updates`;
  const rack = updates.rack || {};
  let icon = "✓";
  let text;
  if (updates.checking && !rackBehind) {
    icon = "⟲";
    text = "Checking for updates…";
  } else if (!updates.checkedAt) {
    icon = "⟲";
    text = "Not checked yet";
  } else if (rackBehind) {
    icon = "⟳";
    text = `Update Rack — ${rack.behind} new` + (behindApps.length ? ` · ${apps}` : "");
  } else if (behindApps.length) {
    icon = "⟳";
    text = `Rack is up to date · ${apps}`;
  } else if (rack.error || rack.reason) {
    icon = "⚠";
    text = "Couldn't check for updates";
  } else {
    text = "Everything is up to date";
  }
  btn.querySelector(".upd-icon").textContent = icon;
  btn.querySelector("span").textContent = text;
  btn.classList.toggle("alert", rackBehind || behindApps.length > 0);
  btn.classList.toggle("on", icon === "✓");
  btn.title = [
    updateTitle(updates.rack, "Rack"),
    // without the supervisor there's no one-click update to run
    rackBehind && rack.supervised === false
      ? "Start Rack from start.bat to update it from here — otherwise: git pull in Rack's folder."
      : "",
    ...behindApps.map((a) => updateTitle(a, a.name)),
    updates.checkedAt ? `Checked ${fmtAgo(updates.checkedAt)}.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderUpdates() {
  renderUpdateMenu();
  renderSidebar();
  renderPanel();
}

async function loadUpdates() {
  try {
    updates = await api("/api/updates");
  } catch {}
  renderUpdates();
}

// Opening the ⚙ menu on an answer older than this asks the remotes again.
const STALE_CHECK_MS = 5 * 60 * 1000;
async function checkNow() {
  updates.checking = true;
  renderUpdateMenu();
  try {
    updates = await api("/api/updates/check", { method: "POST" });
  } catch {
    updates.checking = false;
  }
  renderUpdates();
}

/* ------------------------------------------------------------- sdk prompt */

let sdkText = null;
async function getSdkPrompt() {
  if (sdkText == null) sdkText = (await api("/api/sdk-prompt")).text || "";
  return sdkText;
}

// navigator.clipboard only exists in a secure context (https or localhost).
// Rack is often opened over plain http on a LAN / Tailscale IP, so fall back.
async function copyText(text) {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {}
  return false;
}

function flashLabel(btn, msg) {
  const el = btn.querySelector("span") || btn;
  const old = el.textContent;
  el.textContent = msg;
  btn.classList.add("on");
  setTimeout(() => {
    el.textContent = old;
    btn.classList.remove("on");
  }, 1600);
}

const sdkModal = $("sdk-modal");
function openSdkModal(text) {
  $("sdk-text").value = text;
  $("sdk-sub").textContent = "Couldn't reach the clipboard — select the text and press Ctrl+C.";
  sdkModal.hidden = false;
  $("sdk-text").focus();
  $("sdk-text").select();
}

async function copySdkPrompt(btn) {
  const text = await getSdkPrompt();
  if (!text) return alert("SDK-PROMPT.md wasn't found next to server.js.");
  if (await copyText(text)) {
    if (btn) flashLabel(btn, "Copied ✓");
    return;
  }
  openSdkModal(text); // fall back to manual copy
}

$("btn-sdk").onclick = () => {
  $("settings-menu").hidden = true;
  copySdkPrompt($("btn-sdk"));
};
$("btn-sdk-2").onclick = () => copySdkPrompt($("btn-sdk-2"));
$("sdk-close").onclick = () => (sdkModal.hidden = true);
sdkModal.onclick = (e) => { if (e.target === sdkModal) sdkModal.hidden = true; };
$("sdk-copy").onclick = async () => {
  const ok = await copyText($("sdk-text").value);
  $("sdk-sub").textContent = ok
    ? "Copied to clipboard ✓"
    : "Select the text and press Ctrl+C.";
  $("sdk-text").select();
};

/* ------------------------------------------------------------- changelog */

// Minimal renderer for the subset of Markdown the changelog uses.
function renderMarkdown(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Code spans are pulled out first so their contents (e.g. `RACK_*`) can't be
  // mistaken for bold/italic markers, then put back at the end.
  const inline = (s) => {
    const codes = [];
    let t = esc(s).replace(/`([^`]+)`/g, (_, c) => ` ${codes.push(c) - 1} `);
    t = t
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
    return t.replace(/ (\d+) /g, (_, i) => `<code>${codes[i]}</code>`);
  };
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    // continuation of a wrapped bullet
    if (inList && /^\s{2,}\S/.test(raw)) {
      out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, " " + inline(line.trim()) + "</li>");
      continue;
    }
    closeList();
    if (/^#\s+/.test(line)) continue; // document title — the modal has its own
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) { out.push(`<h4>${inline(h2[1])}</h4>`); continue; }
    const h3 = /^###\s+(.*)$/.exec(line);
    if (h3) { out.push(`<h5>${inline(h3[1])}</h5>`); continue; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

const changelogModal = $("changelog-modal");
$("btn-version").onclick = async () => {
  $("settings-menu").hidden = true;
  $("changelog-body").innerHTML = "<p class='muted'>Loading…</p>";
  changelogModal.hidden = false;
  const { text } = await api("/api/changelog");
  $("changelog-body").innerHTML = text
    ? renderMarkdown(text)
    : "<p class='muted'>No CHANGELOG.md found next to server.js.</p>";
};
$("changelog-close").onclick = () => (changelogModal.hidden = true);
changelogModal.onclick = (e) => { if (e.target === changelogModal) changelogModal.hidden = true; };

function pollBackAndReload() {
  const timer = setInterval(async () => {
    try {
      const r = await fetch("/api/version", { cache: "no-store" });
      if (r.ok) { clearInterval(timer); location.reload(); }
    } catch {}
  }, 1000);
}

$("btn-update-rack").onclick = async () => {
  // Only an update for Rack itself has anything to run; otherwise the item is
  // just a status line (app updates live on each app's ⟳ Update).
  if (updates.checking || !hasUpdate(updates.rack)) {
    if (!updates.checking && (updates.rack?.error || !updates.checkedAt)) checkNow(); // retry a failed check
    return;
  }
  $("settings-menu").hidden = true;
  $("update-title").textContent = "Update Rack";
  $("update-sub").textContent = "Checking for updates…";
  $("update-log").innerHTML = "";
  $("update-modal").hidden = false;
  const res = await api("/api/self-update", { method: "POST" });
  if (res.error) {
    appendLine($("update-log"), "err", "[update] " + res.error);
    $("update-sub").textContent = "Update unavailable.";
  }
};

/* ------------------------------------------------------------- api */

async function api(path, opts) {
  const res = await fetch(path, opts);
  return res.json();
}

async function refreshApps() {
  const data = await api("/api/apps");
  appsList = data.apps || [];
  conflictsList = data.conflicts || [];
  if (selectedId && !appsList.find((a) => a.id === selectedId)) selectedId = null;
  renderSidebar();
  renderPanel();
  renderConsoles();
  renderStats();
}

function selected() {
  return appsList.find((a) => a.id === selectedId) || null;
}

/* ------------------------------------------------------------- sidebar */

let collapsedCats = new Set(JSON.parse(localStorage.getItem("collapsedCats") || "[]"));
function saveCollapsed() {
  localStorage.setItem("collapsedCats", JSON.stringify([...collapsedCats]));
}

let filterText = ""; // lowercased sidebar filter
let drag = null; // { kind:"app", id } | { kind:"cat", cat } while a sidebar drag is in flight
let sidebarDirty = false; // a render was skipped mid-drag — run it once the drag ends

/* Apps grouped for display: [{ cat, apps }] — uncategorized first, headerless. */
function appGroups() {
  const groups = new Map();
  for (const app of appsList) {
    const key = app.category || "";
    if (!groups.has(key)) groups.set(key, { cat: key, apps: [] });
    groups.get(key).apps.push(app);
  }
  // sort() is stable, so this only floats the uncategorized group to the top
  return [...groups.values()].sort((a, b) => (a.cat === "" ? -1 : b.cat === "" ? 1 : 0));
}

function matchesFilter(app) {
  if (!filterText) return true;
  const hay = [app.name, app.category || "", ...(app.commands || []).map((c) => c.name)]
    .join(" ")
    .toLowerCase();
  return hay.includes(filterText);
}

function appItem(app) {
  const btn = document.createElement("button");
  btn.className = "app-item" + (app.id === selectedId ? " selected" : "");
  btn.dataset.id = app.id;
  const upd = updatesFor(app.id);
  btn.innerHTML =
    `<span class="dot ${app.running ? "running" : ""}"></span>` +
    `<span class="name"></span>` +
    `<span class="usage">${usageText(app)}</span>` +
    (app.autostart ? `<span class="auto-badge" title="Auto-starts on launch">⚡</span>` : "") +
    (hasUpdate(upd) ? `<span class="upd-badge">⟳</span>` : "");
  btn.querySelector(".name").textContent = app.name;
  if (hasUpdate(upd)) btn.querySelector(".upd-badge").title = updateTitle(upd, app.name);
  btn.onclick = () => selectApp(app.id);
  if (!filterText) makeAppDraggable(btn, app); // order is meaningless while filtering
  return btn;
}

function renderSidebar() {
  if (drag) {
    sidebarDirty = true; // rebuilding the list mid-drag would drop the drag
    return;
  }
  const list = $("app-list");
  list.innerHTML = "";
  list.classList.remove("dragging");
  $("overview-btn").classList.toggle("selected", !selectedId);

  const groups = appGroups()
    .map((g) => ({ cat: g.cat, apps: g.apps.filter(matchesFilter) }))
    .filter((g) => g.apps.length);

  if (!groups.length) {
    if (filterText) {
      const empty = document.createElement("p");
      empty.className = "list-empty";
      empty.textContent = `No app matches “${filterText}”.`;
      list.appendChild(empty);
    }
    return;
  }

  for (const { cat, apps } of groups) {
    if (!cat) {
      apps.forEach((a) => list.appendChild(appItem(a)));
      continue;
    }
    const collapsed = !filterText && collapsedCats.has(cat);
    const header = document.createElement("button");
    header.className = "cat-header" + (collapsed ? " collapsed" : "");
    header.innerHTML = `<span class="chev">▾</span><span class="cat-name"></span><span class="cat-count">${apps.length}</span>`;
    header.querySelector(".cat-name").textContent = cat;
    header.onclick = () => {
      if (collapsedCats.has(cat)) collapsedCats.delete(cat);
      else collapsedCats.add(cat);
      saveCollapsed();
      renderSidebar();
    };
    if (!filterText) makeCatDraggable(header, cat);
    catDropTarget(header, cat);
    list.appendChild(header);
    if (!collapsed) apps.forEach((a) => list.appendChild(appItem(a)));
  }
}

/* --------------------------------------------------- sidebar drag & drop */

function clearDropMarks() {
  for (const el of $("app-list").querySelectorAll(".drop-before, .drop-after, .drop-into"))
    el.classList.remove("drop-before", "drop-after", "drop-into");
}

function beforeMidpoint(e, el) {
  const box = el.getBoundingClientRect();
  return e.clientY < box.top + box.height / 2;
}

function startDrag(e, what) {
  drag = what;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", what.id || what.cat); // Firefox needs a payload
  $("app-list").classList.add("dragging");
  if (what.kind === "app") showUncatZone();
}

function endDrag() {
  drag = null;
  clearDropMarks();
  const list = $("app-list");
  list.classList.remove("dragging");
  const zone = list.querySelector(".uncat-zone");
  if (zone) zone.remove();
  if (sidebarDirty) {
    sidebarDirty = false;
    renderSidebar();
  }
}

// A drop strip at the top of the list, live only while an app is being dragged,
// so an app can be pulled back out of its category.
function showUncatZone() {
  const list = $("app-list");
  if (list.querySelector(".uncat-zone") || !appsList.some((a) => a.category)) return;
  const zone = document.createElement("div");
  zone.className = "uncat-zone";
  zone.textContent = "no category";
  zone.addEventListener("dragover", (e) => {
    if (!drag || drag.kind !== "app") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropMarks();
    zone.classList.add("drop-into");
  });
  zone.addEventListener("drop", (e) => {
    if (!drag || drag.kind !== "app") return;
    e.preventDefault();
    commitDrop({ kind: "header", cat: "" });
  });
  list.prepend(zone);
}

function makeAppDraggable(btn, app) {
  btn.draggable = true;
  btn.addEventListener("dragstart", (e) => {
    btn.classList.add("dragging-item");
    startDrag(e, { kind: "app", id: app.id });
  });
  btn.addEventListener("dragend", () => {
    btn.classList.remove("dragging-item");
    endDrag();
  });
  btn.addEventListener("dragover", (e) => {
    if (!drag || drag.kind !== "app") return; // a category drops on headers only
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropMarks();
    if (drag.id !== app.id) btn.classList.add(beforeMidpoint(e, btn) ? "drop-before" : "drop-after");
  });
  btn.addEventListener("drop", (e) => {
    if (!drag || drag.kind !== "app") return;
    e.preventDefault();
    e.stopPropagation();
    if (drag.id === app.id) return endDrag();
    commitDrop({ kind: "app", id: app.id, after: !beforeMidpoint(e, btn) });
  });
}

function makeCatDraggable(header, cat) {
  header.draggable = true;
  header.addEventListener("dragstart", (e) => {
    e.stopPropagation();
    startDrag(e, { kind: "cat", cat });
  });
  header.addEventListener("dragend", () => endDrag());
}

function catDropTarget(header, cat) {
  header.addEventListener("dragover", (e) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropMarks();
    if (drag.kind === "app") header.classList.add("drop-into");
    else if (drag.cat !== cat)
      header.classList.add(beforeMidpoint(e, header) ? "drop-before" : "drop-after");
  });
  header.addEventListener("drop", (e) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    if (drag.kind === "app") return commitDrop({ kind: "header", cat });
    if (drag.cat === cat) return endDrag();
    commitDrop({ kind: "cat", cat, after: !beforeMidpoint(e, header) });
  });
}

/* Apply the drop to the grouped model, then flatten it back into appsList —
   so the stored app order always matches what the sidebar shows. */
function commitDrop(target) {
  const groups = appGroups();

  if (drag.kind === "cat") {
    const from = groups.findIndex((g) => g.cat === drag.cat);
    const [moved] = from < 0 ? [] : groups.splice(from, 1);
    if (!moved) return endDrag();
    let to = groups.findIndex((g) => g.cat === target.cat);
    if (to < 0) to = groups.length;
    else if (target.after) to += 1;
    groups.splice(to, 0, moved);
  } else {
    let moved = null;
    for (const g of groups) {
      const i = g.apps.findIndex((a) => a.id === drag.id);
      if (i >= 0) {
        moved = g.apps.splice(i, 1)[0];
        break;
      }
    }
    if (!moved) return endDrag();

    if (target.kind === "app") {
      const g = groups.find((gr) => gr.apps.some((a) => a.id === target.id));
      if (!g) return endDrag();
      g.apps.splice(g.apps.findIndex((a) => a.id === target.id) + (target.after ? 1 : 0), 0, moved);
    } else {
      let g = groups.find((gr) => gr.cat === target.cat);
      if (!g) groups.push((g = { cat: target.cat, apps: [] }));
      g.apps.unshift(moved);
      if (collapsedCats.delete(target.cat)) saveCollapsed(); // show where it landed
    }
  }

  const kept = groups.filter((g) => g.apps.length);
  kept.sort((a, b) => (a.cat === "" ? -1 : b.cat === "" ? 1 : 0));
  appsList = kept.flatMap((g) => g.apps.map((a) => ({ ...a, category: g.cat || null })));

  drag = null;
  sidebarDirty = false;
  clearDropMarks();
  renderSidebar();
  saveOrder();
}

async function saveOrder() {
  const res = await api("/api/apps/reorder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      order: appsList.map((a) => ({ id: a.id, category: a.category || "" })),
    }),
  });
  if (res && res.error) {
    alert("Couldn't save the new order: " + res.error);
    refreshApps();
  }
}

/* ------------------------------------------------------------- filter */

const filterInput = $("app-filter");

function setFilter(text) {
  filterInput.value = text;
  filterText = text.trim().toLowerCase();
  $("filter-clear").hidden = !text;
  renderSidebar();
}

filterInput.addEventListener("input", () => setFilter(filterInput.value));
filterInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation(); // don't also close a modal
    setFilter("");
    filterInput.blur();
  } else if (e.key === "Enter") {
    const first = $("app-list").querySelector(".app-item");
    if (first) {
      selectApp(first.dataset.id);
      filterInput.blur();
    }
  }
});
$("filter-clear").onclick = () => {
  setFilter("");
  filterInput.focus();
};

function selectApp(id) {
  selectedId = id || null;
  try {
    if (selectedId) localStorage.setItem("selected", selectedId);
    else localStorage.removeItem("selected");
  } catch {}
  renderSidebar();
  renderPanel();
  renderConsoles();
  renderStats();
  loadLogs();
  showMain(true);
}
$("overview-btn").onclick = () => selectApp(null);

/* ------------------------------------------------------------- phone layout */

// On a narrow screen the sidebar and the app are two pages: pick an app, see
// it; ‹ (or the phone's own back gesture) goes back to the list.
const narrow = matchMedia("(max-width: 760px)");
const onMainPage = () => !!(history.state && history.state.rackMain);

function showMain(on) {
  document.body.classList.toggle("m-main", on);
  if (!narrow.matches) return;
  if (on && !onMainPage()) history.pushState({ rackMain: true }, "");
  window.scrollTo(0, 0);
}
window.addEventListener("popstate", () => {
  document.body.classList.toggle("m-main", onMainPage());
  window.scrollTo(0, 0);
});
$("btn-back").onclick = () => (onMainPage() ? history.back() : showMain(false));

/* ------------------------------------------------------------- panel */

function fmtUptime(startedAt) {
  let s = Math.floor((Date.now() - startedAt) / 1000);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function renderPanel() {
  const app = selected();
  clearInterval(uptimeTimer);

  $("empty-hint").hidden = appsList.length > 0;
  $("panel").hidden = !app;
  $("overview").hidden = !!app || !appsList.length;
  document.querySelector(".topbar-right").hidden = !app;
  $("btn-run").disabled = !app || app.running;
  $("btn-kill").disabled = !app || !app.running;
  $("btn-edit").disabled = !app;
  $("btn-update").hidden = !app || !(app.update || app.rebuildStep);

  const upd = app ? updatesFor(app.id) : null;
  const behind = hasUpdate(upd);
  $("btn-update").textContent = behind ? `⟳ Update — ${upd.behind} new` : "⟳ Update";
  $("btn-update").classList.toggle("has-update", behind);
  $("btn-update").title = upd
    ? updateTitle(upd, app.name)
    : "Fetch a new version of this app";

  if (!app) {
    const live = appsList.filter((a) => a.running).length;
    $("sel-name").textContent = appsList.length ? "Overview" : "No apps yet";
    $("sel-status").className = "status-pill " + (live ? "running" : "stopped");
    $("sel-status").textContent = `${live} / ${appsList.length} running`;
    $("sel-status").hidden = !appsList.length;
    return;
  }
  $("sel-status").hidden = false;

  $("sel-name").textContent = app.name;
  $("sel-status").className = "status-pill " + (app.running ? "running" : "stopped");
  $("sel-status").textContent = app.running ? "running" : "stopped";

  $("stat-status").textContent = app.running ? "running" : "stopped";
  $("stat-status").className = "stat-value " + (app.running ? "running" : "stopped");
  $("stat-consoles").textContent = `${app.runningCount} / ${app.total}`;
  $("stat-ports").textContent = app.ports.length ? app.ports.join(", ") : "—";
  $("term-running").textContent = app.runningCount;

  const tick = () => {
    $("stat-uptime").textContent = app.running && app.startedAt ? fmtUptime(app.startedAt) : "—";
  };
  tick();
  if (app.running) uptimeTimer = setInterval(tick, 1000);

  renderConflictBanner();
  renderDetails(app);
}

function renderConflictBanner() {
  const banner = $("conflict-banner");
  if (!conflictsList.length) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.className = "banner";
  banner.innerHTML =
    "⚠ Port conflict — these are hardcoded so the controller can't move them: " +
    conflictsList
      .map(
        (c) =>
          `<b>${c.port}</b> (${c.holders.map((h) => `${h.app}/${h.cmd}`).join(", ")})`
      )
      .join("; ");
}

/* ------------------------------------------------------------- public access */

// The details card only *shows* how a process is exposed; changing it happens
// in the Exposure manager, which sees every route on the machine at once.

let funnelInfo = { available: false, active: [] };
let cfInfo = { available: false, tunnels: [], active: [] };

async function loadFunnel() {
  try {
    funnelInfo = await fetch("/api/funnel").then((r) => r.json());
  } catch {
    funnelInfo = { available: false, active: [] };
  }
}

async function loadCf() {
  try {
    cfInfo = await fetch("/api/cf").then((r) => r.json());
  } catch {
    cfInfo = { available: false, tunnels: [], active: [] };
  }
  setCfMenuLabel();
}

// The ⚙ menu is where you find out Cloudflare is there at all before
// cloudflared is installed.
function setCfMenuLabel() {
  const b = $("btn-cf");
  if (!b) return;
  const ready = !!(cfInfo.available && cfInfo.loggedIn);
  b.querySelector("span").textContent = ready ? "Cloudflare: ready" : "Set up Cloudflare";
  b.classList.toggle("on", ready);
}
$("btn-cf").onclick = () => {
  settingsMenu.hidden = true;
  openCfSetup();
};

const loadPublic = () => Promise.all([loadFunnel(), loadCf()]);

// The live cloudflared process for one command, if Rack is running one.
function cfLiveFor(appId, idx) {
  return cfInfo.active.find((a) => a.appId === appId && a.cmdIndex === idx) || null;
}

function cfPost(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// One line per process: every route it is published on, and a way in to the
// manager with this process already picked.
function renderExposureRow(row, app, cmd, idx) {
  if (!row) return;
  if (!cmd.effPort) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  row.innerHTML = "";

  const label = document.createElement("span");
  label.className = "funnel-label";
  label.textContent = "Exposure";
  row.appendChild(label);

  // A route's badge and its link wrap as one.
  let routes = 0;
  const route = (...els) => {
    routes++;
    const span = document.createElement("span");
    span.className = "exp-route";
    for (const el of els) if (el) span.appendChild(el);
    row.appendChild(span);
  };

  for (const sh of (funnelInfo.active || []).filter((a) => a.localPort === cmd.effPort)) {
    route(
      publicBadge(sh.isFunnel ? `● Internet · Funnel :${sh.publicPort}` : `● Tailnet · :${sh.publicPort}`, sh.isFunnel ? "on" : "tailnet"),
      publicLink(sh.url, sh.isFunnel ? "Public URL ↗" : "Tailnet URL ↗")
    );
  }

  const bind = cmd.cloudflare;
  if (bind && bind.tunnel) {
    const live = cfLiveFor(app.id, idx);
    const status = live ? live.status : "off";
    const badge = !cmd.running
      ? publicBadge(`○ Cloudflare ${bind.tunnel} · waits for the process`, "idle")
      : status === "public"
      ? publicBadge(`● Internet · Cloudflare ${bind.tunnel}`, "on")
      : status === "connecting"
      ? publicBadge(`◌ Cloudflare ${bind.tunnel} · connecting…`, "idle")
      : status === "failed"
      ? publicBadge(`● Cloudflare ${bind.tunnel} · failed`, "err")
      : publicBadge(`○ Cloudflare ${bind.tunnel} · off`, "idle");
    if (live && live.error) badge.title = live.error;
    route(badge, bind.hostname && publicLink(`https://${bind.hostname}`, "Public URL ↗"));
  }

  if (!routes) route(publicBadge("Not exposed", "idle"));

  const btn = document.createElement("button");
  btn.className = "btn btn-ghost btn-sm exp-open";
  btn.textContent = "◎ Exposure manager";
  btn.title = "Share this process on your tailnet or the internet, or change how it's shared";
  btn.onclick = () => openExposure({ appId: app.id, cmdIndex: idx });
  row.appendChild(btn);
}

function publicLink(href, text) {
  const a = document.createElement("a");
  a.className = "btn btn-link funnel-url";
  a.target = "_blank";
  a.href = href;
  a.textContent = text || "Public URL ↗";
  a.title = href;
  return a;
}

function publicBadge(text, kind) {
  const s = document.createElement("span");
  s.className = "funnel-live " + kind;
  s.textContent = text;
  return s;
}

function linksFor(cmd) {
  if (!cmd.effPort) return [];
  const base = `http://127.0.0.1:${cmd.effPort}`;
  if (Array.isArray(cmd.links) && cmd.links.length) {
    return cmd.links.map((l) => [l.label || "Open", base + (l.path || "/")]);
  }
  if (cmd.managePort) {
    return [
      ["Server", `${base}/`],
      ["Admin UI", `${base}/_/`],
      ["API", `${base}/api/`],
    ];
  }
  return [["Open", `${base}/`]];
}

// "Is there a new version of this app?" — shown in the details card so you can
// see it without running anything.
function updateNote(app) {
  if (!app.update && !app.rebuildStep) return null;
  const info = updatesFor(app.id);
  const note = document.createElement("div");
  note.className = "upd-note";
  const line = document.createElement("div");
  note.appendChild(line);

  if (updates.checking) {
    line.textContent = "⟲ Checking for updates…";
  } else if (!info || (!info.repo && !info.reason && !info.error)) {
    line.textContent = "⟲ Not checked yet.";
  } else if (!info.repo) {
    line.textContent = `⟲ Can't check automatically (${info.reason || info.error}) — press ⟳ Update to find out.`;
  } else if (info.behind > 0) {
    note.className = "upd-note on";
    line.textContent = `⟳ ${info.behind} new commit${info.behind === 1 ? "" : "s"} on ${info.upstream} — press ⟳ Update.`;
    const list = document.createElement("ul");
    for (const c of info.commits || []) {
      const li = document.createElement("li");
      li.textContent = c; // commit subjects are other people's text — never as HTML
      list.appendChild(li);
    }
    if (list.children.length) note.appendChild(list);
  } else {
    line.textContent = `✓ Up to date${info.head ? ` (${info.head})` : ""} · checked ${fmtAgo(updates.checkedAt)}`;
  }
  if (info && info.repo && info.error) {
    const warn = document.createElement("div");
    warn.className = "muted";
    warn.textContent = `⚠ ${info.error}`;
    note.appendChild(warn);
  }
  return note;
}

function renderDetails(app) {
  const wrap = $("det-commands");
  wrap.innerHTML = "";
  const upd = updateNote(app);
  if (upd) wrap.appendChild(upd);
  if (app.setup) {
    const note = document.createElement("div");
    note.className = "setup-note";
    note.innerHTML =
      `⚙ One-time setup: <code></code> <span class="muted">— run it once by hand, and after code changes.</span>`;
    note.querySelector("code").textContent = app.setup;
    wrap.appendChild(note);
  }
  app.commands.forEach((cmd, idx) => {
    const el = document.createElement("div");
    el.className = "det-cmd";
    const cmdLine = cmd.raw ? cmd.exe : cmd.exe;
    const argStr = (cmd.args || []).join(" ") || "(none)";
    el.innerHTML = `
      <div class="det-cmd-head">
        <span class="dot ${cmd.running ? "running" : ""}"></span>
        <span class="name"></span>
      </div>
      <dl>
        <dt>Command</dt><dd class="c-exe"></dd>
        <dt>Arguments</dt><dd class="c-args"></dd>
        <dt>Folder</dt><dd class="c-dir"></dd>
        <dt>Port</dt><dd class="c-port"></dd>
        <dt>Usage</dt><dd class="c-usage" data-cmd="${idx}">—</dd>
      </dl>
      <div class="det-links"></div>
      <div class="funnel-row" hidden></div>`;
    el.querySelector(".name").textContent = cmd.name;
    el.querySelector(".c-exe").textContent = cmdLine;
    el.querySelector(".c-args").textContent = argStr;
    el.querySelector(".c-dir").textContent = cmd.dir;
    el.querySelector(".c-port").textContent =
      cmd.effPort ? cmd.effPort + (cmd.managePort ? " (managed)" : " (declared)") : "—";
    const links = el.querySelector(".det-links");
    for (const [label, href] of linksFor(cmd)) {
      const a = document.createElement("a");
      a.className = "btn btn-link";
      a.target = "_blank";
      a.href = href;
      a.textContent = `${label} ↗`;
      links.appendChild(a);
    }
    renderExposureRow(el.querySelector(".funnel-row"), app, cmd, idx);
    wrap.appendChild(el);
  });
}

/* ------------------------------------------------------------- consoles */

function renderConsoles() {
  const app = selected();
  const container = $("term-container");
  if (!app) {
    container.innerHTML = "";
    consolesKey = "";
    return;
  }
  const key = app.id + "|" + app.commands.map((c) => c.name).join("|");
  if (key === consolesKey) {
    updateConsoleDots();
    return;
  }
  consolesKey = key;

  container.innerHTML = "";
  app.commands.forEach((cmd, i) => {
    const t = document.createElement("div");
    t.className = "terminal";
    t.dataset.cmd = i;
    t.innerHTML = `
      <div class="term-head">
        <span class="dot ${cmd.running ? "running" : ""}"></span>
        <span class="name"></span>
        <span class="err-badge" hidden>⚠ 0</span>
        <button class="term-clear">Clear</button>
      </div>
      <pre class="term" data-cmd="${i}"></pre>`;
    t.querySelector(".name").textContent = cmd.name;
    const pre = t.querySelector("pre");
    t.querySelector(".err-badge").onclick = (e) => {
      pre.classList.toggle("errors-only");
      e.target.textContent = pre.classList.contains("errors-only")
        ? e.target.textContent.replace("⚠", "◧")
        : e.target.textContent.replace("◧", "⚠");
    };
    t.querySelector(".term-clear").onclick = async () => {
      await api(`/api/apps/${app.id}/clear?cmd=${i}`, { method: "POST" });
      pre.innerHTML = "";
      setBadge(i, 0);
    };
    container.appendChild(t);
  });
  applyVisible();
}

function updateConsoleDots() {
  const app = selected();
  if (!app) return;
  document.querySelectorAll("#term-container .terminal").forEach((t) => {
    const i = Number(t.dataset.cmd);
    const cmd = app.commands[i];
    if (cmd) t.querySelector(".dot").className = "dot" + (cmd.running ? " running" : "");
  });
}

function applyVisible() {
  const panels = [...$("term-container").children];
  const total = panels.length;
  if (visibleCount >= 99 || total <= visibleCount) {
    panels.forEach((p) => (p.style.flex = "1 1 0"));
  } else {
    const v = visibleCount;
    panels.forEach((p) => (p.style.flex = `0 0 calc((100% - ${(v - 1) * 10}px) / ${v})`));
  }
}

$("term-visible").onchange = (e) => {
  visibleCount = Number(e.target.value);
  applyVisible();
};

function preFor(cmd) {
  return document.querySelector(`#term-container pre[data-cmd="${cmd}"]`);
}
function badgeFor(cmd) {
  const t = document.querySelector(`#term-container .terminal[data-cmd="${cmd}"]`);
  return t ? t.querySelector(".err-badge") : null;
}
function setBadge(cmd, n) {
  const b = badgeFor(cmd);
  if (!b) return;
  b.hidden = n === 0;
  b.textContent = (b.textContent.startsWith("◧") ? "◧ " : "⚠ ") + n;
  b.dataset.count = n;
}

function appendLine(pre, stream, line) {
  if (!pre) return;
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  const div = document.createElement("div");
  div.className = stream === "err" ? "ln-err" : "ln-out";
  div.textContent = line;
  pre.appendChild(div);
  while (pre.childNodes.length > 700) pre.removeChild(pre.firstChild);
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

async function loadLogs() {
  const app = selected();
  if (!app) return;
  const perCmd = await api(`/api/apps/${app.id}/logs`);
  perCmd.forEach((c, i) => {
    const pre = preFor(i);
    if (!pre) return;
    pre.innerHTML = "";
    for (const entry of c.log) appendLine(pre, entry.s, entry.line);
    setBadge(i, c.errCount || 0);
  });
}

/* ------------------------------------------------------------- actions */

$("btn-run").onclick = async () => {
  $("btn-run").disabled = true;
  await api(`/api/apps/${selectedId}/start`, { method: "POST" });
};
$("btn-kill").onclick = async () => {
  $("btn-kill").disabled = true;
  await api(`/api/apps/${selectedId}/stop`, { method: "POST" });
};
$("btn-delete").onclick = async () => {
  const app = selected();
  if (!app) return;
  if (!confirm(`Remove "${app.name}" from the controller?\n(The app's files are NOT deleted.)`)) return;
  await api(`/api/apps/${selectedId}`, { method: "DELETE" });
};

/* ------------------------------------------------------------- update */

const updateModal = $("update-modal");
$("btn-update").onclick = async () => {
  const app = selected();
  if (!app || !(app.update || app.rebuildStep)) return;
  const steps = [app.update, app.rebuildStep].filter(Boolean);
  $("update-title").textContent = `Update — ${app.name}`;
  $("update-sub").textContent = `Running: ${steps.join("  →  ")}`;
  $("update-log").innerHTML = "";
  updateModal.hidden = false;
  const res = await api(`/api/apps/${app.id}/update`, { method: "POST" });
  if (res.error) appendLine($("update-log"), "err", "[update] " + res.error);
};
$("update-close").onclick = () => (updateModal.hidden = true);
updateModal.onclick = (e) => { if (e.target === updateModal) updateModal.hidden = true; };

/* ------------------------------------------------------------- cloudflare modals */

const cfModal = $("cf-modal");
const cfSetupModal = $("cf-setup-modal");
const cfLogModal = $("cf-log-modal");
let cfTarget = null; // { appId, cmdIndex } the dialog is publishing

let cfSetupRunning = null; // which step Rack is running right now, if any

// Re-read the world and repaint the dialog. Kept separate from opening it so a
// finished step can refresh the ticks without wiping the log you just watched.
async function cfRefreshSetup() {
  await loadCf();
  $("cf-step-install").textContent = cfInfo.install || "install cloudflared";

  const installed = !!cfInfo.available;
  const loggedIn = !!(cfInfo.available && cfInfo.loggedIn);
  $("cf-step-1").classList.toggle("done", installed);
  $("cf-step-2").classList.toggle("done", loggedIn);
  $("cf-setup-state").textContent = cfSetupRunning
    ? "Running — watch the log above."
    : !installed
    ? "Press Run, or paste the command into a terminal yourself."
    : !loggedIn
    ? "cloudflared is installed. Press Run to log in and pick your domain."
    : cfInfo.tunnels.length
    ? "All set — expose a process from ◎ Exposure manager → Internet — Cloudflare tunnel."
    : "All set — in ◎ Exposure manager pick a process, Internet — Cloudflare tunnel, then ＋ New tunnel…";

  const done = { install: installed, login: loggedIn };
  cfSetupModal.querySelectorAll(".cf-run").forEach((b) => {
    const step = b.dataset.step;
    const running = cfSetupRunning === step;
    b.hidden = done[step]; // nothing left to run for a finished step
    b.textContent = running ? "Stop" : "▶ Run";
    b.classList.toggle("btn-kill", running);
    // Another step is busy, or logging in before cloudflared exists.
    b.disabled = (!!cfSetupRunning && !running) || (step === "login" && !installed);
  });
}

async function openCfSetup() {
  cfSetupModal.hidden = false;
  $("cf-setup-log").hidden = true;
  $("cf-setup-log").innerHTML = "";
  await cfRefreshSetup(); // re-probe on open, so a fresh install shows up at once
}

// Run is the easy path; the command still copies, because a step that fails for
// want of admin rights is one you finish in a terminal.
cfSetupModal.querySelectorAll(".cf-steps code").forEach((el) => {
  el.title = "Click to copy";
  el.onclick = async () => {
    const old = el.textContent;
    if (await copyText(old)) {
      el.textContent = "copied ✓";
      setTimeout(() => (el.textContent = old), 1200);
    }
  };
});

cfSetupModal.querySelectorAll(".cf-run").forEach((b) => {
  b.onclick = async () => {
    const step = b.dataset.step;
    if (cfSetupRunning === step) {
      const res = await cfPost("/api/cf/setup/cancel", {});
      if (res.error) appendLine($("cf-setup-log"), "err", "[setup] " + res.error);
      return;
    }
    $("cf-setup-log").hidden = false;
    $("cf-setup-log").innerHTML = "";
    cfSetupRunning = step;
    await cfRefreshSetup();
    const res = await cfPost("/api/cf/setup", { step });
    if (res.error) {
      appendLine($("cf-setup-log"), "err", "[setup] " + res.error);
      cfSetupRunning = null;
      await cfRefreshSetup();
    }
  };
});
$("cf-setup-close").onclick = () => (cfSetupModal.hidden = true);
cfSetupModal.onclick = (e) => { if (e.target === cfSetupModal) cfSetupModal.hidden = true; };

// `name` is set when attaching to a tunnel that already exists but whose
// hostname Rack doesn't know yet.
function openCfModal(app, idx, name) {
  cfTarget = { appId: app.id, cmdIndex: idx };
  const cmd = app.commands[idx];
  $("cf-title").textContent = `Publish ${app.name} / ${cmd.name}`;
  $("cf-sub").textContent = name
    ? `Tunnel "${name}" exists — tell Rack which hostname it should serve on.`
    : `Give port ${cmd.effPort} a permanent public hostname on your own domain.`;
  $("cf-name").value = name || app.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  $("cf-host").value = "";
  $("cf-auto").checked = true;
  $("cf-log").hidden = true;
  $("cf-log").innerHTML = "";
  $("cf-error").hidden = true;
  $("cf-save").disabled = false;
  cfModal.hidden = false;
  $(name ? "cf-host" : "cf-name").focus();
}

$("cf-cancel").onclick = () => (cfModal.hidden = true);
cfModal.onclick = (e) => { if (e.target === cfModal) cfModal.hidden = true; };

$("cf-save").onclick = async () => {
  if (!cfTarget) return;
  const name = $("cf-name").value.trim();
  const hostname = $("cf-host").value.trim();
  $("cf-error").hidden = true;
  $("cf-log").hidden = false;
  $("cf-log").innerHTML = "";
  $("cf-save").disabled = true;
  const res = await cfPost("/api/cf/create", { name, hostname });
  if (res.error) {
    $("cf-error").textContent = res.error;
    $("cf-error").hidden = false;
    $("cf-save").disabled = false;
  }
  // otherwise the cf-done event finishes the job
};

// Fired when `tunnel create` + `route dns` have finished — bind the process to
// the tunnel and bring it up.
async function cfCreateDone(ev) {
  if (!cfTarget) return;
  if (!ev.ok) {
    $("cf-error").textContent = ev.error || "Setting up the tunnel failed — see the log above.";
    $("cf-error").hidden = false;
    $("cf-save").disabled = false;
    return;
  }
  const res = await cfPost("/api/cf", {
    appId: cfTarget.appId,
    cmdIndex: cfTarget.cmdIndex,
    tunnel: ev.name,
    hostname: ev.hostname,
    auto: $("cf-auto").checked,
  });
  if (res.error) {
    $("cf-error").textContent = res.error;
    $("cf-error").hidden = false;
    $("cf-save").disabled = false;
    return;
  }
  cfModal.hidden = true;
  cfTarget = null;
  await loadPublic();
  await refreshApps();
  expSoon(false);
}

async function openCfLog(app, idx) {
  $("cf-log-title").textContent = `Tunnel log — ${app.name} / ${app.commands[idx].name}`;
  $("cf-log-body").innerHTML = "";
  cfLogModal.hidden = false;
  const res = await api(`/api/cf/log?app=${encodeURIComponent(app.id)}&cmd=${idx}`);
  for (const l of res.log || []) appendLine($("cf-log-body"), l.s, l.line);
}
$("cf-log-close").onclick = () => (cfLogModal.hidden = true);
cfLogModal.onclick = (e) => { if (e.target === cfLogModal) cfLogModal.hidden = true; };

/* ------------------------------------------------------------- editor modal */

const modal = $("modal");
let editingId = null;

// A process needs a command and (sometimes) a port; everything else hides
// behind ⋯ until it's actually used.
function addProcRow(cmd) {
  const tpl = $("proc-tpl").content.cloneNode(true);
  const row = tpl.querySelector(".proc-row");
  const extra = row.querySelector(".proc-extra");
  if (cmd) {
    row.querySelector(".proc-name").value = cmd.name || "";
    row.querySelector(".proc-path").value = cmd.exe || "";
    row.querySelector(".proc-args").value = (cmd.args || []).join(" ");
    row.querySelector(".proc-port").value = cmd.port || "";
    row.querySelector(".proc-dir").value = cmd.dir || "";
    row.querySelector(".proc-stop").value = cmd.stopCommand || "";
    // don't hide fields an existing app actually uses
    extra.hidden = ![...extra.querySelectorAll("input")].some((i) => i.value.trim());
  }
  row.querySelector(".proc-more").onclick = () => {
    extra.hidden = !extra.hidden;
    if (!extra.hidden) extra.querySelector("input").focus();
  };
  row.querySelector(".proc-remove").onclick = () => {
    if ($("proc-rows").children.length > 1) row.remove();
  };
  $("proc-rows").appendChild(row);
}

// The dialog does one of two things: install from GitHub, or wire up something
// already on this machine. Showing both at once is what made it a wall.
let editorMode = "github";
function setMode(mode) {
  editorMode = mode;
  $("tab-github").classList.toggle("on", mode === "github");
  $("tab-local").classList.toggle("on", mode === "local");
  $("pane-github").hidden = mode !== "github";
  $("pane-local").hidden = mode === "github";
  $("modal-save").hidden = mode === "github"; // Install is that pane's action
  $("modal-error").hidden = true;
  const first = mode === "github" ? $("inp-repo") : $("inp-name");
  first.focus();
}
$("tab-github").onclick = () => setMode("github");
$("tab-local").onclick = () => setMode("local");

function openEditor(app) {
  editingId = app ? app.id : null;
  $("modal-title").textContent = app ? "Edit app" : "Add app";
  $("mode-tabs").hidden = !!app; // editing is always local
  $("inp-repo").value = "";
  $("inp-name").value = app ? app.name : "";
  $("inp-category").value = app ? app.category || "" : "";
  $("inp-autostart").checked = app ? !!app.autostart : false;
  $("inp-update").value = app ? app.update || "" : "";
  $("inp-rebuild").value = app ? app.rebuild || "" : "";
  // populate category suggestions from existing apps
  const cats = [...new Set(appsList.map((a) => a.category).filter(Boolean))];
  $("cat-list").innerHTML = cats.map((c) => `<option value="${c.replace(/"/g, "&quot;")}">`).join("");
  $("proc-rows").innerHTML = "";
  if (app && app.commands.length) app.commands.forEach(addProcRow);
  else addProcRow();
  $("advanced").open = !!(app && (app.autostart || app.update || app.rebuild));
  $("modal-error").hidden = true;
  modal.hidden = false;
  setMode(app ? "local" : "github");
  if (app) $("inp-name").focus();
}

function collectSpecs() {
  return [...$("proc-rows").children].map((row) => ({
    name: row.querySelector(".proc-name").value,
    path: row.querySelector(".proc-path").value,
    args: row.querySelector(".proc-args").value,
    port: row.querySelector(".proc-port").value,
    dir: row.querySelector(".proc-dir").value,
    stopCommand: row.querySelector(".proc-stop").value,
  }));
}

// Paste a repo link → clone it into the apps folder → it shows up as an app.
$("btn-install").onclick = async () => {
  const url = $("inp-repo").value.trim();
  if (!url) return showModalError("Paste a repository link first.");
  if (!appsDir) return openFolderModal();
  modal.hidden = true;
  $("update-title").textContent = "Install from GitHub";
  $("update-sub").textContent = `Cloning into ${appsDir}…`;
  $("update-log").innerHTML = "";
  updateModal.hidden = false;
  const res = await api("/api/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (res.error) {
    appendLine($("update-log"), "err", "[install] " + res.error);
    $("update-sub").textContent = "Install failed.";
  }
};

$("add-app-btn").onclick = () => openEditor(null);
$("btn-edit").onclick = () => selected() && openEditor(selected());
$("sel-name").onclick = () => selected() && openEditor(selected());
$("add-proc").onclick = () => addProcRow();
$("modal-cancel").onclick = () => (modal.hidden = true);
modal.onclick = (e) => { if (e.target === modal) modal.hidden = true; };

$("modal-save").onclick = async () => {
  const specs = collectSpecs().filter((s) => s.path.trim());
  if (!specs.length) {
    showModalError("Add at least one process with a path or command.");
    return;
  }
  const body = JSON.stringify({
    name: $("inp-name").value,
    category: $("inp-category").value,
    autostart: $("inp-autostart").checked,
    update: $("inp-update").value,
    rebuild: $("inp-rebuild").value,
    commands: specs,
  });
  const opts = { method: editingId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body };
  const res = await api(editingId ? `/api/apps/${editingId}` : "/api/apps", opts);
  if (res.error) {
    showModalError(res.error);
    return;
  }
  modal.hidden = true;
  selectedId = res.app.id;
  await refreshApps();
  loadLogs();
  showPortInfo(res.portInfo);
};

function showModalError(msg) {
  $("modal-error").textContent = msg;
  $("modal-error").hidden = false;
}

function showPortInfo(info) {
  if (!info || !info.changes || !info.changes.length) return;
  const banner = $("conflict-banner");
  banner.hidden = false;
  banner.className = "banner info";
  banner.innerHTML =
    "↔ Auto-assigned free ports: " +
    info.changes.map((c) => `<b>${c.app}/${c.cmd}</b> ${c.from} → ${c.to}`).join("; ");
  setTimeout(() => renderConflictBanner(), 6000);
}

document.addEventListener("keydown", (e) => {
  // "/" or Ctrl/⌘-K jumps to the sidebar filter, unless something else has focus
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  const modalOpen = !!document.querySelector(".modal-backdrop:not([hidden])");
  if (!typing && !modalOpen && (e.key === "/" || ((e.ctrlKey || e.metaKey) && e.key === "k"))) {
    e.preventDefault();
    filterInput.focus();
    filterInput.select();
    return;
  }
  if (e.key === "Escape") {
    // The manager opens Cloudflare dialogs on top of itself; Esc closes those first.
    const stacked = [cfModal, cfSetupModal, cfLogModal].some((m) => !m.hidden);
    if (!stacked) expModal.hidden = true;
    modal.hidden = true;
    updateModal.hidden = true;
    changelogModal.hidden = true;
    sdkModal.hidden = true;
    cfModal.hidden = true;
    cfSetupModal.hidden = true;
    cfLogModal.hidden = true;
    folderModal.hidden = true;
  }
  if (e.key === "Enter" && !cfModal.hidden && e.target.tagName === "INPUT" && e.target.type === "text") {
    $("cf-save").click();
    return;
  }
  if (e.key === "Enter" && !modal.hidden && e.target.id === "inp-repo") {
    $("btn-install").click();
    return;
  }
  if (e.key === "Enter" && !modal.hidden && e.target.tagName !== "BUTTON") {
    // let Enter in a text field save, but not when focus is a button
    if (e.target.classList && e.target.classList.contains("proc-path")) return; // allow paste-heavy editing
    $("modal-save").click();
  }
});

/* ------------------------------------------------------------- usage stats */

// CPU and memory per app (its whole process tree) and for the machine. The
// server samples every few seconds and pushes each sample; the history it
// keeps is fetched once and then extended here the same way it extends it.

let stats = { interval: 4000, window: 600000, system: null, apps: {}, history: {}, systemHistory: [] };

async function loadStats() {
  try {
    stats = await api("/api/stats");
  } catch {}
  renderStats();
}

function applyStats(ev) {
  const cap = Math.round(ev.window / ev.interval);
  const push = (list, point) => {
    list.push(point);
    if (list.length > cap) list.splice(0, list.length - cap);
  };
  for (const app of appsList) {
    const s = ev.apps[app.id];
    let hist = stats.history[app.id];
    if (s) push(hist || (stats.history[app.id] = hist = []), { t: ev.at, cpu: s.cpu, mem: s.mem });
    else if (hist && hist.length && hist[hist.length - 1].mem != null) push(hist, { t: ev.at, cpu: null, mem: null });
  }
  push(stats.systemHistory, { t: ev.at, cpu: ev.system.cpu, mem: ev.system.memUsed });
  Object.assign(stats, { at: ev.at, interval: ev.interval, window: ev.window, system: ev.system, apps: ev.apps });
  renderStats();
}

const fmtCpu = (p) => (p == null ? "—" : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`);
function fmtMem(b) {
  if (b == null) return "—";
  if (b < 1024 ** 3) return `${Math.round(b / 1024 ** 2)} MB`;
  return `${(b / 1024 ** 3).toFixed(b < 10 * 1024 ** 3 ? 1 : 0)} GB`;
}
// 75% and up is worth a look, 90% and up is trouble.
const level = (pct) => (pct >= 90 ? "crit" : pct >= 75 ? "warn" : "");

function usageText(app) {
  const s = app.running && stats.apps[app.id];
  return s ? `${fmtCpu(s.cpu)} · ${fmtMem(s.mem)}` : "";
}

// A sparkline over the stats window: x is time (so it scrolls), y starts at
// zero. Gaps (null) are where the app was stopped. `fmt` labels the hover.
function drawSpark(svg, points, key, { floor, ceil, fmt }) {
  const now = stats.at || Date.now();
  const pts = points.filter((p) => now - p.t <= stats.window);
  const vals = pts.map((p) => p[key]).filter((v) => v != null);
  const max = Math.min(ceil || Infinity, Math.max(floor, ...vals) * 1.15);
  const x = (t) => 100 - ((now - t) / stats.window) * 100;
  const y = (v) => 31 - (v / max) * 29;

  let line = "";
  let area = "";
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const d = run.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(2)},${py.toFixed(2)}`).join("");
      line += d;
      area += `${d}L${run[run.length - 1][0].toFixed(2)},32L${run[0][0].toFixed(2)},32Z`;
    }
    run = [];
  };
  for (const p of pts) {
    if (p[key] == null) flush();
    else run.push([x(p.t), y(p[key])]);
  }
  flush();
  svg.innerHTML =
    `<path class="spark-area" d="${area}"/><path class="spark-line" d="${line}"/>` +
    `<line class="spark-x" x1="0" x2="0" y1="0" y2="32" visibility="hidden"/>`;

  // Hover (or drag a finger) to read a past value into the tile's note.
  const tile = svg.closest(".stat");
  const note = tile.querySelector(".stat-note");
  const rest = note.textContent;
  const cross = svg.querySelector(".spark-x");
  const read = (e) => {
    const box = svg.getBoundingClientRect();
    const t = now - (1 - (e.clientX - box.left) / box.width) * stats.window;
    let best = null;
    for (const p of pts) if (p[key] != null && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p;
    if (!best) return;
    cross.setAttribute("x1", x(best.t));
    cross.setAttribute("x2", x(best.t));
    cross.setAttribute("visibility", "visible");
    const ago = Math.round((Date.now() - best.t) / 1000);
    note.textContent = `· ${ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`} ago: ${fmt(best[key])}`;
    tile.classList.add("reading");
  };
  svg.onpointermove = svg.onpointerdown = read;
  svg.onpointerleave = svg.onpointerup = svg.onpointercancel = () => {
    cross.setAttribute("visibility", "hidden");
    note.textContent = rest;
    tile.classList.remove("reading");
  };
}

function setTile(id, value, note) {
  const tile = $(id);
  if (tile.classList.contains("reading")) return; // don't yank a value someone is reading
  tile.querySelector(".stat-value").textContent = value;
  tile.querySelector(".stat-note").textContent = note ? `· ${note}` : "";
}

function peak(points, key) {
  const now = stats.at || Date.now();
  const vals = points.filter((p) => now - p.t <= stats.window && p[key] != null).map((p) => p[key]);
  return vals.length ? Math.max(...vals) : null;
}

function renderStats() {
  // sidebar: a running app's live usage beside its name
  for (const el of document.querySelectorAll("#app-list .app-item")) {
    const app = appsList.find((a) => a.id === el.dataset.id);
    const u = el.querySelector(".usage");
    if (app && u) u.textContent = usageText(app);
  }
  const sys = stats.system;
  $("ov-usage").textContent = sys
    ? `CPU ${fmtCpu(sys.cpu)} · RAM ${Math.round((100 * sys.memUsed) / sys.memTotal)}%`
    : "";
  $("ov-usage").title = sys ? "Machine CPU · memory in use" : "";

  const app = selected();
  if (app) renderAppStats(app);
  else if (appsList.length) renderOverview();
}

function renderAppStats(app) {
  const s = app.running ? stats.apps[app.id] : null;
  const hist = stats.history[app.id] || [];
  const cpuPeak = peak(hist, "cpu");
  const memPeak = peak(hist, "mem");
  setTile("tile-cpu", s ? fmtCpu(s.cpu) : "—", cpuPeak != null ? `peak ${fmtCpu(cpuPeak)}` : "");
  setTile("tile-mem", s ? fmtMem(s.mem) : "—", memPeak != null ? `peak ${fmtMem(memPeak)}` : "");
  if (!$("tile-cpu").classList.contains("reading"))
    drawSpark($("tile-cpu").querySelector("svg"), hist, "cpu", { floor: 5, ceil: 100, fmt: fmtCpu });
  if (!$("tile-mem").classList.contains("reading"))
    drawSpark($("tile-mem").querySelector("svg"), hist, "mem", { floor: 64 * 1024 ** 2, fmt: fmtMem });

  for (const dd of document.querySelectorAll("#det-commands .c-usage")) {
    const c = s && s.cmds[Number(dd.dataset.cmd)];
    dd.textContent = !c
      ? "—"
      : `${fmtCpu(c.cpu)} CPU · ${fmtMem(c.mem)}` +
        (c.procs > 1 ? ` · ${c.procs} processes` : "");
  }
}

let ovSort = (() => {
  try { return localStorage.getItem("ovSort") || "mem"; } catch { return "mem"; }
})();
document.querySelectorAll(".ov-sort button").forEach((b) => {
  b.onclick = () => {
    ovSort = b.dataset.sort;
    try { localStorage.setItem("ovSort", ovSort); } catch {}
    renderOverview();
  };
});

function renderOverview() {
  const sys = stats.system;
  if (sys) {
    const memPct = (100 * sys.memUsed) / sys.memTotal;
    setTile("sys-cpu", fmtCpu(sys.cpu), `${sys.cores} threads`);
    setTile("sys-mem", fmtMem(sys.memUsed), `of ${fmtMem(sys.memTotal)} · ${Math.round(memPct)}%`);
    if (!$("sys-cpu").classList.contains("reading"))
      drawSpark($("sys-cpu").querySelector("svg"), stats.systemHistory, "cpu", { floor: 10, ceil: 100, fmt: fmtCpu });
    if (!$("sys-mem").classList.contains("reading"))
      drawSpark($("sys-mem").querySelector("svg"), stats.systemHistory, "mem", { floor: 1, ceil: sys.memTotal, fmt: fmtMem });
    $("sys-cpu").dataset.level = level(sys.cpu || 0);
    $("sys-mem").dataset.level = level(memPct);
    const d = sys.disk;
    $("sys-disk").hidden = !d;
    if (d) {
      const used = (100 * (d.total - d.free)) / d.total;
      setTile("sys-disk", `${fmtMem(d.free)} free`, `${d.path} · ${Math.round(used)}% used`);
      const fill = $("sys-disk").querySelector(".meter-fill");
      fill.style.width = `${used}%`;
      fill.dataset.level = level(used);
    }
    setTile("sys-up", fmtUptime(Date.now() - sys.uptime * 1000), sys.hostname);
  }
  document.querySelectorAll(".ov-sort button").forEach((b) => b.classList.toggle("on", b.dataset.sort === ovSort));

  // Running apps first, then the chosen order; stopped ones keep sidebar order.
  const usage = (a) => (a.running && stats.apps[a.id]) || null;
  const key = (a) => {
    const u = usage(a);
    return ovSort === "cpu" ? (u && u.cpu) || 0 : ovSort === "mem" ? (u && u.mem) || 0 : 0;
  };
  const rows = [...appsList].sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    if (ovSort === "name") return a.name.localeCompare(b.name);
    return key(b) - key(a);
  });

  // Rows are kept and updated in place, so a tap mid-refresh still lands.
  const wrap = $("ov-rows");
  const existing = new Map([...wrap.children].map((el) => [el.dataset.id, el]));
  for (const app of rows) {
    let el = existing.get(app.id);
    existing.delete(app.id);
    if (!el) {
      el = document.createElement("button");
      el.className = "ov-row";
      el.dataset.id = app.id;
      el.innerHTML = `
        <span class="ov-name"><span class="dot"></span><span class="n"></span><span class="ov-cat muted"></span></span>
        <span class="ov-cell ov-cpu"><span class="ov-k">CPU</span><span class="ov-v"></span><span class="meter"><span class="meter-fill"></span></span></span>
        <span class="ov-cell ov-mem"><span class="ov-k">Memory</span><span class="ov-v"></span><span class="meter"><span class="meter-fill"></span></span></span>
        <span class="ov-meta muted"></span>`;
      el.onclick = () => selectApp(app.id);
    }
    wrap.appendChild(el); // moves it into sorted place
    const u = usage(app);
    el.classList.toggle("stopped", !app.running);
    el.querySelector(".dot").className = "dot" + (app.running ? " running" : "");
    el.querySelector(".n").textContent = app.name;
    el.querySelector(".ov-cat").textContent = app.category || "";
    el.querySelector(".ov-cpu .ov-v").textContent = u ? fmtCpu(u.cpu) : "—";
    el.querySelector(".ov-mem .ov-v").textContent = u ? fmtMem(u.mem) : "—";
    el.querySelector(".ov-cpu .meter-fill").style.width = `${u ? Math.min(100, u.cpu || 0) : 0}%`;
    el.querySelector(".ov-mem .meter-fill").style.width =
      `${u && sys ? Math.min(100, (100 * u.mem) / sys.memTotal) : 0}%`;
    el.querySelector(".ov-meta").textContent = !app.running
      ? "stopped"
      : [
          app.startedAt ? `up ${fmtUptime(app.startedAt)}` : "",
          u ? `${u.procs} process${u.procs === 1 ? "" : "es"}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
  }
  for (const el of existing.values()) el.remove();
}

/* ------------------------------------------------------------- SSE */

function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === "hello") {
      loadStats(); // a reconnect may have missed samples — take the server's history
    } else if (ev.type === "stats") {
      applyStats(ev);
    } else if (ev.type === "apps") {
      refreshApps().then(loadLogs);
    } else if (ev.type === "status") {
      const i = appsList.findIndex((a) => a.id === ev.app.id);
      if (i >= 0) appsList[i] = ev.app;
      expSoon(true); // a process started or stopped — its port came or went
      renderSidebar();
      if (ev.app.id === selectedId || !selectedId) {
        renderPanel();
        renderConsoles();
        renderStats();
      }
    } else if (ev.type === "log" && ev.id === selectedId) {
      appendLine(preFor(ev.cmd), ev.stream, ev.line);
      if (ev.stream === "err") {
        const b = badgeFor(ev.cmd);
        if (b) {
          setBadge(ev.cmd, (Number(b.dataset.count) || 0) + 1);
          b.classList.remove("pulse");
          void b.offsetWidth; // restart animation
          b.classList.add("pulse");
        }
      }
    } else if (ev.type === "clear" && ev.id === selectedId) {
      if (ev.cmd == null) {
        document.querySelectorAll("#term-container pre").forEach((p) => (p.innerHTML = ""));
      } else {
        const pre = preFor(ev.cmd);
        if (pre) pre.innerHTML = "";
        setBadge(ev.cmd, 0);
      }
    } else if (ev.type === "update-log" && ev.id === selectedId) {
      appendLine($("update-log"), ev.stream, ev.line);
    } else if (ev.type === "update-done" && ev.id === selectedId) {
      const app = selected();
      $("update-sub").textContent =
        ev.code !== 0
          ? `Update exited with code ${ev.code}.`
          : ev.changed === false
          ? "✓ Already up to date — nothing was built or restarted."
          : ev.restarted
          ? "✓ Updated — the app was restarted on the new version."
          : app && app.running
          ? "✓ Updated."
          : "✓ Updated — press Run.";
    } else if (ev.type === "install-log") {
      appendLine($("update-log"), ev.stream, ev.line);
    } else if (ev.type === "install-done") {
      $("update-sub").textContent = !ev.ok
        ? "Install failed — see the log."
        : ev.warned
        ? "Installed, but a setup step failed — see the log."
        : "✓ Installed — press Run.";
      if (ev.ok && ev.app) {
        selectedId = ev.app.id;
        $("inp-repo").value = "";
        refreshApps().then(loadLogs);
        showPortInfo(ev.portInfo);
      }
    } else if (ev.type === "self-update-log") {
      appendLine($("update-log"), ev.stream, ev.line);
    } else if (ev.type === "self-update-done") {
      $("update-sub").textContent = !ev.ok
        ? "Update failed — see log."
        : ev.changed === false
        ? "✓ You're already on the latest version."
        : "Updated.";
    } else if (ev.type === "updates") {
      loadUpdates();
    } else if (ev.type === "funnel") {
      loadFunnel().then(renderPanel);
      expSoon(false);
    } else if (ev.type === "cf") {
      loadCf().then(renderPanel);
      expSoon(false);
    } else if (ev.type === "cf-log") {
      appendLine($("cf-log"), ev.stream, ev.line);
    } else if (ev.type === "cf-done") {
      cfCreateDone(ev);
    } else if (ev.type === "cf-setup-log") {
      appendLine($("cf-setup-log"), ev.stream, ev.line);
    } else if (ev.type === "cf-setup-done") {
      cfSetupRunning = null;
      cfRefreshSetup();
    } else if (ev.type === "self-update-restart") {
      $("update-sub").textContent = "New version pulled — restarting Rack" +
        (ev.kept && !ev.restarted ? " (your apps keep running)…" : ev.restarted ? " and the apps it was running…" : "…");
      pollBackAndReload();
    }
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 2000);
  };
}

/* ------------------------------------------------------------- init */

loadPublic().then(() => refreshApps()).then(loadLogs).then(loadUpdates);
connectEvents();

/* ------------------------------------------------------- exposure manager */

// Every way something on this machine can be reached from off it, in one
// place: each Tailscale port and Cloudflare tunnel with the app behind it, every
// listening port with the program behind it, and a form to expose anything.

const expModal = $("exposure-modal");
let expState = null;
let expFocus = null; // { appId, cmdIndex } when opened from a process's card
let expSeq = 0;
let expTimer = null;

const REACH_LABEL = {
  public: ["Internet", "exp-public"],
  tailnet: ["Tailnet", "exp-tailnet"],
  lan: ["Local network", "exp-lan"],
  local: ["This PC only", "exp-local"],
};

const CF_STATUS = {
  public: ["Internet", "exp-public"],
  connecting: ["Connecting…", "exp-tailnet"],
  failed: ["Failed", "exp-public"],
  off: ["Off", "exp-local"],
  waiting: ["Waits for the process", "exp-local"],
  unused: ["Free", "exp-free"],
};

const expEsc = (s) =>
  String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function openExposure(focus) {
  settingsMenu.hidden = true;
  expFocus = focus || null;
  expModal.hidden = false;
  $("exp-error").hidden = true;
  if (focus) $("exp-what").dataset.want = `rack:${focus.cmdIndex}:${focus.appId}`;
  if (!expState) $("exp-body").innerHTML = "<p class='muted'>Reading this machine…</p>";
  else renderExposure();
  loadExposure(true);
}

$("btn-exposure").onclick = () => openExposure(null);

/* ------------------------------------------------------------ Claude connector */
// lib/mcp.js. The access key is what signs Claude in: sent as a header by
// Claude Code, or pasted once on the sign-in page claude.ai opens.
const mcpModal = $("mcp-modal");
let mcpShowKey = false;

async function mcpAction(body) {
  $("mcp-error").hidden = true;
  const r = await api("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.error) {
    $("mcp-error").textContent = r.error;
    $("mcp-error").hidden = false;
  }
  renderMcp(r.error ? await api("/api/mcp") : r);
}

function renderMcp(s) {
  const body = $("mcp-body");
  if (!s.enabled) {
    body.innerHTML = `
      <label>Port <input id="mcp-port" type="number" min="1" max="65535" value="${s.port}" style="width:110px" /></label>
      <div class="modal-actions" style="justify-content:flex-start"><button id="mcp-on" class="btn btn-run">Turn on</button></div>`;
    $("mcp-on").onclick = () => mcpAction({ action: "enable", port: Number($("mcp-port").value) || s.port });
    return;
  }
  const host = location.hostname || "localhost";
  const url = `http://${host}:${s.port}/mcp`;
  const shown = mcpShowKey ? s.key : "•".repeat(Math.min(24, s.key.length));
  const cli = `claude mcp add --transport http rack ${url} --header "Authorization: Bearer ${s.key}"`;
  body.innerHTML = `
    <p class="${s.listening ? "" : "modal-error"}" style="margin:4px 0 10px">${
      s.listening
        ? `● On — listening on port <b>${s.port}</b>${s.connected ? ` · ${s.connected} Claude sign-in${s.connected === 1 ? "" : "s"}` : ""}`
        : `Not listening: ${expEsc(s.error || "starting…")}`
    }</p>
    <label>Access key</label>
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
      <code class="mcp-key">${expEsc(shown)}</code>
      <button id="mcp-show" class="btn btn-ghost">${mcpShowKey ? "Hide" : "Show"}</button>
      <button id="mcp-copy" class="btn btn-ghost">Copy</button>
    </div>
    <ol class="cf-steps">
      <li><b>Claude Code</b> on this network — run (click to copy):<br><code id="mcp-cli">${expEsc(cli)}</code></li>
      <li><b>claude.ai or the Claude app</b> needs an https address: in
        <button id="mcp-expose" class="btn-link">◎ Exposure manager</button> publish port <b>${s.port}</b> to the internet
        (Funnel). Then in Claude: <b>Settings → Connectors → Add custom connector</b>, URL
        <code>https://&lt;that address&gt;/mcp</code>, and paste the access key when it asks you to sign in.</li>
    </ol>
    <div class="modal-actions" style="justify-content:flex-start;margin-top:4px">
      <button id="mcp-rotate" class="btn btn-ghost" title="Every connected Claude has to sign in again">New key</button>
      <button id="mcp-off" class="btn btn-danger-ghost" style="margin-top:0">Turn off</button>
    </div>`;
  $("mcp-show").onclick = () => { mcpShowKey = !mcpShowKey; renderMcp(s); };
  const copied = (el) => async () => {
    if (!(await copyText(el === "key" ? s.key : cli))) return;
    const b = el === "key" ? $("mcp-copy") : $("mcp-cli");
    b.classList.add("copied");
    if (el === "key") b.textContent = "Copied";
    setTimeout(() => b.isConnected && (b.classList.remove("copied"), el === "key" && (b.textContent = "Copy")), 1500);
  };
  $("mcp-copy").onclick = copied("key");
  $("mcp-cli").onclick = copied("cli");
  $("mcp-expose").onclick = () => { mcpModal.hidden = true; openExposure(null); };
  $("mcp-rotate").onclick = () => {
    if (confirm("Make a new access key? Every Claude signed in with the old one is signed out.")) mcpAction({ action: "new-key" });
  };
  $("mcp-off").onclick = () => mcpAction({ action: "disable" });
}

$("btn-mcp").onclick = async () => {
  settingsMenu.hidden = true;
  $("mcp-error").hidden = true;
  mcpModal.hidden = false;
  renderMcp(await api("/api/mcp"));
};
$("mcp-close").onclick = () => (mcpModal.hidden = true);
mcpModal.onclick = (e) => { if (e.target === mcpModal) mcpModal.hidden = true; };
$("exp-close").onclick = () => (expModal.hidden = true);
$("exp-refresh").onclick = () => loadExposure(true);
$("exp-hide-local").onchange = () => renderExposure();
expModal.onclick = (e) => { if (e.target === expModal) expModal.hidden = true; };

// rescan re-reads the machine's ports (a few seconds on Windows); without it the
// server reuses its last scan, which is all an expose or stop needs.
async function loadExposure(rescan) {
  const seq = ++expSeq;
  $("exp-refresh").disabled = true;
  try {
    const st = await api("/api/exposure" + (rescan ? "?rescan=1" : ""));
    if (seq !== expSeq) return;
    expState = st;
    renderExposure();
  } catch {
    if (seq === expSeq && !expState) $("exp-body").innerHTML = "<p class='muted'>Could not read the open ports.</p>";
  } finally {
    if (seq === expSeq) $("exp-refresh").disabled = false;
  }
}

// Events arrive in bursts (a tunnel connecting, an app starting) — reload once.
function expSoon(rescan) {
  if (expModal.hidden) return;
  clearTimeout(expTimer);
  expTimer = setTimeout(() => loadExposure(rescan), rescan ? 2000 : 300);
}

const expIsFocus = (owner) =>
  !!(expFocus && owner && owner.appId === expFocus.appId && owner.cmdIndex === expFocus.cmdIndex);

// "Immich · server" for a Rack app, the program name otherwise.
function expWhoText(w) {
  if (!w) return "nothing";
  if (w.owner) return `${w.owner.appName} · ${w.owner.procName}`;
  if (w.process) return `${w.process} (localhost:${w.port})`;
  return `localhost:${w.port}`;
}

// What a route points at: the Rack app and process if Rack runs it, else the
// program found listening on the port.
function expWhoHtml(w) {
  if (!w) return `<span class="exp-dim">Not assigned to anything</span>`;
  const bits = [];
  if (w.owner) {
    bits.push(`<b>${expEsc(w.owner.appName)}</b>`, `<span class="exp-dim">${expEsc(w.owner.procName)}</span>`);
  } else if (w.process) {
    bits.push(`<b>${expEsc(w.process)}</b>`);
    if (w.pid) bits.push(`<span class="exp-dim">PID ${w.pid}</span>`);
  } else {
    bits.push(`<span class="exp-dim">Unknown program</span>`);
  }
  bits.push(`<span class="exp-dim">localhost:${w.port}</span>`);
  let html = bits.join(" · ");
  if (w.owner && !w.owner.running) html += `<div class="exp-note">Stopped — nothing answers until it runs.</div>`;
  else if (!w.owner && !w.listening && !(expState && expState.scanError))
    html += `<div class="exp-note">Nothing is listening on ${w.port} — this points at nothing.</div>`;
  if (!w.owner && w.path) html += `<div class="exp-path">${expEsc(w.path)}</div>`;
  return html;
}

// What a listening port belongs to, for the ports table.
function expOwnerHtml(row) {
  const bits = [];
  if (row.owner) {
    bits.push(`<b>${expEsc(row.owner.appName)}</b>`);
    if (row.owner.procName) bits.push(`<span class="exp-dim">${expEsc(row.owner.procName)}</span>`);
    if (row.process) bits.push(`<span class="exp-dim">${expEsc(row.process)}</span>`);
  } else if (row.process) {
    bits.push(expEsc(row.process));
    if (row.pid) bits.push(`<span class="exp-dim">PID ${row.pid}</span>`);
  } else {
    bits.push("<span class='exp-dim'>Unknown program</span>");
  }
  const detail = row.owner ? null : row.path || row.command;
  return bits.join(" · ") + (detail ? `<div class="exp-path" title="${expEsc(row.command || "")}">${expEsc(detail)}</div>` : "");
}

function expReachNote(row) {
  const routes = [
    ...row.shares.map((sh) => `Tailscale ${sh.isFunnel ? "Funnel" : "serve"} on ${sh.publicPort}`),
    ...row.tunnels.map((t) => t.label + (t.managed ? ` ${t.name || ""} (Rack)` : "")),
  ];
  if (routes.length) return routes.join(" + ");
  if (row.reach === "lan") return `Bound to ${row.addresses[0]}`;
  return "";
}

function renderExposure() {
  if (!expState) return;
  const st = expState;
  const out = [];

  const openCount =
    st.shares.filter((sh) => sh.isFunnel).length + st.tunnels.filter((t) => !t.managed || t.status === "public").length;
  const tailnetCount = st.shares.filter((sh) => !sh.isFunnel).length;
  const sub = [
    openCount ? `<b class="exp-red">${openCount} open to the internet</b>` : "Nothing open to the internet",
    `${tailnetCount} on your tailnet only`,
    `${st.listeners.filter((r) => r.proto === "tcp").length} listening ports`,
  ];
  $("exp-sub").innerHTML = sub.join(" · ");

  if (st.scanError) out.push(`<div class="exp-warn">${expEsc(st.scanError)}</div>`);
  if (st.elevated === false)
    out.push(
      `<div class="exp-warn">Rack isn't running as administrator, so some system processes show without a name. Right-click <b>start.bat</b> → Run as administrator for the full picture.</div>`
    );

  // --- Tailscale: every port, taken or free -----------------------------------
  const ts = st.tailscale;
  out.push(`<section class="exp-block"><h4>Tailscale${ts.available ? ` · <span class="exp-host">${expEsc(ts.dnsName)}</span>` : ""}</h4>`);
  if (!ts.available) {
    out.push(`<p class="exp-dim">${expEsc(ts.reason || "Tailscale isn't available.")}</p>`);
  } else {
    out.push(`<table class="exp-table"><tbody>`);
    for (const slot of ts.slots) {
      if (!slot.shares.length) {
        out.push(`<tr>
          <td class="exp-port">${slot.publicPort}</td>
          <td><span class="exp-badge exp-free">Free</span></td>
          <td><span class="exp-dim">${slot.funnelAllowed ? "Can be shared on your tailnet or opened to the internet" : "Tailnet only"}</span></td>
          <td class="exp-act"><button class="btn btn-ghost btn-sm" data-use-ts="${slot.publicPort}">Use…</button></td>
        </tr>`);
        continue;
      }
      for (const sh of slot.shares) {
        const [label, cls] = sh.isFunnel ? ["Internet", "exp-public"] : ["Tailnet", "exp-tailnet"];
        const path = sh.path && sh.path !== "/" ? ` <span class="exp-dim">${expEsc(sh.path)}</span>` : "";
        out.push(`<tr class="${expIsFocus(sh.target && sh.target.owner) ? "exp-hl" : ""}">
          <td class="exp-port">${slot.publicPort}${path}</td>
          <td><span class="exp-badge ${cls}">${label}</span><div class="exp-dim">${sh.isFunnel ? "Funnel" : "serve"}</div></td>
          <td>${expWhoHtml(sh.target)}<div><a class="exp-url" href="${expEsc(sh.url)}" target="_blank">${expEsc(sh.url)} ↗</a></div></td>
          <td class="exp-act">
            ${sh.isFunnel
              ? `<button class="btn btn-ghost btn-sm" data-tailnet="${slot.publicPort}" title="Take it off the internet, keep it on your tailnet">Tailnet only</button>`
              : slot.funnelAllowed
              ? `<button class="btn btn-danger-ghost btn-sm" data-funnel="${slot.publicPort}" data-local="${sh.localPort}">Open to internet</button>`
              : ""}
            <button class="btn btn-danger-ghost btn-sm" data-stop="${slot.publicPort}">Stop</button>
          </td>
        </tr>`);
      }
    }
    out.push(`</tbody></table>`);
  }
  out.push(`</section>`);

  // --- Cloudflare: every named tunnel, assigned or free ---------------------
  const cf = st.cloudflare;
  out.push(`<section class="exp-block"><h4>Cloudflare tunnels</h4>`);
  if (!cf.available || !cf.loggedIn) {
    out.push(`<p class="exp-dim">${expEsc(cf.available ? "cloudflared is installed but not logged in yet." : cf.reason || "cloudflared isn't installed.")}
      <button class="btn btn-ghost btn-sm" data-cf-setup="1">Set up Cloudflare</button></p>`);
  } else if (!cf.tunnels.length) {
    out.push(`<p class="exp-dim">No tunnels yet — pick a Rack app above, <b>Internet — Cloudflare</b>, then <b>＋ New tunnel…</b></p>`);
  } else {
    out.push(`<table class="exp-table"><tbody>`);
    for (const t of cf.tunnels) {
      const [label, cls] = CF_STATUS[t.status] || CF_STATUS.off;
      const b = t.binding;
      const running = !!(t.target && t.target.owner && t.target.owner.running);
      const up = t.status === "public" || t.status === "connecting";
      out.push(`<tr class="${expIsFocus(t.target && t.target.owner) ? "exp-hl" : ""}">
        <td class="exp-port">${expEsc(t.name)}</td>
        <td><span class="exp-badge ${cls}" title="${expEsc(t.error || "")}">${label}</span></td>
        <td>${b ? expWhoHtml(t.target) : `<span class="exp-dim">Not assigned to anything</span>`}
          ${t.url ? `<div><a class="exp-url" href="${expEsc(t.url)}" target="_blank">${expEsc(t.url)} ↗</a></div>` : ""}
          ${t.error ? `<div class="exp-note">${expEsc(t.error)}</div>` : ""}
          ${!t.inAccount ? `<div class="exp-note">Not found in your Cloudflare account.</div>` : ""}</td>
        <td class="exp-act">${
          b
            ? `<label class="exp-auto" title="Bring the tunnel up whenever the process runs"><input type="checkbox" data-cf-auto="${expEsc(t.name)}"${b.auto ? " checked" : ""} /> auto</label>
               ${running ? `<button class="btn btn-ghost btn-sm" data-cf-connect="${expEsc(t.name)}" data-enable="${up ? "" : "1"}">${up ? "Disconnect" : "Connect"}</button>` : ""}
               ${t.status === "failed" || t.error ? `<button class="btn btn-ghost btn-sm" data-cf-log="${expEsc(t.name)}">Log</button>` : ""}
               <button class="btn btn-danger-ghost btn-sm" data-cf-unbind="${expEsc(t.name)}" title="Stop the tunnel and free it">Stop</button>`
            : `<button class="btn btn-ghost btn-sm" data-use-cf="${expEsc(t.name)}">Use…</button>`
        }</td>
      </tr>`);
    }
    out.push(`</tbody></table>`);
  }
  out.push(`</section>`);

  // --- tunnels Rack didn't start --------------------------------------------
  const foreign = st.tunnels.filter((t) => !t.managed);
  if (foreign.length) {
    out.push(`<section class="exp-block exp-block-danger"><h4>Tunnels Rack didn't start</h4><table class="exp-table"><tbody>`);
    for (const t of foreign) {
      out.push(`<tr>
        <td class="exp-port">${expEsc(t.label)}</td>
        <td><span class="exp-badge exp-public">Internet</span><div class="exp-dim">PID ${expEsc(t.pid)}</div></td>
        <td>${t.target ? expWhoHtml(t.target) : `<span class="exp-dim">Couldn't tell which port it publishes</span>`}
          ${t.url ? `<div class="exp-path">${expEsc(t.url)}</div>` : ""}
          <div class="exp-path" title="${expEsc(t.command || "")}">${expEsc(t.command || "")}</div></td>
        <td class="exp-act exp-dim">Close its window to stop it</td>
      </tr>`);
    }
    out.push(`</tbody></table></section>`);
  }

  // --- every port -------------------------------------------------------------
  const hideLocal = $("exp-hide-local").checked;
  const rows = st.listeners.filter((r) => r.proto === "tcp" && !(hideLocal && r.reach === "local"));
  out.push(`<section class="exp-block"><h4>Listening ports</h4><table class="exp-table"><tbody>`);
  if (!rows.length) out.push(`<tr><td class="exp-dim">Nothing to show.</td></tr>`);
  for (const row of rows) {
    const [label, cls] = REACH_LABEL[row.reach];
    const note = expReachNote(row);
    out.push(`<tr class="${expIsFocus(row.owner) ? "exp-hl" : ""}">
      <td class="exp-port">${row.port}</td>
      <td><span class="exp-badge ${cls}">${label}</span>${note ? `<div class="exp-dim">${expEsc(note)}</div>` : ""}</td>
      <td>${expOwnerHtml(row)}</td>
      <td class="exp-act"><button class="btn btn-ghost btn-sm" data-expose="${row.port}">Expose…</button></td></tr>`);
  }
  out.push(`</tbody></table></section>`);

  $("exp-body").innerHTML = out.join("");
  wireExposureButtons();
  renderExpForm();
}

function wireExposureButtons() {
  const body = $("exp-body");
  const on = (attr, fn) => body.querySelectorAll(`[${attr}]`).forEach((b) => (b.onclick = () => fn(b)));
  const cfTunnel = (name) => expState.cloudflare.tunnels.find((t) => t.name === name);

  on("data-stop", (b) => {
    const p = Number(b.dataset.stop);
    const slot = expState.tailscale.slots.find((s) => s.publicPort === p);
    const who = slot && slot.shares[0] ? expWhoText(slot.shares[0].target) : `port ${p}`;
    if (!confirm(`Stop sharing ${who} on Tailscale port ${p}?`)) return;
    expFunnel({ publicPort: p, enable: false, mode: "serve" }, b);
  });
  // funnel off, serve left standing
  on("data-tailnet", (b) => expFunnel({ publicPort: Number(b.dataset.tailnet), enable: false, mode: "funnel" }, b));
  on("data-funnel", (b) => {
    const p = Number(b.dataset.funnel);
    const local = Number(b.dataset.local);
    if (!confirm(`Open localhost:${local} to the whole internet on port ${p}?\n\nAnyone with the URL will be able to reach it, with no login.`)) return;
    expFunnel({ publicPort: p, localPort: local, enable: true, mode: "funnel" }, b);
  });
  on("data-use-ts", (b) => {
    const p = b.dataset.useTs;
    const slot = expState.tailscale.slots.find((s) => String(s.publicPort) === p);
    expPick({ how: slot && slot.funnelAllowed ? "funnel" : "tailnet", on: p });
  });
  on("data-use-cf", (b) => expPick({ how: "cf", on: `cf:${b.dataset.useCf}` }));
  on("data-expose", (b) => {
    const port = Number(b.dataset.expose);
    const t = expState.targets.find((x) => x.port === port);
    expPick({ what: t ? `rack:${t.cmdIndex}:${t.appId}` : `port:${port}` });
  });
  on("data-cf-setup", () => openCfSetup());

  on("data-cf-connect", async (b) => {
    const t = cfTunnel(b.dataset.cfConnect);
    if (!t || !t.binding) return;
    b.disabled = true;
    const res = await cfPost("/api/cf/connect", { ...t.binding, enable: !!b.dataset.enable });
    if (res && res.error) alert("Cloudflare: " + res.error);
    await expAfter();
  });
  on("data-cf-unbind", async (b) => {
    const t = cfTunnel(b.dataset.cfUnbind);
    if (!t || !t.binding) return;
    if (!confirm(`Stop tunnel "${t.name}" and take it off ${expWhoText(t.target)}?`)) return;
    b.disabled = true;
    const res = await cfPost("/api/cf", { appId: t.binding.appId, cmdIndex: t.binding.cmdIndex, tunnel: null });
    if (res && res.error) alert("Cloudflare: " + res.error);
    await expAfter();
  });
  on("data-cf-log", (b) => {
    const t = cfTunnel(b.dataset.cfLog);
    const app = t && t.binding && appsList.find((a) => a.id === t.binding.appId);
    if (app) openCfLog(app, t.binding.cmdIndex);
  });
  body.querySelectorAll("[data-cf-auto]").forEach((box) => {
    box.onchange = async () => {
      const t = cfTunnel(box.dataset.cfAuto);
      if (!t || !t.binding) return;
      box.disabled = true;
      await cfPost("/api/cf", {
        appId: t.binding.appId,
        cmdIndex: t.binding.cmdIndex,
        tunnel: t.name,
        hostname: t.hostname,
        auto: box.checked,
        connect: false,
      });
      await expAfter();
    };
  });
}

async function expFunnel(body, btn) {
  if (btn) btn.disabled = true;
  const res = await cfPost("/api/funnel", body);
  if (res && res.error) alert(res.error);
  await expAfter();
}

// After any change: the manager, and the process cards behind it.
async function expAfter() {
  await Promise.all([loadExposure(false), loadPublic()]);
  await refreshApps();
}

/* ---- the "Expose" form: what → how → where ---- */

// Pre-select parts of the form (from a Use… or Expose… button) and bring it into view.
function expPick({ what, how, on }) {
  if (what) $("exp-what").dataset.want = what;
  if (how) $("exp-how").dataset.want = how;
  if (on) $("exp-on").dataset.want = on;
  renderExpForm();
  $("exp-new").classList.remove("flash");
  void $("exp-new").offsetWidth;
  $("exp-new").classList.add("flash");
  $("exp-what").focus();
}

// Rebuild a <select>'s options, keeping the choice (or a requested one) if it still exists.
function expFill(sel, items) {
  const asked = sel.dataset.want;
  delete sel.dataset.want;
  const want = asked || sel.value;
  sel.innerHTML = "";
  for (const it of items) {
    if (it.group) {
      const g = document.createElement("optgroup");
      g.label = it.group;
      for (const o of it.options) g.appendChild(expOption(o));
      if (it.options.length) sel.appendChild(g);
    } else sel.appendChild(expOption(it));
  }
  const opts = [...sel.options].filter((o) => !o.disabled);
  // A choice that has become a no-op ("already this") isn't worth keeping.
  const kept = opts.find((o) => o.value === want && (asked || !o.dataset.noop));
  const pick = kept || opts.find((o) => o.dataset.prefer) || opts[0];
  if (pick) sel.value = pick.value;
}
function expOption({ value, text, disabled, prefer, noop }) {
  const o = new Option(text, value);
  o.disabled = !!disabled;
  if (prefer) o.dataset.prefer = "1"; // the default when nothing was picked yet
  if (noop) o.dataset.noop = "1";
  return o;
}

// The thing the form would expose: a Rack process, or a bare port.
function expTarget() {
  const st = expState;
  const v = $("exp-what").value;
  const m = /^rack:(\d+):(.*)$/.exec(v);
  if (m) {
    const t = st.targets.find((x) => x.appId === m[2] && x.cmdIndex === Number(m[1]));
    return t ? { kind: "rack", ...t } : null;
  }
  const port = v === "other" ? Number($("exp-what-port").value) : Number(v.replace(/^port:/, ""));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { kind: "port", port };
}

function renderExpForm() {
  const st = expState;
  if (!st) return;
  const ts = st.tailscale;
  const cf = st.cloudflare;

  // what
  const rackPorts = new Set(st.targets.map((t) => t.port));
  const others = new Map();
  for (const r of st.listeners)
    if (r.proto === "tcp" && !rackPorts.has(r.port) && !others.has(r.port)) others.set(r.port, r);
  expFill($("exp-what"), [
    {
      group: "Rack apps",
      options: st.targets.map((t) => ({
        value: `rack:${t.cmdIndex}:${t.appId}`,
        text: `${t.appName} · ${t.procName} — :${t.port}${t.running ? "" : " (stopped)"}`,
      })),
    },
    {
      group: "Other programs listening",
      options: [...others.values()].map((r) => ({ value: `port:${r.port}`, text: `:${r.port} — ${r.process || "unknown program"}` })),
    },
    { group: "Anything else", options: [{ value: "other", text: "Another port…" }] },
  ]);
  $("exp-what-port").hidden = $("exp-what").value !== "other";

  const target = expTarget();
  const isRack = !!(target && target.kind === "rack");

  // how
  const noTs = ts.available ? "" : " — Tailscale not available";
  expFill($("exp-how"), [
    { value: "tailnet", text: `Tailnet only (Tailscale)${noTs}`, disabled: !ts.available },
    { value: "funnel", text: `Internet (Tailscale Funnel)${noTs}`, disabled: !ts.available },
    { value: "cf", text: `Internet (Cloudflare)${isRack ? "" : " — Rack apps only"}`, disabled: !isRack },
  ]);
  const how = $("exp-how").value;

  // where
  let where = [];
  if (how === "tailnet" || how === "funnel") {
    where = ts.slots
      .filter((s) => how === "tailnet" || s.funnelAllowed)
      .map((s) => {
        const sh = s.shares[0];
        const same = sh && target && sh.localPort === target.port;
        const text = !sh
          ? `Port ${s.publicPort} — free`
          : same
          ? `Port ${s.publicPort} — already this (${sh.isFunnel ? "internet" : "tailnet"})`
          : `Port ${s.publicPort} — replaces ${expWhoText(sh.target)}`;
        return { value: String(s.publicPort), text, prefer: !sh, noop: same && sh.isFunnel === (how === "funnel") };
      });
  } else if (how === "cf") {
    if (!cf.available || !cf.loggedIn) where = [{ value: "cf:setup", text: "Set up Cloudflare first…" }];
    else {
      where = cf.tunnels.map((t) => {
        const mine = t.binding && target && t.binding.appId === target.appId && t.binding.cmdIndex === target.cmdIndex;
        const text = mine
          ? `${t.name} — already this`
          : t.binding
          ? `${t.name} — used by ${expWhoText(t.target)}`
          : `${t.name}${t.hostname ? ` (${t.hostname})` : ""} — free`;
        return { value: `cf:${t.name}`, text, disabled: !!t.binding && !mine, prefer: !t.binding && !!t.hostname, noop: mine };
      });
      where.push({ value: "cf:new", text: "＋ New tunnel…" });
    }
  }
  expFill($("exp-on"), where);

  const go = $("exp-go");
  const internet = how === "funnel" || how === "cf";
  const setup = $("exp-on").value === "cf:setup";
  go.className = "btn " + (setup ? "btn-ghost" : internet ? "btn-kill" : "btn-run");
  go.textContent = setup ? "Set up Cloudflare…" : how === "tailnet" ? "Share on tailnet" : "Open to internet";
  go.disabled = !target || !$("exp-on").value || $("exp-how").selectedOptions[0]?.disabled;
  $("exp-new-note").textContent = !target
    ? $("exp-what").value === "other"
      ? "Type the local port to expose."
      : "Nothing to expose yet."
    : !ts.available && !(cf.available && cf.loggedIn)
    ? "Install Tailscale, or set up Cloudflare from the ⚙ menu, to expose anything."
    : internet
    ? "Anyone with the URL can reach it — no login."
    : "Only devices signed in to your tailnet can reach it.";
}

// The rows belonging to whatever the form is about to expose stay highlighted.
$("exp-what").onchange = () => {
  $("exp-error").hidden = true;
  const t = expTarget();
  expFocus = t && t.kind === "rack" ? { appId: t.appId, cmdIndex: t.cmdIndex } : null;
  renderExposure();
  if ($("exp-what").value === "other") $("exp-what-port").focus();
};
$("exp-what-port").oninput = () => renderExpForm();
$("exp-how").onchange = () => { $("exp-error").hidden = true; renderExpForm(); };
$("exp-on").onchange = () => { $("exp-error").hidden = true; renderExpForm(); };

function expFail(msg) {
  $("exp-error").textContent = msg;
  $("exp-error").hidden = false;
}

$("exp-go").onclick = async () => {
  const st = expState;
  const target = expTarget();
  const how = $("exp-how").value;
  const on = $("exp-on").value;
  if (!st || !target || !on) return;
  $("exp-error").hidden = true;
  const name = target.kind === "rack" ? `${target.appName} · ${target.procName}` : `localhost:${target.port}`;

  if (how === "cf") {
    if (on === "cf:setup") return openCfSetup();
    const app = appsList.find((a) => a.id === target.appId);
    if (!app) return expFail("That app is gone — refresh.");
    if (on === "cf:new") return openCfModal(app, target.cmdIndex, null);
    const tunnel = on.slice(3);
    const t = st.cloudflare.tunnels.find((x) => x.name === tunnel);
    if (t && t.binding && t.binding.appId === target.appId && t.binding.cmdIndex === target.cmdIndex)
      return expFail(`${name} is already on tunnel "${tunnel}".`);
    // A tunnel Rack has never published needs its hostname before it's useful.
    if (!t || !t.hostname) return openCfModal(app, target.cmdIndex, tunnel);
    const prev = target.cloudflare && target.cloudflare.tunnel;
    const moving = prev && prev !== tunnel ? `\n\nIt moves off tunnel "${prev}".` : "";
    if (!confirm(`Open ${name} to the whole internet at https://${t.hostname}?${moving}\n\nAnyone with the URL will be able to reach it.`)) return;
    $("exp-go").disabled = true;
    const res = await cfPost("/api/cf", { appId: target.appId, cmdIndex: target.cmdIndex, tunnel, hostname: t.hostname, auto: true });
    if (res && res.error) expFail(res.error);
    return expAfter();
  }

  const publicPort = Number(on);
  const slot = st.tailscale.slots.find((s) => s.publicPort === publicPort);
  const cur = slot && slot.shares[0];
  const mode = how === "tailnet" ? "serve" : "funnel";
  if (cur && cur.localPort === target.port && cur.isFunnel === (mode === "funnel"))
    return expFail(`${name} is already shared on port ${publicPort}.`);
  const lines = [];
  if (cur && cur.localPort !== target.port) lines.push(`Port ${publicPort} currently points at ${expWhoText(cur.target)} — that stops.`);
  if (mode === "funnel") lines.push("Anyone with the URL will be able to reach it, with no login.");
  const verb = mode === "funnel" ? "Open" : "Share";
  const where = mode === "funnel" ? "the whole internet" : "your tailnet";
  if ((mode === "funnel" || cur) && !confirm(`${verb} ${name} to ${where} on port ${publicPort}?\n\n${lines.join("\n")}`)) return;
  $("exp-go").disabled = true;
  const res = await cfPost("/api/funnel", {
    publicPort,
    localPort: target.port,
    enable: true,
    mode,
    // re-pointing a port, or taking one from internet down to tailnet
    replace: !!cur,
  });
  if (res && res.error) expFail(res.error);
  await expAfter();
};
