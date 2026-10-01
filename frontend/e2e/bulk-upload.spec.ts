import ExcelJS from "exceljs";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Employee Bulk Upload: Staff and Production each have their own sheet, every file is checked before anything is
// saved, each row is reported with its reason, and an employee missing from an update file is only ever dealt with as
// asked. Every employee made here has a code starting BU- and is removed again, so other specs see the seed data only.

const tab = (page: Page, name: RegExp) => page.getByRole("tab", { name });
const row = (page: Page, n: number) => page.getByTestId(`bulk-row-${n}`);

async function api(page: Page, method: string, url: string, data?: unknown) {
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function employees(page: Page) {
  return (await api(page, "GET", "/api/employees")).body as {
    id: number;
    employeeCode: string;
    status: string;
    employmentType: string;
    phone: string | null;
  }[];
}

async function removeTestEmployees(page: Page) {
  for (const e of (await employees(page)).filter((e) => e.employeeCode.startsWith("BU-"))) {
    await api(page, "DELETE", `/api/employees/${e.id}`);
  }
}

async function makeEmployee(
  page: Page,
  code: string,
  kind: "staff" | "production",
  extra: Record<string, unknown> = {},
) {
  const branches = (await api(page, "GET", "/api/branches")).body as { id: number }[];
  const res = await api(page, "POST", "/api/employees", {
    employeeCode: code,
    firstName: `Test${code.slice(3)}`,
    lastName: "Person",
    phone: "9000000099",
    employmentType: kind,
    branchId: branches[0].id,
    ...(kind === "staff"
      ? { salaryType: "monthly", salaryAmount: 24000 }
      : { salaryType: "monthly", salaryPerShift: 400 }),
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

// Save the download, read it with exceljs.
async function downloaded(page: Page, testInfo: TestInfo, click: () => Promise<void>, name: string) {
  const [download] = await Promise.all([page.waitForEvent("download"), click()]);
  const file = testInfo.outputPath(name);
  await download.saveAs(file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return { wb, filename: download.suggestedFilename() };
}

const headersOf = (ws: ExcelJS.Worksheet) =>
  (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((v) => String(v).replace(/ \*$/, ""));

function columnOf(ws: ExcelJS.Worksheet, header: string): number {
  const i = headersOf(ws).indexOf(header);
  expect(i, `column ${header}`).toBeGreaterThanOrEqual(0);
  return i + 1;
}

/** Put one employee's cells on a fresh row below the sample block. */
function addEmployee(ws: ExcelJS.Worksheet, cells: Record<string, string | number>) {
  const r = ws.addRow([]);
  for (const [header, value] of Object.entries(cells)) r.getCell(columnOf(ws, header)).value = value;
  return r.number;
}

async function pick(page: Page, kind: "create" | "update", wb: ExcelJS.Workbook, name = "edited.xlsx") {
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  await page.getByTestId(`bulk-file-${kind}`).setInputFiles({
    name,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer,
  });
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await loginAsHr(page);
  await removeTestEmployees(page);
  await page.goto("/hr/employees/bulk-upload");
  await expect(page.getByTestId("category-staff")).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await removeTestEmployees(page);
});

test("Staff and Production are separate, with their own counts", async ({ page }) => {
  await expect(page.getByTestId("category-staff")).toContainText("3 active");
  await expect(page.getByTestId("category-staff")).toContainText("0 inactive");
  await expect(page.getByTestId("category-production")).toContainText("0 active");
  await expect(page.getByTestId("category-staff")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("category-production").click();
  await expect(page.getByTestId("category-production")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("template-card")).toContainText("Production");
  await expect(page.getByTestId("template-card")).toContainText("Salary Per Shift");
});

test("each kind downloads its own template, with its own columns, samples and instructions", async ({
  page,
}, testInfo) => {
  const staff = await downloaded(
    page,
    testInfo,
    () => page.getByTestId("download-template-staff").click(),
    "staff.xlsx",
  );
  expect(staff.filename).toMatch(/^Staff_Employee_Template_.*\.xlsx$/);
  const staffSheet = staff.wb.getWorksheet("Employees")!;
  const staffHeaders = headersOf(staffSheet);
  expect(staffHeaders).toContain("Salary Amount");
  expect(staffHeaders).toContain("Salary Type");
  expect(staffHeaders).toContain("Retention Allowance");
  expect(staffHeaders).not.toContain("Salary Per Shift");
  expect(staffHeaders).not.toContain("Employment Type");
  expect(String(staffSheet.getCell(2, 1).value)).toBe("SAMPLE001");
  expect(staff.wb.getWorksheet("Instructions")).toBeTruthy();

  await page.getByTestId("category-production").click();
  const prod = await downloaded(
    page,
    testInfo,
    () => page.getByTestId("download-template-production").click(),
    "production.xlsx",
  );
  expect(prod.filename).toMatch(/^Production_Employee_Template_.*\.xlsx$/);
  const prodHeaders = headersOf(prod.wb.getWorksheet("Employees")!);
  expect(prodHeaders).toContain("Salary Per Shift");
  for (const h of ["Salary Amount", "Salary Type", "Basic", "CA", "Employment Type"])
    expect(prodHeaders).not.toContain(h);
  expect(prodHeaders.length).toBeLessThan(staffHeaders.length);
});

test("a file is checked first: every row says what would happen, and nothing is saved until it is applied", async ({
  page,
}, testInfo) => {
  const { wb } = await downloaded(
    page,
    testInfo,
    () => page.getByTestId("download-template-staff").click(),
    "staff.xlsx",
  );
  const ws = wb.getWorksheet("Employees")!;
  const good = addEmployee(ws, {
    "Employee Code": "BU-S1",
    "First Name": "Meera",
    "Last Name": "Iyer",
    Branch: "E2E Head Office",
    "Salary Amount": 30000,
  });
  const dupExisting = addEmployee(ws, { "Employee Code": "E2E001", "First Name": "Asha" });
  const dupInFile = addEmployee(ws, { "Employee Code": "BU-S1", "First Name": "Meera again" });
  const badGender = addEmployee(ws, {
    "Employee Code": "BU-S2",
    "First Name": "Ravi",
    Gender: "Robot",
    Branch: "E2E Head Office",
  });
  await pick(page, "create", wb);

  await expect(page.getByTestId("bulk-result-message")).toContainText("1 employee(s) can be imported");
  await expect(page.getByTestId("bulk-tile-duplicate")).toContainText("2");
  await expect(page.getByTestId("bulk-tile-invalid")).toContainText("1");
  // the page opens on what needs attention; each row says why
  await expect(row(page, good)).toHaveCount(0);
  await expect(row(page, dupExisting)).toContainText("already exists (Asha Kumar, Staff, Active)");
  await expect(row(page, dupInFile)).toContainText(`first on row ${good}`);
  await expect(row(page, badGender)).toContainText("Gender must be Male, Female or Other");
  await page.getByRole("button", { name: /^All/ }).click();
  await expect(row(page, good)).toHaveAttribute("data-status", "created");
  await expect(row(page, good)).toContainText("Ready to import");
  expect((await employees(page)).some((e) => e.employeeCode === "BU-S1")).toBe(false); // checked, not saved

  await page.getByTestId("bulk-apply").click();
  await expect(page.getByTestId("bulk-result-message")).toContainText("Imported 1 employee(s)");
  await page.getByRole("button", { name: /^All/ }).click();
  await expect(row(page, good)).toContainText("Created");
  expect((await employees(page)).find((e) => e.employeeCode === "BU-S1")?.employmentType).toBe("staff");
  await expect(page.getByTestId("category-staff")).toContainText("4 active");
});

test("a Production sheet in the Staff section is refused with a clear message", async ({ page }, testInfo) => {
  await page.getByTestId("category-production").click();
  const { wb } = await downloaded(
    page,
    testInfo,
    () => page.getByTestId("download-template-production").click(),
    "production.xlsx",
  );
  addEmployee(wb.getWorksheet("Employees")!, {
    "Employee Code": "BU-P1",
    "First Name": "Mani",
    "Salary Per Shift": 400,
    Branch: "E2E Head Office",
  });
  await page.getByTestId("category-staff").click();
  await pick(page, "create", wb);
  await expect(page.getByTestId("bulk-error")).toContainText("This is the Production sheet");
  expect((await employees(page)).some((e) => e.employeeCode === "BU-P1")).toBe(false);

  // the same sheet in the Production section is fine and creates a production employee
  await page.getByTestId("category-production").click();
  await pick(page, "create", wb);
  await page.getByTestId("bulk-apply").click();
  await expect(page.getByTestId("bulk-result-message")).toContainText("Imported 1 employee(s)");
  expect((await employees(page)).find((e) => e.employeeCode === "BU-P1")?.employmentType).toBe("production");
});

test("updating existing employees: changes are reported per employee, and someone missing from the file is only dealt with as asked", async ({
  page,
}, testInfo) => {
  for (const code of ["BU-S1", "BU-S2", "BU-S3"]) await makeEmployee(page, code, "staff");
  await page.reload();
  await tab(page, /^Active employees/).click();

  const { wb, filename } = await downloaded(
    page,
    testInfo,
    () => page.getByTestId("download-staff-active").click(),
    "active.xlsx",
  );
  expect(filename).toMatch(/^Staff_Active_Employees_/);
  const ws = wb.getWorksheet("Employees")!;
  const codeCol = columnOf(ws, "Employee Code");
  const rowOf = (code: string) => {
    for (let r = 2; r <= ws.rowCount; r += 1) if (String(ws.getCell(r, codeCol).value) === code) return r;
    throw new Error(`no row for ${code}`);
  };
  expect(headersOf(ws).at(-1)).toBe("Status");
  expect(String(ws.getCell(rowOf("E2E001"), columnOf(ws, "Status")).value)).toBe("Active");

  // change one phone number, then remove two employees from the file
  ws.getCell(rowOf("BU-S1"), columnOf(ws, "Phone")).value = "9111111111";
  ws.spliceRows(rowOf("BU-S3"), 1);
  ws.spliceRows(rowOf("BU-S2"), 1);
  await pick(page, "update", wb);

  await expect(page.getByTestId("bulk-result-message")).toContainText("1 employee(s) would be updated");
  await expect(page.getByTestId("bulk-tile-updated")).toContainText("1");
  await expect(page.getByTestId("bulk-tile-unchanged")).toContainText("3");
  await page.getByRole("button", { name: /^All/ }).click();
  await expect(page.locator('[data-testid^="bulk-row-"][data-status="updated"]').first()).toContainText(
    "Changed: Phone",
  );

  // the removal question: two employees are not in the file, and nothing happens by default
  await expect(page.getByTestId("removal-title")).toContainText("2 Staff active employees are not in your file");
  await expect(page.getByTestId("removal-keep")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("removal-summary")).toContainText("2 left as they are");

  // make both Inactive, but delete BU-S3 outright
  await page.getByTestId("removal-inactive").click();
  await page.getByLabel("What to do with BU-S3").selectOption("delete");
  await expect(page.getByTestId("removal-summary")).toContainText("1 made Inactive, 1 deleted");
  expect((await employees(page)).filter((e) => e.employeeCode.startsWith("BU-") && e.status === "active")).toHaveLength(
    3,
  ); // still nothing done

  await page.getByTestId("bulk-apply").click();
  // deleting needs typing DELETE
  const confirm = page.getByTestId("delete-confirm");
  await expect(confirm).toBeDisabled();
  await page.getByTestId("delete-confirm-input").fill("DELETE");
  await confirm.click();

  await expect(page.getByTestId("bulk-result-message")).toContainText("Updated 1 employee(s)");
  await expect(page.getByTestId("bulk-tile-inactive")).toContainText("1");
  await expect(page.getByTestId("bulk-tile-deleted")).toContainText("1");
  const now = await employees(page);
  expect(now.find((e) => e.employeeCode === "BU-S1")?.phone).toBe("9111111111");
  expect(now.find((e) => e.employeeCode === "BU-S2")?.status).toBe("inactive");
  expect(now.some((e) => e.employeeCode === "BU-S3")).toBe(false);

  // the inactive list now has BU-S2 on its own, separate from Production, and it can be made active again
  await page.getByTestId("bulk-reset").click();
  await tab(page, /^Inactive employees/).click();
  await expect(page.getByTestId("employees-table")).toContainText("BU-S2");
  const inactive = await downloaded(
    page,
    testInfo,
    () => page.getByTestId("download-staff-inactive").click(),
    "inactive.xlsx",
  );
  expect(inactive.filename).toMatch(/^Staff_Inactive_Employees_/);
  const iws = inactive.wb.getWorksheet("Employees")!;
  expect(iws.rowCount).toBe(2); // the header and BU-S2
  expect(String(iws.getCell(2, 1).value)).toBe("BU-S2");
  iws.getCell(2, columnOf(iws, "Status")).value = "Active";
  await pick(page, "update", inactive.wb);
  await expect(page.getByTestId("removal-panel")).toHaveCount(0); // nobody is missing from that file
  await page.getByTestId("bulk-apply").click();
  await expect(page.getByTestId("bulk-result-message")).toContainText("Updated 1 employee(s)");
  expect((await employees(page)).find((e) => e.employeeCode === "BU-S2")?.status).toBe("active");
});

test("a download keeps codes and phones as text, and still uploads cleanly after Excel turns them into numbers", async ({
  page,
}, testInfo) => {
  await tab(page, /^Active employees/).click();
  const { wb } = await downloaded(
    page,
    testInfo,
    () => page.getByTestId("download-staff-active").click(),
    "active.xlsx",
  );
  const ws = wb.getWorksheet("Employees")!;
  const phone = columnOf(ws, "Phone");
  // text, with the Text format: Excel has nothing to flag, and a leading zero or a long number is kept as typed
  for (const header of ["Employee Code", "Phone", "Bank Account", "PF Number"]) {
    expect(ws.getColumn(columnOf(ws, header)).numFmt, header).toBe("@");
  }
  expect(typeof ws.getCell(2, phone).value).toBe("string");

  // "Convert to Number" (what the green triangle offers): the phones become real numbers
  for (let r = 2; r <= ws.rowCount; r += 1) ws.getCell(r, phone).value = Number(ws.getCell(r, phone).value);
  await pick(page, "update", wb);
  await expect(page.getByTestId("bulk-tile-invalid")).toContainText("0");
  await expect(page.getByTestId("bulk-tile-unchanged")).toContainText("3");
  await expect(page.getByTestId("bulk-tile-updated")).toContainText("0");
});

test("a row in the wrong list is refused, and an unknown code is reported as not found", async ({ page }, testInfo) => {
  await makeEmployee(page, "BU-P2", "production");
  await page.reload();
  await tab(page, /^Active employees/).click();
  const { wb } = await downloaded(
    page,
    testInfo,
    () => page.getByTestId("download-staff-active").click(),
    "active.xlsx",
  );
  const ws = wb.getWorksheet("Employees")!;
  const production = addEmployee(ws, { "Employee Code": "BU-P2", Phone: "9222222222" });
  const ghost = addEmployee(ws, { "Employee Code": "BU-NOBODY", Phone: "9333333333" });
  await pick(page, "update", wb);
  await expect(row(page, production)).toContainText("Production active employees");
  await expect(row(page, ghost)).toContainText("No employee with code 'BU-NOBODY'");
  await expect(page.getByTestId("bulk-tile-not_found")).toContainText("1");
  await expect(page.getByTestId("bulk-apply")).toBeDisabled(); // nothing in the file would change anything
  expect((await employees(page)).find((e) => e.employeeCode === "BU-P2")?.phone).toBe("9000000099");
});

test("on a phone the page fits the screen and the results become cards", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(await fits()).toBe(true);
  // nothing is clipped off the right edge: the cards sit inside the screen
  for (const id of ["category-staff", "template-card", "upload-create"]) {
    const box = (await page.getByTestId(id).boundingBox())!;
    expect(box.x + box.width, id).toBeLessThanOrEqual(390);
  }
  const { wb } = await downloaded(
    page,
    testInfo,
    () => page.getByTestId("download-template-staff").click(),
    "staff.xlsx",
  );
  addEmployee(wb.getWorksheet("Employees")!, { "Employee Code": "E2E001", "First Name": "Asha" });
  await pick(page, "create", wb);
  await expect(page.getByTestId("bulk-results")).toBeVisible();
  await expect(page.getByTestId("bulk-result-table")).toBeHidden(); // cards, not the wide table
  expect(await fits()).toBe(true);
});
