# UKTextiles HRMS — Deployment Guide

This documents the **actual, currently-installed** on-premise deployment on this machine. Every path, port, and service name below is what's really configured right now — not a generic template. If you ever rebuild this from scratch (new PC, wiped drive), follow this top to bottom and you'll land back on an identical setup.

## Architecture

```
Browser / Employee phone
        │
        ▼
https://demo.suryaportal.site   ← Cloudflare's public URL (no port-forwarding, no static IP needed)
        │
        ▼
  Cloudflare Tunnel (Windows service: UKTextilesTunnel)
        │
        ▼
  http://localhost:80            ← Nginx (Windows service: UKTextilesNginx)
        │
        ├── /              → serves built React app from  D:\Projects\UK-textile\www
        ├── /api/, /admin/ → proxied to Django on          http://127.0.0.1:8000
        ├── /static/       → served from                   D:\Projects\UK-textile\backend\staticfiles
        └── /media/        → served from                   D:\Projects\UK-textile\backend\media
        │
        ▼
  Django + Waitress (Windows service: UKTextilesDjango, port 8000)
        │
        ▼
  PostgreSQL @ 192.168.0.5:5432  (separate DB server on the LAN, not this machine)
```

The biometric device (eSSL e2008) talks to Django directly over the local network — it never goes through the tunnel, so attendance punches keep working even if internet is down.

## Directory reference

| Path | What it is |
|---|---|
| `D:\Projects\UK-textile` | Project root — everything below is relative to this |
| `D:\Projects\UK-textile\backend` | Django project (source of truth for the API) |
| `D:\Projects\UK-textile\backend\.venv` | Python virtual environment — **machine-specific, never copy between PCs, always rebuild** |
| `D:\Projects\UK-textile\backend\.env` | All secrets/config for Django (DB, JWT, admin bootstrap, CORS) — never committed to git |
| `D:\Projects\UK-textile\backend\staticfiles` | Django's collected static files, served by Nginx `/static/` |
| `D:\Projects\UK-textile\frontend` | React source code — **not served directly**, only its build output is |
| `D:\Projects\UK-textile\frontend\dist` | Output of `npm run build` — a fresh build lands here first |
| `D:\Projects\UK-textile\www` | **What Nginx actually serves as the website.** After every frontend build you copy `frontend\dist\*` here |
| `D:\Projects\UK-textile\nginx` | Nginx binary + config, portable install (not a system-wide Nginx) |
| `D:\Projects\UK-textile\nginx\conf\nginx.conf` | The only Nginx file you should ever need to edit |
| `D:\Projects\UK-textile\cloudflared` | cloudflared binary + tunnel config |
| `D:\Projects\UK-textile\cloudflared\config.yml` | Which hostname routes to which local port |
| `D:\Projects\UK-textile\logs` | Nginx access/error logs |
| `D:\Projects\UK-textile\backend\logs` | Django stdout/stderr logs (written by NSSM, see Phase 7) |
| `D:\Projects\UK-textile\nssm.exe` | Service manager used to install all three background services |

## One-time prerequisites on a fresh machine

Install these before anything else — all via their official installers, no special config needed at install time:

- **Python 3.13+** — must be on PATH (`python --version` works from any folder)
- **Node.js 20+** and npm — for building the frontend
- **Git**
- Network access to the PostgreSQL server at `192.168.0.5:5432` (or wherever your DB actually lives — ask whoever manages that server for credentials)
- Administrator rights on this Windows machine (everything below needs an **Administrator PowerShell**)

NSSM, Nginx, and cloudflared are already vendored inside the project (`nssm.exe`, `nginx\nginx.exe`, `cloudflared\cloudflared-windows-amd64.exe`) — you do not need to install them separately. If you ever need to re-download NSSM specifically:

