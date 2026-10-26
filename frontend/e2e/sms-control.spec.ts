import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// SMS Control (HR portal) and the SMS delivery of login / reset / activation codes, end to end against the real backend and a
// FAKE 2Factor (e2e/fake-twofactor.mjs, :8192) that records every request it receives and hands the spec the code an employee
// would have got by SMS. Nothing leaves the machine: playwright.config.ts points TWOFACTOR_API_BASE at the fake and sets
// SMS_ALLOW_SENDING=true because this is a dev-mode (DEBUG) backend.
//
// Everything created here is prefixed "SMS" / "sms_" and removed again, and the SMS settings are put back as they were (the
// WhatsApp channel, the default limits), so the other specs only ever see the seed data and WhatsApp codes.
//
// The whole file SKIPS when the backend has no /api/sms-control yet (a 404), so it can be committed before the backend.

const FAKE = "http://127.0.0.1:8192";
const FAKE_WHATSAPP = "http://127.0.0.1:8190";
// must match TWOFACTOR_API_KEY / TWOFACTOR_TEMPLATE_NAME in playwright.config.ts
const AUTH_KEY = "e2e-twofactor-key-not-a-real-key";
const TEMPLATE_NAME = "E2E_TF_OTP";
const TEMPLATE_TEXT =
  "XXXX is your UK Textiles HRMS OTP. Official message from UK Textiles. Do not share it with anyone.";
const PASSWORD = "Passw0rd!smsx";
const PAGE = "/hr/sms-control";

let backendReady = false;
let adminToken = "";
let viewerToken = "";
let nobodyToken = "";
let branchToken = "";
let originalSettings: Record<string, unknown> = {};
const employees: Record<string, { id: number; code: string; phone: string }> = {};
// every code an employee was sent in this spec: none of them may ever show up in the log or on the page
const usedCodes: string[] = [];

type Reply = { status: number; body: any };

async function signIn(request: APIRequestContext, username: string, password: string) {
  const res = await request.post("/api/auth/hr-login", { data: { username, password } });
  expect(res.status(), `sign in as ${username}`).toBe(200);
  return (await res.json()).token as string;
}

async function api(
  request: APIRequestContext,
  token: string | null,
  method: string,
  url: string,
  data?: unknown,
): Promise<Reply> {
  const res = await request.fetch(url, { method, headers: token ? { Authorization: `Bearer ${token}` } : {}, data });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status(), body };
}

const admin = (request: APIRequestContext, method: string, url: string, data?: unknown) =>
  api(request, adminToken, method, url, data);

const SETTINGS_KEYS = [
  "otpChannel",
  "otpLoginEnabled",
  "otpResetEnabled",
  "otpActivateEnabled",
  "otpExpiryMinutes",
  "resendCooldownSeconds",
  "maxRequestsPerHour",
  "maxAttemptsPerCode",
  "maxPerPhonePerHour",
  "hourlyCap",
  "dailyCap",
];

/** Puts the SMS settings back as they were when the spec started. */
async function restoreSettings(request: APIRequestContext) {
  const body = Object.fromEntries(
    SETTINGS_KEYS.filter((k) => k in originalSettings).map((k) => [k, originalSettings[k]]),
  );
  if (Object.keys(body).length > 0) await admin(request, "PUT", "/api/sms-control/settings", body);
}

async function purge(request: APIRequestContext) {
  const emps = (await admin(request, "GET", "/api/employees")).body as { id: number; employeeCode: string }[];
  for (const e of emps ?? []) {
    if (e.employeeCode.startsWith("SMS-")) await admin(request, "DELETE", `/api/employees/${e.id}`);
  }
  const users = (await admin(request, "GET", "/api/hr-users")).body as { id: number; username: string }[];
  for (const u of (users ?? []).filter((u) => u.username.startsWith("sms_"))) {
    await admin(request, "DELETE", `/api/hr-users/${u.id}`);
  }
  const roles = (await admin(request, "GET", "/api/roles")).body as { id: number; name: string }[];
  for (const r of (roles ?? []).filter((r) => r.name.startsWith("sms_"))) {
    await admin(request, "DELETE", `/api/roles/${r.id}`);
  }
}

/** The code the fake 2Factor last received for this number, remembered so the spec can check it never leaks. */
async function codeFor(request: APIRequestContext, phone: string): Promise<string> {
  const res = await request.get(`${FAKE}/last-code?mobile=${phone}`);
  expect(res.status(), `an SMS reached the fake 2Factor for ${phone}`).toBe(200);
  const { code } = await res.json();
  expect(code).toMatch(/^\d{4}$/);
  usedCodes.push(code);
  return code;
}

const wrongCode = (code: string) => (code === "0000" ? "1111" : "0000");

