This project must be launchable by **Rack**, a local app manager that runs each
process in the foreground and captures its output as a live console. Make this
project Rack-compatible by adding launcher scripts and a `rack.json` manifest,
following the contract below. Don't change application logic; keep any existing
standalone launchers working.

## How Rack runs things (hard rules)

- Rack launches each process in the **foreground** and captures stdout/stderr.
  It **cannot** see or stop anything started via `start`, `start /b`, or any
  detached window — never use those in a Rack launcher.
- Never use `pause` (or any keypress wait) in a launcher: it hangs forever.
- Never auto-open a browser from a launcher; Rack provides the links.
- **One long-running server = one process = one console.** If your app runs a
  backend and a frontend, that's two separate processes, not one script.
- One-time work (installing deps, downloading binaries, building, migrating,
  seeding) must **not** live in the run path. Put it in a separate `setup.bat`
  (or `setup.sh`) the user runs by hand once. Run scripts should only start a
  server, instantly and repeatably.

## Ports come from the environment

Rack tells each process which port to use via environment variables. Launchers
must **read these with a sensible default fallback** instead of hardcoding:

- `RACK=1` — set when running under Rack.
- `RACK_PORT` — this process's assigned port.
- `<portEnv>` — the same value under a name you choose (e.g. `PB_PORT`).
- `RACK_PORT_<NAME>` — each sibling process's port. `<NAME>` is the sibling's
  name upper-cased with non-alphanumerics replaced by `_`
  (e.g. `RACK_PORT_POCKETBASE=8090`). This is how a frontend finds its backend.

Example `run-pocketbase.bat`:

```bat
@echo off
cd /d "%~dp0"
if "%PB_PORT%"=="" set "PB_PORT=8090"
pocketbase\pocketbase.exe serve --http=127.0.0.1:%PB_PORT% --dir pocketbase\pb_data
```

## `rack.json` (place in the project root)

```json
{
  "name": "My App",
  "category": "Work",
  "autostart": false,
  "setup": "setup.bat",
  "update": "git pull",
  "processes": [
    {
      "name": "Backend",
      "command": "run-backend.bat",
      "args": "",
      "dir": ".",
      "port": 8090,
      "portEnv": "PB_PORT",
      "managed": false,
      "stop": "",
      "links": [{ "label": "Admin UI", "path": "/_/" }]
    },
    {
      "name": "Frontend",
      "command": "run-frontend.bat",
      "port": 3000,
      "portEnv": "APP_PORT",
      "managed": true,
      "links": [{ "label": "Open app", "path": "/" }]
    }
  ]
}
```

| Field | Where | Meaning |
|---|---|---|
| `name` | app | Display name. |
| `category` | app | Optional sidebar group. |
| `autostart` | app | `true` = start when Rack launches (e.g. on boot). |
| `setup` | app | One-time command, shown as a hint. Not run as a process. |
| `update` | app | Optional command (e.g. `git pull`) shown as a ⟳ Update button. |
| `processes[]` | app | One entry per long-running server. |
| `name` | process | Console label. |
| `command` | process | Path relative to the project root, an `.exe`/`.bat`, or a typed command like `npm run start`. |
| `args` | process | Optional extra arguments. |
| `dir` | process | Working folder (defaults to the project root). |
| `port` | process | The port this process serves on. |
| `portEnv` | process | Env var Rack sets to the assigned port; your launcher reads it. |
| `managed` | process | `true` = Rack may reassign this port to avoid clashes. `false` = fixed. |
| `stop` | process | Optional graceful-shutdown command (e.g. `docker compose down`). |
| `links[]` | process | Buttons in Rack: `{label, path}` → `http://127.0.0.1:<port><path>`. |

## Choosing `managed` vs fixed ports

- If a server's port is independent and nothing else hardcodes it, use
  `"managed": true` and read the port from `portEnv`.
- If another component **bakes the URL in at build time** (e.g. Next.js inlines
  `NEXT_PUBLIC_*` during `npm run build`), that backend's port must be
  **fixed** (`"managed": false`), and changing it requires a rebuild. Do not
  pretend such a port is runtime-swappable.

## What to do

1. Inspect this project. Identify every long-running server, how each starts,
   which port it uses, and where its port / backend URL is configured. Report
   what you found before changing anything.
2. Create one foreground-safe launcher script per server: no `start`, no
   `pause`, no browser-open; read the port from its env var with a default.
3. Create `setup.bat` for the one-time work (support a `rebuild` argument if
   there's a build step). `pause` is fine there since it's run by hand; exit
   non-zero on failure.
4. Write `rack.json` describing every process with the correct command, port,
   `portEnv`, `managed`, useful `links`, and `setup` / `update` commands.
5. Ensure machine-specific state is git-ignored (databases, `.env*`, build
   output, `node_modules`, downloaded binaries) so updates only change code and
   never destroy data. Config that must vary per machine belongs in an ignored
   env file, not in tracked source.
6. Verify each launcher actually serves on its port, then **stop it and confirm
   the port is free again** — do not leave orphaned processes or busy ports.
7. Finish by telling me the folder path to point Rack at, and what to run once.

Once done, adding this app to Rack is: **+ Add app → point at the project folder
→ Save**, and every process is imported automatically.
