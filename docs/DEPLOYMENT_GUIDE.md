# UKTextiles HRMS — Deployment & Hosting Guide

_Compiled from the demo deployment postmortem (`demo.suryaportal.site`) and the production roadmap for `hrms.uktextiles.in`. This is the reusable runbook for hosting this project (or any future one built the same way) — read Part 1 once for the "why," then use Part 3 as the actual step-by-step checklist._

---

## Architecture decision — why on-premise + Cloudflare Tunnel, not a cloud VPS

This was decided early and hasn't changed: **Django, PostgreSQL, and the biometric device all stay on the same local company PC/network.** Only a secure tunnel is exposed to the internet.

The one fact that settles it: the biometric device (AiFace-Mars) only talks to Django over the local network. If Django were moved to a cloud VPS (Render/Railway/etc.), the device would need a working internet connection for *every single punch* — any internet blip during morning clock-in would silently lose attendance data. Keeping Django local means the device never depends on the internet at all.

```
Biometric device ──┐
                    ├──► Django (local, 127.0.0.1:8000) ──► PostgreSQL (local)
HR office PCs ──────┘              │
                                    ▼
                              Nginx (reverse proxy, port 80)
                                    │
                                    ▼
                         Cloudflare Tunnel (cloudflared)
                                    │
                                    ▼
                    https://hrms.uktextiles.in (public, HTTPS, no port-forwarding)
                                    │
                                    ▼
                          Employee mobile app (anywhere)
```

**Why Cloudflare Tunnel specifically, not port-forwarding:** port-forwarding exposes the PC directly to the internet (security risk, plus most home/office routers make this fragile). Cloudflare Tunnel makes an outbound-only connection from the PC to Cloudflare's network — nothing is ever opened inbound on the router/firewall, and Cloudflare handles TLS/HTTPS automatically, for free.

**Accepted tradeoff:** the public site is only reachable while that PC is powered on. For a single-location factory used only during working hours, this was a deliberate, accepted tradeoff — not an oversight.

---

## Part 1 — Demo deployment postmortem (`demo.suryaportal.site`)

The demo deployment got to roughly 95% working — Nginx, Django, and the Cloudflare Tunnel were all correctly configured and reachable. Two real bugs surfaced only at the very last step (turning it into a permanently-running Windows service), and both are worth understanding properly so they never cost debugging time again.

### Bug 1 — the venv was tied to a different Windows user

**Symptom:** running the app manually in a terminal worked perfectly. The moment it was wrapped in an NSSM service, it failed with:
```
did not find executable at C:\Users\kit26\AppData\Local\Programs\Python\Python314\python.exe
```

**Root cause:** the Windows username baked into that error (`kit26`) did not match the actual machine's username (`DELL`). A Python virtual environment (`.venv`) is not a portable, relocatable bundle — the interpreter paths inside `.venv\Scripts\` (specifically `pyvenv.cfg` and the activation scripts) are written as **absolute paths** pointing at wherever `python -m venv` was originally run. If a `.venv` folder is copied from one PC (or one Windows user account) to another, those absolute paths still point at the *original* machine's Python install, which doesn't exist on the new one.

**Why "manual terminal worked but NSSM failed":** when you activate a venv manually in a terminal (`.\.venv\Scripts\activate`), some shells partially tolerate a stale path or fall back to whatever `python` resolves to on `PATH`. NSSM does no such fallback — it reads the exact interpreter path recorded inside the service definition and calls it directly, so a stale/foreign path fails immediately and loudly. This is *the* explanation for that exact "worked manually, failed as a service" symptom, and it will reappear on any future project if a `.venv` folder is ever copied, zipped, or committed between machines.

**The fix — always rebuild `.venv` on the machine it will actually run on, never copy it:**
```powershell
cd D:\Projects\UK-textile\backend
Remove-Item -Recurse -Force .venv   # only if an old/foreign one exists
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```
**Rule going forward:** `.venv` must never be committed to git, never zipped and moved between PCs, and never reused across a username change on the same PC. Rebuild it fresh on whatever machine will actually run the service.

### Bug 2 — NSSM pointed at `waitress-serve.exe` directly