const asEmployee = (key: string) => employees[key];

async function ask(request: APIRequestContext, key: string, purpose: "login" | "reset" | "activate") {
  return api(request, null, "POST", "/api/auth/otp/request", { employeeCode: asEmployee(key).code, purpose });
}

/** Opens a page already signed in as `token` (no sign-in screen: the server throttles those). */
async function openAs(page: Page, token: string, path: string) {
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), token);
  await page.goto(path);
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const rows = (page: Page) => page.getByTestId("sms-message-row");

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  adminToken = await signIn(request, HR_USERNAME, HR_PASSWORD);
  const probe = await admin(request, "GET", "/api/sms-control/overview");
  backendReady = probe.status !== 404;
  if (!backendReady) return;

  await purge(request);
  await request.post(`${FAKE}/reset`);
  originalSettings = (await admin(request, "GET", "/api/sms-control/settings")).body;

  const branches = (await admin(request, "GET", "/api/branches")).body as { id: number }[];
  const make = async (key: string, last: string, phone: string) => {
    const code = `SMS-${key}`;
    const res = await admin(request, "POST", "/api/employees", {
      employeeCode: code,
      firstName: "Sms",
      lastName: last,
      phone,
      employmentType: "staff",
      branchId: branches[0].id,
      salaryType: "monthly",
      salaryAmount: 20000,
      joinDate: "2024-01-01",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    employees[key] = { id: res.body.id, code, phone };
  };
  await make("A", "Alpha", "9000000081"); // activates by SMS
  await make("B", "Bravo", "9000000082"); // signs in by SMS, and meets the cooldown
  await make("C", "Charlie", "9000000083"); // resets a password by SMS
  await make("D", "Delta", "9000000084"); // meets the hourly cap
  await make("E", "Echo", "9000000085"); // shares a phone with F
  await make("F", "Foxtrot", "9000000085");
  await make("G", "Golf", "9000000086"); // the breaker
  await make("H", "Hotel", "9000000087"); // the breaker
  await make("I", "India", "9000000088"); // the breaker
  await make("J", "Juliet", "9000000089"); // WhatsApp again

  const role = async (name: string, permissions: Record<string, string>) => {
    const res = await admin(request, "POST", "/api/roles", { name, permissions });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as number;
  };
  const viewRole = await role("sms_view", { sms_control: "view" });
  const editRole = await role("sms_edit", { sms_control: "edit" });
  const noRole = await role("sms_none", { attendance: "view" });
  const user = async (username: string, roleId: number, extra: Record<string, unknown> = {}) => {
    const res = await admin(request, "POST", "/api/hr-users", { username, password: PASSWORD, roleId, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return signIn(request, username, PASSWORD);
  };
  viewerToken = await user("sms_viewer", viewRole);
  nobodyToken = await user("sms_nobody", noRole);
  branchToken = await user("sms_branch", editRole, { branchId: branches[0].id });
});

test.afterAll(async ({ request }) => {
  if (!backendReady) return;
  await restoreSettings(request);
  await purge(request);
  await request.post(`${FAKE}/reset`);
  await request.post(`${FAKE_WHATSAPP}/reset`);
});

test.beforeEach(() => {
  test.skip(!backendReady, "this backend has no /api/sms-control yet (it answered 404)");
});

// ── who may use the API ─────────────────────────────────────────────────────

test("the SMS Control API needs a login, and a role needs the module", async ({ request }) => {
  for (const path of ["overview", "settings", "messages"]) {
    expect((await request.get(`/api/sms-control/${path}`)).status(), path).toBe(401);
  }
  expect((await request.put("/api/sms-control/settings", { data: { hourlyCap: 10 } })).status()).toBe(401);
  expect((await request.post("/api/sms-control/test", { data: { phone: "9876543210" } })).status()).toBe(401);

  // a role without the module sees nothing of it
  for (const path of ["overview", "settings", "messages"]) {
    expect((await api(request, nobodyToken, "GET", `/api/sms-control/${path}`)).status, `no module: ${path}`).toBe(403);
  }

  // View Only reads everything and changes nothing
  for (const path of ["overview", "settings", "messages"]) {
    expect((await api(request, viewerToken, "GET", `/api/sms-control/${path}`)).status, `view: ${path}`).toBe(200);
  }
  expect((await api(request, viewerToken, "PUT", "/api/sms-control/settings", { hourlyCap: 10 })).status).toBe(403);
  expect((await api(request, viewerToken, "POST", "/api/sms-control/test", { phone: "9876543210" })).status).toBe(403);

  // a branch login reads, but the settings and the test are company-wide
  expect((await api(request, branchToken, "GET", "/api/sms-control/overview")).status).toBe(200);
  const put = await api(request, branchToken, "PUT", "/api/sms-control/settings", { hourlyCap: 10 });
  expect(put.status).toBe(403);
  expect(put.body.code).toBe("company_wide_settings");
  expect((await api(request, branchToken, "POST", "/api/sms-control/test", { phone: "9876543210" })).status).toBe(403);

  // and nothing a role can read contains the auth key
  for (const path of ["overview", "settings", "messages"]) {
    const body = JSON.stringify((await admin(request, "GET", `/api/sms-control/${path}`)).body);
    expect(body, path).not.toContain(AUTH_KEY);
  }
  const overview = (await admin(request, "GET", "/api/sms-control/overview")).body;
  expect(overview.env).toMatchObject({ authKey: true, senderId: "E2ETFX", templateName: "E2E_TF_OTP" });
  expect(overview.provider).toBe("twofactor");
  expect(typeof overview.env.authKey).toBe("boolean");
});

test("until HR switches, WhatsApp is still how codes go", async ({ request }) => {
  expect(originalSettings.otpChannel).toBe("whatsapp");
  const options = await (await request.get("/api/auth/login-options")).json();
  expect(options).toMatchObject({ otpChannel: "whatsapp", otpLogin: true, passwordLogin: true });
});

// ── the page ────────────────────────────────────────────────────────────────

test("HR finds SMS Control in the sidebar and sees all five tabs, with Overview in plain words", async ({ page }) => {
  await openAs(page, adminToken, "/hr/dashboard");
  await expect(page.getByRole("link", { name: "SMS Control" })).toBeVisible();
  await page.getByRole("link", { name: "SMS Control" }).click();
  await expect(page).toHaveURL(/\/hr\/sms-control\/overview$/);
  await expect(page.getByRole("heading", { name: "SMS Control" })).toBeVisible();
  for (const name of ["Overview", "Settings", "Messages", "Test", "Setup"]) {
    await expect(tab(page, name)).toBeVisible();
  }
  // exactly one Refresh button, in the title row (the page has its own)
  await expect(page.getByRole("button", { name: /^\s*Refresh( this page)?\s*$/ })).toHaveCount(1);
  await expect(page.getByTestId("page-refresh-bar")).toHaveCount(0);

  await expect(page.getByTestId("sms-card-channel")).toContainText("WhatsApp");
  await expect(page.getByTestId("sms-card-configured")).toContainText("Yes");
  await expect(page.getByTestId("sms-card-sending")).toContainText("Allowed");
  await expect(page.getByTestId("sms-card-circuit")).toContainText("Working");
  await expect(page.getByTestId("sms-card-balance")).toBeVisible();
  await expect(page.getByTestId("sms-chart")).toBeVisible();
  // 2Factor is ready and the channel is WhatsApp: the checklist explains switching
  await expect(page.getByTestId("sms-step-switch")).toContainText("Codes still go by WhatsApp");
  // nothing on the page is the auth key
  await expect(page.locator("body")).not.toContainText(AUTH_KEY);
});

test("the tabs have addresses, and an address that stops early or is unknown lands on the first one", async ({
  page,
}) => {
  await openAs(page, adminToken, PAGE);
  await expect(page).toHaveURL(/\/hr\/sms-control\/overview$/);
  await page.goto(`${PAGE}/settings`);
  await expect(page).toHaveURL(/\/hr\/sms-control\/settings\/channel$/);
  await page.goto(`${PAGE}/nope/deeper`);
  await expect(page).toHaveURL(/\/hr\/sms-control\/overview$/);
  await page.goto(`${PAGE}/settings/limits`);
  await expect(page.getByTestId("sms-section-limits")).toBeVisible();
  // only the open section is on the page
  await expect(page.getByTestId("sms-section-channel")).toHaveCount(0);
  await expect(page.getByTestId("sms-section-switches")).toHaveCount(0);
  await tab(page, "Messages").click();
  await expect(page).toHaveURL(/\/hr\/sms-control\/messages$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/hr\/sms-control\/settings\/limits$/);
});

test("at 390 px wide no tab pushes the page sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const open = async (path: string, marker: string) => {
    await page.goto(path);
    await expect(page.getByTestId(marker)).toBeVisible();
    const overflow = await page.evaluate(() => {
      const main = document.querySelector("main")!;
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        main: main.scrollWidth - main.clientWidth,
      };
    });
    expect(overflow.page, `${path} scrolls the document sideways`).toBeLessThanOrEqual(1);
    expect(overflow.main, `${path} scrolls the page sideways`).toBeLessThanOrEqual(1);
  };
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), adminToken);
  await open(`${PAGE}/overview`, "sms-overview");
  await open(`${PAGE}/settings/channel`, "sms-section-channel");
  await open(`${PAGE}/settings/limits`, "sms-section-limits");
  await open(`${PAGE}/settings/switches`, "sms-section-switches");
  await open(`${PAGE}/messages`, "sms-message-table");
  await open(`${PAGE}/test`, "sms-test");
  await open(`${PAGE}/setup`, "sms-setup");
});

