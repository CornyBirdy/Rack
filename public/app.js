/* Rack frontend (multi-process model) */

const $ = (id) => document.getElementById(id);

let appsList = [];
let conflictsList = [];
let selectedId = null;
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
  } catch {}
}
loadSettings();

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
    const { version, supervised } = await fetch("/api/version").then((r) => r.json());
    const v = document.querySelector(".settings-version");
    if (v) v.textContent = `Rack v${version}`;
    // one-click update only works under the start.bat supervisor loop
    $("btn-update-rack").hidden = !supervised;
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

function renderUpdateMenu() {
  const label = $("btn-check-updates").querySelector("span");
  const behindApps = updates.apps.filter((a) => hasUpdate(a));
  const rackBehind = hasUpdate(updates.rack);
  if (updates.checking) {
    label.textContent = "Checking for updates…";
  } else if (!updates.checkedAt) {
    label.textContent = "Check for updates";
  } else if (rackBehind || behindApps.length) {
    const bits = [];
    if (rackBehind) bits.push("Rack");
    if (behindApps.length) bits.push(`${behindApps.length} app${behindApps.length === 1 ? "" : "s"}`);
    label.textContent = `Update available: ${bits.join(" + ")}`;
  } else {
    label.textContent = `Up to date · checked ${fmtAgo(updates.checkedAt)}`;
  }
  $("btn-check-updates").classList.toggle("alert", !updates.checking && (rackBehind || behindApps.length > 0));
  $("btn-check-updates").title = [
    updateTitle(updates.rack, "Rack"),
    // without the supervisor there's no ⟳ Update Rack button to press
    rackBehind && updates.rack.supervised === false
      ? "Start Rack from start.bat to update it from here — otherwise: git pull in Rack's folder."
      : "",
    ...behindApps.map((a) => updateTitle(a, a.name)),
  ]
    .filter(Boolean)
    .join("\n\n");

  const rackBtn = $("btn-update-rack").querySelector("span");
  rackBtn.textContent = rackBehind
    ? `Update Rack — ${updates.rack.behind} new`
    : "Update Rack";
  $("btn-update-rack").classList.toggle("alert", rackBehind);
  $("btn-update-rack").title = updateTitle(updates.rack, "Rack");
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

$("btn-check-updates").onclick = async () => {
  updates.checking = true;
  renderUpdateMenu();
  try {
    updates = await api("/api/updates/check", { method: "POST" });
  } catch {
    updates.checking = false;
  }
  renderUpdates();
};

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
  if (!selectedId && appsList.length) selectedId = appsList[0].id;
  renderSidebar();
  renderPanel();
  renderConsoles();
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
  selectedId = id;
  renderSidebar();
  renderPanel();
  renderConsoles();
  loadLogs();
}

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

  $("empty-hint").hidden = !!app;
  $("panel").hidden = !app;
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
    $("sel-name").textContent = "No app selected";
    $("sel-status").className = "status-pill stopped";
    $("sel-status").textContent = "—";
    return;
  }

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

// One row per process covering both providers. They're mutually exclusive on
// purpose: a process has one public route, or none.

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

// Cloudflare is hidden from the per-process dropdown until cloudflared exists,
// so the ⚙ menu is where you find out the feature is there at all.
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

// Which public port (if any) is currently funnelling this process's local port.
function funnelFor(localPort) {
  return funnelInfo.active.find((a) => a.isFunnel && a.localPort === localPort) || null;
}

// The live cloudflared process for one command, if Rack is running one.
function cfLiveFor(appId, idx) {
  return cfInfo.active.find((a) => a.appId === appId && a.cmdIndex === idx) || null;
}

// Which other process has already claimed a named tunnel — "App / process".
function cfOwnerOf(name, appId, idx) {
  for (const a of appsList)
    for (let i = 0; i < a.commands.length; i++) {
      const b = a.commands[i].cloudflare;
      if (b && b.tunnel === name && !(a.id === appId && i === idx))
        return `${a.name} / ${a.commands[i].name}`;
    }
  return null;
}

// `cloudflared tunnel list` doesn't report hostnames, so the hostname a tunnel
// publishes on is only known from a binding Rack already stored.
function cfHostnameOf(name) {
  for (const a of appsList)
    for (const c of a.commands)
      if (c.cloudflare && c.cloudflare.tunnel === name && c.cloudflare.hostname)
        return c.cloudflare.hostname;
  return null;
}

