import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { expect, test, type Download, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// Report Log: the three sub-tabs (Monthly Report, Daily Leave Report, Daily Late Report), the tab in the address, and the
// late / leave lists with their downloads. The late list reads the attendance engine's own late flag, so the world below is
// made with real punches on a fixed Monday: a staff shift 09:00 with 15 minutes of grace (deadline 09:15), and arrivals at
// 09:21 / 09:34 / 10:00 (late by 6, 19 and 45 minutes after the grace), 09:05 (on time) and none (absent). Everything made
// here is named "RL ..." or has the code "RL-..." and is removed again.

const DAY = "2026-08-03"; // a Monday
const QUIET_DAY = "2026-08-04"; // nobody was given a punch (everyone is absent, nobody is late)
// A deleted branch keeps its code for good, so a re-run in the same database needs a code of its own. Unit<n> reads U-<n>.
const UNIT_NO = 100 + Math.floor(Math.random() * 899);
const UNIT = `U-${UNIT_NO}`;

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

async function adminToken(page: Page): Promise<string> {
  const res = await page.request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  return (await res.json()).token as string;
}

async function purge(page: Page) {
  const token = await adminToken(page);
  const list = async (url: string) => ((await api(page, "GET", url, undefined, token)).body ?? []) as any[];
  for (const e of (await list("/api/employees")).filter((e) => e.employeeCode.startsWith("RL-"))) {
    await api(page, "DELETE", `/api/employees/${e.id}`, undefined, token);
  }
  for (const s of (await list("/api/shifts")).filter((s) => s.name.startsWith("RL "))) {
    await api(page, "DELETE", `/api/shifts/${s.id}`, undefined, token);
  }
  for (const d of (await list("/api/designations")).filter((d) => d.title.startsWith("RL "))) {
    await api(page, "DELETE", `/api/designations/${d.id}`, undefined, token);
  }
  for (const d of (await list("/api/departments")).filter((d) => d.name.startsWith("RL "))) {
    await api(page, "DELETE", `/api/departments/${d.id}`, undefined, token);
  }
  for (const b of (await list("/api/branches")).filter((b) => b.name.startsWith("RL "))) {
    await api(page, "DELETE", `/api/branches/${b.id}`, undefined, token);
  }
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await loginAsHr(page);
  await purge(page);

  const make = async (url: string, data: object) => {
    const r = await api(page, "POST", url, data);
    expect(r.status, `${url}: ${JSON.stringify(r.body)}`).toBe(201);
    return r.body.id as number;
  };
  const head = ((await api(page, "GET", "/api/branches")).body as any[]).find((b) => b.isHeadOffice);
  const unit = await make("/api/branches", { name: "RL Unit Ninety-two", code: `Unit${UNIT_NO}` });
  const admin = await make("/api/departments", { name: "RL Admin", branchId: head.id });
  const prod = await make("/api/departments", { name: "RL Production", branchId: unit });
  const accounts = await make("/api/designations", { title: "RL Accounts Asst", departmentId: admin });
  const qc = await make("/api/designations", { title: "RL QC", departmentId: prod });
  const shift = await make("/api/shifts", {
    name: "RL General",
    shiftType: "staff",
    startTime: "09:00",
    endTime: "18:00",
    gracePeriodMinutes: 15,
  });

  const employee = (
    code: string,
    first: string,
    branchId: number,
    departmentId: number,
    designationId: number,
    type = "staff",
  ) =>
    make("/api/employees", {
      employeeCode: code,
      firstName: first,
      lastName: "Latecomer",
      phone: "9000000088",
      gender: "male",
      employmentType: type,
      branchId,
      departmentId,
      designationId,
      salaryType: "monthly",
      ...(type === "staff" ? { salaryAmount: 24000 } : { salaryPerShift: 400 }),
    });
  const ids = {
    lokesh: await employee("RL-01", "Lokesh", head.id, admin, accounts),
    pandi: await employee("RL-02", "Pandiyammal", head.id, admin, accounts),
    babu: await employee("RL-03", "Babu", unit, prod, qc),
    early: await employee("RL-04", "Early", head.id, admin, accounts),
    absent: await employee("RL-05", "Absent", unit, prod, qc),
    worker: await employee("RL-06", "Worker", unit, prod, qc, "production"),
  };

  const assign = await api(page, "POST", "/api/shift-assignments/apply", {
    shiftId: shift,
    effectiveFrom: "2026-01-01",
    selection: { employees: { include: Object.values(ids) } },
  });
  expect(assign.status, JSON.stringify(assign.body)).toBe(201);

  const punch = async (id: number, time: string, type = "IN") => {
    const r = await api(page, "POST", "/api/attendance/manual", {
      employeeId: id,
      date: DAY,
      punchTime: time,
      punchType: type,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  for (const [id, time] of [
    [ids.lokesh, "09:21"],
    [ids.pandi, "09:34"],
    [ids.babu, "10:00"],
    [ids.early, "09:05"],
    [ids.worker, "09:50"],
  ] as const) {
    await punch(id, time);
    await punch(id, "18:00", "OUT");
  }
  await page.close();
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await loginAsHr(page);
  await purge(page);
  await page.close();
});

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });

async function openLate(page: Page, date = DAY) {
  await loginAsHr(page);
  await page.goto("/hr/attendance/report-log?tab=late");
  await page.getByTestId("daily-date").fill(date);
}

/** The two lines the owner did not want (the summary and the explanation) and a totals row are in no export. */
function noExtras(ws: ExcelJS.Worksheet) {
  const text: string[] = [];
  ws.eachRow((row) => row.eachCell((cell) => text.push(String(JSON.stringify(cell.value)))));
  const all = text.join(" | ");
  for (const banned of ["Total late", "Average", "Longest", "Total Minutes Late =", "Total:", "SUM("]) {
    expect(all).not.toContain(banned);
  }
}

/** The hh:mm of an Excel time cell (read back as a date on 1899-12-30, or as the fraction of a day). */
function clockOf(value: unknown): string {
  const minutes =
    value instanceof Date ? value.getUTCHours() * 60 + value.getUTCMinutes() : Math.round(Number(value) * 1440);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

async function readDownload(download: Download): Promise<Buffer> {
  const path = await download.path();
  return readFile(path);
}

test("the page has the three sub-tabs, and Daily Report is now Daily Leave Report", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/attendance/report-log");
  await expect(page.getByRole("heading", { name: "Report Log" })).toBeVisible();
  // (each pill carries its label twice, for the hover animation, so read them by name)
  const tabs = page.getByTestId("report-log-tabs").getByRole("tab");
  await expect(tabs).toHaveCount(3);
  for (const name of ["Monthly Report", "Daily Leave Report", "Daily Late Report"]) {
    await expect(tab(page, name)).toBeVisible();
  }
  await expect(page.getByText("Daily Report", { exact: true })).toHaveCount(0);
  // opens on the Monthly Report: the sheet and the Late-Penalty Breakdown
  await expect(tab(page, "Monthly Report")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("late-penalty")).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous period" })).toBeVisible();
  await expect(page.getByTestId("mode-badge")).toBeVisible();
});

test("the tab is in the address: switching writes it, a refresh and a deep link open the same tab, 'daily' is the leave report", async ({
  page,
}) => {
  await loginAsHr(page);
  await page.goto("/hr/attendance/report-log");

  await tab(page, "Daily Late Report").click();
  await expect(page).toHaveURL(/[?&]tab=late/);
  await expect(page.getByTestId("late-tab")).toBeVisible();
  await page.reload();
  await expect(tab(page, "Daily Late Report")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("late-tab")).toBeVisible();

  await tab(page, "Daily Leave Report").click();
  await expect(page).toHaveURL(/[?&]tab=leave/);
  await page.reload();
  await expect(page.getByTestId("leave-tab")).toBeVisible();

  await tab(page, "Monthly Report").click();
  await expect(page).toHaveURL(/[?&]tab=monthly/);
  await expect(page.getByTestId("monthly-tab")).toBeVisible();

  await page.goto("/hr/attendance/report-log?tab=daily");
  await expect(tab(page, "Daily Leave Report")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("leave-tab")).toBeVisible();

  await page.goto("/hr/attendance/report-log?tab=nonsense");
  await expect(tab(page, "Monthly Report")).toHaveAttribute("aria-selected", "true");
});

test("the Monthly Report keeps the Late-Penalty Breakdown", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/attendance/report-log?tab=monthly");
  await page.getByTestId("late-penalty-toggle").click();
  await expect(page.getByText("Deduction Rule:")).toBeVisible();
  await expect(page.getByTestId("late-penalty").getByText("Late-Penalty Breakdown")).toBeVisible();
});

