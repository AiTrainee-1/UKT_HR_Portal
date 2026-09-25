import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// WhatsApp goes to a fake WAClient on :8190 (see fake-waclient.mjs), which is also where these tests
// read the OTP an employee would have received.
const FAKE = "http://127.0.0.1:8190";

type Sent = { number: string; type: string; message?: string; url?: string; kind?: string; instance_id: string };

async function sentMessages(request: APIRequestContext): Promise<Sent[]> {
  return (await request.get(`${FAKE}/messages`)).json();
}

async function hrToken(page: Page) {
  return page.evaluate(() => localStorage.getItem("uk_textile_token"));
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });

test.describe.configure({ mode: "serial" });

test("an employee signs in with a WhatsApp OTP, end to end", async ({ request }) => {
  await request.post(`${FAKE}/reset`);

  const options = await (await request.get("/api/auth/login-options")).json();
  expect(options).toEqual({ otpLogin: true, otpReset: true, otpActivate: true, passwordLogin: true });

  // Ask for a code by Employee Code: it must be WhatsApped to the number on file.
  const ask = await request.post("/api/auth/otp/request", { data: { employeeCode: "E2E001", purpose: "login" } });
  expect(ask.status()).toBe(200);
  expect((await ask.json()).maskedPhone).toMatch(/0001$/);

  const sent = await sentMessages(request);
  expect(sent).toHaveLength(1);
  expect(sent[0].number).toBe("919000000001");
  expect(sent[0].type).toBe("text");
  const code = sent[0].message!.match(/\b(\d{6})\b/)![1];

  // A wrong code is refused; the right one signs in and the token really works.
  const wrong = await request.post("/api/auth/otp/login", {
    data: { employeeCode: "E2E001", otp: code === "000000" ? "111111" : "000000" },
  });
  expect(wrong.status()).toBe(400);
  const login = await request.post("/api/auth/otp/login", { data: { employeeCode: "E2E001", otp: code } });
  expect(login.status()).toBe(200);
  const { token, employeeId } = await login.json();
  const me = await request.get("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
  expect((await me.json()).employeeId).toBe(employeeId);

  // ...and the same code can't be used twice.
  const again = await request.post("/api/auth/otp/login", { data: { employeeCode: "E2E001", otp: code } });
  expect(again.status()).toBe(400);
});

test("a new employee must confirm a WhatsApp code before choosing a first password", async ({ request }) => {
  await request.post(`${FAKE}/reset`);

  // The old open route no longer lets a stranger set someone's first password.
  const direct = await request.post("/api/auth/set-password", {
    data: { identifier: "E2E002", password: "attacker-pass-1" },
  });
  expect(direct.status()).toBe(403);
  expect(
    (
      await request.post("/api/auth/employee-login", { data: { identifier: "E2E002", password: "attacker-pass-1" } })
    ).status(),
  ).toBe(401);

  // The code goes to the number HR has on file, worded as an activation code.
  const ask = await request.post("/api/auth/otp/request", { data: { employeeCode: "E2E002", purpose: "activate" } });
  expect(ask.status()).toBe(200);
  const sent = await sentMessages(request);
  expect(sent).toHaveLength(1);
  expect(sent[0].number).toBe("919000000002");
  expect(sent[0].message).toContain("activation code");
  const code = sent[0].message!.match(/\b(\d{6})\b/)![1];

  // A wrong code sets nothing; the right one sets the password, which then signs in.
  const wrong = await request.post("/api/auth/otp/activate", {
    data: { employeeCode: "E2E002", otp: code === "000000" ? "111111" : "000000", password: "first-password-1" },
  });
  expect(wrong.status()).toBe(400);
  const activate = await request.post("/api/auth/otp/activate", {
    data: { employeeCode: "E2E002", otp: code, password: "first-password-1" },
  });
  expect(activate.status()).toBe(200);
  const login = await request.post("/api/auth/employee-login", {
    data: { identifier: "E2E002", password: "first-password-1" },
  });
  expect(login.status()).toBe(200);

  // Once activated there is nothing left to activate.
  const again = await request.post("/api/auth/otp/request", { data: { employeeCode: "E2E002", purpose: "activate" } });
  expect(again.status()).toBe(409);
});

test("forgot password resets through a WhatsApp OTP", async ({ request }) => {
  await request.post(`${FAKE}/reset`);
  await request.post("/api/auth/otp/request", { data: { employeeCode: "E2E002", purpose: "reset" } });
  const code = (await sentMessages(request))[0].message!.match(/\b(\d{6})\b/)![1];

  const reset = await request.post("/api/auth/otp/reset-password", {
    data: { employeeCode: "E2E002", otp: code, password: "a-new-password-1" },
  });
  expect(reset.status()).toBe(200);
  const login = await request.post("/api/auth/employee-login", {
    data: { identifier: "E2E002", password: "a-new-password-1" },
  });
  expect(login.status()).toBe(200);
});

test("employee tokens cannot open the WhatsApp Control API", async ({ request }) => {
  await request.post(`${FAKE}/reset`);
  await request.post("/api/auth/otp/request", { data: { employeeCode: "E2E003", purpose: "login" } });
  const code = (await sentMessages(request))[0].message!.match(/\b(\d{6})\b/)![1];
  const { token } = await (
    await request.post("/api/auth/otp/login", { data: { employeeCode: "E2E003", otp: code } })
  ).json();
  const auth = { Authorization: `Bearer ${token}` };
  for (const path of ["overview", "messages", "employees", "settings", "templates"]) {
    expect((await request.get(`/api/whatsapp-control/${path}`, { headers: auth })).status(), path).toBe(403);
  }
  expect((await request.get("/api/whatsapp-control/overview")).status()).toBe(401);
});

test("HR sees those messages on the WhatsApp Control page, with the code hidden", async ({ page, request }) => {
  await loginAsHr(page);
  await page.goto("/hr/whatsapp-control");
  await expect(page.getByRole("heading", { name: "WhatsApp Control" })).toBeVisible();

  // Overview: the OTPs sent above are counted and grouped under "OTP & Login".
  await expect(page.getByText("By module")).toBeVisible();
  await expect(page.getByRole("button", { name: /OTP & Login/ })).toContainText(/[1-9]/);

  // Messages tab: newest first, with a Login OTP row for Asha whose text never shows the code.
  await tab(page, "Messages").click();
  const rows = page.getByTestId("whatsapp-message-row");
  await expect(rows.first()).toBeVisible();
  const ashaOtp = rows.filter({ hasText: "Login OTP" }).filter({ hasText: "Asha Kumar" }).first();
  await expect(ashaOtp).toBeVisible();
  await expect(ashaOtp).toContainText("••••••");
  await ashaOtp.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("••••••");
  await expect(dialog).toContainText("+919000000001");
  await expect(dialog).toContainText("Automatic");
  const codeSent = (await sentMessages(request)).find((m) => m.number === "919000000001");
  if (codeSent) {
    const code = codeSent.message?.match(/\b(\d{6})\b/)?.[1];
    if (code) await expect(dialog).not.toContainText(code);
  }
  await page.keyboard.press("Escape");

  // Filters narrow the list.
  await page.getByLabel("Search messages").fill("Ravi");
  await expect(rows.first()).toContainText("Ravi Nair");
  await expect(rows.filter({ hasText: "Asha Kumar" })).toHaveCount(0);
  await page.getByRole("button", { name: "Clear" }).click();
  await page.getByRole("tab", { name: "Failed", exact: true }).click();
  await expect(page.getByText("No messages match these filters.")).toBeVisible();

  // Employee-wise history.
  await tab(page, "Employees").click();
  const employeeRow = page.getByTestId("whatsapp-employee-row").filter({ hasText: "Asha Kumar" });
  await expect(employeeRow).toBeVisible();
  await employeeRow.click();
  await expect(page.getByRole("dialog")).toContainText("Asha Kumar");
  await expect(page.getByRole("dialog").getByTestId("whatsapp-message-row").first()).toContainText("Login OTP");
  await page.keyboard.press("Escape");

  // Token for the API-level checks below.
  expect(await hrToken(page)).toBeTruthy();
});

test("every feature can be switched on and off, and it takes effect", async ({ page, request }) => {
  await loginAsHr(page);
  await page.goto("/hr/whatsapp-control");
  await tab(page, "Feature Controls").click();

  // The attendance alerts and geo approval start OFF; sign-in features start ON.
  for (const key of [
    "absentAlertEnabled",
    "missingPunchAlertEnabled",
    "lateAlertEnabled",
    "fourPunchAlertEnabled",
    "geoApprovalEnabled",
  ]) {
    await expect(page.getByTestId(`toggle-${key}`)).toHaveAttribute("aria-checked", "false");
  }
  await expect(page.getByTestId("toggle-otpLoginEnabled")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("toggle-otpActivateEnabled")).toHaveAttribute("aria-checked", "true");

  // Flip each alert ON independently, and confirm the others don't move.
  const absent = page.getByTestId("toggle-absentAlertEnabled");
  await absent.click();
  await expect(absent).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("toggle-lateAlertEnabled")).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await tab(page, "Feature Controls").click();
  await expect(page.getByTestId("toggle-absentAlertEnabled")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("toggle-absentAlertEnabled").click();
  await expect(page.getByTestId("toggle-absentAlertEnabled")).toHaveAttribute("aria-checked", "false");

  // Switching OTP login OFF really turns it off for the apps...
  await page.getByTestId("toggle-otpLoginEnabled").click();
  await expect(page.getByTestId("toggle-otpLoginEnabled")).toHaveAttribute("aria-checked", "false");
  expect((await (await request.get("/api/auth/login-options")).json()).otpLogin).toBe(false);
  const refused = await request.post("/api/auth/otp/request", { data: { employeeCode: "E2E001", purpose: "login" } });
  expect(refused.status()).toBe(403);
  // ...and back ON restores it.
  await page.getByTestId("toggle-otpLoginEnabled").click();
  await expect(page.getByTestId("toggle-otpLoginEnabled")).toHaveAttribute("aria-checked", "true");
  expect((await (await request.get("/api/auth/login-options")).json()).otpLogin).toBe(true);
});

test("message wording can be edited and reset to the default", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/whatsapp-control");
  await tab(page, "Message Text").click();

  const row = page.getByTestId("template-salary_slip");
  await expect(row).toContainText("Default");
  await row.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Message text").fill("Hi {{1}}, slip for {{2}} attached.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("template-salary_slip")).toContainText("Customised");

  // A login code message must keep {{1}} (otherwise nobody could log in).
  await page.getByTestId("template-otp_login").getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Message text").fill("Your code is coming soon");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/must include/i).first()).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // Reset the slip wording so the run leaves nothing behind.
  await page.getByTestId("template-salary_slip").getByRole("button", { name: "Edit" }).click();
  await page.getByRole("button", { name: "Use default" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("template-salary_slip")).toContainText("Default");
});

