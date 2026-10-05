import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { loginAsHr } from "./helpers";

// The salary split: 50% (Basic + DA + Retaining Allowance) + 50% (Other + Petrol + HRA + Special Allowance + CA),
// worked out from the salary, editable, and always kept at exactly 50% + 50%.

const box = (page: Page, key: string) => page.getByTestId(`split-input-${key}`);
const FIRST = ["basic", "da", "retainingAllowance"];
const SECOND = ["otherAllowance", "petrolAllowance", "hra", "specialAllowance", "ca"];

async function values(page: Page, keys: string[]) {
  return Promise.all(keys.map((k) => box(page, k).inputValue()));
}

async function authHeader(page: Page) {
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  return { Authorization: `Bearer ${token}` };
}

async function findEmployee(page: Page | APIRequestContext, headers: Record<string, string>, code: string) {
  const request = "request" in page ? page.request : page;
  const list = await (await request.get("/api/employees", { headers })).json();
  return (list as { employeeCode: string; id: number }[]).find((e) => e.employeeCode === code);
}

async function startNewEmployee(page: Page, code: string) {
  await page.goto("/hr/employees/new");
  await page.getByLabel("Employee Code *").fill(code);
  await page.getByLabel("First Name *").fill("Split");
  await page.getByLabel("Last Name *").fill(code);
  await page.getByLabel("Phone *").fill("9000011111");
  await page.locator("select").filter({ hasText: "Select Branch" }).selectOption({ index: 1 });
}

test.describe.configure({ mode: "serial" });

test("entering a monthly salary fills in all eight amounts, 50% + 50%", async ({ page }) => {
  await loginAsHr(page);
  await startNewEmployee(page, "SPL1");
  await expect(page.getByTestId("split-status")).toContainText("Enter the salary amount");

  await page.getByTestId("input-salary-amount").fill("43000");
  expect(await values(page, FIRST)).toEqual(["7166.67", "7166.67", "7166.66"]);
  expect(await values(page, SECOND)).toEqual(["4300.00", "4300.00", "4300.00", "4300.00", "4300.00"]);
  await expect(page.getByTestId("split-first-total")).toContainText("₹21,500.00");
  await expect(page.getByTestId("split-second-total")).toContainText("₹21,500.00");
  await expect(page.getByTestId("split-status")).toContainText("The split is valid: 50% + 50% of ₹43,000.00");
});

test("a split that is not 50% + 50% is flagged live and blocks Save", async ({ page, request }) => {
  await loginAsHr(page);
  await startNewEmployee(page, "SPL2");
  await page.getByTestId("input-salary-amount").fill("43000");

  await box(page, "basic").fill("9000");
  await expect(page.getByTestId("split-status")).toContainText(
    "First portion (Basic + DA + Retaining Allowance) is ₹23,333.33",
  );
  await expect(page.getByTestId("split-status")).toContainText("must be 50% of the salary (₹21,500.00)");
  await expect(page.getByTestId("split-first-total")).toContainText("over");

  await page.getByRole("button", { name: "Save Employee" }).click();
  await expect(page.getByText("Fix the salary split").first()).toBeVisible();
  await expect(page).toHaveURL(/\/hr\/employees\/new/);
  expect(await findEmployee(request, await authHeader(page), "SPL2")).toBeUndefined();

  // a blank box is not a zero
  await box(page, "basic").fill("");
  await expect(page.getByRole("alert").filter({ hasText: "Enter an amount (0 if none)" })).toBeVisible();
});

