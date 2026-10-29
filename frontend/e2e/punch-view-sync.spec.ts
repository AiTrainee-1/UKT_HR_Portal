import ExcelJS from "exceljs";
import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Punch View's Excel round trip now SYNCHRONISES the system with the uploaded file: a row deleted from the sheet deletes
// its punch (after a confirmation that says how many), and Cancel deletes nothing. Everything made here is on 2026-01-12
// for the seeded employees E2E001 / E2E002, and is removed again through the same feature.

const DAY = "2026-01-12";
const PAGE = `/hr/attendance/punch-view`;

async function token(page: Page) {
  return page.evaluate(() => localStorage.getItem("uk_textile_token"));
}

async function workbookBuffer(rows: (string | number | null)[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Punches");
  ws.addRow(["Punch ID", "Employee Code", "Employee Name", "Department", "Date", "Punch Time", "Punch Type", "Source"]);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function upload(page: Page, buffer: Buffer, flags: Record<string, string> = {}) {
  const res = await page.request.post("/api/attendance/punches/import", {
    headers: { Authorization: `Bearer ${await token(page)}` },
    multipart: { file: { name: "punches.xlsx", mimeType: "application/octet-stream", buffer }, ...flags },
  });
  expect(res.status()).toBe(200);
  return res.json();
}

async function listDay(page: Page) {
  const res = await page.request.get(`/api/attendance/punches?dateFrom=${DAY}&dateTo=${DAY}&limit=100`, {
    headers: { Authorization: `Bearer ${await token(page)}` },
  });
  return (await res.json()) as { total: number; results: { id: number; employeeCode: string; punchTime: string }[] };
}

/** Removes every punch of DAY through the feature under test: download, drop all rows, upload with "delete". */
async function wipeDay(page: Page) {
  const res = await page.request.get(`/api/attendance/punches/export?dateFrom=${DAY}&dateTo=${DAY}`, {
    headers: { Authorization: `Bearer ${await token(page)}` },
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await res.body()) as never);
  const ws = wb.getWorksheet("Punches")!;
  for (let n = ws.rowCount; n > 1; n--) ws.spliceRows(n, 1);
  const out = await upload(page, Buffer.from(await wb.xlsx.writeBuffer()), { deleteMissing: "1" });
  expect(out.errorCount).toBe(0);
}

test("a row deleted from the downloaded sheet deletes its punch, after a confirmation", async ({ page }) => {
  await loginAsHr(page);
  await wipeDay(page);
  try {
    const seeded = await upload(
      page,
      await workbookBuffer([
        [null, "E2E001", "", "", DAY, "09:00:00", "IN", ""],
        [null, "E2E001", "", "", DAY, "13:00:00", "OUT", ""],
        [null, "E2E002", "", "", DAY, "09:10:00", "IN", ""],
      ]),
    );
    expect(seeded.created).toBe(3);
    expect((await listDay(page)).total).toBe(3);

    // Punch View for that one day: Custom, both dates
    await page.goto(PAGE);
    await page.getByRole("tab", { name: "Custom" }).click();
    await page.locator('input[type="date"]').nth(0).fill(DAY);
    await page.locator('input[type="date"]').nth(1).fill(DAY);
    await expect(page.getByRole("button", { name: /Export \(3\)/ })).toBeVisible();

    // download the file, as the user does
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /Export \(3\)/ }).click(),
    ]);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.concat(chunks) as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Punches", "Export record"]);
    expect(wb.getWorksheet("Export record")!.state).toBe("hidden");

    // delete the 13:00 OUT row and the whole "Department" column, save, upload it back
    const ws = wb.getWorksheet("Punches")!;
    let outRow = 0;
    ws.eachRow((row, n) => {
      if (n > 1 && String(row.getCell(6).value).startsWith("13:00")) outRow = n;
    });
    expect(outRow).toBeGreaterThan(1);
    ws.spliceRows(outRow, 1);
    ws.spliceColumns(4, 1);
    const edited = Buffer.from(await wb.xlsx.writeBuffer());

    // Cancel: nothing is deleted
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: "edited.xlsx", mimeType: "application/octet-stream", buffer: edited });
    const dialog = page.getByTestId("punch-delete-confirm");
    await expect(dialog).toContainText("Delete 1 punch?");
    await expect(dialog).toContainText("E2E001");
    await expect(dialog).toContainText("13:00:00");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect((await listDay(page)).total).toBe(3);

    // Confirm: the punch is gone and the page says so
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: "edited.xlsx", mimeType: "application/octet-stream", buffer: edited });
    await expect(page.getByTestId("punch-delete-confirm")).toContainText("Delete 1 punch?");
    await page.getByTestId("punch-delete-confirm-apply").click();
    await expect(page.getByText("Import result")).toBeVisible();
    await expect(page.getByText("deleted", { exact: false }).first()).toBeVisible();
    const after = await listDay(page);
    expect(after.total).toBe(2);
    expect(after.results.map((r) => r.punchTime).sort()).toEqual(["09:00:00", "09:10:00"]);
    await expect(page.getByRole("button", { name: /Export \(2\)/ })).toBeVisible();

    // A file with nothing removed is applied straight away: no confirmation
    await page.locator('input[type="file"]').setInputFiles({
      name: "same.xlsx",
      mimeType: "application/octet-stream",
      buffer: await workbookBuffer([]),
    });
    await expect(page.getByTestId("punch-delete-confirm")).toHaveCount(0);
  } finally {
    await wipeDay(page);
  }
  expect((await listDay(page)).total).toBe(0);
});

