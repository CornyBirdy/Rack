/*
 * Rack — manages multiple local apps, each of which may run
 * several processes ("commands"). Every process is captured inside the
 * controller (its own console), so nothing pops up in a stray window.
 * Zero dependencies: uses only Node.js built-ins.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, exec, execSync } = require("child_process");

const VERSION = "0.2";
// True when launched by the start.bat supervisor loop, which can relaunch us on
// exit code 42 — that's what makes one-click "Update Rack" able to restart.
const SUPERVISED = process.env.RACK_SUPERVISOR === "1" || process.argv.includes("--supervised");
const RESTART_EXIT_CODE = 42;

const portArg = process.argv.find((a) => a.startsWith("--port="));
const CONTROL_PORT = portArg ? Number(portArg.split("=")[1]) : 7799;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const APPS_FILE = path.join(ROOT, "apps.json");
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
  }));
  app.category = app.category || null;
  app.autostart = !!app.autostart; // start this app when the controller launches
  app.update = app.update || null; // shell command to fetch a new version (e.g. git pull)
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
      slot.proc = null;
      broadcast({ type: "status", app: stateOf(app) });
    });
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

// Run an app's `update` command (e.g. `git pull`) and stream its output to the
// UI via SSE. Runs in the first process's folder (the repo root).
const updateProcs = new Map();
function updateApp(app) {
  if (!app.update) return { ok: false, error: "No update command set for this app." };
  if (updateProcs.get(app.id)) return { ok: false, error: "An update is already running." };
  const dir = (app.commands[0] && app.commands[0].dir) || ROOT;
  const emit = (stream, line) => broadcast({ type: "update-log", id: app.id, stream, line });
  emit("out", `[update] ${app.update}   (in ${dir})`);
  let proc;
  try {
    proc = spawn(app.update, { cwd: dir, windowsHide: true, shell: true });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  updateProcs.set(app.id, proc);
  const pump = (stream) => (d) =>
    d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => emit(stream, l));
  proc.stdout.on("data", pump("out"));
  proc.stderr.on("data", pump("err"));
  proc.on("error", (e) => emit("err", `[update] error: ${e.message}`));
  proc.on("exit", (code) => {
    updateProcs.delete(app.id);
    emit("out", `[update] finished (exit code ${code})`);
    broadcast({ type: "update-done", id: app.id, code });
  });
  return { ok: true };
}

// Update Rack itself: `git pull` in ROOT, and if new code arrived, restart via
// the supervisor (exit 42). Running apps are remembered and brought back after.
let selfUpdating = false;
function gitHead() {
  try { return execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim(); } catch { return ""; }
}
function selfUpdate() {
  if (!SUPERVISED) return { ok: false, error: "Launch Rack via start.bat to enable one-click update." };
  if (selfUpdating) return { ok: false, error: "An update is already running." };
  selfUpdating = true;
  const emit = (stream, line) => broadcast({ type: "self-update-log", stream, line });
  const before = gitHead();
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
    if (before && before === gitHead()) {
      selfUpdating = false;
      emit("out", "[update] Already up to date.");
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
    dir = ROOT;
  }

  // Optional working-folder override.
  if (spec.dir && spec.dir.trim()) {
    const d = path.resolve(spec.dir.trim().replace(/^"|"$/g, ""));
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
      proc.dir ? undefined : dir
    );
    if (r.error) return { error: `Manifest process "${proc.name || i + 1}": ${r.error}` };
    if (proc.managed != null) r.cmd.managePort = !!proc.managed; // manifest wins over auto-detect
    if (proc.portEnv) r.cmd.portEnv = proc.portEnv;
    if (Array.isArray(proc.links)) r.cmd.links = proc.links;
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
  return { app };
}

/* ------------------------------------------------------------- HTTP server */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
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
      broadcast({ type: "apps" });
      return sendJSON(res, 200, { app: stateOf(result.app), portInfo });
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
      if ("update" in body) app.update = (String(body.update || "").trim()) || null;
      if (Array.isArray(body.commands)) {
        const rebuilt = [];
        for (let i = 0; i < body.commands.length; i++) {
          const r = resolveCommand(body.commands[i]);
          if (r.error) return sendJSON(res, 400, { error: `Process ${i + 1}: ${r.error}` });
          rebuilt.push(r.cmd);
        }
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

    // GET /api/version  → version + whether one-click self-update is available
    if (parts[1] === "version" && req.method === "GET") {
      return sendJSON(res, 200, { version: VERSION, supervised: SUPERVISED });
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
});

/* ------------------------------------------------- clean shutdown of children */

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const app of apps) stopApp(app);
  setTimeout(() => process.exit(0), 800);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
