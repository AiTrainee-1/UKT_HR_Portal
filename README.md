# UK Textile HR Management System

The project is split into two independent applications:

| Folder | Stack | Port (dev) |
|--------|--------|------------|
| [`frontend/`](frontend/) | React 19 + Vite | 5173 |
| [`backend/`](backend/) | Python Django + DRF | 8080 |

The React UI and REST API contract are unchanged from the original monorepo. The Django backend implements the same `/api/*` endpoints, JSON shapes, and JWT auth as the previous Express server.

## Quick start

### 1. Database

Create PostgreSQL database `uk_textile` (or adjust `DATABASE_URL` in `backend/.env`).

### 2. Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
copy .env.example .env
python manage.py migrate
python manage.py runserver 8080
```

### 3. Frontend

```bash
cd frontend
npm install
copy .env.example .env
npm run dev
```

Open **http://localhost:5173**

### HR login

- Username: `admin` (or `HR_USERNAME` in `backend/.env`)
- Password: value of `HR_PASSWORD` in `backend/.env` (default `admin123` in examples)

## Architecture

```
frontend (React)  --HTTP /api/*-->  backend (Django)
                                         |
                                    PostgreSQL
```

In development, Vite proxies `/api` to `http://localhost:8080`. In production, serve the React build behind nginx (or similar) and point `VITE_API_URL` at the Django API host, with CORS configured in `backend/.env`.
