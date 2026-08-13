# Rack

A tiny dashboard to run and monitor all your apps from one place — PocketBase
or anything else that starts from a terminal. An app can run **several
processes at once**, each captured in its own console inside the dashboard (so
nothing pops up in a stray window). Zero dependencies — just Node.js.

## Run it

Double-click **start.bat**. It starts the controller and opens the dashboard
in your browser at http://localhost:7799. Closing the window kills the
controller and every app it started.

## Add an app

Click **+ Add app**, give it a name, and add one or more **processes**. Each
process is one of:

- a **folder** (auto-picks `pocketbase.exe`, then a `start/run/launch` .bat,
  then a lone .exe),
- a file directly — an **.exe**, **.bat**, or **.cmd**, or
- a **typed command** like `npm run start` (set the *Working folder* so it runs
  in the right place).

Each process can take optional **arguments** and a **port**. Press **▶ Run** and
every process starts together; each gets its own console on the right.

## Ports (auto-managed)

- **PocketBase** processes are detected automatically. The controller assigns
  each one a free port and its `serve --http=...` command, plus quick links to
  the server page, admin UI, and API.
- Type a **port** on any process to tell the controller it's in use. If two apps
  clash, the controller **moves the ones it controls** (PocketBase) to a free
  port and tells you. Ports baked inside a `.bat` can't be moved — those show a
  clear **conflict warning** instead.

> Tip: your `start-prod.bat` hardcodes 8090/3000 internally, so the controller
> can't rewrite those. To let it manage the ports and show both consoles, add
> the two servers as separate processes (a PocketBase process + an
> `npm run start` process) instead of the all-in-one `.bat`.

## Consoles

- **Terminals · N running** shows how many processes are live.
- The **Show [1 / 2 / 3 / All]** dropdown controls how many consoles are visible
  at once; the rest scroll.
- Each console has a **Clear** button and a **⚠ error badge** that counts
  stderr lines and pulses when a new one arrives — click it to show errors only.

## One-click import with a manifest (recommended)

An app can describe itself with a **`rack.json`** in its folder (the legacy name
`multiapp.json` still works). Then just **+ Add app → point at the folder →
Save**, and every process is imported with the right names, ports, links, and
setup hint — no manual typing. Rack also injects each process's port as an
environment variable at runtime, so ports stay declared in one place. See
**RACK-SDK.md** for the format.

## Copy SDK prompt

Building a new app you want Rack to run? Open **⚙ → Copy SDK prompt** (also
linked from **+ Add app**) and paste it into your AI coding tool. It tells the
model exactly how to make the project Rack-ready: foreground launcher scripts,
ports read from environment variables, and a `rack.json` manifest — so afterwards
you just point Rack at the folder.

The prompt lives in `SDK-PROMPT.md`, so you can tweak it without touching code.

## Categories

Give an app a **Category** (in the editor) and the sidebar groups apps under
collapsible headers, like a Discord channel list. Apps with no category sit at
the top. Collapse state is remembered per browser.

## Controller settings (⚙)

The **⚙** button in the sidebar header (top-left) holds controller-wide settings
— **Theme** and **Run on boot** — kept separate from the per-app buttons so it's
clear what acts on the controller vs. the selected app.

- **Run on boot** installs/removes a Windows Startup entry that launches the
  controller (hidden) when you log in.
- Tick **"Start automatically when the controller launches"** in an app's editor
  to have that app come up on its own — so after a reboot, your usual apps are
  back. Apps show a ⚡ badge in the sidebar when auto-start is on.

## Updating a deployed app (⟳ Update)

Give an app an **Update command** (in the editor, e.g. `git pull`) and a **⟳
Update** button appears. Click it to fetch a new version and watch the output
stream live. Because machine-specific state (`.env`, databases, build output) is
git-ignored, an update only changes code — your data stays put.

**Apps that need compiling** get a second step for free: if the app's folder has
a **`rebuild.bat`**, Rack runs it right after the update, in the same log. Since
a build can't overwrite files a running server is holding open, Rack stops the
app before building and starts it again once the build succeeds — so one click
is pull → build → back up. A failed pull skips the build, and a failed build
leaves the app stopped so you never run half-built code.

Fill in **Rebuild command** in the editor to point at a different build command,
or type `off` to skip the rebuild entirely.

## Tailscale Funnel (public access)

If Tailscale is installed and logged in on the machine running Rack, each process
that serves a port gets a **Funnel** dropdown in its details card. Pick a public
port and Rack runs the Tailscale command for you, then shows a **Public URL**
link and a green **● public** marker.

Funnel only allows three public ports — **443, 8443, and 10000** — so you can
expose **up to three processes at once** (this is a Tailscale limit, not a plan
limit; Funnel is available on all plans including the free one). A port already
used by another process shows as *in use* and can't be picked twice. Switching a
process to a different public port turns the old one off first, so you never
leave a stray funnel behind.

> Anything you funnel is reachable from the **public internet** — only turn it on
> for services you intend to share.

## Docker (and other graceful stops)

Add a process with command `docker compose up` and a **Stop command** of
`docker compose down`. Run streams the compose logs into the console; Stop runs
`down` for a clean teardown, then kills the process. The Stop command works for
anything that needs a graceful shutdown, not just Docker.

## Rename or change an app

Click the app's name in the top bar (or **✎ Edit**) to rename it, change its
category, toggle auto-start, edit any process, or add/remove processes. Changes
take effect the next time you Run it.

Registered apps are stored in `apps.json` next to the server. Removing an app
from the dashboard never deletes its files.
