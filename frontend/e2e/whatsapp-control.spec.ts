import { createHmac } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// WhatsApp Control (/hr/whatsapp-control) and WhatsApp codes on the official Meta WhatsApp Cloud API, end to end against
// the real backend and a FAKE Meta Graph API (e2e/fake-meta.mjs, :8190) that records every message it is asked to send.
// seed_e2e submitted every message type's template to that fake through the real create path, so every template is
// APPROVED here, as on a live server whose templates Meta has approved. SMS codes start OFF (sms-control.spec.ts switches
// them on and back off), so WhatsApp is the only way codes go in this file. Nothing leaves the machine.

const FAKE = "http://127.0.0.1:8190";
// must match playwright.config.ts (dummy values of the e2e stack only)
const ACCESS_TOKEN = "e2e-meta-access-token";
const APP_SECRET = "e2e-meta-app-secret";
const VERIFY_TOKEN = "e2e-meta-verify-token";

type Sent = {
  id: string;
  number: string;
  template: string;
  language: string;
  category: string;
  params: Record<string, string>;
  header: unknown;
  button: string | null;
  message: string;
};

async function sentMessages(request: APIRequestContext): Promise<Sent[]> {
  return (await request.get(`${FAKE}/messages`)).json();
}

/** The one-time code of a code message: Meta's copy-code button carries it (and the text shows it). */
function codeOf(m: Sent): string {
  expect(m.template).toBe("hrms_otp");
  expect(m.category).toBe("authentication");
  expect(m.button).toMatch(/^\d{6}$/);
  expect(m.message).toContain(m.button!);
  return m.button!;
}

async function hrHeaders(request: APIRequestContext) {
  const login = await request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  return { Authorization: `Bearer ${(await login.json()).token}` };
}

async function employeeId(request: APIRequestContext, code: string): Promise<number> {
  const employees = await (await request.get("/api/employees", { headers: await hrHeaders(request) })).json();
  return employees.find((e: { employeeCode: string }) => e.employeeCode === code).id;
}

/** A webhook POST signed the way Meta signs it (HMAC-SHA256 of the raw body with the app secret). */
async function webhook(request: APIRequestContext, body: unknown, secret = APP_SECRET) {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return request.post("/api/whatsapp/webhook/", {
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
    data: raw,
  });
}

const change = (value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [
    { id: "200000000000002", changes: [{ field: "messages", value: { messaging_product: "whatsapp", ...value } }] },
  ],
});

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });

// the codes the employees were sent in this file: none may ever show on the page
const codes: string[] = [];

test.describe.configure({ mode: "serial" });

test("login-options offers WhatsApp codes on their own, and is never cached", async ({ request }) => {
  const res = await request.get("/api/auth/login-options");
  expect(res.headers()["cache-control"]).toContain("no-store");
  const options = await res.json();
  expect(options).toMatchObject({
    otpLogin: true,
    otpReset: true,
    otpActivate: true,
    passwordLogin: true,
    // what an old app build reads
    otpChannel: "whatsapp",
    codeLength: 6,
    // what a new one reads: SMS codes are off, and WhatsApp needs nothing from SMS
    otpChannels: { login: ["whatsapp"], reset: ["whatsapp"], activate: ["whatsapp"] },
    channels: { whatsapp: { name: "WhatsApp", codeLength: 6 } },
  });
  expect(options.channels.sms).toBeUndefined();
});

