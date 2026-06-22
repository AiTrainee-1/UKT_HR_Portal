# UK Textile — Backend (Django)

REST API matching the original Express/OpenAPI contract at `/api/*`.

## Setup

```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\activate

pip install -r requirements.txt
copy .env.example .env
```

Create the PostgreSQL database, then apply schema:

```bash
python manage.py migrate
```

If you already have tables from the old Node/Drizzle setup, run:

```bash
python manage.py migrate --fake-initial
```

## Run

```bash
python manage.py runserver 8080
```

API base: `http://localhost:8080/api`

Health check: `GET http://localhost:8080/api/healthz`

## Environment

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `HR_USERNAME` | HR login username (default `admin`) |
| `HR_PASSWORD` | HR login password |
| `JWT_SECRET` | JWT signing key (must match if migrating tokens) |
| `CORS_ALLOWED_ORIGINS` | Comma-separated frontend URLs |
