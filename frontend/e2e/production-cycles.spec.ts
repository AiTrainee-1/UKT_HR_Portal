import { expect, test, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// Production pay cycles: Weekly (7 days), BiWeekly (14 days) and Monthly (28 days, four weeks). Production employees
// are assigned to ONE cycle on Employees > Production Employees; each cycle has its own Production Payroll page that
// pays only the people assigned to it, can pay one employee at a time and never overwrites payroll that exists.
// Periods are fixed in February 2026 (every cycle starts Monday 2 Feb) so the dates never depend on today. Every
// employee made here has a code starting PC- and is removed again, so other specs see the seed data only.

const WEEK1 = { periodStart: "2026-02-02", periodEnd: "2026-02-08" };
const FORTNIGHT1 = { periodStart: "2026-02-02", periodEnd: "2026-02-15" };

type Reply = { status: number; body: any };

// The token comes from the login API, not from the page: a page that is still navigating after the UI login would
// make page.evaluate fail with "Execution context was destroyed".
const tokens = new Map<string, string>();

async function tokenOf(page: Page, username: string, password: string): Promise<string> {
  const known = tokens.get(username);
  if (known) return known;
  const res = await page.request.post("/api/auth/hr-login", { data: { username, password } });
  const token = (await res.json()).token as string;
  tokens.set(username, token);
  return token;
}

async function api(page: Page, method: string, url: string, data?: unknown, bearer?: string): Promise<Reply> {
  const token = bearer ?? (await tokenOf(page, HR_USERNAME, HR_PASSWORD));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function testEmployees(page: Page) {
  const list = (await api(page, "GET", "/api/employees?employmentType=production")).body as {
    id: number;
    employeeCode: string;
    productionPayCycle: string | null;
  }[];
  return list.filter((e) => e.employeeCode.startsWith("PC-"));
}

async function removeTestEmployees(page: Page) {
  for (const e of await testEmployees(page)) await api(page, "DELETE", `/api/employees/${e.id}`);
}

async function makeWorker(page: Page, code: string, first: string, perShift: number | null) {
  const branches = (await api(page, "GET", "/api/branches")).body as { id: number }[];
  const res = await api(page, "POST", "/api/employees", {
    employeeCode: code,
    firstName: first,
    lastName: "Worker",
    phone: "9000000077",
    employmentType: "production",
    branchId: branches[0].id,
    salaryType: "monthly",
    ...(perShift ? { salaryPerShift: perShift } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function setCycles(page: Page, monthlyStart: string | null) {
  const res = await api(page, "PUT", "/api/payroll-settings", {
    prodCycles: {
      weekly: { weekStart: "monday", anchorDate: null },
      biweekly: { weekStart: "monday", anchorDate: "2026-02-02" },
      monthly: { weekStart: "monday", anchorDate: monthlyStart },
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function cycleOf(page: Page, code: string) {
  return (await testEmployees(page)).find((e) => e.employeeCode === code)?.productionPayCycle ?? null;
}

async function payrollRows(page: Page, cycle: string, period = WEEK1) {
  return (
    await api(
      page,
      "GET",
      `/api/payroll/production?cycle=${cycle}&periodStart=${period.periodStart}&periodEnd=${period.periodEnd}`,
    )
  ).body as { employeeCode: string; status: string; payCycle: string }[];
}

/** Opens the period holding `date` on a cycle page, whichever tab is showing. */
async function openPeriodHolding(page: Page, date: string, label: RegExp) {
  await page.getByTestId("pcp-period-date").fill(date);
  await expect(page.getByTestId("pcp-period")).toContainText(label, { timeout: 15_000 });
}

/** A tab of the Production Employees page. The tab row draws each label twice (its animation), so the role is the reliable handle. */
const peTab = (page: Page, label: "All" | "Weekly" | "BiWeekly" | "Monthly" | "Unassigned") =>
  page.getByRole("tab", { name: new RegExp(`^${label}\\b`) });

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, testInfo) => {
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  await removeTestEmployees(page);
  await setCycles(page, "2026-02-02");
  await makeWorker(page, "PC-W1", "Asha", 500);
  await makeWorker(page, "PC-W2", "Bala", 500);
  await makeWorker(page, "PC-B1", "Chitra", 500);
  await makeWorker(page, "PC-U1", "Deepa", 500);
  await makeWorker(page, "PC-N1", "Esha", null);
  await page.close();
});

test.afterAll(async ({ browser }, testInfo) => {
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  await removeTestEmployees(page);
  // back to the shipped defaults: Monday weeks and no first-period dates
  await api(page, "PUT", "/api/payroll-settings", {
    prodCycles: {
      weekly: { weekStart: "monday", anchorDate: null },
      biweekly: { weekStart: "monday", anchorDate: null },
      monthly: { weekStart: "monday", anchorDate: null },
    },
  });
  await page.close();
});

test("the sidebar offers Production Payroll > Weekly, BiWeekly, Monthly and Employees > Production Employees", async ({
  page,
}) => {
  await loginAsHr(page);
  const nav = page.locator("nav");
  await nav.getByText("Production Payroll", { exact: true }).click();
  for (const name of ["Weekly", "BiWeekly", "Monthly"]) {
    await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  }
  await nav.getByText("Employees", { exact: true }).first().click();
  await expect(nav.getByRole("link", { name: "Production Employees" })).toBeVisible();

  await nav.getByRole("link", { name: "BiWeekly", exact: true }).click();
  await expect(page).toHaveURL(/\/hr\/production-payroll\/biweekly$/);
  await expect(page.getByTestId("production-payroll-biweekly")).toBeVisible();
  await expect(page.getByTestId("pcp-cycle-badge")).toHaveText("BiWeekly");
});

test("the old Production Payroll address opens Weekly", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/production-payroll");
  await expect(page).toHaveURL(/\/hr\/production-payroll\/weekly$/);
  await expect(page.getByTestId("production-payroll-weekly")).toBeVisible();
});

test("Production Employees lists only production employees, and the new ones are unassigned", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/employees/productionEmployee");
  await expect(page.getByTestId("production-employees-page")).toBeVisible();

  await peTab(page, "All").click();
  await page.getByTestId("pe-search").fill("PC-");
  for (const code of ["PC-W1", "PC-W2", "PC-B1", "PC-U1", "PC-N1"]) {
    await expect(page.getByTestId(`pe-row-${code}`)).toBeVisible();
  }
  // a staff employee is never listed
  await page.getByTestId("pe-search").fill("E2E001");
  await expect(page.getByTestId("pe-row-E2E001")).toHaveCount(0);

  await page.getByTestId("pe-search").fill("PC-");
  await peTab(page, "Unassigned").click();
  await expect(page.getByTestId("pe-row-PC-U1")).toBeVisible();
  await expect(page.getByTestId("pe-row-PC-U1")).toContainText(/not assigned/i);
  await expect(page.getByTestId("pe-stat-unassigned")).toBeVisible();
});

test("employees are assigned to a cycle one at a time and in bulk", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/employees/productionEmployee");
  await peTab(page, "Unassigned").click();
  await page.getByTestId("pe-search").fill("PC-");

  // bulk: two people to Weekly
  await page.getByTestId("pe-select-PC-W1").check();
  await page.getByTestId("pe-select-PC-W2").check();
  await expect(page.getByTestId("pe-bulk-bar")).toBeVisible();
  await page.getByTestId("pe-bulk-weekly").click();
  await expect.poll(() => cycleOf(page, "PC-W1")).toBe("weekly");
  await expect.poll(() => cycleOf(page, "PC-W2")).toBe("weekly");

  // one at a time: from the row's own menu
  await page.getByTestId("pe-row-assign-PC-B1").click();
  await page.getByTestId("pe-row-assign-PC-B1-biweekly").click();
  await expect.poll(() => cycleOf(page, "PC-B1")).toBe("biweekly");

  // the blocked-by-rate employee goes to Weekly too, to show why payroll cannot be generated for them
  await page.getByTestId("pe-select-PC-N1").check();
  await page.getByTestId("pe-bulk-weekly").click();
  await expect.poll(() => cycleOf(page, "PC-N1")).toBe("weekly");

  // the tabs follow
  await peTab(page, "Weekly").click();
  await expect(page.getByTestId("pe-row-PC-W1")).toBeVisible();
  await expect(page.getByTestId("pe-row-PC-W2")).toBeVisible();
  await expect(page.getByTestId("pe-row-PC-B1")).toHaveCount(0);
  await peTab(page, "BiWeekly").click();
  await expect(page.getByTestId("pe-row-PC-B1")).toBeVisible();
  await peTab(page, "Unassigned").click();
  await expect(page.getByTestId("pe-row-PC-U1")).toBeVisible();
  await expect(page.getByTestId("pe-row-PC-W1")).toHaveCount(0);
});

test("moving someone to another cycle asks first and can be undone", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/employees/productionEmployee");
  await peTab(page, "Weekly").click();
  await page.getByTestId("pe-search").fill("PC-W2");
  await page.getByTestId("pe-select-PC-W2").check();
  await page.getByTestId("pe-bulk-biweekly").click();
  await expect(page.getByRole("alertdialog")).toContainText(/Move 1 employee from Weekly to BiWeekly/i);
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /cancel/i })
    .click();
  expect(await cycleOf(page, "PC-W2")).toBe("weekly");

  await page.getByTestId("pe-bulk-biweekly").click();
  await page.getByTestId("pe-confirm").click();
  await expect.poll(() => cycleOf(page, "PC-W2")).toBe("biweekly");

  // and back
  await peTab(page, "BiWeekly").click();
  await page.getByTestId("pe-select-PC-W2").check();
  await page.getByTestId("pe-bulk-weekly").click();
  await page.getByTestId("pe-confirm").click();
  await expect.poll(() => cycleOf(page, "PC-W2")).toBe("weekly");
});

test("the Weekly page shows only the people on the Weekly cycle", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/production-payroll/weekly");
  await page.getByRole("tab", { name: /^Employees/ }).click();
  await openPeriodHolding(page, "2026-02-04", /2 Feb - 8 Feb 2026/);

  await expect(page.getByTestId("pcp-roster-row-PC-W1")).toBeVisible();
  await expect(page.getByTestId("pcp-roster-row-PC-W2")).toBeVisible();
  await expect(page.getByTestId("pcp-roster-row-PC-N1")).toBeVisible();
  for (const other of ["PC-B1", "PC-U1", "E2E001"]) {
    await expect(page.getByTestId(`pcp-roster-row-${other}`)).toHaveCount(0);
  }
  await expect(page.getByTestId("pcp-roster-counts")).toContainText("3 on the Weekly cycle");
  // an employee with no rate per shift is shown as blocked, with the reason
  await expect(page.getByTestId("pcp-roster-state-PC-N1")).toHaveText(/cannot be generated/i);
  await expect(page.getByTestId("pcp-roster-row-PC-N1")).toContainText("No Salary Per Shift");
});

test("one employee can be generated on their own, and only that one", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/production-payroll/weekly");
  await page.getByRole("tab", { name: /^Employees/ }).click();
  await openPeriodHolding(page, "2026-02-04", /2 Feb - 8 Feb 2026/);

  await page.getByTestId("pcp-generate-PC-W1").click();
  await expect(page.getByTestId("pcp-roster-state-PC-W1")).toHaveText(/generated - pending/i, { timeout: 30_000 });
  await expect(page.getByTestId("pcp-roster-state-PC-W2")).toHaveText(/not generated/i);

  const rows = await payrollRows(page, "weekly");
  expect(rows.map((r) => r.employeeCode)).toEqual(["PC-W1"]);
  expect(rows[0].payCycle).toBe("weekly");
});