test("an employee signs in with a WhatsApp code sent as Meta's approved code template", async ({ request }) => {
  await request.post(`${FAKE}/reset`);

  // an old app sends no channel: the first one that works is used
  const ask = await request.post("/api/auth/otp/request", { data: { employeeCode: "E2E001", purpose: "login" } });
  expect(ask.status()).toBe(200);
  const answer = await ask.json();
  expect(answer).toMatchObject({ channel: "whatsapp", codeLength: 6, otherChannels: [] });
  expect(answer.maskedPhone).toMatch(/0001$/);

  const sent = await sentMessages(request);
  expect(sent).toHaveLength(1);
  expect(sent[0].number).toBe("919000000001");
  expect(sent[0].language).toBe("en");
  const code = codeOf(sent[0]);
  codes.push(code);
  // the answer never carries the code
  expect(JSON.stringify(answer)).not.toContain(code);

  const wrong = await request.post("/api/auth/otp/login", {
    data: { employeeCode: "E2E001", otp: code === "000000" ? "111111" : "000000" },
  });
  expect(wrong.status()).toBe(400);
  const login = await request.post("/api/auth/otp/login", { data: { employeeCode: "E2E001", otp: code } });
  expect(login.status()).toBe(200);
  const { token, employeeId: id } = await login.json();
  const me = await request.get("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
  expect((await me.json()).employeeId).toBe(id);
  // ...and the same code can't be used twice
  expect((await request.post("/api/auth/otp/login", { data: { employeeCode: "E2E001", otp: code } })).status()).toBe(
    400,
  );
});

test("a new employee must confirm a WhatsApp code before choosing a first password", async ({ request }) => {
  await request.post(`${FAKE}/reset`);

  // the old open route no longer lets a stranger set someone's first password
  const direct = await request.post("/api/auth/set-password", {
    data: { identifier: "E2E002", password: "attacker-pass-1" },
  });
  expect(direct.status()).toBe(403);

  const ask = await request.post("/api/auth/otp/request", {
    data: { employeeCode: "E2E002", purpose: "activate", channel: "whatsapp" },
  });
  expect(ask.status()).toBe(200);
  const sent = await sentMessages(request);
  expect(sent).toHaveLength(1);
  expect(sent[0].number).toBe("919000000002");
  const code = codeOf(sent[0]);
  codes.push(code);

  const wrong = await request.post("/api/auth/otp/activate", {
    data: { employeeCode: "E2E002", otp: code === "000000" ? "111111" : "000000", password: "first-password-1" },
  });
  expect(wrong.status()).toBe(400);
  const activate = await request.post("/api/auth/otp/activate", {
    data: { employeeCode: "E2E002", otp: code, password: "first-password-1" },
  });
  expect(activate.status()).toBe(200);
  expect(
    (
      await request.post("/api/auth/employee-login", { data: { identifier: "E2E002", password: "first-password-1" } })
    ).status(),
  ).toBe(200);
  // once activated there is nothing left to activate
  expect(
    (await request.post("/api/auth/otp/request", { data: { employeeCode: "E2E002", purpose: "activate" } })).status(),
  ).toBe(409);
});

test("forgot password resets through a WhatsApp code", async ({ request }) => {
  await request.post(`${FAKE}/reset`);
  expect(
    (await request.post("/api/auth/otp/request", { data: { employeeCode: "E2E002", purpose: "reset" } })).status(),
  ).toBe(200);
  const code = codeOf((await sentMessages(request))[0]);
  codes.push(code);
  const reset = await request.post("/api/auth/otp/reset-password", {
    data: { employeeCode: "E2E002", otp: code, password: "a-new-password-1" },
  });
  expect(reset.status()).toBe(200);
  expect(
    (
      await request.post("/api/auth/employee-login", { data: { identifier: "E2E002", password: "a-new-password-1" } })
    ).status(),
  ).toBe(200);
});

test("asking for an SMS code while only WhatsApp is offered names the way that works", async ({ request }) => {
  await request.post(`${FAKE}/reset`);
  const res = await request.post("/api/auth/otp/request", {
    data: { employeeCode: "E2E003", purpose: "login", channel: "sms" },
  });
  expect(res.status()).toBe(400);
  expect(await res.json()).toMatchObject({ code: "channel_unavailable", availableChannels: ["whatsapp"] });
  expect(await sentMessages(request)).toEqual([]);
});

test("employee tokens cannot open the WhatsApp Control API", async ({ request }) => {
  await request.post(`${FAKE}/reset`);
  await request.post("/api/auth/otp/request", { data: { employeeCode: "E2E003", purpose: "login" } });
  const code = codeOf((await sentMessages(request))[0]);
  codes.push(code);
  const { token } = await (
    await request.post("/api/auth/otp/login", { data: { employeeCode: "E2E003", otp: code } })
  ).json();
  const auth = { Authorization: `Bearer ${token}` };
  for (const path of [
    "overview",
    "usage",
    "messages",
    "employees",
    "settings",
    "queue",
    "meta-templates",
    "connection",
    "test-message",
  ]) {
    expect((await request.get(`/api/whatsapp-control/${path}`, { headers: auth })).status(), path).toBe(403);
    expect((await request.get(`/api/whatsapp-control/${path}`)).status(), path).toBe(401);
  }
  // the old "Message Text" wording endpoints are gone: with Meta the wording IS the approved template
  const headers = await hrHeaders(request);
  expect((await request.get("/api/whatsapp-control/templates", { headers })).status()).toBe(404);
});

test("a test message goes out as its approved template, and Meta's webhook ticks it delivered and read", async ({
  request,
}) => {
  await request.post(`${FAKE}/reset`);
  const headers = await hrHeaders(request);
  const asha = await employeeId(request, "E2E001");

  // the preview: the template, its variables and the text; nothing is sent
  const preview = await request.post("/api/whatsapp-control/test-message", {
    headers,
    data: { documentType: "approval_approved", employeeId: asha, dryRun: true },
  });
  expect(preview.status()).toBe(200);
  const p = await preview.json();
  expect(p).toMatchObject({ status: "preview", template: { name: "hrms_approval_approved", status: "APPROVED" } });
  expect(p.params.employee_name).toBe("Asha Kumar");
  expect(await sentMessages(request)).toEqual([]);
  // free text can't be sent: Meta delivers approved templates only
  const free = await request.post("/api/whatsapp-control/test-message", {
    headers,
    data: { documentType: "approval_approved", employeeId: asha, text: "hello" },
  });
  expect(free.status()).toBe(400);

  const send = await request.post("/api/whatsapp-control/test-message", {
    headers,
    data: { documentType: "approval_approved", employeeId: asha },
  });
  const result = await send.json();
  expect(result.status, JSON.stringify(result)).toBe("sent");
  const wamid = result.providerMessageId as string;
  const [sent] = await sentMessages(request);
  expect(sent).toMatchObject({ id: wamid, number: "919000000001", template: "hrms_approval_approved" });
  expect(sent.params.employee_name).toBe("Asha Kumar");
  expect(sent.message).toContain("Dear Asha Kumar");

  // the webhook handshake: the verify token answers the challenge, anything else is refused
  const ok = await request.get(
    `/api/whatsapp/webhook/?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=4711`,
  );
  expect(ok.status()).toBe(200);
  expect(await ok.text()).toBe("4711");
  expect(
    (await request.get("/api/whatsapp/webhook/?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1")).status(),
  ).toBe(403);

  // a POST without Meta's signature (or signed with another secret) is never processed
  const at = Math.floor(Date.now() / 1000);
  const delivered = change({
    statuses: [
      {
        id: wamid,
        status: "delivered",
        timestamp: String(at),
        recipient_id: "919000000001",
        pricing: { billable: true, pricing_model: "PMP", category: "utility", type: "regular" },
      },
    ],
  });
  expect((await webhook(request, delivered, "not-the-app-secret")).status()).toBe(403);
  expect(
    (
      await request.post("/api/whatsapp/webhook/", {
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(delivered),
      })
    ).status(),
  ).toBe(403);

  expect((await webhook(request, delivered)).status()).toBe(200);
  const read = change({
    statuses: [{ id: wamid, status: "read", timestamp: String(at + 5), recipient_id: "919000000001" }],
  });
  expect((await webhook(request, read)).status()).toBe(200);

  const log = await (
    await request.get("/api/whatsapp-control/messages?page=1&pageSize=50&type=approval_approved", { headers })
  ).json();
  const row = log.items.find((m: { providerMessageId: string }) => m.providerMessageId === wamid);
  expect(row).toMatchObject({ status: "read", templateName: "hrms_approval_approved", pricingCategory: "utility" });
  expect(row.billable).toBe(true);
  expect(row.deliveredAt).toBeTruthy();
  expect(row.readAt).toBeTruthy();
  const connection = await (await request.get("/api/whatsapp-control/connection", { headers })).json();
  expect(connection.webhook.lastWebhookAt).toBeTruthy();
});

test("an employee who replies STOP is opted out, and HR can opt them back in", async ({ request }) => {
  const headers = await hrHeaders(request);
  const meena = await employeeId(request, "E2E003");
  const stop = change({
    contacts: [{ wa_id: "919000000003", profile: { name: "Meena" } }],
    messages: [
      {
        from: "919000000003",
        id: "wamid.INBOUND1",
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: "text",
        text: { body: "STOP" },
      },
    ],
  });
  expect((await webhook(request, stop)).status()).toBe(200);
  const rows = await (await request.get("/api/whatsapp-control/employees?search=E2E003", { headers })).json();
  const row = rows.find((r: { employeeId: number }) => r.employeeId === meena);
  expect(row).toMatchObject({ optOut: true, optOutReason: "Replied STOP" });

  const back = await request.patch(`/api/whatsapp-control/employees/${meena}/opt-out`, {
    headers,
    data: { optOut: false },
  });
  expect(back.status()).toBeLessThan(300);
  const after = await (await request.get("/api/whatsapp-control/employees?search=E2E003", { headers })).json();
  expect(after.find((r: { employeeId: number }) => r.employeeId === meena).optOut).toBe(false);
});

test("approving and rejecting a request WhatsApps the employee as the approved templates", async ({ request }) => {
  await request.post(`${FAKE}/reset`);
  const headers = await hrHeaders(request);
  const asha = await employeeId(request, "E2E001");
  const created = await request.post("/api/leave-requests", {
    headers,
    data: {
      employeeId: asha,
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      type: "casual",
      reason: "Family function",
    },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).id as number;

  expect(
    (
      await request.patch(`/api/leave-requests/${id}/status`, {
        headers,
        data: { status: "approved", hrComment: "Enjoy" },
      })
    ).status(),
  ).toBe(200);
  const of = async (template: string) => (await sentMessages(request)).filter((m) => m.template === template);
  await expect.poll(async () => (await of("hrms_approval_approved")).length).toBe(1);
  const [approved] = await of("hrms_approval_approved");
  expect(approved.number).toBe("919000000001");
  expect(approved.params).toMatchObject({ employee_name: "Asha Kumar", request_type: "Leave", comment: "Enjoy" });
  for (const piece of ["Dear Asha Kumar", "Your *Leave* request has been approved", "Family function", "Enjoy"]) {
    expect(approved.message).toContain(piece);
  }
  // every variable is one line (Meta refuses a newline or a tab in a variable)
  for (const value of Object.values(approved.params)) expect(value).not.toMatch(/[\n\t]/);
  expect(approved.message).not.toMatch(/https?:\/\/|View request|portal/i);

  await request.patch(`/api/leave-requests/${id}/status`, {
    headers,
    data: { status: "rejected", hrComment: "Clash with the audit" },
  });
  await expect.poll(async () => (await of("hrms_approval_rejected")).length).toBe(1);
  expect((await of("hrms_approval_rejected"))[0].message).toContain("Reason: Clash with the audit");
});

test("HR sees those messages on the page: the hero, the templates they went as, and never a code", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/whatsapp-control");
  await expect(page.getByRole("heading", { name: "WhatsApp Control" })).toBeVisible();
  for (const name of [
    "Overview",
    "Usage & Cost",
    "Message Controls",
    "Templates",
    "OTP",
    "Messages",
    "Employees",
    "Send a test",
    "Settings",
  ]) {
    await expect(tab(page, name)).toBeVisible();
  }
  // the connection hero: Meta's answer about the number (the fake's)
  await expect(page.getByTestId("wa-hero")).toContainText("UK Textiles (e2e)");
  await expect(page.getByTestId("wa-kpis")).toBeVisible();

  await tab(page, "Messages").click();
  await expect(page).toHaveURL(/tab=messages/);
  const rows = page.getByTestId("whatsapp-message-row");
  await expect(rows.first()).toBeVisible();
  const ashaCode = rows.filter({ hasText: "Login OTP" }).filter({ hasText: "Asha Kumar" }).first();
  await expect(ashaCode).toBeVisible();
  await expect(ashaCode).toContainText("hrms_otp");
  const approval = rows.filter({ hasText: "Approval - Approved" }).first();
  await expect(approval).toContainText("hrms_approval_approved");
  for (const code of codes) await expect(page.locator("body")).not.toContainText(code);

  await page.getByLabel("Search messages").fill("Ravi");
  await expect(rows.first()).toContainText("Ravi Nair");
  await expect(rows.filter({ hasText: "Asha Kumar" })).toHaveCount(0);
  await page.getByRole("button", { name: "Clear filters" }).click();

  await tab(page, "Employees").click();
  await expect(page.getByTestId("whatsapp-employee-row").filter({ hasText: "Asha Kumar" })).toBeVisible();
});

test("the OTP tab's switches take effect for the apps at once, and nobody is locked out", async ({ page, request }) => {
  await loginAsHr(page);
  await page.goto("/hr/whatsapp-control?tab=otp");
  await expect(page.getByTestId("wa-otp-template-name")).toHaveText("hrms_otp");

  const login = page.getByTestId("toggle-otpLoginEnabled");
  await expect(login).toHaveAttribute("aria-checked", "true");
  await login.click();
  await expect(login).toHaveAttribute("aria-checked", "false");
  let options = await (await request.get("/api/auth/login-options")).json();
  expect(options).toMatchObject({ otpLogin: false, otpReset: true, otpChannels: { login: [], reset: ["whatsapp"] } });
  const refused = await request.post("/api/auth/otp/request", { data: { employeeCode: "E2E001", purpose: "login" } });
  expect(refused.status()).toBe(403);
  await login.click();
  await expect(login).toHaveAttribute("aria-checked", "true");

  // the master switch asks first; OFF leaves no way to get a code, so the password form must be offered
  await page.getByTestId("wa-otp-master-switch").click();
  await page.getByTestId("wa-otp-off-confirm-confirm").click();
  await expect(page.getByTestId("wa-otp-master-switch")).toHaveAttribute("aria-checked", "false");
  options = await (await request.get("/api/auth/login-options")).json();
  expect(options).toMatchObject({
    otpLogin: false,
    otpReset: false,
    otpActivate: false,
    otpChannel: null,
    passwordLogin: true,
    otpChannels: { login: [], reset: [], activate: [] },
  });
  await page.getByTestId("wa-otp-master-switch").click();
  await expect(page.getByTestId("wa-otp-master-switch")).toHaveAttribute("aria-checked", "true");
  options = await (await request.get("/api/auth/login-options")).json();
  expect(options.otpChannels.login).toEqual(["whatsapp"]);
});

test("one approval workflow can be switched off on Message Controls without touching the others", async ({
  page,
  request,
}) => {
  await request.post(`${FAKE}/reset`);
  const headers = await hrHeaders(request);
  const asha = await employeeId(request, "E2E001");
  const leave = async (day: string) => {
    const created = await request.post("/api/leave-requests", {
      headers,
      data: { employeeId: asha, startDate: day, endDate: day, type: "casual", reason: "Family function" },
    });
    expect(created.status()).toBe(201);
    return (await created.json()).id as number;
  };
  const approvals = async () => (await sentMessages(request)).filter((m) => m.template === "hrms_approval_approved");

  await loginAsHr(page);
  await page.goto("/hr/whatsapp-control?tab=controls");
  const toggle = page.getByTestId("toggle-approvalLeaveEnabled");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("toggle-approvalPermissionEnabled")).toHaveAttribute("aria-checked", "true");

  // a leave decision no longer messages anyone (give the sender time to prove it)
  const first = await leave("2026-10-07");
  expect(
    (await request.patch(`/api/leave-requests/${first}/status`, { headers, data: { status: "approved" } })).status(),
  ).toBe(200);
  await page.waitForTimeout(2000);
  expect(await approvals()).toHaveLength(0);

  // switched back on, the next decision goes out
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  const next = await leave("2026-10-08");
  await request.patch(`/api/leave-requests/${next}/status`, { headers, data: { status: "approved" } });
  await expect.poll(async () => (await approvals()).length).toBe(1);
});

