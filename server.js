/*
 * Rack — manages multiple local apps, each of which may run
 * several processes ("commands"). Every process is captured inside the
 * controller (its own console), so nothing pops up in a stray window.
 * Zero dependencies: uses only Node.js built-ins.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, exec, execFile, execSync } = require("child_process");

const VERSION = "0.12.0";
// True when launched by the start.bat supervisor loop, which can relaunch us on
// exit code 42 — that's what makes one-click "Update Rack" able to restart.
const SUPERVISED = process.env.RACK_SUPERVISOR === "1" || process.argv.includes("--supervised");
const RESTART_EXIT_CODE = 42;

const portArg = process.argv.find((a) => a.startsWith("--port="));
const CONTROL_PORT = portArg ? Number(portArg.split("=")[1]) : 7799;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const APPS_FILE = path.join(ROOT, "apps.json");
const SETTINGS_FILE = path.join(ROOT, "settings.json");
const RESTORE_FILE = path.join(ROOT, ".rack-restore.json");
const MAX_LOG_LINES = 600;
const BASE_APP_PORT = 8090;

/* ---------------------------------------------------------------- helpers */

const RUNNABLE = /\.(exe|bat|cmd)$/i;
const isPB = (exe) => path.basename(exe || "").toLowerCase().includes("pocketbase");

// Split a command-argument string into tokens, respecting simple quotes.
function parseArgs(str) {
  if (!str || !String(str).trim()) return [];
  const tokens = String(str).match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return tokens.map((t) => t.replace(/^["']|["']$/g, ""));
}

function extractHttpPort(args) {
  for (const a of args || []) {
    const m = /^--http=.*?:(\d+)/.exec(a);
    if (m) return Number(m[1]);
  }
  return null;
}

/* ---------------------------------------------------------------- storage */

let apps = [];

// Bring any shape (legacy single-exe, or new multi-command) into the canonical
// { id, name, commands: [{ name, exe, args, dir, port, managePort, raw }] } form.
function normalizeApp(app) {
  if (!Array.isArray(app.commands)) {
    const exe = app.exe || "";
    const args = app.args || [];
    const pb = isPB(exe);
    app.commands = [
      {
        name: app.name || "main",
        exe,
        args: pb ? args.filter((a) => !/^--http=/.test(a)) : args,
        dir: app.dir || (exe ? path.dirname(exe) : ROOT),
        port: pb ? extractHttpPort(args) ?? app.port ?? null : app.port ?? null,
        managePort: pb,
        raw: false,
      },
    ];
  }
  app.commands = app.commands.map((c, i) => ({
    name: c.name || `process ${i + 1}`,
    exe: c.exe || "",
    args: Array.isArray(c.args) ? c.args : parseArgs(c.args),
    dir: c.dir || (c.exe && !c.raw ? path.dirname(c.exe) : ROOT),
    port: c.port ?? null,
    managePort: !!c.managePort,
    raw: !!c.raw,
    portEnv: c.portEnv || null, // env var the controller sets to the effective port
    links: Array.isArray(c.links) ? c.links : null, // [{ label, path }]
    stopCommand: c.stopCommand || null, // shell command run on Stop (e.g. docker compose down)
    cloudflare: cfBinding(c.cloudflare), // { tunnel, hostname, auto } — publish this port publicly
  }));
  app.category = app.category || null;
  app.autostart = !!app.autostart; // start this app when the controller launches
  app.update = app.update || null; // shell command to fetch a new version (e.g. git pull)
  app.rebuild = app.rebuild || null; // build step run after update; blank = auto-detect rebuild.bat
  delete app.exe;
  delete app.args;
  delete app.dir;
  delete app.port;
  return app;
}

function loadApps() {
  try {
    apps = JSON.parse(fs.readFileSync(APPS_FILE, "utf8")).map(normalizeApp);
  } catch {
    apps = [];
  }
}
function saveApps() {
  fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
}
loadApps();

// Controller-wide, per-machine settings (currently just the apps folder that
// "Install from GitHub" clones into). Gitignored, like apps.json.
let settings = { appsDir: null };
function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {}
}
function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
loadSettings();

// Point the controller at a folder to keep cloned apps in; it's created if it
// doesn't exist yet. Blank clears the setting.
function setAppsDir(input) {
  const raw = (input || "").trim().replace(/^"|"$/g, "");
  if (!raw) {
    settings.appsDir = null;
    saveSettings();
    return { ok: true };
  }
  const dir = path.resolve(raw);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `Couldn't create ${dir}: ${e.message}` };
  }
  if (!fs.statSync(dir).isDirectory()) return { ok: false, error: `${dir} is not a folder.` };
  settings.appsDir = dir;
  saveSettings();
  return { ok: true };
}

/* ---------------------------------------------------------- runtime state */

// appId -> array aligned with app.commands: { proc, pid, startedAt, effPort, log:[{s,line}], errCount }
const runtime = new Map();

function slotsFor(app) {
  let slots = runtime.get(app.id);
  if (!slots || slots.length !== app.commands.length) {
    const old = slots || [];
    slots = app.commands.map((_, i) => old[i] || { proc: null, log: [], errCount: 0 });
    runtime.set(app.id, slots);
  }
  return slots;
}

function stateOf(app) {
  const slots = slotsFor(app);
  const commands = app.commands.map((c, i) => {
    const s = slots[i];
    const running = !!(s && s.proc);
    return {
      name: c.name,
      exe: c.exe,
      args: c.args,
      dir: c.dir,
      port: c.port,
      managePort: c.managePort,
      raw: c.raw,
      portEnv: c.portEnv || null,
      links: c.links || null,
      stopCommand: c.stopCommand || null,
      cloudflare: c.cloudflare || null,
      running,
      pid: running ? s.pid : null,
      startedAt: running ? s.startedAt : null,
      effPort: running ? s.effPort : c.port,
    };
  });
  const runningCmds = commands.filter((c) => c.running);
  return {
    id: app.id,
    name: app.name,
    setup: app.setup || null,
    category: app.category || null,
    autostart: !!app.autostart,
    update: app.update || null,
    rebuild: app.rebuild || null,
    rebuildStep: (rebuildStepFor(app) || {}).label || null,
    commands,
    running: runningCmds.length > 0,
    runningCount: runningCmds.length,
    total: commands.length,
    startedAt: runningCmds.length ? Math.min(...runningCmds.map((c) => c.startedAt)) : null,
    ports: commands.map((c) => c.effPort).filter(Boolean),
  };
}

/* -------------------------------------------------------------------- SSE */

const sseClients = new Set();
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(data);
}

/* ------------------------------------------------------------ port control */

function nextFreePort(taken) {
  let p = BASE_APP_PORT;
  while (taken.has(p)) p++;
  return p;
}

// Assign concrete ports to every controller-managed command, shifting off any
// port already claimed by another app. Returns what moved + unresolved clashes.
function resolvePorts() {
  const changes = [];
  const taken = new Set();
  // Ports baked into non-managed commands can't be moved — lock them first.
  for (const a of apps)
    for (const c of a.commands) if (c.port && !c.managePort) taken.add(c.port);

  for (const a of apps)
    for (const c of a.commands) {
      if (!c.managePort) continue;
      let want = c.port;
      if (!want || taken.has(want)) {
        const p = nextFreePort(taken);
        if (want && want !== p) changes.push({ app: a.name, cmd: c.name, from: want, to: p });
        want = p;
      }
      c.port = want;
      taken.add(want);
    }
  saveApps();
  return { changes, conflicts: conflicts() };
}

// Ports declared by more than one app that the controller cannot auto-move.
function conflicts() {
  const map = {};
  for (const a of apps)
    for (const c of a.commands) {
      if (!c.port) continue;
      (map[c.port] ||= []).push({ app: a.name, cmd: c.name });
    }
  return Object.entries(map)
    .filter(([, v]) => v.length > 1)
    .map(([port, holders]) => ({ port: Number(port), holders }));
}

/* --------------------------------------------------------- process control */

function pushLog(app, idx, stream, chunk) {
  const slot = slotsFor(app)[idx];
  if (!slot) return;
  const lines = chunk.toString().split(/\r?\n/).filter((l) => l.length > 0);
  for (const line of lines) {
    slot.log.push({ s: stream, line });
    if (slot.log.length > MAX_LOG_LINES) slot.log.shift();
    if (stream === "err") slot.errCount++;
    broadcast({ type: "log", id: app.id, cmd: idx, stream, line });
  }
}

function buildRunArgs(cmd, effPort) {
  if (cmd.managePort) {
    const base = (cmd.args || []).filter((a) => !/^--http=/.test(a) && a !== "serve");
    return ["serve", ...base, `--http=127.0.0.1:${effPort}`];
  }
  return cmd.args || [];
}

// The Rack SDK contract: every process is launched with env vars telling it
// which ports to use — its own (RACK_PORT + its portEnv) and its siblings'
// (RACK_PORT_<NAME>). Scripts/apps read these instead of hardcoding ports.
// MAC_* aliases are kept for backward compatibility.
function envFor(app, cmd, effPort) {
  const env = { ...process.env, RACK: "1", MAC: "1" };
  if (effPort) {
    env.RACK_PORT = env.MAC_PORT = String(effPort);
    if (cmd.portEnv) env[cmd.portEnv] = String(effPort);
  }
  for (const sib of app.commands) {
    const p = sib.port;
    if (!p) continue;
    const key = sib.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    env["RACK_PORT_" + key] = String(p);
    env["MAC_PORT_" + key] = String(p);
    if (sib.portEnv && !env[sib.portEnv]) env[sib.portEnv] = String(p);
  }
  return env;
}

function spawnCommand(cmd, effPort, env) {
  const args = buildRunArgs(cmd, effPort);
  const isBatch = /\.(bat|cmd)$/i.test(cmd.exe);
  if (cmd.raw || isBatch) {
    // Run through a shell. Quote file paths (but not a raw command string).
    const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
    const head = cmd.raw ? cmd.exe : q(cmd.exe);
    const line = [head, ...args.map(q)].join(" ");
    return spawn(line, { cwd: cmd.dir, windowsHide: true, shell: true, env });
  }
  return spawn(cmd.exe, args, { cwd: cmd.dir, windowsHide: true, env });
}

function startApp(app) {
  const slots = slotsFor(app);
  if (slots.every((s) => s.proc) && slots.length) return { ok: false, error: "Already running" };

  // Ports already claimed by *other* apps, so a managed port avoids them.
  const taken = new Set();
  for (const a of apps)
    if (a.id !== app.id) for (const c of a.commands) if (c.port) taken.add(c.port);

  let started = 0;
  app.commands.forEach((cmd, i) => {
    const slot = slots[i];
    if (slot.proc) return; // already running this process

    if (!cmd.raw && !fs.existsSync(cmd.exe)) {
      pushLog(app, i, "err", `[controller] not found: ${cmd.exe}`);
      return;
    }

    let effPort = cmd.port;
    if (cmd.managePort) {
      effPort = cmd.port && !taken.has(cmd.port) ? cmd.port : nextFreePort(taken);
      if (effPort !== cmd.port) {
        cmd.port = effPort; // remember the resolved port
        saveApps();
      }
    }
    if (effPort) taken.add(effPort);
    slot.effPort = effPort;

    let proc;
    try {
      proc = spawnCommand(cmd, effPort, envFor(app, cmd, effPort));
    } catch (e) {
      pushLog(app, i, "err", `[controller] failed to start: ${e.message}`);
      return;
    }
    slot.proc = proc;
    slot.pid = proc.pid;
    slot.startedAt = Date.now();
    started++;

    const where = effPort ? ` on port ${effPort}` : "";
    pushLog(app, i, "out", `[controller] started ${cmd.name} (pid ${proc.pid})${where}`);
    proc.stdout.on("data", (d) => pushLog(app, i, "out", d));
    proc.stderr.on("data", (d) => pushLog(app, i, "err", d));
    proc.on("error", (e) => pushLog(app, i, "err", `[controller] error: ${e.message}`));
    proc.on("exit", (code, signal) => {
      pushLog(app, i, "out", `[controller] process exited (code ${code ?? signal})`);
      // A late exit event from an older process must not clear a fresh one
      // (a restart can start the replacement before this fires).
      if (slot.proc === proc) {
        slot.proc = null;
        // A tunnel must never outlive what it publishes, or the public URL
        // starts answering 502s from Cloudflare's edge.
        stopTunnel(app.id, i);
      }
      broadcast({ type: "status", app: stateOf(app) });
    });

    // Auto-expose: a bound tunnel comes up with the process. The short delay
    // just keeps the logs tidy — cloudflared would retry anyway.
    if (cmd.cloudflare && cmd.cloudflare.tunnel && cmd.cloudflare.auto) {
      setTimeout(() => connectTunnel(app, i), 1200);
    }
  });

  broadcast({ type: "status", app: stateOf(app) });
  return { ok: started > 0, error: started ? undefined : "Nothing could be started" };
}