test("the Daily Late Report is a table of the late staff: shift, grace, punch-in and how late, longest delay first", async ({
  page,
}) => {
  await openLate(page);
  const table = page.getByTestId("late-table");
  await expect(table).toBeVisible();

  // no paper sheet and no preview block (the picture is an off-screen element, not shown on the page)
  await expect(page.getByTestId("late-preview")).toHaveCount(0);
  await expect(page.getByTestId("late-sheet")).toHaveCount(0);
  await expect(page.getByText("STAFF LATE REPORT")).toHaveCount(0);

  // the seven columns after the tick column (each header is a sort button; the last also says what it means)
  await expect(table.getByRole("columnheader")).toHaveCount(8); // the tick column and the seven
  for (const header of [
    "Employee Name",
    "Employee Code",
    "Department",
    "Shift Start Time",
    "Grace Period (minutes)",
    "Actual Punch-In Time",
    "Total Minutes Late",
  ]) {
    await expect(table.getByRole("columnheader", { name: new RegExp(header.replace(/[()]/g, "\\$&")) })).toBeVisible();
  }

  // all seven columns fit a laptop-width page (1280 px with the sidebar open): nothing needs a sideways scroll
  const cut = await table.evaluate((t) => t.parentElement!.scrollWidth - t.parentElement!.clientWidth);
  expect(cut).toBeLessThanOrEqual(1);

  // longest delay first: Babu 45 min, Pandiyammal 19, Lokesh 6
  const rows = table.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Babu Latecomer");
  await expect(rows.nth(1)).toContainText("Pandiyammal Latecomer");
  await expect(rows.nth(2)).toContainText("Lokesh Latecomer");

  // Lokesh: shift 09:00 + 15 min grace = 09:15, punched 09:21: 6 min late, 21 min after the shift start
  const lokesh = page.locator("[data-testid^='late-row-']", { hasText: "RL-01" });
  await expect(lokesh).toContainText("RL Admin");
  await expect(lokesh).toContainText("09:00 AM");
  await expect(lokesh).toContainText("15");
  await expect(lokesh).toContainText("09:21 AM");
  await expect(lokesh.locator("[data-testid^='late-by-']")).toHaveText("6 min");
  await expect(lokesh.locator("[data-testid^='after-start-']")).toHaveText("21 min after shift start");
  await expect(lokesh.locator("[data-testid^='late-by-']")).toHaveAttribute("data-severity", "low");
  const babu = page.locator("[data-testid^='late-row-']", { hasText: "RL-03" });
  await expect(babu.locator("[data-testid^='late-by-']")).toHaveText("45 min");
  await expect(babu.locator("[data-testid^='late-by-']")).toHaveAttribute("data-severity", "high");
  await expect(babu.locator("[data-testid^='after-start-']")).toHaveText("60 min after shift start");
  await expect(babu).toContainText(UNIT);
  const pandi = page.locator("[data-testid^='late-row-']", { hasText: "RL-02" });
  await expect(pandi.locator("[data-testid^='late-by-']")).toHaveAttribute("data-severity", "mid");

  // the on-time one, the absent one and the production worker (who was late too) are not on it
  await expect(table.getByText("RL-04")).toHaveCount(0);
  await expect(table.getByText("RL-05")).toHaveCount(0);
  await expect(table.getByText("RL-06")).toHaveCount(0);

  // the legend, the help line and the figures
  await expect(page.getByTestId("severity-legend")).toContainText("1-10 min");
  await expect(page.getByTestId("severity-legend")).toContainText("11-30 min");
  await expect(page.getByTestId("severity-legend")).toContainText("31+ min");
  await expect(page.getByTestId("late-note")).toContainText("punch-in time minus (shift start + grace)");
  await expect(page.getByTestId("late-note")).toContainText("production workers are not part of this report");
  await expect(page.getByTestId("late-summary")).toContainText("3 late");
  await expect(page.getByTestId("late-summary")).toContainText("average 23.3 min");
  await expect(page.getByTestId("late-summary")).toContainText("longest 45 min (Babu Latecomer)");
  await expect(page.getByTestId("figure-late-value")).toHaveText("3");
  await expect(page.getByTestId("figure-latest-value")).toHaveText("10:00 AM");
});