test("Setup lists what the server needs by name, copies the template text, and never asks for a secret", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openAs(page, adminToken, `${PAGE}/setup`);
  for (const name of [
    "TWOFACTOR_API_KEY",
    "TWOFACTOR_SENDER_ID",
    "TWOFACTOR_TEMPLATE_NAME",
    "TWOFACTOR_API_BASE",
    "SMS_ALLOW_SENDING",
  ]) {
    await expect(page.getByTestId(`sms-env-${name}`)).toContainText(name);
  }
  for (const flag of ["authKey", "senderId", "templateName"]) {
    await expect(page.getByTestId(`sms-env-state-${flag}`)).toHaveText("Set");
  }
  await expect(page.getByTestId("sms-setup-secret")).toContainText("only ever kept on the server");
  await expect(page.getByTestId("sms-2f-template-text")).toContainText(TEMPLATE_TEXT);
  await expect(page.getByTestId("sms-2f-template-name")).toContainText("UKT_HRMS_OTP");
  await expect(page.getByTestId("sms-2f-sender-id")).toContainText("UKTHRM");
  await expect(page.getByText("twofactor-sms-otp-integration.md")).toBeVisible();
  // there is no box to type a key into, and the page never shows one
  await expect(page.getByTestId("sms-setup").locator("input, textarea, select")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(AUTH_KEY);

  await page.getByTestId("sms-2f-template-text").getByRole("button", { name: /^Copy/ }).click();
  await expect(page.getByTestId("sms-2f-template-text")).toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TEMPLATE_TEXT);
});