function killPid(pid) {
  if (process.platform === "win32") {
    exec(`taskkill /pid ${pid} /t /f`); // /t kills the whole tree
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

function stopApp(app) {
  const slots = slotsFor(app);
  let stopped = 0;
  slots.forEach((slot, i) => {
    const cmd = app.commands[i];
    stopTunnel(app.id, i); // take the public route down before the process behind it
    // A stopCommand does a graceful teardown (e.g. `docker compose down`).
    if (cmd && cmd.stopCommand) {
      pushLog(app, i, "out", `[controller] stop: ${cmd.stopCommand}`);
      const sc = spawn(cmd.stopCommand, { cwd: cmd.dir, windowsHide: true, shell: true });
      sc.stdout.on("data", (d) => pushLog(app, i, "out", d));
      sc.stderr.on("data", (d) => pushLog(app, i, "err", d));
    }
    if (!slot.proc) return;
    pushLog(app, i, "out", "[controller] stopping...");
    killPid(slot.pid);
    stopped++;
  });
  const hasStopCmd = app.commands.some((c) => c.stopCommand);
  return { ok: stopped > 0 || hasStopCmd, error: stopped || hasStopCmd ? undefined : "Not running" };
}

// An app's folder — where its update / rebuild commands run (the repo root).
function appDir(app) {
  return (app.commands[0] && app.commands[0].dir) || ROOT;
}

// "setup.bat" means the one in the app's folder. cmd.exe usually finds it there,
// but not when NoDefaultCurrentDirectoryInExePath is set — and a shell started
// from an odd place may not either — so spell the path out. A command that isn't
// a file in the folder ("npm install", "git pull") is left alone.
function resolveStepCommand(command, dir) {
  const line = String(command || "").trim();
  const m = /^"([^"]+)"|^(\S+)/.exec(line);
  if (!m) return line;
  const first = (m[1] || m[2] || "").replace(/^\.[\\/]/, "");
  if (!first || path.isAbsolute(first)) return line;
  const full = path.join(dir, first);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return line;
  return `"${full}"${line.slice(m[0].length)}`;
}

// New code often has to be compiled before it can run, so ⟳ Update runs a second
// step after the update command: the app's `rebuild` command, or — when none is
// set — a `rebuild.bat` sitting in its folder. Set `rebuild` to "off" to skip it.
const REBUILD_OFF = /^(off|none|no|false)$/i;
const REBUILD_FILES = ["rebuild.bat", "rebuild.cmd", "rebuild.sh"];
function rebuildStepFor(app) {
  const explicit = (app.rebuild || "").trim();
  if (explicit) return REBUILD_OFF.test(explicit) ? null : { cmd: explicit, label: explicit };
  const dir = appDir(app);
  for (const f of REBUILD_FILES) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return { cmd: f.endsWith(".sh") ? `sh "${p}"` : `"${p}"`, label: f };
  }
  return null;
}

/* ------------------------------------------------------------------- git */

// Small git wrappers. The sync one is only ever used for local, instant
// questions (what commit is checked out?); anything that talks to a remote goes
// through gitAsync so a slow network can't freeze the dashboard.
// A check must never sit waiting on a credential prompt nobody can see.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
function gitSync(dir, args) {
  try {
    return execSync(`git ${args.join(" ")}`, {
      cwd: dir,
      windowsHide: true,
      env: GIT_ENV,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}
function gitAsync(dir, args, timeout = 45000) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: dir, timeout, windowsHide: true, env: GIT_ENV }, (err, stdout, stderr) =>
      resolve({
        ok: !err,
        out: String(stdout || "").trim(),
        error: err ? String(stderr || "").trim() || err.message : null,
      })
    );
  });
}
const gitHeadIn = (dir) => gitSync(dir, ["rev-parse", "HEAD"]);
const isGitRepo = (dir) => gitSync(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";

// Ask the remote whether there's anything new, without changing the checkout.
// Returns { repo, behind, ahead, commits, ... } — `behind` is what "an update is
// available" means: commits on the upstream branch we don't have yet.
async function checkGit(dir) {
  if (!dir || !fs.existsSync(dir)) return { repo: false, reason: "folder not found" };
  if (!isGitRepo(dir)) return { repo: false, reason: "not a git checkout" };

  const fetched = await gitAsync(dir, ["fetch", "--quiet"]);
  const upstream = await gitAsync(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream.ok) {
    return { repo: true, error: "this branch isn't tracking a remote branch", head: gitHeadIn(dir).slice(0, 7) };
  }
  const count = await gitAsync(dir, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
  const [ahead, behind] = count.ok ? count.out.split(/\s+/).map(Number) : [0, 0];
  const log = behind ? await gitAsync(dir, ["log", "--pretty=%h %s", "-5", "HEAD..@{u}"]) : null;
  return {
    repo: true,
    head: gitHeadIn(dir).slice(0, 7),
    upstream: upstream.out,
    ahead: ahead || 0,
    behind: behind || 0,
    commits: log && log.ok ? log.out.split(/\r?\n/).filter(Boolean) : [],
    // a failed fetch still reports the last known state, but says it may be stale
    error: fetched.ok ? null : `couldn't reach the remote: ${firstLine(fetched.error)}`,
  };
}
const firstLine = (s) => String(s || "").split(/\r?\n/).filter(Boolean)[0] || "";

/* --------------------------------------------------- "check for updates" */

// Cached answer to "is there anything new?", for Rack itself and every app that
// has an update command. Refreshed on demand (⟲ Check for updates), a while
// after boot, every few hours, and after an update runs.
const AUTO_CHECK_MS = 6 * 60 * 60 * 1000;
let updateStatus = { checking: false, checkedAt: 0, rack: null, apps: {} };
let checkTimer = null;

function updateStatusFor(app) {
  return updateStatus.apps[app.id] || null;
}

async function checkUpdates() {
  if (updateStatus.checking) return updateStatus;
  updateStatus.checking = true;
  broadcast({ type: "updates" });
  try {
    updateStatus.rack = await checkGit(ROOT);
    const found = {};
    for (const a of apps) {
      // Nothing to apply without an update command, so nothing worth reporting.
      found[a.id] = a.update ? await checkGit(appDir(a)) : { repo: false, reason: "no update command" };
    }
    updateStatus.apps = found;
    updateStatus.checkedAt = Date.now();
  } finally {
    updateStatus.checking = false;
    broadcast({ type: "updates" });
  }
  return updateStatus;
}

// Re-check shortly after something changed the picture (an update ran, an app
// was added), coalescing a burst of changes into one pass.
function checkUpdatesSoon(delay = 3000) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => checkUpdates().catch(() => {}), delay);
}

function updatesPayload() {
  return {
    checking: updateStatus.checking,
    checkedAt: updateStatus.checkedAt || null,
    rack: { version: VERSION, supervised: SUPERVISED, ...(updateStatus.rack || {}) },
    apps: apps.map((a) => ({
      id: a.id,
      name: a.name,
      canUpdate: !!(a.update || rebuildStepFor(a)),
      ...(updateStatus.apps[a.id] || {}),
    })),
  };
}

/* ---------------------------------------------------------- app updates */

// Run an app's update sequence and stream the output to the UI via SSE:
//
//   update command → (only if it actually brought new code) rebuild → restart
//
// The app keeps running through the update command — it's only stopped once
// there's something to build or restart, so a "nothing to pull" update leaves a
// running app completely alone.
const updateProcs = new Map();

// Stopping is asynchronous (taskkill), so wait for the processes to really be
// gone: building over files they still hold open fails, and starting over a
// live slot would be a silent no-op.
function waitStopped(app, cb, tries = 0) {
  if (!slotsFor(app).some((s) => s.proc)) return cb(true);
  if (tries >= 40) return cb(false); // ~10s
  setTimeout(() => waitStopped(app, cb, tries + 1), 250);
}

