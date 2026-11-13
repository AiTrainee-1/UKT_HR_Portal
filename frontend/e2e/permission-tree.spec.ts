import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// The full permission tree (2026-11-11, permission-inventory.md): a role can hide one tab of a page on its own, and approve
// one request type on its own. Everything made here is called pt_* (accounts) or "PT *" (roles) and removed again; the two
// employee requests it raises (there is no delete for them) are rejected at the end, so nothing is left waiting.

const PASSWORD = "Pt-Passw0rd!x";

type Reply = { status: number; body: any };

async function api(page: Page, method: string, url: string, data?: unknown, token?: string): Promise<Reply> {
  const bearer = token ?? (await page.evaluate(() => localStorage.getItem("uk_textile_token")));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${bearer}` }, data });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status(), body };
}

async function tokenOf(page: Page, username: string): Promise<string> {
  const res = await page.request.post("/api/auth/hr-login", { data: { username, password: PASSWORD } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).token as string;
}

async function cleanUp(page: Page) {
  const users = ((await api(page, "GET", "/api/hr-users")).body ?? []) as { id: number; username: string }[];
  for (const u of users.filter((u) => u.username.startsWith("pt_"))) await api(page, "DELETE", `/api/hr-users/${u.id}`);
  const roles = ((await api(page, "GET", "/api/roles")).body ?? []) as { id: number; name: string }[];
  for (const r of roles.filter((r) => r.name.startsWith("PT "))) await api(page, "DELETE", `/api/roles/${r.id}`);
}

/** A role and a login with it (made by the Super Admin through the API). */
async function account(page: Page, username: string, role: Record<string, unknown>) {
  const made = await api(page, "POST", "/api/roles", role);
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const user = await api(page, "POST", "/api/hr-users", {
    username,
    password: PASSWORD,
    fullName: username,
    roleId: made.body.id,
  });
  expect(user.status, JSON.stringify(user.body)).toBe(201);
}

async function signIn(page: Page, username: string) {
  await page.evaluate(() => localStorage.removeItem("uk_textile_token"));
  await page.goto("/hr-login");
  await page.getByTestId("input-username").fill(username);
  await page.getByTestId("input-password").fill(PASSWORD);
  await page.getByTestId("button-submit").click();
  await expect(page).toHaveURL(/\/hr\/dashboard/);
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await loginAsHr(page);
  await cleanUp(page);
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await loginAsHr(page);
  await cleanUp(page);
  await page.close();
});

test("a role with one tab hidden: the tab is gone and its API refuses", async ({ page }) => {
  await account(page, "pt_cl", {
    name: "PT No carry forward",
    permissions: { dashboard: "view", casual_leave: "edit", "casual_leave.carry_forward": "hidden" },
  });
  await signIn(page, "pt_cl");
  await page.goto("/hr/casual-leave");
  await expect(page.getByRole("tab", { name: /^Requests/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Carry Forward/ })).toHaveCount(0);
  // asking for it by address opens the first tab it may see instead
  await page.goto("/hr/casual-leave?tab=carry-forward");
  await expect(page.getByRole("tab", { name: /^Taken this month/ })).toHaveAttribute("aria-selected", "true");

  const token = await tokenOf(page, "pt_cl");
  expect((await api(page, "GET", "/api/casual-leaves/adjustments?year=2026", undefined, token)).status).toBe(403);
  expect((await api(page, "POST", "/api/casual-leaves/assign", {}, token)).status).toBe(403);
  expect((await api(page, "GET", "/api/casual-leaves?month=11&year=2026", undefined, token)).status).toBe(200);
});

test("a role that approves only Salary Enquiry decides those and not a Shift Correction", async ({ page }) => {
  const employees = (await api(page, "GET", "/api/employees")).body as { id: number; employeeCode: string }[];
  const emp = employees.find((e) => e.employeeCode === "E2E001") ?? employees[0];
  const raise = async (requestType: string) => {
    const r = await api(page, "POST", "/api/employee-requests", {
      employeeId: emp.id,
      requestType,
      subject: `PT ${requestType}`,
      description: "PT permission tree",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };
  const enquiry = await raise("salary_enquiry");
  const shift = await raise("shift_correction");
  await account(page, "pt_salary", {
    name: "PT Salary enquiries",
    permissions: { dashboard: "view", requests: "edit" },
    approvals: { request_salary_enquiry: true },
  });

  try {
    await signIn(page, "pt_salary");
    await page.goto("/hr/requests?kind=request");
    const handle = async (id: number) => {
      await page.getByTestId(`request-request-${id}`).getByTestId(`handle-request-${id}`).click();
      const dialog = page.getByTestId("handle-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("handle-status").click();
      return dialog;
    };
    // Salary Enquiry: Approved is offered
    const dialog = await handle(enquiry);
    await expect(page.getByRole("option", { name: "Approved", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    // Shift Correction: this account may not decide it, so the row offers no Reply & set status at all
    const shiftRow = page.getByTestId(`request-request-${shift}`);
    await expect(shiftRow).toBeVisible();
    await expect(shiftRow.getByTestId(`handle-request-${shift}`)).toHaveCount(0);

    // ...and the API says the same
    const token = await tokenOf(page, "pt_salary");
    const no = await api(page, "PUT", `/api/employee-requests/${shift}/action`, { status: "approved" }, token);
    expect(no.status).toBe(403);
    expect(no.body.code).toBe("approval_not_permitted");
    const yes = await api(page, "PUT", `/api/employee-requests/${enquiry}/action`, { status: "rejected" }, token);
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
  } finally {
    await loginAsHr(page);
    await api(page, "PUT", `/api/employee-requests/${shift}/action`, { status: "rejected", hrNotes: "PT clean-up" });
    await api(page, "PUT", `/api/employee-requests/${enquiry}/action`, { status: "rejected", hrNotes: "PT clean-up" });
  }
});

test("the role dialog lists every page, tab and approval kind", async ({ page }) => {
  await page.goto("/hr/account-management");
  await page.getByRole("tab", { name: /^Roles & Permissions/ }).click();
  await page.getByTestId("create-role").click();
  const dialog = page.getByTestId("role-dialog");
  await expect(dialog).toBeVisible();
  // search finds a tab three levels down, with the path to it
  await page.getByTestId("module-search").fill("waiting for hr");
  await expect(dialog.getByTestId("module-compensation.ot.type2.waiting")).toBeVisible();
  await expect(dialog.getByTestId("section-compensation")).toBeVisible();
  // a page's control takes its tabs with it
  await page.getByTestId("module-search").fill("staff payroll");
  await dialog.getByTestId("perm-payroll-edit").click();
  await expect(dialog.getByTestId("perm-payroll.issues-edit")).toHaveAttribute("data-active", "true");
  await page.getByRole("button", { name: "Clear module search" }).click();
  // the approvals: every request type on its own, nothing behind a generic label
  await dialog.getByRole("tab", { name: /^Approvals/ }).click();
  await dialog.getByTestId("approvals-make-explicit").click();
  for (const kind of [
    "request_leave",
    "request_salary_enquiry",
    "request_shift_correction",
    "request_advance",
    "request_permission",
    "request_general",
    "advance_general",
    "advance_term",
    "payroll_finalize",
    "payroll_mark_paid",
    "payroll_release",
  ]) {
    await expect(dialog.getByTestId(`approval-${kind}`)).toBeVisible();
  }
  await expect(dialog.getByTestId("approval-info-holiday_work")).toBeVisible();
  await expect(dialog).not.toContainText("Other requests –");
});
