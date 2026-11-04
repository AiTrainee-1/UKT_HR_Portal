import { expect, test, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// Casual Leave -> Carry Forward (owner 2026-11-04, final form): the balance stays a fixed 12. "Deduct days": HR enters the
// most days, the system detects the employee's Absent and On Leave days of a month (with an animation), HR picks that many
// dates or fewer, and only the picked dates become Casual Leave. Every round is kept in a log with the balance before and
// after. The test makes an employee of its own with absent days (and one approved leave day) in October 2026.

type Reply = { status: number; body: any };

async function api(page: Page, method: string, url: string, data?: unknown, token?: string): Promise<Reply> {
  const bearer = token ?? (await page.evaluate(() => localStorage.getItem("uk_textile_token")));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${bearer}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function adminToken(page: Page): Promise<string> {
  const res = await page.request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  return (await res.json()).token as string;
}

const VIEWER = { username: "e2e_cl_viewer", password: "E2e-Viewer-Passw0rd!" };
const made = {
  role: null as number | null,
  user: null as number | null,
  employee: null as number | null,
  leave: null as number | null,
};

test.afterEach(async ({ page }) => {
  const token = await adminToken(page);
  if (made.user) await api(page, "DELETE", `/api/hr-users/${made.user}`, undefined, token);
  if (made.role) await api(page, "DELETE", `/api/roles/${made.role}`, undefined, token);
  if (made.leave) await api(page, "DELETE", `/api/leave-requests/${made.leave}`, undefined, token);
  if (made.employee) await api(page, "DELETE", `/api/employees/${made.employee}`, undefined, token);
  made.user = made.role = made.employee = made.leave = null;
});

async function left(page: Page, token: string, employeeId: number): Promise<{ total: number; remaining: number }> {
  const history = await api(page, "GET", `/api/casual-leaves/history?employeeId=${employeeId}`, undefined, token);
  return history.body.balance;
}

async function dayStatus(page: Page, token: string, employeeId: number, d: string): Promise<string> {
  const ctx = await api(
    page,
    "GET",
    `/api/attendance/edit-context?employeeId=${employeeId}&date=${d}`,
    undefined,
    token,
  );
  expect(ctx.status, JSON.stringify(ctx.body)).toBe(200);
  return ctx.body.day.status as string;
}

test("Deduct days: detect the absent and on-leave days, and only the picked dates become Casual Leave", async ({
  page,
}) => {
  await loginAsHr(page);
  const token = await adminToken(page);
  const branches = (await api(page, "GET", "/api/branches", undefined, token)).body as { id: number }[];
  const created = await api(
    page,
    "POST",
    "/api/employees",
    {
      employeeCode: "CF-ABS",
      firstName: "Kavya",
      lastName: "Absent",
      phone: "9000000088",
      employmentType: "staff",
      branchId: branches[0].id,
      salaryType: "monthly",
      salaryAmount: 24000,
      joinDate: "2024-01-01",
    },
    token,
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const kavya = created.body.id as number;
  made.employee = kavya;
  // an approved sick leave on 9 October, and no punches on 5-8 October: the engine marks those days once it looks at them
  const leave = await api(
    page,
    "POST",
    "/api/leave-requests",
    {
      employeeId: kavya,
      startDate: "2026-10-09",
      endDate: "2026-10-09",
      type: "sick",
      reason: "fever",
      reasonCategory: "sick",
    },
    token,
  );
  expect(leave.status, JSON.stringify(leave.body)).toBe(201);
  made.leave = leave.body.id;
  await api(page, "PATCH", `/api/leave-requests/${made.leave}/status`, { status: "approved" }, token);
  const absentDays = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"];
  for (const d of absentDays) expect(await dayStatus(page, token, kavya, d)).toBe("absent");
  expect(await dayStatus(page, token, kavya, "2026-10-09")).toBe("on_leave");
  expect(await left(page, token, kavya)).toMatchObject({ total: 12, remaining: 12 });

  await page.goto("/hr/casual-leave?tab=carry-forward");
  await page.getByTestId("cf-balances-search").fill("CF-ABS");
  await expect(page.getByTestId(`cf-left-${kavya}`)).toContainText("12 of 12");
  await page.getByTestId(`cf-assign-${kavya}`).click();
  const dialog = page.getByTestId("cf-dialog");
  await expect(dialog).toContainText("Deduct days · Kavya Absent");
  await expect(dialog).not.toContainText("Add days");
  await expect(page.getByTestId("cf-idle")).toBeVisible();

  // 1) the most days; 2) the detection runs (this month first, nothing there), then October
  await page.getByTestId("cf-days").fill("3");
  await expect(page.getByTestId("cf-detecting")).toContainText("Detecting attendance");
  await expect(page.getByTestId(`cf-none-${kavya}`)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("cf-month-prev").click();
  await expect(page.getByTestId("cf-month")).toHaveText("October 2026");
  await expect(page.getByTestId("cf-detecting")).toBeVisible();
  await expect(page.getByTestId(`cf-result-${kavya}`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId(`cf-count-absent-${kavya}`)).toContainText("4");
  await expect(page.getByTestId(`cf-count-leave-${kavya}`)).toContainText("1");
  await expect(page.getByTestId(`cf-absent-${kavya}`)).toContainText(
    "These are the dates on which Kavya Absent was marked Absent",
  );
  await expect(page.getByTestId(`cf-onleave-${kavya}`)).toContainText("Fri 9 Oct · Sick Leave");
  await expect(page.getByTestId(`cf-result-${kavya}`)).toContainText(
    "Please select the dates you want to convert into Casual Leave (up to 3).",
  );

  // pick an absent day from the list and the leave day from the calendar
  await page.getByTestId(`cf-date-${kavya}-2026-10-05`).click();
  await page.getByTestId(`cf-cal-${kavya}-2026-10-09`).click();
  await expect(page.getByTestId(`cf-picked-${kavya}`)).toHaveText("2 of 3 picked");
  await expect(page.getByTestId("cf-preview")).toContainText("of 12 left");
  await page.getByTestId("cf-reason").fill("Absent days covered by unused Casual Leave");
  await expect(page.getByTestId("cf-save")).toHaveText("Assign CL to 2 dates");
  await page.getByTestId("cf-save").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId(`cf-left-${kavya}`)).toContainText("10 of 12");

  // exactly the two picked dates are approved Casual Leave and paid present days; the rest stay as they were
  expect(await left(page, token, kavya)).toMatchObject({ total: 12, remaining: 10 });
  const cls = (await api(page, "GET", `/api/casual-leaves?employeeId=${kavya}`, undefined, token)).body as {
    date: string;
    status: string;
  }[];
  expect(cls.map((c) => [c.date, c.status]).sort()).toEqual([
    ["2026-10-05", "approved"],
    ["2026-10-09", "approved"],
  ]);
  expect(await dayStatus(page, token, kavya, "2026-10-05")).toBe("present");
  expect(await dayStatus(page, token, kavya, "2026-10-09")).toBe("present");
  expect(await dayStatus(page, token, kavya, "2026-10-06")).toBe("absent");

  // the log keeps the round with its dates
  await page.getByRole("tab", { name: /Change log/ }).click();
  await expect(page.getByTestId("cf-log")).toContainText("Absent days covered by unused Casual Leave");
  await expect(page.getByTestId("cf-log")).toContainText("Mon 5 Oct");
  await expect(page.getByTestId("cf-log")).toContainText("Fri 9 Oct");

  // the server never adds days, never takes more dates than the number, nor a day that already has Casual Leave
  const add = await api(
    page,
    "POST",
    "/api/casual-leaves/adjustments",
    { reason: "e2e: add", items: [{ employeeId: kavya, days: 3 }] },
    token,
  );
  expect(add.status).toBe(405);
  const tooMany = await api(
    page,
    "POST",
    "/api/casual-leaves/assign",
    { reason: "e2e: too many", items: [{ employeeId: kavya, limit: 1, dates: ["2026-10-06", "2026-10-08"] }] },
    token,
  );
  expect(tooMany.status).toBe(400);
  const notOpen = await api(
    page,
    "POST",
    "/api/casual-leaves/assign",
    { reason: "e2e: already CL", items: [{ employeeId: kavya, limit: 1, dates: ["2026-10-05"] }] },
    token,
  );
  expect(notOpen.status).toBe(400);
  expect(await left(page, token, kavya)).toMatchObject({ total: 12, remaining: 10 });
});

test("a view-only login sees the balances and the log but cannot give Casual Leave", async ({ page }) => {
  await loginAsHr(page);
  const token = await adminToken(page);
  const list = (await api(page, "GET", "/api/employees?search=E2E00", undefined, token)).body as {
    id: number;
    employeeCode: string;
  }[];
  const asha = list.find((e) => e.employeeCode === "E2E001")!.id;
  const role = await api(
    page,
    "POST",
    "/api/roles",
    {
      name: "e2e CL viewer",
      description: "Reads Casual Leave",
      permissions: { dashboard: "view", casual_leave: "view" },
    },
    token,
  );
  expect(role.status, JSON.stringify(role.body)).toBeLessThan(300);
  made.role = role.body.id;
  const user = await api(
    page,
    "POST",
    "/api/hr-users",
    { username: VIEWER.username, password: VIEWER.password, fullName: "CL Viewer", roleId: made.role },
    token,
  );
  expect(user.status, JSON.stringify(user.body)).toBeLessThan(300);
  made.user = user.body.id;

  await page.evaluate(() => localStorage.clear());
  await page.goto("/hr-login");
  await page.getByTestId("input-username").fill(VIEWER.username);
  await page.getByTestId("input-password").fill(VIEWER.password);
  await page.getByTestId("button-submit").click();
  await expect(page).toHaveURL(/\/hr\//);

  await page.goto("/hr/casual-leave?tab=carry-forward");
  await expect(page.getByTestId(`cf-row-${asha}`)).toBeVisible();
  await expect(page.getByTestId(`cf-assign-${asha}`)).toBeDisabled();
  await expect(page.getByTestId(`cf-history-${asha}`)).toBeEnabled();
  await page.getByRole("tab", { name: /Change log/ }).click();
  await expect(page.getByTestId("cf-log")).toBeVisible();
  const viewerToken = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const assign = await api(
    page,
    "POST",
    "/api/casual-leaves/assign",
    { reason: "not allowed", items: [{ employeeId: asha, limit: 1, dates: ["2026-10-05"] }] },
    viewerToken!,
  );
  expect(assign.status).toBe(403);
});