test("a column header sorts the late list, a second click flips it", async ({ page }) => {
  await openLate(page);
  const order = async () =>
    (await page.getByTestId("late-name").allTextContents()).map((t) => t.replace(" Latecomer", ""));
  await expect(page.getByTestId("late-table").locator("tbody tr")).toHaveCount(3);
  expect(await order()).toEqual(["Babu", "Pandiyammal", "Lokesh"]);

  await page.getByTestId("sort-name").click();
  expect(await order()).toEqual(["Babu", "Lokesh", "Pandiyammal"]);
  await expect(page.getByRole("columnheader", { name: /Employee Name/ })).toHaveAttribute("aria-sort", "ascending");
  await page.getByTestId("sort-name").click();
  expect(await order()).toEqual(["Pandiyammal", "Lokesh", "Babu"]);

  await page.getByTestId("sort-punchIn").click();
  expect(await order()).toEqual(["Lokesh", "Pandiyammal", "Babu"]);
  await page.getByTestId("sort-minutesLate").click();
  expect(await order()).toEqual(["Babu", "Pandiyammal", "Lokesh"]);
  await page.getByTestId("sort-minutesLate").click();
  expect(await order()).toEqual(["Lokesh", "Pandiyammal", "Babu"]);
});

test("late list: tick rows, then Excel / PDF / Image hold only the ticked rows, or every row when none is ticked", async ({
  page,
}) => {
  await openLate(page);
  const lateRows = page.locator("[data-testid^='late-row-']");
  await expect(lateRows).toHaveCount(3);
  const tick = (code: string) => lateRows.filter({ hasText: code }).getByRole("checkbox").click();
  const headerBox = page.getByTestId("select-all");
  const scope = page.getByTestId("export-scope");
  const downloadSheet = async () => {
    const [file] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-excel").click()]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await readDownload(file)) as unknown as ArrayBuffer);
    return wb.getWorksheet("Daily Late Report")!;
  };

  // nothing ticked: "Showing 3 of 3", every row is exported, and the buttons say so
  await expect(page.getByTestId("late-result-line")).toContainText("Showing 3 of 3 late employees");
  await expect(page.getByTestId("late-selected-count")).toHaveText("0");
  await expect(scope).toHaveText("Exporting all 3");
  await expect(headerBox).toHaveAttribute("data-state", "unchecked");
  await expect(page.getByTestId("export-excel")).toHaveAttribute("title", /exporting all 3/);
  const everyone = await downloadSheet();
  expect([7, 8, 9].map((r) => everyone.getCell(r, 2).value)).toEqual(["RL-03", "RL-02", "RL-01"]);
  expect(everyone.rowCount).toBe(9); // the header and three rows: nothing after the table
  expect(everyone.getCell("A5").value).toBeNull(); // nothing narrows this list, so no note line
  noExtras(everyone);

  // tick Babu and Lokesh: two selected, the header box is half ticked and the file holds exactly those two
  await tick("RL-03");
  await tick("RL-01");
  await expect(page.getByTestId("late-selected-count")).toHaveText("2");
  await expect(scope).toHaveText("Exporting 2 selected");
  await expect(headerBox).toHaveAttribute("data-state", "indeterminate");
  await expect(lateRows.filter({ hasText: "RL-03" })).toHaveAttribute("data-state", "selected");
  await expect(lateRows.filter({ hasText: "RL-02" })).not.toHaveAttribute("data-state", "selected");
  await expect(page.getByTestId("export-excel")).toHaveAttribute("title", /exporting 2 selected/);
  const two = await downloadSheet();
  expect([7, 8].map((r) => two.getCell(r, 2).value)).toEqual(["RL-03", "RL-01"]);
  expect(two.rowCount).toBe(8); // the header and the two rows: no totals row, no summary
  // the one small note says the file is a selection
  expect(two.getCell("A5").value).toBe("Selected: 2 of 3");
  noExtras(two);

  // a tick belongs to the person, not the position: sorting keeps it, and the file follows the order shown
  await page.getByTestId("sort-name").click();
  await expect(page.getByTestId("late-name").first()).toHaveText("Babu Latecomer");
  await expect(lateRows.filter({ hasText: "RL-03" })).toHaveAttribute("data-state", "selected");
  await expect(lateRows.filter({ hasText: "RL-01" })).toHaveAttribute("data-state", "selected");
  await expect(scope).toHaveText("Exporting 2 selected");
  const sorted = await downloadSheet();
  expect([7, 8].map((r) => sorted.getCell(r, 2).value)).toEqual(["RL-03", "RL-01"]);
  await page.getByTestId("sort-name").click();
  expect((await downloadSheet()).getCell("B7").value).toBe("RL-01");
  await page.getByTestId("sort-minutesLate").click(); // back to the longest delay first

  // the PDF and the picture download with the selection too
  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-pdf").click()]);
  expect(pdf.suggestedFilename()).toBe("Daily_Late_Report_2026-08-03.pdf");
  const [image] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-image").click()]);
  expect(image.suggestedFilename()).toBe("Daily_Late_Report_2026-08-03.png");
  expect((await readDownload(image)).length).toBeGreaterThan(8000);

  // narrowing the list: only the ticked rows still listed count, and the tick comes back with its row
  await page.getByTestId("daily-search").fill("lokesh");
  await expect(lateRows).toHaveCount(1);
  await expect(page.getByTestId("late-result-line")).toContainText("Showing 1 of 3 late employees");
  await expect(page.getByTestId("late-selected-count")).toHaveText("1");
  await expect(scope).toHaveText("Exporting 1 selected");
  await expect(headerBox).toHaveAttribute("data-state", "checked");
  await page.getByTestId("daily-search").fill("pandiyammal");
  await expect(lateRows).toHaveCount(1);
  await expect(page.getByTestId("late-selected-count")).toHaveText("0"); // the ticked people are not in this list
  await expect(scope).toHaveText("Exporting all 1");
  await page.getByTestId("daily-search").fill("");
  await expect(lateRows).toHaveCount(3);
  await expect(page.getByTestId("late-selected-count")).toHaveText("2");

  // select all: every box ticked, the header too, all three exported (and stated as selected)
  await tick("RL-02");
  await expect(headerBox).toHaveAttribute("data-state", "checked");
  await expect(scope).toHaveText("Exporting 3 selected");
  await headerBox.click(); // all ticked: the header box unticks every row
  await expect(page.getByTestId("late-selected-count")).toHaveText("0");
  await expect(headerBox).toHaveAttribute("data-state", "unchecked");
  await expect(scope).toHaveText("Exporting all 3");
  await headerBox.click(); // none ticked: it ticks every row in view
  await expect(page.getByTestId("late-selected-count")).toHaveText("3");
  await expect(lateRows.locator("[data-testid^='late-select-'][data-state='unchecked']")).toHaveCount(0);
  const all = await downloadSheet();
  expect([7, 8, 9].map((r) => all.getCell(r, 2).value)).toEqual(["RL-03", "RL-02", "RL-01"]);
  expect(all.getCell("A5").value).toBe("Selected: 3 of 3");

  // clearing the selection, and a new date starts with none
  await page.getByTestId("late-clear-selection").click();
  await expect(page.getByTestId("late-selected-count")).toHaveText("0");
  await tick("RL-01");
  await expect(page.getByTestId("late-selected-count")).toHaveText("1");
  await page.getByTestId("daily-date").fill(QUIET_DAY);
  await expect(page.getByTestId("late-empty")).toBeVisible();
  await page.getByTestId("daily-date").fill(DAY);
  await expect(lateRows).toHaveCount(3);
  await expect(page.getByTestId("late-selected-count")).toHaveText("0");
});