test("configuration shows the webhook address and never a secret", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/whatsapp-control");
  await tab(page, "Configuration").click();
  await expect(page.getByText("WAClient credentials are set on the server")).toBeVisible();
  await expect(page.getByTestId("webhook-url")).toContainText("/api/whatsapp/webhook/");
  await expect(page.locator("body")).not.toContainText("e2e-token");
  await expect(page.locator("body")).not.toContainText("e2e-instance");
});

test("a WhatsApp outage is shown as a failed message with its reason", async ({ page, request }) => {
  await request.post(`${FAKE}/fail-next`);
  // Wait out the per-employee resend cooldown by using an employee not asked yet.
  const ask = await request.post("/api/auth/otp/request", { data: { employeeCode: "E2E002", purpose: "login" } });
  expect(ask.status()).toBe(502);

  await loginAsHr(page);
  await page.goto("/hr/whatsapp-control");
  await tab(page, "Messages").click();
  await page.getByRole("tab", { name: "Failed", exact: true }).click();
  const failed = page.getByTestId("whatsapp-message-row").filter({ hasText: "Ravi Nair" });
  await expect(failed.first()).toContainText("Instance not connected");
  await tab(page, "Overview").click();
  await expect(page.getByText("Recent failures")).toBeVisible();
  await expect(page.getByText("Instance not connected").first()).toBeVisible();
});

