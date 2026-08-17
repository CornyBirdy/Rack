# Changelog

## v0.6
- **Cloudflare Tunnel** — publish a process on a permanent hostname of your own
  domain (`app.example.com`), not just a Tailscale address.
- The Funnel dropdown became a single **Public** dropdown covering both
  providers. One process, one public route.
- **＋ New tunnel…** creates the tunnel and its DNS record for you and shows the
  live `cloudflared` output. Installing cloudflared and `cloudflared tunnel
  login` stay manual — that login is a browser flow Rack won't drive.
- Rack runs `cloudflared` itself, so a tunnel is always torn down with the
  process it publishes — no public URL left answering 502s.
- **auto** checkbox per process: bring the tunnel up whenever the process runs.
- A named tunnel can only be bound to one process (running one twice makes
  Cloudflare split traffic between them). Failures show `● failed` with a
  **log ↗** into the last 200 lines of cloudflared output.

## v0.5
- **⟳ Update now rebuilds too** — if the app's folder has a `rebuild.bat`, it
  runs straight after the update command, in the same live log. One click is
  pull → build.
- Rack stops the app before the build (a build can't overwrite files a running
  server holds open) and starts it again once the build succeeds. A failed pull
  skips the build; a failed build leaves the app stopped.
- New **Rebuild command** field in the app editor and `rebuild` in `rack.json` —
  point it at a different build command, or `off` / `false` to skip it.
- Apps with only a `rebuild.bat` and no update command get the button too.

## v0.4
- **Copy SDK prompt** — grab a ready-made prompt for your AI coding tool that
  makes a new project Rack-ready. In the ⚙ menu, and linked from **+ Add app**.
- Falls back to a selectable text box when the clipboard isn't reachable (which
  happens when Rack is opened over plain `http` on a LAN or Tailscale address).
- The prompt lives in `SDK-PROMPT.md`, so you can edit it without touching code.

## v0.3
- **Tailscale Funnel** — each process that serves a port gets a Funnel dropdown
  (443 / 8443 / 10000), a **Public URL** link, and a green `● public` marker.
- Ports already funnelled by another process show as *in use* and can't be
  double-booked; switching ports turns the old funnel off first.
- Tailscale state is read live, so funnels set outside Rack also show up.
- Added this changelog — click the version in the ⚙ menu.

## v0.2
- Renamed the app to **Rack** (manifest is now `rack.json`, env vars `RACK_*`;
  the old `multiapp.json` and `MAC_*` names still work).
- **One-click "Update Rack"** — pulls the new version and restarts itself via a
  supervisor loop in `start.bat`, then brings your running apps back.
- **⚙ settings menu** in the sidebar — Theme and Run-on-boot moved here so
  controller-wide settings aren't confused with per-app buttons.
- Version indicator in the settings menu.
- Per-app **⟳ Update** button that runs the app's own update command (`git pull`).

## v0.1
- Run several **processes per app**, each with its own live console — nothing
  opens in a stray window.
- Run / Kill, live stdout + stderr, per-console Clear and a `⚠` error badge with
  an errors-only view.
- **`rack.json` manifest** — point Rack at a folder and every process imports in
  one click, with ports injected as environment variables at runtime.
- PocketBase auto-detection with automatic free-port assignment; conflict
  warnings for ports hardcoded inside a `.bat`.
- Collapsible sidebar **categories**, per-app **auto-start**, and **run on boot**.
- **Stop commands** for graceful teardown (e.g. `docker compose down`).
- Dark / light mode.
