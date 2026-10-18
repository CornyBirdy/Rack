/*
 * host.js — a tiny keeper that holds one of an app's processes so it outlives
 * Rack itself.
 *
 * Rack used to be the parent of every process it ran and the only thing
 * holding their console pipes, so restarting Rack (⟳ Update Rack does) meant
 * stopping every app and starting it again. Now Rack starts this script, and
 * this script starts the process:
 *
 *   Rack ──spawn──▶ host.js --hop ──spawn──▶ host.js --run ──spawn──▶ the app
 *                   (exits at once)
 *
 * The extra hop leaves the real host with no living parent, so nothing aimed
 * at Rack's process tree can walk down to it, and it is spawned detached, so
 * it is in no console or job object of Rack's either.
 *
 * The host owns the process's stdout/stderr and serves them on a local socket
 * (a named pipe on Windows): newline-delimited JSON, one client at a time. It
 * keeps the last lines of output, so a Rack that reconnects after an update
 * shows the console as it was, plus whatever was printed while it was gone.
 *
 * This file runs on its own and may keep running across many Rack updates: it
 * must not require anything from Rack, and its protocol only ever grows (a
 * newer Rack talks to an older host). The same idea, for Minecraft servers,
 * lives in Rack-MC's lib/host.js.
 *
 * Protocol v1
 *   host → Rack  {t:"hello", v, key, pid, hostPid, startedAt, meta, lines:[[seq, at, stream, line]…], exit}
 *                {t:"line", s, at, st, l}
 *                {t:"exit", code, signal, error, at}
 *   Rack → host  {t:"in", d}     write to the process's stdin
 *                {t:"kill"}      stop the process and everything it started
 */
"use strict";

const fs = require("fs");
const net = require("net");
const { spawn, exec } = require("child_process");

const PROTOCOL = 1;
const KEEP_LINES = 1000;
const LINGER_MS = 10 * 60000; // after the process exits, wait this long for Rack to hear about it

const [mode, specFile] = process.argv.slice(2);
let spec;
try {
  spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
} catch (e) {
  process.exit(2);
}

function note(msg) {
  if (!spec.logFile) return;
  try {
    fs.appendFileSync(spec.logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

if (mode === "--hop") {
  // Start the real host and leave, so it has no living parent.
  try {
    const child = spawn(process.execPath, [__filename, "--run", specFile], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch (e) {
    note("hop failed: " + e.message);
  }
  process.exit(0);
}

if (mode !== "--run") process.exit(2);

/* ------------------------------------------------------------------ state */

const startedAt = Date.now();
const lines = []; // [seq, at, stream, line]
let seq = 0;
let child = null;
let client = null;
let exitInfo = null;
let lingerTimer = null;

process.on("uncaughtException", (e) => note("uncaught: " + (e && e.stack ? e.stack : e)));
// A hang-up of a terminal we never had is not a reason to drop the app.
process.on("SIGHUP", () => {});
process.on("SIGTERM", () => (child && !exitInfo ? kill() : quit()));

function send(obj) {
  if (!client || client.destroyed) return false;
  try {
    client.write(JSON.stringify(obj) + "\n");
    return true;
  } catch {
    return false;
  }
}

function push(stream, line) {
  const entry = [++seq, Date.now(), stream, line];
  lines.push(entry);
  if (lines.length > KEEP_LINES) lines.splice(0, lines.length - KEEP_LINES);
  send({ t: "line", s: entry[0], at: entry[1], st: stream, l: line });
}

// A chunk can end mid-line; hold the tail until the rest arrives, but not
// forever — a prompt with no newline after it should still show up.
function reader(stream, name) {
  let carry = "";
  let timer = null;
  const flush = () => {
    timer = null;
    if (carry) push(name, carry);
    carry = "";
  };
  stream.setEncoding("utf8");
  stream.on("data", (d) => {
    const parts = (carry + d).split(/\r?\n/);
    carry = parts.pop();
    for (const l of parts) if (l) push(name, l);
    if (timer) clearTimeout(timer);
    timer = carry ? setTimeout(flush, 250) : null;
  });
  stream.on("end", () => {
    if (timer) clearTimeout(timer);
    flush();
  });
  stream.on("error", () => {});
}

function writeIn(text) {
  if (!child || exitInfo || !child.stdin || !child.stdin.writable) return false;
  try {
    child.stdin.write(text);
    return true;
  } catch {
    return false;
  }
}

function writeJSON(file, obj) {
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(obj));
  } catch (e) {
    note(`could not write ${file}: ${e.message}`);
  }
}

function rm(file) {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}

function hello() {
  return {
    t: "hello",
    v: PROTOCOL,
    key: spec.key,
    pid: child ? child.pid || null : null,
    hostPid: process.pid,
    startedAt,
    meta: spec.meta || null,
    lines,
    exit: exitInfo,
  };
}

/* ------------------------------------------------------------- the socket */

function onClient(sock) {
  if (client && client !== sock) client.destroy(); // the newest Rack wins
  client = sock;
  sock.setEncoding("utf8");
  sock.on("error", () => {});
  sock.on("close", () => {
    if (client === sock) client = null;
  });

  send(hello());
  if (exitInfo) {
    // It heard. Nothing more to keep around for.
    sock.end();
    setTimeout(quit, 1500);
    return;
  }

  let buf = "";
  sock.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (msg.t === "in" && typeof msg.d === "string") writeIn(msg.d);
      else if (msg.t === "kill") kill();
    }
  });
}