// ── the centralised layer: approvals, the message editor, module switches ──────────────────────

async function hrApi(request: APIRequestContext) {
  const login = await request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };
  const employees = await (await request.get("/api/employees", { headers })).json();
  const asha = employees.find((e: { employeeCode: string }) => e.employeeCode === "E2E001");
  return { headers, asha };
}

async function newLeave(request: APIRequestContext, day: string) {
  const { headers, asha } = await hrApi(request);
  const created = await request.post("/api/leave-requests", {
    headers,
    data: { employeeId: asha.id, startDate: day, endDate: day, type: "casual", reason: "Family function" },
  });
  expect(created.status()).toBe(201);
  return { headers, id: (await created.json()).id as number };
}

const decisions = async (request: APIRequestContext, title: string) =>
  (await sentMessages(request)).filter((m) => m.message?.includes(title));

test("approving and rejecting a request WhatsApps the employee, and HR sees it under Approvals", async ({
  page,
  request,
}) => {
  await request.post(`${FAKE}/reset`);
  const { headers, id } = await newLeave(request, "2026-10-05");

  const approve = await request.patch(`/api/leave-requests/${id}/status`, {
    headers,
    data: { status: "approved", hrComment: "Enjoy" },
  });
  expect(approve.status()).toBe(200);
  // Delivered by the background worker, so wait for it rather than expect it at once.
  await expect.poll(async () => (await decisions(request, "Request Approved")).length).toBe(1);
  const [approved] = await decisions(request, "Request Approved");
  expect(approved.number).toBe("919000000001");
  for (const piece of ["Hello Asha Kumar", "Your *Leave* request has been approved", "Family function", "Enjoy"]) {
    expect(approved.message).toContain(piece);
  }
  // A portal address is configured, so the message carries a link (sent as a link preview).
  expect(approved.type).toBe("link");
  expect(approved.url).toBe("https://portal.e2e.test/employee/leave");

  // HR changes their mind: the employee hears that too, with the reason.
  await request.patch(`/api/leave-requests/${id}/status`, {
    headers,
    data: { status: "rejected", hrComment: "Clash with the audit" },
  });
  await expect.poll(async () => (await decisions(request, "Request Rejected")).length).toBe(1);
  expect((await decisions(request, "Request Rejected"))[0].message).toContain("Reason: Clash with the audit");

  // The Messages tab shows both, tagged with the module and workflow that raised them.
  await loginAsHr(page);
  await page.goto("/hr/whatsapp-control");
  await tab(page, "Messages").click();
  const rows = page.getByTestId("whatsapp-message-row");
  const approvedRow = rows.filter({ hasText: "Approval - Approved" }).first();
  await expect(approvedRow).toContainText("Approvals - Leave");
  await expect(approvedRow).toContainText("Asha Kumar");
  await expect(approvedRow).toContainText("+919000000001");
  await expect(rows.filter({ hasText: "Approval - Rejected" }).first()).toContainText("Approvals - Leave");
  // ...and the workflow filter narrows to it.
  await page.getByRole("combobox", { name: "Workflow" }).click();
  await page.getByRole("option", { name: "Leave", exact: true }).click();
  await expect(rows.first()).toContainText("Approvals - Leave");
  await expect(rows.filter({ hasText: "Login OTP" })).toHaveCount(0);

  // Overview: today's and this month's numbers.
  await tab(page, "Overview").click();
  await expect(page.getByTestId("period-today")).toContainText("Total");
  await expect(page.getByTestId("period-this-month")).toContainText("Delivered");
});

