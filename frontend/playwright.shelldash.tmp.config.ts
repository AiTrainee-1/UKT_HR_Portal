import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Temporary: the shell + dashboard + employees + organization sweep of the Clean Professional theme.
// Own ports (backend 8201, frontend 5201) and an own throwaway database; deleted when the sweep is done.
const API_PORT = 8201;
const WEB_PORT = 5201;

export default defineConfig({
  ...base,
  testDir: "./e2e",
  outputDir: "test-results/shelldash",
  use: { ...base.use, baseURL: `http://127.0.0.1:${WEB_PORT}` },
  projects: [{ name: "chrome", use: { channel: "chrome" } }],
  webServer: [
    {
      command: `python e2e_setup.py && python manage.py runserver 127.0.0.1:${API_PORT} --noreload`,
      cwd: "../backend",
      url: `http://127.0.0.1:${API_PORT}/api/healthz`,
      reuseExistingServer: process.env.E2E_REUSE_SERVERS === "1",
      timeout: 180_000,
      env: {
        DB_NAME: "uktex_theme_shelldash_e2e",
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
      },
    },
    {
      command: "npm run dev",
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: process.env.E2E_REUSE_SERVERS === "1",
      timeout: 120_000,
      env: { PORT: String(WEB_PORT), VITE_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