test("a day whose only punch was deleted stops showing as Present", async ({ page }) => {
  await loginAsHr(page);
  await wipeDay(page);
  const employees = (await page.request
    .get("/api/employees?search=E2E001", {
      headers: { Authorization: `Bearer ${await token(page)}` },
    })
    .then((r) => r.json())) as { id: number; employeeCode: string }[];
  const asha = employees.find((e) => e.employeeCode === "E2E001")!;
  const marks = async () => {
    const res = await page.request.get(`/api/attendance?employeeId=${asha.id}&year=2026`, {
      headers: { Authorization: `Bearer ${await token(page)}` },
    });
    return ((await res.json()) as { date: string; present: boolean }[]).filter((a) => a.date === DAY && a.present);
  };
  try {
    await upload(page, await workbookBuffer([[null, "E2E001", "", "", DAY, "09:00:00", "IN", ""]]));
    expect((await listDay(page)).total).toBe(1);
    expect(await marks()).toHaveLength(1); // the punch marked the day present

    // download, delete that one row, upload it back (what the user did)
    const res = await page.request.get(`/api/attendance/punches/export?dateFrom=${DAY}&dateTo=${DAY}`, {
      headers: { Authorization: `Bearer ${await token(page)}` },
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await res.body()) as never);
    wb.getWorksheet("Punches")!.spliceRows(2, 1);
    const out = await upload(page, Buffer.from(await wb.xlsx.writeBuffer()), { deleteMissing: "1" });
    expect(out.deleted).toBe(1);
    expect(out.marksCleared).toBe(1);
    expect((await listDay(page)).total).toBe(0);
    expect(await marks()).toHaveLength(0); // no punch, so no Present
  } finally {
    await wipeDay(page);
  }
});

test("a day's status is set from Punch View and every change is in the History page", async ({ page }) => {
  await loginAsHr(page);
  await wipeDay(page);
  try {
    await upload(page, await workbookBuffer([[null, "E2E001", "", "", DAY, "09:00:00", "IN", ""]]));
    await page.goto(PAGE);
    await page.getByRole("tab", { name: "Custom" }).click();
    await page.locator('input[type="date"]').nth(0).fill(DAY);
    await page.locator('input[type="date"]').nth(1).fill(DAY);
    await expect(page.getByRole("button", { name: /Export \(1\)/ })).toBeVisible();

    // the pencil beside the day opens the dialog with the employee and the day filled in
    await page.getByTestId(`day-status-edit-E2E001-${DAY}`).click();
    const dialog = page.getByTestId("day-status-dialog");
    await expect(dialog.getByTestId("day-status-code")).toHaveValue("E2E001");
    await expect(dialog.getByTestId("day-status-found")).toContainText("Asha Kumar");
    // a status needs a reason
    await dialog.getByTestId("day-status-absent").click();
    await expect(dialog.getByTestId("day-status-save")).toBeDisabled();
    await dialog.getByTestId("day-status-note").fill("No show, confirmed by HOD");
    await dialog.getByTestId("day-status-save").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("push-history-none")).toHaveCount(0);
    await expect(page.getByText("Absent").first()).toBeVisible();
    await expect(page.getByText("by hand").first()).toBeVisible();

    // set it to Half Day, then hand it back to the punches
    await page.getByTestId(`day-status-edit-E2E001-${DAY}`).click();
    await expect(page.getByTestId("day-status-found")).toContainText("by hand");
    await page.getByTestId("day-status-half_shift").click();
    await page.getByTestId("day-status-note").fill("Came for the morning only");
    await page.getByTestId("day-status-save").click();
    await expect(page.getByTestId("day-status-dialog")).toHaveCount(0);
    await page.getByTestId(`day-status-edit-E2E001-${DAY}`).click();
    await page.getByTestId("day-status-auto").click();
    await page.getByTestId("day-status-save").click();
    await expect(page.getByTestId("day-status-dialog")).toHaveCount(0);

    // the History page lists all three, newest first, and filters
    await page.getByTestId("punch-history-link").click();
    await expect(page).toHaveURL(/punch-view\/history$/);
    const table = page.getByTestId("history-table");
    await expect(table).toBeVisible();
    await page.getByTestId("history-search").fill("E2E001");
    await expect(table).toContainText("Status back to automatic");
    await expect(table).toContainText("Came for the morning only");
    await expect(table).toContainText("No show, confirmed by HOD");
    await page.getByTestId("history-action").selectOption("status_reset");
    await expect(table).toContainText("Status back to automatic");
    await expect(table).not.toContainText("Status set by hand");
    await page.getByTestId("history-clear").click();
    await page.getByTestId("history-search").fill("NOSUCHPERSON");
    await expect(page.getByTestId("history-empty")).toContainText("Nothing matches");
  } finally {
    await wipeDay(page);
  }
});
