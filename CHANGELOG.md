# Changelog

## Unreleased
- **+ Add app stays in reach on a phone.** It's pinned to the bottom of the
  app list instead of sitting below the last app, so it no longer scrolls off
  screen once you have a few apps.

## v0.13.5
- **The Rack Suite design system.** Rack, MC Hoster and Shelf now share one
  set of blue/grey neutrals, shapes and soft buttons; each app has its own
  accent, and Rack's is coral (Run, the selected app, switches, focus and the
  CPU/disk meters). Memory charts are blue. Success, warning, danger and info
  are the same colours in every app. Secondary buttons have a hairline
  border. Dark and light both follow the new palette, as does the Claude
  connector's sign-in page.
- **A new icon:** a duotone coral rack of three units on the suite's dark
  tile, in the tab, the installed app and the top of the sidebar.

## v0.13.4
- **Twilight, refined.** Dark is deeper and less pastel: richer teal for what
  you act on, and clearer green, amber, red and blue for statuses. Light is
  calmer: softer whites and slightly softer text, so it no longer glares.
- **A new icon** in the Rack Suite style shared with MC Hoster, Shelf and
  Cascade: a teal mark on a dark rounded tile, also at the top of the sidebar.
- **Smoother.** Picking an app or the overview brings its page in, dialogs
  and the ⚙ menu fade in and out instead of popping, and buttons and list
  rows ease on hover and press. On a phone an app slides in from the side and
  dialogs rise from the bottom. Nothing moves if your device asks for less
  motion.

## v0.13.3
- **New look: the Rack Suite "Twilight" palette**, replacing Sunset. Dark
  graphite with a faint periwinkle tint, teal for the things you act on — Run,
  the selected app (with a teal stripe down its left edge), switches, focus
  and the CPU/disk meters — and periwinkle for the memory charts. Buttons are
  soft now: a raised fill with a faint ring instead of a hard outline, Run in
  solid teal and Kill / Remove app as a red tint. Every control shows the same
  teal focus ring. Light theme is still under ⚙ → Theme.

## v0.13.2
- **New look: the Rack Suite "Sunset" palette.** Dark is the main theme and
  light is still one click away (⚙ → Theme). Periwinkle is the one action
  colour — Run, selected items, focus and toggles — and charts take periwinkle,
  pink and orange in turn. Every status says what it is in words and an icon,
  not just a colour: ✓ Running, ■ Stopped, ⚠ High / ⚠ Critical on a busy CPU,
  memory or disk, and "⚠ 2 errors" on a console. Buttons and inputs are a
  steady 32px high (44px on touch screens) and the sidebar is a little wider.
  Consoles stay dark in both themes.

## v0.13.1
- **Update checks are much faster.** Rack and every app are checked at the same
  time instead of one after another, and the fetch skips tags and git's
  auto-maintenance pass.
- **No more ⟲ Check for updates button.** The ⚙ menu just says whether there's
  an update — *Everything is up to date*, or **⟳ Update Rack — 3 new**, which is
  the button to install it. Rack keeps that fresh itself: every 30 minutes
  (was 6 hours) and whenever you open the menu on an answer over 5 minutes old.

## v0.13.0
- **Updating Rack no longer restarts your apps.** Every process now runs under a
  small host process of its own (`lib/host.js`) that holds its console, instead
  of being Rack's child — so ⟳ Update Rack, Rack crashing or Rack being killed
  leaves your apps running. When Rack comes back it reconnects to each one: the
  console is as it was, with whatever was printed meanwhile, and Stop, Restart,
  stats and ports all work as before. Cloudflare tunnels are kept the same way,
  so a public URL doesn't blink during an update. Closing Rack's window or
  Ctrl+C still stops everything. **⚙ → Keep apps running on update** switches
  back to the old behaviour (stop, update, start again).
- **New: ✳ Claude connector** (⚙ menu) — an MCP server so Claude can list your
  apps, read their logs, start/stop/restart and update them, check for
  updates, see machine load and what's exposed, and update Rack. It runs on a
  port of its own (7800) that answers only the connector, so it can be
  published with Funnel for claude.ai without publishing the dashboard. Sign-in
  is an access key Rack makes: Claude Code sends it as a header, claude.ai asks
  for it once on an OAuth sign-in page. **New key** signs every Claude out.

