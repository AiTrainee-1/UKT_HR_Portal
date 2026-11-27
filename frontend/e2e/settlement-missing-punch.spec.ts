import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Loan & Advance (the Settlement page renamed 2026-11-27: Overview, Salary Advance and Term Loan pages from the sidebar)
// and Missing Punch after their redesign: the count and stat cards (the page opens on this month), search and filters,
// the report dialog and the bank file, the approval confirmation, the detail view, HR's New request under the employee
// rules, the old /hr/settlement address, bulk approval of missing punches, exports, and the phone layout. Everything made
// here carries "settle_e2e" in its purpose / reason (and the two employees "LA-E2E1" / "LA-E2E2") and is removed again;
// the approval pipeline is handed back to the built-in one.
//
// Seeding (2026-11-27): POST /api/advances now runs the employee rules (mobile_settlement_views.apply_for), so a Salary
// Advance can be raised only on the 21st and 22nd, within 50 % of the salary earned in the 1st-20th of the month: the
// seeded employees have no attendance this month, so no Salary Advance can be seeded on any day. The requests seeded
// here are Term Loans (any day, after 6 months of service: the two employees made here joined in 2024); the Salary
// Advance side is checked through the New request dialog refusing it.
//
// The bulk approval really writes punches to attendance (as any approval does), so its requests are for dates in 2020,
// far from anything another spec looks at.

const TAG = "settle_e2e";