function updateApp(app) {
  if (updateProcs.get(app.id)) return { ok: false, error: "An update is already running." };
  const rebuild = rebuildStepFor(app);
  if (!app.update && !rebuild) return { ok: false, error: "No update command set for this app." };

  const dir = appDir(app);
  const emit = (stream, line) => broadcast({ type: "update-log", id: app.id, stream, line });
  const wasRunning = slotsFor(app).some((s) => s.proc);
  updateProcs.set(app.id, true); // claim the slot before the first spawn

  const done = (code, changed, restarted) => {
    updateProcs.delete(app.id);
    emit("out", `[update] finished (exit code ${code})`);
    broadcast({ type: "update-done", id: app.id, code, changed, restarted });
    if (code === 0) checkUpdatesSoon(); // the badge is stale either way now
  };

  const runStep = (tag, cmd, label, onExit) => {
    emit("out", `[${tag}] ${label}   (in ${dir})`);
    let proc;
    try {
      // `cmd` may name a script in the app's folder, and stdin is /dev/null so a
      // script that ends in `pause` can't stall the update forever.
      proc = spawn(resolveStepCommand(cmd, dir), {
        cwd: dir,
        windowsHide: true,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      emit("err", `[${tag}] error: ${e.message}`);
      return onExit(1);
    }
    updateProcs.set(app.id, proc);
    const pump = (stream) => (d) =>
      d
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((l) => {
          if (tag === "update" && /already up[- ]to[- ]date/i.test(l)) proc.sawUpToDate = true;
          emit(stream, l);
        });
    proc.stdout.on("data", pump("out"));
    proc.stderr.on("data", pump("err"));
    proc.on("error", (e) => emit("err", `[${tag}] error: ${e.message}`));
    proc.on("exit", (code) => onExit(code, !!proc.sawUpToDate));
  };

  const restart = (code, changed) => {
    if (!wasRunning) return done(code, changed, false);
    emit("out", "[update] restarting the app...");
    waitStopped(app, (gone) => {
      if (!gone) {
        emit("err", "[update] the app hasn't stopped — start it by hand.");
        return done(code, changed, false);
      }
      const r = startApp(app);
      if (!r.ok) emit("err", `[update] restart failed: ${r.error}`);
      done(code, changed, r.ok);
    });
  };

  // New code is in the folder: build it if there's a build step, then make sure
  // the app is actually running the new code rather than the old one.
  const applyNewCode = (changed) => {
    if (!rebuild) {
      if (!wasRunning) return done(0, changed, false);
      emit("out", "[update] new code — restarting the app so it picks it up");
      stopApp(app);
      return restart(0, changed);
    }
    if (wasRunning) {
      emit("out", "[update] stopping the app — a build can't overwrite files it holds open");
      stopApp(app);
    }
    waitStopped(app, (gone) => {
      if (!gone) {
        emit("err", "[update] the app hasn't stopped — skipping the rebuild.");
        return done(1, changed, false);
      }
      runStep("rebuild", rebuild.cmd, rebuild.label, (code) => {
        if (code !== 0) {
          emit("err", "[rebuild] failed — the app stays stopped, so you never run half-built code.");
          return done(code, changed, false);
        }
        restart(0, changed);
      });
    });
  };

  // A rebuild asked for on its own always runs — there's no update to compare.
  if (!app.update) {
    applyNewCode(true);
    return { ok: true };
  }

  const headBefore = gitHeadIn(dir);
  runStep("update", app.update, app.update, (code, sawUpToDate) => {
    if (code !== 0) {
      // The app was never stopped, so a failed update leaves it exactly as it was.
      emit("err", `[update] failed (code ${code}) — nothing was built or restarted.`);
      return done(code, false, false);
    }
    // In a git checkout the commit itself is the answer; elsewhere fall back to
    // what the command said, and assume new code if it said nothing.
    const changed = headBefore ? headBefore !== gitHeadIn(dir) : !sawUpToDate;
    if (!changed) {
      emit("out", `[update] already up to date — skipping ${rebuild ? rebuild.label : "the restart"}.`);
      return done(0, false, false);
    }
    if (headBefore) emit("out", `[update] new code: ${headBefore.slice(0, 7)} → ${gitHeadIn(dir).slice(0, 7)}`);
    applyNewCode(true);
  });
  return { ok: true };
}

// Update Rack itself: `git pull` in ROOT, and if new code arrived, restart via
// the supervisor (exit 42). Running apps are remembered and brought back after.
let selfUpdating = false;
function selfUpdate() {
  if (!SUPERVISED) return { ok: false, error: "Launch Rack via start.bat to enable one-click update." };
  if (selfUpdating) return { ok: false, error: "An update is already running." };
  selfUpdating = true;
  const emit = (stream, line) => broadcast({ type: "self-update-log", stream, line });
  const before = gitHeadIn(ROOT);
  emit("out", "[update] git pull");
  const proc = spawn("git pull", { cwd: ROOT, windowsHide: true, shell: true });
  const pump = (s) => (d) => d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => emit(s, l));
  proc.stdout.on("data", pump("out"));
  proc.stderr.on("data", pump("err"));
  proc.on("error", (e) => { selfUpdating = false; emit("err", "[update] " + e.message); broadcast({ type: "self-update-done", ok: false }); });
  proc.on("exit", (code) => {
    if (code !== 0) {
      selfUpdating = false;
      emit("err", `[update] git pull failed (code ${code}).`);
      return broadcast({ type: "self-update-done", ok: false });
    }
    if (before && before === gitHeadIn(ROOT)) {
      selfUpdating = false;
      emit("out", "[update] Already up to date.");
      checkUpdatesSoon();
      return broadcast({ type: "self-update-done", ok: true, changed: false });
    }
    emit("out", "[update] Updated — restarting Rack...");
    try {
      const runningIds = apps.filter((a) => slotsFor(a).some((s) => s.proc)).map((a) => a.id);
      fs.writeFileSync(RESTORE_FILE, JSON.stringify(runningIds));
    } catch {}
    for (const a of apps) stopApp(a); // avoid orphaned children across the restart
    broadcast({ type: "self-update-restart" });
    setTimeout(() => process.exit(RESTART_EXIT_CODE), 1000);
  });
  return { ok: true };
}

/* ------------------------------------------------------ add / edit an app */

// Resolve one process spec { name, path, args, dir, port } into a stored command.
// baseDir resolves relative paths (used when importing from a manifest).
function resolveCommand(spec, baseDir) {
  const rawInput = (spec.path || "").trim().replace(/^"|"$/g, "");
  if (!rawInput) return { error: "Each process needs a command or a path." };

  const resolved = path.resolve(baseDir || ".", rawInput);
  let exe, dir, raw = false;

  if (fs.existsSync(resolved)) {
    const st = fs.statSync(resolved);
    if (st.isFile()) {
      exe = resolved;
      dir = path.dirname(resolved);
    } else {
      dir = resolved;
      const files = fs.readdirSync(dir);
      const lc = (f) => f.toLowerCase();
      const pick =
        files.find((f) => lc(f).includes("pocketbase") && lc(f).endsWith(".exe")) ||
        files.find((f) => /^(start|run|launch)\b.*\.(bat|cmd)$/i.test(f)) ||
        (files.filter((f) => RUNNABLE.test(f)).length === 1
          ? files.find((f) => RUNNABLE.test(f))
          : null);
      if (!pick)
        return { error: `Couldn't find an app to run in ${dir}. Point at the .exe/.bat, or type a command.` };
      exe = path.join(dir, pick);
    }
  } else {
    // Not a real path — treat the text as a raw shell command (e.g. "npm run start").
    raw = true;
    exe = rawInput;
    // A manifest's typed command runs in the app's folder, as RACK-SDK documents;
    // one typed into the dialog has no folder to inherit, so it runs next to Rack.
    dir = baseDir ? path.resolve(baseDir) : ROOT;
  }

  // Optional working-folder override. A manifest's `"dir": "."` means the app's
  // own folder, so relative paths resolve against baseDir — not against whatever
  // directory Rack itself was started from.
  if (spec.dir && spec.dir.trim()) {
    const d = path.resolve(baseDir || ".", spec.dir.trim().replace(/^"|"$/g, ""));
    if (!fs.existsSync(d)) return { error: `Working folder does not exist: ${d}` };
    dir = d;
  }

  const pb = !raw && isPB(exe);
  const customArgs = parseArgs(spec.args);
  const hasHttp = customArgs.some((a) => /^--http=/.test(a));
  let port = spec.port != null && String(spec.port).trim() !== "" ? Number(spec.port) : null;
  if (port != null && !Number.isFinite(port)) port = null;

  let managePort = false;
  let args;
  if (pb && !hasHttp) {
    managePort = true; // controller owns the port + injects --http
    args = customArgs.filter((a) => a !== "serve");
  } else {
    args = customArgs;
    if (hasHttp && port == null) port = extractHttpPort(customArgs);
  }

  const name = (spec.name || "").trim() || (raw ? exe.split(/\s+/)[0] : path.basename(exe));
  const stopCommand = (spec.stopCommand || "").trim() || null;
  return { cmd: { name, exe, args, dir, port, managePort, raw, stopCommand } };
}

const MANIFEST_NAMES = ["rack.json", "multiapp.json", ".rack.json", ".multiapp.json"];

// Read a rack.json (or legacy multiapp.json) manifest from a folder, if present.
function loadManifest(dir) {
  for (const name of MANIFEST_NAMES) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) {
      try {
        return JSON.parse(fs.readFileSync(f, "utf8"));
      } catch (e) {
        return { __error: `${name} is not valid JSON: ${e.message}` };
      }
    }
  }
  return null;
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Build a full app from a manifest object. Process fields:
//   name, command (path/exe/bat or typed command), args?, dir?, port?,
//   managed? (controller may reassign), portEnv?, links? [{label, path}]
function buildFromManifest(dir, man, nameOverride) {
  if (man.__error) return { error: man.__error };
  const procs = Array.isArray(man.processes) ? man.processes : [];
  if (!procs.length) return { error: "Manifest has no processes." };

  const commands = [];
  for (let i = 0; i < procs.length; i++) {
    const proc = procs[i];
    const r = resolveCommand(
      { name: proc.name, path: proc.command, args: proc.args, dir: proc.dir, port: proc.port, stopCommand: proc.stop || proc.stopCommand },
      dir
    );
    if (r.error) return { error: `Manifest process "${proc.name || i + 1}": ${r.error}` };
    if (proc.managed != null) r.cmd.managePort = !!proc.managed; // manifest wins over auto-detect
    if (proc.portEnv) r.cmd.portEnv = proc.portEnv;
    if (Array.isArray(proc.links)) r.cmd.links = proc.links;
    if (proc.cloudflare) r.cmd.cloudflare = cfBinding(proc.cloudflare);
    commands.push(r.cmd);
  }
  const app = {
    id: newId(),
    name: (nameOverride || "").trim() || (man.name || "").trim() || path.basename(dir),
    commands,
  };
  if (man.setup) app.setup = typeof man.setup === "string" ? man.setup : man.setup.command || null;
  if (man.category) app.category = String(man.category);
  if (man.autostart != null) app.autostart = !!man.autostart;
  if (man.update) app.update = String(man.update);
  // `"rebuild": false` opts out of the rebuild.bat auto-detection.
  if (man.rebuild != null) app.rebuild = man.rebuild === false ? "off" : String(man.rebuild);
  return { app };
}

function resolveApp(spec) {
  // Auto-import: pointing a single entry at a folder that has a manifest.
  const probe = spec.path || (spec.commands && spec.commands[0] && spec.commands[0].path);
  const single = !Array.isArray(spec.commands) || spec.commands.length <= 1;
  if (single && probe) {
    const p = path.resolve(probe.trim().replace(/^"|"$/g, ""));
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      const man = loadManifest(p);
      if (man) return buildFromManifest(p, man, spec.name);
    }
  }

  const specs = Array.isArray(spec.commands) && spec.commands.length
    ? spec.commands
    : [{ name: spec.name, path: spec.path, args: spec.args, dir: spec.dir, port: spec.port, stopCommand: spec.stopCommand }];

  const commands = [];
  for (let i = 0; i < specs.length; i++) {
    const r = resolveCommand(specs[i]);
    if (r.error) return { error: `Process ${i + 1}: ${r.error}` };
    commands.push(r.cmd);
  }
  const name =
    (spec.name || "").trim() ||
    commands[0].name ||
    path.basename(commands[0].dir || "app");
  const app = { id: newId(), name, commands };
  if (spec.category != null) app.category = String(spec.category).trim() || null;
  if (spec.autostart != null) app.autostart = !!spec.autostart;
  if (spec.update != null) app.update = String(spec.update).trim() || null;
  if (spec.rebuild != null) app.rebuild = String(spec.rebuild).trim() || null;
  return { app };
}

/* ------------------------------------------------- install from a git URL */

// Clone a repo into the apps folder and add it as an app: one paste, one app.

let gitAvailable = null;
function hasGit() {
  if (gitAvailable == null) {
    try {
      execSync("git --version", { stdio: "ignore" });
      gitAvailable = true;
    } catch {
      gitAvailable = false;
    }
  }
  return gitAvailable;
}

// Turn whatever was pasted into { url, name, branch }: the clone URL, the folder
// name to clone into, and a branch when the link points at one (.../tree/dev).
// Accepts full https links, git@host:owner/repo.git, and owner/repo shorthand.
function parseRepo(input) {
  const s = (input || "").trim().replace(/^"|"$/g, "").replace(/\/+$/, "");
  if (!s) return { error: "Paste a repository link." };
  let url, name, branch = null;
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) {
    url = `https://github.com/${s}.git`;
    name = s.split("/")[1];
  } else if (/^(git|ssh):\/\//i.test(s) || /^[\w.-]+@[\w.-]+:/.test(s)) {
    url = s;
    name = s.split(/[/:]/).pop();
  } else if (/^https?:\/\//i.test(s)) {
    let u;
    try {
      u = new URL(s);
    } catch {
      return { error: "That link isn't a valid URL." };
    }
    const seg = u.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    if (seg.length < 2) return { error: "That link doesn't point at a repository." };
    if (seg[2] === "tree" && seg.length > 3) branch = seg.slice(3).join("/");
    name = seg[1];
    url = `${u.origin}/${seg[0]}/${name.replace(/\.git$/, "")}.git`;
  } else {
    return { error: "That doesn't look like a repository link." };
  }
  name = name.replace(/\.git$/, "");
  if (!/^[\w.-]+$/.test(name) || name === "." || name === "..")
    return { error: "Couldn't work out a folder name from that link." };
  return { url, name, branch };
}

let installProc = null;
let installing = false;

