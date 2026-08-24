# UKTextiles HRMS -Cloud Deployment Guide (Railway + Vercel)

An alternative to the on-premise deployment (`deployment-guide.md`): Django + PostgreSQL on **Railway**, the React frontend on **Vercel**. Read the caveat below before starting -it affects whether this is actually the right choice for this specific app.

---

## Read this first -the biometric device problem

`deployment-guide.md`'s on-premise architecture exists specifically because **the biometric device only reaches Django over the local network** (see `biometric-integration.md`, Path 1 -Pull). Moving Django to Railway breaks that assumption directly: a cloud-hosted Django process cannot open a TCP connection *into* a device sitting behind the factory's router, so `sync_biometric` (the Pull path) simply cannot work against a device on-premise once Django itself is off-premise.

**Practical options, in order of how much they change:**

1. **Hybrid (recommended if the device must stay involved):** keep a small on-premise Windows machine running *only* `python manage.py sync_biometric` on a schedule (Task Scheduler, no Django web process needed there), pointed at the same cloud Postgres via `DB_HOST`/`DB_PORT` in its own `.env`. Django itself, the HR Portal, and the employee apps all move to Railway/Vercel; only the sync command stays local. This needs no code changes -`sync_biometric` already just needs LAN access to the device and network access to Postgres, both of which this satisfies.
2. **Push instead of Pull:** if the device supports HTTP Push (`biometric-integration.md`, Path 2) and can reach the public Railway URL, point it there directly and retire the Pull path entirely. This needs the device to have outbound internet access, and (per `biometric-integration.md`) the ADMS/HTTPS variant of push is not yet implemented in this codebase -only the simpler JSON-POST push endpoint is.
3. **Don't move Django at all.** Keep the on-premise deployment (`deployment-guide.md`) for exactly the reason it was chosen, and treat this guide as relevant only if the biometric device is retired or replaced with something that doesn't need LAN pull access.

Everything below assumes option 1 or 2 has been decided on -this guide covers moving the **web application and database**, not the biometric device's own connectivity.

---

## Architecture

```
┌─────────────┐        ┌──────────────────────┐        ┌────────────────────┐
│   Vercel     │──HTTPS─▶│   Railway            │──TCP──▶│  Railway Postgres   │
│   (frontend) │  /api   │   (Django + Gunicorn) │        │  (managed)          │
└─────────────┘        └──────────────────────┘        └────────────────────┘
                               ▲
                               │ sync_biometric (scheduled)
                        ┌──────────────┐
                        │  On-prem PC   │ -- only if keeping the biometric device;
                        │  (Task        │    see the section above
                        │  Scheduler)   │
                        └──────────────┘
```