// The whole tree: a .bat that starts node that forks workers is one app.
function kill() {
  if (!child || exitInfo || !child.pid) return;
  if (process.platform === "win32") {
    exec(`taskkill /pid ${child.pid} /t /f`, { windowsHide: true }, () => {});
  } else {
    try {
      child.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      if (!exitInfo)
        try {
          child.kill("SIGKILL");
        } catch {}
    }, 5000).unref();
  }
}

/* -------------------------------------------------------------- lifecycle */

function finish(code, signal, error) {
  if (exitInfo) return;
  exitInfo = { code: code ?? null, signal: signal ?? null, error: error || null, at: Date.now() };
  writeJSON(spec.exitFile, { ...exitInfo, key: spec.key, startedAt, socket: spec.socket });
  rm(spec.stateFile);
  if (send({ t: "exit", ...exitInfo })) {
    client.end();
    setTimeout(quit, 1500);
  } else {
    // Nobody is listening — Rack may be mid-update. Hold on so it can hear
    // how this ended; the exit file covers it if it never comes.
    lingerTimer = setTimeout(quit, LINGER_MS);
  }
}

function quit() {
  if (lingerTimer) clearTimeout(lingerTimer);
  try {
    server.close();
  } catch {}
  if (process.platform !== "win32") rm(spec.socket);
  process.exit(0);
}

function launch() {
  const env = { ...process.env, ...(spec.env || {}) };
  try {
    child = spec.line
      ? spawn(spec.line, { cwd: spec.cwd || undefined, windowsHide: true, shell: true, env })
      : spawn(spec.file, spec.args || [], { cwd: spec.cwd || undefined, windowsHide: true, env });
  } catch (e) {
    push("err", "[host] " + e.message);
    return finish(null, null, e.message);
  }
  child.stdin.on("error", () => {});
  reader(child.stdout, "out");
  reader(child.stderr, "err");
  child.on("error", (e) => {
    push("err", "[host] " + e.message);
    if (!child.pid) finish(null, null, e.message); // it never started
  });
  child.on("exit", (code, signal) => {
    // Let the last of its output drain into the buffer first.
    setTimeout(() => finish(code, signal, null), 150);
  });
  if (child.pid)
    writeJSON(spec.stateFile, {
      v: PROTOCOL,
      key: spec.key,
      pid: child.pid,
      hostPid: process.pid,
      startedAt,
      socket: spec.socket,
      meta: spec.meta || null,
    });
}

const server = net.createServer(onClient);
server.on("error", (e) => {
  // Most likely another host already serves this socket — never run two.
  note("listen failed: " + e.message);
  process.exit(1);
});
if (process.platform === "win32") {
  server.listen(spec.socket, launch); // a pipe that is still served refuses a second listener
} else {
  // A socket file outlives a host that died; one that answers is a live host.
  const probe = net.connect(spec.socket);
  probe.on("connect", () => {
    note("another host already serves " + spec.socket);
    probe.destroy();
    process.exit(1);
  });
  probe.on("error", () => {
    rm(spec.socket);
    server.listen(spec.socket, launch);
  });
}