test("one approval workflow can be switched off without touching the others", async ({ page, request }) => {
  await request.post(`${FAKE}/reset`);
  await loginAsHr(page);
  await page.goto("/hr/whatsapp-control");
  await tab(page, "Feature Controls").click();
  const leave = page.getByTestId("toggle-approvalLeaveEnabled");
  await expect(leave).toHaveAttribute("aria-checked", "true");
  await leave.click();
  await expect(leave).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("toggle-approvalPermissionEnabled")).toHaveAttribute("aria-checked", "true");

  // A leave decision no longer messages anyone (give the background worker time to prove it).
  const { headers, id } = await newLeave(request, "2026-10-07");
  expect(
    (await request.patch(`/api/leave-requests/${id}/status`, { headers, data: { status: "approved" } })).status(),
  ).toBe(200);
  await page.waitForTimeout(2000);
  expect(await decisions(request, "Request Approved")).toHaveLength(0);

  // Switched back on, the next decision goes out.
  await leave.click();
  await expect(leave).toHaveAttribute("aria-checked", "true");
  const next = await newLeave(request, "2026-10-08");
  await request.patch(`/api/leave-requests/${next.id}/status`, { headers, data: { status: "approved" } });
  await expect.poll(async () => (await decisions(request, "Request Approved")).length).toBe(1);
});

test("the message editor previews wording as you type, inserts variables and catches typos", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/whatsapp-control");
  await tab(page, "Message Text").click();

  // Every module has its own group, including the new ones.
  for (const module of ["Approvals", "Geo Attendance", "Visitors", "Outpass & Gate"]) {
    await expect(page.locator("p.uppercase").filter({ hasText: module })).toBeVisible();
  }
  await expect(page.getByTestId("template-visitor_contact")).toContainText("Contact card");

  await page.getByTestId("template-approval_rejected").getByRole("button", { name: "Edit" }).click();
  const preview = page.getByTestId("template-preview");
  await expect(preview).toContainText("Request Rejected");
  await expect(preview).toContainText("Rejected by: Meena (HR)");

  const box = page.getByLabel("Message text");
  await box.fill("Sorry {{employee_name}}, your {{request_type}} was rejected");
  await expect(preview).toContainText("Sorry Asha Kumar, your Leave was rejected");

  // A variable is inserted where the cursor is.
  await box.fill("Reason: ");
  await page.getByRole("button", { name: "{{comment}}" }).click();
  await expect(box).toHaveValue("Reason: {{comment}}");
  await expect(preview).toContainText("Reason: Get well soon");

  // A misspelt variable is called out before anything is sent blank.
  await box.fill("Hi {{employe_name}}");
  await expect(page.getByText(/Unknown placeholder/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
});