- **Vercel** builds and serves the React frontend as a static site (no Node process running in production -same as the on-premise Nginx setup, just Vercel's CDN instead of Nginx).
- **Railway** runs Django behind Gunicorn (or Waitress, but Gunicorn is the more common Railway convention) as a long-running web service, plus a managed PostgreSQL instance in the same project.
- Both are HTTPS by default -no Cloudflare Tunnel needed, since neither service is a local machine with no public IP.

---

## Part 1 -Railway (Backend + Database)

### 1. Create the project and add Postgres

In the Railway dashboard: **New Project → Deploy from GitHub repo**, pointing at this repository (or a fork/mirror of it). Then **+ New → Database → PostgreSQL** in the same project -Railway provisions it and automatically injects a `DATABASE_URL` env var into every service in the project.

**`DATABASE_URL` works out of the box** -`backend/config/settings.py` parses it (scheme, credentials, host, port, database, and an optional `?sslmode=`) and only falls back to the discrete `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` vars when it isn't set. So Railway's auto-injected variable needs no configuration at all, and local development keeps using `.env` unchanged.

Percent-encoded characters in the password are decoded correctly, which matters because generated passwords routinely contain `@`, `:` or `/`. A `DATABASE_URL` that isn't a Postgres URL, or has a non-numeric port, is ignored rather than half-applied -the app falls back to the discrete vars instead of booting with a broken connection.

### 2. Configure the Django service

**Root directory:** set to `backend/` (Railway needs to know Django's actual root isn't the repo root, since `frontend/` sits alongside it).

**Start command** (Railway's build system auto-detects Python via `requirements.txt`; a Procfile or the service's Start Command field both work):
```
gunicorn config.wsgi:application --bind 0.0.0.0:$PORT
```
`gunicorn` is already in `requirements.txt`. The on-premise deployment keeps using `waitress` (gunicorn needs `fcntl` and cannot run on Windows) -both are listed, so neither deployment target has to edit the file.

**Environment variables** (Railway → Variables tab), matching `backend.md` Section 3:
```
DEBUG=false
DJANGO_SECRET_KEY=<new random secret>
JWT_SECRET=<new random secret>
ALLOWED_HOSTS=<your-railway-domain>.up.railway.app,your-custom-domain.com
CORS_ALLOWED_ORIGINS=https://<your-vercel-domain>.vercel.app,https://your-custom-domain.com
# DATABASE_URL is injected by Railway automatically -do not set it by hand.
# The discrete DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD vars are only
# needed if you are NOT using DATABASE_URL (e.g. an external database).
DB_SSLMODE=require
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<strong password>
BIOMETRIC_API_KEY=<strong random key>   # only relevant if using the Push path, see above
WHATSAPP_ACCESS_TOKEN=...               # only if using WhatsApp -see backend.md Section 8
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_BUSINESS_ACCOUNT_ID=...
```
`DB_SSLMODE=require` -managed Postgres providers including Railway's expect TLS. This now applies in two places at once: Django's own connection (as `OPTIONS.sslmode`) and the `pg_dump`/`psql` subprocesses the backup system shells out to (as `PGSSLMODE`), so backups and the ORM can't end up disagreeing about TLS. Alternatively append `?sslmode=require` to `DATABASE_URL` -settings.py reads it from either place, with the explicit env var winning.

**Database privileges for Backup/Restore:** if using the in-app Backup/Restore feature (Settings → Backup) against Railway Postgres, the `DB_USER` needs owner privileges on the `public` schema for Restore's schema-reset step -Railway's default database user has this by default (unlike some other managed providers that lock it down), but confirm on the Postgres service's connection details before relying on Restore in production.

### 3. First deploy

Railway builds automatically on every push to the connected branch. After the first successful deploy, run migrations from Railway's **Shell** (or a one-off deploy command):
```bash
python manage.py migrate
python manage.py collectstatic --noinput
```
The admin account bootstraps itself on the app's first startup, same as on-premise (`backend.md` Section 1) -no separate step needed.

### 4. Media files -read this before uploading anything real

Django's `MEDIA_ROOT` (resumes, employee documents, ID card assets, backup staging) is local disk by default. **Railway's filesystem is not reliably persistent across redeploys for a standard web service** -a new deploy can start from a clean filesystem, silently losing anything written to `media/` since the last one. Two ways to handle this:

- **Railway Volumes** -attach a persistent volume to `MEDIA_ROOT`. Works, but Railway's own guidance notes real tradeoffs for a customer-facing app: no horizontal scaling (replicas) for a service with a volume attached, and a short window of downtime on every redeploy while the volume reattaches. Acceptable for a single-instance internal HR tool; worth knowing before assuming it behaves like local disk always did.
- **S3-compatible object storage** (AWS S3, Cloudflare R2, Backblaze B2) -the more standard production answer. Requires switching Django's default file storage backend (`django-storages` + the relevant backend), which is a real code change not currently in this codebase -budget time for it if choosing this route.

For a first migration, Railway Volumes is the faster path; move to object storage later if uptime/scaling on redeploy becomes a real problem.

**Scheduled backups** (Settings → Backup) currently write to a local directory and optionally upload to Google Drive (`backend.md` Section 9) -on Railway, point the local directory at the same volume as `MEDIA_ROOT`, or rely on the Google Drive upload as the actual durable copy and treat the local one as transient.

---

## Part 2 -Vercel (Frontend)

### 1. Import the project

In the Vercel dashboard: **Add New → Project**, import the same GitHub repo. Set **Root Directory** to `frontend/` -Vercel auto-detects the Vite framework preset once that's set (per Vercel's own Vite integration, no manual build-command configuration needed in the common case).