test("the late rows carry the shift timing from the API: after grace, at least a minute, agreeing with the late flag", async ({
  page,
}) => {
  await loginAsHr(page);
  const body = (await api(page, "GET", `/api/attendance/report-log?date=${DAY}`)).body as { rows: any[] };
  const rows = Object.fromEntries(body.rows.map((r) => [r.employeeCode, r]));
  expect(rows["RL-01"]).toMatchObject({
    isLate: true,
    firstPunch: "09:21",
    unitLabel: "HO",
    shiftStart: "09:00",
    graceMinutes: 15,
    lateDeadline: "09:15",
    minutesAfterStart: 21,
    minutesLate: 6,
  });
  expect(rows["RL-03"]).toMatchObject({
    isLate: true,
    firstPunch: "10:00",
    unitLabel: UNIT,
    branchName: "RL Unit Ninety-two",
    minutesAfterStart: 60,
    minutesLate: 45,
  });
  // on time: the figures of the shift are there, the minutes are not
  expect(rows["RL-04"]).toMatchObject({
    isLate: false,
    firstPunch: "09:05",
    shiftStart: "09:00",
    minutesLate: null,
    minutesAfterStart: null,
  });
  expect(rows["RL-05"]).toMatchObject({ status: "absent", firstPunch: null, minutesLate: null });
  expect(rows["RL-06"]).toBeUndefined(); // production
  for (const row of body.rows) {
    if (row.isLate) expect(row.minutesLate).toBeGreaterThanOrEqual(1);
    else expect(row.minutesLate).toBeNull();
  }
});

