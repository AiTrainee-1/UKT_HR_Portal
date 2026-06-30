# UK Textile — Backend (Django REST Framework)

> For full project documentation, see the [root README](../README.md).

## Quick Start

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
copy .env.example .env          # then fill in your values
python manage.py migrate
python manage.py runserver 8080
```

API base: `http://localhost:8080/api`  
Health check: `GET http://localhost:8080/api/healthz`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `HR_USERNAME` | HR portal login username (default `admin`) |
| `HR_PASSWORD` | HR portal login password |
| `JWT_SECRET` | JWT signing secret — never change after first deploy |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowed origins (frontend + mobile) |
| `BIOMETRIC_HOST` | eSSL device local IP address |
| `BIOMETRIC_PORT` | ZK protocol port (default `4370`) |
| `BIOMETRIC_PASSWORD` | Device password (default `0`) |
| `SMTP_HOST` | SMTP server for salary slip emails |
| `SMTP_PORT` | SMTP port (default `587`) |
| `SMTP_USER` | SMTP email address |
| `SMTP_PASSWORD` | SMTP password or app password |

## Biometric Sync

```bash
python manage.py sync_biometric --today    # today's records
python manage.py sync_biometric --days 3   # last 3 days
python manage.py sync_biometric --all      # all device records
```

Automatic sync runs at **07:30 AM** and **08:30 PM IST** via APScheduler when the server is running.

## Migrations

```bash
python manage.py migrate                  # apply all migrations
python manage.py migrate --fake-initial   # if tables already exist from old setup
```

Current migrations: `0001` through `0012` (includes department managers feature).