```powershell
cd D:\Projects\UK-textile
Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile "nssm.zip"
Expand-Archive -Path "nssm.zip" -DestinationPath ".\nssm_temp" -Force
Copy-Item ".\nssm_temp\nssm-2.24\win64\nssm.exe" ".\nssm.exe" -Force
Remove-Item -Recurse -Force ".\nssm_temp", "nssm.zip"
```

---

## Phase 1 — Get the code

```powershell
cd D:\Projects
git clone <your-repo-url> UK-textile
cd D:\Projects\UK-textile
```

If you're updating an existing install instead of starting fresh, skip to [Redeploying after a code change](#redeploying-after-a-code-change) near the bottom — you don't need to repeat Phases 2–7.

## Phase 2 — Database

The database is **not on this machine** — it's a PostgreSQL server at `192.168.0.5`. You just need a database created there once:

```powershell
# Run from any machine that can reach 192.168.0.5, with psql installed
createdb -U postgres -h 192.168.0.5 -p 5432 UKTex_DB
```

If you're instead setting up a **local** database on this machine (e.g. moving off the shared DB server), install PostgreSQL locally, create the DB the same way with `-h localhost`, and change `DB_HOST` in `.env` (Phase 3) accordingly.

## Phase 3 — Backend (Django + Waitress)

A Python virtual environment cannot be copied between machines — it always has to be built fresh on the machine it will run on.

```powershell
cd D:\Projects\UK-textile\backend
Remove-Item -Recurse -Force ".venv" -ErrorAction SilentlyContinue
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

(`waitress` — the production WSGI server — is already listed in `requirements.txt`, no separate install needed.)

**Create `backend\.env`** — copy the template and fill in real values:

```powershell
Copy-Item .env.example .env
notepad .env
```

What each key means and what to set it to:

| Key | Set to |
|---|---|
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | Your PostgreSQL server details (currently `192.168.0.5`, `UKTex_DB`) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | The **one** bootstrap login. On first startup Django auto-creates this as the super-admin HR account. Every other login (HR, MD, Directors, EA, EDP...) is created afterward from **Account Management** inside the portal — nothing else goes in `.env` |
| `JWT_SECRET` | A long random string. Generate one with `python -c "import secrets; print(secrets.token_hex(32))"`. **Never change this after go-live** — it invalidates every logged-in session |
| `DJANGO_SECRET_KEY` | Another long random string, same rule as above |
| `DEBUG` | `false` for production (sensitive error pages are only safe on `true` during local dev) |
| `ALLOWED_HOSTS` | Comma-separated list of hostnames Django will answer to — must include your Cloudflare hostname (`demo.suryaportal.site`), `localhost`, `127.0.0.1`, and this machine's LAN IP |
| `CORS_ALLOWED_ORIGINS` | Comma-separated list of frontend origins allowed to call the API — must include your public HTTPS URL and any dev server URLs you use |
| `BIOMETRIC_DEVICE_IP` / `PORT` / `PASSWORD` | Your eSSL e2008 device's IP (Main Menu → COMM. → Ethernet → IP Address on the device itself) |

Then set up the database schema and static files:

```powershell
python manage.py migrate
python manage.py collectstatic --noinput
```

`migrate` also runs the one-time data migrations that seed the admin account's `Role`/`HRUser` tables — this is what makes Account Management work.

## Phase 4 — Frontend (build once, deploy the output)

The frontend is **not run as a live server in production** — it's compiled once into static HTML/JS/CSS, and Nginx serves those files directly. There is no Node.js process running in production at all.

```powershell
cd D:\Projects\UK-textile\frontend
npm install
npm run build
```

This produces `D:\Projects\UK-textile\frontend\dist`. Nginx doesn't read from `dist` — it reads from `D:\Projects\UK-textile\www`, so copy the build output over:

```powershell
Remove-Item -Recurse -Force D:\Projects\UK-textile\www\* -ErrorAction SilentlyContinue
Copy-Item -Recurse D:\Projects\UK-textile\frontend\dist\* D:\Projects\UK-textile\www\
```

**You must redo this copy every time you change frontend code and want it live** — see the redeploy section below. There's no file-watcher connecting `dist` to `www`.

## Phase 5 — Nginx

Config file: `D:\Projects\UK-textile\nginx\conf\nginx.conf`. This is already set correctly for this machine — you generally shouldn't need to touch it. For reference, it currently does:

- Listens on **port 80** (not 8080 — port 80 is free on this machine, so no Windows port-conflict workaround was needed)
- Serves the built React app from `D:/Projects/UK-textile/www`
- Proxies `/api/` and `/admin/` to Django at `http://127.0.0.1:8000` (`/admin/` is currently unused — Django's admin site isn't enabled in this project, so that route 404s; harmless to leave as-is)
- Serves `/static/` from `D:/Projects/UK-textile/backend/staticfiles`
- Logs to `D:/Projects/UK-textile/logs/nginx_access.log` and `nginx_error.log`

