import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// The Payroll tab of Staff Payroll: records as a TABLE by default, listed ONE DEPARTMENT AT A TIME (a strip of department
// tabs), and an Export menu whose second item is the printed Salary Payroll Statement as a PDF (the same file as
// Reports > HR Reports > Salary Statement). Seeded for February 2026 by seed_e2e.py: Asha Kumar and Ravi Nair, both in
// Stitching. This spec moves Ravi to a department of its own for the test and puts him back.

const FEB = "/hr/payroll?month=2&year=2026";
const RUN = String(Date.now()).slice(-6);

async function api(page: Page, method: string, url: string, data?: unknown) {
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status(), body };
}

test("the Payroll tab lists a table, one department at a time, and exports the Salary Payroll Statement as a PDF", async ({
  page,
}) => {
  await loginAsHr(page);
  await api(page, "POST", "/api/payroll/generate", { month: 2, year: 2026 });

  const employees = (await api(page, "GET", "/api/employees?search=E2E00")).body as {
    id: number;
    employeeCode: string;
    departmentId: number | null;
  }[];
  const ravi = employees.find((e) => e.employeeCode === "E2E002")!;
  const originalDepartment = ravi.departmentId;
  const branches = (await api(page, "GET", "/api/branches")).body as { id: number }[];
  const created = await api(page, "POST", "/api/departments", { name: `PD Accounts ${RUN}`, branchId: branches[0].id });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const dept = created.body as { id: number };

  try {
    expect((await api(page, "PATCH", `/api/employees/${ravi.id}`, { departmentId: dept.id })).status).toBe(200);
    await api(page, "POST", "/api/payroll/generate", { month: 2, year: 2026 });

    await page.goto(FEB);
    await expect(page.getByTestId("staff-payroll-tab")).toBeVisible({ timeout: 30_000 });

    // a table by default, not cards
    await expect(page.getByTestId("staff-records")).toHaveAttribute("data-layout", "table");
    // the department strip: the first department by name is open, the others are one click away
    const tabs = page.getByTestId("staff-dept-tabs");
    await expect(tabs).toBeVisible();
    await expect(page.getByTestId(`staff-dept-tab-${dept.id}`)).toContainText(`PD Accounts ${RUN}`);
    await expect(page.getByTestId(`staff-dept-tab-${dept.id}`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("staff-records")).toContainText("Ravi Nair");
    await expect(page.getByTestId("staff-records")).not.toContainText("Asha Kumar");
    await expect(page.getByTestId("staff-dept-summary")).toContainText("1 employee");
    // the count of the month still covers every department
    await expect(page.getByTestId("staff-record-count")).toContainText("2 records");

    // another department: only its records
    await tabs.getByRole("button", { name: /Stitching/ }).click();
    await expect(page).toHaveURL(/pdept=/);
    await expect(page.getByTestId("staff-records")).toContainText("Asha Kumar");
    await expect(page.getByTestId("staff-records")).not.toContainText("Ravi Nair");

    // a search stays inside what the filters say, and the tabs follow it
    await page.getByTestId("staff-pf-search").fill("Ravi");
    await expect(page.getByTestId(`staff-dept-tab-${dept.id}`)).toBeVisible();
    await expect(tabs.getByRole("button", { name: /Stitching/ })).toHaveCount(0);
    await page.getByTestId("staff-pf-search").fill("");
    await expect(tabs.getByRole("button", { name: /Stitching/ })).toBeVisible();

    // cards are still one click away and the choice stays in the address
    await page.getByTestId("payroll-record-layout-cards").click();
    await expect(page).toHaveURL(/layout=cards/);
    await page.getByTestId("payroll-record-layout-table").click();

    // the Export menu: the Excel register and the statement PDF, no CSV
    await page.getByTestId("staff-export").click();
    await expect(page.getByTestId("staff-export-register-xlsx")).toBeVisible();
    await expect(page.getByTestId("staff-export-register-csv")).toHaveCount(0);
    await expect(page.getByTestId("staff-export-statement-pdf")).toContainText("Salary Payroll Statement (PDF)");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("staff-export-statement-pdf").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(2000);
  } finally {
    await api(page, "PATCH", `/api/employees/${ravi.id}`, { departmentId: originalDepartment });
    await api(page, "POST", "/api/payroll/generate", { month: 2, year: 2026 });
    await api(page, "DELETE", `/api/departments/${dept.id}`);
  }
});