test("Generate Payroll pays the rest of the cycle and leaves existing payroll alone", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/production-payroll/weekly");
  await openPeriodHolding(page, "2026-02-04", /2 Feb - 8 Feb 2026/);

  await page.getByTestId("pcp-generate-open").click();
  const dialog = page.getByTestId("pcp-generate-dialog");
  await expect(dialog).toContainText("Weekly");
  await expect(dialog).toContainText("2 Feb - 8 Feb 2026");
  await expect(dialog).toContainText(/1 employee already has payroll/);
  await expect(dialog).toContainText(/cannot be generated/);
  await expect(page.getByTestId("pcp-generate-ready")).toHaveText("1 employee");
  await page.getByTestId("pcp-generate-confirm").click();

  await expect
    .poll(async () => (await payrollRows(page, "weekly")).map((r) => r.employeeCode).sort())
    .toEqual(["PC-W1", "PC-W2"]);
  await expect(page.getByTestId("pcp-rows")).toContainText("Bala Worker", { timeout: 30_000 });
  await expect(page.getByTestId("pcp-rows")).toContainText("Asha Worker");

  // another cycle's page shows none of it
  expect(await payrollRows(page, "biweekly")).toEqual([]);
  expect((await payrollRows(page, "biweekly", FORTNIGHT1)).map((r) => r.employeeCode)).toEqual([]);
});

