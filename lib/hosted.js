/*
 * hosted.js — Rack's side of host.js: start a process that outlives Rack,
 * find it again after a restart, and talk to it.
 *
 * launch() returns a handle shaped like the ChildProcess that spawn() gives,
 * as far as Rack uses one — `pid`, `stdout`/`stderr` emitting "data", and
 * "spawn", "error" and "exit" events — so the code that wires up a process's
 * console doesn't care which kind it has. Two differences: `pid` is only
 * known once the host answers ("spawn" fires then), and `detached` is true.
 *
 *   launch(key, spec)  start spec under a host of its own
 *   adopt(key)         reconnect to a host a previous Rack left running
 *   handle.kill()      stop the process and its tree (through the host)
 *   handle.release()   let go without stopping it (Rack is restarting)
 */
const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");
const crypto = require("crypto");
const { spawn, exec } = require("child_process");
const { EventEmitter } = require("events");

const isWin = process.platform === "win32";
const ROOT = path.join(__dirname, "..");
const RUN_DIR = path.join(ROOT, ".rack-run");
const HOST = path.join(__dirname, "host.js");
// Two Rack checkouts on one machine have their own apps; their pipe names
// must never meet.
const TAG = crypto.createHash("sha1").update(ROOT).digest("hex").slice(0, 8);

const CONNECT_EVERY = 150;
const LAUNCH_WAIT = 20000; // a cold Node start on a busy machine is slow
const RECONNECT_WAIT = 4000;

const safeKey = (key) => String(key).replace(/[^A-Za-z0-9_-]/g, "_");

function socketPath(key) {
  return isWin
    ? `\\\\.\\pipe\\rack-${TAG}-${safeKey(key)}`
    : path.join(os.tmpdir(), `rack-${TAG}-${safeKey(key)}.sock`);
}

function filesFor(key) {
  const k = safeKey(key);
  return {
    spec: path.join(RUN_DIR, `${k}.spec.json`),
    state: path.join(RUN_DIR, `${k}.json`),
    exit: path.join(RUN_DIR, `${k}.exit.json`),
    log: path.join(RUN_DIR, `${k}.host.log`),
  };
}

const readJSON = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const rm = (file) => {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
};

function killPid(pid) {
  if (!pid) return;
  if (isWin) exec(`taskkill /pid ${pid} /t /f`, { windowsHide: true }, () => {});
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

class HostedProc extends EventEmitter {
  constructor(key, socket) {
    super();
    this.key = key;
    this.socket = socket;
    this.detached = true;
    this.pid = null;
    this.hostPid = null;
    this.startedAt = null;
    this.meta = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.sock = null;
    this.pending = []; // messages sent before the socket is up
    this.done = false;
    this.released = false;
    this.info = null;
    this.lastSeq = 0;
  }

  _send(obj) {
    const raw = JSON.stringify(obj) + "\n";
    if (!this.sock || this.sock.destroyed) {
      if (!this.done && !this.released) this.pending.push(raw);
      return;
    }
    try {
      this.sock.write(raw);
    } catch {}
  }

  write(text) {
    if (!this.done) this._send({ t: "in", d: String(text) });
  }

  // Stop it, through the host when it can hear us, and by pid as well in case
  // the host itself is what's stuck.
  kill() {
    if (this.done) return;
    this._send({ t: "kill" });
    const pid = this.pid;
    setTimeout(() => {
      if (!this.done) killPid(pid);
    }, 3000).unref();
    if (!this.sock) killPid(pid);
  }

  // Let go without stopping anything: Rack is going away, the app isn't.
  release() {
    this.released = true;
    if (this.sock)
      try {
        this.sock.end();
      } catch {}
  }

  _exit(code, signal, error) {
    if (this.done) return;
    this.done = true;
    rm(filesFor(this.key).exit); // heard it live; nothing left to report on boot
    if (error && !this.pid) this.emit("error", new Error(error));
    this.emit("exit", code, signal);
  }

  // Keep dialling until the host answers or `wait` runs out.
  _connect(wait) {
    return new Promise((resolve) => {
      const until = Date.now() + wait;
      const attempt = () => {
        if (this.done || this.released) return resolve(false);
        const sock = net.connect(this.socket);
        let buf = "";
        let greeted = false;
        sock.setEncoding("utf8");
        sock.on("connect", () => {
          this.sock = sock;
        });
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
            if (msg.t === "hello" && !greeted) {
              greeted = true;
              this._hello(msg);
              resolve(true);
            } else this._message(msg);
          }
        });
        sock.on("error", () => {});
        sock.on("close", () => {
          if (this.sock === sock) this.sock = null;
          if (!greeted) {
            if (Date.now() < until) setTimeout(attempt, CONNECT_EVERY);
            else resolve(false);
            return;
          }
          this._lost();
        });
      };
      attempt();
    });
  }

  _hello(msg) {
    const again = !!this.info; // back after a dropped connection, not a first meeting
    this.info = msg;
    this.pid = msg.pid || null;
    this.hostPid = msg.hostPid || null;
    this.startedAt = msg.startedAt || Date.now();
    this.meta = msg.meta || null;
    for (const raw of this.pending.splice(0))
      try {
        this.sock.write(raw);
      } catch {}
    const lines = msg.lines || [];
    if (again) {
      // Only what was printed while the line was down.
      for (const [sq, , st, l] of lines) if (sq > this.lastSeq) this._line(sq, st, l);
    } else {
      // A fresh launch: everything so far is new. An adopt hands the backlog
      // to the caller instead (see adopt), so it isn't replayed as live output.
      if (this.pid) this.emit("spawn");
      if (!this.adopting) for (const [sq, , st, l] of lines) this._line(sq, st, l);
      else if (lines.length) this.lastSeq = lines[lines.length - 1][0];
    }
    if (msg.exit) this._exit(msg.exit.code, msg.exit.signal, msg.exit.error);
  }

  _line(sq, st, l) {
    if (sq != null) this.lastSeq = Math.max(this.lastSeq, sq);
    (st === "err" ? this.stderr : this.stdout).emit("data", l + "\n");
  }

  _message(msg) {
    if (msg.t === "line") this._line(msg.s, msg.st, msg.l);
    else if (msg.t === "exit") this._exit(msg.code, msg.signal, msg.error);
  }

  // The socket dropped without an exit message: either we let go on purpose,
  // or the host died. Try to get back in; if nobody's there, the process went
  // with it.
  async _lost() {
    if (this.done || this.released) return;
    const back = await this._connect(RECONNECT_WAIT);
    if (back || this.done || this.released) return;
    const ex = readJSON(filesFor(this.key).exit);
    rm(filesFor(this.key).state);
    this._exit(ex ? ex.code : null, ex ? ex.signal : null, ex ? ex.error : "its host process went away");
  }
}

