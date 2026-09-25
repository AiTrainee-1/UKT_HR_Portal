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
const backendEnv = {
  DB_NAME: process.env.E2E_DB_NAME ?? "uktex_e2e",
  DEBUG: "true",
  JWT_SECRET: "e2e-only-jwt-secret-at-least-32-bytes-long",
  DJANGO_SECRET_KEY: "e2e-only-django-secret",
  ALLOWED_HOSTS: "localhost,127.0.0.1",
  // Never let a test run use the developer's live WhatsApp credentials from backend/.env.
  WACLIENT_INSTANCE_ID: "",
  WACLIENT_ACCESS_TOKEN: "",
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
