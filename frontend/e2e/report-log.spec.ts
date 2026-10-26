import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import { expect, test, type Download, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// Report Log: the three sub-tabs (Monthly Report, Daily Leave Report, Daily Late Report), the tab in the address, and the late /
// leave lists with their downloads. The late list reads the attendance engine's own late flag, so the world below is made with
// real punches on a fixed Monday: a staff shift 09:00 with 15 minutes of grace, and arrivals at 09:21 / 09:34 / 09:41 (late), 09:05
// (on time) and none (absent). Everything made here is named "RL ..." or has the code "RL-..." and is removed again.

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
    [ids.babu, "09:41"],
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

test("the Daily Late Report lists the staff the engine marked late, per unit, with the first punch", async ({
  page,
}) => {
  await openLate(page);

  await expect(page.getByTestId("late-sheet-title")).toHaveText("03.08.26 STAFF LATE REPORT");
  const sheet = page.getByTestId("late-sheet");
  // head office first (labelled HO), then the other unit (Unit<n> reads U-<n>)
  const labels = sheet.locator("[data-testid^='late-sheet-unit-']");
  await expect(labels).toHaveText(["HO", UNIT]);
  await expect(sheet.getByRole("columnheader")).toHaveText([
    "S.No",
    "Ticket No",
    "Employee Name",
    "Designation",
    "Late Hours",
  ]);

  const lokesh = sheet.getByRole("row", { name: /RL-01/ });
  await expect(lokesh).toContainText("Lokesh Latecomer");
  await expect(lokesh).toContainText("RL Accounts Asst");
  await expect(lokesh).toContainText("09:21 AM");
  await expect(sheet.getByRole("row", { name: /RL-02/ })).toContainText("09:34 AM");
  await expect(sheet.getByRole("row", { name: /RL-03/ })).toContainText("09:41 AM");
  // the on-time one, the absent one and the production worker (who was late too) are not on it
  await expect(sheet.getByText("RL-04")).toHaveCount(0);
  await expect(sheet.getByText("RL-05")).toHaveCount(0);
  await expect(sheet.getByText("RL-06")).toHaveCount(0);

  // the late cell is yellow, the unit gutter label is boxed
  const cellColor = await lokesh.getByText("09:21 AM").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(cellColor).toBe("rgb(255, 255, 0)");

  // counts per unit and in total
  await expect(page.getByTestId("late-unit-counts")).toContainText("HO · 2");
  await expect(page.getByTestId("late-unit-counts")).toContainText(`${UNIT} · 1`);
  await expect(page.getByTestId("late-unit-counts")).toContainText("Total · 3");
  await expect(page.getByTestId("figure-late-value")).toHaveText("3");
  await expect(page.getByTestId("figure-latest-value")).toHaveText("09:41 AM");
  await expect(page.getByTestId("late-note")).toContainText("production workers are not part of this report");
});

test("the late list agrees with the API's own late flag and carries the new fields", async ({ page }) => {
  await loginAsHr(page);
  const body = (await api(page, "GET", `/api/attendance/report-log?date=${DAY}`)).body as { rows: any[] };
  const rows = Object.fromEntries(body.rows.map((r) => [r.employeeCode, r]));
  expect(rows["RL-01"]).toMatchObject({ isLate: true, firstPunch: "09:21", unitLabel: "HO" });
  expect(rows["RL-03"]).toMatchObject({
    isLate: true,
    firstPunch: "09:41",
    unitLabel: UNIT,
    branchName: "RL Unit Ninety-two",
  });
  expect(rows["RL-04"]).toMatchObject({ isLate: false, firstPunch: "09:05" });
  expect(rows["RL-05"]).toMatchObject({ status: "absent", firstPunch: null });
  expect(rows["RL-06"]).toBeUndefined(); // production
});

test("the late list narrows by search and department, and says so when nobody was late", async ({ page }) => {
  await openLate(page);
  await expect(page.getByTestId("late-sheet")).toBeVisible();

  await page.getByTestId("daily-search").fill("babu");
  await expect(page.getByTestId("late-sheet").getByText("RL-03")).toBeVisible();
  await expect(page.getByTestId("late-sheet").getByText("RL-01")).toHaveCount(0);
  await expect(page.getByTestId("late-unit-counts")).toContainText("Total · 1");
  await page.getByTestId("daily-search").fill("");

  await page.getByTestId("daily-department").click();
  await page.getByRole("option", { name: "RL Production" }).click();
  await expect(page.getByTestId("late-unit-counts")).toContainText(`${UNIT} · 1`);
  await expect(page.getByTestId("late-unit-counts")).not.toContainText("HO ·");

  await page.getByTestId("daily-date").fill(QUIET_DAY);
  await expect(page.getByTestId("late-empty")).toContainText("Nobody was late on 04.08.2026");
  await expect(page.getByTestId("export-excel")).toBeDisabled();
});

test("the Daily Late Report downloads an Excel file, a PDF and an image of the same list", async ({ page }) => {
  await openLate(page);
  await expect(page.getByTestId("late-sheet")).toBeVisible();

  const [excel] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-excel").click()]);
  expect(excel.suggestedFilename()).toBe("03_08_26_STAFF_LATE_REPORT.xlsx");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readDownload(excel)) as unknown as ArrayBuffer);
  const ws = wb.getWorksheet("Report")!;
  expect(ws.getCell("A3").value).toBe("03.08.26 STAFF LATE REPORT");
  expect(ws.getCell("F5").value).toBe("Late Hours");
  expect(ws.getCell("A6").value).toBe("HO");
  expect(ws.getCell("C6").value).toBe("RL-01");
  expect(ws.getCell("F6").value).toBe("09:21 AM");
  expect(ws.getCell("A9").value).toBe(UNIT);
  expect(ws.getCell("F9").value).toBe("09:41 AM");

  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-pdf").click()]);
  expect(pdf.suggestedFilename()).toBe("03_08_26_STAFF_LATE_REPORT.pdf");
  expect((await readDownload(pdf)).subarray(0, 5).toString()).toBe("%PDF-");

  const [image] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-image").click()]);
  expect(image.suggestedFilename()).toBe("03_08_26_STAFF_LATE_REPORT.png");
  expect((await readDownload(image)).subarray(1, 4).toString()).toBe("PNG");
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
  await expect(page.getByTestId("late-sheet")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(tab(page, "Daily Late Report")).toBeVisible();
});