test("Skipped Employees explains who cannot be paid and writes nothing", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/production-payroll/weekly");
  await openPeriodHolding(page, "2026-02-04", /2 Feb - 8 Feb 2026/);
  await page.getByTestId("pcp-skipped-open").click();
  const dialog = page.getByTestId("pcp-skipped-dialog");
  await expect(dialog).toContainText("Esha Worker", { timeout: 60_000 });
  await expect(dialog).toContainText(/No Salary Per Shift/);
  await expect(dialog).toContainText(/2 already have payroll/);
  await page.keyboard.press("Escape");
  expect(await payrollRows(page, "weekly")).toHaveLength(2);
});

test("a paid payslip is never recomputed, a pending one only when asked", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/production-payroll/weekly");
  await page.getByRole("tab", { name: /^Employees/ }).click();
  await openPeriodHolding(page, "2026-02-04", /2 Feb - 8 Feb 2026/);

  // pending: "Generate again" asks first
  await page.getByTestId("pcp-regenerate-PC-W2").click();
  await expect(page.getByTestId("pcp-regenerate-dialog")).toContainText(/recomputes the payslip/i);
  await page.getByTestId("pcp-regenerate-confirm").click();
  await expect(page.getByTestId("pcp-roster-state-PC-W2")).toHaveText(/generated - pending/i);

  // mark one paid on the Payroll tab
  await page.getByRole("tab", { name: /^Payroll/ }).click();
  const run = page
    .getByTestId("pcp-rows")
    .locator("div")
    .filter({ hasText: "Bala Worker" })
    .filter({ hasText: "Mark Paid" })
    .last();
  await run.getByRole("button", { name: /mark paid/i }).click();
  await expect
    .poll(async () => (await payrollRows(page, "weekly")).find((r) => r.employeeCode === "PC-W2")?.status)
    .toBe("paid");

  // paid: no "Generate again" any more, and the API refuses to recompute it
  await page.getByRole("tab", { name: /^Employees/ }).click();
  await expect(page.getByTestId("pcp-roster-state-PC-W2")).toHaveText("Paid");
  await expect(page.getByTestId("pcp-regenerate-PC-W2")).toHaveCount(0);
  const employee = (await testEmployees(page)).find((e) => e.employeeCode === "PC-W2")!;
  const again = await api(page, "POST", "/api/payroll/production/generate", {
    cycle: "weekly",
    ...WEEK1,
    employeeIds: [employee.id],
    regenerate: true,
  });
  expect(again.status).toBe(201);
  expect(again.body.generated).toBe(0);
  expect(again.body.skippedDetails[0].reason).toMatch(/already paid/i);
});