test("a template deleted at Meta is offered again on Message Controls and created from the HRMS wording", async ({
  page,
  request,
}) => {
  const headers = await hrHeaders(request);
  const NAME = "hrms_geo_punch_rejection";
  const list = await (await request.get("/api/whatsapp-control/meta-templates", { headers })).json();
  const row = list.templates.find((t: { name: string }) => t.name === NAME);
  expect(row).toMatchObject({ status: "APPROVED", category: "UTILITY", messageTypes: ["geo_punch_rejection"] });

  await loginAsHr(page);
  await page.goto("/hr/whatsapp-control?tab=templates");
  await expect(page.getByTestId("wa-template-hrms_otp")).toBeVisible();
  await page.getByTestId("wa-templates-sync").click();
  await expect(page.getByTestId(`wa-template-${NAME}`)).toHaveAttribute("data-state", "approved");

  // delete it (at Meta too), after a confirmation
  await page.getByTestId(`wa-template-delete-${row.id}`).click();
  await page.getByTestId("wa-template-delete-confirm-confirm").click();
  await expect(page.getByTestId(`wa-template-${NAME}`)).toHaveCount(0);
  const atMeta = (await (await request.get(`${FAKE}/templates`)).json()) as { name: string }[];
  expect(atMeta.map((t) => t.name)).not.toContain(NAME);

  // Message Controls: the type now needs a template, with a button that drafts it from the HRMS wording
  await page.goto("/hr/whatsapp-control?tab=controls");
  await page.getByTestId("wa-type-create-geo_punch_rejection").click();
  const dialog = page.getByTestId("wa-template-dialog");
  await expect(dialog.getByTestId("wa-tpl-name")).toHaveValue(NAME);
  await expect(dialog.getByTestId("wa-tpl-body")).toHaveValue(/\{\{employee_name\}\}/);
  await expect(dialog.getByTestId("wa-tpl-preview")).toContainText("Asha Kumar");
  await dialog.getByTestId("wa-tpl-submit").click();
  await expect(dialog).toHaveCount(0);

  await expect
    .poll(
      async () =>
        ((await (await request.get(`${FAKE}/templates`)).json()) as { name: string; status: string }[]).find(
          (t) => t.name === NAME,
        )?.status,
    )
    .toBe("APPROVED");
  const again = await (await request.get("/api/whatsapp-control/meta-templates", { headers })).json();
  expect(again.templates.find((t: { name: string }) => t.name === NAME)).toMatchObject({ status: "APPROVED" });
  // nothing is missing any more
  const overview = await (await request.get("/api/whatsapp-control/overview", { headers })).json();
  expect(overview.templates.missingForEnabledTypes).toEqual([]);
});