### 2. Environment variables

This project's API base URL is controlled by `VITE_API_URL` (`frontend/README.md`, `frontend.md` Section 1). Since Django now lives on a different origin (Railway) than the frontend (Vercel), set it explicitly -unlike the on-premise setup where `/api` is same-origin via Nginx's reverse proxy:
```
VITE_API_URL=https://<your-railway-domain>.up.railway.app
```
**No trailing `/api`** -every generated API call already starts with `/api/...` (see `frontend/src/lib/api-client/generated/api.ts`, e.g. `/api/auth/hr-login`), and `setBaseUrl()`/`applyBaseUrl()` (`custom-fetch.ts`) just concatenates this value in front of that path with no separator logic. Adding `/api` here produces `.../api/api/auth/hr-login` -a second 404 that looks identical to the first from the browser's Network tab, so it's an easy one to reintroduce by "fixing" this value the intuitive way.

Set this in Vercel → Project Settings → Environment Variables. Vite only exposes variables prefixed `VITE_` to client code (already the convention this project uses), and Vercel's build step picks up whatever's set there automatically -no code change needed.

### 3. Deploy

Push to the connected branch, or `vercel --prod` via the CLI. Vercel builds with `npm run build` and serves the `dist/` output from its CDN -there's no Node process running in production, same principle as the on-premise Nginx-serves-static-files setup, just without needing to manage the copy-to-`www\` step manually (Vercel rebuilds and redeploys the static output on every push automatically).

### 4. Custom domain (optional)

Vercel → Project Settings → Domains -add the real domain and follow its DNS instructions (a `CNAME` to Vercel, or `A`/`ALIAS` records depending on the registrar). Update `ALLOWED_HOSTS`/`CORS_ALLOWED_ORIGINS` on the Railway side to match once the custom domain is live.

---

## Part 3 -Connect the pieces

1. Confirm `https://<vercel-domain>` loads the login page and successfully calls `https://<railway-domain>/api/...` (check the browser Network tab for CORS errors -if present, double check `CORS_ALLOWED_ORIGINS` on Railway includes the exact Vercel origin, including `https://`).
2. Log in with `ADMIN_USERNAME`/`ADMIN_PASSWORD`, create real HR accounts from Account Management.
3. If keeping the biometric device (option 1 or 2 above), confirm attendance sync actually reaches the new Django URL/DB before relying on it for real payroll data -this is the one piece of the whole migration that doesn't "just work" by moving hosting providers, see the caveat at the top of this guide.
4. Point the separate Employee Mobile App / Employee Web App repos' API base URL at the new Railway domain (their own `.env`, not part of this repo).

---

## Cost estimate (2026, approximate)

| Service | Typical cost |
|---|---|
| Railway (Django + Postgres, small HR-tool-scale traffic) | Usage-based; small projects commonly run **$5-20/month** combined, after an initial free trial credit |
| Vercel (static frontend, low-to-moderate traffic) | Free tier is normally sufficient for an internal admin tool's frontend hosting; paid tiers exist for higher bandwidth/team features |
| Custom domain | Whatever the registrar charges (same as the on-premise setup) |

Actual cost depends heavily on Railway resource usage (Postgres size, Django instance uptime/memory) -check Railway's current usage-based pricing calculator before committing budget, since it bills by consumption rather than a flat plan.

---

## When on-premise (`deployment-guide.md`) is still the better fit

- The biometric device's Pull sync is the primary attendance-capture method and a hybrid on-prem sync agent (option 1 above) isn't wanted.
- Zero ongoing hosting cost matters more than cloud convenience.
- Data residency requirements mean company data shouldn't leave the local network at all.

## When Railway + Vercel is the better fit

- The biometric device is being retired, replaced with Push-capable hardware, or a hybrid sync agent is acceptable.
- The team wants managed infrastructure (automatic scaling, no NSSM/Windows-service maintenance, no "is the PC on" dependency).
- Multiple people need to deploy without SSH/RDP access to a specific physical machine.