test("the API only ever pays the people on the requested cycle", async ({ page }) => {
  await loginAsHr(page);
  const w1 = (await testEmployees(page)).find((e) => e.employeeCode === "PC-W1")!;
  const b1 = (await testEmployees(page)).find((e) => e.employeeCode === "PC-B1")!;

  const noCycle = await api(page, "POST", "/api/payroll/production/generate", { ...WEEK1 });
  expect(noCycle.status).toBe(400);

  const wrongPeriod = await api(page, "POST", "/api/payroll/production/generate", { cycle: "biweekly", ...WEEK1 });
  expect(wrongPeriod.status).toBe(400);
  expect(wrongPeriod.body.error).toContain("is not a BiWeekly period");

  const outsider = await api(page, "POST", "/api/payroll/production/generate", {
    cycle: "weekly",
    ...WEEK1,
    employeeIds: [b1.id],
  });
  expect(outsider.body.generated).toBe(0);
  expect(outsider.body.skippedDetails[0].reason).toContain("Not assigned to the Weekly cycle");

  const notEnded = await api(page, "POST", "/api/payroll/production/generate", {
    cycle: "weekly",
    employeeIds: [w1.id],
    periodStart: "2099-01-05",
    periodEnd: "2099-01-11",
  });
  expect(notEnded.status).toBe(400);
});