test("Usage & Cost counts this month's messages by category and prices them in rupees", async ({ page, request }) => {
  const headers = await hrHeaders(request);
  const usage = await (await request.get("/api/whatsapp-control/usage", { headers })).json();
  expect(usage.totals.sent).toBeGreaterThan(0);
  expect(usage.byCategory.authentication.messages).toBeGreaterThan(0);
  expect(usage.byCategory.utility.messages).toBeGreaterThan(0);
  expect(usage.cost).toMatchObject({ currency: "INR", gstRate: 0.18, isCurrentMonth: true });
  expect(usage.cost.soFar).toBeGreaterThan(0);
  // Meta's own figures (pricing analytics) were read from the fake
  expect(usage.meta.available).toBe(true);

  await loginAsHr(page);
  await page.goto("/hr/whatsapp-control?tab=usage");
  await expect(page.getByTestId("wa-usage")).toBeVisible();
  await expect(page.getByTestId("wa-usage-cat-authentication")).toBeVisible();
  await expect(page.getByTestId("wa-usage-cost")).toContainText("₹");
});

test("Settings shows the set-up checklist and the webhook address, and never a secret", async ({ page, request }) => {
  await loginAsHr(page);
  await page.goto("/hr/whatsapp-control?tab=config");
  for (const name of [
    "WHATSAPP_CLOUD_PHONE_NUMBER_ID",
    "WHATSAPP_CLOUD_BUSINESS_ACCOUNT_ID",
    "WHATSAPP_CLOUD_ACCESS_TOKEN",
    "WHATSAPP_CLOUD_APP_SECRET",
    "WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN",
  ]) {
    await expect(page.getByTestId(`wa-env-${name}`)).toContainText("Set");
  }
  await expect(page.getByTestId("wa-webhook-url")).toContainText("/api/whatsapp/webhook/");
  for (const secret of [ACCESS_TOKEN, APP_SECRET, VERIFY_TOKEN]) {
    await expect(page.locator("body")).not.toContainText(secret);
  }
  const connection = JSON.stringify(
    await (await request.get("/api/whatsapp-control/connection", { headers: await hrHeaders(request) })).json(),
  );
  for (const secret of [ACCESS_TOKEN, APP_SECRET, VERIFY_TOKEN]) expect(connection).not.toContain(secret);
});

test("Meta refusing a code is a failed message with its reason, and the employee is told", async ({
  page,
  request,
}) => {
  await request.post(`${FAKE}/reset`);
  await request.post(`${FAKE}/fail-next`, { data: { code: 131026, message: "Message undeliverable." } });
  const ask = await request.post("/api/auth/otp/request", { data: { employeeCode: "E2E002", purpose: "login" } });
  expect(ask.status()).toBe(502);

  const headers = await hrHeaders(request);
  const failed = await (
    await request.get("/api/whatsapp-control/messages?page=1&pageSize=20&status=failed", { headers })
  ).json();
  const row = failed.items.find((m: { employeeCode: string }) => m.employeeCode === "E2E002");
  expect(row.error).toContain("131026");

  await loginAsHr(page);
  await page.goto("/hr/whatsapp-control?tab=messages");
  await page.getByRole("tab", { name: /^Failed/ }).click();
  await expect(page.getByTestId("whatsapp-message-row").filter({ hasText: "Ravi Nair" }).first()).toBeVisible();
});