// ── the test SMS ────────────────────────────────────────────────────────────

test("a test SMS goes through 2Factor, is logged without the number, and tests are limited to three an hour", async ({
  page,
  request,
}) => {
  await request.post(`${FAKE}/reset`);
  await openAs(page, adminToken, `${PAGE}/test`);
  const phone = page.getByLabel("Mobile number");
  const send = page.getByRole("button", { name: "Send a test SMS" });
  await expect(page.getByTestId("sms-test-preview")).toContainText("1234 is your UK Textiles HRMS OTP.");

  // a number that is not a mobile number is refused on the page, and nothing is sent
  await phone.fill("12345");
  await send.click();
  await expect(phone).toHaveAttribute("aria-invalid", "true");
  expect((await (await request.get(`${FAKE}/requests`)).json()).length).toBe(0);

  // 1: accepted
  await phone.fill("98765 43210");
  await send.click();
  await expect(page.getByTestId("sms-test-ok")).toContainText("••••••3210");
  const sent = await (await request.get(`${FAKE}/requests`)).json();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ authkey: AUTH_KEY, templateId: TEMPLATE_NAME, code: "1234" });
  expect(sent[0].mobile).toBe("919876543210");

  // 2: 2Factor refuses it: the page says so in plain words
  await request.post(`${FAKE}/fail-next`, { data: { times: 1 } });
  await phone.fill("9876543211");
  await send.click();
  await expect(page.getByTestId("sms-test-refused")).toContainText("was not sent");

  // 3: accepted, through the API
  const third = await admin(request, "POST", "/api/sms-control/test", { phone: "9876543212" });
  expect(third.status).toBe(200);
  expect(third.body.ok).toBe(true);

  // 4: over the limit: the server's own sentence is shown
  await phone.fill("9876543213");
  await send.click();
  await expect(page.getByTestId("sms-test-failed")).toContainText("3 test messages per hour");
  expect((await (await request.get(`${FAKE}/requests`)).json()).filter((r: any) => !r.failed)).toHaveLength(2);

  // the log has them as test messages, with the number hidden and 2Factor's id
  await tab(page, "Messages").click();
  const sentRow = rows(page).filter({ hasText: "••••••3210" });
  await expect(sentRow).toHaveCount(1);
  await expect(sentRow).toContainText("Test message");
  await expect(sentRow).toContainText("Sent");
  await expect(sentRow).toContainText("FAKE2F");
  await expect(rows(page).filter({ hasText: "••••••3211" })).toContainText("Failed");
  await expect(page.locator("body")).not.toContainText("9876543210");
  await expect(page.locator("body")).not.toContainText("1234");

  // Overview counts them
  await tab(page, "Overview").click();
  await expect(page.getByTestId("sms-today-sent")).toHaveText(/^[2-9]\d* sent$/);
  await expect(page.getByTestId("sms-today-failed")).toHaveText("1 failed");
});