test("BiWeekly pays its own people for a two-week period, separately from Weekly", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/production-payroll/biweekly");
  await expect(page.getByTestId("pcp-cycle-badge")).toHaveText("BiWeekly");
  await openPeriodHolding(page, "2026-02-10", /2 Feb - 15 Feb 2026/);

  await page.getByTestId("pcp-generate-open").click();
  await expect(page.getByTestId("pcp-generate-ready")).toHaveText("1 employee");
  await page.getByTestId("pcp-generate-confirm").click();
  await expect
    .poll(async () => (await payrollRows(page, "biweekly", FORTNIGHT1)).map((r) => r.employeeCode))
    .toEqual(["PC-B1"]);
  await expect(page.getByTestId("pcp-rows")).toContainText("Chitra Worker", { timeout: 30_000 });
  await expect(page.getByTestId("pcp-rows")).not.toContainText("Asha Worker");
});

test("Salary and Payslip show only the slips of the cycle", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/production-payroll/weekly");
  await page.getByRole("tab", { name: /^Salary/ }).click();
  await expect(page.getByTestId("pcp-salary-tab")).toContainText("PC-W1");
  await expect(page.getByTestId("pcp-salary-tab")).toContainText("PC-W2");
  await expect(page.getByTestId("pcp-salary-tab")).not.toContainText("PC-B1");

  await page.getByRole("tab", { name: /^Payslip/ }).click();
  await page.getByLabel("Month").selectOption({ label: "February" });
  await page.getByLabel("Year").fill("2026");
  await expect(page.getByTestId("pcp-payslip-tab")).toContainText("Asha Worker");
  await expect(page.getByTestId("pcp-payslip-tab")).toContainText("Bala Worker");
  await expect(page.getByTestId("pcp-payslip-tab")).not.toContainText("Chitra Worker");

  await page.goto("/hr/production-payroll/biweekly");
  await page.getByRole("tab", { name: /^Payslip/ }).click();
  await page.getByLabel("Month").selectOption({ label: "February" });
  await page.getByLabel("Year").fill("2026");
  await expect(page.getByTestId("pcp-payslip-tab")).toContainText("Chitra Worker");
  await expect(page.getByTestId("pcp-payslip-tab")).not.toContainText("Asha Worker");
});

test("a period that has not ended cannot be generated yet", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/production-payroll/weekly");
  await page.getByRole("tab", { name: /^Employees/ }).click();
  // a week far in the future, so the check never depends on today's date or time zone
  await openPeriodHolding(page, "2099-01-07", /5 Jan - 11 Jan 2099/);
  await expect(page.getByTestId("pcp-not-ended")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("pcp-generate-PC-W1")).toBeDisabled();

  // the dialog says so and cannot be confirmed
  await page.getByRole("tab", { name: /^Payroll/ }).click();
  await page.getByTestId("pcp-generate-open").click();
  await expect(page.getByTestId("pcp-generate-dialog")).toContainText("has not ended yet");
  await expect(page.getByTestId("pcp-generate-confirm")).toBeDisabled();
});

test("a cycle with no first period start asks for it instead of guessing", async ({ page }) => {
  await loginAsHr(page);
  await setCycles(page, null);
  await page.goto("/hr/production-payroll/monthly");
  await expect(page.getByTestId("pcp-setup-needed")).toContainText("Set the first period start date for Monthly");
  await expect(
    page.getByTestId("pcp-setup-needed").getByRole("link", { name: /open monthly settings/i }),
  ).toBeVisible();
  await setCycles(page, "2026-02-02");
  await page.reload();
  await expect(page.getByTestId("pcp-setup-needed")).toHaveCount(0);
  await expect(page.getByTestId("pcp-period")).toBeVisible();
});