test("the late list narrows by search and department, and says so when nobody was late", async ({ page }) => {
  await openLate(page);
  await expect(page.getByTestId("late-table")).toBeVisible();

  const lateRows = page.locator("[data-testid^='late-row-']");
  await page.getByTestId("daily-search").fill("babu");
  await expect(lateRows).toHaveCount(1);
  await expect(lateRows).toContainText("RL-03");
  await expect(page.getByTestId("figure-late-value")).toHaveText("1");
  await page.getByTestId("daily-search").fill("");
  await expect(lateRows).toHaveCount(3);

  await page.getByTestId("daily-department").click();
  await page.getByRole("option", { name: "RL Production" }).click();
  await expect(page.getByTestId("figure-late-value")).toHaveText("1");
  await expect(page.getByTestId("figure-units-value")).toHaveText("1");
  await expect(lateRows).toHaveCount(1);
  await expect(lateRows).toContainText("RL-03");

  await page.getByTestId("daily-date").fill(QUIET_DAY);
  await expect(page.getByTestId("late-empty")).toContainText("Nobody was late on 04.08.2026");
  await expect(page.getByTestId("export-excel")).toBeDisabled();
  await expect(page.getByTestId("export-pdf")).toBeDisabled();
  await expect(page.getByTestId("export-image")).toBeDisabled();
});

