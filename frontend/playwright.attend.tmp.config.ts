import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// TEMPORARY (attendance-area theme sweep): own ports and own throwaway database, no fake terminals/WhatsApp/SMS.
const API_PORT = 8202;
const WEB_PORT = 5202;
const reuse = process.env.E2E_REUSE_SERVERS === "1";

const backendEnv = {
  DB_NAME: "uktex_theme_attend_e2e",
  DATABASE_URL: "",
  DB_CONN_MAX_AGE: "0",
  DEBUG: "true",
  THROTTLE_RELAXED: "true",
  JWT_SECRET: "e2e-only-jwt-secret-at-least-32-bytes-long",
  DJANGO_SECRET_KEY: "e2e-only-django-secret",
  ALLOWED_HOSTS: "localhost,127.0.0.1",
  WACLIENT_INSTANCE_ID: "e2e-instance",
  WACLIENT_ACCESS_TOKEN: "e2e-token",
  WACLIENT_API_URL: "http://127.0.0.1:9/send",
  TWOFACTOR_API_KEY: "e2e-twofactor-key-not-a-real-key",
  TWOFACTOR_API_BASE: "http://127.0.0.1:9/API/V1",
};

export default defineConfig({
  ...base,
  outputDir: "test-results/attend",
  reporter: [["list"]],
  use: { ...base.use, baseURL: `http://127.0.0.1:${WEB_PORT}` },
  projects: [{ name: "chrome", use: { channel: "chrome" } }],
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