// Clone, then (when the repo ships a rack.json) run its setup and build steps,
// then register the app. All output streams to the UI over SSE.
function installApp(body) {
  if (installing) return { ok: false, error: "An install is already running." };
  if (!settings.appsDir)
    return { ok: false, error: "Set an apps folder first (gear menu > Apps folder)." };
  if (!hasGit()) return { ok: false, error: "git isn't installed, or isn't on PATH." };

  const base = settings.appsDir;
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch (e) {
    return { ok: false, error: `Apps folder ${base} is missing and couldn't be created: ${e.message}` };
  }

  const repo = parseRepo(body.url);
  if (repo.error) return { ok: false, error: repo.error };

  const target = path.join(base, repo.name);
  const cloned = fs.existsSync(target) && fs.readdirSync(target).length > 0;
  if (cloned && !fs.existsSync(path.join(target, ".git")))
    return { ok: false, error: `${target} already exists and isn't a clone — rename or remove it first.` };
  if (apps.some((a) => a.commands.some((c) => c.dir === target)))
    return { ok: false, error: `${repo.name} is already added — it lives in ${target}.` };

  const emit = (stream, line) => broadcast({ type: "install-log", stream, line });
  let stepFailed = false; // a setup/build step that failed, but didn't stop the install
  const finish = (ok, extra) => {
    if (!installing) return;
    installing = false;
    installProc = null;
    broadcast({ type: "install-done", ok, ...extra });
  };

  // Last step: import the clone — its rack.json when it has one, otherwise the
  // same folder auto-detection the Add app dialog uses.
  const register = () => {
    const man = loadManifest(target);
    // Without a manifest to name the app, the repo folder name beats the .bat we
    // happened to find in it.
    const r = man
      ? buildFromManifest(target, man, body.name)
      : resolveApp({ name: (body.name || "").trim() || repo.name, path: target });
    if (r.error) {
      emit("err", `[install] cloned to ${target}, but couldn't add it: ${r.error}`);
      emit("err", "[install] add it by hand with + Add app, pointing at that folder.");
      return finish(false, { error: r.error, dir: target });
    }
    const app = r.app;
    if (!app.update) app.update = "git pull"; // it came from git — Update means pull
    if (body.category) app.category = String(body.category).trim() || null;
    if (body.autostart != null) app.autostart = !!body.autostart;
    apps.push(app);
    const portInfo = resolvePorts();
    broadcast({ type: "apps" });
    if (!man) emit("out", "[install] no rack.json in this repo — check the processes with Edit.");
    emit("out", `[install] added "${app.name}" — ${app.commands.length} process(es).`);
    finish(true, { app: stateOf(app), portInfo, warned: stepFailed });
  };

  // Only the clone is allowed to stop an install. A repo's own setup or build
  // script failing is worth shouting about, but the clone is already on disk, so
  // the app still gets added — fix the script and press ⟳ Update.
  const STEP_TIMEOUT = 10 * 60 * 1000;
  const runSteps = (list, i, done) => {
    if (i >= list.length) return done();
    const step = list[i];
    const skip = (why) => {
      emit("err", `[${step.tag}] ${why}`);
      if (!step.optional) return finish(false, { error: `${step.tag}: ${why}` });
      stepFailed = true;
      emit("out", `[${step.tag}] carrying on — the app is still added.`);
      runSteps(list, i + 1, done);
    };
    emit("out", `[${step.tag}] ${step.cmd}   (in ${step.cwd})`);
    let proc;
    try {
      // stdin is /dev/null on purpose: a setup script that ends in `pause`, or
      // asks a question, would otherwise wait forever on input nobody can type.
      proc = spawn(step.cmd, {
        cwd: step.cwd,
        windowsHide: true,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return skip(e.message);
    }
    installProc = proc;
    let done_ = false;
    const cap = setTimeout(() => {
      emit("err", `[${step.tag}] still running after 10 minutes — stopping it.`);
      killPid(proc.pid);
    }, STEP_TIMEOUT);
    // git reports clone progress on stderr, so a red line here isn't a failure —
    // only the exit code decides.
    const pump = (stream) => (d) =>
      d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => emit(stream, l));
    proc.stdout.on("data", pump("out"));
    proc.stderr.on("data", pump("err"));
    proc.on("error", (e) => {
      if (done_) return;
      done_ = true;
      clearTimeout(cap);
      installProc = null;
      skip(e.message);
    });
    proc.on("exit", (code) => {
      if (done_) return;
      done_ = true;
      clearTimeout(cap);
      installProc = null;
      if (code !== 0) return skip(`failed (exit code ${code}).`);
      runSteps(list, i + 1, done);
    });
  };

  // The manifest only exists once the clone lands, so the post-clone steps are
  // worked out after it.
  const afterClone = () => {
    const man = loadManifest(target) || {};
    const setup = man.setup ? (typeof man.setup === "string" ? man.setup : man.setup.command) : null;
    const post = [];
    if (setup) post.push({ tag: "setup", cmd: resolveStepCommand(setup, target), cwd: target, optional: true });
    // A fresh clone usually has to be built before it can run; rebuildStepFor()
    // takes the app's folder + rebuild setting, which is all we have so far.
    const rb = rebuildStepFor({
      commands: [{ dir: target }],
      rebuild: man.rebuild == null ? null : man.rebuild === false ? "off" : String(man.rebuild),
    });
    if (rb) post.push({ tag: "build", cmd: resolveStepCommand(rb.cmd, target), cwd: target, optional: true });
    runSteps(post, 0, register);
  };

  installing = true;
  const steps = [];
  if (cloned) {
    emit("out", `[install] ${target} is already cloned — importing it.`);
  } else {
    const branch = repo.branch ? `-b ${JSON.stringify(repo.branch)} ` : "";
    steps.push({
      tag: "clone",
      cmd: `git clone ${branch}--recurse-submodules "${repo.url}" "${target}"`,
      cwd: base,
    });
  }
  runSteps(steps, 0, afterClone);
  return { ok: true, dir: target };
}

/* ------------------------------------------------------------- HTTP server */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CONTROL_PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] === "api") {
    // GET /api/events (SSE)
    if (parts[1] === "events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // GET /api/apps
    if (parts[1] === "apps" && !parts[2] && req.method === "GET") {
      return sendJSON(res, 200, { apps: apps.map(stateOf), conflicts: conflicts() });
    }

    // POST /api/apps  {name, commands:[{path,args,dir,port}]}
    if (parts[1] === "apps" && !parts[2] && req.method === "POST") {
      const body = await readBody(req);
      const result = resolveApp(body);
      if (result.error) return sendJSON(res, 400, { error: result.error });
      apps.push(result.app);
      const portInfo = resolvePorts();
      if (result.app.update) checkUpdatesSoon();
      broadcast({ type: "apps" });
      return sendJSON(res, 200, { app: stateOf(result.app), portInfo });
    }

    // POST /api/apps/reorder  {order:[{id, category}]}  — sidebar drag & drop
    if (parts[1] === "apps" && parts[2] === "reorder" && req.method === "POST") {
      const body = await readBody(req);
      const wanted = Array.isArray(body.order) ? body.order : [];
      const byId = new Map(apps.map((a) => [a.id, a]));
      const seen = new Set();
      const next = [];
      for (const entry of wanted) {
        const a = entry && byId.get(entry.id);
        if (!a || seen.has(a.id)) continue;
        seen.add(a.id);
        if ("category" in entry) a.category = String(entry.category || "").trim() || null;
        next.push(a);
      }
      // an app the client didn't know about (added mid-drag) keeps its place at the end
      for (const a of apps) if (!seen.has(a.id)) next.push(a);
      apps = next;
      saveApps();
      broadcast({ type: "apps" });
      return sendJSON(res, 200, { apps: apps.map(stateOf) });
    }

    const app = apps.find((a) => a.id === parts[2]);
    if (parts[1] === "apps" && parts[2] && !app) {
      return sendJSON(res, 404, { error: "Unknown app" });
    }

    // PATCH /api/apps/:id  {name?, category?, autostart?, commands?}
    if (parts[1] === "apps" && parts[2] && !parts[3] && req.method === "PATCH") {
      const body = await readBody(req);
      if (typeof body.name === "string" && body.name.trim()) app.name = body.name.trim();
      if ("category" in body) app.category = (String(body.category || "").trim()) || null;
      if ("autostart" in body) app.autostart = !!body.autostart;
      if ("update" in body) {
        const next = String(body.update || "").trim() || null;
        if (next !== app.update) checkUpdatesSoon();
        app.update = next;
      }
      if ("rebuild" in body) app.rebuild = (String(body.rebuild || "").trim()) || null;
      if (Array.isArray(body.commands)) {
        const rebuilt = [];
        for (let i = 0; i < body.commands.length; i++) {
          const r = resolveCommand(body.commands[i]);
          if (r.error) return sendJSON(res, 400, { error: `Process ${i + 1}: ${r.error}` });
          rebuilt.push(r.cmd);
        }
        // The editor doesn't show Cloudflare bindings, so carry them across an
        // edit by position instead of silently unpublishing a process.
        rebuilt.forEach((c, i) => {
          if (app.commands[i] && app.commands[i].cloudflare) c.cloudflare = app.commands[i].cloudflare;
        });
        // stop anything running before we change the process list out from under it
        stopApp(app);
        app.commands = rebuilt;
        runtime.delete(app.id);
      }
      const portInfo = resolvePorts();
      broadcast({ type: "apps" });
      return sendJSON(res, 200, { app: stateOf(app), portInfo });
    }

    // DELETE /api/apps/:id
    if (parts[1] === "apps" && parts[2] && !parts[3] && req.method === "DELETE") {
      stopApp(app);
      apps = apps.filter((a) => a.id !== app.id);
      runtime.delete(app.id);
      saveApps();
      broadcast({ type: "apps" });
      return sendJSON(res, 200, { ok: true });
    }

    // POST /api/apps/:id/start | stop
    if (parts[1] === "apps" && parts[3] === "start" && req.method === "POST") {
      const r = startApp(app);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (parts[1] === "apps" && parts[3] === "stop" && req.method === "POST") {
      const r = stopApp(app);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }

    // POST /api/apps/:id/update  — run the app's update command (e.g. git pull)
    if (parts[1] === "apps" && parts[3] === "update" && req.method === "POST") {
      const r = updateApp(app);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }

    // POST /api/apps/:id/clear[?cmd=idx]  — clear one console or all of them
    if (parts[1] === "apps" && parts[3] === "clear" && req.method === "POST") {
      const slots = slotsFor(app);
      const cmd = url.searchParams.get("cmd");
      const targets = cmd != null ? [Number(cmd)] : slots.map((_, i) => i);
      for (const i of targets) if (slots[i]) { slots[i].log = []; slots[i].errCount = 0; }
      broadcast({ type: "clear", id: app.id, cmd: cmd != null ? Number(cmd) : null });
      return sendJSON(res, 200, { ok: true });
    }

    // GET /api/apps/:id/logs  → per-command logs
    if (parts[1] === "apps" && parts[3] === "logs" && req.method === "GET") {
      const slots = slotsFor(app);
      return sendJSON(res, 200, slots.map((s) => ({ log: s.log, errCount: s.errCount })));
    }

    // GET /api/stats  → CPU / memory per app and for the machine, with recent history
    if (parts[1] === "stats" && req.method === "GET") {
      return sendJSON(res, 200, statsPayload());
    }

    // GET /api/funnel  → live Tailscale funnel state   POST /api/funnel {publicPort, localPort, enable}
    if (parts[1] === "funnel" && req.method === "GET") {
      return sendJSON(res, 200, await funnelState());
    }
    if (parts[1] === "funnel" && req.method === "POST") {
      const r = await setFunnel(await readBody(req));
      if (!r.ok) return sendJSON(res, 400, r);
      broadcast({ type: "funnel" });
      return sendJSON(res, 200, await funnelState());
    }

    // GET /api/exposure[?rescan=1]  → every listening port on this machine, the
    // program behind it and how far it reaches, plus every way it can be exposed
    if (parts[1] === "exposure" && req.method === "GET") {
      return sendJSON(res, 200, await exposureState(url.searchParams.get("rescan") === "1"));
    }

    // GET /api/cf  → cloudflared availability, named tunnels, live tunnels
    if (parts[1] === "cf" && !parts[2] && req.method === "GET") {
      return sendJSON(res, 200, await cfState());
    }

    // POST /api/cf  {appId, cmdIndex, tunnel|null, hostname?, auto?, connect?}
    //   Binds a process to a named tunnel (or unbinds it with tunnel:null).
    if (parts[1] === "cf" && !parts[2] && req.method === "POST") {
      const body = await readBody(req);
      const r = setTunnelBinding(body);
      if (!r.ok) return sendJSON(res, 400, r);
      broadcast({ type: "cf" });
      return sendJSON(res, 200, await cfState());
    }

    // POST /api/cf/connect  {appId, cmdIndex, enable}  — bring one tunnel up/down now
    if (parts[1] === "cf" && parts[2] === "connect" && req.method === "POST") {
      const { appId, cmdIndex, enable } = await readBody(req);
      const target = apps.find((a) => a.id === appId);
      if (!target) return sendJSON(res, 404, { error: "Unknown app" });
      const r = enable ? connectTunnel(target, Number(cmdIndex)) : stopTunnel(appId, Number(cmdIndex));
      if (!r.ok) return sendJSON(res, 400, r);
      return sendJSON(res, 200, await cfState());
    }

    // POST /api/cf/setup  {step: "install"|"login"}  — run a prerequisite command
    if (parts[1] === "cf" && parts[2] === "setup" && !parts[3] && req.method === "POST") {
      const r = runCfSetup(await readBody(req));
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (parts[1] === "cf" && parts[2] === "setup" && parts[3] === "cancel" && req.method === "POST") {
      const r = cancelCfSetup();
      return sendJSON(res, r.ok ? 200 : 400, r);
    }

    // POST /api/cf/create  {name, hostname}  — create the tunnel + its DNS route
    if (parts[1] === "cf" && parts[2] === "create" && req.method === "POST") {
      const r = createTunnel(await readBody(req));
      return sendJSON(res, r.ok ? 200 : 400, r);
    }

    // GET /api/cf/log?app=&cmd=  → recent cloudflared output for one tunnel
    if (parts[1] === "cf" && parts[2] === "log" && req.method === "GET") {
      const t = tunnels.get(tKey(url.searchParams.get("app"), url.searchParams.get("cmd")));
      return sendJSON(res, 200, { log: t ? t.log : [] });
    }

    // GET /api/settings  → controller-wide settings   POST /api/settings {appsDir}
    if (parts[1] === "settings" && req.method === "GET") {
      return sendJSON(res, 200, { appsDir: settings.appsDir, git: hasGit() });
    }
    if (parts[1] === "settings" && req.method === "POST") {
      const body = await readBody(req);
      const r = "appsDir" in body ? setAppsDir(body.appsDir) : { ok: true };
      if (!r.ok) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, { appsDir: settings.appsDir, git: hasGit() });
    }

    // POST /api/install  {url, name?, category?, autostart?}
    //   Clone a repo into the apps folder and add it as an app.
    if (parts[1] === "install" && req.method === "POST") {
      const r = installApp(await readBody(req));
      return sendJSON(res, r.ok ? 200 : 400, r);
    }

    // GET /api/sdk-prompt  → the copy-paste prompt for AI coding tools
    if (parts[1] === "sdk-prompt" && req.method === "GET") {
      let text = "";
      try {
        text = fs.readFileSync(path.join(ROOT, "SDK-PROMPT.md"), "utf8");
      } catch {}
      return sendJSON(res, 200, { text });
    }

    // GET /api/changelog  → raw CHANGELOG.md text
    if (parts[1] === "changelog" && req.method === "GET") {
      let text = "";
      try {
        text = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
      } catch {}
      return sendJSON(res, 200, { text });
    }

    // GET /api/version  → version + whether one-click self-update is available
    if (parts[1] === "version" && req.method === "GET") {
      return sendJSON(res, 200, { version: VERSION, supervised: SUPERVISED });
    }

    // GET /api/updates  → last known "is there anything new?" for Rack + apps
    if (parts[1] === "updates" && !parts[2] && req.method === "GET") {
      return sendJSON(res, 200, updatesPayload());
    }

    // POST /api/updates/check  — ask every remote now (git fetch), then report
    if (parts[1] === "updates" && parts[2] === "check" && req.method === "POST") {
      await checkUpdates();
      return sendJSON(res, 200, updatesPayload());
    }

    // POST /api/self-update  — git pull Rack itself and restart if changed
    if (parts[1] === "self-update" && req.method === "POST") {
      const r = selfUpdate();
      return sendJSON(res, r.ok ? 200 : 400, r);
    }

    // GET /api/boot  → is "run on boot" installed?   POST /api/boot {enable}
    if (parts[1] === "boot" && req.method === "GET") {
      return sendJSON(res, 200, { enabled: fs.existsSync(startupShortcutPath()) });
    }
    if (parts[1] === "boot" && req.method === "POST") {
      const { enable } = await readBody(req);
      try {
        await setRunOnBoot(!!enable);
        return sendJSON(res, 200, { enabled: !!enable });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message });
      }
    }

    return sendJSON(res, 404, { error: "Not found" });
  }

  // static files
  let file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  file = path.normalize(file);
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
});

