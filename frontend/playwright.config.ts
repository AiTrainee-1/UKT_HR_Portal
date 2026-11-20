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
const FAKE_GEMINI_PORT = 8191;
const FAKE_TWOFACTOR_PORT = 8192;
// Fake biometric terminals (backend/fake_zk_device.py): three devices on consecutive TCP ports that speak the ZK protocol,
// and an HTTP control port the Device Control spec uses to reset them and to read back what the portal wrote to them.
const FAKE_DEVICE_BASE_PORT = 14371;
const FAKE_DEVICE_CONTROL_PORT = 14380;
const backendEnv = {
  DB_NAME: process.env.E2E_DB_NAME ?? "uktex_e2e",
  // backend/.env may point DATABASE_URL at a real (even production) database, and a set DATABASE_URL wins over
  // DB_NAME. Blank it so the e2e stack can only ever use its own throwaway database.
  DATABASE_URL: "",
  // runserver opens a thread (and a database connection) per request, and Django keeps each one for 60s by default.
  // A page that fires a burst of API calls then piles up past Postgres's connection limit, shared with the dev
  // database, and random tests get a 503 "database unavailable". Close each connection when its request ends.
  DB_CONN_MAX_AGE: "0",
  DEBUG: "true",
  // The per-IP throttles (api/throttles.py) are flood guards sized for a factory behind one NAT address; this stack signs
  // in hundreds of times from 127.0.0.1, so every rate is lifted to 100000/min. Never set it on a real server.
  THROTTLE_RELAXED: "true",
  JWT_SECRET: "e2e-only-jwt-secret-at-least-32-bytes-long",
  // The Super Admin's login follows ADMIN_USERNAME / ADMIN_PASSWORD at every backend start (api/super_admin_sync.py), and
  // backend/.env holds the owner's real ones: blank here (an empty variable wins over .env) so the stack keeps the
  // e2e_admin account seed_e2e makes instead of renaming it to the owner's login.
  ADMIN_USERNAME: "",
  ADMIN_PASSWORD: "",
  DJANGO_SECRET_KEY: "e2e-only-django-secret",
  ALLOWED_HOSTS: "localhost,127.0.0.1",
  // WhatsApp goes to a local fake of Meta's WhatsApp Cloud API (e2e/fake-meta.mjs), never to Meta: dummy credentials
  // override whatever real ones backend/.env holds, and the API address can't leave the machine.
  // A dev-mode backend (DEBUG) refuses to send WhatsApp unless told otherwise; here it sends only to the local fake, so
  // the development recipient lock (WHATSAPP_ONLY_TO_EMPLOYEES in backend/.env) is blanked: a local fake needs none.
  WHATSAPP_ALLOW_SENDING: "true",
  WHATSAPP_ONLY_TO_EMPLOYEES: "",
  WHATSAPP_CLOUD_API_BASE: `http://127.0.0.1:${FAKE_PORT}`,
  WHATSAPP_CLOUD_API_VERSION: "v23.0",
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: "100000000000001",
  WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID: "200000000000002",
  WHATSAPP_CLOUD_ACCESS_TOKEN: "e2e-meta-access-token",
  WHATSAPP_CLOUD_APP_SECRET: "e2e-meta-app-secret",
  WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN: "e2e-meta-verify-token",
  WHATSAPP_CLOUD_TEMPLATE_LANGUAGE: "en",
  // The e2e stack delivers each WhatsApp message as soon as it is queued (no pacing, caps or quiet hours), so a spec can
  // read the fake right after the action. The queue itself is tested in backend/api/tests_whatsapp_dispatcher.py.
  WHATSAPP_ASYNC_SEND: "false",
  // SMS goes to a local fake of 2Factor (e2e/fake-twofactor.mjs), never to 2Factor: dummy credentials override whatever real
  // ones backend/.env holds (none of them looks like a placeholder, or the server would treat SMS as not set up), and the API
  // address can't leave the machine. A dev-mode backend (DEBUG) refuses to send SMS unless told otherwise; here it sends only
  // to the local fake.
  TWOFACTOR_API_KEY: "e2e-twofactor-key-not-a-real-key",
  TWOFACTOR_TEMPLATE_NAME: "E2E_TF_OTP",
  TWOFACTOR_SENDER_ID: "E2ETFX",
  TWOFACTOR_API_BASE: `http://127.0.0.1:${FAKE_TWOFACTOR_PORT}/API/V1`,
  SMS_ALLOW_SENDING: "true",
  // backend/.env names the developer's own employee for local runserver testing; the e2e stack texts the fake 2Factor
  // only, which needs no recipient list (an empty variable wins over .env).
  SMS_ONLY_TO_EMPLOYEES: "",
  // Same for email: a dev-mode backend refuses to send unless told otherwise. Nothing can leave the machine, because
  // the only SMTP account the tests save points at 127.0.0.1:9 (gmail-control.spec.ts); until then SMTP isn't set up.
  EMAIL_ALLOW_SENDING: "true",
  // The MD's AI assistant talks to a local fake of Google's Gemini API (e2e/fake-gemini.mjs): the real assistant runs
  // against the e2e database, but no key, quota or network is involved and nothing leaves the machine.
  GEMINI_API_KEY: "e2e-fake-gemini-key",
  GEMINI_API_BASE_URL: `http://127.0.0.1:${FAKE_GEMINI_PORT}/v1beta`,
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
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // A fake microphone for the voice tests (the MD portal's assistant records speech): Chromium plays a test tone
        // instead of opening a real device, and does not show its permission prompt.
        launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
      },
    },
  ],
  webServer: [
    {
      command: "node e2e/fake-meta.mjs",
      url: `http://127.0.0.1:${FAKE_PORT}/health`,
      reuseExistingServer: reuse,
      timeout: 30_000,
      env: { FAKE_META_PORT: String(FAKE_PORT) },
    },
    {
      command: "node e2e/fake-twofactor.mjs",
      url: `http://127.0.0.1:${FAKE_TWOFACTOR_PORT}/health`,
      reuseExistingServer: reuse,
      timeout: 30_000,
      env: { FAKE_TWOFACTOR_PORT: String(FAKE_TWOFACTOR_PORT) },
    },
    {
      command: "node e2e/fake-gemini.mjs",
      url: `http://127.0.0.1:${FAKE_GEMINI_PORT}/health`,
      reuseExistingServer: reuse,
      timeout: 30_000,
      env: { FAKE_GEMINI_PORT: String(FAKE_GEMINI_PORT) },
    },
    {
      command: `python fake_zk_device.py --base-port ${FAKE_DEVICE_BASE_PORT} --count 3 --control-port ${FAKE_DEVICE_CONTROL_PORT}`,
      cwd: "../backend",
      url: `http://127.0.0.1:${FAKE_DEVICE_CONTROL_PORT}/health`,
      reuseExistingServer: reuse,
      timeout: 30_000,
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
