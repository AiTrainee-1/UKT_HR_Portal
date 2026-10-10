import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Settlement (advances and term loans) and Missing Punch after their redesign: the stat cards, search and filters, the
// approval confirmation, the detail view, validation in the new-advance form, bulk approval of missing punches, exports,
// and the phone layout. Everything made here carries "settle_e2e" in its purpose / reason and is removed again; the
// approval pipeline is handed back to the built-in one.
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

type Row = { id: number; purpose?: string; reason?: string };

async function employeeId(page: Page, code: string): Promise<number> {
  const list = (await api(page, "GET", "/api/employees")).body as { id: number; employeeCode: string }[];
  return list.find((e) => e.employeeCode === code)!.id;
}

async function cleanUp(page: Page) {
  for (const a of ((await api(page, "GET", "/api/advances")).body as Row[]).filter((a) => a.purpose?.startsWith(TAG))) {
    await api(page, "DELETE", `/api/advances/${a.id}`);
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

// ───────────────────────────── Settlement ─────────────────────────────

async function seedAdvances(page: Page) {
  const asha = await employeeId(page, "E2E001");
  const general = await api(page, "POST", "/api/advances", {
    employeeId: asha,
    advanceType: "general",
    amount: 4000,
    purpose: `${TAG} medical`,
    repaymentStartMonth: 12,
    repaymentStartYear: 2030,
  });
  expect(general.status, JSON.stringify(general.body)).toBe(201);
  const term = await api(page, "POST", "/api/advances", {
    employeeId: asha,
    advanceType: "term",
    amount: 9000,
    purpose: `${TAG} bike`,
    emiAmount: 3000,
    repaymentStartMonth: 1,
    repaymentStartYear: 2031,
  });
  expect(term.status, JSON.stringify(term.body)).toBe(201);
  return { general: general.body.id as number, term: term.body.id as number };
}

test("Settlement shows the summary, and searches and filters the advances", async ({ page }) => {
  const ids = await seedAdvances(page);
  await page.goto("/hr/settlement");
  await expect(page.getByRole("heading", { name: "Settlement" })).toBeVisible();
  for (const stat of ["stat-pending", "stat-active", "stat-recovered", "stat-left"]) {
    await expect(page.getByTestId(stat)).toBeVisible();
  }
  // opens on the approvals waiting for HR, as it always did
  await expect(page.getByTestId(`advance-row-${ids.general}`)).toBeVisible();
  await expect(page.getByTestId(`advance-row-${ids.term}`)).toBeVisible();

  await page.getByTestId("settlement-search").fill(`${TAG} bike`);
  await expect(page.getByTestId(`advance-row-${ids.term}`)).toBeVisible();
  await expect(page.getByTestId(`advance-row-${ids.general}`)).toHaveCount(0);
  await expect(page.getByTestId("settlement-count")).toContainText("Showing 1 of");

  await page.getByTestId("settlement-search").fill("nobody at all");
  await expect(page.getByTestId("advances-no-match")).toBeVisible();
  await page.getByTestId("advances-no-match").getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByTestId(`advance-row-${ids.general}`)).toBeVisible();

  // type filter
  await page.getByTestId("settlement-search").fill(TAG);
  await page.getByTestId("filter-type").click();
  await page.getByRole("option", { name: "Term loan" }).click();
  await expect(page.getByTestId(`advance-row-${ids.term}`)).toBeVisible();
  await expect(page.getByTestId(`advance-row-${ids.general}`)).toHaveCount(0);

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
  await page.goto("/hr/settlement");
  await page.getByTestId(`advance-approve-${ids.term}`).click();
  await expect(page.getByTestId("decision-dialog")).toBeVisible();
  await expect(page.getByTestId("decision-schedule")).toContainText("3 deductions of ₹3,000 from Jan 2031 to Mar 2031");

  // cancelling changes nothing
  await page.getByTestId("decision-cancel").click();
  expect(((await api(page, "GET", `/api/advances/${ids.term}`)).body as { status: string }).status).toBe("pending");

  await page.getByTestId(`advance-approve-${ids.term}`).click();
  await page.getByTestId("decision-confirm").click();
  await expect(page.getByText("Advance approved").first()).toBeVisible();
  await expect(page.getByTestId(`advance-row-${ids.term}`)).toHaveCount(0); // it left the pending list

  await page.getByRole("tab", { name: /^Active/ }).click();
  await page.getByTestId("settlement-search").fill(`${TAG} bike`);
  await page.getByTestId(`advance-row-${ids.term}`).click();
  const sheet = page.getByTestId("advance-detail");
  await expect(sheet).toContainText("Deduction schedule (3)");
  await expect(sheet).toContainText("Still scheduled through payroll");
  await expect(sheet.getByTestId("detail-print")).toBeVisible();
});

test("the new-advance form explains what is wrong, previews the schedule, and creates the advance", async ({
  page,
}) => {
  await page.goto("/hr/settlement");
  await page.getByTestId("new-advance").click();
  const dialog = page.getByTestId("create-advance-dialog");
  await dialog.getByTestId("advance-submit").click();
  await expect(dialog.getByText("Choose the employee this advance is for.")).toBeVisible();
  await expect(dialog.getByText("Enter the amount.")).toBeVisible();

  await dialog.getByTestId("advance-employee").click();
  await page
    .getByRole("button", { name: /E2E001/ })
    .first()
    .click();
  await dialog.getByTestId("advance-amount").fill("-5");
  await dialog.getByTestId("advance-submit").click();
  await expect(dialog.getByText("The amount must be more than 0.")).toBeVisible();

  await dialog.getByTestId("advance-type").click();
  await page.getByRole("option", { name: "Term advance (loan)" }).click();
  await dialog.getByTestId("advance-amount").fill("6000");
  await dialog.getByTestId("advance-submit").click();
  await expect(dialog.getByText("Enter the number of months or the monthly EMI.")).toBeVisible();
  await dialog.getByTestId("advance-emi").fill("9000");
  await expect(dialog.getByText("The monthly EMI cannot be more than the amount.")).toBeVisible();

  await dialog.getByTestId("advance-emi").fill("2000");
  await dialog.getByTestId("advance-start-year").fill("2031");
  await expect(dialog.getByTestId("advance-preview")).toContainText("3 deductions of ₹2,000");
  await dialog.getByTestId("advance-purpose").fill(`${TAG} created`);
  await dialog.getByTestId("advance-submit").click();
  await expect(page.getByText("Advance created").first()).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.getByTestId("settlement-search").fill(`${TAG} created`);
  await expect(page.getByTestId("advances-table").getByRole("row")).toHaveCount(2); // header + the new one
});

test("deleting an advance asks first", async ({ page }) => {
  const ids = await seedAdvances(page);
  await page.goto("/hr/settlement");
  await page.getByTestId(`advance-delete-${ids.general}`).click();
  await expect(page.getByTestId("delete-dialog")).toContainText("cannot be undone");
  await page.getByTestId("delete-cancel").click();
  await expect(page.getByTestId(`advance-row-${ids.general}`)).toBeVisible();
  await page.getByTestId(`advance-delete-${ids.general}`).click();
  await page.getByTestId("delete-confirm").click();
  await expect(page.getByText("Advance deleted").first()).toBeVisible();
  await expect(page.getByTestId(`advance-row-${ids.general}`)).toHaveCount(0);
});

test("Settlement exports the filtered list", async ({ page }) => {
  await seedAdvances(page);
  await page.goto("/hr/settlement");
  await page.getByTestId("settlement-search").fill(TAG);
  const download = page.waitForEvent("download");
  await page.getByTestId("settlement-export").click();
  expect((await download).suggestedFilename()).toMatch(/^Settlement_advances_\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test("Settlement on a phone shows cards, not a clipped table", async ({ page }) => {
  const ids = await seedAdvances(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/hr/settlement");
  await expect(page.getByTestId(`advance-card-${ids.general}`)).toBeVisible();
  await expect(page.getByTestId("advances-table")).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  // the Approve button is on the card, one tap away
  await expect(page.getByTestId(`advance-card-approve-${ids.general}`)).toBeVisible();
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
