import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// SMS Control (HR portal) and SMS one-time codes, end to end against the real backend and a FAKE 2Factor
// (e2e/fake-twofactor.mjs, :8192) that records every request it receives and hands the spec the code an employee would
// have got by SMS. Nothing leaves the machine: playwright.config.ts points TWOFACTOR_API_BASE at the fake and sets
// SMS_ALLOW_SENDING=true because this is a dev-mode (DEBUG) backend.
//
// SMS is used for codes only, and SMS codes and WhatsApp codes are INDEPENDENT: each has its own master switch (SMS here,
// WhatsApp on WhatsApp Control), either alone is enough, and with both on the employee picks. SMS codes start OFF in the
// seed; WhatsApp codes (the fake Meta API, :8190) start on.
//
// Everything created here is prefixed "SMS" / "sms_" and removed again, and the SMS settings (SMS codes off, the default
// limits and price) and the WhatsApp code switch are put back as they were, so the other specs only see WhatsApp codes.

const FAKE = "http://127.0.0.1:8192";
const FAKE_WHATSAPP = "http://127.0.0.1:8190";
// must match TWOFACTOR_API_KEY / TWOFACTOR_TEMPLATE_NAME in playwright.config.ts
const AUTH_KEY = "e2e-twofactor-key-not-a-real-key";
const TEMPLATE_NAME = "E2E_TF_OTP";
const TEMPLATE_TEXT =
  "XXXX is your UK Textiles HRMS OTP. Official message from UK Textiles. Do not share it with anyone.";
const PASSWORD = "Passw0rd!smsx";
const PAGE = "/hr/sms-control";

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
  "otpEnabled",
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
  "monthlyBudget",
];

/** Puts the SMS settings back as they were when the spec started (the price back to the default), and WhatsApp codes on. */
async function restoreSettings(request: APIRequestContext) {
  const body = Object.fromEntries(
    SETTINGS_KEYS.filter((k) => k in originalSettings).map((k) => [k, originalSettings[k]]),
  );
  await admin(request, "PUT", "/api/sms-control/settings", { ...body, pricePerSms: null });
  await admin(request, "PATCH", "/api/whatsapp-control/settings", { otpEnabled: true });
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

/** Asks for a code; `channel` as a new app sends it (left out: what an old app sends, the first way that works). */
async function ask(
  request: APIRequestContext,
  key: string,
  purpose: "login" | "reset" | "activate",
  channel?: "sms" | "whatsapp",
) {
  return api(request, null, "POST", "/api/auth/otp/request", {
    employeeCode: asEmployee(key).code,
    purpose,
    ...(channel ? { channel } : {}),
  });
}

const loginOptions = async (request: APIRequestContext) => (await request.get("/api/auth/login-options")).json();

/** Opens a page already signed in as `token` (no sign-in screen: the server throttles those). */
async function openAs(page: Page, token: string, path: string) {
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), token);
  await page.goto(path);
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const rows = (page: Page) => page.getByTestId("sms-message-row");

/** Settings > OTP Switches: flips the SMS master switch, saves, and confirms in the page's own question. */
async function switchSmsCodes(page: Page, on: boolean) {
  await openAs(page, adminToken, `${PAGE}/settings/switches`);
  const master = page.getByTestId("sms-switch-otpEnabled");
  await expect(master).toHaveAttribute("aria-checked", on ? "false" : "true");
  await master.click();
  await page.getByTestId("sms-switches-save-row-save").click();
  const dialog = page.getByTestId("sms-master-confirm");
  await expect(dialog).toContainText(on ? "Switch SMS codes on?" : "Switch SMS codes off?");
  await dialog.getByRole("button", { name: on ? "Yes, switch on" : "Yes, switch off" }).click();
  await expect(page.getByTestId("sms-switches-save-row")).toHaveAttribute("data-dirty", "false");
  await expect(master).toHaveAttribute("aria-checked", on ? "true" : "false");
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  adminToken = await signIn(request, HR_USERNAME, HR_PASSWORD);
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
  await make("J", "Juliet", "9000000089"); // WhatsApp once SMS codes are off again
  await make("K", "Kilo", "9000000090"); // SMS only, while WhatsApp codes are off

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
  await restoreSettings(request);
  await purge(request);
  await request.post(`${FAKE}/reset`);
  await request.post(`${FAKE_WHATSAPP}/reset`);
});

// ── who may use the API ─────────────────────────────────────────────────────

