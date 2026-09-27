# Rack

A tiny dashboard to run and monitor all your apps from one place — PocketBase
or anything else that starts from a terminal. An app can run **several
processes at once**, each captured in its own console inside the dashboard (so
nothing pops up in a stray window). Zero dependencies — just Node.js.

## Run it

Double-click **start.bat**. It starts the controller and opens the dashboard
in your browser at http://localhost:7799. Closing the window kills the
controller and every app it started.

## Install from GitHub

Set your **apps folder** once (⚙ → **Apps folder**) — that's where Rack keeps
the apps it installs. Then **+ Add app**, paste a repository link into
**Install from GitHub**, and press **Install**:

```
https://github.com/owner/repo      owner/repo      git@github.com:owner/repo.git
```

Rack clones it into the apps folder, runs the repo's `setup` and build steps,
imports its `rack.json` if it has one (see below), and adds the app — with
`git pull` already set as its **⟳ Update** command. A `/tree/<branch>` link
clones that branch; a repo you've already cloned there is imported instead of
re-cloned. Needs `git` on your PATH.

## Add an app by hand

Click **+ Add app → From this PC**, give it a name, and add one or more
**processes**. A process is one line — the command and, if it needs one, a port;
**⋯** opens its console name, arguments, working folder and stop command, and
**Advanced** holds autostart plus the update / rebuild commands. Each process is
one of:

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

## Organizing the sidebar

### Categories

Give an app a **Category** (in the editor) and the sidebar groups apps under
collapsible headers, like a Discord channel list. Apps with no category sit at
the top. Collapse state is remembered per browser.

### Drag to arrange

**Drag an app** to put it where you want it: up or down inside its group, or
onto another category's header to move it there (a collapsed category opens so
you can see where it landed). While you drag, a **no category** strip appears at
the top of the list — drop an app there to take its category off again.

**Drag a category header** to move the whole group, apps and all. Uncategorized
apps stay pinned at the top.

The order you arrange is the order Rack saves in `apps.json`, so it survives a
restart and is the same in every browser.

### Filter

