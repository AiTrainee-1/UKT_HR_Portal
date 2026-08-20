# UKTextiles HRMS -Deployment Guide (On-Premise)

Full step-by-step runbook for the on-premise deployment: Django + Waitress, Nginx, and Cloudflare Tunnel, all running as Windows services (NSSM) on a company PC. This is the reusable checklist for hosting this project -Part 3 is the actual step-by-step to run.

> **Looking for cloud hosting instead (Railway + Vercel)?** See `clouddeployment.md`.
> The Nginx/Cloudflare Tunnel deployment described here runs on a separate server/device, not inside this repo -the `nginx/`/`cloudflared/`/`www/` folders that used to live in this checkout have been removed; rebuild them fresh on whichever machine actually runs the deployment, per Phase 1 below.

---

## Architecture decision -why on-premise + Cloudflare Tunnel, not a cloud VPS

The deciding fact: the biometric device only talks to Django over the local network (see `biometric-integration.md`). If Django moved to a cloud VPS, the device would need working internet for *every single punch* -any blip during morning clock-in would silently lose attendance data. Keeping Django local means the device never depends on the internet at all.

```
Biometric device ──┐
                    ├──► Django (local, 127.0.0.1:8000) ──► PostgreSQL (local or LAN)
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
                  Employee mobile app / Employee web app (anywhere)
```

**Why Cloudflare Tunnel, not port-forwarding:** port-forwarding exposes the PC directly to the internet. Cloudflare Tunnel makes an outbound-only connection from the PC to Cloudflare's network -nothing is ever opened inbound on the router/firewall, and Cloudflare handles TLS/HTTPS automatically, for free.

**Accepted tradeoff:** the public site is only reachable while that PC is powered on -a deliberate choice for a single-location factory used only during working hours, not an oversight. See the bottom of this guide for optional auto power-on/shutdown scheduling.

---

## One-time prerequisites on a fresh machine

- **Python 3.11+** on PATH
- **Node.js 20+** and npm
- **Git**
- **PostgreSQL 15+** reachable (local, or a LAN/managed server -see `clouddeployment.md` if moving it off-premise)
- Administrator rights on the Windows machine (everything below needs an Administrator PowerShell)

NSSM, Nginx, and cloudflared are **not** part of this git repo -download them fresh onto the deployment machine:

```powershell
# NSSM
Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile "nssm.zip"
Expand-Archive -Path "nssm.zip" -DestinationPath ".\nssm_temp" -Force
Copy-Item ".\nssm_temp\nssm-2.24\win64\nssm.exe" ".\nssm.exe" -Force
Remove-Item -Recurse -Force ".\nssm_temp", "nssm.zip"

# Nginx -download the Windows zip from nginx.org, extract to a `nginx\` folder
# cloudflared -download cloudflared-windows-amd64.exe from Cloudflare's GitHub releases
```

---

## Part 1 -Prepare the environment & code

**1. Get the code and build a fresh virtualenv** (a `.venv` is never portable between machines/users -see the postmortem below for why this matters):
```powershell
cd D:\UKTextile
git clone <your-repo-url> .
cd backend
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

**2. Configure `backend\.env`:**
```env
DEBUG=false
ALLOWED_HOSTS=hrms.uktextiles.in,localhost,127.0.0.1
CORS_ALLOWED_ORIGINS=https://hrms.uktextiles.in
DJANGO_SECRET_KEY=<new random secret>
JWT_SECRET=<new random secret, separate from DJANGO_SECRET_KEY -never change after go-live>
DB_HOST=... DB_PORT=5432 DB_NAME=... DB_USER=... DB_PASSWORD=<strong production password>
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<strong password -bootstraps the one Super Admin account, see backend.md>
BIOMETRIC_DEVICE_IP=... BIOMETRIC_DEVICE_PORT=4370 BIOMETRIC_DEVICE_PASSWORD=0
BIOMETRIC_API_KEY=<strong random key>
```
See `backend.md` Section 3 for the complete variable list, including `DB_SSLMODE` and the WhatsApp credentials (only needed if that channel is being used).

Generate secrets with:
```powershell
python -c "import secrets; print(secrets.token_urlsafe(50))"
```

Then apply the schema and collect static files:
```powershell
python manage.py migrate
python manage.py collectstatic --noinput
```
`migrate` never creates a login account -only structural schema/defaults (see `backend.md` Section 1). The admin account is created separately, the moment Django's process starts for the first time.

**3. Build the React frontend:**
```powershell
cd ..\frontend
# Set VITE_API_URL=/api in frontend\.env
npm install
npm run build
```
Copy the *contents* of `dist\` into wherever Nginx serves from (e.g. `..\www\`) -not the `dist` folder itself, or Nginx's `root` directive nests one level too deep and 403s:
```powershell
Copy-Item -Path "dist\*" -Destination "..\www\" -Recurse -Force
```

---

## Part 2 -Configure the traffic controllers

**Nginx** (`nginx\conf\nginx.conf`):
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

    location /static/ { alias D:/UKTextile/backend/staticfiles/; }
    location /media/  { alias D:/UKTextile/backend/media/; }

    access_log  D:/UKTextile/logs/nginx_access.log;
    error_log   D:/UKTextile/logs/nginx_error.log;
}
```
Validate before ever restarting the service: `.\nginx.exe -t`.

