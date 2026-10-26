import { defineConfig } from "@playwright/test";

// TEMPORARY (payroll area sweep of the Clean Professional theme): an isolated stack on its own ports and database.
const API_PORT = 8203;
const WEB_PORT = 5203;
const backendEnv = {
  DB_NAME: "uktex_theme_payr_e2e",
  DATABASE_URL: "",
  DB_CONN_MAX_AGE: "0",
  DEBUG: "true",
  THROTTLE_RELAXED: "true",
  JWT_SECRET: "e2e-only-jwt-secret-at-least-32-bytes-long",
  DJANGO_SECRET_KEY: "e2e-only-django-secret",
  ALLOWED_HOSTS: "localhost,127.0.0.1",
  WHATSAPP_ALLOW_SENDING: "false",
  SMS_ALLOW_SENDING: "false",
  EMAIL_ALLOW_SENDING: "false",
};

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results/payr",
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, trace: "off", screenshot: "off" },
  projects: [{ name: "chrome", use: { channel: "chrome" } }],
  webServer: [
    {
      command: `python e2e_setup.py && python manage.py runserver 127.0.0.1:${API_PORT} --noreload`,
      cwd: "../backend",
      url: `http://127.0.0.1:${API_PORT}/api/healthz`,
      reuseExistingServer: true,
      timeout: 240_000,
      env: backendEnv,
    },
    {
      command: "npm run dev",
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { PORT: String(WEB_PORT), VITE_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