test("the Daily Late Report downloads an Excel file, a PDF and an image of the list as sorted on the page", async ({
  page,
}) => {
  await openLate(page);
  await expect(page.getByTestId("late-table")).toBeVisible();
  await expect(page.getByTestId("export-excel")).toBeEnabled();
  await expect(page.getByTestId("export-pdf")).toBeEnabled();
  await expect(page.getByTestId("export-image")).toBeEnabled();

  const [excel] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-excel").click()]);
  expect(excel.suggestedFilename()).toBe("Daily_Late_Report_2026-08-03.xlsx");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readDownload(excel)) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet("Daily Late Report")!;
  expect(ws.getCell("A3").value).toBe("Daily Late Report");
  expect(String(ws.getCell("A4").value)).toContain("Mon, 3 Aug 2026");
  expect(String(ws.getCell("A4").value)).toContain("Generated:");
  noExtras(ws);
  expect([1, 2, 3, 4, 5, 6, 7].map((c) => ws.getCell(6, c).value)).toEqual([
    "Employee Name",
    "Employee Code",
    "Department",
    "Shift Start Time",
    "Grace Period (minutes)",
    "Actual Punch-In Time",
    "Total Minutes Late",
  ]);
  // longest delay first, as on the page
  expect(ws.getCell("A7").value).toBe("Babu Latecomer");
  expect(ws.getCell("B7").value).toBe("RL-03");
  expect(ws.getCell("C7").value).toBe("RL Production");
  expect(clockOf(ws.getCell("D7").value)).toBe("09:00"); // a real Excel time, shown as hh:mm AM/PM
  expect(ws.getCell("E7").value).toBe(15);
  expect(clockOf(ws.getCell("F7").value)).toBe("10:00");
  expect(ws.getCell("G7").value).toBe(45);
  expect(ws.getCell("G9").value).toBe(6);
  expect(ws.rowCount).toBe(9);
  expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 6 });
  expect(ws.autoFilter).toBeTruthy();

  // the file follows the order chosen on the page
  await page.getByTestId("sort-name").click();
  const [byName] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-excel").click()]);
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load((await readDownload(byName)) as unknown as ArrayBuffer);
  expect(wb2.getWorksheet("Daily Late Report")!.getCell("A7").value).toBe("Babu Latecomer");
  expect(wb2.getWorksheet("Daily Late Report")!.getCell("A8").value).toBe("Lokesh Latecomer");

  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-pdf").click()]);
  expect(pdf.suggestedFilename()).toBe("Daily_Late_Report_2026-08-03.pdf");
  const bytes = await readDownload(pdf);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  expect(bytes.length).toBeGreaterThan(2000);

  // the picture: a real PNG of the new report (not the old paper sample), wide and tall enough to read
  const [image] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-image").click()]);
  expect(image.suggestedFilename()).toBe("Daily_Late_Report_2026-08-03.png");
  const png = await readDownload(image);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect(png.length).toBeGreaterThan(8000);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(width).toBeGreaterThanOrEqual(2000); // 1148 px wide, taken at twice that for sharpness
  expect(height).toBeGreaterThan(500);
});