/* ------------------------------------------------------- tailscale funnel */

// Funnel can only listen publicly on these three ports (Tailscale limitation).
const FUNNEL_PORTS = [443, 8443, 10000];

let TS_BIN;
function ts() {
  if (TS_BIN !== undefined) return TS_BIN;
  const candidates =
    process.platform === "win32"
      ? ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"]
      : [
          "tailscale",
          "/usr/bin/tailscale",
          "/usr/local/bin/tailscale",
          "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ];
  TS_BIN = null;
  for (const c of candidates) {
    try {
      execSync(`"${c}" version`, { stdio: "ignore", timeout: 5000 });
      TS_BIN = c;
      break;
    } catch {}
  }
  return TS_BIN;
}

function tsExec(args) {
  return new Promise((resolve) => {
    const bin = ts();
    if (!bin) return resolve({ ok: false, out: "", err: "Tailscale not found" });
    exec(`"${bin}" ${args}`, { timeout: 20000 }, (err, stdout, stderr) =>
      resolve({
        ok: !err,
        out: (stdout || "").trim(),
        err: (stderr || "").trim() || (err ? err.message : ""),
      })
    );
  });
}

function publicUrl(dnsName, pub, p) {
  const base = pub === 443 ? `https://${dnsName}` : `https://${dnsName}:${pub}`;
  return base + (p && p !== "/" ? p : "/");
}

// Live state straight from Tailscale — it owns the serve/funnel config, not us.
async function funnelState() {
  if (!ts()) return { available: false, reason: "Tailscale isn't installed on this machine." };

  const st = await tsExec("status --json");
  let dnsName = "";
  try {
    const j = JSON.parse(st.out);
    dnsName = ((j.Self && j.Self.DNSName) || "").replace(/\.$/, "");
  } catch {}
  if (!dnsName)
    return { available: false, reason: "Tailscale is installed but not logged in yet." };

  const sc = await tsExec("funnel status --json");
  let cfg = null;
  try {
    cfg = JSON.parse(sc.out);
  } catch {}

  const active = [];
  if (cfg && cfg.Web) {
    for (const [hostPort, web] of Object.entries(cfg.Web)) {
      const pub = Number(hostPort.split(":").pop());
      const isFunnel = !!(cfg.AllowFunnel && cfg.AllowFunnel[hostPort]);
      for (const [p, h] of Object.entries(web.Handlers || {})) {
        const m = /:(\d+)\s*$/.exec(h.Proxy || "");
        active.push({
          publicPort: pub,
          path: p,
          localPort: m ? Number(m[1]) : null,
          isFunnel, // false = tailnet-only `serve`, true = public `funnel`
          url: publicUrl(dnsName, pub, p),
        });
      }
    }
  }
  return { available: true, dnsName, ports: FUNNEL_PORTS, active };
}

// mode "serve" shares on the tailnet only; the default "funnel" is public.
// Funnel is limited to three ports by Tailscale; serve is not.
// `replace` clears whatever the public port pointed at first, so it can be
// re-pointed at a different local port in one go.
async function setFunnel({ publicPort, localPort, enable, mode, replace }) {
  const pub = Number(publicPort);
  const verb = mode === "serve" ? "serve" : "funnel";
  if (!Number.isInteger(pub) || pub < 1 || pub > 65535)
    return { ok: false, error: "That public port is not a valid port number." };
  if (verb === "funnel" && !FUNNEL_PORTS.includes(pub))
    return { ok: false, error: `Funnel only allows public ports ${FUNNEL_PORTS.join(", ")}.` };
  if (enable) {
    const local = Number(localPort);
    if (!Number.isInteger(local) || local < 1 || local > 65535)
      return { ok: false, error: "That isn't a port that can be exposed." };
    if (replace) await tsExec(`serve --https=${pub} off`);
    const r = await tsExec(`${verb} --bg --https=${pub} localhost:${local}`);
    if (!r.ok) return { ok: false, error: r.err || `Failed to enable ${verb}.` };
  } else {
    // `serve off` drops the funnel with it; `funnel off` leaves the tailnet
    // share standing, which is what the "make tailnet-only" button wants.
    const r = await tsExec(`${verb} --https=${pub} off`);
    if (!r.ok) return { ok: false, error: r.err || `Failed to turn the ${verb} off.` };
  }
  return { ok: true };
}

/* ------------------------------------------------------ cloudflare tunnel */

// Tailscale's daemon owns funnel state, so above we just shell out and read it
// back. Cloudflare has no such daemon: `cloudflared` is a plain child process
// per tunnel, so Rack spawns it, scrapes its status, and owns its lifetime —
// which is why a tunnel is always torn down with the process it publishes.
//
// Only *named* tunnels are supported: they need a Cloudflare account, a domain,
// and a one-time `cloudflared tunnel login`, but give a stable hostname. The
// login is a browser flow writing credentials to ~/.cloudflared — Rack points
// you at it and never automates it.

const CF_MAX_LOG = 200;
const CF_INSTALL =
  process.platform === "win32"
    ? "winget install --id Cloudflare.cloudflared"
    : process.platform === "darwin"
    ? "brew install cloudflared"
    : "See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";

let CF_BIN;
let CF_PROBED = 0;
function cf() {
  // Unlike the Tailscale probe this doesn't cache a miss for the whole session:
  // installing cloudflared is step one of the setup flow, so "not found" has to
  // be able to become "found" without restarting Rack.
  if (CF_BIN || (CF_BIN === null && Date.now() - CF_PROBED < 30000)) return CF_BIN;
  const winget =
    process.env.LOCALAPPDATA &&
    path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "cloudflared.exe");
  const candidates =
    process.platform === "win32"
      ? [
          "cloudflared",
          "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
          "C:\\Program Files\\cloudflared\\cloudflared.exe",
          winget,
        ].filter(Boolean)
      : [
          "cloudflared",
          "/usr/local/bin/cloudflared",
          "/opt/homebrew/bin/cloudflared",
          "/usr/bin/cloudflared",
        ];
  CF_BIN = null;
  CF_PROBED = Date.now();
  for (const c of candidates) {
    try {
      execSync(`"${c}" --version`, { stdio: "ignore", timeout: 5000 });
      CF_BIN = c;
      break;
    } catch {}
  }
  return CF_BIN;
}

// Forget a cached probe result — call after anything that could have installed
// cloudflared or written its credentials.
function cfResetProbe() {
  CF_BIN = undefined;
  CF_PROBED = 0;
  cfListCache = { at: 0, list: [] };
}

function cfExec(args) {
  return new Promise((resolve) => {
    const bin = cf();
    if (!bin) return resolve({ ok: false, out: "", err: "cloudflared not found" });
    exec(`"${bin}" ${args}`, { timeout: 25000 }, (err, stdout, stderr) =>
      resolve({
        ok: !err,
        out: (stdout || "").trim(),
        err: (stderr || "").trim() || (err ? err.message : ""),
      })
    );
  });
}

// `tunnel login` writes cert.pem here — its presence is what makes named
// tunnels usable at all.
function cfLoggedIn() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || ROOT;
    return fs.existsSync(path.join(home, ".cloudflared", "cert.pem"));
  } catch {
    return false;
  }
}

// Normalize a binding from apps.json or a manifest into { tunnel, hostname, auto }.
function cfBinding(v) {
  if (!v || !v.tunnel) return null;
  return {
    tunnel: String(v.tunnel).trim(),
    hostname: (v.hostname && String(v.hostname).trim()) || null,
    auto: !!v.auto,
  };
}

let cfListCache = { at: 0, list: [] };
async function cfTunnels(force) {
  if (!force && Date.now() - cfListCache.at < 15000) return cfListCache.list;
  const r = await cfExec("tunnel list --output json");
  let list = [];
  try {
    const j = JSON.parse(r.out);
    if (Array.isArray(j))
      list = j
        .filter((t) => t && t.name && !t.deleted_at)
        .map((t) => ({
          id: t.id,
          name: t.name,
          connections: Array.isArray(t.connections) ? t.connections.length : 0,
        }));
  } catch {}
  cfListCache = { at: Date.now(), list };
  return list;
}

// "appId:cmdIndex" -> { proc, pid, name, hostname, status, error, log[] }
const tunnels = new Map();
const tKey = (appId, idx) => `${appId}:${idx}`;

function tunnelPush(t, stream, line) {
  t.log.push({ s: stream, line });
  if (t.log.length > CF_MAX_LOG) t.log.shift();
}

