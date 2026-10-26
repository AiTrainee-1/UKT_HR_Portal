import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// TEMPORARY (clean-theme area sweep "setrep"): the base config's stack on its own ports and database. Deleted when done.
const API_PORT = 8204;
const WEB_PORT = 5204;
const backendEnv = {
  DB_NAME: "uktex_theme_setrep_e2e",
  DATABASE_URL: "",
  DB_CONN_MAX_AGE: "0",
  DEBUG: "true",
  THROTTLE_RELAXED: "true",
  JWT_SECRET: "e2e-only-jwt-secret-at-least-32-bytes-long",
  DJANGO_SECRET_KEY: "e2e-only-django-secret",
  ALLOWED_HOSTS: "localhost,127.0.0.1",
  EMAIL_ALLOW_SENDING: "false",
  WHATSAPP_ALLOW_SENDING: "false",
  SMS_ALLOW_SENDING: "false",
};

export default defineConfig({
  ...base,
  testDir: "./e2e",
  outputDir: "test-results/setrep",
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, trace: "off", screenshot: "off" },
  projects: [{ name: "chrome", use: { channel: "chrome" } }],
  webServer: [
    {
      command: `python e2e_setup.py && python manage.py runserver 127.0.0.1:${API_PORT} --noreload`,
      cwd: "../backend",
      url: `http://127.0.0.1:${API_PORT}/api/healthz`,
      reuseExistingServer: true,
      timeout: 180_000,
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