If you ever change it, validate before restarting the service:

```powershell
cd D:\Projects\UK-textile\nginx
.\nginx.exe -t
```

## Phase 6 — Cloudflare Tunnel

Config file: `D:\Projects\UK-textile\cloudflared\config.yml`. Currently:

```yaml
tunnel: bc1e7382-eeb9-4779-97ae-466771cd6e3a
credentials-file: 'C:\Users\DELL\.cloudflared\bc1e7382-eeb9-4779-97ae-466771cd6e3a.json'

ingress:
  - hostname: demo.suryaportal.site
    service: http://localhost:80
  - service: http_status:404
```

The tunnel is named `hrms-demo` and already exists in your Cloudflare account, tied to the credentials file above (also machine-specific — don't copy it between PCs). If you ever need to create it from scratch on a new machine:

```powershell
cd D:\Projects\UK-textile\cloudflared
.\cloudflared-windows-amd64.exe tunnel login
.\cloudflared-windows-amd64.exe tunnel create hrms-demo
.\cloudflared-windows-amd64.exe tunnel route dns hrms-demo demo.suryaportal.site
```

That generates a new `credentials-file` and tunnel ID — update `config.yml` with the new values it prints.

## Phase 7 — Register the three Windows services

This is what makes everything start automatically on boot and keep running after you close PowerShell/VS Code. Run as **Administrator**:

```powershell
cd D:\Projects\UK-textile

# Django backend (port 8000, via Waitress — never use `manage.py runserver` in production)
.\nssm.exe install UKTextilesDjango "D:\Projects\UK-textile\backend\.venv\Scripts\python.exe"
.\nssm.exe set UKTextilesDjango AppParameters "-m waitress --host=127.0.0.1 --port=8000 config.wsgi:application"
.\nssm.exe set UKTextilesDjango AppDirectory "D:\Projects\UK-textile\backend"
.\nssm.exe set UKTextilesDjango AppStdout "D:\Projects\UK-textile\backend\logs\django_out.log"
.\nssm.exe set UKTextilesDjango AppStderr "D:\Projects\UK-textile\backend\logs\django_err.log"

# Nginx (port 80)
.\nssm.exe install UKTextilesNginx "D:\Projects\UK-textile\nginx\nginx.exe"
.\nssm.exe set UKTextilesNginx AppDirectory "D:\Projects\UK-textile\nginx"

# Cloudflare Tunnel
.\nssm.exe install UKTextilesTunnel "D:\Projects\UK-textile\cloudflared\cloudflared-windows-amd64.exe" "tunnel --config D:\Projects\UK-textile\cloudflared\config.yml run hrms-demo"
.\nssm.exe set UKTextilesTunnel AppDirectory "D:\Projects\UK-textile\cloudflared"
```

All three are set to `Automatic` start type by default with NSSM, so they come up on their own after a Windows restart — no manual step needed on reboot.

## Phase 8 — Start / stop / manage

```powershell
# Start everything (order doesn't matter — each retries until the others are up)
.\nssm.exe start UKTextilesDjango
.\nssm.exe start UKTextilesNginx
.\nssm.exe start UKTextilesTunnel

# Check status of all three at a glance
Get-Service -Name 'UKTextiles*' | Select-Object Name, Status, StartType

# Stop one (e.g. before redeploying Django code)
.\nssm.exe stop UKTextilesDjango

# Restart one (picks up new code — Waitress does NOT auto-reload on file changes)
.\nssm.exe restart UKTextilesDjango

# Fully remove a service (rare — only if reinstalling from scratch)
.\nssm.exe remove UKTextilesDjango confirm
```

**Important**: Waitress has no auto-reload. If you edit any backend `.py` file, nothing happens until you run `.\nssm.exe restart UKTextilesDjango`.

---

## Post-deploy checklist

1. `Get-Service -Name 'UKTextiles*'` — all three should show `Running`.
2. `curl http://localhost/api/healthz` — should return `{"status":"ok"}`.
3. Open `https://demo.suryaportal.site` in a browser — should load the login page.
4. Log in as `hr-login` with your `ADMIN_USERNAME`/`ADMIN_PASSWORD` from `.env`.
5. Go to **Account Management** (Admin-only sidebar item) and create the real HR/MD/Director/EA/EDP accounts with whatever module permissions each should have. Nothing else needs touching `.env` from here on.

## Redeploying after a code change

You never need to redo Phases 1–7 for a normal update. The routine is:

```powershell
cd D:\Projects\UK-textile
git pull

# Backend changed?
cd backend
.\.venv\Scripts\activate
pip install -r requirements.txt        # only if requirements.txt changed
python manage.py migrate               # only if new migrations were added
.\..\nssm.exe restart UKTextilesDjango
cd ..

# Frontend changed?
cd frontend
npm install                            # only if package.json changed
npm run build
Remove-Item -Recurse -Force ..\www\* -ErrorAction SilentlyContinue
Copy-Item -Recurse dist\* ..\www\
cd ..
```

Frontend changes don't need a service restart (Nginx just serves whatever files are in `www` — the copy step alone is enough). Backend changes always need `nssm restart UKTextilesDjango` since Waitress won't pick up new `.py` files on its own.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `https://demo.suryaportal.site` unreachable, but `http://localhost` on this PC works | `UKTextilesTunnel` service is stopped, or this PC lost internet |
| Site loads but every API call fails/CORS errors | `UKTextilesDjango` is stopped, or `ALLOWED_HOSTS`/`CORS_ALLOWED_ORIGINS` in `.env` doesn't include the URL you're hitting it from |
| Backend changes don't seem to take effect | You edited `.py` files but didn't run `nssm restart UKTextilesDjango` — Waitress has no auto-reload |
| Every single API endpoint suddenly 500s, including `/healthz` | Usually an import error somewhere in a `.py` file — check `backend\logs\django_err.log` for the traceback. Full logs, not just the last line — Django often needs to try building its own error page, which can itself fail and mask the real cause a few lines up |
| `nginx.exe -t` fails | Syntax error in `nginx.conf` — the error message includes the exact line number |
| Port 80 already in use | Something else (IIS, Skype, another web server) is bound to it — `netstat -ano | findstr :80` to find the PID, or change Nginx's `listen` directive and the tunnel's `service:` line to a different port together |
| Frontend shows old content after a deploy | You built but forgot the `Copy-Item` step into `www`, or the browser cached the old `index.html` — hard-refresh |

## Quick reference

| Thing | Value |
|---|---|
| Project root | `D:\Projects\UK-textile` |
| Public URL | `https://demo.suryaportal.site` |
| Nginx port | `80` |
| Django/Waitress port | `8000` (bound to `127.0.0.1` only — not exposed directly) |
| Database | `192.168.0.5:5432` / `UKTex_DB` |
| Tunnel name | `hrms-demo` |
| Services | `UKTextilesDjango`, `UKTextilesNginx`, `UKTextilesTunnel` |
| Frontend build output | `frontend\dist` → copied to → `www` |