function startTunnel(app, idx) {
  const cmd = app.commands[idx];
  const bind = cmd && cmd.cloudflare;
  if (!bind || !bind.tunnel) return { ok: false, error: "No Cloudflare tunnel is set for this process." };
  if (!cf()) return { ok: false, error: "cloudflared isn't installed on this machine." };

  const key = tKey(app.id, idx);
  const existing = tunnels.get(key);
  if (existing && existing.proc) return { ok: true };

  const slot = slotsFor(app)[idx];
  if (!slot || !slot.proc)
    return { ok: false, error: "Start the process first — a tunnel can't outlive it." };
  const port = slot.effPort || cmd.port;
  if (!port) return { ok: false, error: "That process has no port to publish." };

  const t = {
    proc: null,
    pid: null,
    name: bind.tunnel,
    hostname: bind.hostname || null,
    status: "connecting",
    error: null,
    log: [],
  };
  tunnels.set(key, t);

  // --url overrides the tunnel's ingress, so one named tunnel maps to exactly
  // one local port and no config.yml is needed.
  const args = ["tunnel", "--no-autoupdate", "run", "--url", `http://localhost:${port}`, bind.tunnel];
  let proc;
  try {
    proc = spawn(cf(), args, { cwd: ROOT, windowsHide: true });
  } catch (e) {
    t.status = "failed";
    t.error = e.message;
    broadcast({ type: "cf" });
    return { ok: false, error: e.message };
  }
  t.proc = proc;
  t.pid = proc.pid;
  tunnelPush(t, "out", `[rack] cloudflared ${args.join(" ")}`);

  const pump = (stream) => (d) => {
    let changed = false;
    for (const line of d.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      tunnelPush(t, stream, line);
      if (t.status !== "public" && /Registered tunnel connection|Connection [\w-]+ registered/i.test(line)) {
        t.status = "public";
        t.error = null;
        changed = true;
      }
      if (/\bERR\b|failed to|Cannot determine default/i.test(line) && !t.error) {
        t.error = line.slice(-240);
      }
    }
    if (changed) broadcast({ type: "cf" });
  };
  proc.stdout.on("data", pump("out"));
  proc.stderr.on("data", pump("err")); // cloudflared logs everything to stderr
  proc.on("error", (e) => {
    t.status = "failed";
    t.error = e.message;
    tunnelPush(t, "err", e.message);
    broadcast({ type: "cf" });
  });
  proc.on("exit", (code) => {
    if (tunnels.get(key) !== t) return; // superseded by a newer tunnel
    t.proc = null;
    if (t.stopping) {
      tunnels.delete(key); // clean stop — drop back to "bound but off"
    } else {
      t.status = "failed";
      if (!t.error) t.error = `cloudflared exited (code ${code})`;
    }
    broadcast({ type: "cf" });
  });

  broadcast({ type: "cf" });
  return { ok: true };
}

// Killing is asynchronous (taskkill), so a re-point has to wait for the old
// cloudflared to actually be gone — spawning over it would double-register the
// tunnel and split traffic between the two.
function connectTunnel(app, idx, tries = 0) {
  const t = tunnels.get(tKey(app.id, idx));
  if (t && t.proc) {
    if (tries > 40) return { ok: false, error: "The previous tunnel hasn't stopped." };
    setTimeout(() => connectTunnel(app, idx, tries + 1), 250);
    return { ok: true };
  }
  return startTunnel(app, idx);
}

function stopTunnel(appId, idx) {
  const key = tKey(appId, idx);
  const t = tunnels.get(key);
  if (!t) return { ok: true };
  if (t.proc) {
    t.stopping = true;
    t.status = "off";
    killPid(t.pid);
  } else {
    tunnels.delete(key);
  }
  broadcast({ type: "cf" });
  return { ok: true };
}

async function cfState() {
  if (!cf())
    return {
      available: false,
      reason: "cloudflared isn't installed on this machine.",
      install: CF_INSTALL,
      loggedIn: false,
      tunnels: [],
      active: [],
    };
  const loggedIn = cfLoggedIn();
  const named = loggedIn ? await cfTunnels() : [];
  const active = [];
  for (const [key, t] of tunnels) {
    const [appId, idx] = key.split(":");
    active.push({
      appId,
      cmdIndex: Number(idx),
      name: t.name,
      hostname: t.hostname,
      status: t.status,
      url: t.hostname ? `https://${t.hostname}` : null,
      error: t.error || null,
    });
  }
  return { available: true, loggedIn, install: CF_INSTALL, tunnels: named, active };
}

function setTunnelBinding({ appId, cmdIndex, tunnel, hostname, auto, connect }) {
  const app = apps.find((a) => a.id === appId);
  if (!app) return { ok: false, error: "Unknown app." };
  const idx = Number(cmdIndex);
  const cmd = app.commands[idx];
  if (!cmd) return { ok: false, error: "Unknown process." };

  if (!tunnel) {
    stopTunnel(appId, idx);
    cmd.cloudflare = null;
    saveApps();
    broadcast({ type: "apps" });
    return { ok: true };
  }

  // Running one named tunnel twice makes Cloudflare load-balance between the
  // two, which reads as random flakiness — so a tunnel belongs to one process.
  for (const a of apps)
    for (let i = 0; i < a.commands.length; i++) {
      const b = a.commands[i].cloudflare;
      if (b && b.tunnel === tunnel && !(a.id === appId && i === idx))
        return {
          ok: false,
          error: `Tunnel "${tunnel}" is already used by ${a.name} / ${a.commands[i].name}.`,
        };
    }

  const prev = cmd.cloudflare;
  cmd.cloudflare = cfBinding({
    tunnel,
    hostname: (hostname || "").trim() || (prev && prev.hostname) || null,
    auto: auto == null ? !!(prev && prev.auto) : !!auto,
  });
  saveApps();

  const live = tunnels.get(tKey(appId, idx));
  const rebind = live && (live.name !== tunnel || live.hostname !== cmd.cloudflare.hostname);
  if (rebind) stopTunnel(appId, idx);
  if (connect !== false && slotsFor(app)[idx] && slotsFor(app)[idx].proc) connectTunnel(app, idx);

  broadcast({ type: "apps" });
  return { ok: true };
}

/* ---- one-click setup: run the two prerequisite commands from the dialog ---- */

// Both are one-off, machine-wide, and interactive in ways Rack can't answer for
// you: the install can raise a UAC prompt, and the login blocks on a browser
// round-trip. So they run as supervised children with their output streamed —
// Rack shows you what's happening rather than pretending it didn't.

const CF_SETUP_TIMEOUT = 10 * 60 * 1000;
let cfSetupProc = null;

function cfSetupCommand(step) {
  if (step === "login") {
    const bin = cf();
    if (!bin) return { error: "Install cloudflared first." };
    return { line: `"${bin}" tunnel login`, label: "cloudflared tunnel login" };
  }
  if (step === "install") {
    if (cf()) return { error: "cloudflared is already installed." };
    if (process.platform === "win32")
      return {
        // Accept the agreements up front: a prompt on stdin would just hang,
        // since nothing is attached to answer it.
        line: "winget install --id Cloudflare.cloudflared --accept-package-agreements --accept-source-agreements",
        label: CF_INSTALL,
      };
    if (process.platform === "darwin")
      return { line: "brew install cloudflared", label: CF_INSTALL };
    return { error: "One-click install is Windows/macOS only — install cloudflared by hand." };
  }
  return { error: "Unknown setup step." };
}

function runCfSetup({ step }) {
  if (cfSetupProc) return { ok: false, error: "A setup step is already running." };
  const c = cfSetupCommand(step);
  if (c.error) return { ok: false, error: c.error };

  const emit = (stream, line) => broadcast({ type: "cf-setup-log", step, stream, line });
  let proc;
  try {
    proc = spawn(c.line, { cwd: ROOT, windowsHide: true, shell: true });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  cfSetupProc = proc;

  emit("out", `[setup] ${c.label}`);
  if (step === "install")
    emit("out", "[setup] if Windows asks permission to install, approve the prompt.");
  else
    emit("out", "[setup] a browser will open — pick the domain you want to use, then come back here.");

  const pump = (s) => (d) =>
    d.toString().split(/\r?\n/).filter((l) => l.trim()).forEach((l) => emit(s, l));
  proc.stdout.on("data", pump("out"));
  proc.stderr.on("data", pump("err"));

  // The login waits on a human finishing a browser flow, so it can hang forever.
  const timer = setTimeout(() => {
    if (cfSetupProc === proc) {
      emit("err", "[setup] gave up after 10 minutes — stopping.");
      killPid(proc.pid);
    }
  }, CF_SETUP_TIMEOUT);

  let finished = false;
  const finish = (ok, msg) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (cfSetupProc === proc) cfSetupProc = null;
    cfResetProbe(); // the whole point of the step was to change what's on disk
    emit(ok ? "out" : "err", msg);
    broadcast({ type: "cf-setup-done", step, ok });
    broadcast({ type: "cf" });
  };
  proc.on("error", (e) => finish(false, `[setup] ${e.message}`));
  proc.on("exit", (code) =>
    finish(code === 0, code === 0 ? "[setup] done." : `[setup] exited with code ${code}.`)
  );
  return { ok: true };
}

function cancelCfSetup() {
  if (!cfSetupProc) return { ok: false, error: "Nothing is running." };
  killPid(cfSetupProc.pid);
  return { ok: true };
}

// Create the named tunnel (if it doesn't exist yet) and point a hostname at it.
// Streams to the UI the same way an app update does.
let cfCreating = false;
function createTunnel({ name, hostname }) {
  name = (name || "").trim();
  hostname = (hostname || "").trim().toLowerCase();
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(name))
    return { ok: false, error: "Pick a tunnel name (letters, numbers, dots, - and _)." };
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(hostname))
    return { ok: false, error: "Enter the full hostname, e.g. app.example.com." };
  if (!cf()) return { ok: false, error: "cloudflared isn't installed on this machine." };
  if (!cfLoggedIn()) return { ok: false, error: "Run `cloudflared tunnel login` first." };
  if (cfCreating) return { ok: false, error: "A tunnel is already being set up." };

  cfCreating = true;
  const emit = (stream, line) => broadcast({ type: "cf-log", stream, line });

  (async () => {
    const exists = (await cfTunnels(true)).some((t) => t.name === name);
    const steps = [];
    if (exists) emit("out", `[cloudflare] tunnel "${name}" already exists — reusing it.`);
    else steps.push({ label: `tunnel create ${name}`, args: ["tunnel", "create", name] });
    steps.push({
      label: `tunnel route dns ${name} ${hostname}`,
      args: ["tunnel", "route", "dns", name, hostname],
      soft: true, // an existing record pointing here is fine
    });

    let finished = false;
    const done = (ok, error) => {
      if (finished) return;
      finished = true;
      cfCreating = false;
      cfListCache.at = 0;
      broadcast({ type: "cf-done", ok, error: error || null, name, hostname });
      broadcast({ type: "cf" });
    };

    const run = (i) => {
      const step = steps[i];
      if (!step) return done(true);
      emit("out", `[cloudflare] ${step.label}`);
      let p;
      try {
        p = spawn(cf(), step.args, { cwd: ROOT, windowsHide: true });
      } catch (e) {
        emit("err", e.message);
        return done(false, e.message);
      }
      let last = "";
      const pump = (s) => (d) =>
        d
          .toString()
          .split(/\r?\n/)
          .filter(Boolean)
          .forEach((l) => {
            last = l;
            emit(s, l);
          });
      p.stdout.on("data", pump("out"));
      p.stderr.on("data", pump("err"));
      p.on("error", (e) => {
        emit("err", e.message);
        done(false, e.message);
      });
      p.on("exit", (code) => {
        if (finished) return;
        if (code === 0) return run(i + 1);
        if (step.soft && /already exists|1003/i.test(last)) {
          emit("out", "[cloudflare] that DNS record already exists — reusing it.");
          return run(i + 1);
        }
        emit("err", `[cloudflare] failed (exit code ${code}).`);
        done(false, last || `Step failed with exit code ${code}.`);
      });
    };
    run(0);
  })().catch((e) => {
    cfCreating = false;
    broadcast({ type: "cf-done", ok: false, error: e.message });
  });

  return { ok: true };
}

/* ------------------------------------------------- machine-wide exposure */

// Rack knows the ports of the apps it runs. This section covers the rest of the
// machine: every listening port with the program behind it, so a funnel on 8443
// can be read as "that's Immich" rather than "that's localhost:2283".

