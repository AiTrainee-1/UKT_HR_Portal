import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Requests hub (/hr/requests): every kind of request as a sub-tab with a live waiting count, the figures above the list, search
// and filters, the detail dialog with the approval trail and who decided, Reject with a reason, the general-request form,
// the export and the phone layout. Everything made here carries the reason "RQH ..." and is removed again where the API has
// a delete; general requests and outpasses have none, so the spec decides them (nothing is left waiting).

async function api(page: Page, method: string, url: string, data?: unknown) {
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

const made = { leave: [] as number[], permission: [] as number[], missingPunch: [] as number[] };

async function employee(page: Page) {
  const list = (await api(page, "GET", "/api/employees")).body as {
    id: number;
    employeeCode: string;
    firstName: string;
  }[];
  return list.find((e) => e.employeeCode === "E2E001") ?? list[0];
}

async function cleanUp(page: Page) {
  for (const id of made.leave) await api(page, "DELETE", `/api/leave-requests/${id}`);
  for (const id of made.permission) await api(page, "DELETE", `/api/permissions/${id}`);
  for (const id of made.missingPunch) await api(page, "DELETE", `/api/missing-punch-requests/${id}/status`);
  made.leave = [];
  made.permission = [];
  made.missingPunch = [];
}

async function makeLeave(page: Page, employeeId: number, reason: string) {
  const r = await api(page, "POST", "/api/leave-requests", {
    employeeId,
    startDate: "2026-10-26",
    endDate: "2026-10-26",
    type: "casual",
    reason,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  made.leave.push(r.body.id);
  return r.body.id as number;
}

async function makeMissingPunch(page: Page, employeeId: number, reason: string) {
  const r = await api(page, "POST", "/api/missing-punch-requests", {
    employeeId,
    date: "2026-10-09",
    punchTime: "09:05",
    punchSlot: "morning_in",
    reason,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  made.missingPunch.push(r.body.id);
  return r.body.id as number;
}

const tab = (page: Page, name: RegExp | string) => page.getByRole("tab", { name });
const row = (page: Page, kind: string, id: number) => page.getByTestId(`request-${kind}-${id}`);

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await loginAsHr(page);
});

test.afterEach(async ({ page }) => {
  await cleanUp(page);
});

test("every kind of request has its own sub-tab, with how many are waiting", async ({ page }) => {
  const asha = await employee(page);
  const leaveId = await makeLeave(page, asha.id, "RQH tabs leave");
  const punchId = await makeMissingPunch(page, asha.id, "RQH tabs punch");
  await page.goto("/hr/requests");
  await expect(page.getByTestId("requests-hub")).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Requests/ })).toBeVisible();

  for (const label of [
    "All",
    "Leave",
    "Permission",
    "Casual Leave",
    "Missing Punch",
    "On-Duty",
    "On-Duty punches",
    "Outpass",
    "Other requests",
    "Attendance correction",
    "Resignation",
    "Advance",
  ]) {
    await expect(tab(page, new RegExp(`^${label}( \\(\\d+\\))?$`)), label).toBeVisible();
  }
  // a kind with something waiting shows how many
  await expect(tab(page, /^Leave \(\d+\)$/)).toBeVisible();
  await expect(tab(page, /^Missing Punch \(\d+\)$/)).toBeVisible();

  // All holds both; a kind's tab holds only its own
  await expect(row(page, "leave", leaveId)).toBeVisible();
  await expect(row(page, "missing_punch", punchId)).toBeVisible();
  await tab(page, /^Leave/).click();
  await expect(row(page, "leave", leaveId)).toBeVisible();
  await expect(row(page, "missing_punch", punchId)).toHaveCount(0);
  await expect(page).toHaveURL(/kind=leave/);
  await expect(page.getByTestId("requests-tab-note")).toContainText("Approval pipeline");

  // the address opens the same tab
  await page.reload();
  await expect(tab(page, /^Leave/)).toHaveAttribute("aria-selected", "true");

  // exactly one Refresh, in the title row
  await expect(page.getByRole("button", { name: /^\s*Refresh( this page)?\s*$/ })).toHaveCount(1);
});