/**
 * Start a process under a host of its own. spec: { line } (run through the
 * shell) or { file, args }, plus cwd, env (only what differs from Rack's own
 * environment — the host inherits the rest) and meta (anything Rack wants back
 * on adopt, like the port it gave the process).
 */
function launch(key, { line = null, file = null, args = [], cwd = null, env = {}, meta = null }) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const f = filesFor(key);
  rm(f.exit);
  // A fresh socket name per launch, so a host still lingering to report an
  // earlier exit can never be mistaken for this one.
  const socket = socketPath(`${key}-${Date.now().toString(36)}`);
  fs.writeFileSync(
    f.spec,
    JSON.stringify({ key, line, file, args, cwd, env, meta, socket, stateFile: f.state, exitFile: f.exit, logFile: f.log })
  );
  const h = new HostedProc(key, socket);
  try {
    const hop = spawn(process.execPath, [HOST, "--hop", f.spec], { detached: true, stdio: "ignore", windowsHide: true });
    hop.on("error", (e) => h._exit(null, null, "could not start its host: " + e.message));
    hop.unref();
  } catch (e) {
    setImmediate(() => h._exit(null, null, "could not start its host: " + e.message));
    return h;
  }
  h._connect(LAUNCH_WAIT).then((ok) => {
    if (ok || h.done || h.released) return;
    const ex = readJSON(f.exit);
    h._exit(ex ? ex.code : null, ex ? ex.signal : null, (ex && ex.error) || "its host never answered");
  });
  return h;
}

/**
 * Reconnect to a host a previous Rack started. Resolves { proc, lines } for a
 * live one (lines: its recent output, [stream, line]), or { exit } with how it
 * ended if it finished while Rack was away (null when nothing was there).
 */
async function adopt(key) {
  const f = filesFor(key);
  const state = readJSON(f.state);
  const ex = readJSON(f.exit);
  if (!state) {
    if (ex) {
      rm(f.exit);
      // Its host may still be waiting to say how it ended; a hello is all it
      // needs before it goes.
      if (ex.socket) {
        const s = net.connect(ex.socket);
        s.on("data", () => s.destroy());
        s.on("error", () => {});
        setTimeout(() => s.destroy(), 2000).unref();
      }
    }
    return { proc: null, exit: ex };
  }
  const h = new HostedProc(key, state.socket || socketPath(key));
  h.adopting = true;
  const ok = await h._connect(1500);
  h.adopting = false;
  if (ok && !h.done)
    return { proc: h, lines: (h.info.lines || []).map(([, , st, l]) => [st === "err" ? "err" : "out", l]) };
  if (ok && h.done) return { proc: null, exit: h.info.exit };
  // Its state file says running, but nobody answers: it died hard.
  rm(f.state);
  rm(f.exit);
  return { proc: null, exit: ex || null };
}

module.exports = { launch, adopt, killPid, RUN_DIR };