test("the Daily Leave Report lists the absent staff, keeps the Informed call and downloads the STAFF LEAVE LIST", async ({
  page,
}) => {
  await loginAsHr(page);
  await page.goto("/hr/attendance/report-log?tab=leave");
  await page.getByTestId("daily-date").fill(DAY);
  await page.getByTestId("daily-search").fill("RL-0");

  // only the absent one: the late and on-time staff punched in
  const row = page.getByTestId(/^leave-row-/);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("RL-05");
  await expect(row).toContainText(UNIT);
  await expect(page.getByTestId("figure-absent-value")).toHaveText("1");

  // nothing ticked: the downloads are off
  await expect(page.getByTestId("export-excel")).toBeDisabled();
  await row.getByRole("checkbox").click();
  await expect(page.getByTestId("selected-count")).toContainText("1");
  await expect(page.getByTestId("export-excel")).toBeEnabled();

  // the call is saved (to the API) and the row and the figures follow
  const absentId = Number((await row.getAttribute("data-testid"))!.replace("leave-row-", ""));
  await page.getByTestId(`informed-${absentId}`).click();
  await page.getByRole("option", { name: "Not informed" }).click();
  await expect(page.getByTestId("figure-not-informed-value")).toHaveText("1");
  const saved = (await api(page, "GET", `/api/attendance/report-log?date=${DAY}&search=RL-05`)).body.rows[0];
  expect(saved.isInformed).toBe(false);

  const [excel] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-excel").click()]);
  expect(excel.suggestedFilename()).toBe("03_08_2026_STAFF_LEAVE_LIST.xlsx");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readDownload(excel)) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet("Report")!;
  expect(ws.getCell("A3").value).toBe("03.08.2026 STAFF LEAVE LIST");
  expect(["B", "C", "D", "E", "F", "G"].map((c) => ws.getCell(`${c}5`).value)).toEqual([
    "S.No",
    "Ticket No",
    "Employee Name",
    "Department",
    "Designation",
    "Remarks",
  ]);
  expect(ws.getCell("A6").value).toBe(UNIT);
  expect(ws.getCell("C6").value).toBe("RL-05");
  expect(ws.getCell("E6").value).toBe("RL Production");
  expect(ws.getCell("G6").value).toBe("Not informed");

  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-pdf").click()]);
  expect(pdf.suggestedFilename()).toBe("03_08_2026_STAFF_LEAVE_LIST.pdf");
  const [image] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-image").click()]);
  expect(image.suggestedFilename()).toBe("03_08_2026_STAFF_LEAVE_LIST.png");

  // put it back
  await page.getByTestId(`informed-${absentId}`).click();
  await page.getByRole("option", { name: "Unset" }).click();
  await expect(page.getByTestId("figure-not-informed-value")).toHaveText("0");
});

test("the page fits a phone: no sideways scroll on the page, tabs and the late list reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLate(page);
  await expect(page.getByTestId("late-table")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(tab(page, "Daily Late Report")).toBeVisible();
  // the late table itself fits the phone too: nothing is cut off at its right edge (the minutes late are the last column)
  const hidden = await page
    .getByTestId("late-table")
    .evaluate((table) => table.parentElement!.scrollWidth - table.parentElement!.clientWidth);
  expect(hidden).toBeLessThanOrEqual(1);
  const chip = page.locator("[data-testid^='late-by-']").first();
  await chip.scrollIntoViewIfNeeded();
  await expect(chip).toBeInViewport({ ratio: 1 });
});