The box above the list filters apps as you type, matching the app name, its
category, and its process names — so typing `pocketbase` finds every app with a
PocketBase console. Press **/** (or Ctrl+K) from anywhere to jump to it,
**Enter** to open the first match, and **Esc** to clear. Categories expand while
you're filtering, and dragging is off — the order you see isn't the whole list.

## Controller settings (⚙)

The **⚙** button in the sidebar header (top-left) holds controller-wide settings
— **Theme**, **Run on boot**, and the **Exposure manager** — kept separate from the
per-app buttons so it's clear what acts on the controller vs. the selected app.

- **Run on boot** installs/removes a Windows Startup entry that launches the
  controller (hidden) when you log in.
- Tick **"Start automatically when the controller launches"** in an app's editor
  to have that app come up on its own — so after a reboot, your usual apps are
  back. Apps show a ⚡ badge in the sidebar when auto-start is on.

## Exposure manager (⚙ → ◎)

Everything on this machine that can be reached from somewhere else, and every
way to change that, in one place. Open it from **⚙ → ◎ Exposure manager**, or
from **◎ Exposure manager** on any process's card — that opens it with the
process already picked and its rows highlighted.

**Expose** at the top is the one form for sharing anything: pick *what* (a Rack
app's process, any other program listening on this PC, or a port you type),
*to* (tailnet only, the internet through Tailscale Funnel, or the internet
through a Cloudflare tunnel) and *on* (which Tailscale port, or which tunnel).
Picking a port that's already in use says what it will replace. Anything headed
for the internet asks first.

Below it, every exposure method is listed **with what's using it**:

- **Tailscale** — each port (443, 8443 and 10000, plus any other port you've
  shared) with its URL, whether it reaches the internet or only your tailnet, and
  the **app and process** behind it (or the program name and PID when Rack
  doesn't run it). Free ports say so and have **Use…**. A share pointing at a port
  nothing listens on — or at a stopped app — is flagged. **Tailnet only**,
  **Open to internet** and **Stop** change a share in place.
- **Cloudflare tunnels** — every named tunnel in your account: which app it
  publishes, its hostname, and whether it's up. **auto**, **Connect** /
  **Disconnect**, **Log** and **Stop** (which frees the tunnel) are here; a free
  tunnel has **Use…**.
- **Tunnels Rack didn't start** — a stray `cloudflared`, `ngrok` or `frpc` from
  someone's `run-tunnel.bat` is listed with the port and app it publishes, so it
  can't hide. Close its window to stop it.
- **Listening ports** — every port on the machine with the program behind it and
  how far it reaches, each with **Expose…**:

| Badge | Means |
|---|---|
| **This PC only** | Bound to `127.0.0.1`. Nothing off this machine can reach it. |
| **Local network** | Bound to `0.0.0.0`, so anything on your LAN can reach it. |
| **Tailnet** | Tailscale `serve`. Only devices signed in to your tailnet. |
| **Internet** | Tailscale Funnel or a tunnel, so anyone with the URL. |

> Run Rack as administrator to see the program behind system ports. Windows
> hides the name and path of other users' processes from a normal user; the
> manager says so when that's the case.

## Checking for updates (⚙ → ⟲ Check for updates)

Rack can tell you what's out of date **without running anything**. It does a
`git fetch` in Rack's own folder and in every app that has an update command,
then compares your checkout against the branch it tracks:

- Apps with new commits get a **⟳** badge in the sidebar, and their **⟳ Update**
  button reads **Update — 3 new**.
- The app's details card lists the incoming commit subjects, so you can see
  what's coming before you pull.
- The menu item itself summarizes — *Update available: Rack + 2 apps*, or *Up to
  date · checked 5m ago*.

It also checks on its own: 20 seconds after Rack starts, every 6 hours, and
after any update runs. Nothing is ever pulled by a check — it only looks.

An app whose folder isn't a git checkout says so (Rack can't know what a custom
update script will do); press **⟳ Update** to find out. A repo it can't reach —
no network, credentials needed — reports that instead of hanging: checks can't
raise a password prompt and give up after 45 seconds.

## Updating Rack itself (⚙ → ⟳ Update Rack)

**⟳ Update Rack** pulls Rack's own repo and restarts the controller, bringing
back whatever was running before. When there are new commits waiting it reads
**Update Rack — 3 new**. It needs Rack to have been started from **start.bat**,
whose supervisor loop is what relaunches it; started any other way the item is
hidden and you update with a `git pull` in Rack's folder. A pull with nothing in
it just says you're already on the latest version.

## Updating a deployed app (⟳ Update)

Give an app an **Update command** (in the editor, e.g. `git pull`) and a **⟳
Update** button appears. Click it to fetch a new version and watch the output
stream live. Because machine-specific state (`.env`, databases, build output) is
git-ignored, an update only changes code — your data stays put.

**Nothing new? Nothing happens.** Rack compares the commit before and after the
update command, and if the checkout didn't move it skips the rebuild and the
restart and says *already up to date* — a pointless build never runs, and a
running app is never interrupted. (Outside a git checkout Rack goes by what the
command printed, and assumes new code if it can't tell.)

**New code always ends up running.** If the app was up when the update brought
something new, Rack restarts it onto the new version — with or without a build
step.

**Apps that need compiling** get that build for free: if the app's folder has a
**`rebuild.bat`**, Rack runs it right after the update, in the same log. A build
can't overwrite files a running server holds open, so Rack stops the app first,
waits for its processes to actually exit, builds, then starts it again — one
click is pull → build → back up.

The update command itself runs with the app still up, so a **failed update
leaves the app exactly as it was**, still running. A failed *build* leaves the
app stopped, so you never run half-built code.

Fill in **Rebuild command** in the editor to point at a different build command,
or type `off` to skip the rebuild entirely.

## Public access

Each process that serves a port shows how it's exposed in its details card —
**● Internet · Funnel :8443**, **● Tailnet · :443**, a Cloudflare tunnel and its
state, or *Not exposed* — with a link to each public URL. Changing any of it is
done in the **◎ Exposure manager** (the button on the same line), which sees
every route on the machine at once. A process can be on more than one route.

### Tailscale Funnel

If Tailscale is installed and logged in on the machine running Rack, pick a
Tailscale port in the Exposure manager and Rack runs the Tailscale command for
you. **Tailnet only** uses `tailscale serve`; **Internet** uses Funnel.

Funnel only allows three public ports — **443, 8443, and 10000** — so you can
expose **up to three processes at once** (this is a Tailscale limit, not a plan
limit; Funnel is available on all plans including the free one). Pointing a port
that's already in use at something else turns the old share off first, so you
never leave a stray funnel behind.

### Cloudflare Tunnel

Gives a process a **permanent hostname on your own domain** — `app.example.com`
— instead of a Tailscale address. Rack supports *named* tunnels only, so this
needs a Cloudflare account and a domain on Cloudflare. Two one-time steps, by
hand, in a terminal:

```
winget install --id Cloudflare.cloudflared
cloudflared tunnel login
```

You don't have to type either one. Open **⚙ → Set up Cloudflare** and press
**▶ Run** on each step — Rack runs the command as a supervised child, streams the
output, and ticks the step off when it succeeds. **Stop** cancels a running step.
Clicking the command itself still copies it, which is what you want if the
install comes back needing an admin terminal. The menu item reads **Cloudflare:
ready** once both steps are done.

Two things Rack can't do for you: approving the Windows permission prompt the
install may raise, and picking your domain in the browser window the login opens
(it writes credentials to `~/.cloudflared`, then the dialog catches up on its
own). A login left unfinished is given up on after 10 minutes.

Once that's done, pick a Rack process in the Exposure manager, **Internet
(Cloudflare)**, then **＋ New tunnel…**, give it a name and a hostname, and Rack
runs `cloudflared tunnel create` and `cloudflared tunnel route dns` for you,
streaming the output. The tunnel is then bound to that process until you
**Stop** it; one tunnel serves one process. Cloudflare tunnels are for Rack's own
processes, since Rack runs `cloudflared` alongside them — use Tailscale for
anything else on the machine.

Unlike Tailscale — whose daemon holds a funnel up on its own — `cloudflared` is a
process Rack runs and supervises. That means:

- A tunnel is **always stopped with the process it publishes**, including when
  that process crashes or when Rack shuts down. A public hostname never outlives
  the thing behind it.
- Tick **auto** (in the Exposure manager) to bring the tunnel up automatically
  whenever the process runs; leave it off and use **Connect** by hand.
- If cloudflared fails, the tunnel shows **Failed** with the reason — **Log**
  has the last 200 lines of output.

> Anything you publish is reachable from the **public internet** — only turn it
> on for services you intend to share. `cloudflared tunnel route dns` writes a
> real DNS record into your Cloudflare zone.

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