test("a manual edit that keeps both portions at 50% saves, for a weekly salary too", async ({ page }) => {
  await loginAsHr(page);
  await startNewEmployee(page, "SPL3");
  await page.getByRole("combobox", { name: "Salary Type *" }).click();
  await page.getByRole("option", { name: "Weekly" }).click();
  await page.getByTestId("input-salary-amount").fill("6000");
  expect(await values(page, FIRST)).toEqual(["1000.00", "1000.00", "1000.00"]);
  expect(await values(page, SECOND)).toEqual(["600.00", "600.00", "600.00", "600.00", "600.00"]);

  await box(page, "basic").fill("1500");
  await box(page, "da").fill("500");
  await box(page, "retainingAllowance").fill("1000");
  await box(page, "hra").fill("1000");
  await box(page, "ca").fill("200");
  await box(page, "otherAllowance").fill("400");
  await box(page, "petrolAllowance").fill("400");
  await box(page, "specialAllowance").fill("1000");
  await expect(page.getByTestId("split-status")).toContainText("The split is valid");

  await page.getByRole("button", { name: "Save Employee" }).click();
  await expect(page.getByText("Employee added successfully").first()).toBeVisible();

  const headers = await authHeader(page);
  const saved = await findEmployee(page, headers, "SPL3");
  const emp = await (await page.request.get(`/api/employees/${saved!.id}`, { headers })).json();
  expect(emp.salaryType).toBe("weekly");
  expect(emp.salaryAmount).toBe(6000);
  expect(emp.salaryBreakup).toEqual({
    basic: 1500,
    da: 500,
    retainingAllowance: 1000,
    otherAllowance: 400,
    petrolAllowance: 400,
    hra: 1000,
    specialAllowance: 1000,
    ca: 200,
  });
});

test("changing the salary recalculates everything, and Reset returns to the automatic split", async ({ page }) => {
  await loginAsHr(page);
  await startNewEmployee(page, "SPL4");
  await page.getByTestId("input-salary-amount").fill("43000");
  await box(page, "basic").fill("10000");
  await box(page, "da").fill("4333.34");
  await expect(page.getByTestId("split-status")).toContainText("The split is valid");

  await page.getByTestId("input-salary-amount").fill("50000");
  expect(await values(page, FIRST)).toEqual(["8333.34", "8333.33", "8333.33"]);
  expect(await values(page, SECOND)).toEqual(["5000.00", "5000.00", "5000.00", "5000.00", "5000.00"]);

  await box(page, "ca").fill("1");
  await expect(page.getByTestId("split-second-total")).toContainText("short");
  await page.getByTestId("split-reset").click();
  expect(await values(page, SECOND)).toEqual(["5000.00", "5000.00", "5000.00", "5000.00", "5000.00"]);
  await expect(page.getByTestId("split-status")).toContainText("The split is valid");

  // an amount with paise: the odd paisa goes to the first portion
  await page.getByTestId("input-salary-amount").fill("1000.01");
  expect(await values(page, FIRST)).toEqual(["166.67", "166.67", "166.67"]);
  await expect(page.getByTestId("split-first-total")).toContainText("₹500.01");
  await expect(page.getByTestId("split-second-total")).toContainText("₹500.00");
  await expect(page.getByTestId("split-status")).toContainText("The split is valid");
});

test("a production employee paid per shift has no salary split", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/employees/new");
  await page.getByRole("combobox", { name: "Employment Type *" }).click();
  await page.getByRole("option", { name: "Production (Weekly)" }).click();
  await expect(page.getByText("Salary Per Shift (₹) *")).toBeVisible();
  await expect(page.getByTestId("salary-split")).toHaveCount(0);
});

test("an older employee with no split gets a suggestion to review, and saving records it", async ({ page }) => {
  await loginAsHr(page);
  const headers = await authHeader(page);
  const asha = await findEmployee(page, headers, "E2E001");
  expect(asha).toBeTruthy();
  const before = await (await page.request.get(`/api/employees/${asha!.id}`, { headers })).json();
  expect(before.salaryAmount).toBe(24000);
  expect(before.salaryBreakup).toBeNull();

  await page.goto(`/hr/employees/${asha!.id}/edit`);
  await expect(page.getByTestId("split-not-recorded")).toBeVisible();
  expect(await values(page, FIRST)).toEqual(["4000.00", "4000.00", "4000.00"]);
  expect(await values(page, SECOND)).toEqual(["2400.00", "2400.00", "2400.00", "2400.00", "2400.00"]);

  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByText("Employee updated successfully").first()).toBeVisible();
  const after = await (await page.request.get(`/api/employees/${asha!.id}`, { headers })).json();
  expect(after.salaryBreakup.basic).toBe(4000);
  expect(after.salaryBreakup.ca).toBe(2400);
  expect(after.salaryAmount).toBe(24000);

  // now it is on record: no more suggestion, and a new salary re-splits
  await page.goto(`/hr/employees/${asha!.id}/edit`);
  await expect(page.getByTestId("split-not-recorded")).toHaveCount(0);
  await page.getByTestId("input-salary-amount").fill("30000");
  expect(await values(page, FIRST)).toEqual(["5000.00", "5000.00", "5000.00"]);
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByText("Employee updated successfully").first()).toBeVisible();
  const raised = await (await page.request.get(`/api/employees/${asha!.id}`, { headers })).json();
  expect([raised.salaryAmount, raised.salaryBreakup.basic, raised.salaryBreakup.hra]).toEqual([30000, 5000, 3000]);
});