async function api(page: Page, method: string, url: string, data?: unknown) {
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

type Row = { id: number; purpose?: string; reason?: string; status?: string };

async function employeeId(page: Page, code: string): Promise<number> {
  const list = (await api(page, "GET", "/api/employees")).body as { id: number; employeeCode: string }[];
  return list.find((e) => e.employeeCode === code)!.id;
}

/** The two employees the Loan & Advance tests raise requests for: staff, joined in 2024 (6 months of service done). */
const LOAN_EMPLOYEES = [
  { employeeCode: "LA-E2E1", firstName: "Lakshmi", lastName: "Loan", phone: "9000000171" },
  { employeeCode: "LA-E2E2", firstName: "Arun", lastName: "Advance", phone: "9000000172" },
] as const;

async function loanEmployees(page: Page): Promise<[number, number]> {
  const list = (await api(page, "GET", "/api/employees")).body as { id: number; employeeCode: string }[];
  const branches = (await api(page, "GET", "/api/branches")).body as { id: number }[];
  const ids: number[] = [];
  for (const e of LOAN_EMPLOYEES) {
    const known = list.find((x) => x.employeeCode === e.employeeCode);
    if (known) {
      ids.push(known.id);
      continue;
    }
    const made = await api(page, "POST", "/api/employees", {
      ...e,
      employmentType: "staff",
      branchId: branches[0].id,
      salaryType: "monthly",
      salaryAmount: 24000,
      joinDate: "2024-01-01",
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    ids.push(made.body.id as number);
  }
  return [ids[0], ids[1]];
}

async function cleanUp(page: Page) {
  for (const a of ((await api(page, "GET", "/api/advances")).body as Row[]).filter((a) => a.purpose?.startsWith(TAG))) {
    // only a waiting advance can be deleted (2026-11-26): put a decided one back to waiting first
    if (a.status && a.status !== "pending") await api(page, "PUT", `/api/advances/${a.id}`, { status: "pending" });
    await api(page, "DELETE", `/api/advances/${a.id}`);
  }
  const employees = (await api(page, "GET", "/api/employees")).body as { id: number; employeeCode: string }[];
  for (const e of employees.filter((x) => LOAN_EMPLOYEES.some((l) => l.employeeCode === x.employeeCode))) {
    await api(page, "DELETE", `/api/employees/${e.id}`);
  }
  const punches = (await api(page, "GET", "/api/missing-punch-requests?status=all")).body as Row[];
  for (const p of punches.filter((p) => p.reason?.startsWith(TAG))) {
    await api(page, "DELETE", `/api/missing-punch-requests/${p.id}/status`);
  }
  await api(page, "DELETE", "/api/approval-workflows/missing_punch");
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await loginAsHr(page);
  await cleanUp(page);
});

test.afterEach(async ({ page }) => {
  await cleanUp(page);
});

// ───────────────────────────── Loan & Advance ─────────────────────────────

const OVERVIEW = "/hr/Loan&Advance";
const TERM_LOAN = "/hr/Loan&Advance/term-loan";
const SALARY_ADVANCE = "/hr/Loan&Advance/salary-advance";

/** Two Term Loan requests raised by HR under the employee rules (see the top: no Salary Advance can be seeded). */
async function seedAdvances(page: Page) {
  const [lakshmi, arun] = await loanEmployees(page);
  const bike = await api(page, "POST", "/api/advances", {
    employeeId: lakshmi,
    advanceType: "term",
    amount: 9000,
    repaymentMonths: 3,
    purpose: `${TAG} bike`,
  });
  expect(bike.status, JSON.stringify(bike.body)).toBe(201);
  const medical = await api(page, "POST", "/api/advances", {
    employeeId: arun,
    advanceType: "term",
    amount: 4000,
    repaymentMonths: 2,
    purpose: `${TAG} medical`,
  });
  expect(medical.status, JSON.stringify(medical.body)).toBe(201);
  return { bike: bike.body.id as number, medical: medical.body.id as number };
}

test("the old Settlement address goes to its Loan & Advance page; the sidebar chooses the page, not a tab row", async ({
  page,
}) => {
  await page.goto("/hr/settlement?tab=loan&month=all");
  await expect(page).toHaveURL(/\/hr\/Loan&Advance\/term-loan\?month=all$/);
  await expect(page.getByTestId("loan-advance-title")).toHaveText("Term Loan");
  await expect(page.getByTestId("loan-advance-breadcrumb")).toContainText("Loan & Advance");
  await expect(page.getByTestId("settlement-tabs")).toHaveCount(0);
  const nav = page.locator("nav").filter({ has: page.getByRole("link", { name: "Term Loan", exact: true }) });
  for (const [name, href] of [
    ["Overview", OVERVIEW],
    ["Salary Advance", SALARY_ADVANCE],
    ["Term Loan", TERM_LOAN],
  ]) {
    await expect(nav.getByRole("link", { name, exact: true }).first()).toHaveAttribute("href", href);
  }
  await nav.getByRole("link", { name: "Salary Advance", exact: true }).first().click();
  await expect(page).toHaveURL(/\/hr\/Loan&Advance\/salary-advance$/);
  await expect(page.getByTestId("loan-advance-title")).toHaveText("Salary Advance");
  await page.goto("/hr/settlement");
  await expect(page).toHaveURL(/\/hr\/Loan&Advance$/);
  await expect(page.getByRole("heading", { name: "Loan & Advance" })).toBeVisible();
});

test("Loan & Advance shows the summary, and searches and filters the advances", async ({ page }) => {
  const ids = await seedAdvances(page);
  await page.goto(OVERVIEW);
  await expect(page.getByRole("heading", { name: "Loan & Advance" })).toBeVisible();
  for (const stat of ["stat-pending", "stat-active", "stat-recovered", "stat-left"]) {
    await expect(page.getByTestId(stat)).toBeVisible();
  }
  // opens on the approvals waiting for HR, as it always did
  await expect(page.getByTestId(`advance-row-${ids.medical}`)).toBeVisible();
  await expect(page.getByTestId(`advance-row-${ids.bike}`)).toBeVisible();

  await page.getByTestId("settlement-search").fill(`${TAG} bike`);
  await expect(page.getByTestId(`advance-row-${ids.bike}`)).toBeVisible();
  await expect(page.getByTestId(`advance-row-${ids.medical}`)).toHaveCount(0);
  await expect(page.getByTestId("settlement-count")).toContainText("Showing 1 of");

  await page.getByTestId("settlement-search").fill("nobody at all");
  await expect(page.getByTestId("advances-no-match")).toBeVisible();
  await page.getByTestId("advances-no-match").getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByTestId(`advance-row-${ids.medical}`)).toBeVisible();

  // type filter (the Overview's own: both seeded requests are Term Loans)
  await page.getByTestId("settlement-search").fill(TAG);
  await page.getByTestId("filter-type").click();
  await page.getByRole("option", { name: "Salary Advance" }).click();
  await expect(page.getByTestId("advances-no-match")).toBeVisible();
  await page.getByTestId("filter-type").click();
  await page.getByRole("option", { name: "Term Loan" }).click();
  await expect(page.getByTestId(`advance-row-${ids.bike}`)).toBeVisible();
  await expect(page.getByTestId(`advance-row-${ids.medical}`)).toBeVisible();

  // a date range in the future shows nothing, an upside-down one says so
  await page.getByTestId("filter-type").click();
  await page.getByRole("option", { name: "All types" }).click();
  await page.getByTestId("filter-from").fill("2099-01-01");
  await expect(page.getByTestId("advances-no-match")).toBeVisible();
  await page.getByTestId("filter-from").fill("");
  await page.getByTestId("filter-to").fill("2000-01-01");
  await expect(page.getByTestId("advances-no-match")).toBeVisible();

  // sorting from the column heading
  await page.getByTestId("settlement-clear-filters").click();
  await page.getByRole("tab", { name: /^All/ }).click();
  await page.getByTestId("sort-amount").click();
  await expect(page.getByTestId("advances-table").locator("th[aria-sort='descending']")).toHaveCount(1);
});

test("approving asks first, shows the schedule it creates, and the advance moves to Active", async ({ page }) => {
  const ids = await seedAdvances(page);
  await page.goto(TERM_LOAN);
  await page.getByTestId(`advance-approve-${ids.bike}`).click();
  await expect(page.getByTestId("decision-dialog")).toBeVisible();
  // a Term Loan is deducted from next month (the employee rules fix the first month)
  await expect(page.getByTestId("decision-schedule")).toContainText(/3 deductions of ₹3,000 from [A-Z][a-z]{2} \d{4}/);

  // cancelling changes nothing
  await page.getByTestId("decision-cancel").click();
  expect(((await api(page, "GET", `/api/advances/${ids.bike}`)).body as { status: string }).status).toBe("pending");

  await page.getByTestId(`advance-approve-${ids.bike}`).click();
  await page.getByTestId("decision-confirm").click();
  await expect(page.getByText("Advance approved").first()).toBeVisible();
  await expect(page.getByTestId(`advance-row-${ids.bike}`)).toHaveCount(0); // it left the pending list

  await page.getByRole("tab", { name: /^Active/ }).click();
  await page.getByTestId("settlement-search").fill(`${TAG} bike`);
  await page.getByTestId(`advance-row-${ids.bike}`).click();
  const sheet = page.getByTestId("advance-detail");
  await expect(sheet).toContainText("Deduction schedule (3)");
  await expect(sheet).toContainText("Still scheduled through payroll");
  await expect(sheet.getByTestId("detail-print")).toBeVisible();
});

test("New request follows the employee rules: what blocks it, what is wrong, the schedule, and the request made", async ({
  page,
}) => {
  await loanEmployees(page);
  await page.goto(TERM_LOAN);
  await page.getByTestId("new-advance").click();
  const dialog = page.getByTestId("new-request-dialog");
  await expect(dialog.getByTestId("new-request-title")).toHaveText("New Term Loan request");
  await expect(dialog.getByTestId("new-request-submit")).toBeDisabled(); // nobody chosen yet

  await dialog.getByTestId("new-request-employee-select").click();
  await page
    .getByRole("button", { name: /LA-E2E1/ })
    .first()
    .click();
  await expect(dialog.getByTestId("new-request-service")).toContainText("months of service");
  await dialog.getByTestId("new-request-amount").fill("500");
  await dialog.getByTestId("new-request-months").fill("13");
  await dialog.getByTestId("new-request-purpose").fill(`${TAG} created`);
  await dialog.getByTestId("new-request-submit").click();
  await expect(dialog.getByText("A Term Loan starts from ₹1,000.")).toBeVisible();
  // 1 to Settings' Max repayment months (6 by default, owner 2026-11-27)
  await expect(dialog.getByText(/^A Term Loan is repaid in 1 to \d+ months\.$/)).toBeVisible();

  await dialog.getByTestId("new-request-amount").fill("6000");
  await dialog.getByTestId("new-request-months").fill("3");
  await expect(dialog.getByTestId("new-request-schedule")).toContainText("3 deductions of ₹2,000");
  await dialog.getByTestId("new-request-submit").click();
  await expect(page.getByText("Term Loan request raised").first()).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.getByTestId("settlement-search").fill(`${TAG} created`);
  await expect(page.getByTestId("advances-table").getByRole("row")).toHaveCount(2); // header + the new one

  // a Salary Advance for someone with nothing earned this month (or outside the 21st-22nd) cannot be raised
  await page.goto(SALARY_ADVANCE);
  await page.getByTestId("new-advance").click();
  await dialog.getByTestId("new-request-employee-select").click();
  await page
    .getByRole("button", { name: /LA-E2E2/ })
    .first()
    .click();
  await expect(dialog.getByTestId("new-request-blocked")).toBeVisible();
  await expect(dialog.getByTestId("new-request-amount")).toBeDisabled();
  await expect(dialog.getByTestId("new-request-submit")).toBeDisabled();
});

test("deleting an advance asks first", async ({ page }) => {
  const ids = await seedAdvances(page);
  await page.goto(OVERVIEW);
  await page.getByTestId(`advance-delete-${ids.medical}`).click();
  await expect(page.getByTestId("delete-dialog")).toContainText("cannot be undone");
  await page.getByTestId("delete-cancel").click();
  await expect(page.getByTestId(`advance-row-${ids.medical}`)).toBeVisible();
  await page.getByTestId(`advance-delete-${ids.medical}`).click();
  await page.getByTestId("delete-confirm").click();
  await expect(page.getByText("Advance deleted").first()).toBeVisible();
  await expect(page.getByTestId(`advance-row-${ids.medical}`)).toHaveCount(0);
});

test("the Export report starts from the page, and names the file after the type, status and month", async ({
  page,
}) => {
  await seedAdvances(page);
  await page.goto(OVERVIEW); // this month, raised in it: the seeded ones were raised today
  await page.getByTestId("settlement-search").fill(TAG);
  // the report's status starts on the page's (Pending); the owner's 12 columns are ticked
  let download = page.waitForEvent("download");
  await page.getByTestId("settlement-export").click();
  const dialog = page.getByTestId("report-dialog");
  await expect(dialog.getByTestId("report-summary")).toContainText("All types · Pending");
  await expect(dialog.getByTestId("report-column-sno")).toHaveAttribute("data-state", "checked");
  await expect(dialog.getByTestId("report-column-purpose")).toHaveAttribute("data-state", "unchecked");
  await dialog.getByTestId("report-xlsx").click();
  expect((await download).suggestedFilename()).toMatch(
    /^Loan_Advance_All_types_Pending_[A-Za-z]+_\d{4}_\d{4}-\d{2}-\d{2}\.xlsx$/,
  );
  await page.keyboard.press("Escape"); // closes the report (the dialog has two "Close" buttons: the X and the footer's)
  await expect(dialog).toHaveCount(0);

  // the Term Loan page: the report starts on Term Loan; All statuses, All months, as a PDF
  await page.goto(TERM_LOAN);
  await page.getByTestId("settlement-export").click();
  await dialog.getByTestId("report-status").click();
  await page.getByRole("option", { name: "All", exact: true }).click();
  await dialog.getByTestId("report-month").click();
  await page.getByRole("option", { name: "All months" }).click();
  download = page.waitForEvent("download");
  await dialog.getByTestId("report-pdf").click();
  expect((await download).suggestedFilename()).toMatch(
    /^Loan_Advance_Term_Loan_All_statuses_All_months_\d{4}-\d{2}-\d{2}\.pdf$/,
  );
});

test("Export Bank File pays this month's approved ones, after a confirm", async ({ page }) => {
  const ids = await seedAdvances(page);
  const approved = await api(page, "PUT", `/api/advances/${ids.medical}`, { status: "approved" });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  await page.goto(OVERVIEW);
  await page.getByTestId("settlement-search").fill(TAG);
  await page.getByTestId("settlement-bank-file").click();
  const dialog = page.getByTestId("bank-file-dialog");
  await expect(dialog.getByTestId("bank-file-summary")).toContainText("approved (active or completed)");
  const download = page.waitForEvent("download");
  await dialog.getByTestId("bank-file-confirm").click();
  expect((await download).suggestedFilename()).toMatch(/^Loan_Advance_Bank_File_Overview_[A-Za-z]+_\d{4}\.xlsx$/);
});

test("rejecting needs a reason, which is saved and shown in the details", async ({ page }) => {
  const ids = await seedAdvances(page);
  await page.goto("/hr/settlement?tab=loan"); // the old address of the Term Loan tab
  await expect(page).toHaveURL(/\/hr\/Loan&Advance\/term-loan$/);
  await page.getByTestId(`advance-reject-${ids.medical}`).click();
  const dialog = page.getByTestId("decision-dialog");
  await dialog.getByTestId("decision-confirm").click();
  await expect(dialog.getByTestId("decision-remark-problem")).toHaveText(
    "Write the reason for rejecting (at least 3 characters).",
  );
  expect(((await api(page, "GET", `/api/advances/${ids.medical}`)).body as { status: string }).status).toBe("pending");
  await dialog.getByTestId("decision-remark").fill(`${TAG} already has one running`);
  await dialog.getByTestId("decision-confirm").click();
  await expect(page.getByText("Advance rejected").first()).toBeVisible();
  const saved = (await api(page, "GET", `/api/advances/${ids.medical}`)).body as {
    status: string;
    decisionRemark: string;
    history: { action: string; remark: string }[];
  };
  expect(saved.status).toBe("rejected");
  expect(saved.decisionRemark).toBe(`${TAG} already has one running`);
  expect(saved.history[0]).toMatchObject({ action: "rejected", remark: `${TAG} already has one running` });

  await page.getByRole("tab", { name: /^Rejected/ }).click();
  await page.getByTestId(`advance-row-${ids.medical}`).click();
  await expect(page.getByTestId("advance-decision-remark")).toContainText("already has one running");
  await expect(page.getByTestId("advance-history")).toContainText("Rejected");
});

test("Loan & Advance on a phone shows cards, not a clipped table", async ({ page }) => {
  const ids = await seedAdvances(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(OVERVIEW);
  await expect(page.getByTestId(`advance-card-${ids.medical}`)).toBeVisible();
  await expect(page.getByTestId("advances-table")).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  // the Approve button is on the card, one tap away
  await expect(page.getByTestId(`advance-card-approve-${ids.medical}`)).toBeVisible();
});

// ───────────────────────────── Missing Punch ─────────────────────────────

/** HR decides these (a one-step HR pipeline), for the dates given. */
async function seedPunches(page: Page, dates: [string, string] = ["2020-01-06", "2020-01-07"]) {
  const put = await api(page, "PUT", "/api/approval-workflows/missing_punch", {
    steps: [{ roles: ["hr"], mandatory: true }],
  });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  const asha = await employeeId(page, "E2E001");
  const one = await api(page, "POST", "/api/missing-punch-requests", {
    employeeId: asha,
    date: dates[0],
    punchTime: "09:05",
    punchSlot: "morning_in",
    reason: `${TAG} one`,
  });
  const two = await api(page, "POST", "/api/missing-punch-requests", {
    employeeId: asha,
    date: dates[1],
    punchTime: "13:00",
    punchSlot: "lunch_out",
    reason: `${TAG} two`,
  });
  expect(one.status, JSON.stringify(one.body)).toBe(201);
  expect(two.status, JSON.stringify(two.body)).toBe(201);
  return { one: one.body.id as number, two: two.body.id as number };
}

test("Missing Punch shows the summary, searches by employee, date and punch, and filters", async ({ page }) => {
  const ids = await seedPunches(page);
  await page.goto("/hr/missing-punch");
  await expect(page.getByRole("heading", { name: "Missing Punch" })).toBeVisible();
  for (const stat of ["mp-stat-hr", "mp-stat-hod", "mp-stat-approved", "mp-stat-rejected"]) {
    await expect(page.getByTestId(stat)).toBeVisible();
  }
  // exactly one Refresh, in the title row
  await expect(page.getByRole("button", { name: /^\s*Refresh( this page)?\s*$/ })).toHaveCount(1);

  await expect(page.getByTestId(`missing-punch-${ids.one}`)).toBeVisible();
  await expect(page.getByTestId(`missing-punch-${ids.two}`)).toBeVisible();

  await page.getByTestId("mp-search").fill(`${TAG} lunch`);
  await expect(page.getByTestId(`missing-punch-${ids.two}`)).toBeVisible();
  await expect(page.getByTestId(`missing-punch-${ids.one}`)).toHaveCount(0);
  await page.getByTestId("mp-search").fill("2020-01-06");
  await expect(page.getByTestId(`missing-punch-${ids.one}`)).toBeVisible();
  await expect(page.getByTestId(`missing-punch-${ids.two}`)).toHaveCount(0);

  await page.getByTestId("mp-clear-filters").click();
  await page.getByTestId("mp-search").fill(TAG);
  await page.getByTestId("mp-filter-slot").click();
  await page.getByRole("option", { name: "Lunch Check-Out" }).click();
  await expect(page.getByTestId(`missing-punch-${ids.two}`)).toBeVisible();
  await expect(page.getByTestId(`missing-punch-${ids.one}`)).toHaveCount(0);

  await page.getByTestId("mp-clear-filters").click();
  await page.getByTestId("mp-search").fill("nobody at all");
  await expect(page.getByTestId("mp-no-match")).toBeVisible();
});

test("a request opens in a detail view, and HR rejects it there with a note", async ({ page }) => {
  const ids = await seedPunches(page);
  await page.goto("/hr/missing-punch");
  await page.getByTestId(`mp-open-${ids.one}`).click();
  const sheet = page.getByTestId("mp-detail");
  await expect(sheet).toContainText(`${TAG} one`);
  await expect(sheet).toContainText("Morning Check-In");
  await sheet.getByTestId("mp-comment").fill("not on the gate log");
  await sheet.getByTestId("mp-detail-reject").click();
  await expect(page.getByText("Missing Punch rejected").first()).toBeVisible();
  await expect(page.getByTestId(`missing-punch-${ids.one}`)).toHaveCount(0);

  // the rejection says who decided and when, with the note
  await page.getByRole("tab", { name: /^Rejected/ }).click();
  await expect(page.getByTestId(`mp-decisions-${ids.one}`)).toContainText("rejected");
  await expect(page.getByTestId(`mp-decisions-${ids.one}`)).toContainText("not on the gate log");
});

test("bulk approval lists exactly what it will approve, and only what HR may decide", async ({ page }) => {
  const ids = await seedPunches(page);
  await page.goto("/hr/missing-punch");
  await expect(page.getByTestId("mp-bulk-bar")).toBeVisible();
  await page.getByTestId(`mp-select-${ids.one}`).click();
  await page.getByTestId(`mp-select-${ids.two}`).click();
  await page.getByTestId("mp-bulk-approve").click();
  const dialog = page.getByTestId("mp-bulk-dialog");
  await expect(dialog.getByTestId("mp-bulk-list").getByRole("listitem")).toHaveCount(2);
  await expect(dialog).toContainText(`${TAG} one`);
  await expect(dialog).toContainText(`${TAG} two`);

  // cancelling approves nothing
  await dialog.getByTestId("mp-bulk-cancel").click();
  await expect(page.getByTestId(`missing-punch-${ids.one}`)).toBeVisible();

  await page.getByTestId("mp-bulk-approve").click();
  await page.getByTestId("mp-bulk-confirm").click();
  await expect(page.getByText("Approved 2 requests").first()).toBeVisible();
  await expect(page.getByTestId(`missing-punch-${ids.one}`)).toHaveCount(0);
  await page.getByRole("tab", { name: /^Approved/ }).click();
  await expect(page.getByTestId(`missing-punch-${ids.one}`)).toContainText("Added to attendance");
});

test("under the built-in pipeline a request waiting for the HOD cannot be selected or approved", async ({ page }) => {
  const asha = await employeeId(page, "E2E001");
  const waiting = await api(page, "POST", "/api/missing-punch-requests", {
    employeeId: asha,
    date: "2020-01-08",
    punchTime: "09:10",
    punchSlot: "morning_in",
    reason: `${TAG} waiting for the HOD`,
  });
  const id = waiting.body.id as number;
  await page.goto("/hr/missing-punch");
  const row = page.getByTestId(`missing-punch-${id}`);
  await expect(row).toContainText("Waiting for HOD");
  await expect(row.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(page.getByTestId(`mp-select-${id}`)).toHaveCount(0);
  await page.getByRole("tab", { name: /^Awaiting HOD/ }).click();
  await expect(row).toBeVisible();
});

test("Missing Punch exports the filtered list", async ({ page }) => {
  await seedPunches(page);
  await page.goto("/hr/missing-punch");
  await page.getByTestId("mp-search").fill(TAG);
  const download = page.waitForEvent("download");
  await page.getByTestId("mp-export").click();
  expect((await download).suggestedFilename()).toMatch(/^Missing_punch_requests_\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test("Missing Punch on a phone lays the requests out as cards without sideways scrolling", async ({ page }) => {
  const ids = await seedPunches(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/hr/missing-punch");
  const card = page.getByTestId(`missing-punch-${ids.one}`);
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