test("the SMS Control API needs a login, and a role needs the module", async ({ request }) => {
  const paths = ["overview", "usage", "settings", "messages"];
  for (const path of paths) {
    expect((await request.get(`/api/sms-control/${path}`)).status(), path).toBe(401);
  }
  expect((await request.put("/api/sms-control/settings", { data: { hourlyCap: 10 } })).status()).toBe(401);
  expect((await request.post("/api/sms-control/test", { data: { phone: "9876543210" } })).status()).toBe(401);

  // a role without the module sees nothing of it
  for (const path of paths) {
    expect((await api(request, nobodyToken, "GET", `/api/sms-control/${path}`)).status, `no module: ${path}`).toBe(403);
  }

  // View Only reads everything and changes nothing
  for (const path of paths) {
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
  for (const path of paths) {
    const body = JSON.stringify((await admin(request, "GET", `/api/sms-control/${path}`)).body);
    expect(body, path).not.toContain(AUTH_KEY);
  }
  const overview = (await admin(request, "GET", "/api/sms-control/overview")).body;
  expect(overview.env).toMatchObject({ authKey: true, senderId: "E2ETFX", templateName: "E2E_TF_OTP" });
  expect(overview.provider).toBe("twofactor");
  expect(typeof overview.env.authKey).toBe("boolean");
});

test("SMS codes start off, WhatsApp codes work on their own, and there is no 'active channel' any more", async ({
  request,
}) => {
  expect(originalSettings.otpEnabled).toBe(false);
  expect("otpChannel" in originalSettings).toBe(false);
  const options = await loginOptions(request);
  expect(options).toMatchObject({
    otpChannel: "whatsapp",
    otpLogin: true,
    passwordLogin: true,
    otpChannels: { login: ["whatsapp"], reset: ["whatsapp"], activate: ["whatsapp"] },
  });
  expect(options.channels.sms).toBeUndefined();
  // asking for an SMS code now is refused, and names the way that works
  const refused = await ask(request, "A", "activate", "sms");
  expect(refused.status).toBe(400);
  expect(refused.body).toMatchObject({ code: "channel_unavailable", availableChannels: ["whatsapp"] });
  expect(await (await request.get(`${FAKE}/requests`)).json()).toEqual([]);
  // the old single "channel" setting is refused with a sentence that says why
  const old = await admin(request, "PUT", "/api/sms-control/settings", { otpChannel: "sms" });
  expect(old.status).toBe(400);
  expect(JSON.stringify(old.body)).toContain("switched on separately");
});

// ── the page ────────────────────────────────────────────────────────────────

test("HR finds SMS Control in the sidebar and sees its six tabs, with Overview in plain words", async ({ page }) => {
  await openAs(page, adminToken, "/hr/dashboard");
  await expect(page.getByRole("link", { name: "SMS Control" })).toBeVisible();
  await page.getByRole("link", { name: "SMS Control" }).click();
  await expect(page).toHaveURL(/\/hr\/sms-control\/overview$/);
  await expect(page.getByRole("heading", { name: "SMS Control" })).toBeVisible();
  for (const name of ["Overview", "Usage & Cost", "Settings", "Messages", "Test", "Setup"]) {
    await expect(tab(page, name)).toBeVisible();
  }
  // exactly one Refresh button, in the title row (the page has its own)
  await expect(page.getByRole("button", { name: /^\s*Refresh( this page)?\s*$/ })).toHaveCount(1);
  await expect(page.getByTestId("page-refresh-bar")).toHaveCount(0);

  await expect(page.getByTestId("sms-hero")).toBeVisible();
  await expect(page.getByTestId("sms-card-otp-value")).toHaveText("Off");
  await expect(page.getByTestId("sms-card-configured")).toContainText("Yes");
  await expect(page.getByTestId("sms-card-sending")).toContainText("Allowed");
  await expect(page.getByTestId("sms-card-circuit")).toContainText("Working");
  // the 2Factor balance (the fake answers 500 credits)
  await expect(page.getByTestId("sms-card-balance")).toContainText("500");
  // SMS is for codes only, and WhatsApp codes are set on WhatsApp Control
  await expect(page.getByTestId("sms-codes-only")).toBeVisible();
  await expect(page.getByTestId("sms-independent")).toContainText("WhatsApp");
  await expect(page.getByTestId("sms-month")).toBeVisible();
  // nothing on the page is the auth key
  await expect(page.locator("body")).not.toContainText(AUTH_KEY);
});

test("the tabs have addresses, and an address that stops early, is retired or is unknown lands on a real one", async ({
  page,
}) => {
  await openAs(page, adminToken, PAGE);
  await expect(page).toHaveURL(/\/hr\/sms-control\/overview$/);
  await page.goto(`${PAGE}/settings`);
  await expect(page).toHaveURL(/\/hr\/sms-control\/settings\/switches$/);
  // the retired "Channel" section
  await page.goto(`${PAGE}/settings/channel`);
  await expect(page).toHaveURL(/\/hr\/sms-control\/settings\/switches$/);
  await page.goto(`${PAGE}/nope/deeper`);
  await expect(page).toHaveURL(/\/hr\/sms-control\/overview$/);
  await page.goto(`${PAGE}/settings/limits`);
  await expect(page.getByTestId("sms-section-limits")).toBeVisible();
  // only the open section is on the page
  await expect(page.getByTestId("sms-section-switches")).toHaveCount(0);
  await expect(page.getByTestId("sms-section-cost")).toHaveCount(0);
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
  await open(`${PAGE}/usage`, "sms-usage");
  await open(`${PAGE}/settings/switches`, "sms-section-switches");
  await open(`${PAGE}/settings/limits`, "sms-section-limits");
  await open(`${PAGE}/settings/cost`, "sms-section-cost");
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
    "SMS_ONLY_TO_EMPLOYEES",
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
  // 2Factor may read a code out as a phone call: nothing in the HRMS can change that, so the page says so
  await expect(page.getByTestId("sms-setup-voice")).toBeVisible();
  // there is no box to type a key into, and the page never shows one
  await expect(page.getByTestId("sms-setup").locator("input, textarea, select")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(AUTH_KEY);

  await page.getByTestId("sms-2f-template-text").getByRole("button", { name: /^Copy/ }).click();
  await expect(page.getByTestId("sms-2f-template-text")).toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TEMPLATE_TEXT);
});

// ── the test code ───────────────────────────────────────────────────────────

test("a test code goes through 2Factor's OTP template, is logged without the number, and is limited to three an hour", async ({
  page,
  request,
}) => {
  await request.post(`${FAKE}/reset`);
  await openAs(page, adminToken, `${PAGE}/test`);
  await expect(page.getByTestId("sms-test-preview")).toContainText("1234 is your UK Textiles HRMS OTP.");
  // there is no box for a message of your own: SMS carries codes only
  await expect(page.getByTestId("sms-test").locator("textarea")).toHaveCount(0);
  await page.getByTestId("sms-test-mode-phone").click();
  const phone = page.getByLabel("Mobile number");
  const send = page.getByTestId("sms-test-send");

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

  // 3: accepted, through the API, to an employee's registered number
  const third = await admin(request, "POST", "/api/sms-control/test", { employeeCode: asEmployee("B").code });
  expect(third.status, JSON.stringify(third.body)).toBe(200);
  expect(third.body.ok).toBe(true);
  expect(await (await request.get(`${FAKE}/requests?mobile=${asEmployee("B").phone}`)).json()).toHaveLength(1);

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

  // an unsaved change in OTP Switches does not go with the limits
  await page.getByTestId("sms-settings-nested-switches").click();
  await page.getByTestId("sms-switch-otpResetEnabled").click();
  await page.getByTestId("sms-settings-nested-limits").click();
  await expect(expiry).toHaveValue("7");
  await save.click();
  await expect(page.getByTestId("sms-limits-save-row")).toHaveAttribute("data-dirty", "false");

  const saved = (await admin(request, "GET", "/api/sms-control/settings")).body;
  expect(saved.otpExpiryMinutes).toBe(7);
  expect(saved.otpResetEnabled).toBe(true);
  expect(saved.otpEnabled).toBe(false);
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

test("the price per SMS and the monthly budget save on Cost, and Usage & Cost uses them", async ({ page, request }) => {
  await openAs(page, adminToken, `${PAGE}/settings/cost`);
  await page.getByTestId("sms-input-pricePerSms").fill("0.25");
  await page.getByTestId("sms-input-monthlyBudget").fill("500");
  await page.getByTestId("sms-cost-save-row-save").click();
  await expect(page.getByTestId("sms-cost-save-row")).toHaveAttribute("data-dirty", "false");
  const saved = (await admin(request, "GET", "/api/sms-control/settings")).body;
  expect(saved.pricePerSms).toBe(0.25);
  expect(saved.monthlyBudget).toBe(500);
  expect(saved.pricePerSmsDefault).toBe(0.2);

  const usage = (await admin(request, "GET", "/api/sms-control/usage")).body;
  expect(usage.cost).toMatchObject({ perSms: 0.25, budget: 500, currency: "INR", isCurrentMonth: true });
  expect(usage.totals.sent).toBeGreaterThanOrEqual(2);
  expect(usage.byPurpose.test.sent).toBeGreaterThanOrEqual(2);
  expect(usage.cost.soFar).toBeGreaterThan(0);

  await tab(page, "Usage & Cost").click();
  await expect(page).toHaveURL(/\/hr\/sms-control\/usage/);
  await expect(page.getByTestId("sms-usage-totals")).toBeVisible();
  await expect(page.getByTestId("sms-usage-price")).toContainText("0.25");
  await expect(page.getByTestId("sms-by-purpose")).toBeVisible();

  // a price above the allowed range is refused by the server too
  expect((await admin(request, "PATCH", "/api/sms-control/settings", { pricePerSms: 1000 })).status).toBe(400);
  // and an empty price goes back to the default
  expect((await admin(request, "PATCH", "/api/sms-control/settings", { pricePerSms: null })).status).toBe(200);
  expect((await admin(request, "GET", "/api/sms-control/settings")).body.pricePerSms).toBe(0.2);
});

test("switching SMS codes on asks first, and the apps are offered both ways at once", async ({ page, request }) => {
  await switchSmsCodes(page, true);
  expect((await admin(request, "GET", "/api/sms-control/settings")).body.otpEnabled).toBe(true);

  const options = await loginOptions(request);
  expect(options).toMatchObject({
    otpLogin: true,
    otpReset: true,
    otpActivate: true,
    passwordLogin: true,
    // an old app still gets the first way (WhatsApp) and its code length
    otpChannel: "whatsapp",
    codeLength: 6,
    otpChannels: { login: ["whatsapp", "sms"], reset: ["whatsapp", "sms"], activate: ["whatsapp", "sms"] },
    channels: { whatsapp: { name: "WhatsApp", codeLength: 6 }, sms: { name: "SMS", codeLength: 4 } },
  });

  await openAs(page, adminToken, `${PAGE}/overview`);
  await expect(page.getByTestId("sms-card-otp-value")).toHaveText("On");
});

test("with both on, the employee's choice decides: SMS goes to 2Factor only, WhatsApp to Meta only", async ({
  request,
}) => {
  await request.post(`${FAKE}/reset`);
  await request.post(`${FAKE_WHATSAPP}/reset`);
  const a = asEmployee("A");

  const requested = await ask(request, "A", "activate", "sms");
  expect(requested.status, JSON.stringify(requested.body)).toBe(200);
  expect(requested.body).toMatchObject({ channel: "sms", codeLength: 4, otherChannels: ["whatsapp"] });
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
  expect((await ask(request, "A", "activate")).status).toBe(409);

  // the same employee asks for a sign-in code by WhatsApp: Meta gets it, 2Factor hears nothing more
  await request.post(`${FAKE}/reset`);
  const byWhatsApp = await ask(request, "A", "login", "whatsapp");
  expect(byWhatsApp.status, JSON.stringify(byWhatsApp.body)).toBe(200);
  expect(byWhatsApp.body).toMatchObject({ channel: "whatsapp", codeLength: 6, otherChannels: ["sms"] });
  const whatsapp = await (await request.get(`${FAKE_WHATSAPP}/messages`)).json();
  expect(whatsapp).toHaveLength(1);
  expect(whatsapp[0]).toMatchObject({ number: `91${a.phone}`, template: "hrms_otp" });
  expect(await (await request.get(`${FAKE}/requests`)).json()).toEqual([]);
});

test("an employee signs in with an SMS code once, waits per channel, and cannot open SMS Control", async ({
  request,
}) => {
  await request.post(`${FAKE}/reset`);
  const b = asEmployee("B");

  const first = await ask(request, "B", "login", "sms");
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.channel).toBe("sms");
  expect(first.body.message).toContain("SMS");

  // asking for another SMS code at once is a 429 that says how long to wait (per employee, purpose and channel)
  const again = await ask(request, "B", "login", "sms");
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
  // the SMS wait does not hold back a WhatsApp code: each way has its own
  expect((await ask(request, "B", "login", "whatsapp")).status).toBe(200);

  // an employee token cannot open SMS Control
  for (const path of ["overview", "usage", "settings", "messages"]) {
    expect((await api(request, token, "GET", `/api/sms-control/${path}`)).status, path).toBe(403);
  }
  expect((await api(request, token, "PUT", "/api/sms-control/settings", { hourlyCap: 5 })).status).toBe(403);
  expect((await api(request, token, "POST", "/api/sms-control/test", { phone: "9876543210" })).status).toBe(403);
});

test("forgot password resets through an SMS code", async ({ request }) => {
  await request.post(`${FAKE}/reset`);
  const c = asEmployee("C");
  // a first password (activation), then a new one (reset): two purposes, so no cooldown between them
  expect((await ask(request, "C", "activate", "sms")).status).toBe(200);
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

  const requested = await ask(request, "C", "reset", "sms");
  expect(requested.status, JSON.stringify(requested.body)).toBe(200);
  expect(requested.body.message).toContain("SMS");
  const code = await codeFor(request, c.phone);
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

test("an SMS purpose switch turns off SMS only: WhatsApp keeps offering that use", async ({ page, request }) => {
  await openAs(page, adminToken, `${PAGE}/settings/switches`);
  const reset = page.getByTestId("sms-switch-otpResetEnabled");
  await expect(reset).toHaveAttribute("aria-checked", "true");
  await reset.click();
  await page.getByTestId("sms-switches-save-row-save").click();
  await expect(page.getByTestId("sms-switches-save-row")).toHaveAttribute("data-dirty", "false");
  let options = await loginOptions(request);
  expect(options).toMatchObject({ otpReset: true, otpChannels: { login: ["whatsapp", "sms"], reset: ["whatsapp"] } });
  const refused = await ask(request, "C", "reset", "sms");
  expect(refused.status).toBe(400);
  expect(refused.body).toMatchObject({ code: "channel_unavailable", availableChannels: ["whatsapp"] });

  await reset.click();
  await page.getByTestId("sms-switches-save-row-save").click();
  await expect(page.getByTestId("sms-switches-save-row")).toHaveAttribute("data-dirty", "false");
  options = await loginOptions(request);
  expect(options.otpChannels.reset).toEqual(["whatsapp", "sms"]);
});

test("WhatsApp codes switched off on WhatsApp Control leave SMS codes working on their own", async ({ request }) => {
  await request.post(`${FAKE}/reset`);
  await request.post(`${FAKE_WHATSAPP}/reset`);
  expect((await admin(request, "PATCH", "/api/whatsapp-control/settings", { otpEnabled: false })).status).toBe(200);
  try {
    const options = await loginOptions(request);
    expect(options).toMatchObject({
      otpLogin: true,
      otpChannel: "sms",
      codeLength: 4,
      otpChannels: { login: ["sms"], reset: ["sms"], activate: ["sms"] },
    });
    expect(options.channels.whatsapp).toBeUndefined();
    // an old app (no channel) gets the SMS code
    const k = asEmployee("K");
    const requested = await ask(request, "K", "activate");
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    expect(requested.body).toMatchObject({ channel: "sms", codeLength: 4, otherChannels: [] });
    await codeFor(request, k.phone);
    expect(await (await request.get(`${FAKE_WHATSAPP}/messages`)).json()).toEqual([]);
    // and WhatsApp is refused when asked for by name
    const refused = await ask(request, "K", "login", "whatsapp");
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: "channel_unavailable", availableChannels: ["sms"] });
  } finally {
    expect((await admin(request, "PATCH", "/api/whatsapp-control/settings", { otpEnabled: true })).status).toBe(200);
  }
  expect((await loginOptions(request)).otpChannels.login).toEqual(["whatsapp", "sms"]);
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

test("the hourly cap and the per-phone cap block more SMS codes, say so to the employee, and show up as Blocked", async ({
  page,
  request,
}) => {
  await request.post(`${FAKE}/reset`);

  // per phone: two employees share a number; one code to it is allowed, the second is refused
  expect((await admin(request, "PUT", "/api/sms-control/settings", { maxPerPhonePerHour: 1 })).status).toBe(200);
  expect((await ask(request, "E", "activate", "sms")).status).toBe(200);
  const sharedPhone = await ask(request, "F", "activate", "sms");
  expect(sharedPhone.status, JSON.stringify(sharedPhone.body)).toBe(429);
  expect(await (await request.get(`${FAKE}/requests?mobile=${asEmployee("F").phone}`)).json()).toHaveLength(1);
  expect((await admin(request, "PUT", "/api/sms-control/settings", { maxPerPhonePerHour: 5 })).status).toBe(200);

  // the company-wide hourly cap: set it to what has been used, and the next SMS code is refused
  const nowUsed = (await admin(request, "GET", "/api/sms-control/overview")).body.limits.hourUsed as number;
  expect(
    (await admin(request, "PUT", "/api/sms-control/settings", { hourlyCap: nowUsed, dailyCap: 10000 })).status,
  ).toBe(200);
  const blocked = await ask(request, "D", "activate", "sms");
  expect(blocked.status, JSON.stringify(blocked.body)).toBe(503);
  expect(blocked.body.error ?? blocked.body.message).toContain("temporarily unavailable");
  expect(await (await request.get(`${FAKE}/requests?mobile=${asEmployee("D").phone}`)).json()).toHaveLength(0);
  // a cap is a pause, not a switch: SMS is still offered, and WhatsApp still works for the same employee
  expect((await loginOptions(request)).otpChannels.activate).toEqual(["whatsapp", "sms"]);

  // HR sees it: the overview says so, and the log has a Blocked row with the reason
  await openAs(page, adminToken, `${PAGE}/overview`);
  await expect(page.getByTestId("sms-cap-hour")).toContainText(`${nowUsed} of ${nowUsed}`);
  // a used-up cap pauses SMS until the hour turns: the alert says which limit
  await expect(page.getByTestId("sms-alert-paused")).toContainText(`The hourly limit of ${nowUsed} SMS is used up`);
  await expect(page.getByTestId("sms-card-circuit")).toContainText("Paused");
  await page.goto(`${PAGE}/messages?status=blocked`);
  await expect(rows(page).first()).toBeVisible();
  await expect(rows(page).filter({ hasText: "Sms Delta" }).first()).toContainText("limit");
  await expect(rows(page).filter({ hasText: "Sms Delta" }).first()).toContainText("Blocked");

  // raising the cap lets codes go again
  expect((await admin(request, "PUT", "/api/sms-control/settings", { hourlyCap: 100, dailyCap: 500 })).status).toBe(
    200,
  );
  const allowed = await ask(request, "D", "activate", "sms");
  expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
});

test("three 2Factor failures pause SMS: employees are told to use their password, and HR sees why", async ({
  page,
  request,
}) => {
  await request.post(`${FAKE}/reset`);
  await request.post(`${FAKE}/fail-next`, { data: { times: 10 } });
  let paused = false;
  for (const key of ["G", "H", "I"]) {
    const res = await ask(request, key, "activate", "sms");
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
    const next = await ask(request, "J", "activate", "sms");
    expect(next.status).toBe(503);
  }
  await request.post(`${FAKE}/reset`);
  const overview = (await admin(request, "GET", "/api/sms-control/overview")).body;
  expect(overview.status.paused).toBe(true);
  expect(overview.circuit.paused).toBe(true);

  await openAs(page, adminToken, `${PAGE}/overview`);
  await expect(page.getByTestId("sms-card-circuit")).toContainText("Paused");
  await expect(page.getByTestId("sms-alert-paused")).toBeVisible();
  await page.goto(`${PAGE}/test`);
  await expect(page.getByTestId("sms-test-blocked")).toContainText("paused");
  await expect(page.getByTestId("sms-test-send")).toBeDisabled();
  await page.goto(`${PAGE}/messages?status=failed`);
  await expect(rows(page).first()).toBeVisible();
});

// ── and off again ───────────────────────────────────────────────────────────

test("switching SMS codes off sends codes by WhatsApp only again, and 2Factor hears nothing", async ({
  page,
  request,
}) => {
  await request.post(`${FAKE}/reset`);
  await request.post(`${FAKE_WHATSAPP}/reset`);
  await switchSmsCodes(page, false);

  const options = await loginOptions(request);
  expect(options).toMatchObject({
    otpChannel: "whatsapp",
    otpLogin: true,
    otpReset: true,
    otpActivate: true,
    otpChannels: { login: ["whatsapp"], reset: ["whatsapp"], activate: ["whatsapp"] },
  });
  expect(options.channels.sms).toBeUndefined();

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
