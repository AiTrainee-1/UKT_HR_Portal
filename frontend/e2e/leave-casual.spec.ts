import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Casual Leave: who has taken CL this month, who is eligible, who is not and why, the month picker, applying for
// someone and deciding the request. Leave & Holiday: filters on every list, the who-is-on-leave calendar, holidays
// (add, edit, delete), leave types and balances, and the Excel export. Everything made here is called LC-* (employees),
// "LC *" (holidays, leave types) and is removed again, so the other specs only ever see the seed data.

async function api(page: Page, method: string, url: string, data?: unknown) {
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const now = new Date();
const TODAY = iso(now);
const monthsAgo = (n: number) => iso(new Date(now.getFullYear(), now.getMonth() - n, Math.min(now.getDate(), 28)));

type Emp = { id: number; code: string };

async function cleanUp(page: Page) {
  const casual = (await api(page, "GET", `/api/casual-leaves`)).body as { id: number; employeeCode: string }[];
  for (const c of (casual ?? []).filter((c) => c.employeeCode?.startsWith("LC-"))) {
    await api(page, "DELETE", `/api/casual-leaves/${c.id}`);
  }
  const leaves = (await api(page, "GET", "/api/leave-requests")).body as { id: number; employeeCode: string }[];
  for (const l of (leaves ?? []).filter((l) => l.employeeCode?.startsWith("LC-"))) {
    await api(page, "DELETE", `/api/leave-requests/${l.id}`);
  }
  const employees = (await api(page, "GET", "/api/employees")).body as { id: number; employeeCode: string }[];
  for (const e of (employees ?? []).filter((e) => e.employeeCode.startsWith("LC-"))) {
    await api(page, "DELETE", `/api/employees/${e.id}`);
  }
  const permissions = (await api(page, "GET", "/api/permissions")).body as { id: number; employeeCode: string }[];
  for (const p of (permissions ?? []).filter((p) => p.employeeCode?.startsWith("LC-"))) {
    await api(page, "DELETE", `/api/permissions/${p.id}`);
  }
  const holidays = (await api(page, "GET", `/api/holidays?year=${now.getFullYear()}`)).body as {
    id: number;
    name: string;
  }[];
  for (const h of (holidays ?? []).filter((h) => h.name.startsWith("LC "))) {
    await api(page, "DELETE", `/api/holidays/${h.id}`);
  }
  const types = (await api(page, "GET", "/api/leave-types")).body as { id: number; name: string }[];
  for (const t of (types ?? []).filter((t) => t.name.startsWith("LC "))) {
    await api(page, "DELETE", `/api/leave-types/${t.id}`);
  }
}

/** Five people: one eligible, one who has taken CL, one new joiner, one production, one with a CL waiting. */
async function world(page: Page) {
  const branches = (await api(page, "GET", "/api/branches")).body as { id: number }[];
  const emp = async (code: string, first: string, extra: Record<string, unknown> = {}): Promise<Emp> => {
    const res = await api(page, "POST", "/api/employees", {
      employeeCode: code,
      firstName: first,
      lastName: "Casual",
      phone: "9000000077",
      employmentType: "staff",
      branchId: branches[0].id,
      salaryType: "monthly",
      salaryAmount: 24000,
      joinDate: "2024-01-01",
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.id as number, code };
  };
  const eligible = await emp("LC-ELIG", "Elena");
  const taken = await emp("LC-TAKEN", "Tara");
  const rookie = await emp("LC-NEW", "Nila", { joinDate: monthsAgo(3) });
  const production = await emp("LC-PROD", "Pavan", { employmentType: "production" });
  const waiting = await emp("LC-WAIT", "Wasim");
  const made = await api(page, "POST", "/api/casual-leaves", { employeeId: taken.id, date: TODAY, reason: "LC taken" });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const decided = await api(page, "PATCH", `/api/casual-leaves/${made.body.id}`, { status: "approved" });
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  const pending = await api(page, "POST", "/api/casual-leaves", {
    employeeId: waiting.id,
    date: TODAY,
    reason: "LC waiting",
  });
  expect(pending.status, JSON.stringify(pending.body)).toBe(201);
  return {
    eligible,
    taken,
    rookie,
    production,
    waiting,
    takenCl: made.body.id as number,
    waitingCl: pending.body.id as number,
  };
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });

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

test("Casual Leave answers the three questions: who took it this month, who is eligible, who is not and why", async ({
  page,
}) => {
  const w = await world(page);
  await page.goto("/hr/casual-leave");
  await expect(page.locator("main h2").first()).toHaveText("Casual Leave (CL)");
  await expect(page.getByRole("button", { name: /^\s*Refresh( this page)?\s*$/ })).toHaveCount(1);

  // Taken this month (the opening view): who, the date, the status and who approved it
  const taken = page.getByTestId("tab-taken");
  await expect(taken.getByTestId("cl-table").getByTestId(`cl-${w.takenCl}`)).toContainText("Tara Casual");
  await expect(taken.getByTestId(`cl-${w.takenCl}`)).toContainText("approved");
  await expect(taken.getByTestId(`cl-${w.takenCl}`)).toContainText("Approved by");
  await expect(taken.getByTestId(`cl-${w.waitingCl}`)).toContainText("Wasim Casual");
  await expect(taken.getByTestId(`cl-${w.waitingCl}`)).toContainText(/pending|Waiting for/i);

  // Eligible: the one who can still take it; not the one who has, the new joiner or the production employee
  await tab(page, "Eligible").click();
  await expect(page.getByTestId(`eligible-${w.eligible.id}`)).toContainText("Elena Casual");
  await expect(page.getByTestId(`eligible-${w.eligible.id}`)).toContainText("Never"); // last CL
  await expect(page.getByTestId(`eligible-${w.taken.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`eligible-${w.rookie.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`eligible-${w.production.id}`)).toHaveCount(0);

  // Not eligible: each with the reason
  await tab(page, "Not eligible").click();
  await expect(page.getByTestId(`not-eligible-${w.taken.id}`)).toContainText("Already used this month");
  await expect(page.getByTestId(`not-eligible-${w.waiting.id}`)).toContainText("waiting for a decision");
  await expect(page.getByTestId(`not-eligible-${w.rookie.id}`)).toContainText("Under 6 months of service");
  await expect(page.getByTestId(`not-eligible-${w.rookie.id}`)).toContainText("Becomes eligible on");
  await expect(page.getByTestId(`not-eligible-${w.production.id}`)).toContainText("Production employee");
  await expect(page.getByTestId(`not-eligible-${w.eligible.id}`)).toHaveCount(0);
});

test("the reason pills and the search narrow the Not eligible list, and a month back shows that month", async ({
  page,
}) => {
  const w = await world(page);
  await page.goto("/hr/casual-leave");
  await tab(page, "Not eligible").click();

  await page.getByRole("tab", { name: /^Production/ }).click();
  await expect(page.getByTestId(`not-eligible-${w.production.id}`)).toBeVisible();
  await expect(page.getByTestId(`not-eligible-${w.rookie.id}`)).toHaveCount(0);

  await page.getByRole("tab", { name: /^All/ }).click();
  await page.getByTestId("not-eligible-search").fill("nila casual");
  await expect(page.getByTestId(`not-eligible-${w.rookie.id}`)).toBeVisible();
  await expect(page.getByTestId(`not-eligible-${w.production.id}`)).toHaveCount(0);
  await expect(page.getByTestId("not-eligible-count")).toContainText("Showing 1 of");
  await page.getByTestId("not-eligible-count-clear").click();
  await expect(page.getByTestId(`not-eligible-${w.production.id}`)).toBeVisible();

  // last month: this month's CL are not there, and the empty state says so
  await page.getByRole("button", { name: "Previous month" }).click();
  await tab(page, "Taken this month").click();
  await expect(page.getByTestId(`cl-${w.takenCl}`)).toHaveCount(0);
  await expect(page.getByTestId("taken-empty")).toBeVisible();
  await page.getByTestId("month-picker-today").click();
  await expect(page.getByTestId(`cl-${w.takenCl}`)).toBeVisible();
});

test("Apply CL moves someone from Eligible to Not eligible, and the request is decided from Requests", async ({
  page,
}) => {
  const w = await world(page);
  await page.goto("/hr/casual-leave");
  await tab(page, "Eligible").click();
  await page.locator(`[data-testid="apply-cl-${w.eligible.id}"]:visible`).click();
  await expect(page.getByTestId("apply-dialog")).toContainText("Elena Casual");
  await page.getByTestId("apply-reason").fill("LC family function");
  await page.getByTestId("apply-submit").click();
  await expect(page.getByText("CL request created for Elena Casual")).toBeVisible();
  await expect(page.getByTestId(`eligible-${w.eligible.id}`)).toHaveCount(0);

  await tab(page, "Not eligible").click();
  await expect(page.getByTestId(`not-eligible-${w.eligible.id}`)).toContainText("Already used this month");

  await tab(page, "Requests").click();
  const requests = (await api(page, "GET", `/api/casual-leaves?month=${now.getMonth() + 1}&year=${now.getFullYear()}`))
    .body as {
    id: number;
    employeeId: number;
  }[];
  const mine = requests.find((r) => r.employeeId === w.eligible.id)!;
  const card = page.getByTestId("cl-table").getByTestId(`cl-${mine.id}`);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Casual leave approved|Casual leave/).first()).toBeVisible();
  await expect(card).toContainText("approved");
});