// ── the settings ────────────────────────────────────────────────────────────

test("a limit outside its range is refused where it is typed; a good one saves, and one Save is one section", async ({
  page,
  request,
}) => {
  await openAs(page, adminToken, `${PAGE}/settings/limits`);
  const expiry = page.getByLabel("How long a code works");
  const save = page.getByTestId("sms-limits-save-row-save");

  await expiry.fill("99");
  await expect(
    page.getByTestId("sms-setting-otpExpiryMinutes").getByText("Enter a whole number from 1 to 15."),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  await expiry.fill("7");
  await expect(page.getByTestId("sms-example-otpExpiryMinutes")).toContainText("10:07");
  await expect(save).toBeEnabled();

  // an unsaved choice in Channel does not go with the limits
  await page.getByTestId("sms-settings-nested-channel").click();
  await page.getByTestId("sms-channel-sms").locator("input").check();
  await page.getByTestId("sms-settings-nested-limits").click();
  await expect(expiry).toHaveValue("7");
  await save.click();
  await expect(page.getByTestId("sms-limits-save-row")).toHaveAttribute("data-dirty", "false");

  const saved = (await admin(request, "GET", "/api/sms-control/settings")).body;
  expect(saved.otpExpiryMinutes).toBe(7);
  expect(saved.otpChannel).toBe("whatsapp");
  expect(saved.updatedBy).toBeTruthy();
});

test("a copy of the settings that somebody else has outdated is refused, and can be reloaded", async ({
  page,
  request,
}) => {
  await openAs(page, adminToken, `${PAGE}/settings/limits`);
  const expiry = page.getByLabel("How long a code works");
  await expect(expiry).toHaveValue("7");
  await expiry.fill("9");

  // somebody else saves first
  expect((await admin(request, "PUT", "/api/sms-control/settings", { otpExpiryMinutes: 6 })).status).toBe(200);

  await page.getByTestId("sms-limits-save-row-save").click();
  await expect(page.getByTestId("sms-limits-error")).toContainText("Someone else saved these settings");
  await expect(expiry).toHaveValue("9");
  expect((await admin(request, "GET", "/api/sms-control/settings")).body.otpExpiryMinutes).toBe(6);

  await page.getByRole("button", { name: "Reload the saved settings" }).click();
  await page.getByRole("button", { name: "Reload and discard" }).click();
  await expect(page.getByTestId("sms-limits-error")).toHaveCount(0);
  await expect(expiry).toHaveValue("6");
  await expiry.fill("5");
  await page.getByTestId("sms-limits-save-row-save").click();
  await expect(page.getByTestId("sms-limits-save-row")).toHaveAttribute("data-dirty", "false");
  expect((await admin(request, "GET", "/api/sms-control/settings")).body.otpExpiryMinutes).toBe(5);
});

test("switching the channel to SMS asks first, and the login screens follow", async ({ page, request }) => {
  await openAs(page, adminToken, `${PAGE}/settings/channel`);
  await page.getByTestId("sms-channel-sms").locator("input").check();
  await page.getByTestId("sms-channel-save-row-save").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Send codes by SMS?");
  await expect(dialog).toContainText("WhatsApp keeps sending every other message");

  // Cancel: nothing changed
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect((await admin(request, "GET", "/api/sms-control/settings")).body.otpChannel).toBe("whatsapp");

  // Yes: saved, and shown as in use
  await page.getByTestId("sms-channel-save-row-save").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Yes, use SMS" }).click();
  await expect(page.getByTestId("sms-channel-sms")).toContainText("In use now");
  expect((await admin(request, "GET", "/api/sms-control/settings")).body.otpChannel).toBe("sms");

  // login-options names the channel, and the code methods are on (2Factor is set up and this machine may send)
  const options = await (await request.get("/api/auth/login-options")).json();
  expect(options).toMatchObject({
    otpChannel: "sms",
    otpLogin: true,
    otpReset: true,
    otpActivate: true,
    passwordLogin: true,
  });

  await tab(page, "Overview").click();
  await expect(page.getByTestId("sms-card-channel")).toContainText("SMS");
  await expect(page.getByTestId("sms-step-switch")).toHaveCount(0);
});

test("the three switches turn each code feature off for the login screens", async ({ page, request }) => {
  await openAs(page, adminToken, `${PAGE}/settings/switches`);
  const reset = page.getByRole("switch", { name: "Forgot password by code" });
  await expect(reset).toBeChecked();
  await reset.click();
  await page.getByTestId("sms-switches-save-row-save").click();
  await expect(page.getByTestId("sms-switches-save-row")).toHaveAttribute("data-dirty", "false");
  let options = await (await request.get("/api/auth/login-options")).json();
  expect(options).toMatchObject({ otpChannel: "sms", otpLogin: true, otpReset: false, otpActivate: true });
  const refused = await ask(request, "C", "reset");
  expect(refused.status).toBeGreaterThanOrEqual(400);

  await reset.click();
  await page.getByTestId("sms-switches-save-row-save").click();
  await expect(page.getByTestId("sms-switches-save-row")).toHaveAttribute("data-dirty", "false");
  options = await (await request.get("/api/auth/login-options")).json();
  expect(options.otpReset).toBe(true);
});

// ── employees, by SMS ───────────────────────────────────────────────────────

test("a new employee activates by SMS: the code reaches 2Factor, never WhatsApp, and a wrong code sets nothing", async ({
  request,
}) => {
  await request.post(`${FAKE}/reset`);
  await request.post(`${FAKE_WHATSAPP}/reset`);
  const a = asEmployee("A");

  const requested = await ask(request, "A", "activate");
  expect(requested.status, JSON.stringify(requested.body)).toBe(200);
  expect(requested.body.channel).toBe("sms");
  expect(requested.body.message).toContain("SMS");
  expect(requested.body.message).not.toContain("WhatsApp");
  expect(requested.body.maskedPhone).toMatch(/0081$/);
  expect(requested.body.resendAfterSeconds).toBeGreaterThanOrEqual(30);
  expect(requested.body.expiresInSeconds).toBeGreaterThan(0);

  // the SMS went to the number on file, through the real template (its NAME is in the call)
  const sent = await (await request.get(`${FAKE}/requests?mobile=${a.phone}`)).json();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ authkey: AUTH_KEY, templateId: TEMPLATE_NAME });
  expect(sent[0].mobile).toBe(`91${a.phone}`);
  // WhatsApp was not used
  expect(await (await request.get(`${FAKE_WHATSAPP}/messages`)).json()).toEqual([]);
  // the response never carries the code
  expect(JSON.stringify(requested.body)).not.toContain(sent[0].code);

  const code = await codeFor(request, a.phone);
  const wrong = await api(request, null, "POST", "/api/auth/otp/activate", {
    employeeCode: a.code,
    otp: wrongCode(code),
    password: "first-password-1",
  });
  expect(wrong.status).toBe(400);
  expect(
    (await api(request, null, "POST", "/api/auth/employee-login", { identifier: a.code, password: "first-password-1" }))
      .status,
  ).toBe(401);

  const activated = await api(request, null, "POST", "/api/auth/otp/activate", {
    employeeCode: a.code,
    otp: code,
    password: "first-password-1",
  });
  expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  expect(
    (await api(request, null, "POST", "/api/auth/employee-login", { identifier: a.code, password: "first-password-1" }))
      .status,
  ).toBe(200);
  // once activated there is nothing left to activate
  expect((await ask(request, "A", "activate")).status).toBe(409);
});