test("Settings -> Production Payroll sets a cycle's first period start, and that cycle's page opens up", async ({
  page,
}) => {
  await loginAsHr(page);
  await setCycles(page, null);
  await page.goto("/hr/settings?tab=production_payroll#monthly-first-period");
  const date = page.locator("#monthly-first-period-input");
  await expect(date).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Not set: Monthly payroll cannot be generated until you choose it.")).toBeVisible();

  // a Wednesday: the weeks are counted from the Monday of that week (2 Feb)
  await date.fill("2026-02-04");
  await page.getByRole("button", { name: "Save Monthly settings" }).click();
  await expect(page.getByText("Monthly settings saved").first()).toBeVisible();
  const saved = (await api(page, "GET", "/api/payroll-settings")).body.prodCycles.monthly;
  expect(saved.anchorDate).toMatch(/^2026-02-0[24]$/);

  await page.goto("/hr/production-payroll/monthly");
  await expect(page.getByTestId("pcp-setup-needed")).toHaveCount(0);
  await openPeriodHolding(page, "2026-02-10", /2 Feb - 1 Mar 2026/);
});

test("Settings -> Production Payroll offers every weekday as the week start, and the Weekly page follows the one saved", async ({
  page,
}) => {
  await loginAsHr(page);
  try {
    await page.goto("/hr/settings?tab=production_payroll#weekly-week-start");
    const select = page.locator("#weekly-week-start-input");
    await expect(select).toBeVisible({ timeout: 30_000 });
    await expect(select.locator("option")).toHaveText([
      "Monday (weeks run Monday to Sunday)",
      "Tuesday (weeks run Tuesday to Monday)",
      "Wednesday (weeks run Wednesday to Tuesday)",
      "Thursday (weeks run Thursday to Wednesday)",
      "Friday (weeks run Friday to Thursday)",
      "Saturday (weeks run Saturday to Friday)",
      "Sunday (weeks run Sunday to Saturday)",
    ]);

    await select.selectOption("wednesday");
    await expect(page.getByTestId("weekly-today-preview")).toContainText(/Wed \d+ \w+ 20\d\d to Tue \d+ \w+ 20\d\d/);
    await page.getByRole("button", { name: "Save Weekly settings" }).click();
    // asked only when payroll was already generated for days the new weeks would cover
    await page
      .getByTestId("confirm-settings-save")
      .click({ timeout: 3_000 })
      .catch(() => undefined);
    await expect(page.getByText("Weekly settings saved").first()).toBeVisible();
    expect((await api(page, "GET", "/api/payroll-settings")).body.prodCycles.weekly.weekStart).toBe("wednesday");

    // the Weekly page now offers Wednesday-to-Tuesday weeks, and says so when generating
    await page.goto("/hr/production-payroll/weekly");
    await openPeriodHolding(page, "2026-02-04", /4 Feb - 10 Feb 2026/);
    await page.getByTestId("pcp-generate-open").click();
    await expect(page.getByTestId("pcp-generate-dialog")).toContainText("weeks run Wednesday to Tuesday");
    await page.keyboard.press("Escape");

    // a Monday week is no longer one of the Weekly periods
    const monday = await api(page, "POST", "/api/payroll/production/generate", { cycle: "weekly", ...WEEK1 });
    expect(monday.status).toBe(400);
    expect(monday.body.error).toContain("is not a Weekly period");
  } finally {
    await setCycles(page, "2026-02-02"); // Monday weeks again for the tests after this one
  }
});

