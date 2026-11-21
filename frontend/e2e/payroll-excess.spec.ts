import ExcelJS from "exceljs";
import { expect, test, type APIRequestContext, type Download, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// The Excess tab (owner 2026-11-20; it was the Salary tab, same ?tab=salary), the rebuilt Payslip tab and the Payroll tab's
// "Not included" view, on Staff Payroll and on a Production Payroll cycle page, against the real backend:
//   * an Excess (added to the earned salary) or a Detection (taken off it) is entered by hand with a mandatory remark; an
//     already generated payroll's NET follows at once, Generate again keeps it, and change / remove need a reason;
//   * every add / change / remove is in the history, with who, when, the amount before and after and the remark;
//   * Not included lists everyone who is not in the payroll, with the reason; the Payslip tab lists only the payroll's
//     employees and downloads their payslips as a PDF.
// Staff: February 2026 from seed_e2e.py (Asha Kumar E2E001 paid 24,000; Ravi Nair E2E002 paid 15,000; Meena E2E003 has no
// salary). Every entry added here is removed again, so February is back to 24,000 / 15,000 for the other specs.
// Production: the Weekly period 2 Mar - 8 Mar 2026 (no other spec uses it) with two workers made here (codes PX-*).
// Every employee made here is removed again (their payrolls and entries go with them).

const FEB = "/hr/payroll?month=2&year=2026";
const MONTH = { month: 2, year: 2026 };
const WEEK = { periodStart: "2026-03-02", periodEnd: "2026-03-08" };
const WEEKLY = `/hr/production-payroll/weekly?period=${WEEK.periodStart}_${WEEK.periodEnd}`;
const PROD_SCOPE = { cycle: "weekly", ...WEEK };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Reply = { status: number; body: any };
type Entry = { id: number; kind: "excess" | "detection"; amount: number; remark: string; source: string };

let token = "";
const ids = { asha: 0, ravi: 0, ashaPayroll: 0, raviPayroll: 0, inactiveStaff: 0, worker: 0, inactiveWorker: 0 };

async function api(request: APIRequestContext, method: string, url: string, data?: unknown): Promise<Reply> {
  const res = await request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status(), body };
}

async function openAs(page: Page, path: string) {
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), token);
  await page.goto(path);
}

const staffPayroll = async (request: APIRequestContext, code: string) =>
  ((await api(request, "GET", "/api/payroll?month=2&year=2026")).body as any[]).find((r) => r.employeeCode === code);

const workerPayroll = async (request: APIRequestContext) =>
  (
    (
      await api(
        request,
        "GET",
        `/api/payroll/production?cycle=weekly&periodStart=${WEEK.periodStart}&periodEnd=${WEEK.periodEnd}&includeParked=1`,
      )
    ).body as any[]
  ).find((r) => r.employeeCode === "PX-W1");

/** The active entries of the month (staff) or the period (production), by employee code. */
async function entriesOf(request: APIRequestContext, kind: "staff" | "production"): Promise<Record<string, Entry[]>> {
  const url =
    kind === "staff"
      ? "/api/payroll-excess/month?month=2&year=2026"
      : `/api/production-payroll-excess/period?cycle=weekly&periodStart=${WEEK.periodStart}&periodEnd=${WEEK.periodEnd}`;
  const res = await api(request, "GET", url);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const out: Record<string, Entry[]> = {};
  for (const d of res.body.departments) for (const r of d.rows) out[r.code] = r.entries;
  return out;
}