test("an employee signs in with an SMS code once, is made to wait before asking again, and cannot open SMS Control", async ({
  request,
}) => {
  await request.post(`${FAKE}/reset`);
  const b = asEmployee("B");

  const first = await ask(request, "B", "login");
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.channel).toBe("sms");
  expect(first.body.message).toContain("SMS");

  // asking for another code at once is a 429 that says how long to wait (the wait is per employee and purpose)
  const again = await ask(request, "B", "login");
  expect(again.status).toBe(429);
  expect(again.body.retryAfterSeconds).toBeGreaterThan(0);
  expect(JSON.stringify(again.body).toLowerCase()).toContain("wait");

  const code = await codeFor(request, b.phone);
  expect(
    (await api(request, null, "POST", "/api/auth/otp/login", { employeeCode: b.code, otp: wrongCode(code) })).status,
  ).toBe(400);
  const login = await api(request, null, "POST", "/api/auth/otp/login", { employeeCode: b.code, otp: code });
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  const token = login.body.token as string;
  const me = await api(request, token, "GET", "/api/auth/me");
  expect(me.body.employeeId).toBe(b.id);
  // the same code cannot be used twice
  expect((await api(request, null, "POST", "/api/auth/otp/login", { employeeCode: b.code, otp: code })).status).toBe(
    400,
  );

  // an employee token cannot open SMS Control
  for (const path of ["overview", "settings", "messages"]) {
    expect((await api(request, token, "GET", `/api/sms-control/${path}`)).status, path).toBe(403);
  }
  expect((await api(request, token, "PUT", "/api/sms-control/settings", { hourlyCap: 5 })).status).toBe(403);
  expect((await api(request, token, "POST", "/api/sms-control/test", { phone: "9876543210" })).status).toBe(403);
});