function cfPost(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function renderPublicRow(row, app, cmd, idx) {
  if (!row) return;
  // Only meaningful for a process that actually serves a port, on a machine
  // where at least one provider exists.
  if ((!funnelInfo.available && !cfInfo.available) || !cmd.effPort) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  row.innerHTML = "";

  const ts = funnelFor(cmd.effPort);
  const bind = cmd.cloudflare;
  const live = cfLiveFor(app.id, idx);

  const label = document.createElement("span");
  label.className = "funnel-label";
  label.textContent = "Public";
  row.appendChild(label);

  const sel = document.createElement("select");
  sel.className = "funnel-select";
  sel.appendChild(new Option("Off", ""));

  if (funnelInfo.available) {
    const g = document.createElement("optgroup");
    g.label = "Tailscale Funnel";
    for (const p of funnelInfo.ports) {
      // A public port already used by a *different* local port isn't selectable.
      const taken = funnelInfo.active.find((a) => a.publicPort === p && a.localPort !== cmd.effPort);
      const o = new Option(taken ? `${p} — in use` : String(p), `ts:${p}`);
      if (taken) o.disabled = true;
      g.appendChild(o);
    }
    sel.appendChild(g);
  }

  if (cfInfo.available) {
    const g = document.createElement("optgroup");
    g.label = "Cloudflare";
    if (!cfInfo.loggedIn) {
      g.appendChild(new Option("Set up Cloudflare…", "cf:setup"));
    } else {
      for (const t of cfInfo.tunnels) {
        const owner = cfOwnerOf(t.name, app.id, idx);
        const host = cfHostnameOf(t.name);
        const text = owner ? `${t.name} — used by ${owner}` : host ? `${t.name} (${host})` : t.name;
        const o = new Option(text, `cf:${t.name}`);
        if (owner) o.disabled = true;
        g.appendChild(o);
      }
      g.appendChild(new Option("＋ New tunnel…", "cf:new"));
    }
    sel.appendChild(g);
  }

  const current = bind && bind.tunnel ? `cf:${bind.tunnel}` : ts ? `ts:${ts.publicPort}` : "";
  sel.value = current;

  sel.onchange = async () => {
    const next = sel.value;
    if (next === "cf:setup" || next === "cf:new") {
      sel.value = current; // these open a dialog rather than selecting anything
      return next === "cf:setup" ? openCfSetup() : openCfModal(app, idx, null);
    }
    sel.disabled = true;
    // One public route per process — clear whatever the other provider had.
    if (bind && bind.tunnel && !next.startsWith("cf:")) {
      await cfPost("/api/cf", { appId: app.id, cmdIndex: idx, tunnel: null });
    }
    if (ts && next !== `ts:${ts.publicPort}`) {
      await cfPost("/api/funnel", { publicPort: ts.publicPort, enable: false });
    }

    let res = { ok: true };
    if (next.startsWith("ts:")) {
      res = await cfPost("/api/funnel", {
        publicPort: Number(next.slice(3)),
        localPort: cmd.effPort,
        enable: true,
      });
    } else if (next.startsWith("cf:")) {
      const name = next.slice(3);
      const host = cfHostnameOf(name);
      // A tunnel Rack has never published needs its hostname before it's useful.
      if (!host) {
        sel.disabled = false;
        sel.value = current;
        return openCfModal(app, idx, name);
      }
      res = await cfPost("/api/cf", {
        appId: app.id,
        cmdIndex: idx,
        tunnel: name,
        hostname: host,
        auto: bind ? bind.auto : true,
      });
    }
    if (res && res.error) alert("Public access: " + res.error);
    await loadPublic();
    await refreshApps();
  };
  row.appendChild(sel);

  /* --- Tailscale: the daemon holds it up, so there's nothing to control --- */
  if (ts && !(bind && bind.tunnel)) {
    row.appendChild(publicLink(ts.url));
    row.appendChild(publicBadge("● public", "on"));
    return;
  }

  /* --- Cloudflare: Rack owns the process, so it gets real controls --- */
  if (!bind || !bind.tunnel) return;

  const status = live ? live.status : "off";
  const connected = status === "public";

  const auto = document.createElement("label");
  auto.className = "funnel-auto";
  auto.title = "Publish automatically whenever this process runs";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = !!bind.auto;
  box.onchange = async () => {
    box.disabled = true;
    await cfPost("/api/cf", {
      appId: app.id,
      cmdIndex: idx,
      tunnel: bind.tunnel,
      hostname: bind.hostname,
      auto: box.checked,
      connect: false,
    });
    await refreshApps();
  };
  auto.appendChild(box);
  auto.appendChild(document.createTextNode("auto"));
  row.appendChild(auto);

  if (cmd.running) {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost btn-sm";
    btn.textContent = connected || status === "connecting" ? "Disconnect" : "Connect";
    btn.onclick = async () => {
      btn.disabled = true;
      const res = await cfPost("/api/cf/connect", {
        appId: app.id,
        cmdIndex: idx,
        enable: !(connected || status === "connecting"),
      });
      if (res && res.error) alert("Cloudflare: " + res.error);
      await loadPublic();
      renderPanel();
    };
    row.appendChild(btn);
  }

  if (bind.hostname) row.appendChild(publicLink(`https://${bind.hostname}`));

  const badge = !cmd.running
    ? publicBadge("○ waits for the process", "idle")
    : status === "connecting"
    ? publicBadge("◌ connecting…", "idle")
    : status === "failed"
    ? publicBadge("● failed", "err")
    : connected
    ? publicBadge("● public", "on")
    : publicBadge("○ off", "idle");
  if (live && live.error) badge.title = live.error;
  row.appendChild(badge);

  if (live && (status === "failed" || live.error)) {
    const log = document.createElement("button");
    log.className = "btn btn-link funnel-url";
    log.textContent = "log ↗";
    log.onclick = () => openCfLog(app, idx);
    row.appendChild(log);
  }
}

function publicLink(href) {
  const a = document.createElement("a");
  a.className = "btn btn-link funnel-url";
  a.target = "_blank";
  a.href = href;
  a.textContent = "Public URL ↗";
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
    line.textContent = "⟲ Not checked yet — ⚙ Check for updates.";
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
    renderPublicRow(el.querySelector(".funnel-row"), app, cmd, idx);
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
    ? "All set — pick a tunnel in a process's Public dropdown."
    : "All set — open a process's Public dropdown and choose ＋ New tunnel…";

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

/* ------------------------------------------------------------- SSE */

function connectEvents() {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === "apps") {
      refreshApps().then(loadLogs);
    } else if (ev.type === "status") {
      const i = appsList.findIndex((a) => a.id === ev.app.id);
      if (i >= 0) appsList[i] = ev.app;
      renderSidebar();
      if (ev.app.id === selectedId) {
        renderPanel();
        renderConsoles();
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
    } else if (ev.type === "cf") {
      loadCf().then(renderPanel);
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
      $("update-sub").textContent = "New version pulled — restarting Rack…";
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