/** Removes every active entry of February (left over by a run that stopped half way). */
async function clearFebruary(request: APIRequestContext) {
  const all = Object.values(await entriesOf(request, "staff")).flat();
  if (all.length === 0) return;
  const res = await api(request, "POST", "/api/payroll-excess/remove", {
    entryIds: all.map((e) => e.id),
    remark: "e2e clean up",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function removeMadeEmployees(request: APIRequestContext) {
  const list = (await api(request, "GET", "/api/employees")).body as { id: number; employeeCode: string }[];
  for (const e of list.filter((e) => e.employeeCode === "E2EXS1" || e.employeeCode.startsWith("PX-")))
    await api(request, "DELETE", `/api/employees/${e.id}`);
}

async function makeEmployee(request: APIRequestContext, data: Record<string, unknown>): Promise<number> {
  const branches = (await api(request, "GET", "/api/branches")).body as { id: number }[];
  const res = await api(request, "POST", "/api/employees", {
    branchId: branches[0].id,
    salaryType: "monthly",
    joinDate: "2025-01-01",
    ...data,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

async function makeInactive(request: APIRequestContext, id: number) {
  const res = await api(request, "PATCH", `/api/employees/${id}/status`, { status: "inactive" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function pdfHead(download: Download): Promise<string> {
  const fs = await import("node:fs/promises");
  return (await fs.readFile((await download.path())!)).subarray(0, 5).toString("latin1");
}

/** "20 Nov 2026": the date part of a history row's time, as the page writes it. */
function dayOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** Fills and saves the Add dialog of the Excess tab for the employees given (by id). */
async function addOnScreen(
  page: Page,
  opts: { kind: "excess" | "detection"; amount: string; remark: string; search: string; employeeIds: number[] },
) {
  await page.getByTestId("excess-add-open").click();
  const dialog = page.getByTestId("excess-add-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId(`excess-kind-${opts.kind}`).click();
  await expect(dialog.getByTestId(`excess-kind-${opts.kind}`)).toHaveAttribute("aria-checked", "true");
  await dialog.getByTestId("excess-amount").fill(opts.amount);
  await dialog.getByTestId("excess-remark").fill(opts.remark);
  await dialog.getByTestId("excess-picker-search").fill(opts.search);
  for (const id of opts.employeeIds) await dialog.getByTestId(`excess-option-${id}`).click();
  await dialog.getByTestId("excess-add-save").click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  const login = await request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  expect(login.status()).toBe(200);
  token = (await login.json()).token as string;
  await removeMadeEmployees(request);

  // staff: an inactive employee with a salary (left out of the payroll), then February generated
  ids.inactiveStaff = await makeEmployee(request, {
    employeeCode: "E2EXS1",
    firstName: "Kavya",
    lastName: "Exstaff",
    phone: "9000000081",
    employmentType: "staff",
    salaryAmount: 18000,
  });
  await makeInactive(request, ids.inactiveStaff);
  expect((await api(request, "POST", "/api/payroll/generate", MONTH)).status).toBe(201);
  await clearFebruary(request);
  const asha = await staffPayroll(request, "E2E001");
  const ravi = await staffPayroll(request, "E2E002");
  [ids.asha, ids.ashaPayroll, ids.ravi, ids.raviPayroll] = [asha.employeeId, asha.id, ravi.employeeId, ravi.id];
  expect([Number(asha.finalSalary), Number(ravi.finalSalary)]).toEqual([24000, 15000]);

  // production: two workers on the Weekly cycle, the second one made inactive; the week generated for the first one
  ids.worker = await makeEmployee(request, {
    employeeCode: "PX-W1",
    firstName: "Lakshmi",
    lastName: "Exworker",
    phone: "9000000082",
    employmentType: "production",
    salaryPerShift: 500,
  });
  ids.inactiveWorker = await makeEmployee(request, {
    employeeCode: "PX-W2",
    firstName: "Mohan",
    lastName: "Exworker",
    phone: "9000000083",
    employmentType: "production",
    salaryPerShift: 500,
  });
  const assigned = await api(request, "POST", "/api/employees/production/assign", {
    employeeIds: [ids.worker, ids.inactiveWorker],
    cycle: "weekly",
  });
  expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
  await makeInactive(request, ids.inactiveWorker);
  const generated = await api(request, "POST", "/api/payroll/production/generate", {
    ...PROD_SCOPE,
    employeeIds: [ids.worker],
  });
  expect(generated.status, JSON.stringify(generated.body)).toBe(201);
  expect(generated.body.generated).toBe(1);
});

test.afterAll(async ({ request }) => {
  await clearFebruary(request);
  await removeMadeEmployees(request);
  // February is the plain 24,000 / 15,000 again for the other specs
  expect(Number((await staffPayroll(request, "E2E001")).finalSalary)).toBe(24000);
  expect(Number((await staffPayroll(request, "E2E002")).finalSalary)).toBe(15000);
});

// ── Staff Payroll ───────────────────────────────────────────────────────────────────────────────────────────────────────

test("staff: an Excess needs a remark, and the generated payroll's NET rises at once on Records and Payslip", async ({
  page,
  request,
}) => {
  await openAs(page, `${FEB}&tab=salary`);
  await expect(page.getByRole("tab", { name: /^Excess\b/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("excess-title")).toHaveText("Excess & Detection · February 2026", { timeout: 30_000 });
  await expect(page.getByTestId("excess-empty")).toBeVisible();
  await expect(page.getByTestId("excess-not-generated-note")).toHaveCount(0);

  await page.getByTestId("excess-add-open").click();
  const dialog = page.getByTestId("excess-add-dialog");
  // nothing is saved without an amount, a remark and an employee
  await dialog.getByTestId("excess-add-save").click();
  await expect(dialog.getByTestId("excess-amount-error")).toHaveText("Enter an amount.");
  await expect(dialog.getByTestId("excess-remark-error")).toHaveText("A remark is required.");
  await expect(dialog.getByTestId("excess-picker-error")).toHaveText("Pick at least one employee.");
  // an inactive employee is listed but cannot be picked, with the reason; one with no salary neither
  await dialog.getByTestId("excess-picker-search").fill("E2EXS1");
  await expect(dialog.getByTestId(`excess-option-${ids.inactiveStaff}`)).toBeDisabled();
  await expect(dialog.getByTestId(`excess-option-${ids.inactiveStaff}`)).toContainText("Inactive employee");
  await dialog.getByTestId("excess-picker-search").fill("E2E003");
  await expect(dialog.locator('[data-testid^="excess-option-"]').first()).toContainText(
    "No monthly salary on the profile",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // the server refuses a missing remark too
  const noRemark = await api(request, "POST", "/api/payroll-excess/entries", {
    ...MONTH,
    kind: "excess",
    amount: 2000,
    remark: "",
    employeeIds: [ids.asha],
  });
  expect(noRemark.status).toBe(400);
  expect(noRemark.body.error).toMatch(/remark/i);

  await addOnScreen(page, {
    kind: "excess",
    amount: "2000",
    remark: "Festival incentive approved by MD",
    search: "E2E001",
    employeeIds: [ids.asha],
  });
  // the breakdown: earned 24,000 -> 26,000, and the payroll's NET with it
  const row = page.getByTestId("excess-row-E2E001");
  await expect(row).toBeVisible();
  await expect(page.getByTestId("excess-row-excess-E2E001")).toContainText("₹2,000");
  await expect(page.getByTestId("excess-row-earned-E2E001")).toContainText("₹24,000 → ₹26,000");
  await expect(page.getByTestId("excess-row-netpay-E2E001")).toContainText("₹26,000");
  await expect(page.getByTestId("excess-kpi-excess-value")).toHaveText("₹2,000");
  await expect(page.getByTestId("excess-kpi-entries-value")).toHaveText("1");

  // the generated payroll changed at once: no Generate again needed
  const payroll = await staffPayroll(request, "E2E001");
  expect([Number(payroll.bonus), Number(payroll.finalSalary)]).toEqual([2000, 26000]);
  await page.goto(`${FEB}&layout=cards`);
  await expect(page.getByTestId(`payroll-record-net-${ids.ashaPayroll}`)).toHaveText("₹26,000", { timeout: 30_000 });
  await page.goto(`${FEB}&tab=payslip`);
  await expect(page.getByTestId(`ps-row-${ids.ashaPayroll}-excess`)).toHaveText("+₹2,000", { timeout: 30_000 });
  await expect(page.getByTestId(`ps-row-${ids.ashaPayroll}-net`)).toHaveText("₹26,000");
});

test("staff: Generate again keeps the excess, and the payroll itself no longer takes a bonus", async ({
  page,
  request,
}) => {
  await openAs(page, `${FEB}&layout=cards`);
  await expect(page.getByTestId(`payroll-record-net-${ids.ashaPayroll}`)).toHaveText("₹26,000", { timeout: 30_000 });
  await page.getByTestId("staff-generate-open").click();
  // the run belongs to the page (it goes on in the background): wait for the server to finish it
  const run = page.waitForResponse(
    (r) => r.url().includes("/api/payroll/generate") && r.request().method() === "POST",
    { timeout: 60_000 },
  );
  await page.getByTestId("staff-generate-dialog").getByTestId("staff-generate-confirm").click();
  expect((await run).status()).toBe(201);
  const p = await staffPayroll(request, "E2E001");
  expect([Number(p.bonus), Number(p.finalSalary)]).toEqual([2000, 26000]);
  await page.reload();
  await expect(page.getByTestId(`payroll-record-net-${ids.ashaPayroll}`)).toHaveText("₹26,000", { timeout: 30_000 });
  // and once more through the API
  expect((await api(request, "POST", "/api/payroll/generate", MONTH)).status).toBe(201);
  expect(Number((await staffPayroll(request, "E2E001")).finalSalary)).toBe(26000);

  // a bonus typed on the payroll would be lost on the next Generate again: refused, with where to go instead
  const refused = await api(request, "PATCH", `/api/payroll/${ids.ashaPayroll}`, { bonus: 5000 });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain("Add an excess or a detection on the Excess tab instead");
  // an old client sending the same value back is accepted, and nothing moves
  expect((await api(request, "PATCH", `/api/payroll/${ids.ashaPayroll}`, { bonus: 2000 })).status).toBe(200);
  expect(Number((await staffPayroll(request, "E2E001")).finalSalary)).toBe(26000);
});

test("staff: a Detection lowers the NET; changing and removing an entry need a reason", async ({ page, request }) => {
  await openAs(page, `${FEB}&tab=salary`);
  await expect(page.getByTestId("excess-row-E2E001")).toBeVisible({ timeout: 30_000 });
  await addOnScreen(page, {
    kind: "detection",
    amount: "500",
    remark: "Uniform not returned",
    search: "E2E001",
    employeeIds: [ids.asha],
  });
  await expect(page.getByTestId("excess-row-detection-E2E001")).toContainText("₹500");
  await expect(page.getByTestId("excess-row-netpay-E2E001")).toContainText("₹25,500");
  expect(Number((await staffPayroll(request, "E2E001")).finalSalary)).toBe(25500);

  const entries = (await entriesOf(request, "staff"))["E2E001"];
  const excess = entries.find((e) => e.kind === "excess")!;
  const detection = entries.find((e) => e.kind === "detection")!;
  await page.getByTestId("excess-row-toggle-E2E001").click();
  await expect(page.getByTestId(`excess-entry-remark-${excess.id}`)).toHaveText("Festival incentive approved by MD");

  // change: 2,000 -> 2,500, refused without a reason
  await page.getByTestId(`excess-entry-change-${excess.id}`).click();
  const change = page.getByTestId("excess-change-dialog");
  await change.getByTestId("excess-change-amount").fill("2500");
  await expect(change.getByTestId("excess-change-preview")).toHaveText("₹2,000 → ₹2,500 (+₹500)");
  await change.getByTestId("excess-change-save").click();
  await expect(change.getByTestId("excess-change-reason-error")).toHaveText("A reason is required.");
  const noReason = await api(request, "PATCH", `/api/payroll-excess/entries/${excess.id}`, { amount: 2500 });
  expect(noReason.status).toBe(400);
  await change.getByTestId("excess-change-reason").fill("Corrected after MD approval");
  await change.getByTestId("excess-change-save").click();
  await expect(change).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("excess-row-netpay-E2E001")).toContainText("₹26,000");
  expect(Number((await staffPayroll(request, "E2E001")).finalSalary)).toBe(26000);

  // remove the detection, refused without a reason
  await page.getByTestId(`excess-entry-remove-${detection.id}`).click();
  const remove = page.getByTestId("excess-remove-dialog");
  await remove.getByTestId("excess-remove-save").click();
  await expect(remove.getByTestId("excess-remove-reason-error")).toHaveText("A reason is required.");
  const noReasonRemove = await api(request, "POST", "/api/payroll-excess/remove", { entryIds: [detection.id] });
  expect(noReasonRemove.status).toBe(400);
  await remove.getByTestId("excess-remove-reason").fill("Added by mistake");
  await remove.getByTestId("excess-remove-save").click();
  await expect(remove).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId(`excess-entry-${detection.id}`)).toHaveCount(0);
  await expect(page.getByTestId("excess-row-netpay-E2E001")).toContainText("₹26,500");
  const payroll = await staffPayroll(request, "E2E001");
  expect([Number(payroll.bonus), Number(payroll.finalSalary)]).toEqual([2500, 26500]);
});

test("staff: the history lists who did what and when, the amount before and after, and the remark", async ({
  page,
  request,
}) => {
  const history = await api(request, "GET", `/api/payroll-excess/history?month=2&year=2026&employeeId=${ids.asha}`);
  expect(history.status).toBe(200);
  const items = history.body.items as any[];
  // newest first: the removal, the change, the detection, the excess
  expect(items.map((i) => [i.action, i.kind, i.previousAmount, i.newAmount])).toEqual([
    ["removed", "detection", 500, null],
    ["changed", "excess", 2000, 2500],
    ["added", "detection", null, 500],
    ["added", "excess", null, 2000],
  ]);
  expect(items.map((i) => i.remark)).toEqual([
    "Added by mistake",
    "Corrected after MD approval",
    "Uniform not returned",
    "Festival incentive approved by MD",
  ]);
  expect(new Set(items.map((i) => i.by))).toEqual(new Set(["E2E Admin"]));
  for (const i of items) expect(Number.isNaN(new Date(i.at).getTime())).toBe(false);
  // each one moved the generated payroll's NET
  const [removed, changed, , added] = items;
  expect([changed.payrollNetBefore, changed.payrollNetAfter]).toEqual([25500, 26000]);
  expect([removed.payrollNetBefore, removed.payrollNetAfter]).toEqual([26000, 26500]);
  expect([added.payrollNetBefore, added.payrollNetAfter]).toEqual([24000, 26000]);

  await openAs(page, `${FEB}&tab=salary&exview=history`);
  const table = page.getByTestId("excess-history-table");
  await expect(table).toBeVisible({ timeout: 30_000 });
  const changedRow = page.getByTestId(`excess-history-row-${changed.id}`);
  for (const text of [
    "Changed",
    "₹2,000 → ₹2,500",
    "Corrected after MD approval",
    "E2E Admin",
    "Asha Kumar",
    "₹25,500 → ₹26,000",
    dayOf(changed.at),
  ])
    await expect(changedRow).toContainText(text);
  const removedRow = page.getByTestId(`excess-history-row-${removed.id}`);
  for (const text of ["Removed", "₹500 removed", "Added by mistake", "E2E Admin"])
    await expect(removedRow).toContainText(text);
  await expect(page.getByTestId(`excess-history-row-${added.id}`)).toContainText("New ₹2,000");
  // the filters narrow it: only what was removed
  await page.getByTestId("excess-history-action").click();
  await page.getByRole("option", { name: "Removed" }).click();
  await expect(page.getByTestId(`excess-history-row-${removed.id}`)).toBeVisible();
  await expect(page.getByTestId(`excess-history-row-${changed.id}`)).toHaveCount(0);
});

test("staff: one amount for several employees at once, the search narrows the breakdown and its Excel follows", async ({
  page,
  request,
}) => {
  await openAs(page, `${FEB}&tab=salary`);
  await expect(page.getByTestId("excess-row-E2E001")).toBeVisible({ timeout: 30_000 });
  await addOnScreen(page, {
    kind: "excess",
    amount: "1000",
    remark: "Attendance bonus for the stitching floor",
    search: "E2E00",
    employeeIds: [ids.asha, ids.ravi],
  });
  await expect(page.getByTestId("excess-row-netpay-E2E002")).toContainText("₹16,000");
  await expect(page.getByTestId("excess-row-netpay-E2E001")).toContainText("₹27,500");
  const bulk = Object.values(await entriesOf(request, "staff"))
    .flat()
    .filter((e) => e.source === "bulk");
  expect(bulk.map((e) => e.amount)).toEqual([1000, 1000]);

  await page.getByTestId("excess-search").fill("Ravi");
  await expect(page).toHaveURL(/exq=Ravi/);
  await expect(page.getByTestId("excess-shown-count")).toHaveText("Showing 1 of 2 employees");
  await expect(page.getByTestId("excess-row-E2E001")).toHaveCount(0);
  await page.getByTestId("excess-export").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("excess-export-excess-xlsx").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^Excess_Detection.*\.xlsx$/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile((await download.path())!);
  const codes: string[] = [];
  book.worksheets[0].eachRow((r) => {
    const code = String(r.getCell(3).value ?? "");
    if (/^E2E/.test(code)) codes.push(code);
  });
  expect(codes).toEqual(["E2E002"]);

  // both bulk entries removed in one go, with one reason
  await page.getByTestId("excess-filters-clear").click();
  await page.getByTestId("excess-toggle-all-entries").click();
  for (const e of bulk) await page.getByTestId(`excess-entry-pick-${e.id}`).click();
  await expect(page.getByTestId("excess-picked-entries")).toContainText("2");
  await page.getByTestId("excess-bulk-remove").click();
  const remove = page.getByTestId("excess-remove-dialog");
  await expect(remove.getByTestId("excess-remove-totals")).toContainText("Excess taken back: ₹2,000");
  await remove.getByTestId("excess-remove-reason").fill("Paid with the next month instead");
  await remove.getByTestId("excess-remove-save").click();
  await expect(remove).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("excess-row-E2E002")).toHaveCount(0);
  expect(Number((await staffPayroll(request, "E2E002")).finalSalary)).toBe(15000);
  expect(Number((await staffPayroll(request, "E2E001")).finalSalary)).toBe(26500);
});

test("staff: Not included lists everyone left out of the month's payroll, with the reason", async ({
  page,
  request,
}) => {
  const res = await api(request, "GET", "/api/payroll/not-included?month=2&year=2026");
  expect(res.status).toBe(200);
  expect(res.body.generated).toBe(true);
  const byCode = Object.fromEntries((res.body.employees as any[]).map((e) => [e.code, e]));
  expect(byCode.E2EXS1).toMatchObject({ reasonCode: "inactive", category: "staff", status: "inactive" });
  expect(byCode.E2E003).toMatchObject({ reasonCode: "no_salary" });
  expect(byCode.E2E001).toBeUndefined();
  expect(byCode.E2E002).toBeUndefined();
  // the production workers are paid elsewhere, and say so
  expect(byCode["PX-W1"]).toMatchObject({ reasonCode: "production", category: "production" });

  await openAs(page, `${FEB}&view=not_included`);
  await expect(page.getByTestId("view-not_included")).toHaveAttribute("aria-selected", "true");
  const view = page.getByTestId("not-included-view");
  await expect(view).toBeVisible({ timeout: 30_000 });
  // staff first: the category filter opens on Staff, so the production workers are not listed
  await expect(page.getByTestId("ni-category")).toContainText("Staff");
  const rows = view.locator('li[data-testid^="ni-row-"]');
  await expect(rows.first()).toBeVisible();
  await expect(page.getByTestId(`ni-row-${ids.worker}`)).toHaveCount(0);
  // the search narrows it to one
  await page.getByTestId("ni-search").fill("E2EXS1");
  await expect(rows).toHaveCount(1);
  const row = page.getByTestId(`ni-row-${ids.inactiveStaff}`);
  await expect(row).toHaveAttribute("data-reason", "inactive");
  await expect(page.getByTestId(`ni-row-${ids.inactiveStaff}-reason`)).toHaveText(
    "Inactive employee: inactive employees are left out of the payroll.",
  );
  await page.getByTestId("ni-search").fill("E2E003");
  await expect(page.getByTestId(`ni-row-${byCode.E2E003.id}-reason`)).toHaveText("No monthly salary on the profile.");
  // the payroll's own employees are not here
  await page.getByTestId("ni-search").fill("E2E001");
  await expect(rows).toHaveCount(0);
});

test("staff: the Payslip tab lists only the payroll's employees, with the breakdown, and downloads the PDF", async ({
  page,
  request,
}) => {
  const res = await api(request, "GET", "/api/payslips/staff?month=2&year=2026");
  expect(res.status).toBe(200);
  expect((res.body.rows as any[]).map((r) => r.code).sort()).toEqual(["E2E001", "E2E002"]);
  const asha = (res.body.rows as any[]).find((r) => r.code === "E2E001");
  expect(asha).toMatchObject({ excess: 2500, detection: 0, net: 26500 });
  expect(asha.earnings).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: "Excess (added by HR)", amount: 2500 })]),
  );

  await openAs(page, `${FEB}&tab=payslip`);
  const tab = page.getByTestId("staff-payslips-tab");
  await expect(page.getByTestId("ps-heading")).toHaveText("February 2026 · 2 payslips", { timeout: 30_000 });
  await expect(page.getByTestId("ps-list")).toContainText("Asha Kumar");
  await expect(page.getByTestId("ps-list")).toContainText("Ravi Nair");
  // not in the payroll: no payslip
  await expect(tab).not.toContainText("Meena Nosalary");
  await expect(tab).not.toContainText("Kavya Exstaff");
  await expect(page.getByTestId("ps-kpi-excess-value")).toHaveText("₹2,500");
  await expect(page.getByTestId(`ps-row-${ids.ashaPayroll}-net`)).toHaveText("₹26,500");

  // the payslip's breakdown: the lines the PDF prints
  await page.getByTestId(`ps-row-${ids.ashaPayroll}-open`).click();
  const sheet = page.getByTestId("ps-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("ps-sheet-earnings")).toContainText("Excess (added by HR)");
  await expect(sheet.getByTestId("ps-sheet-net")).toContainText("₹26,500.00");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // one employee's PDF, then every payslip listed in one PDF
  const [one] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId(`ps-row-${ids.ashaPayroll}-download`).click(),
  ]);
  expect(one.suggestedFilename()).toBe("Payslip-E2E001-February-2026.pdf");
  expect(await pdfHead(one)).toBe("%PDF-");
  const [all] = await Promise.all([page.waitForEvent("download"), page.getByTestId("ps-download-all").click()]);
  expect(all.suggestedFilename()).toBe("Payslips-February-2026.pdf");
  expect(await pdfHead(all)).toBe("%PDF-");
});

// ── Production Payroll (Weekly, 2 Mar - 8 Mar 2026) ────────────────────────────────────────────────────────────────────

test("production: an Excess raises the period's NET at once, Generate again keeps it, a Detection lowers it", async ({
  page,
  request,
}) => {
  const before = await workerPayroll(request);
  expect(before, "PX-W1 has a payroll for the week").toBeTruthy();
  const base = Number(before.finalSalary);

  await openAs(page, `${WEEKLY}&tab=salary`);
  await expect(page.getByRole("tab", { name: /^Excess\b/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("excess-tab")).toHaveAttribute("data-kind", "production");
  await expect(page.getByTestId("excess-title")).toContainText(/Weekly .*2 Mar.*8 Mar 2026/, { timeout: 30_000 });

  // the inactive worker is offered but cannot be picked
  await page.getByTestId("excess-add-open").click();
  const dialog = page.getByTestId("excess-add-dialog");
  await dialog.getByTestId("excess-picker-search").fill("PX-W");
  await expect(dialog.getByTestId(`excess-option-${ids.inactiveWorker}`)).toBeDisabled();
  await expect(dialog.getByTestId(`excess-option-${ids.inactiveWorker}`)).toContainText("Inactive employee");
  await page.keyboard.press("Escape");

  await addOnScreen(page, {
    kind: "excess",
    amount: "1500",
    remark: "Extra pieces finished on Sunday",
    search: "PX-W1",
    employeeIds: [ids.worker],
  });
  await expect(page.getByTestId("excess-row-excess-PX-W1")).toContainText("₹1,500");
  const raised = base + 1500;
  const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
  await expect(page.getByTestId("excess-row-netpay-PX-W1")).toContainText(inr(raised));
  expect(Number((await workerPayroll(request)).finalSalary)).toBe(raised);

  // the Payslip tab of the period has it at once
  const payrollId = before.id as number;
  await page.goto(`${WEEKLY}&tab=payslip`);
  await expect(page.getByTestId(`ps-row-${payrollId}-excess`)).toHaveText("+₹1,500", { timeout: 30_000 });
  await expect(page.getByTestId(`ps-row-${payrollId}-net`)).toHaveText(inr(raised));

  // Generate again (Employees tab) keeps it
  await page.goto(`${WEEKLY}&tab=employees`);
  await page.getByTestId("pcp-regenerate-PX-W1").click({ timeout: 30_000 });
  const run = page.waitForResponse(
    (r) => r.url().includes("/api/payroll/production/generate") && r.request().method() === "POST",
    { timeout: 60_000 },
  );
  await page.getByTestId("pcp-regenerate-confirm").click();
  expect((await run).status()).toBe(201);
  await expect(page.getByTestId("pcp-roster-state-PX-W1")).toHaveText(/generated - pending/i, { timeout: 30_000 });
  const again = await workerPayroll(request);
  expect([Number(again.bonus), Number(again.finalSalary)]).toEqual([1500, raised]);
  // the production payroll's own PATCH refuses a bonus too
  const refused = await api(request, "PATCH", `/api/payroll/${payrollId}`, { bonus: 99 });
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain("Add an excess or a detection on the Excess tab instead");

  // a Detection (through the API) lowers it, and the payslip follows
  const detection = await api(request, "POST", "/api/production-payroll-excess/entries", {
    ...PROD_SCOPE,
    kind: "detection",
    amount: 400,
    remark: "Damaged pieces",
    employeeIds: [ids.worker],
  });
  expect(detection.status, JSON.stringify(detection.body)).toBe(200);
  expect(detection.body.payrollUpdated).toBe(1);
  expect(Number((await workerPayroll(request)).finalSalary)).toBe(raised - 400);
  await page.goto(`${WEEKLY}&tab=payslip`);
  await expect(page.getByTestId(`ps-row-${payrollId}-detection`)).toHaveText("−₹400", { timeout: 30_000 });
  await expect(page.getByTestId(`ps-row-${payrollId}-net`)).toHaveText(inr(raised - 400));

  // removing it needs a reason, and puts the NET back
  const detectionId = detection.body.created[0].id as number;
  await page.goto(`${WEEKLY}&tab=salary`);
  await page.getByTestId("excess-row-toggle-PX-W1").click({ timeout: 30_000 });
  await page.getByTestId(`excess-entry-remove-${detectionId}`).click();
  const remove = page.getByTestId("excess-remove-dialog");
  await remove.getByTestId("excess-remove-save").click();
  await expect(remove.getByTestId("excess-remove-reason-error")).toHaveText("A reason is required.");
  await remove.getByTestId("excess-remove-reason").fill("Pieces were repaired");
  await remove.getByTestId("excess-remove-save").click();
  await expect(remove).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId("excess-row-netpay-PX-W1")).toContainText(inr(raised));
  expect(Number((await workerPayroll(request)).finalSalary)).toBe(raised);

  // the history of the period: the three changes, by whom
  await page.getByTestId("excess-view-history").click();
  await expect(page).toHaveURL(/exview=history/);
  const table = page.getByTestId("excess-history-table");
  await expect(table.locator('tr[data-testid^="excess-history-row-"]')).toHaveCount(3, { timeout: 30_000 });
  await expect(table).toContainText("Extra pieces finished on Sunday");
  await expect(table).toContainText("₹400 removed");
  await expect(table).toContainText("Pieces were repaired");
  await expect(table).toContainText("E2E Admin");
});

test("production: Not included gives the inactive worker's reason; the Payslip tab lists only the period's payroll", async ({
  page,
  request,
}) => {
  const res = await api(
    request,
    "GET",
    `/api/payroll/production/not-included?cycle=weekly&periodStart=${WEEK.periodStart}&periodEnd=${WEEK.periodEnd}`,
  );
  expect(res.status).toBe(200);
  const byCode = Object.fromEntries((res.body.employees as any[]).map((e) => [e.code, e]));
  expect(byCode["PX-W2"]).toMatchObject({ reasonCode: "inactive", category: "production" });
  expect(byCode["PX-W1"]).toBeUndefined();
  expect(byCode.E2E001).toMatchObject({ reasonCode: "staff" });

  await openAs(page, `${WEEKLY}&view=not_included`);
  const view = page.getByTestId("not-included-view");
  await expect(view).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("ni-category")).toContainText("Production");
  await page.getByTestId("ni-search").fill("PX-W");
  await expect(view.locator('li[data-testid^="ni-row-"]')).toHaveCount(1);
  await expect(page.getByTestId(`ni-row-${ids.inactiveWorker}`)).toHaveAttribute("data-reason", "inactive");
  await expect(page.getByTestId(`ni-row-${ids.inactiveWorker}-reason`)).toHaveText(
    "Inactive employee: inactive workers are left out of the payroll.",
  );

  const slips = await api(
    request,
    "GET",
    `/api/payslips/production?cycle=weekly&periodStart=${WEEK.periodStart}&periodEnd=${WEEK.periodEnd}`,
  );
  expect(slips.status).toBe(200);
  expect((slips.body.rows as any[]).map((r) => r.code)).toEqual(["PX-W1"]);
  const payrollId = slips.body.rows[0].payrollId as number;

  await page.goto(`${WEEKLY}&tab=payslip`);
  const tab = page.getByTestId("pcp-payslip-tab");
  await expect(page.getByTestId("ps-heading")).toContainText("1 payslip", { timeout: 30_000 });
  await expect(page.getByTestId("ps-list")).toContainText("Lakshmi Exworker");
  await expect(tab).not.toContainText("Mohan Exworker");
  await expect(page.getByTestId(`ps-row-${payrollId}-excess`)).toHaveText("+₹1,500");
  const [pdf] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId(`ps-row-${payrollId}-download`).click(),
  ]);
  expect(pdf.suggestedFilename()).toBe("Payslip-PX-W1-Weekly-02Mar-08Mar2026.pdf");
  expect(await pdfHead(pdf)).toBe("%PDF-");
});