test("the employee page shows the split beside the salary", async ({ page }) => {
  await loginAsHr(page);
  const asha = await findEmployee(page, await authHeader(page), "E2E001");
  await page.goto(`/hr/employees/${asha!.id}`);
  const summary = page.getByTestId("salary-split-summary");
  await expect(summary).toContainText("First portion · 50%");
  await expect(summary).toContainText("Retaining Allowance");
  await expect(summary).toContainText("Second portion · 50%");
  await expect(summary).toContainText("₹5,000.00");
});

test("the Compensation page's CTC Breakdown shows the split: recorded, automatic, and none", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/compensation");
  await expect(page.getByTestId("ctc-row-E2E001")).toBeVisible();

  // two-level header: the two portions, then the eight components; the old HRA / Allowances columns are gone
  await expect(page.getByRole("columnheader", { name: "First portion · 50%" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Second portion · 50%" })).toBeVisible();
  for (const name of [
    "Basic",
    "DA",
    "Retaining Allowance",
    "Other Allowance",
    "Petrol Allowance",
    "HRA",
    "Special Allowance",
    "CA",
  ]) {
    await expect(page.getByRole("columnheader", { name, exact: true })).toBeVisible();
  }
  // the old percentage-based Allowances column is gone (HRA is now one of the eight split columns, checked above)
  await expect(page.getByRole("columnheader", { name: "Allowances", exact: true })).toHaveCount(0);

  // the eight component cells of a row (Code, Name, Department, Designation come first)
  const split = async (code: string) =>
    (await page.getByTestId(`ctc-row-${code}`).locator("td").allInnerTexts()).slice(4, 12).map((s) => s.trim());

  // recorded (saved by the earlier edit test, rescaled to 30,000): shown as it is, no "Auto split" tag
  expect(await split("E2E001")).toEqual([
    "₹5,000",
    "₹5,000",
    "₹5,000",
    "₹3,000",
    "₹3,000",
    "₹3,000",
    "₹3,000",
    "₹3,000",
  ]);
  await expect(page.getByTestId("ctc-row-E2E001").getByTestId("ctc-auto-split")).toHaveCount(0);

  // a hand-made weekly split, recorded when the employee was added
  expect(await split("SPL3")).toEqual(["₹1,500", "₹500", "₹1,000", "₹400", "₹400", "₹1,000", "₹1,000", "₹200"]);

  // never saved: the automatic split is shown, and tagged so it is not mistaken for a recorded one
  expect(await split("E2E002")).toEqual([
    "₹5,000",
    "₹5,000",
    "₹5,000",
    "₹3,000",
    "₹3,000",
    "₹3,000",
    "₹3,000",
    "₹3,000",
  ]);
  await expect(page.getByTestId("ctc-row-E2E002").getByTestId("ctc-auto-split")).toBeVisible();
  await expect(page.getByTestId("ctc-summary")).toContainText("showing the automatic split (not recorded yet)");

  // no salary: nothing to split
  expect(await split("E2E003")).toEqual(Array(8).fill("—"));
  await expect(page.getByTestId("ctc-row-E2E003").getByTestId("ctc-auto-split")).toHaveCount(0);

  // the same figures land in the Excel export
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export to Excel" }).click(),
  ]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile((await download.path())!);
  const ws = wb.worksheets[0];
  const header = (ws.getRow(1).values as unknown[]).slice(1).map((h) => String(h));
  expect(header.slice(4, 15)).toEqual([
    "BASIC",
    "DA",
    "RETAINING ALLOWANCE",
    "FIRST PORTION (50%)",
    "OTHER ALLOWANCE",
    "PETROL ALLOWANCE",
    "HRA",
    "SPECIAL ALLOWANCE",
    "CA",
    "SECOND PORTION (50%)",
    "EMPLOYER PF",
  ]);
  expect(header.at(-1)).toBe("SALARY SPLIT");
  const rowOf = (code: string) => {
    for (let r = 2; r <= ws.rowCount; r++) if (String(ws.getRow(r).getCell(1).value) === code) return ws.getRow(r);
    throw new Error(`${code} is not in the export`);
  };
  const cell = (code: string, label: string) => rowOf(code).getCell(header.indexOf(label) + 1).value;
  expect([
    cell("E2E001", "FIRST PORTION (50%)"),
    cell("E2E001", "SECOND PORTION (50%)"),
    cell("E2E001", "SALARY SPLIT"),
  ]).toEqual([15000, 15000, "Recorded"]);
  expect([cell("SPL3", "BASIC"), cell("SPL3", "FIRST PORTION (50%)")]).toEqual([1500, 3000]);
  expect(cell("E2E002", "SALARY SPLIT")).toBe("Automatic");
  expect(cell("E2E003", "SALARY SPLIT")).toBe("");
});

test("Settings -> Payroll -> Compensation no longer has Basic % / HRA % boxes", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/settings");
  await page.getByRole("tab", { name: "Payroll", exact: true }).click();
  await page.getByRole("tab", { name: "Compensation", exact: true }).click();
  const note = page.getByTestId("compensation-split-note");
  await expect(note).toContainText("First portion (50%)");
  await expect(note).toContainText("Second portion (50%)");
  await expect(note).toContainText("no longer used");
  await expect(page.getByText("Basic (%)")).toHaveCount(0);
  await expect(page.getByText("HRA (%)")).toHaveCount(0);
});