**Cloudflare Tunnel:**
```powershell
cd D:\UKTextile\cloudflared
.\cloudflared-windows-amd64.exe tunnel login
.\cloudflared-windows-amd64.exe tunnel create UKTextiles-HRMS
.\cloudflared-windows-amd64.exe tunnel route dns UKTextiles-HRMS hrms.uktextiles.in
```
`cloudflared\config.yml`:
```yaml
tunnel: <your-tunnel-id>
credentials-file: 'C:\Users\<user>\.cloudflared\<your-tunnel-id>.json'

ingress:
  - hostname: hrms.uktextiles.in
    service: http://localhost:80
  - service: http_status:404
```
**Gotcha:** the `credentials-file` path must be single-quoted -Windows backslashes inside an unquoted YAML string can be misparsed.

Test manually before installing as a service (from a phone on mobile data, not office WiFi, to confirm it's genuinely public):
```powershell
.\cloudflared-windows-amd64.exe tunnel run UKTextiles-HRMS
```

---

## Part 3 -Register the three Windows services (NSSM)

Run as **Administrator**:

```powershell
cd D:\UKTextile
mkdir logs -ErrorAction SilentlyContinue

# Django (Waitress) -point at python.exe, never at waitress-serve.exe directly (see postmortem below)
.\nssm.exe install UKTextilesDjango "D:\UKTextile\backend\.venv\Scripts\python.exe"
.\nssm.exe set UKTextilesDjango AppParameters "-m waitress --host=127.0.0.1 --port=8000 config.wsgi:application"
.\nssm.exe set UKTextilesDjango AppDirectory "D:\UKTextile\backend"
.\nssm.exe set UKTextilesDjango AppStdout "D:\UKTextile\logs\django_out.log"
.\nssm.exe set UKTextilesDjango AppStderr "D:\UKTextile\logs\django_err.log"

# Nginx
.\nssm.exe install UKTextilesNginx "D:\UKTextile\nginx\nginx.exe"
.\nssm.exe set UKTextilesNginx AppDirectory "D:\UKTextile\nginx"

# Cloudflared
.\nssm.exe install UKTextilesTunnel "D:\UKTextile\cloudflared\cloudflared-windows-amd64.exe" "tunnel --config D:\UKTextile\cloudflared\config.yml run UKTextiles-HRMS"
.\nssm.exe set UKTextilesTunnel AppDirectory "D:\UKTextile\cloudflared"

.\nssm.exe start UKTextilesDjango
.\nssm.exe start UKTextilesNginx
.\nssm.exe start UKTextilesTunnel
```
All three default to `Automatic` start type, so they come back on their own after a Windows restart.

```powershell
Get-Service -Name 'UKTextiles*' | Select-Object Name, Status, StartType   # check all three at a glance
.\nssm.exe restart UKTextilesDjango                                       # picks up new backend code -no auto-reload
.\nssm.exe stop UKTextilesDjango                                          # before redeploying
```

---

## Post-deploy checklist

1. `Get-Service -Name 'UKTextiles*'` -all three `Running`.
2. `curl http://localhost/api/healthz` -returns `{"status":"ok"}`.
3. `https://hrms.uktextiles.in` loads the login page from a phone on mobile data.
4. Log in with `ADMIN_USERNAME`/`ADMIN_PASSWORD`, then go to **Account Management** and create the real HR/MD/Director accounts with proper permissions -nothing else touches `.env` from here on.
5. Biometric sync still runs correctly -the device's connection is entirely unaffected by any of the above.
6. Reboot the PC once fully, confirm all three services auto-start with no manual step, confirm `logs\django_err.log` stays clean.

---

## Redeploying after a code change

```powershell
cd D:\UKTextile
git pull

# Backend changed?
cd backend
.\.venv\Scripts\activate
pip install -r requirements.txt        # only if requirements.txt changed
python manage.py migrate               # only if new migrations were added
cd ..
.\nssm.exe restart UKTextilesDjango

# Frontend changed?
cd frontend
npm install                            # only if package.json changed
npm run build
Remove-Item -Recurse -Force ..\www\* -ErrorAction SilentlyContinue
Copy-Item -Recurse dist\* ..\www\
cd ..
```
Frontend changes need no service restart (Nginx just serves whatever's in `www\` -the copy step alone is enough). Backend changes always need `nssm restart UKTextilesDjango`, since Waitress never auto-reloads.

---

## Postmortem -two real deployment bugs worth knowing in advance

### Bug 1 -a copied/foreign `.venv`

**Symptom:** running the app manually in a terminal worked; wrapped in an NSSM service, it failed with `did not find executable at C:\Users\<other-user>\...\python.exe`.

**Root cause:** a Python venv is not portable -`pyvenv.cfg` and the activation scripts inside `.venv\Scripts\` are written as **absolute paths** to wherever `python -m venv` originally ran. Copying/zipping a `.venv` between machines or Windows user accounts leaves it pointing at a Python install that doesn't exist on the new one. A manual terminal activation sometimes tolerates this by falling back to whatever `python` resolves to on PATH; NSSM reads the exact recorded path and calls it directly, so it fails immediately and loudly.

**Rule going forward:** never commit, zip, or copy `.venv` between machines or across a username change on the same PC -always rebuild it fresh on whatever machine will actually run the service (Part 1, step 1).

### Bug 2 -NSSM pointed at `waitress-serve.exe` directly

**Symptom:** `502 Bad Gateway` once running as a service, even after fixing the venv.

**Root cause:** `waitress-serve.exe` is a thin pip-generated wrapper in the venv's `Scripts\` folder. Launched directly by NSSM (outside an activated shell), it doesn't reliably resolve back to the venv's own Python/site-packages.

**Fix -always point NSSM at the venv's real `python.exe`, invoking Waitress as a module, never the wrapper:**
```powershell
nssm set UKTextilesDjango Application "D:\UKTextile\backend\.venv\Scripts\python.exe"
nssm set UKTextilesDjango AppParameters "-m waitress --host=127.0.0.1 --port=8000 config.wsgi:application"
```

### Smaller gotchas confirmed in practice

- PowerShell needs `.\` to run a local executable -always `cd` into the `cloudflared`/`nginx` folder first.
- YAML paths on Windows must be single-quoted in `config.yml` (backslashes can be misparsed unquoted).
- Nginx needs the built frontend directly inside its serve folder, not nested in an extra `dist\` subfolder.
- **Never manually `Stop-Process`/kill the Django python process** -that leaves NSSM's tracking out of sync, and can leave an *orphan* process still holding port 8000 that a subsequent `nssm restart` can't replace (the new process fails to bind the port and dies quietly, while the old orphan -running old code -keeps answering requests, making it look like "nothing I deploy ever takes effect"). Always use `nssm restart <service>` / `Restart-Service`. If an orphan is ever suspected, check `(Get-NetTCPConnection -LocalPort 8000 -State Listen).OwningProcess` and compare its `StartTime` against your last deploy; if it's older, do a clean `Stop-Service` → kill any leftover python → `Start-Service` (safe only because the service is stopped first).
- `logs\django_err.log` is the fastest diagnostic when the service is running but the site 502s -it shows the exact Python traceback.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Public URL unreachable, `localhost` on the PC works | `UKTextilesTunnel` stopped, or the PC lost internet |
| Site loads, every API call fails/CORS errors | `UKTextilesDjango` stopped, or `ALLOWED_HOSTS`/`CORS_ALLOWED_ORIGINS` doesn't include the URL being used |
| Backend changes don't take effect | Forgot `nssm restart UKTextilesDjango` -no auto-reload |
| Every endpoint 500s, including `/healthz` | Import error in some `.py` file -check `logs\django_err.log`, read the full traceback not just the last line |
| `nginx.exe -t` fails | Syntax error in `nginx.conf` -message includes the line number |
| Port 80 already in use | `netstat -ano | findstr :80` to find the PID, or change the Nginx `listen` + tunnel `service:` port together |
| Frontend shows old content after a deploy | Forgot the `Copy-Item` into the serve folder, or the browser cached `index.html` -hard refresh |
| Service won't start after a fresh deploy | Was `.venv` copied instead of rebuilt on this machine? (Bug 1) |
| 502 specifically from Django, no obvious Python error | Is NSSM pointed at `python.exe -m waitress`, not `waitress-serve.exe`? (Bug 2) |

---

## Optional -auto power on/off

| What | How |
|---|---|
| Auto power on at 8 AM | BIOS → Power Management → RTC Wake / Scheduled Power On |
| Auto shutdown at 10 PM | Windows Task Scheduler → `shutdown /s /t 0` at 22:00 |

---

## Recommended additions not yet built

- Scheduled PostgreSQL backups (Settings → Backup already supports this from within the app -Section 9 of `backend.md`).
- Log rotation for `django_out.log`/`django_err.log`/Nginx logs.
- A simple uptime check (a scheduled task pinging `/api/healthz`, alerting on failure).
