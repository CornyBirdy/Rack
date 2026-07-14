# Rack SDK — `rack.json`

A tiny contract so an app describes itself to Rack. Drop a `rack.json` in the
app's root folder (the legacy name `multiapp.json` still works); then in Rack
just **+ Add app → point at the folder → Save**, and every process is imported
with the right names, ports, and links. No manual per-process typing.

## Manifest format

```json
{
  "name": "TimePunch",
  "category": "Work",
  "autostart": false,
  "setup": "setup.bat",
  "update": "git pull",
  "processes": [
    {
      "name": "PocketBase",
      "command": "run-pocketbase.bat",
      "port": 8090,
      "portEnv": "PB_PORT",
      "managed": false,
      "links": [
        { "label": "Admin UI", "path": "/_/" },
        { "label": "API", "path": "/api/" }
      ]
    },
    {
      "name": "Next.js",
      "command": "run-next.bat",
      "port": 3000,
      "portEnv": "APP_PORT",
      "managed": false,
      "links": [{ "label": "Open app", "path": "/" }]
    }
  ]
}
```

A Docker app looks like this — one process, using `stop` for a graceful teardown:

```json
{
  "name": "My Stack",
  "processes": [
    {
      "name": "Compose",
      "command": "docker compose up",
      "stop": "docker compose down",
      "dir": ".",
      "port": 8080,
      "links": [{ "label": "Open", "path": "/" }]
    }
  ]
}
```

### Fields

| Field | Where | Meaning |
|---|---|---|
| `name` | app | Display name (folder name if omitted). |
| `category` | app | Optional sidebar group (collapsible, Discord-style). |
| `autostart` | app | `true` = start this app when Rack launches (e.g. on boot). |
| `update` | app | Optional shell command (e.g. `git pull`) shown as a **⟳ Update** button; runs in the first process's folder and streams its output. Use it to pull new code before Run. |
| `setup` | app | A one-time command (string) shown as a hint. Run it by hand once and after code changes — it is **not** launched as a process. |
| `processes[]` | app | One entry per long-running server; each gets its own console. |
| `name` | process | Console label. |
| `command` | process | A path (relative to the folder), an `.exe`/`.bat`, or a typed command like `npm run start`. |
| `args` | process | Optional extra arguments (string or array). |
| `dir` | process | Working folder (defaults to the app folder). |
| `port` | process | The port this process uses. |
| `portEnv` | process | Env var Rack sets to the effective port (e.g. `PB_PORT`). Your launcher reads it. |
| `managed` | process | `true` = Rack may move this port to avoid clashes; `false` = fixed (declared, warn-only). Defaults: PocketBase → managed, everything else → fixed. |
| `stop` | process | Optional shell command run on **Stop** for a graceful teardown (e.g. `docker compose down`). Rack runs it, then kills the process. |
| `links[]` | process | Buttons in the details panel: `{ "label", "path" }` → `http://127.0.0.1:<port><path>`. |

## Runtime contract (env vars Rack injects)

Every process is launched with:

- `RACK=1` — running under Rack.
- `RACK_PORT` — this process's effective port.
- `<portEnv>` — same value, under the name you chose (e.g. `PB_PORT=8090`).
- `RACK_PORT_<NAME>` — each sibling's port, name upper-cased with non-alphanumerics
  as `_` (e.g. `RACK_PORT_POCKETBASE=8090`). Lets a frontend find its backend.

The equivalent `MAC_*` variables are also set as backward-compatible aliases.

A launcher script just reads these. Example (`run-pocketbase.bat`):

```bat
if "%PB_PORT%"=="" set "PB_PORT=8090"
pocketbase\pocketbase.exe serve --http=127.0.0.1:%PB_PORT% --dir pocketbase\pb_data
```

## Note on baked-in ports (Next.js)

Next.js inlines `NEXT_PUBLIC_*` at **build** time, so a production build's
PocketBase URL is fixed when you build. Keep such a backend `managed: false` on a
fixed port; to change it, update the port and rebuild (`setup.bat rebuild`).
Fully runtime-swappable ports require reading the URL at runtime (a server config
route or a proxy) rather than a `NEXT_PUBLIC_` var.