test("forgot password resets through an SMS code", async ({ request }) => {
  await request.post(`${FAKE}/reset`);
  const c = asEmployee("C");
  // a first password (activation), then a new one (reset): two purposes, so no cooldown between them
  expect((await ask(request, "C", "activate")).status).toBe(200);
  const activation = await codeFor(request, c.phone);
  expect(
    (
      await api(request, null, "POST", "/api/auth/otp/activate", {
        employeeCode: c.code,
        otp: activation,
        password: "charlie-pass-1",
      })
    ).status,
  ).toBe(200);

  const requested = await ask(request, "C", "reset");
  expect(requested.status, JSON.stringify(requested.body)).toBe(200);
  expect(requested.body.message).toContain("SMS");
  const code = await codeFor(request, c.phone);
  // a wrong code changes nothing
  expect(
    (
      await api(request, null, "POST", "/api/auth/otp/reset-password", {
        employeeCode: c.code,
        otp: wrongCode(code),
        password: "a-new-password-1",
      })
    ).status,
  ).toBe(400);
  const reset = await api(request, null, "POST", "/api/auth/otp/reset-password", {
    employeeCode: c.code,
    otp: code,
    password: "a-new-password-1",
  });
  expect(reset.status, JSON.stringify(reset.body)).toBe(200);
  expect(
    (await api(request, null, "POST", "/api/auth/employee-login", { identifier: c.code, password: "a-new-password-1" }))
      .status,
  ).toBe(200);
  expect(
    (await api(request, null, "POST", "/api/auth/employee-login", { identifier: c.code, password: "charlie-pass-1" }))
      .status,
  ).toBe(401);
});

test("the log shows every one of those, newest first, and never a code", async ({ page, request }) => {
  const body = JSON.stringify((await admin(request, "GET", "/api/sms-control/messages?pageSize=200")).body);
  expect(usedCodes.length).toBeGreaterThanOrEqual(3);
  for (const code of usedCodes) expect(body, `the code ${code} is in the log`).not.toContain(`"${code}"`);
  expect(body).not.toContain(AUTH_KEY);
  expect(body).not.toContain(asEmployee("A").phone);

  await openAs(page, adminToken, `${PAGE}/messages`);
  await expect(rows(page).first()).toBeVisible();
  await expect(rows(page).filter({ hasText: "Sms Alpha" }).first()).toContainText("Account activation");
  await expect(rows(page).filter({ hasText: "Sms Alpha" }).first()).toContainText("••••••0081");
  for (const code of usedCodes) await expect(page.locator("body")).not.toContainText(code);

  // filters narrow the list, and the address keeps them
  await page.getByTestId("sms-search").fill("Charlie");
  await expect(rows(page).filter({ hasNotText: "Sms Charlie" })).toHaveCount(0);
  await expect(rows(page).first()).toContainText("Sms Charlie");
  await expect(page).toHaveURL(/q=Charlie/);
  await page.getByTestId("sms-clear-filters").click();
  await page.getByTestId("sms-purpose-filter").selectOption("reset");
  await expect(rows(page).first()).toContainText("Password reset");
  await expect(page).toHaveURL(/purpose=reset/);
  await page.getByRole("tab", { name: /^Failed/ }).click();
  await expect(page).toHaveURL(/status=failed/);
  await page.getByTestId("sms-clear-filters").click();
});

// ── the protections ─────────────────────────────────────────────────────────