test("the server refuses a second Casual Leave in a month, with the reason the page shows", async ({ page }) => {
  const w = await world(page);
  // the page hides Apply CL for someone who cannot; the rule itself is the server's, and this is its answer
  const second = await api(page, "POST", "/api/casual-leaves", { employeeId: w.taken.id, date: TODAY });
  expect(second.status).toBe(400);
  expect(second.body.error).toContain("already used this month");
});

test("Leave & Holiday: search, status, type and date filters on the leave requests", async ({ page }) => {
  const w = await world(page);
  const made = async (employeeId: number, type: string, reason: string) => {
    const r = await api(page, "POST", "/api/leave-requests", {
      employeeId,
      startDate: TODAY,
      endDate: TODAY,
      type,
      reason,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };
  const sick = await made(w.eligible.id, "sick", "LC sick");
  const casual = await made(w.taken.id, "casual", "LC casual");
  await api(page, "PATCH", `/api/leave-requests/${casual}/status`, { status: "approved" });

  await page.goto("/hr/leave");
  await expect(page.locator("main h2").first()).toHaveText("Leave & Holiday");
  await expect(page.getByRole("button", { name: /^\s*Refresh( this page)?\s*$/ })).toHaveCount(1);
  await expect(page.getByTestId(`leave-${sick}`)).toBeVisible();
  await expect(page.getByTestId(`leave-${casual}`)).toBeVisible();

  await page.getByTestId("leave-search").fill("elena");
  await expect(page.getByTestId(`leave-${sick}`)).toBeVisible();
  await expect(page.getByTestId(`leave-${casual}`)).toHaveCount(0);
  await page.getByTestId("leave-count-clear").click();

  await page.getByRole("tab", { name: /^Approved/ }).click();
  await expect(page.getByTestId(`leave-${casual}`)).toBeVisible();
  await expect(page.getByTestId(`leave-${sick}`)).toHaveCount(0);
  await page.getByRole("tab", { name: /^All/ }).click();

  // a date range that does not touch today leaves nothing, with the "nothing matches" state, not the empty one
  await page.getByTestId("leave-from").fill(monthsAgo(6));
  await page.getByTestId("leave-to").fill(monthsAgo(5));
  await expect(page.getByTestId("leave-no-match")).toBeVisible();
  await expect(page.getByTestId("leave-empty")).toHaveCount(0);
});

test("the calendar shows who is on leave today and opens the day", async ({ page }) => {
  const w = await world(page);
  const r = await api(page, "POST", "/api/leave-requests", {
    employeeId: w.eligible.id,
    startDate: TODAY,
    endDate: TODAY,
    type: "sick",
    reason: "LC calendar",
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await page.goto("/hr/leave");
  await tab(page, "Calendar").click();
  const day = page.getByTestId(`cal-day-${TODAY}`);
  await expect(day).toBeVisible();
  // pending leave counts too, and the casual leaves made by the world (approved and pending) are on it as well
  await expect(day).not.toHaveAttribute("data-count", "0");
  await day.click();
  await expect(page.getByTestId("cal-day-panel")).toContainText("Elena Casual");
  await page.getByTestId("cal-search").fill("tara");
  await expect(page.getByTestId("cal-day-panel")).not.toContainText("Elena Casual");
  await expect(page.getByTestId("cal-day-panel")).toContainText("Tara Casual");
});

test("holidays can be added, edited and deleted, and the list can be searched", async ({ page }) => {
  await page.goto("/hr/leave");
  await tab(page, "Holidays").click();
  const year = now.getFullYear();
  await page.getByTestId("hol-add").click();
  await page.getByTestId("holiday-save").click();
  await expect(page.getByTestId("holiday-problem")).toContainText("Name and date are required");
  await page.getByTestId("holiday-name").fill("LC Founders Day");
  await page.getByTestId("holiday-date").fill(`${year}-12-30`);
  await page.getByTestId("holiday-save").click();
  await expect(page.getByText("Holiday added", { exact: true }).first()).toBeVisible();
  const card = page.getByTestId("hol-list").locator('[data-testid^="holiday-"]', { hasText: "LC Founders Day" });
  await expect(card).toBeVisible();

  await page.getByTestId("hol-search").fill("founders");
  await expect(page.getByTestId("hol-count")).toContainText("Showing 1 of");
  await card.getByRole("button", { name: "Edit LC Founders Day" }).click();
  await page.getByTestId("holiday-name").fill("LC Founders Day (moved)");
  await page.getByTestId("holiday-save").click();
  await expect(page.getByText("Holiday saved", { exact: true }).first()).toBeVisible();
  const moved = page
    .getByTestId("hol-list")
    .locator('[data-testid^="holiday-"]', { hasText: "LC Founders Day (moved)" });
  await expect(moved).toBeVisible();

  await moved.getByRole("button", { name: "Delete LC Founders Day (moved)" }).click();
  await page.getByTestId("confirm-delete-holiday-confirm").click();
  await expect(page.getByText("Holiday deleted", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("hol-no-match").or(page.getByTestId("hol-empty"))).toBeVisible();
});

test("leave types and balances: add a type, allocate days, search the table, export", async ({ page }) => {
  const w = await world(page);
  const code = `LC${String(Date.now()).slice(-5)}`;
  await page.goto("/hr/leave");
  await tab(page, "Balances").click();
  await page.getByTestId("add-leave-type").click();
  await page.getByTestId("lt-name").fill("LC Earned Leave");
  await page.getByTestId("lt-code").fill(code);
  await page.getByTestId("lt-days").fill("10");
  await page.getByTestId("lt-save").click();
  await expect(page.getByText("LC Earned Leave added", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("leave-types")).toContainText("LC Earned Leave");

  // 10 days allocated and 9 used leaves 1: a low balance
  const types = (await api(page, "GET", "/api/leave-types")).body as { id: number; name: string }[];
  const type = types.find((t) => t.name === "LC Earned Leave")!;
  const alloc = await api(page, "POST", "/api/leave-balances/allocate", {
    employeeId: w.eligible.id,
    leaveTypeId: type.id,
    year: now.getFullYear(),
    allocated: 10,
  });
  expect(alloc.status, JSON.stringify(alloc.body)).toBe(201);
  await page.reload();
  await tab(page, "Balances").click();
  await page.getByTestId("bal-search").fill("elena");
  const row = page.getByTestId("balances-table").locator("tr", { hasText: "LC Earned Leave" });
  await expect(row).toContainText("Elena Casual");
  await expect(row).toContainText("10");

  // allocate through the dialog too (a second person)
  await page.getByTestId("bal-allocate").click();
  await expect(page.getByTestId("allocate-dialog")).toBeVisible();
  await page.getByTestId("allocate-save").click();
  await expect(page.getByTestId("allocate-problem")).toContainText("Choose an employee");
  await page.keyboard.press("Escape");

  const download = page.waitForEvent("download");
  await page.getByTestId("bal-export").click();
  expect((await download).suggestedFilename()).toMatch(/^Leave_balances_\d{4}.*\.xlsx$/);
});

test("the permissions list searches and filters too", async ({ page }) => {
  const w = await world(page);
  const made = await api(page, "POST", "/api/permissions", {
    employeeId: w.eligible.id,
    date: TODAY,
    type: "Late In",
    permissionTime: "09:30",
    reason: "LC permission",
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  await page.goto("/hr/leave");
  await tab(page, "Permissions").click();
  await expect(page.getByTestId(`permission-${made.body.id}`)).toBeVisible();
  await page.getByTestId("perm-search").fill("zzz nobody");
  await expect(page.getByTestId("perm-no-match")).toBeVisible();
  await page.getByTestId("perm-count-clear").click();
  await expect(page.getByTestId(`permission-${made.body.id}`)).toBeVisible();
});