test("the figures say who the waiting requests are with, and a figure narrows the list to them", async ({ page }) => {
  const asha = await employee(page);
  const leaveId = await makeLeave(page, asha.id, "RQH figures leave");
  const punchId = await makeMissingPunch(page, asha.id, "RQH figures punch");
  await page.goto("/hr/requests");
  await expect(page.getByTestId("requests-figures")).toBeVisible();
  await expect(page.getByTestId("figure-waiting-hr-value")).not.toHaveText("0");
  await expect(page.getByTestId("figure-waiting-hod-value")).not.toHaveText("0");

  // leave runs HOD-or-HR (HR can decide), missing punch runs HOD then HR (it is with the HOD)
  await page.getByTestId("figure-waiting-hod").click();
  await expect(row(page, "missing_punch", punchId)).toBeVisible();
  await expect(row(page, "missing_punch", punchId)).toContainText("Waiting for HOD");
  await expect(row(page, "leave", leaveId)).toHaveCount(0);
  await page.getByTestId("figure-waiting-hr").click();
  await expect(row(page, "leave", leaveId)).toBeVisible();
  await expect(row(page, "missing_punch", punchId)).toHaveCount(0);
});

test("search, filters and the two kinds of empty list", async ({ page }) => {
  const asha = await employee(page);
  const a = await makeLeave(page, asha.id, "RQH search alpha wedding");
  const b = await makeLeave(page, asha.id, "RQH search beta funeral");
  await page.goto("/hr/requests");
  await tab(page, /^Leave/).click();
  const search = page.getByTestId("requests-search");

  await search.fill("rqh wedding");
  await expect(row(page, "leave", a)).toBeVisible();
  await expect(row(page, "leave", b)).toHaveCount(0);
  await expect(page.getByTestId("requests-count")).toContainText("Showing");

  // every word has to match
  await search.fill("wedding funeral");
  await expect(page.getByTestId("requests-no-match")).toBeVisible();
  await expect(page.getByTestId("requests-no-match")).toContainText("No request matches");
  await page.getByTestId("requests-no-match").getByRole("button", { name: "Clear filters" }).click();
  await expect(search).toHaveValue("");
  await expect(row(page, "leave", b)).toBeVisible();

  // a status filter, then a period filter, then the filters cleared
  await page.getByTestId("filter-status").click();
  await page.getByRole("option", { name: "Approved", exact: true }).click();
  await expect(row(page, "leave", a)).toHaveCount(0);
  await expect(page.getByTestId("requests-clear-filters")).toBeVisible();
  await page.getByTestId("requests-clear-filters").click();
  await expect(row(page, "leave", a)).toBeVisible();
  await page.getByTestId("filter-period").click();
  await page.getByRole("option", { name: "Today" }).click();
  await expect(row(page, "leave", a)).toBeVisible();
  await page.getByTestId("filter-period").click();
  await page.getByRole("option", { name: "Custom range" }).click();
  await page.getByTestId("filter-from").fill("2020-01-01");
  await page.getByTestId("filter-to").fill("2020-01-31");
  await expect(row(page, "leave", a)).toHaveCount(0);

  // the sort is offered
  await page.getByTestId("requests-sort").click();
  await expect(page.getByRole("option", { name: "Longest waiting first" })).toBeVisible();
});

