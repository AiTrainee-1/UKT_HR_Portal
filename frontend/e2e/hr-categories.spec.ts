import { expect, test, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// HR Manager / HR Assistant account categories (backend/api/hr_access.py; the permission matrix is in
// api/tests_hr_categories.py). The Super Admin creates one of each in Account Management, the assistant edits payroll and
// proposes an attendance change but has no Approve button for a missing punch or an attendance edit (and the API refuses
// a direct call), the manager approves both and sees the assistant's activity. Everything made here is called e2e_hc_*
// and removed again; the HOD set-up (E2E003 for E2E001) is removed too, the days touched are reset.

const FAKE_WACLIENT = "http://127.0.0.1:8190";
const HOD_CODE = "E2E003";
const HOD_PASSWORD = "employee-pass-1"; // the password the other specs use for this account
const ASSISTANT = "e2e_hc_asst";
const MANAGER = "e2e_hc_mgr";
const PASSWORD = "Hc-Passw0rd!";
const PUNCH_DAY = "2025-12-03";
const EDIT_DAY = "2025-12-04";

type Reply = { status: number; body: Record<string, any> | null };

async function api(page: Page, method: string, url: string, data?: unknown, token?: string): Promise<Reply> {
  const bearer = token ?? (await page.evaluate(() => localStorage.getItem("uk_textile_token")));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${bearer}` }, data });
  const text = await res.text();
  let body: Reply["body"] = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status(), body };
}

async function token(page: Page, username: string, password: string): Promise<string> {
  const res = await page.request.post("/api/auth/hr-login", { data: { username, password } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).token as string;
}

async function hodToken(page: Page): Promise<string> {
  await page.request.post(`${FAKE_WACLIENT}/reset`);
  const ask = await page.request.post("/api/auth/otp/request", {
    data: { employeeCode: HOD_CODE, purpose: "activate" },
  });
  if (ask.status() === 200) {
    const sent = await (await page.request.get(`${FAKE_WACLIENT}/messages`)).json();
    const otp = sent[0].message.match(/\b(\d{6})\b/)![1];
    const activate = await page.request.post("/api/auth/otp/activate", {
      data: { employeeCode: HOD_CODE, otp, password: HOD_PASSWORD },
    });
    expect(activate.status()).toBe(200);
  } else {
    expect(ask.status()).toBe(409); // already activated
  }
  const login = await page.request.post("/api/auth/employee-login", {
    data: { identifier: HOD_CODE, password: HOD_PASSWORD },
  });
  expect(login.status()).toBe(200);
  return (await login.json()).token as string;
}

async function loginAs(page: Page, username: string) {
  await page.evaluate(() => localStorage.removeItem("uk_textile_token"));
  await page.goto("/hr-login");
  await page.getByTestId("input-username").fill(username);
  await page.getByTestId("input-password").fill(PASSWORD);
  await page.getByTestId("button-submit").click();
  await expect(page).toHaveURL(/\/hr\/dashboard/, { timeout: 30_000 });
}

async function cleanAccounts(page: Page, admin: string) {
  const users = ((await api(page, "GET", "/api/hr-users", undefined, admin)).body ?? []) as unknown as {
    id: number;
    username: string;
  }[];
  for (const u of users.filter((x) => x.username.startsWith("e2e_hc_"))) {
    await api(page, "DELETE", `/api/hr-users/${u.id}`, undefined, admin);
  }
}

test("HR Manager and HR Assistant: created by the Super Admin, the assistant edits but can't approve, the manager approves and reviews", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await loginAsHr(page);
  const admin = await token(page, HR_USERNAME, HR_PASSWORD);
  await cleanAccounts(page, admin);
  const employees = (await api(page, "GET", "/api/employees?search=E2E00", undefined, admin)).body as unknown as {
    id: number;
    employeeCode: string;
  }[];
  const asha = employees.find((e) => e.employeeCode === "E2E001")!;
  const manager = await api(page, "POST", "/api/department-managers", { employeeCode: HOD_CODE }, admin);
  expect(manager.status, JSON.stringify(manager.body)).toBe(201);
  const managerId = manager.body!.id as number;
  let punchId: number | null = null;
  try {
    expect(
      (await api(page, "POST", `/api/department-managers/${managerId}/employees`, { employeeCode: "E2E001" }, admin))
        .status,
    ).toBeLessThan(300);

    // ── the Super Admin creates an HR Assistant and an HR Manager on their own tabs ──
    await page.goto("/hr/account-management");
    await page.getByRole("tab", { name: /^HR Assistant/ }).click();
    await expect(page.getByTestId("category-tab-hr_assistant")).toBeVisible();
    await page.getByTestId("create-hr_assistant").click();
    const dialog = page.getByTestId("category-account-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("cat-username").fill(ASSISTANT);
    await page.getByTestId("cat-password").fill(PASSWORD);
    await page.getByTestId("cat-fullname").fill("Asha Assistant");
    await expect(page.getByTestId("cat-role")).toContainText("HR Assistant - default");
    await dialog.getByRole("tab", { name: /^Approvals/ }).click();
    await expect(page.getByTestId("approval-missing_punch")).toHaveAttribute("data-locked", "true");
    await expect(page.getByTestId("approval-attendance_correction")).toHaveAttribute("data-locked", "true");
    await expect(page.getByTestId("approval-switch-missing_punch")).toBeDisabled();
    await expect(page.getByTestId("cat-can-approve")).toContainText("Leave");
    await page.getByTestId("cat-save").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId(`cat-row-${ASSISTANT}`)).toBeVisible();

    await page.getByRole("tab", { name: /^HR Manager/ }).click();
    await page.getByTestId("create-hr_manager").click();
    await page.getByTestId("cat-username").fill(MANAGER);
    await page.getByTestId("cat-password").fill(PASSWORD);
    await page.getByTestId("cat-fullname").fill("Meera Manager");
    await expect(page.getByTestId("cat-role")).toContainText("HR Manager - default");
    await page.getByTestId("cat-save").click();
    await expect(page.getByTestId(`cat-row-${MANAGER}`)).toBeVisible();

    // the Accounts tab shows the category, and can filter by it
    await page.getByRole("tab", { name: /^Accounts/ }).click();
    const assistantRow = page.getByTestId("accounts-table").getByTestId(`account-row-${ASSISTANT}`);
    await expect(assistantRow.getByTestId("category-chip-hr_assistant")).toBeVisible();

    // the starter role for assistants shows the two approvals locked
    await page.getByRole("tab", { name: /^Roles/ }).click();
    await page.getByTestId("roles-table").getByTestId("role-edit-HR Assistant - default").click();
    await page
      .getByTestId("role-dialog")
      .getByRole("tab", { name: /^Approvals/ })
      .click();
    await expect(page.getByTestId("approval-missing_punch")).toHaveAttribute("data-locked", "true");
    await page.keyboard.press("Escape");

    // ── requests waiting for HR: a missing punch and an attendance edit, both already approved by the HOD ──
    const created = await api(
      page,
      "POST",
      "/api/missing-punch-requests",
      {
        employeeCode: "E2E001",
        date: PUNCH_DAY,
        punchTime: "09:05",
        punchSlot: "morning_in",
        reason: "card left home",
      },
      admin,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    punchId = created.body!.id as number;
    const hod = await hodToken(page);
    expect(
      (await api(page, "PATCH", `/api/manager/missing-punch-requests/${punchId}/status`, { status: "approved" }, hod))
        .status,
    ).toBe(200);

    // ── the assistant ──
    const asst = await token(page, ASSISTANT, PASSWORD);
    // edits payroll (a bonus on a payroll row of a month nobody else uses)
    await api(page, "POST", "/api/payroll/generate", { month: 4, year: 2025 }, admin);
    const rows = (await api(page, "GET", "/api/payroll?month=4&year=2025", undefined, admin)).body as unknown as {
      id: number;
      salaryMode: string;
    }[];
    const row = rows.find((r) => r.salaryMode === "monthly")!;
    expect(row, "a staff payroll row for April 2025").toBeTruthy();
    const edited = await api(page, "PATCH", `/api/payroll/${row.id}`, { bonus: 321 }, asst);
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    // proposes an attendance change (editing attendance is allowed; it waits for the HOD, then HR)
    const proposal = await api(
      page,
      "POST",
      "/api/attendance/override",
      { employeeId: asha.id, date: EDIT_DAY, type: "absent", note: "Did not come, confirmed" },
      asst,
    );
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(202);
    const editId = proposal.body!.request.id as number;
    expect(
      (await api(page, "PATCH", `/api/manager/attendance-requests/${editId}/status`, { status: "approved" }, hod))
        .status,
    ).toBe(200);

    await loginAs(page, ASSISTANT);
    const nav = page.locator("nav");
    await expect(nav.locator('a[href="/hr/payroll"]')).toBeVisible();
    await expect(nav.locator('a[href="/hr/leave"]')).toBeVisible();
    await expect(nav.locator('a[href="/hr/settings"]')).toHaveCount(0);
    await expect(nav.locator('a[href="/hr/account-management"]')).toHaveCount(0);
    await expect(nav.locator('a[href="/hr/assistant-activity"]')).toHaveCount(0);
    await expect(page.getByTestId("profile-category-badge")).toHaveText("HR Assistant");

    // the missing punch: on the list, but no Approve button, a note why, and a direct call is refused
    await page.goto("/hr/missing-punch");
    await expect(page.getByTestId(`missing-punch-${punchId}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`mp-locked-${punchId}`)).toBeVisible();
    await expect(page.getByTestId(`missing-punch-${punchId}`).getByRole("button", { name: /^Approve/ })).toHaveCount(0);
    const refused = await api(
      page,
      "PATCH",
      `/api/missing-punch-requests/${punchId}/status`,
      { status: "approved" },
      asst,
    );
    expect(refused.status).toBe(403);
    expect(refused.body!.code).toBe("approval_not_permitted");

    // the attendance edit: no Approve button on the Requests page, and a direct call is refused
    await page.goto("/hr/requests?kind=attendance_correction");
    await expect(page.getByTestId(`request-attendance_correction-${editId}`).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`approve-attendance_correction-${editId}`)).toHaveCount(0);
    const refusedEdit = await api(
      page,
      "PATCH",
      `/api/attendance/override-requests/${editId}`,
      { status: "approved" },
      asst,
    );
    expect(refusedEdit.status).toBe(403);
    expect(refusedEdit.body!.code).toBe("approval_not_permitted");
    // Account Management stays the Super Admin's
    expect((await api(page, "GET", "/api/hr-users", undefined, asst)).status).toBe(403);

    // ── the manager approves both and reviews the assistant's activity ──
    await loginAs(page, MANAGER);
    await expect(page.getByTestId("profile-category-badge")).toHaveText("HR Manager");
    await expect(page.locator("nav").locator('a[href="/hr/account-management"]')).toHaveCount(0);
    await page.goto("/hr/missing-punch");
    const card = page.getByTestId(`missing-punch-${punchId}`);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole("button", { name: /^Approve/ }).click();
    await expect
      .poll(async () => (await api(page, "GET", `/api/missing-punch-requests?status=all`, undefined, admin)).body)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: punchId, status: "approved" })]));

    await page.goto("/hr/requests?kind=attendance_correction");
    await page.getByTestId(`approve-attendance_correction-${editId}`).first().click();
    await expect(page.getByTestId(`approve-attendance_correction-${editId}`)).toHaveCount(0, { timeout: 30_000 });

    await page.goto("/hr/assistant-activity");
    await expect(page.getByTestId("activity-title")).toHaveText("HR Assistant activity");
    const table = page.getByTestId("activity-table");
    // (the module's name in the tree is "Staff Payroll" since 2026-11-11)
    await expect(table).toContainText("Changed in Staff Payroll", { timeout: 30_000 });
    await expect(table).toContainText("Proposed Absent");
    await expect(table).toContainText("Asha Assistant");
    expect((await api(page, "GET", "/api/hr-users")).status).toBe(403);
  } finally {
    if (punchId) await api(page, "DELETE", `/api/missing-punch-requests/${punchId}/status`, undefined, admin);
    for (const d of [EDIT_DAY, PUNCH_DAY]) {
      await api(page, "POST", "/api/attendance/override", { employeeId: asha.id, date: d, reset: true }, admin);
    }
    await api(page, "DELETE", `/api/department-managers/${managerId}`, undefined, admin);
    await cleanAccounts(page, admin);
  }
});