test("a read-only login can look but not generate or assign", async ({ page }) => {
  const role = await api(page, "POST", "/api/roles", {
    name: "PC Viewer",
    permissions: { production_payroll: "view", employees: "view" },
  });
  expect(role.status, JSON.stringify(role.body)).toBeLessThan(300);
  const user = await api(page, "POST", "/api/hr-users", {
    username: "pc_viewer",
    password: "Pc-Viewer-Passw0rd!",
    fullName: "PC Viewer",
    roleId: role.body.id,
  });
  expect(user.status, JSON.stringify(user.body)).toBeLessThan(300);
  try {
    await page.goto("/hr-login");
    await page.getByTestId("input-username").fill("pc_viewer");
    await page.getByTestId("input-password").fill("Pc-Viewer-Passw0rd!");
    await page.getByTestId("button-submit").click();
    await expect(page).toHaveURL(/\/hr\//);

    await page.goto("/hr/production-payroll/weekly");
    await expect(page.getByTestId("pcp-generate-open")).toBeDisabled();
    await page.goto("/hr/employees/productionEmployee");
    await peTab(page, "Weekly").click();
    await expect(page.getByTestId("pe-row-assign-PC-W1")).toBeDisabled();

    const viewer = await tokenOf(page, "pc_viewer", "Pc-Viewer-Passw0rd!");
    const blocked = await api(
      page,
      "POST",
      "/api/employees/production/assign",
      { employeeIds: [1], cycle: "weekly" },
      viewer,
    );
    expect(blocked.status).toBe(403);
    const generating = await api(
      page,
      "POST",
      "/api/payroll/production/generate",
      { cycle: "weekly", ...WEEK1 },
      viewer,
    );
    expect(generating.status).toBe(403);
  } finally {
    await api(page, "DELETE", `/api/hr-users/${user.body.id}`);
    await api(page, "DELETE", `/api/roles/${role.body.id}`);
  }
});

test("a login scoped to one branch sees, assigns and generates only that branch's production employees", async ({
  page,
}) => {
  const branches = (await api(page, "GET", "/api/branches")).body as { id: number }[];
  const home = branches[0].id; // where makeWorker puts the PC-W / PC-B / PC-U employees
  const other = await api(page, "POST", "/api/branches", {
    name: "PC Other Unit",
    code: "PCOU",
    location: "Elsewhere",
  });
  expect(other.status, JSON.stringify(other.body)).toBeLessThan(300);
  const outsider = await api(page, "POST", "/api/employees", {
    employeeCode: "PC-X1",
    firstName: "Xavier",
    lastName: "Worker",
    phone: "9000000078",
    employmentType: "production",
    branchId: other.body.id,
    salaryType: "monthly",
    salaryPerShift: 500,
  });
  expect(outsider.status, JSON.stringify(outsider.body)).toBe(201);
  const role = await api(page, "POST", "/api/roles", {
    name: "PC Branch Clerk",
    permissions: { production_payroll: "edit", employees: "edit" },
  });
  expect(role.status, JSON.stringify(role.body)).toBeLessThan(300);
  const user = await api(page, "POST", "/api/hr-users", {
    username: "pc_branch",
    password: "Pc-Branch-Passw0rd!",
    fullName: "PC Branch",
    roleId: role.body.id,
    branchId: home,
  });
  expect(user.status, JSON.stringify(user.body)).toBeLessThan(300);
  try {
    const clerk = await tokenOf(page, "pc_branch", "Pc-Branch-Passw0rd!");
    const list = await api(page, "GET", "/api/employees/production?cycle=all&status=all", undefined, clerk);
    const codes = (list.body.employees as { employeeCode: string }[]).map((e) => e.employeeCode);
    expect(codes).toContain("PC-W1");
    expect(codes).not.toContain("PC-X1");

    // the other branch's employee cannot be assigned or paid from here
    const assign = await api(
      page,
      "POST",
      "/api/employees/production/assign",
      { employeeIds: [outsider.body.id], cycle: "weekly" },
      clerk,
    );
    expect(assign.body.updated).toBe(0);
    expect(assign.body.skipped[0].reason).toMatch(/not a production employee in your scope/i);
    const generate = await api(
      page,
      "POST",
      "/api/payroll/production/generate",
      { cycle: "weekly", ...WEEK1, employeeIds: [outsider.body.id] },
      clerk,
    );
    expect(generate.body.generated).toBe(0);
    expect(await cycleOf(page, "PC-X1")).toBeNull();

    // and the page says the same
    await page.goto("/hr-login");
    await page.getByTestId("input-username").fill("pc_branch");
    await page.getByTestId("input-password").fill("Pc-Branch-Passw0rd!");
    await page.getByTestId("button-submit").click();
    await expect(page).toHaveURL(/\/hr\//);
    await page.goto("/hr/employees/productionEmployee");
    await peTab(page, "All").click();
    await expect(page.getByTestId("pe-row-PC-W1")).toBeVisible();
    await expect(page.getByTestId("pe-row-PC-X1")).toHaveCount(0);
  } finally {
    await api(page, "DELETE", `/api/hr-users/${user.body.id}`);
    await api(page, "DELETE", `/api/roles/${role.body.id}`);
    await api(page, "DELETE", `/api/employees/${outsider.body.id}`);
    await api(page, "DELETE", `/api/branches/${other.body.id}`);
  }
});
