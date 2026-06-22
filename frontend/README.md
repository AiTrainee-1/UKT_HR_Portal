# UK Textile — Frontend (React)

React + Vite SPA for the UK Textile HR platform. Talks to the Django backend at `/api` (proxied in dev).

## Setup

```bash
cd frontend
npm install
copy .env.example .env
```

## Run (development)

Start the [backend](../backend/README.md) on port **8080**, then:

```bash
npm run dev
```

Open **http://localhost:5173**

Vite proxies `http://localhost:5173/api/*` → `http://localhost:8080/api/*`.

## Production build

```bash
npm run build
npm run preview
```

Set `VITE_API_URL` to your deployed API origin (e.g. `https://api.example.com`) if the API is not served on the same host under `/api`.

## Stack

- React 19, Vite 7, TypeScript
- TanStack Query + generated API client (`src/lib/api-client`)
- wouter routing, Tailwind CSS 4, shadcn/Radix UI, Recharts
