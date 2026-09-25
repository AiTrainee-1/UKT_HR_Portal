import { defineConfig, devices } from "@playwright/test";

// End-to-end suite. It boots its own backend + frontend on ports that are
// deliberately NOT the dev defaults (8000 / 5173), against a throwaway
// database that e2e_setup.py drops and recreates -so running it can never
// touch a developer's running servers or real data. Servers are never reused
// unless E2E_REUSE_SERVERS=1 is set explicitly (used to iterate on tests
// against a stack that is already up on these same isolated ports).
const reuse = process.env.E2E_REUSE_SERVERS === "1";
const API_PORT = 8180;
const WEB_PORT = 5180;
const FAKE_PORT = 8190;
const backendEnv = {
  DB_NAME: process.env.E2E_DB_NAME ?? "uktex_e2e",
  // runserver opens a thread (and a database connection) per request, and Django keeps each one for 60s by default.
  // A page that fires a burst of API calls then piles up past Postgres's connection limit, shared with the dev
  // database, and random tests get a 503 "database unavailable". Close each connection when its request ends.
  DB_CONN_MAX_AGE: "0",
  DEBUG: "true",
  JWT_SECRET: "e2e-only-jwt-secret-at-least-32-bytes-long",
  DJANGO_SECRET_KEY: "e2e-only-django-secret",
  ALLOWED_HOSTS: "localhost,127.0.0.1",
  // WhatsApp goes to a local fake (e2e/fake-waclient.mjs), never to WAClient: dummy credentials
  // override whatever real ones backend/.env holds, and the API address can't leave the machine.
  WACLIENT_INSTANCE_ID: "e2e-instance",
  WACLIENT_ACCESS_TOKEN: "e2e-token",
  WACLIENT_API_URL: `http://127.0.0.1:${FAKE_PORT}/send`,
  WHATSAPP_SEND_DELAY_SECONDS: "0",
  WHATSAPP_MIN_SEND_GAP_SECONDS: "0",
  EMPLOYEE_PORTAL_URL: "https://portal.e2e.test",
};

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node e2e/fake-waclient.mjs",
      url: `http://127.0.0.1:${FAKE_PORT}/health`,
      reuseExistingServer: reuse,
      timeout: 30_000,
      env: { FAKE_WACLIENT_PORT: String(FAKE_PORT) },
    },
    {
      command: `python e2e_setup.py && python manage.py runserver 127.0.0.1:${API_PORT} --noreload`,
      cwd: "../backend",
      url: `http://127.0.0.1:${API_PORT}/api/healthz`,
      reuseExistingServer: reuse,
      timeout: 180_000,
      env: backendEnv,
    },
    {
      command: "npm run dev",
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: reuse,
      timeout: 120_000,
      env: { PORT: String(WEB_PORT), VITE_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
