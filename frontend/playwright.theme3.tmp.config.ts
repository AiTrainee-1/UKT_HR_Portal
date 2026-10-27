import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// TEMPORARY (THEME-3 integration of the Clean Professional theme): the base config's stack on its own ports and throwaway
// database. Deleted when the work ends.
const API_PORT = 8230;
const WEB_PORT = 5230;
const FAKE_PORT = 18236;
const FAKE_TWOFACTOR_PORT = 18237;
const FAKE_GEMINI_PORT = 18238;
const FAKE_DEVICE_BASE_PORT = 14671;
const FAKE_DEVICE_CONTROL_PORT = 14680;
const DB = "uktex_theme3_e2e";

const backendEnv = {
  DB_NAME: DB,
  DATABASE_URL: "",
  DB_CONN_MAX_AGE: "0",
  DEBUG: "true",
  THROTTLE_RELAXED: "true",
  JWT_SECRET: "e2e-only-jwt-secret-at-least-32-bytes-long",
  DJANGO_SECRET_KEY: "e2e-only-django-secret",
  ALLOWED_HOSTS: "localhost,127.0.0.1",
  WHATSAPP_ALLOW_SENDING: "true",
  WACLIENT_INSTANCE_ID: "e2e-instance",
  WACLIENT_ACCESS_TOKEN: "e2e-token",
  WACLIENT_API_URL: `http://127.0.0.1:${FAKE_PORT}/send`,
  WHATSAPP_SEND_DELAY_SECONDS: "0",
  WHATSAPP_MIN_SEND_GAP_SECONDS: "0",
  TWOFACTOR_API_KEY: "e2e-twofactor-key-not-a-real-key",
  TWOFACTOR_TEMPLATE_NAME: "E2E_TF_OTP",
  TWOFACTOR_SENDER_ID: "E2ETFX",
  TWOFACTOR_API_BASE: `http://127.0.0.1:${FAKE_TWOFACTOR_PORT}/API/V1`,
  SMS_ALLOW_SENDING: "true",
  EMAIL_ALLOW_SENDING: "true",
  GEMINI_API_KEY: "e2e-fake-gemini-key",
  GEMINI_API_BASE_URL: `http://127.0.0.1:${FAKE_GEMINI_PORT}/v1beta`,
};

export default defineConfig({
  ...base,
  outputDir: "test-results/theme3",
  reporter: [["list"]],
  use: { ...base.use, baseURL: `http://127.0.0.1:${WEB_PORT}` },
  projects: [{ name: "chrome", use: { channel: "chrome" } }],
  webServer: [
    {
      command: "node e2e/fake-waclient.mjs",
      url: `http://127.0.0.1:${FAKE_PORT}/health`,
      reuseExistingServer: true,
      timeout: 30_000,
      env: { FAKE_WACLIENT_PORT: String(FAKE_PORT) },
    },
    {
      command: "node e2e/fake-twofactor.mjs",
      url: `http://127.0.0.1:${FAKE_TWOFACTOR_PORT}/health`,
      reuseExistingServer: true,
      timeout: 30_000,
      env: { FAKE_TWOFACTOR_PORT: String(FAKE_TWOFACTOR_PORT) },
    },
    {
      command: "node e2e/fake-gemini.mjs",
      url: `http://127.0.0.1:${FAKE_GEMINI_PORT}/health`,
      reuseExistingServer: true,
      timeout: 30_000,
      env: { FAKE_GEMINI_PORT: String(FAKE_GEMINI_PORT) },
    },
    {
      command: `python fake_zk_device.py --base-port ${FAKE_DEVICE_BASE_PORT} --count 3 --control-port ${FAKE_DEVICE_CONTROL_PORT}`,
      cwd: "../backend",
      url: `http://127.0.0.1:${FAKE_DEVICE_CONTROL_PORT}/health`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
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
