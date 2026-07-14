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

function appItem(app) {
  const btn = document.createElement("button");
  btn.className = "app-item" + (app.id === selectedId ? " selected" : "");
  btn.innerHTML =
    `<span class="dot ${app.running ? "running" : ""}"></span>` +
    `<span class="name"></span>` +
    (app.autostart ? `<span class="auto-badge" title="Auto-starts on launch">⚡</span>` : "");
  btn.querySelector(".name").textContent = app.name;
  btn.onclick = () => selectApp(app.id);
  return btn;
}

function renderSidebar() {
  const list = $("app-list");
  list.innerHTML = "";

  // Group by category, preserving app order. Uncategorized shown first, headerless.
  const groups = new Map();
  for (const app of appsList) {
    const key = app.category || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(app);
  }

  for (const [cat, apps] of groups) {
    if (!cat) {
      apps.forEach((a) => list.appendChild(appItem(a)));
      continue;
    }
    const collapsed = collapsedCats.has(cat);
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
    list.appendChild(header);
    if (!collapsed) apps.forEach((a) => list.appendChild(appItem(a)));
  }
}

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
  $("btn-update").hidden = !app || !app.update;

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

function renderDetails(app) {
  const wrap = $("det-commands");
  wrap.innerHTML = "";
  if (app.setup) {
    const note = document.createElement("div");
    note.className = "setup-note";
    note.innerHTML =
      `⚙ One-time setup: <code></code> <span class="muted">— run it once by hand, and after code changes.</span>`;
    note.querySelector("code").textContent = app.setup;
    wrap.appendChild(note);
  }
  for (const cmd of app.commands) {
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
      <div class="det-links"></div>`;
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
    wrap.appendChild(el);
  }
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
  if (!app || !app.update) return;
  $("update-title").textContent = `Update — ${app.name}`;
  $("update-sub").textContent = `Running: ${app.update}`;
  $("update-log").innerHTML = "";
  updateModal.hidden = false;
  const res = await api(`/api/apps/${app.id}/update`, { method: "POST" });
  if (res.error) appendLine($("update-log"), "err", "[update] " + res.error);
};
$("update-close").onclick = () => (updateModal.hidden = true);
updateModal.onclick = (e) => { if (e.target === updateModal) updateModal.hidden = true; };

/* ------------------------------------------------------------- editor modal */

const modal = $("modal");
let editingId = null;

function addProcRow(cmd) {
  const tpl = $("proc-tpl").content.cloneNode(true);
  const row = tpl.querySelector(".proc-row");
  if (cmd) {
    row.querySelector(".proc-name").value = cmd.name || "";
    row.querySelector(".proc-path").value = cmd.exe || "";
    row.querySelector(".proc-args").value = (cmd.args || []).join(" ");
    row.querySelector(".proc-port").value = cmd.port || "";
    row.querySelector(".proc-dir").value = cmd.dir || "";
    row.querySelector(".proc-stop").value = cmd.stopCommand || "";
  }
  row.querySelector(".proc-remove").onclick = () => {
    if ($("proc-rows").children.length > 1) row.remove();
  };
  $("proc-rows").appendChild(row);
}

function openEditor(app) {
  editingId = app ? app.id : null;
  $("modal-title").textContent = app ? "Edit app" : "Add app";
  $("inp-name").value = app ? app.name : "";
  $("inp-category").value = app ? app.category || "" : "";
  $("inp-autostart").checked = app ? !!app.autostart : false;
  $("inp-update").value = app ? app.update || "" : "";
  // populate category suggestions from existing apps
  const cats = [...new Set(appsList.map((a) => a.category).filter(Boolean))];
  $("cat-list").innerHTML = cats.map((c) => `<option value="${c.replace(/"/g, "&quot;")}">`).join("");
  $("proc-rows").innerHTML = "";
  if (app && app.commands.length) app.commands.forEach(addProcRow);
  else addProcRow();
  $("modal-error").hidden = true;
  modal.hidden = false;
  (app ? $("inp-name") : $("proc-rows").querySelector(".proc-path")).focus();
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
  if (e.key === "Escape") { modal.hidden = true; updateModal.hidden = true; }
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
      $("update-sub").textContent =
        ev.code === 0 ? "✓ Update finished — press Run." : `Update exited with code ${ev.code}.`;
    }
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 2000);
  };
}

/* ------------------------------------------------------------- init */

refreshApps().then(loadLogs);
connectEvents();
