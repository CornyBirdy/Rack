/*
 * mcp.js — the Claude connector: an MCP server so Claude (Claude Code, the
 * Claude app, claude.ai) can see and run your apps — what's running, its
 * logs, start/stop/restart, updates, machine load and what's exposed.
 *
 * It listens on a port of its own (7800 by default) that answers nothing but
 * the connector, never on the dashboard's port: Rack's dashboard has no
 * sign-in, so publishing it (to reach claude.ai) would publish everything.
 * Publish this port instead — Tailscale Funnel from the Exposure manager.
 *
 * Signing in uses an access key Rack makes for you (⚙ → Claude connector):
 *   - Claude Code (on your network) sends it as a header:
 *       claude mcp add --transport http rack http://<pc>:7800/mcp \
 *         --header "Authorization: Bearer <key>"
 *   - claude.ai / the Claude app use OAuth: Claude registers itself, opens
 *     /oauth/authorize, you paste the key there once, and Claude gets tokens
 *     (an access token for a day, renewed quietly for up to 6 months).
 * A new key signs every connected Claude out. The flow mirrors Shelf's
 * connector (pb_hooks/mcp_auth.js), with the key standing in for an account.
 *
 * MCP messages are JSON-RPC over plain HTTP POSTs ("Streamable HTTP",
 * answered with plain JSON — no streaming or sessions).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ACCESS_TTL = 24 * 3600; // an access token lasts a day …
const REFRESH_TTL = 180 * 24 * 3600; // … and Claude renews it for up to 6 months of disuse
const CODE_TTL = 10 * 60;
const UPDATE_WAIT_MS = 5 * 60000;
const DEFAULT_PORT = 7800;

const now = () => Math.floor(Date.now() / 1000);
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n = 32) => b64url(crypto.randomBytes(n));
const s256 = (verifier) => b64url(crypto.createHash("sha256").update(String(verifier)).digest());
const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Where Claude may be sent back to after signing in: Claude's own callback,
// and apps on the same computer (Claude Code / Desktop wait on localhost).
function redirectAllowed(uri) {
  return (
    /^https:\/\/(claude\.ai|claude\.com)\/api\/mcp\/auth_callback$/.test(uri) ||
    /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/[^?#]*)?$/.test(uri)
  );
}

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const INSTRUCTIONS = `Rack runs the user's self-hosted apps on their home server (a small always-on PC): each app is one or more processes (a PocketBase server, a Node app, a .bat…) with its own console.
Refer to apps by name. Look before acting: list_apps / get_app / read_logs, and when something is broken, read its logs (errors_only is a quick first look) before restarting it.
Starting, stopping, restarting and updating affect real services other people may be using — say what you're about to do, and do it when the user asked for it. update_app pulls new code (git pull), rebuilds and restarts the app, and returns its output. update_rack updates Rack itself; the apps keep running while it restarts.`;

function create(ctx) {
  const STORE = path.join(ctx.ROOT, ".rack-mcp.json");
  let data = { enabled: false, key: null, port: DEFAULT_PORT, clients: {}, tokens: {} };
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(STORE, "utf8")) };
  } catch {}
  const save = () => {
    try {
      fs.writeFileSync(STORE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.log("Couldn't save the Claude connector's settings: " + e.message);
    }
  };

  /* ------------------------------------------------------------- tokens */

  function issue(kind, extra) {
    const token = random(36);
    const ttl = { code: CODE_TTL, access: ACCESS_TTL, refresh: REFRESH_TTL }[kind];
    data.tokens[sha256(token)] = { kind, expires: now() + ttl, ...extra };
    save();
    return token;
  }
  function lookup(kind, token) {
    if (!token) return null;
    const h = sha256(token);
    const t = data.tokens[h];
    if (!t || t.kind !== kind) return null;
    if (t.expires < now()) {
      delete data.tokens[h];
      save();
      return null;
    }
    return { hash: h, ...t };
  }
  function sweep() {
    for (const [h, t] of Object.entries(data.tokens)) if (t.expires < now()) delete data.tokens[h];
  }
  // A request may use the access key itself, or an OAuth access token.
  function authorised(req) {
    if (!data.enabled || !data.key) return false;
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
    if (!m) return false;
    const t = m[1].trim();
    return same(t, data.key) || !!lookup("access", t);
  }

  /* ---------------------------------------------------------- http bits */

  function baseUrl(req) {
    if (process.env.RACK_MCP_URL) return process.env.RACK_MCP_URL.replace(/\/+$/, "");
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
    let proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    if (!proto) {
      const port = (host.match(/:(\d+)$/) || [])[1];
      const local = /^(localhost|127\.|\[::1\]|\d+\.\d+\.\d+\.\d+)/.test(host);
      proto = local || (port && port !== "443") ? "http" : "https";
    }
    return proto + "://" + host;
  }
  const json = (res, code, obj, headers = {}) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(obj));
  };
  const readRaw = (req) =>
    new Promise((resolve) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 1e6) req.destroy();
      });
      req.on("end", () => resolve(body));
      req.on("error", () => resolve(""));
    });
  // OAuth posts forms; Claude Code sometimes posts JSON.
  async function readParams(req) {
    const raw = await readRaw(req);
    if (/json/i.test(req.headers["content-type"] || "")) {
      try {
        return JSON.parse(raw || "{}");
      } catch {
        return {};
      }
    }
    return Object.fromEntries(new URLSearchParams(raw));
  }

  /* ------------------------------------------------------------- OAuth */

  const protectedResource = (req) => ({
    resource: baseUrl(req) + "/mcp",
    authorization_servers: [baseUrl(req)],
    bearer_methods_supported: ["header"],
    resource_name: "Rack",
  });
  const serverMetadata = (req) => {
    const base = baseUrl(req);
    return {
      issuer: base,
      authorization_endpoint: base + "/oauth/authorize",
      token_endpoint: base + "/oauth/token",
      registration_endpoint: base + "/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["rack"],
    };
  };

  async function register(req, res) {
    let body = {};
    try {
      body = JSON.parse((await readRaw(req)) || "{}");
    } catch {}
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!uris.length || !uris.every(redirectAllowed))
      return json(res, 400, {
        error: "invalid_redirect_uri",
        error_description: "Rack only signs in to Claude (claude.ai / claude.com) and apps on this computer.",
      });
    const clientId = "rack-" + random(18);
    const name = String(body.client_name || "Claude").slice(0, 120);
    data.clients[clientId] = { name, redirect_uris: uris, created: Date.now() };
    save();
    json(res, 201, {
      client_id: clientId,
      client_id_issued_at: now(),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  }

  const PASS = ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope", "resource"];

  function loginPage(res, p, clientName, error) {
    const hidden = PASS.filter((k) => p[k])
      .map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`)
      .join("");
    res.writeHead(error ? 401 : 200, {
      "Content-Type": "text/html; charset=utf-8",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://claude.com http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
      "Cache-Control": "no-store",
    });
    res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${esc(clientName)} to Rack</title>
<style>
  /* Rack Suite "Sunset" tokens: dark first, light when the system asks for it */
  :root { color-scheme:dark; --ground:#0d0e13; --surface:#18191e; --hairline:#27292e; --border-control:#828593;
          --ink:#e6e7ed; --ink-muted:#a5a7b1; --accent:#9babfd; --on-accent:#121524; --danger:#f68795;
          --danger-soft:rgba(246,135,149,.14); }
  @media (prefers-color-scheme: light) {
    :root { color-scheme:light; --ground:#f5f6fe; --surface:#ffffff; --hairline:#dfe1e8; --border-control:#777a87;
            --ink:#181a24; --ink-muted:#525561; --accent:#95a4f6; --on-accent:#121524; --danger:#b8223a;
            --danger-soft:rgba(184,34,58,.1); }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:var(--ground); color:var(--ink); font:15px/1.5 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; padding:16px; }
  form { background:var(--surface); border:1px solid var(--hairline); border-radius:16px; padding:32px; width:100%; max-width:400px; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { margin:0 0 16px; color:var(--ink-muted); }
  label { display:block; font-size:13px; color:var(--ink-muted); margin:12px 0 4px; }
  input[type=password] { width:100%; min-height:44px; padding:8px 12px; border-radius:6px; border:1px solid var(--border-control);
         background:transparent; color:var(--ink); font:14px "Cascadia Mono", Consolas, monospace; }
  input[type=password]:focus { outline:2px solid var(--accent); border-color:transparent; }
  button { margin-top:20px; width:100%; min-height:44px; padding:8px; border:0; border-radius:6px; background:var(--accent);
           color:var(--on-accent); font:inherit; font-weight:600; cursor:pointer; }
  .err { color:var(--danger); background:var(--danger-soft); border-radius:6px; padding:8px 12px; margin:0 0 8px; }
  .err::before { content:"⚠ "; }

</style></head><body>
<form method="post" action="/oauth/authorize">
  <h1>Connect ${esc(clientName)} to Rack</h1>
  <p>${esc(clientName)} will be able to see your apps and their logs, and start, stop, restart and update them.
     Paste the access key from Rack's dashboard: <b>⚙ → Claude connector</b>.</p>
  ${error ? `<p class="err">${esc(error)}</p>` : ""}
  ${hidden}
  <label for="key">Access key</label>
  <input id="key" name="key" type="password" autocomplete="off" required autofocus>
  <button type="submit">Allow</button>
</form></body></html>`);
  }

  function redirectWith(res, uri, params) {
    const q = Object.keys(params)
      .filter((k) => params[k] != null && params[k] !== "")
      .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
      .join("&");
    res.writeHead(302, { Location: uri + (uri.includes("?") ? "&" : "?") + q });
    res.end();
  }
  const page = (res, code, text) => {
    res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<p style="font-family:system-ui">${esc(text)}</p>`);
  };

  async function authorize(req, res, url) {
    const post = req.method === "POST";
    const src = post ? await readParams(req) : Object.fromEntries(url.searchParams);
    const p = {};
    for (const k of PASS.concat(["key"])) p[k] = src[k] == null ? "" : String(src[k]);

    const client = data.clients[p.client_id];
    // Without a known client and its registered redirect there's nowhere safe to
    // send errors, so they're shown here.
    if (!client) return page(res, 400, "Unknown app. Remove the Rack connector in Claude and add it again.");
    if (!p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri))
      return page(res, 400, "This sign-in link isn't for a registered app.");
    if (p.response_type !== "code") return redirectWith(res, p.redirect_uri, { error: "unsupported_response_type", state: p.state });
    if (!p.code_challenge || p.code_challenge_method !== "S256")
      return redirectWith(res, p.redirect_uri, { error: "invalid_request", error_description: "PKCE (S256) is required", state: p.state });

    if (!post) return loginPage(res, p, client.name, "");
    if (!data.key || !same(p.key.trim(), data.key)) {
      await new Promise((r) => setTimeout(r, 1000)); // slows down guessing
      return loginPage(res, p, client.name, "That isn't Rack's access key.");
    }
    sweep();
    const code = issue("code", { client_id: p.client_id, redirect_uri: p.redirect_uri, challenge: p.code_challenge });
    redirectWith(res, p.redirect_uri, { code, state: p.state });
  }

  const tokenError = (res, error, description) => json(res, 400, { error, error_description: description });
  const tokenPair = (res, clientId) =>
    json(res, 200, {
      access_token: issue("access", { client_id: clientId }),
      token_type: "Bearer",
      expires_in: ACCESS_TTL,
      refresh_token: issue("refresh", { client_id: clientId }),
      scope: "rack",
    });

  async function token(req, res) {
    const b = await readParams(req);
    const get = (k) => (b[k] == null ? "" : String(b[k]));
    if (get("grant_type") === "authorization_code") {
      const rec = lookup("code", get("code"));
      if (!rec) return tokenError(res, "invalid_grant", "The sign-in code is invalid or has expired.");
      delete data.tokens[rec.hash]; // single use
      save();
      if (get("client_id") && get("client_id") !== rec.client_id) return tokenError(res, "invalid_grant", "The code was issued to another app.");
      if (get("redirect_uri") !== rec.redirect_uri) return tokenError(res, "invalid_grant", "redirect_uri doesn't match.");
      if (!get("code_verifier") || !same(s256(get("code_verifier")), rec.challenge))
        return tokenError(res, "invalid_grant", "PKCE check failed.");
      return tokenPair(res, rec.client_id);
    }
    if (get("grant_type") === "refresh_token") {
      const rec = lookup("refresh", get("refresh_token"));
      if (!rec) return tokenError(res, "invalid_grant", "The refresh token is invalid or has expired.");
      if (get("client_id") && get("client_id") !== rec.client_id) return tokenError(res, "invalid_grant", "The token was issued to another app.");
      delete data.tokens[rec.hash]; // rotated: each refresh token works once
      sweep();
      return tokenPair(res, rec.client_id);
    }
    tokenError(res, "unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  /* ------------------------------------------------------------- tools */

  // An app by id or name — exact first, then a unique partial match.
  function findApp(ref) {
    const all = ctx.apps();
    const s = String(ref || "").trim().toLowerCase();
    if (!s) throw new Error("Say which app (its name).");
    const exact = all.find((a) => a.id.toLowerCase() === s || a.name.toLowerCase() === s);
    if (exact) return exact;
    const some = all.filter((a) => a.name.toLowerCase().includes(s));
    if (some.length === 1) return some[0];
    if (!some.length) throw new Error(`No app called "${ref}". Apps: ${all.map((a) => a.name).join(", ") || "none"}.`);
    throw new Error(`"${ref}" matches ${some.map((a) => a.name).join(", ")} — which one?`);
  }

  const mb = (bytes) => (bytes == null ? null : Math.round(bytes / 1048576));
  const ago = (ms) => {
    if (!ms) return null;
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 90) return s + "s";
    if (s < 5400) return Math.round(s / 60) + "m";
    if (s < 172800) return Math.round(s / 3600) + "h";
    return Math.round(s / 86400) + "d";
  };

  function appSummary(app) {
    const st = ctx.stateOf(app);
    const use = (ctx.statsPayload().apps || {})[app.id];
    const upd = ctx.updatesPayload().apps.find((u) => u.id === app.id) || {};
    return {
      name: app.name,
      id: app.id,
      category: st.category,
      running: st.runningCount === st.total ? (st.total ? "yes" : "no processes") : st.runningCount ? `${st.runningCount} of ${st.total} processes` : "no",
      up_for: ago(st.startedAt),
      ports: st.ports,
      cpu_percent: use && use.cpu != null ? Math.round(use.cpu * 10) / 10 : null,
      memory_mb: use ? mb(use.mem) : null,
      update_available: upd.behind ? `${upd.behind} new commit(s)` : undefined,
    };
  }

  // Wait for an app's processes to be gone (stopping is asynchronous).
  const stopped = (app) => new Promise((resolve) => ctx.waitStopped(app, resolve));

  const TOOLS = [
    {
      name: "list_apps",
      title: "List apps",
      description: "Every app Rack runs: whether it's running, for how long, its ports, CPU and memory, and whether an update is waiting.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      run: () => ({ apps: ctx.apps().map(appSummary) }),
    },
    {
      name: "get_app",
      title: "App details",
      description: "One app in detail: each process (command, folder, port, pid, uptime, error count, links), its update/rebuild commands and update status.",
      inputSchema: { type: "object", properties: { app: { type: "string", description: "App name (or id)" } }, required: ["app"] },
      annotations: { readOnlyHint: true },
      run: ({ app: ref }) => {
        const app = findApp(ref);
        const st = ctx.stateOf(app);
        const slots = ctx.slotsFor(app);
        const use = (ctx.statsPayload().apps || {})[app.id];
        const upd = ctx.updatesPayload().apps.find((u) => u.id === app.id) || {};
        return {
          ...appSummary(app),
          autostart: st.autostart,
          update_command: st.update,
          rebuild: st.rebuildStep,
          update_status: upd.behind ? `${upd.behind} new commit(s) waiting` : upd.reason || (upd.repo === false ? "not a git repo" : "up to date (as of the last check)"),
          processes: st.commands.map((c, i) => ({
            name: c.name,
            command: [c.exe, ...(c.args || [])].join(" "),
            folder: c.dir,
            port: c.effPort || c.port || null,
            running: c.running,
            pid: c.pid,
            up_for: ago(c.startedAt),
            errors_logged: slots[i] ? slots[i].errCount : 0,
            cpu_percent: use && use.cmds && use.cmds[i] && use.cmds[i].cpu != null ? Math.round(use.cmds[i].cpu * 10) / 10 : null,
            memory_mb: use && use.cmds && use.cmds[i] ? mb(use.cmds[i].mem) : null,
            links: c.links || undefined,
          })),
        };
      },
    },
    {
      name: "read_logs",
      title: "Read logs",
      description: "The recent console output of an app's processes (stdout and stderr, oldest first). errors_only keeps just stderr lines.",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", description: "App name (or id)" },
          process: { type: "string", description: "Process name, when the app has several (default: all)" },
          lines: { type: "integer", description: "How many of the latest lines per process (default 80, max 600)" },
          errors_only: { type: "boolean" },
        },
        required: ["app"],
      },
      annotations: { readOnlyHint: true },
      run: ({ app: ref, process: proc, lines = 80, errors_only = false }) => {
        const app = findApp(ref);
        const n = Math.max(1, Math.min(600, Number(lines) || 80));
        const slots = ctx.slotsFor(app);
        const pick = app.commands
          .map((c, i) => ({ c, i }))
          .filter(({ c }) => !proc || c.name.toLowerCase() === String(proc).toLowerCase());
        if (!pick.length) throw new Error(`${app.name} has no process called "${proc}". It has: ${app.commands.map((c) => c.name).join(", ")}.`);
        return {
          app: app.name,
          processes: pick.map(({ c, i }) => {
            const log = (slots[i] ? slots[i].log : []).filter((l) => !errors_only || l.s === "err");
            return {
              process: c.name,
              running: !!(slots[i] && slots[i].proc),
              log: log.slice(-n).map((l) => (l.s === "err" ? "! " : "  ") + l.line).join("\n") || "(nothing)",
            };
          }),
        };
      },
    },
    {
      name: "start_app",
      title: "Start app",
      description: "Start an app (every process it has that isn't already running).",
      inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      run: ({ app: ref }) => {
        const app = findApp(ref);
        const r = ctx.startApp(app);
        if (!r.ok) throw new Error(r.error || "It couldn't be started.");
        return { started: app.name, note: "Use read_logs in a few seconds to see it come up." };
      },
    },
    {
      name: "stop_app",
      title: "Stop app",
      description: "Stop an app and everything it started.",
      inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      run: async ({ app: ref }) => {
        const app = findApp(ref);
        const r = ctx.stopApp(app);
        if (!r.ok) throw new Error(r.error || "It couldn't be stopped.");
        const gone = await stopped(app);
        return { stopped: app.name, all_processes_gone: gone };
      },
    },
    {
      name: "restart_app",
      title: "Restart app",
      description: "Stop an app, wait for it to be gone, and start it again.",
      inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
      annotations: { readOnlyHint: false, destructiveHint: true },
      run: async ({ app: ref }) => {
        const app = findApp(ref);
        ctx.stopApp(app);
        if (!(await stopped(app))) throw new Error(`${app.name} didn't stop within 10 seconds — not starting it again over itself.`);
        const r = ctx.startApp(app);
        if (!r.ok) throw new Error(r.error || "It stopped, but couldn't be started again.");
        return { restarted: app.name, note: "Use read_logs in a few seconds to see it come up." };
      },
    },
    {
      name: "update_app",
      title: "Update app",
      description:
        "Run an app's update: its update command (usually git pull), then — only if new code arrived — its rebuild step and a restart. Waits for it to finish (up to 5 minutes) and returns the output.",
      inputSchema: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
      annotations: { readOnlyHint: false, destructiveHint: true },
      run: ({ app: ref }) => {
        const app = findApp(ref);
        return new Promise((resolve, reject) => {
          const out = [];
          const onEvent = (ev) => {
            if (ev.id !== app.id) return;
            if (ev.type === "update-log") out.push((ev.stream === "err" ? "! " : "  ") + ev.line);
            if (ev.type === "update-done") finish({ app: app.name, exit_code: ev.code, new_code: !!ev.changed, restarted: !!ev.restarted });
          };
          const timer = setTimeout(
            () => finish({ app: app.name, still_running: true, note: "Still going after 5 minutes — check get_app / read_logs later." }),
            UPDATE_WAIT_MS
          );
          const finish = (result) => {
            clearTimeout(timer);
            ctx.events.off("event", onEvent);
            resolve({ ...result, output: out.slice(-150).join("\n") });
          };
          ctx.events.on("event", onEvent);
          const r = ctx.updateApp(app);
          if (!r.ok) {
            clearTimeout(timer);
            ctx.events.off("event", onEvent);
            reject(new Error(r.error || "It couldn't be updated."));
          }
        });
      },
    },
    {
      name: "check_updates",
      title: "Check for updates",
      description: "Ask every app's git remote (and Rack's own) whether new commits are waiting. Takes a few seconds.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async () => {
        await ctx.checkUpdates();
        const u = ctx.updatesPayload();
        return {
          rack: { version: u.rack.version, update_available: u.rack.behind ? `${u.rack.behind} new commit(s)` : "no" },
          apps: u.apps
            .filter((a) => a.canUpdate)
            .map((a) => ({ app: a.name, update_available: a.behind ? `${a.behind} new commit(s)` : a.reason || (a.error ? "couldn't check: " + a.error : "no") })),
        };
      },
    },
    {
      name: "machine_stats",
      title: "Machine load",
      description: "The server's CPU, memory, free disk and uptime, and which apps use the most.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      run: () => {
        const s = ctx.statsPayload();
        const sys = s.system || {};
        const byApp = Object.entries(s.apps || {})
          .map(([id, u]) => ({ app: (ctx.apps().find((a) => a.id === id) || {}).name || id, cpu_percent: u.cpu != null ? Math.round(u.cpu * 10) / 10 : null, memory_mb: mb(u.mem), processes: u.procs }))
          .sort((a, b) => (b.memory_mb || 0) - (a.memory_mb || 0));
        return {
          hostname: sys.hostname,
          cpu_percent: sys.cpu != null ? Math.round(sys.cpu * 10) / 10 : null,
          cores: sys.cores,
          memory: sys.memTotal ? `${mb(sys.memUsed)} of ${mb(sys.memTotal)} MB used` : null,
          disk: sys.disk ? `${Math.round(sys.disk.free / 1073741824)} GB free of ${Math.round(sys.disk.total / 1073741824)} GB on ${sys.disk.path}` : null,
          uptime: sys.uptime ? ago(Date.now() - sys.uptime * 1000) : null,
          apps: byApp,
        };
      },
    },
    {
      name: "list_exposure",
      title: "What's exposed",
      description: "Every port on the machine that reaches beyond it — the tailnet or the public internet (Tailscale Funnel, Cloudflare tunnels) — and the app or program behind it.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      run: async () => {
        const e = await ctx.exposureState(false);
        return {
          listening_beyond_this_pc: (e.listeners || [])
            .filter((l) => l.reach === "public" || l.reach === "tailnet")
            .map((l) => ({
              port: l.port,
              reach: l.reach,
              app: l.owner ? `${l.owner.appName} / ${l.owner.procName}` : null,
              program: l.process || null,
              urls: [...(l.shares || []).map((s) => s.url), ...(l.tunnels || []).map((t) => t.url)].filter(Boolean),
            })),
          lan_ports: (e.listeners || []).filter((l) => l.reach === "lan").map((l) => l.port),
        };
      },
    },
    {
      name: "update_rack",
      title: "Update Rack",
      description: "Pull Rack's own new code and restart Rack. Apps keep running and Rack reconnects to them. Only works when Rack was started from start.bat.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: false },
      run: () => {
        const r = ctx.selfUpdate();
        if (!r.ok) throw new Error(r.error || "Rack couldn't update itself.");
        return { started: true, note: "Rack pulls and, if anything new arrived, restarts within a few seconds. Check list_apps afterwards." };
      },
    },
  ];

  function listForClient() {
    return TOOLS.map(({ run, ...t }) => t);
  }

  async function callTool(name, args) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return null;
    try {
      const out = await tool.run(args || {});
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out };
    } catch (e) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  }

  /* --------------------------------------------------------- the endpoint */

  const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

  async function mcp(req, res) {
    if (!authorised(req))
      return json(res, 401, { error: "invalid_token", error_description: "Sign in to Rack first." }, {
        "WWW-Authenticate": `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource/mcp"`,
      });
    let msg;
    try {
      msg = JSON.parse(await readRaw(req));
    } catch {
      return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const reply = (id, result) => ({ jsonrpc: "2.0", id, result });
    const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
    const handle = async (m) => {
      if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return error(null, -32600, "Invalid request");
      if (m.id === undefined || m.id === null) return null; // a notification — nothing to say back
      const p = m.params || {};
      switch (m.method) {
        case "initialize":
          return reply(m.id, {
            protocolVersion: VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : VERSIONS[1],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "rack", title: "Rack", version: ctx.VERSION },
            instructions: INSTRUCTIONS,
          });
        case "ping":
          return reply(m.id, {});
        case "tools/list":
          return reply(m.id, { tools: listForClient() });
        case "tools/call": {
          const r = await callTool(p.name, p.arguments);
          return r ? reply(m.id, r) : error(m.id, -32602, `Unknown tool: ${p.name}`);
        }
        case "resources/list":
          return reply(m.id, { resources: [] });
        case "prompts/list":
          return reply(m.id, { prompts: [] });
        default:
          return error(m.id, -32601, `Method not found: ${m.method}`);
      }
    };
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map(handle))).filter(Boolean);
      if (!out.length) return res.writeHead(202).end();
      return json(res, 200, out);
    }
    const out = await handle(msg);
    if (!out) return res.writeHead(202).end();
    json(res, 200, out);
  }

  async function route(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    try {
      if (req.method === "GET" && /^\/\.well-known\/oauth-protected-resource(\/mcp)?$/.test(p)) return json(res, 200, protectedResource(req));
      if (req.method === "GET" && /^\/\.well-known\/(oauth-authorization-server(\/mcp)?|openid-configuration)$/.test(p))
        return json(res, 200, serverMetadata(req));
      if (p === "/oauth/register" && req.method === "POST") return await register(req, res);
      if (p === "/oauth/authorize" && (req.method === "GET" || req.method === "POST")) return await authorize(req, res, url);
      if (p === "/oauth/token" && req.method === "POST") return await token(req, res);
      if (p === "/mcp" && req.method === "POST") return await mcp(req, res);
      if (p === "/mcp") return json(res, 405, { error: "Use POST." }, { Allow: "POST" });
      if (p === "/")
        return page(res, 200, "This is Rack's Claude connector. Add https://<this address>/mcp in Claude → Settings → Connectors.");
      json(res, 404, { error: "Not found" });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e.message });
    }
  }

  /* ------------------------------------------------------ on / off, settings */

  let server = null;
  let listenError = null;
  function listen() {
    if (server || !data.enabled) return;
    listenError = null;
    server = http.createServer(route);
    server.on("error", (e) => {
      listenError = e.code === "EADDRINUSE" ? `Port ${data.port} is already in use.` : e.message;
      console.log("Claude connector: " + listenError);
      server = null;
    });
    server.listen(data.port, () => console.log(`Claude connector (MCP) on port ${data.port}`));
  }
  function close() {
    if (server) server.close();
    server = null;
  }

  function status() {
    return {
      enabled: !!data.enabled,
      key: data.enabled ? data.key : null,
      port: data.port,
      listening: !!server && !listenError,
      error: listenError,
      connected: Object.values(data.tokens).filter((t) => t.kind === "refresh" && t.expires > now()).length,
    };
  }

  // POST /api/mcp {action: "enable" | "disable" | "new-key", port?}
  function configure({ action, port }) {
    if (port != null) {
      const n = Number(port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, error: "That isn't a port number." };
      if (n !== data.port) {
        data.port = n;
        close();
      }
    }
    if (action === "enable") {
      data.enabled = true;
      if (!data.key) data.key = random(24);
    } else if (action === "disable") {
      data.enabled = false;
      close();
    } else if (action === "new-key") {
      // Signs every connected Claude out: their tokens were issued against the old key.
      data.key = random(24);
      data.tokens = {};
      data.clients = {};
    }
    save();
    listen();
    return { ok: true, ...status() };
  }

  listen();
  return { status, configure, close };
}

module.exports = { create, DEFAULT_PORT };