**Symptom:** even after fixing the venv, pointing NSSM's service target straight at `.venv\Scripts\waitress-serve.exe` caused `502 Bad Gateway` once running as a service.

**Root cause:** `waitress-serve.exe` is a thin wrapper script generated by pip inside the venv's `Scripts\` folder. Launched directly by NSSM (outside of an activated shell), that wrapper doesn't reliably resolve back to the venv's own Python and site-packages — the environment activation that normally happens implicitly in a terminal session doesn't happen the same way under NSSM's raw process launch.

**The fix — always point NSSM at the venv's real `python.exe`, and invoke waitress as a module (`-m waitress`), never at the wrapper `.exe`:**
```powershell
nssm install UKTextilesDjango "D:\Projects\UK-textile\backend\.venv\Scripts\python.exe"
nssm set UKTextilesDjango AppParameters "-m waitress --host=127.0.0.1 --port=8000 config.wsgi:application"
nssm set UKTextilesDjango AppDirectory "D:\Projects\UK-textile\backend"
```
This forces Python to load with the venv's own interpreter and its `site-packages` correctly resolved, every time, regardless of how NSSM launches the process.

### Other gotchas confirmed during the demo run (small, but worth keeping)

- **PowerShell needs `.\` to run a local executable** — `cloudflared-windows-amd64.exe tunnel login` fails silently/confusingly from the wrong directory context; always `cd` into the folder and prefix with `.\`.
- **YAML paths on Windows must be single-quoted** in `cloudflared/config.yml` — an unquoted `C:\Users\DELL\.cloudflared\<id>.json` path can be misparsed by the YAML parser because of the backslashes; wrap it: `credentials-file: 'C:\Users\DELL\.cloudflared\<tunnel-id>.json'`.
- **Nginx needs the built frontend directly inside `www\`, not nested in a `dist\` subfolder** — copying `frontend/dist/*` (the contents) into `www\`, not the `dist` folder itself, avoids a confusing 403 Forbidden from Nginx's `root` directive pointing at the wrong level.
- **`backend\logs\django_err.log` is the single fastest diagnostic** when the service is running but the site 502s — it shows the exact Python traceback that crashed the app, faster than checking Nginx or Cloudflare first.

---

## Part 2 — Production roadmap: `hrms.uktextiles.in`

Rather than patching the demo deployment's leftover quirks one by one, the decision was made to **start the production deployment clean**, now that the full process (including both gotchas above) is understood end-to-end. Same architecture, new domain, deliberately organized folder layout.

| Phase | What |
|---|---|
| 1 | Cloudflare DNS — confirm `uktextiles.in` is on Cloudflare's nameservers |
| 2 | Create the `hrms.uktextiles.in` subdomain |
| 3 | Cloudflare Tunnel — new tunnel named `UKTextiles-HRMS` (fresh, not reusing the demo tunnel) |
| 4 | Nginx — `/` → React, `/api/` → Django, `/static/` → static files, `/media/` → media files |
| 5 | Waitress — production WSGI server for Django |
| 6 | Windows Services (NSSM) — Django, Nginx, and Cloudflared all auto-start on boot |
| 7 | Mobile app — point `EXPO_PUBLIC_API_URL` at `https://hrms.uktextiles.in/api` |
| 8 | SSL — handled automatically by Cloudflare, no Certbot/Let's Encrypt needed |
| 9 | Biometric device — **no changes required**, it keeps talking to Django over LAN exactly as before |

### Recommended production folder layout

The demo deployment kept Nginx, Cloudflared, and the app all nested inside the git-tracked project folder (`D:\Projects\UK-textile\...`). For the company production deployment, separate the **deployed/running copy** from the **git/dev repo** — this makes backups, troubleshooting, and future redeploys much cleaner:

```
D:\
 └── UKTextile\
       ├── backend\        (deployed copy of the Django app + its own fresh .venv)
       ├── frontend\       (source, only needed to rebuild — the built output lives in www\)
       ├── www\            (built React static files — what Nginx actually serves)
       ├── nginx\           (nginx.exe + conf\)
       ├── cloudflared\     (cloudflared.exe + config.yml + credentials)
       ├── logs\            (django_out.log, django_err.log, nginx access/error logs)
       └── backups\         (scheduled PostgreSQL dumps — see Part 5)
```
`D:\Projects\UK-textile` remains the git repo for active development; `D:\UKTextile` is the standalone, production-only copy that the Windows services actually point at. Redeploying a new version means rebuilding/copying into `D:\UKTextile`, not editing it in place.

---

## Part 3 — Complete step-by-step master guide (from scratch)

This is the actual checklist to run, in order, for `hrms.uktextiles.in`. Each step assumes the previous one is confirmed working before moving on — don't chain all of them blind.

### Phase 1 — Prepare the environment & code

**1. Create a fresh virtual environment on the machine that will run it** (never copy one in — see Bug 1 above):
```powershell
cd D:\UKTextile\backend
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

**2. Lock down Django settings (`backend\.env`):**
```
DEBUG=false
ALLOWED_HOSTS=hrms.uktextiles.in,localhost,127.0.0.1
CORS_ALLOWED_ORIGINS=https://hrms.uktextiles.in
DJANGO_SECRET_KEY=<new random secret, generated fresh, never reused from dev>
JWT_SECRET=<new random secret, separate from DJANGO_SECRET_KEY>
DB_PASSWORD=<strong production password>
```
Generate secrets with:
```powershell
python -c "import secrets; print(secrets.token_urlsafe(50))"
```
Then:
```powershell
python manage.py migrate
python manage.py collectstatic --noinput
```

**3. Build the React frontend:**
Set in `frontend\.env`:
```
VITE_API_URL=/api
```
Then:
```powershell
cd D:\UKTextile\frontend
npm run build
Copy-Item -Path "dist\*" -Destination "..\www\" -Recurse -Force
```
**Gotcha:** copy the *contents* of `dist\` into `www\`, not the `dist` folder itself — Nginx's `root` points directly at `www\`, so nesting an extra folder level causes a 403.

### Phase 2 — Configure the traffic controllers

**1. Nginx (`nginx\conf\nginx.conf`):**
```nginx
server {
    listen       80;
    server_name  hrms.uktextiles.in;

    location / {
        root   D:/UKTextile/www;
        index  index.html;
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /static/ {
        alias D:/UKTextile/backend/staticfiles/;
    }

    location /media/ {
        alias D:/UKTextile/backend/media/;
    }

    access_log  D:/UKTextile/logs/nginx_access.log;
    error_log   D:/UKTextile/logs/nginx_error.log;
}
```

**2. Authenticate Cloudflare & create the tunnel:**
```powershell
cd D:\UKTextile\cloudflared
.\cloudflared-windows-amd64.exe tunnel login
.\cloudflared-windows-amd64.exe tunnel create UKTextiles-HRMS
.\cloudflared-windows-amd64.exe tunnel route dns UKTextiles-HRMS hrms.uktextiles.in
```
**Gotcha:** run these from inside the `cloudflared` folder with the `.\` prefix — PowerShell won't run a local executable by bare name.

**3. Write the tunnel config (`cloudflared\config.yml`):**
```yaml
tunnel: <your-tunnel-id>
credentials-file: 'C:\Users\DELL\.cloudflared\<your-tunnel-id>.json'

ingress:
  - hostname: hrms.uktextiles.in
    service: http://localhost:80
  - service: http_status:404
```
**Gotcha:** the `credentials-file` path must be single-quoted — Windows backslashes inside an unquoted YAML string can be misparsed.

Test manually before installing as a service:
```powershell
.\cloudflared-windows-amd64.exe tunnel run UKTextiles-HRMS
```
Visit `https://hrms.uktextiles.in` from a phone on mobile data (not office WiFi) to confirm it's genuinely public, not just resolving locally.

### Phase 3 — Lock it all in with background services

Install `nssm` once if not already available (Administrator PowerShell):
```powershell
winget install nssm
```
Restart PowerShell, then set up all three services as Administrator.

**1. Django (Waitress) — point at `python.exe`, never at `waitress-serve.exe` directly (see Bug 2 above):**
```powershell
mkdir "D:\UKTextile\logs"
nssm install UKTextilesDjango "D:\UKTextile\backend\.venv\Scripts\python.exe"
nssm set UKTextilesDjango AppParameters "-m waitress --host=127.0.0.1 --port=8000 config.wsgi:application"
nssm set UKTextilesDjango AppDirectory "D:\UKTextile\backend"
nssm set UKTextilesDjango AppStdout "D:\UKTextile\logs\django_out.log"
nssm set UKTextilesDjango AppStderr "D:\UKTextile\logs\django_err.log"
nssm start UKTextilesDjango
```

**2. Nginx:**
```powershell
nssm install UKTextilesNginx "D:\UKTextile\nginx\nginx.exe"
nssm set UKTextilesNginx AppDirectory "D:\UKTextile\nginx"
nssm start UKTextilesNginx
```

**3. Cloudflared:**
```powershell
nssm install UKTextilesTunnel "D:\UKTextile\cloudflared\cloudflared-windows-amd64.exe" "tunnel --config D:\UKTextile\cloudflared\config.yml run UKTextiles-HRMS"
nssm set UKTextilesTunnel AppDirectory "D:\UKTextile\cloudflared"
nssm start UKTextilesTunnel
```

### Phase 4 — Mobile app handoff

Update the mobile app's `.env`:
```
EXPO_PUBLIC_API_URL=https://hrms.uktextiles.in/api
```
This is the only change the mobile side needs — the biometric device's connection to Django is entirely unaffected (it always talked to `127.0.0.1`/LAN, never to the public domain).

### Final verification checklist

- [ ] `https://hrms.uktextiles.in` loads the HR portal from a phone on mobile data
- [ ] HR login and employee login both work
- [ ] Biometric sync still runs correctly — nothing about the device's connection changed
- [ ] Reboot the PC fully once, and confirm all three services (Django, Nginx, Cloudflared) start automatically with no manual intervention
- [ ] Check `D:\UKTextile\logs\django_err.log` is empty/clean after the reboot test

---

## Part 4 — Maintenance & troubleshooting cheat sheet

| Symptom | First thing to check |
|---|---|
| Site unreachable entirely | Is the PC powered on? (Expected outcome outside working hours if auto-shutdown is configured) |
| PC is on, site still down/502 | `D:\UKTextile\logs\django_err.log` — shows the exact Python traceback |
| Service won't start after a fresh deploy | Was `.venv` copied from another machine/user instead of rebuilt on this PC? (Bug 1) |
| 502 specifically from the Django service, no obvious Python error | Is NSSM pointed at `python.exe -m waitress` and not at `waitress-serve.exe` directly? (Bug 2) |
| Frontend loads but shows blank/404 on refresh of a sub-route | Confirm `try_files $uri $uri/ /index.html;` is present in the Nginx `location /` block |
| Frontend shows 403 Forbidden | Confirm `www\` contains `index.html` directly, not nested inside a `dist\` subfolder |
| `cloudflared` commands "not recognized" | Run from inside the `cloudflared` folder with the `.\` prefix |
| Tunnel config fails to parse | Check the `credentials-file` path is wrapped in single quotes |
| Mobile app can't reach the API after this migration | Confirm `EXPO_PUBLIC_API_URL` was updated to `https://hrms.uktextiles.in/api` and the app was rebuilt/restarted |

**Recommended additions not yet built (for later):**
- Scheduled PostgreSQL backups into `D:\UKTextile\backups\` (e.g. nightly `pg_dump` via Windows Task Scheduler) — nothing currently automates this.
- Log rotation for `django_out.log`/`django_err.log`/Nginx logs, so they don't grow unbounded over months of uptime.
- A simple uptime check (even a scheduled task pinging `https://hrms.uktextiles.in/api/healthz` and emailing/alerting on failure) so a crashed service is noticed before someone in HR reports it.

---

*This guide reflects the deployment approach decided and verified across the demo deployment (`demo.suryaportal.site`) and the production rollout plan for `hrms.uktextiles.in`. Reuse Part 3 as the checklist for any future redeploy or a second on-premise HRMS instance built the same way.*