const EXPOSURE_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$procs = @{}
foreach ($p in (Get-CimInstance Win32_Process)) {
  $procs[[int]$p.ProcessId] = @{ name = $p.Name; path = $p.ExecutablePath; command = $p.CommandLine }
}
$rows = New-Object System.Collections.ArrayList
function Add-Row($proto, $addr, $port, $owner) {
  $i = $null
  if ($owner -ne $null) { $i = $procs[[int]$owner] }
  [void]$rows.Add([pscustomobject]@{
    proto = $proto; address = [string]$addr; port = [int]$port
    owner = $(if ($owner -ne $null) { [int]$owner } else { $null })
    process = $(if ($i) { $i.name } else { $null })
    path = $(if ($i) { $i.path } else { $null })
    command = $(if ($i) { $i.command } else { $null })
  })
}
foreach ($c in (Get-NetTCPConnection -State Listen)) { Add-Row 'tcp' $c.LocalAddress $c.LocalPort $c.OwningProcess }
foreach ($c in (Get-NetUDPEndpoint)) { Add-Row 'udp' $c.LocalAddress $c.LocalPort $c.OwningProcess }
$elevated = $false
try {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $elevated = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
[pscustomobject]@{ rows = $rows; elevated = $elevated } | ConvertTo-Json -Depth 5 -Compress
`;

// Piping the script through stdin keeps it out of the command line, so none of
// it has to survive cmd.exe quoting.
function psJson(script) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", "-"], { windowsHide: true });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null); }, 40000);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => { clearTimeout(timer); finish(null); });
    child.on("close", () => {
      clearTimeout(timer);
      try { finish(JSON.parse(out.trim())); } catch { finish(null); }
    });
    child.stdin.end(script);
  });
}

function shellLines(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve(String(stdout || "").split("\n"))
    );
  });
}

function hostPort(token) {
  const m = /^(.*):(\d+)$/.exec(token || "");
  if (!m) return null;
  const host = m[1].replace(/^\[|\]$/g, "");
  return { host: host === "*" ? "0.0.0.0" : host, port: Number(m[2]) };
}

// One row per listening socket: { proto, address, port, pid, process, path, command }.
async function scanListeners() {
  if (process.platform === "win32") {
    const data = await psJson(EXPOSURE_PS);
    if (!data) return { rows: [], elevated: null, error: "Windows would not list the open ports." };
    const raw = Array.isArray(data.rows) ? data.rows : data.rows ? [data.rows] : [];
    return {
      elevated: data.elevated === true,
      rows: raw
        .filter((r) => r && Number(r.port) > 0)
        .map((r) => ({
          proto: r.proto,
          address: String(r.address || ""),
          port: Number(r.port),
          pid: r.owner == null ? null : Number(r.owner),
          process: r.process || null,
          path: r.path || null,
          command: r.command || null,
        })),
    };
  }

  // Linux/macOS: ss where it exists, lsof otherwise.
  const rows = [];
  const ssLines = await shellLines("ss -lntupH");
  if (ssLines.some((l) => l.trim())) {
    for (const line of ssLines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      const hp = hostPort(parts[4]);
      if (!hp) continue;
      const who = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
      rows.push({
        proto: parts[0].toLowerCase().startsWith("u") ? "udp" : "tcp",
        address: hp.host,
        port: hp.port,
        pid: who ? Number(who[2]) : null,
        process: who ? who[1] : null,
        path: null,
        command: null,
      });
    }
  } else {
    for (const [proto, flag] of [["tcp", "-iTCP -sTCP:LISTEN"], ["udp", "-iUDP"]]) {
      const lines = await shellLines(`lsof -nP ${flag}`);
      for (const line of lines.slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 9) continue;
        const hp = parts.slice(8).map(hostPort).filter(Boolean).pop();
        if (!hp) continue;
        rows.push({ proto, address: hp.host, port: hp.port, pid: Number(parts[1]) || null, process: parts[0], path: null, command: null });
      }
    }
  }
  for (const row of rows) {
    if (!row.pid || row.command) continue;
    try {
      row.command = fs.readFileSync(`/proc/${row.pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      row.path = fs.readlinkSync(`/proc/${row.pid}/exe`);
    } catch {}
  }
  return { rows, elevated: null };
}

// Every Rack process that has a port — what the manager can expose by name.
function rackTargets() {
  const out = [];
  for (const app of apps) {
    const slots = slotsFor(app);
    app.commands.forEach((cmd, i) => {
      const slot = slots[i];
      const running = !!(slot && slot.proc);
      const port = (running && slot.effPort) || cmd.port;
      if (!port) return;
      out.push({
        appId: app.id,
        appName: app.name,
        procName: cmd.name,
        cmdIndex: i,
        port: Number(port),
        running,
        cloudflare: cmd.cloudflare || null,
      });
    });
  }
  return out;
}

// port -> the Rack app and process sitting on it. Two apps can declare the same
// port; the one actually running wins.
function rackPortOwners(targets = rackTargets()) {
  const byPort = new Map();
  for (const t of targets) {
    const prev = byPort.get(t.port);
    if (prev && prev.running && !t.running) continue;
    byPort.set(t.port, { appId: t.appId, appName: t.appName, procName: t.procName, cmdIndex: t.cmdIndex, running: t.running });
  }
  return byPort;
}

const OTHER_TUNNELS = [
  { id: "cloudflared", label: "Cloudflare Tunnel", re: /cloudflared/i },
  { id: "ngrok", label: "ngrok", re: /\bngrok\b/i },
  { id: "frp", label: "frp", re: /\bfrpc\b/i },
];

// Tunnel daemons Rack did not start — someone's stray run-tunnel.bat.
function foreignTunnels(rows, rackPids) {
  const found = new Map();
  for (const row of rows) {
    const text = [row.process, row.path, row.command].filter(Boolean).join(" ");
    const hit = text && OTHER_TUNNELS.find((t) => t.re.test(text));
    if (!hit || rackPids.has(row.pid)) continue;
    const key = `${hit.id}:${row.pid}`;
    if (found.has(key)) continue;
    const url = /--url[= ]\s*(\S+)/i.exec(row.command || "");
    const target = url ? hostPort(url[1].replace(/^https?:\/\//, "").replace(/\/+$/, "")) : null;
    found.set(key, {
      label: hit.label,
      pid: row.pid,
      command: row.command || row.process,
      targetPort: target ? target.port : null,
      url: url ? url[1] : null,
    });
  }
  return [...found.values()];
}

const isLoopback = (addr) => addr === "::1" || /^127\./.test(addr || "");

// The port scan shells out to PowerShell and takes a few seconds, so it is
// cached: exposing or stopping something doesn't change what's listening, and
// the manager re-reads after every action. Opening it and Refresh rescan.
let scanCache = { at: 0, promise: null, pending: false };
function cachedScan(rescan) {
  const stale = !scanCache.promise || Date.now() - scanCache.at > 120000;
  if ((rescan || stale) && !scanCache.pending) {
    const promise = scanListeners();
    scanCache = { at: Date.now(), promise, pending: true };
    promise.finally(() => {
      if (scanCache.promise === promise) scanCache.pending = false;
    });
  }
  return scanCache.promise;
}

async function exposureState(rescan) {
  const [scan, funnel, cfs] = await Promise.all([cachedScan(rescan), funnelState(), cfState()]);
  const targets = rackTargets();
  const owners = rackPortOwners(targets);
  const shares = funnel.available ? funnel.active : [];

  const rackTunnels = [];
  const rackPids = new Set();
  for (const [key, t] of tunnels) {
    const [appId, idx] = key.split(":");
    const app = apps.find((a) => a.id === appId);
    const slot = app ? slotsFor(app)[Number(idx)] : null;
    if (t.pid) rackPids.add(t.pid);
    rackTunnels.push({
      label: "Cloudflare Tunnel",
      name: t.name,
      appName: app ? app.name : appId,
      procName: app && app.commands[idx] ? app.commands[idx].name : null,
      hostname: t.hostname,
      url: t.hostname ? `https://${t.hostname}` : null,
      status: t.status,
      targetPort: slot ? slot.effPort : null,
      managed: true,
    });
  }

  const foreign = foreignTunnels(scan.rows, rackPids);
  const tunnelPorts = new Map();
  for (const t of [...rackTunnels, ...foreign]) {
    if (!t.targetPort) continue;
    tunnelPorts.set(t.targetPort, [...(tunnelPorts.get(t.targetPort) || []), t]);
  }

  // Collapse the dual 0.0.0.0 / :: bind of one service into a single row.
  const merged = new Map();
  for (const row of scan.rows) {
    const key = `${row.proto}:${row.port}:${row.pid ?? row.process ?? ""}`;
    const existing = merged.get(key);
    if (existing) {
      if (!existing.addresses.includes(row.address)) existing.addresses.push(row.address);
      existing.loopbackOnly = existing.loopbackOnly && isLoopback(row.address);
      continue;
    }
    merged.set(key, { ...row, addresses: [row.address], loopbackOnly: isLoopback(row.address) });
  }

  const listeners = [...merged.values()]
    .map((row) => {
      const onPort = shares.filter((sh) => sh.localPort === row.port);
      const viaTunnel = tunnelPorts.get(row.port) || [];
      const isPublic = onPort.some((sh) => sh.isFunnel) || viaTunnel.length > 0;
      return {
        ...row,
        owner: owners.get(row.port) || null,
        shares: onPort,
        tunnels: viaTunnel,
        reach: isPublic ? "public" : onPort.length ? "tailnet" : row.loopbackOnly ? "local" : "lan",
      };
    })
    .sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));

  // What is actually behind a local port: the Rack app if Rack runs it, and the
  // program the scan found listening there. `listening: false` on a port that is
  // being published means the share points at nothing.
  const whoOn = (port, owner) => {
    if (!port) return null;
    const l = listeners.find((r) => r.port === port && r.proto === "tcp");
    return {
      port,
      owner: owner || owners.get(port) || null,
      process: l ? l.process : null,
      pid: l ? l.pid : null,
      path: l ? l.path : null,
      listening: !!l,
    };
  };

  const sharesOut = shares.map((sh) => ({ ...sh, target: whoOn(sh.localPort) }));
  const slotPorts = [...new Set([...FUNNEL_PORTS, ...shares.map((sh) => sh.publicPort)])].sort((a, b) => a - b);

  // One entry per named tunnel, bound or not, so a free tunnel is something you
  // can pick rather than something you have to remember exists.
  const bound = targets.filter((t) => t.cloudflare && t.cloudflare.tunnel);
  const names = [...new Set([...cfs.tunnels.map((t) => t.name), ...bound.map((t) => t.cloudflare.tunnel)])];
  const cfTunnelsOut = names.sort().map((name) => {
    const b = bound.find((t) => t.cloudflare.tunnel === name) || null;
    const live = b ? tunnels.get(tKey(b.appId, b.cmdIndex)) : null;
    const known = cfs.tunnels.find((t) => t.name === name);
    const hostname = (b && b.cloudflare.hostname) || null;
    return {
      name,
      hostname,
      url: hostname ? `https://${hostname}` : null,
      inAccount: !!known,
      binding: b ? { appId: b.appId, cmdIndex: b.cmdIndex, auto: !!b.cloudflare.auto } : null,
      target: b
        ? whoOn(b.port, { appId: b.appId, appName: b.appName, procName: b.procName, cmdIndex: b.cmdIndex, running: b.running })
        : null,
      status: live ? live.status : !b ? "unused" : b.running ? "off" : "waiting",
      error: (live && live.error) || null,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    scannedAt: new Date(scanCache.at).toISOString(),
    elevated: scan.elevated,
    scanError: scan.error || null,
    tailscale: {
      available: funnel.available,
      reason: funnel.reason || null,
      dnsName: funnel.dnsName || null,
      ports: funnel.ports || FUNNEL_PORTS,
      slots: funnel.available
        ? slotPorts.map((p) => ({
            publicPort: p,
            funnelAllowed: FUNNEL_PORTS.includes(p),
            url: publicUrl(funnel.dnsName, p, "/"),
            shares: sharesOut.filter((sh) => sh.publicPort === p),
          }))
        : [],
    },
    cloudflare: {
      available: cfs.available,
      loggedIn: !!cfs.loggedIn,
      reason: cfs.reason || null,
      tunnels: cfTunnelsOut,
    },
    shares: sharesOut,
    tunnels: [...rackTunnels, ...foreign].map((t) => ({ ...t, target: whoOn(t.targetPort) })),
    targets: targets.map(({ cloudflare, ...t }) => t),
    listeners,
  };
}

/* ------------------------------------------------------------ usage stats */

// CPU and memory per app. A process Rack starts is often only the head of a
// tree — a .bat that runs node that forks workers — so each running process is
// counted together with everything below it. CPU is a share of the whole
// machine, the way Task Manager shows it. A short history feeds the sparklines.

const STATS_MS = 4000;
const STATS_HISTORY = 150; // ~10 minutes at STATS_MS

// The process table: pid -> { ppid, cpu (cumulative seconds), mem (bytes) }.
//
// Windows: one long-lived PowerShell prints the table every STATS_MS, because
// starting PowerShell costs more than the sample does. Get-Process is the cheap
// part; the parent map needs WMI, so it is only re-read when processes it
// hasn't seen turn up (at most every 10s) and once a minute regardless. The
// loop exits by itself once Rack is gone, so it can never be orphaned.
const STATS_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$parents = @{}
$mapAt = [datetime]::MinValue
while ($true) {
  if (-not (Get-Process -Id ${process.pid})) { exit }
  $procs = Get-Process
  $age = ((Get-Date) - $mapAt).TotalSeconds
  $stale = $age -gt 60
  if (-not $stale -and $age -gt 10) { foreach ($p in $procs) { if (-not $parents.ContainsKey($p.Id)) { $stale = $true; break } } }
  if ($stale) {
    $parents = @{}
    foreach ($c in (Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId)) { $parents[[int]$c.ProcessId] = [int]$c.ParentProcessId }
    $mapAt = Get-Date
  }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine('BEGIN')
  foreach ($p in $procs) {
    $t = $p.TotalProcessorTime
    [void]$sb.AppendLine("$($p.Id)\`t$($parents[$p.Id])\`t$(if ($t) { $t.Ticks } else { 0 })\`t$($p.WorkingSet64)")
  }
  [void]$sb.AppendLine('END')
  [Console]::Out.Write($sb.ToString())
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${STATS_MS}
}

`;

let winTable = null; // { at, procs } — the newest table the PowerShell loop printed
let winSampler = null;
let winSamplerAt = 0;

function startWinSampler() {
  if (winSampler || Date.now() - winSamplerAt < 30000) return; // don't respawn in a tight loop
  winSamplerAt = Date.now();
  let child;
  try {
    child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", "-"], { windowsHide: true });
  } catch {
    return;
  }
  winSampler = child;
  let buf = "";
  let rows = null;
  child.stdout.on("data", (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      if (line === "BEGIN") rows = new Map();
      else if (line === "END" && rows) {
        winTable = { at: Date.now(), procs: rows };
        rows = null;
      } else if (rows) {
        const [pid, ppid, ticks, mem] = line.split("\t");
        if (pid) rows.set(Number(pid), { ppid: Number(ppid) || 0, cpu: Number(ticks) / 1e7, mem: Number(mem) || 0 });
      }
    }
  });
  child.on("error", () => {});
  child.on("exit", () => {
    if (winSampler !== child) return;
    winSampler = null;
    winTable = null; // stale numbers would read as live ones
  });
  child.stdin.end(STATS_PS);
}

function stopWinSampler() {
  if (!winSampler) return;
  try { winSampler.kill(); } catch {}
  winSampler = null;
  winTable = null;
  winSamplerAt = 0; // a deliberate stop isn't a crash — the next start needn't wait
}

const CLK_TCK = 100; // USER_HZ — 100 on every mainstream Linux build
const PAGE_SIZE = 4096;

function readProcLinux() {
  const procs = new Map();
  let entries = [];
  try { entries = fs.readdirSync("/proc"); } catch { return null; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${e}/stat`, "utf8");
      // the name in (parens) can hold spaces, so split after its closing paren
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      procs.set(Number(e), {
        ppid: Number(f[1]),
        cpu: (Number(f[11]) + Number(f[12])) / CLK_TCK,
        mem: Number(f[21]) * PAGE_SIZE,
      });
    } catch {} // the process exited mid-read
  }
  return procs;
}