test("the details show the approval trail; Reject asks for a reason, and the row then says who decided", async ({
  page,
}) => {
  const asha = await employee(page);
  const id = await makeLeave(page, asha.id, "RQH detail leave");
  await page.goto("/hr/requests");
  await tab(page, /^Leave/).click();
  await row(page, "leave", id).click();
  const detail = page.getByTestId("request-detail");
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId("approval-trail")).toBeVisible();
  await expect(detail).toContainText("RQH detail leave");
  await expect(detail.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Open in Leave & Holiday" })).toBeVisible();

  await detail.getByRole("button", { name: "Reject", exact: true }).click();
  const decision = page.getByTestId("decision-dialog");
  await expect(decision).toBeVisible();
  await decision.getByTestId("decision-note").fill("RQH not this week");
  await decision.getByRole("button", { name: "Confirm reject" }).click();
  await expect(page.getByText("Leave rejected").first()).toBeVisible();

  const after = row(page, "leave", id);
  await expect(after).toContainText("rejected");
  await expect(after).toContainText(/\(HR\)/);
  await after.click();
  await expect(page.getByTestId("decided-by")).toContainText("Rejected by");
  await expect(page.getByTestId("decided-by")).toContainText("RQH not this week");
  // the server really recorded it
  const leaves = (await api(page, "GET", `/api/leave-requests?employeeId=${asha.id}`)).body as {
    id: number;
    status: string;
  }[];
  expect(leaves.find((l) => l.id === id)?.status).toBe("rejected");
});

test("a request that waits for the HOD offers no Approve; it says who it is waiting for", async ({ page }) => {
  const asha = await employee(page);
  const id = await makeMissingPunch(page, asha.id, "RQH hod punch");
  await page.goto("/hr/requests");
  await tab(page, /^Missing Punch/).click();
  const card = row(page, "missing_punch", id);
  await expect(card).toContainText("Waiting for HOD");
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Reject", exact: true })).toHaveCount(0);
  await card.click();
  await expect(page.getByTestId("request-detail")).toContainText("HR cannot decide it until that step is done");
});

test("a general request is answered here: status and notes the employee reads", async ({ page }) => {
  const asha = await employee(page);
  const created = await api(page, "POST", "/api/employee-requests", {
    employeeId: asha.id,
    requestType: "salary_enquiry",
    subject: "RQH salary slip query",
    description: "RQH please check September",
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.id as number;
  await page.goto("/hr/requests");
  await tab(page, /^Other requests/).click();
  await page.getByTestId("filter-request-type").click();
  await page.getByRole("option", { name: "Salary enquiry" }).click();
  await row(page, "request", id).getByTestId(`handle-request-${id}`).click();

  const dialog = page.getByTestId("handle-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("handle-status").click();
  await page.getByRole("option", { name: "Approved", exact: true }).click();
  await dialog.getByTestId("handle-notes").fill("RQH slip re-issued");
  await dialog.getByTestId("handle-submit").click();
  await expect(page.getByText("Request updated").first()).toBeVisible();

  const after = row(page, "request", id);
  await expect(after).toContainText("approved");
  const list = (await api(page, "GET", "/api/employee-requests?requestType=salary_enquiry")).body as {
    id: number;
    status: string;
    hrNotes: string | null;
  }[];
  const saved = list.find((r) => r.id === id);
  expect(saved?.status).toBe("approved");
  expect(saved?.hrNotes).toBe("RQH slip re-issued");
});

test("the filtered list downloads as CSV with every column", async ({ page }) => {
  const asha = await employee(page);
  const id = await makeLeave(page, asha.id, "RQH export leave");
  await page.goto("/hr/requests");
  await tab(page, /^Leave/).click();
  await page.getByTestId("requests-search").fill("RQH export");
  await expect(row(page, "leave", id)).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByTestId("requests-export").click();
  await page.getByTestId("requests-export-csv").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^requests-Leave-\d{4}-\d{2}-\d{2}\.csv$/);
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf-8");
  expect(text).toContain("Request type,Request,Employee code,Employee");
  expect(text).toContain("RQH export leave");
});

test("on a phone each request is a card and nothing is clipped", async ({ page }) => {
  const asha = await employee(page);
  const id = await makeLeave(page, asha.id, "RQH phone leave");
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/hr/requests");
  await expect(page.getByTestId("requests-cards")).toBeVisible();
  await expect(page.getByTestId("requests-table")).toHaveCount(0);
  await expect(row(page, "leave", id)).toHaveCount(1);
  await expect(row(page, "leave", id).getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
