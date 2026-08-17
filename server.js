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

const VERSION = "0.6";
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

// Run an app's update sequence (update command, then rebuild) and stream the
// output to the UI via SSE. A failed step skips the rest.
const updateProcs = new Map();
function updateApp(app) {
  if (updateProcs.get(app.id)) return { ok: false, error: "An update is already running." };
  const rebuild = rebuildStepFor(app);
  if (!app.update && !rebuild) return { ok: false, error: "No update command set for this app." };

  const dir = appDir(app);
  const emit = (stream, line) => broadcast({ type: "update-log", id: app.id, stream, line });
  const steps = [];
  if (app.update) steps.push({ tag: "update", cmd: app.update, label: app.update });
  if (rebuild) steps.push({ tag: "rebuild", cmd: rebuild.cmd, label: rebuild.label });

  // A build can't overwrite files the running app still holds open, so stop it
  // first and bring it back once the build succeeds.
  const wasRunning = !!rebuild && slotsFor(app).some((s) => s.proc);
  if (wasRunning) {
    emit("out", "[update] stopping the app first — it restarts after the rebuild");
    stopApp(app);
  }

  const finish = (code) => {
    const done = (restarted) => {
      updateProcs.delete(app.id);
      emit("out", `[update] finished (exit code ${code})`);
      broadcast({ type: "update-done", id: app.id, code, restarted });
    };
    if (!wasRunning || code !== 0) return done(false);
    emit("out", "[update] restarting the app...");
    // Stopping is asynchronous (taskkill), so wait for the old processes to
    // actually be gone — starting over a live slot would be a silent no-op.
    const restart = (tries = 0) => {
      if (slotsFor(app).some((s) => s.proc)) {
        if (tries < 40) return setTimeout(() => restart(tries + 1), 250);
        emit("err", "[update] the app hasn't stopped — start it by hand.");
        return done(false);
      }
      const r = startApp(app);
      if (!r.ok) emit("err", `[update] restart failed: ${r.error}`);
      done(r.ok);
    };
    restart();
  };

  const runStep = (i) => {
    const step = steps[i];
    const next = steps[i + 1];
    emit("out", `[${step.tag}] ${step.label}   (in ${dir})`);
    let proc;
    try {
      proc = spawn(step.cmd, { cwd: dir, windowsHide: true, shell: true });
    } catch (e) {
      emit("err", `[${step.tag}] error: ${e.message}`);
      return finish(1);
    }
    updateProcs.set(app.id, proc);
    const pump = (stream) => (d) =>
      d.toString().split(/\r?\n/).filter(Boolean).forEach((l) => emit(stream, l));
    proc.stdout.on("data", pump("out"));
    proc.stderr.on("data", pump("err"));
    proc.on("error", (e) => emit("err", `[${step.tag}] error: ${e.message}`));
    proc.on("exit", (code) => {
      if (code !== 0) {
        if (next) emit("err", `[${step.tag}] failed — skipping ${next.tag}.`);
        return finish(code);
      }
      if (next) return runStep(i + 1);
      finish(code);
    });
  };

  updateProcs.set(app.id, true); // claim the slot before the first spawn
  runStep(0);
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

async function setFunnel({ publicPort, localPort, enable }) {
  const pub = Number(publicPort);
  if (!FUNNEL_PORTS.includes(pub))
    return { ok: false, error: `Funnel only allows public ports ${FUNNEL_PORTS.join(", ")}.` };
  if (enable) {
    if (!localPort) return { ok: false, error: "That process has no port to expose." };
    const r = await tsExec(`funnel --bg --https=${pub} localhost:${localPort}`);
    if (!r.ok) return { ok: false, error: r.err || "Failed to enable funnel." };
  } else {
    const r = await tsExec(`funnel --https=${pub} off`);
    if (!r.ok) return { ok: false, error: r.err || "Failed to turn the funnel off." };
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
  // Belt and braces: a surviving cloudflared would keep a public hostname
  // pointing at a port nothing is listening on any more.
  for (const t of tunnels.values()) if (t.pid) killPid(t.pid);
  setTimeout(() => process.exit(0), 800);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