// Anything else (macOS): ps. TIME is [[dd-]hh:]mm:ss[.cc].
async function readProcPs() {
  const procs = new Map();
  for (const line of await shellLines("ps -A -o pid=,ppid=,time=,rss=")) {
    const [pid, ppid, time, rss] = line.trim().split(/\s+/);
    if (!pid || !time) continue;
    const [days, clock] = time.includes("-") ? time.split("-") : [0, time];
    const secs = clock.split(":").reduce((s, part) => s * 60 + Number(part), 0) + Number(days) * 86400;
    procs.set(Number(pid), { ppid: Number(ppid), cpu: secs, mem: Number(rss) * 1024 });
  }
  return procs;
}

// Returns { at, procs } or null when there's no table (yet).
async function processTable() {
  if (process.platform === "win32") {
    startWinSampler();
    return winTable;
  }
  const procs = process.platform === "linux" ? readProcLinux() : await readProcPs();
  return procs ? { at: Date.now(), procs } : null;
}

// Machine-wide CPU from the kernel's per-core counters.
let prevCpuTimes = null;
function systemCpu() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  const prev = prevCpuTimes;
  prevCpuTimes = { idle, total };
  if (!prev || total <= prev.total) return null;
  return Math.max(0, Math.min(100, 100 * (1 - (idle - prev.idle) / (total - prev.total))));
}

// The drive Rack lives on — on a home server that's usually the one that fills up.
function systemDisk() {
  try {
    const s = fs.statfsSync(ROOT);
    return { path: path.parse(ROOT).root, total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

const statsHistory = new Map(); // appId -> [{ t, cpu, mem }]   (cpu/mem null = a gap: the app was stopped)
const systemHistory = [];
let statsNow = null; // the latest broadcast payload
let prevTable = null;
let idleSince = 0;

function pushPoint(list, point) {
  list.push(point);
  if (list.length > STATS_HISTORY) list.splice(0, list.length - STATS_HISTORY);
}

// Sum one running process and every descendant. `seen` stops a pid being
// counted twice when two of an app's processes share a tree.
function treeUsage(rootPid, table, prev, dt, children, seen) {
  const ncpu = os.cpus().length || 1;
  let cpuSecs = 0;
  let mem = 0;
  let count = 0;
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = table.procs.get(pid);
    if (!p) continue;
    count++;
    mem += p.mem;
    if (prev) {
      const before = prev.procs.get(pid);
      cpuSecs += Math.max(0, p.cpu - (before ? before.cpu : 0));
    }
    for (const kid of children.get(pid) || []) queue.push(kid);
  }
  if (!count) return null;
  const cpu = prev && dt > 0 ? Math.min(100, (100 * cpuSecs) / dt / ncpu) : null;
  return { cpu, mem, procs: count };
}

async function sampleStats() {
  const running = apps.filter((a) => slotsFor(a).some((s) => s.proc));
  if (!running.length && !idleSince) idleSince = Date.now();
  if (running.length) idleSince = 0;
  // Nothing to measure for a minute — let the Windows sampler go.
  if (!running.length && idleSince && Date.now() - idleSince > 60000) stopWinSampler();

  const table = running.length ? await processTable() : null;
  const fresh = table && (!prevTable || table.at !== prevTable.at);
  const appsOut = {};

  if (table) {
    const prev = prevTable && fresh ? prevTable : null;
    const dt = prev ? (table.at - prev.at) / 1000 : 0;
    const children = new Map();
    for (const [pid, p] of table.procs) {
      if (p.ppid === pid) continue;
      if (!children.has(p.ppid)) children.set(p.ppid, []);
      children.get(p.ppid).push(pid);
    }
    for (const app of running) {
      const seen = new Set();
      const cmds = slotsFor(app).map((s) =>
        s.proc && s.pid ? treeUsage(s.pid, table, prev, dt, children, seen) : null
      );
      const live = cmds.filter(Boolean);
      if (!live.length) continue; // started after this table was taken
      const anyCpu = live.some((c) => c.cpu != null);
      appsOut[app.id] = {
        cpu: anyCpu ? live.reduce((n, c) => n + (c.cpu || 0), 0) : null,
        mem: live.reduce((n, c) => n + c.mem, 0),
        procs: live.reduce((n, c) => n + c.procs, 0),
        cmds,
      };
    }
    if (fresh) prevTable = table;
  }
  // On Windows the table arrives on PowerShell's clock, so between two tables
  // the last numbers stand instead of reading as zero.
  if (table && !fresh && statsNow) {
    for (const id of Object.keys(appsOut)) if (statsNow.apps[id]) appsOut[id] = statsNow.apps[id];
  }
  if (!running.length) prevTable = null;

  const t = Date.now();
  for (const app of apps) {
    const s = appsOut[app.id];
    let hist = statsHistory.get(app.id);
    if (s) {
      if (!hist) statsHistory.set(app.id, (hist = []));
      pushPoint(hist, { t, cpu: s.cpu, mem: s.mem });
    } else if (hist && hist.length && hist[hist.length - 1].mem != null) {
      pushPoint(hist, { t, cpu: null, mem: null }); // stopped: break the line here
    }
  }
  for (const id of statsHistory.keys()) if (!apps.some((a) => a.id === id)) statsHistory.delete(id);

  const memTotal = os.totalmem();
  const system = {
    cpu: systemCpu(),
    memUsed: memTotal - os.freemem(),
    memTotal,
    disk: systemDisk(),
    cores: os.cpus().length,
    uptime: os.uptime(),
    hostname: os.hostname(),
  };
  pushPoint(systemHistory, { t, cpu: system.cpu, mem: system.memUsed });

  statsNow = { at: t, interval: STATS_MS, window: STATS_MS * STATS_HISTORY, system, apps: appsOut };
  broadcast({ type: "stats", ...statsNow });
}

function statsPayload() {
  const history = {};
  for (const [id, list] of statsHistory) history[id] = list;
  return { ...(statsNow || { interval: STATS_MS, window: STATS_MS * STATS_HISTORY, system: null, apps: {} }), history, systemHistory };
}

/* --------------------------------------------------------- run on boot (win) */

function startupShortcutPath() {
  const startup =
    process.env.APPDATA &&
    path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  return startup ? path.join(startup, "Rack.lnk") : path.join(ROOT, "Rack.lnk");
}

// Create/remove a Startup shortcut that launches the controller hidden on login.
function setRunOnBoot(enable) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") return reject(new Error("Run on boot is Windows-only."));
    const lnk = startupShortcutPath();
    const vbs = path.join(ROOT, "start-hidden.vbs");
    if (enable) {
      // A tiny VBS launches node with no console window.
      fs.writeFileSync(
        vbs,
        `CreateObject("WScript.Shell").Run "cmd /c cd /d ""${ROOT}"" && node server.js --no-open", 0, False\n`
      );
      const ps =
        `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}');` +
        `$s.TargetPath='wscript.exe';$s.Arguments='\"${vbs}\"';` +
        `$s.WorkingDirectory='${ROOT}';$s.Save()`;
      exec(`powershell -NoProfile -Command "${ps}"`, (err) => (err ? reject(err) : resolve()));
    } else {
      try { if (fs.existsSync(lnk)) fs.unlinkSync(lnk); } catch (e) { return reject(e); }
      resolve();
    }
  });
}

/* ------------------------------------------------------------ start listening */

server.listen(CONTROL_PORT, () => {
  const url = `http://localhost:${CONTROL_PORT}`;
  console.log(`Rack running at ${url}`);
  if (process.platform === "win32" && !process.argv.includes("--no-open")) {
    exec(`start "" ${url}`);
  }
  // Auto-start apps marked "autostart" (e.g. after a reboot).
  for (const app of apps) {
    if (app.autostart) {
      console.log(`Auto-starting ${app.name}...`);
      startApp(app);
    }
  }
  // After a self-update restart, bring back whatever was running before.
  try {
    if (fs.existsSync(RESTORE_FILE)) {
      const ids = JSON.parse(fs.readFileSync(RESTORE_FILE, "utf8"));
      fs.unlinkSync(RESTORE_FILE);
      for (const id of ids) {
        const app = apps.find((a) => a.id === id);
        if (app && !app.autostart) {
          console.log(`Restoring ${app.name} after update...`);
          startApp(app);
        }
      }
    }
  } catch {}
  // Look for updates once the dashboard has settled, then a few times a day.
  checkUpdatesSoon(20000);
  setInterval(() => checkUpdates().catch(() => {}), AUTO_CHECK_MS).unref();
  sampleStats().catch(() => {});
  setInterval(() => sampleStats().catch(() => {}), STATS_MS).unref();
});

/* ------------------------------------------------- clean shutdown of children */

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const app of apps) stopApp(app);
  // Belt and braces: a surviving cloudflared would keep a public hostname
  // pointing at a port nothing is listening on any more.
  for (const t of tunnels.values()) if (t.pid) killPid(t.pid);
  if (cfSetupProc) killPid(cfSetupProc.pid);
  if (installProc) killPid(installProc.pid);
  stopWinSampler();
  setTimeout(() => process.exit(0), 800);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