## v0.12.0
- **Usage stats.** Every running app shows its CPU and memory live: beside its
  name in the sidebar, as CPU / Memory tiles with a 10-minute sparkline on the
  app, and per process in Details along with how many processes it runs. An app
  counts its whole process tree — a `.bat` that starts node that forks workers
  is one number.
- **New: ▦ Overview** at the top of the sidebar — machine CPU, memory, free disk
  and uptime, and every app side by side, sorted by CPU, memory or name. Tap a
  row to open the app.
- **Works on a phone.** Under ~760px wide the app list and the app become two
  pages with a ‹ back button (the phone's back gesture works too), the panels
  stack, consoles get a sensible height, and dialogs open as bottom sheets.
  Narrow desktop windows and unfolded phones stack details above the consoles.
- Add to Home screen gets a proper Rack icon and name.

## v0.11.0
- **"What's exposed" is now the ◎ Exposure manager.** It used to be a read-out
  with a Share button bolted on; now it's where exposing things happens. One
  **Expose** form at the top — what (a Rack process, any listening program, or a
  typed port), to (tailnet, internet via Funnel, internet via Cloudflare) and on
  (which Tailscale port or tunnel) — says what a busy port would replace and asks
  before anything goes on the internet.
- **Every exposure method shows what's using it.** Each Tailscale port (443,
  8443, 10000, and any other you've shared) and each Cloudflare tunnel in your
  account is listed, taken or free, with the **app and process** behind it — or
  the program name and PID when Rack doesn't run it. A share pointing at a
  stopped app, or at a port nothing is listening on, is flagged.
- **Change a route in place:** Tailnet only / Open to internet / Stop on a
  Tailscale port; auto, Connect / Disconnect, Log and Stop on a tunnel; Use… on
  anything free.
- **The per-process Public dropdown is gone.** A process's card now shows how
  it's exposed (Funnel, tailnet, Cloudflare — with their URLs) and a
  **◎ Exposure manager** button that opens the manager with that process picked.

## v0.10.0
- **New: ⚙ → 🔒 What's exposed.** Rack knew the ports of the apps it runs, which
  left the rest of the machine a blank — a funnel on 8443 said `localhost:2283`
  and nothing about what 2283 was. This lists every listening port on the machine
  with the program behind it, naming the **Rack app and process** where Rack runs
  it, and marks how far each one reaches: this PC, the LAN, your tailnet, or the
  open internet. Anything published right now is called out at the top, the
  internet-facing list first.
- **Tunnels Rack didn't start are listed too.** A stray `cloudflared` from a
  `run-tunnel.bat` was invisible to Rack even while it published a port. It now
  shows up beside the funnels, matched to the port it publishes.
- **Sharing from the same view.** Any port on the machine can be shared on your
  tailnet or opened to the internet, not just the ports of apps Rack runs. Ports
  already funnelled say which app holds them.
- Run Rack as administrator for the program behind system ports — Windows hides
  that from a normal user, and the view now says so rather than showing blanks.

## v0.9.1
- **Fix: an installed app that Rack couldn't run.** A manifest process with
  `"dir": "."` — straight out of the SDK example — had its working folder
  resolved against whatever directory Rack itself was started from, so the app
  ran in Rack's own folder instead of its own, with its command left unresolved.
  `dir` is now always relative to the app's folder, as RACK-SDK says. An app
  already added that way needs its working folder fixed in ✎ Edit, or a
  remove + re-install.
- **Fix: a failed `setup` no longer throws the install away.** The clone is on
  disk either way, so the app is added and the log says which step failed —
  fix it and press ⟳ Update. Only the clone itself can stop an install now.
- **Fix: `setup.bat` is found.** A setup or build command naming a script in the
  app's folder runs by its full path, instead of relying on the shell to look in
  the current directory (which Windows can be configured not to do).
- **Fix: a script that ends in `pause` can't hang an install or an update.**
  Rack runs these steps with no stdin, so a prompt nobody can answer returns
  straight away instead of waiting forever. A step still running after 10
  minutes is stopped and the install carries on.

## v0.9
- **Apps folder** (⚙ menu) — one folder where Rack keeps the apps you install.
- **Install from GitHub** — paste a repo link into **+ Add app** and press
  **Install**. Rack clones it into the apps folder, runs the repo's `setup` and
  build steps, imports its `rack.json`, and the app appears in the sidebar
  ready to run. Repos without a manifest still land as an app — Rack
  auto-detects what to run, same as pointing at a folder.
- Installed apps get `git pull` as their **⟳ Update** command automatically.
- Full `https://` links, `git@host:owner/repo.git` and `owner/repo` shorthand
  all work; a `/tree/<branch>` link clones that branch. An already-cloned
  folder is imported instead of re-cloned.
- **The Add app dialog stopped being a wall of fields.** It opens on two tabs —
  *From GitHub* (link + Install, nothing else) and *From this PC* — a process is
  one line (command + port) with name, arguments, working folder and stop
  command behind ⋯, and autostart / update / rebuild behind **Advanced**.
  Editing an app opens whichever of those it actually uses.
- Fix: a manifest process with a **typed command** (`npm run start`) now runs in
  the app's folder, as RACK-SDK documents — it used to run next to Rack.

## v0.8
- **⟳ Update only rebuilds when there's actually something new.** Rack compares
  the checked-out commit before and after the update command; if nothing moved,
  the rebuild and the restart are skipped and the log says *already up to date*.
  Outside a git checkout it falls back to what the command printed.
- **An update that brings new code now restarts the app** even when there's no
  rebuild step — previously a plain `git pull` left the old code running.
- **The app isn't stopped until there's a reason to stop it.** The update
  command runs while the app is up, so a "nothing to pull" update no longer
  interrupts anything, and a *failed* update leaves the app running instead of
  stopping it and never bringing it back.
- Before a rebuild, Rack now waits for the app's processes to really be gone —
  a build can't overwrite files they still hold open.
- **⟲ Check for updates** in the ⚙ menu — one `git fetch` per repo tells you
  what's behind without running anything: Rack itself and every app with an
  update command.
  - Apps with new commits get a **⟳** badge in the sidebar; the ⟳ Update button
    reads *Update — 3 new*; the details card lists the incoming commit subjects.
  - The menu item summarizes ("Update available: Rack + 2 apps") and, when
    everything is current, says when it last checked.
  - Runs on its own 20s after Rack starts, every 6 hours, and after any update.
  - Checks can't hang on a credential prompt (`GIT_TERMINAL_PROMPT=0`, 45s cap)
    and a repo that can't be reached reports the reason instead of failing
    silently.
- New endpoints: `GET /api/updates`, `POST /api/updates/check`.

## v0.7
- **Drag apps around the sidebar** — reorder them inside a group, or drop one on
  a category header to move it there. The header's category opens on drop so you
  can see where the app landed.
- A **no category** strip appears at the top of the list while you drag, for
  taking an app back out of its category.
- **Drag a category header** to move the whole group, apps and all.
  Uncategorized apps stay pinned at the top.
- The order is saved in `apps.json` (new `POST /api/apps/reorder`), so it
  survives a restart and looks the same in every browser.
- **Filter box** above the app list — matches app names, categories and process
  names. **/** or Ctrl+K jumps to it, **Enter** opens the first match, **Esc**
  clears it. Collapsed categories open while filtering, and dragging is off
  because a filtered list isn't the real order.

## v0.6
- **Cloudflare Tunnel** — publish a process on a permanent hostname of your own
  domain (`app.example.com`), not just a Tailscale address.
- The Funnel dropdown became a single **Public** dropdown covering both
  providers. One process, one public route.
- **＋ New tunnel…** creates the tunnel and its DNS record for you and shows the
  live `cloudflared` output. Installing cloudflared and `cloudflared tunnel
  login` stay manual — that login is a browser flow Rack won't drive.
- **Set up Cloudflare** in the ⚙ menu runs both prerequisite commands for you —
  press **▶ Run** on each and watch the output; the step ticks itself off when
  it succeeds. The commands still copy on click, for when a step needs an admin
  terminal. The per-process dropdown stays hidden until cloudflared exists, so
  this is where you find the feature before it's installed. Reads **Cloudflare:
  ready** once you're set up.
- Setup steps are supervised like any other process: **Stop** cancels one, they
  can't run two at a time, and a login left waiting on a browser gives up after
  10 minutes instead of hanging around forever.
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