test("the hourly cap and the per-phone cap block more codes, say so to the employee, and show up as Blocked", async ({
  page,
  request,
}) => {
  await request.post(`${FAKE}/reset`);
  const before = (await admin(request, "GET", "/api/sms-control/overview")).body;
  const used = before.limits.hourUsed as number;

  // per phone: two employees share a number; one code to it is allowed, the second is refused
  expect((await admin(request, "PUT", "/api/sms-control/settings", { maxPerPhonePerHour: 1 })).status).toBe(200);
  expect((await ask(request, "E", "activate")).status).toBe(200);
  const sharedPhone = await ask(request, "F", "activate");
  expect(sharedPhone.status, JSON.stringify(sharedPhone.body)).toBe(429);
  expect(await (await request.get(`${FAKE}/requests?mobile=${asEmployee("F").phone}`)).json()).toHaveLength(1);
  expect((await admin(request, "PUT", "/api/sms-control/settings", { maxPerPhonePerHour: 5 })).status).toBe(200);

  // the company-wide hourly cap: set it to what has been used, and the next code is refused
  const nowUsed = ((await admin(request, "GET", "/api/sms-control/overview")).body.limits.hourUsed as number) ?? used;
  expect(
    (await admin(request, "PUT", "/api/sms-control/settings", { hourlyCap: nowUsed, dailyCap: 10000 })).status,
  ).toBe(200);
  const blocked = await ask(request, "D", "activate");
  expect(blocked.status, JSON.stringify(blocked.body)).toBe(503);
  expect(blocked.body.error ?? blocked.body.message).toContain("temporarily unavailable");
  expect(await (await request.get(`${FAKE}/requests?mobile=${asEmployee("D").phone}`)).json()).toHaveLength(0);

  // HR sees it: the overview says so, and the log has a Blocked row with the reason
  await openAs(page, adminToken, `${PAGE}/overview`);
  await expect(page.getByTestId("sms-step-cap-hour")).toContainText("cap is reached");
  await expect(page.getByTestId("sms-card-hour")).toContainText(`${nowUsed} of ${nowUsed}`);
  await page.goto(`${PAGE}/messages?status=blocked`);
  await expect(rows(page).first()).toBeVisible();
  await expect(rows(page).filter({ hasText: "Sms Delta" }).first()).toContainText("limit");
  await expect(rows(page).filter({ hasText: "Sms Delta" }).first()).toContainText("Blocked");

  // raising the cap lets codes go again
  expect((await admin(request, "PUT", "/api/sms-control/settings", { hourlyCap: 100, dailyCap: 500 })).status).toBe(
    200,
  );
  const allowed = await ask(request, "D", "activate");
  expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
});

test("three 2Factor failures pause sending: employees are told to use their password, and HR sees why", async ({
  page,
  request,
}) => {
  await request.post(`${FAKE}/reset`);
  await request.post(`${FAKE}/fail-next`, { data: { times: 10 } });
  let paused = false;
  for (const key of ["G", "H", "I"]) {
    const res = await ask(request, key, "activate");
    if (res.status === 503) {
      paused = true;
      expect(res.body.error ?? res.body.message).toContain("temporarily unavailable");
      break;
    }
    // 2Factor refused it: a plain sentence, and the code is gone
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.error ?? res.body.message).toContain("We couldn't send the code by SMS");
  }
  // (earlier failures in the last ten minutes count too: after at most the third, sending is paused)
  if (!paused) {
    const next = await ask(request, "J", "activate");
    expect(next.status).toBe(503);
  }
  await request.post(`${FAKE}/reset`);
  const overview = (await admin(request, "GET", "/api/sms-control/overview")).body;
  expect(overview.circuit.paused).toBe(true);
  expect(overview.circuit.until).toBeTruthy();

  await openAs(page, adminToken, `${PAGE}/overview`);
  await expect(page.getByTestId("sms-card-circuit")).toContainText("Paused");
  await expect(page.getByTestId("sms-step-paused")).toContainText("SMS sending is paused");
  await page.goto(`${PAGE}/test`);
  await expect(page.getByTestId("sms-test-blocked")).toContainText("paused");
  await expect(page.getByRole("button", { name: "Send a test SMS" })).toBeDisabled();
  await page.goto(`${PAGE}/messages?status=failed`);
  await expect(rows(page).first()).toBeVisible();
});

// ── and back ────────────────────────────────────────────────────────────────

test("switching back to WhatsApp sends codes by WhatsApp again, and 2Factor hears nothing", async ({
  page,
  request,
}) => {
  await request.post(`${FAKE}/reset`);
  await request.post(`${FAKE_WHATSAPP}/reset`);
  await openAs(page, adminToken, `${PAGE}/settings/channel`);
  await page.getByTestId("sms-channel-whatsapp").locator("input").check();
  await page.getByTestId("sms-channel-save-row-save").click();
  await expect(page.getByRole("alertdialog")).toContainText("Send codes by WhatsApp again?");
  await page.getByRole("alertdialog").getByRole("button", { name: "Yes, use WhatsApp" }).click();
  await expect(page.getByTestId("sms-channel-whatsapp")).toContainText("In use now");

  const options = await (await request.get("/api/auth/login-options")).json();
  expect(options).toMatchObject({ otpChannel: "whatsapp", otpLogin: true, otpReset: true, otpActivate: true });

  const j = asEmployee("J");
  const requested = await ask(request, "J", "activate");
  expect(requested.status, JSON.stringify(requested.body)).toBe(200);
  expect(requested.body.channel).toBe("whatsapp");
  expect(requested.body.message).toContain("WhatsApp");
  expect(requested.body.message).not.toContain("SMS");
  const whatsapp = await (await request.get(`${FAKE_WHATSAPP}/messages`)).json();
  expect(whatsapp).toHaveLength(1);
  expect(whatsapp[0].number).toBe(`91${j.phone}`);
  expect(await (await request.get(`${FAKE}/requests`)).json()).toEqual([]);
});