test("the bulk-upload template carries the eight split columns, and the upload works with and without them", async ({
  page,
}) => {
  await loginAsHr(page);
  await page.goto("/hr/employees/bulk-upload");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("download-template-staff").click(), // the Staff sheet is the one with the salary columns
  ]);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile((await download.path())!);
  const ws = wb.worksheets[0];
  const headers = (ws.getRow(1).values as (string | undefined)[])
    .slice(1)
    .map((h) => String(h ?? "").replace(/ \*$/, ""));
  // the Staff sheet carries the eight split columns right after the salary amount
  const split = [
    "Basic",
    "DA",
    "Retaining Allowance",
    "Other Allowance",
    "Petrol Allowance",
    "HRA",
    "Special Allowance",
    "CA",
  ];
  const first = headers.indexOf("Basic");
  expect(headers.slice(first - 2, first)).toEqual(["Salary Type", "Salary Amount"]);
  expect(headers.slice(first, first + 8)).toEqual(split);
  expect(headers.slice(0, 5)).toEqual(["Employee Code", "First Name", "Last Name", "Email", "Phone"]);
  // the first sample row shows a hand-made split that adds up to 25,000
  const sample = (ws.getRow(2).values as unknown[]).slice(1);
  const splitCells = sample.slice(first, first + 8).map(Number);
  expect(splitCells.reduce((a, b) => a + b, 0)).toBeCloseTo(25000, 2);

  // upload two rows built on the downloaded headers: one leaves the split blank, one types a bad split
  const upload = new ExcelJS.Workbook();
  const sheet = upload.addWorksheet("Employees");
  sheet.addRow(headers);
  const row = (code: string, extra: Record<string, string | number>) =>
    sheet.addRow(
      headers.map(
        (h) =>
          ({
            "Employee Code": code,
            "First Name": "Bulk",
            "Last Name": code,
            Phone: "9000022222",
            "Employment Type": "Staff",
            Branch: "E2E Head Office",
            "Salary Type": "Monthly",
            "Salary Amount": 43000,
            ...extra,
          })[h] ?? "",
      ),
    );
  row("BULKOK", {});
  row("BULKBAD", { Basic: 30000, "Other Allowance": 21500 });
  const buffer = Buffer.from(await upload.xlsx.writeBuffer());

  const auth = await authHeader(page);
  const response = await page.request.post("/api/employees/bulk-upload", {
    headers: auth,
    multipart: {
      file: {
        name: "employees.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer,
      },
    },
  });
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(201);
  expect(body.created).toBe(1);
  expect(body.failed).toBe(1);
  expect(body.errors[0]).toContain("First portion");

  const ok = await findEmployee(page, auth, "BULKOK");
  const emp = await (await page.request.get(`/api/employees/${ok!.id}`, { headers: auth })).json();
  expect(emp.salaryBreakup).toMatchObject({ basic: 7166.67, da: 7166.67, retainingAllowance: 7166.66, ca: 4300 });
  expect(await findEmployee(page, auth, "BULKBAD")).toBeUndefined();
});
