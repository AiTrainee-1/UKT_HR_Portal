import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Seeded by seed_e2e.py for February 2026 (24 Mon-Sat working days):
//   Asha Kumar  - salary 24,000, present all 24 days  -> paid 24,000
//   Ravi Nair   - salary 30,000, present 12 of 24     -> paid 15,000
//   Meena       - no salary configured                -> skipped

const FEB = "/hr/payroll?month=2&year=2026";

// A payroll entry is a card (an <article> named "Payroll of <employee>").
const card = (page: Page, name: string) => page.getByRole("article", { name: `Payroll of ${name}` });

test("HR generates staff payroll for a month and the figures are right", async ({ page }) => {
  await loginAsHr(page);
  await page.goto(FEB);

  await page.getByTestId("staff-generate-open").click();
  const dialog = page.getByTestId("staff-generate-dialog");
  // the dialog opens on the month the page is showing
  await expect(dialog.getByTestId("staff-generate-month")).toHaveValue("2");
  await expect(dialog.getByTestId("staff-generate-year")).toHaveValue("2026");
  await dialog.getByTestId("staff-generate-confirm").click();

  const asha = card(page, "Asha Kumar");
  const ravi = card(page, "Ravi Nair");
  await expect(asha).toBeVisible({ timeout: 30_000 });
  await expect(asha).toContainText("24 / 24 days");
  await expect(asha).toContainText("₹24,000");
  await expect(ravi).toContainText("12 / 24 days");
  await expect(ravi).toContainText("₹15,000");
  await expect(page.getByText("Meena Nosalary")).toHaveCount(0);
  await expect(page.getByTestId("staff-record-count")).toHaveText("February 2026 · 2 records");
});

test("the dashboard of the month shows the totals, the skipped employee and the issues", async ({ page, request }) => {
  await loginAsHr(page);
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  await request.post("/api/payroll/generate", {
    headers: { Authorization: `Bearer ${token}` },
    data: { month: 2, year: 2026 },
  });

  await page.goto(FEB);
  const dash = page.getByTestId("staff-dash-root");
  await expect(dash).toBeVisible();
  // 24,000 + 15,000 net payable across the two paid-able payrolls
  await expect(page.getByTestId("staff-dash-kpi-net")).toContainText("₹39,000");
  await expect(page.getByTestId("staff-dash-kpi-employees")).toContainText("2");
  // Meena has no salary: she is the one employee skipped at generation
  await expect(page.getByTestId("staff-dash-kpi-skipped")).toContainText("1");
});

test("the skipped employee is listed with the reason", async ({ page }) => {
  await loginAsHr(page);
  await page.goto(FEB);

  await page.getByTestId("staff-skipped-open").click();
  await expect(page).toHaveURL(/view=skipped/);
  await expect(page.getByText("Meena Nosalary")).toBeVisible();
  await expect(page.getByText(/No Salary Amount/)).toBeVisible();
});

test("the filters narrow the payroll cards and live in the address", async ({ page, request }) => {
  await loginAsHr(page);
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  await request.post("/api/payroll/generate", {
    headers: { Authorization: `Bearer ${token}` },
    data: { month: 2, year: 2026 },
  });

  await page.goto(FEB);
  await expect(card(page, "Asha Kumar")).toBeVisible({ timeout: 30_000 });
  await expect(card(page, "Ravi Nair")).toBeVisible();

  await page.getByTestId("staff-pf-search").fill("Ravi");
  await expect(card(page, "Asha Kumar")).toHaveCount(0);
  await expect(card(page, "Ravi Nair")).toBeVisible();
  await expect(page).toHaveURL(/q=Ravi/);

  // a reload lands on the same filtered view
  await page.reload();
  await expect(page.getByTestId("staff-pf-search")).toHaveValue("Ravi");
  await expect(card(page, "Asha Kumar")).toHaveCount(0);
  await expect(card(page, "Ravi Nair")).toBeVisible();
});

test("the API agrees with the screen, and regenerating never duplicates", async ({ page, request }) => {
  await loginAsHr(page);
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const headers = { Authorization: `Bearer ${token}` };

  const generated = await request.post("/api/payroll/generate", { headers, data: { month: 2, year: 2026 } });
  expect(generated.status()).toBe(201);
  const body = await generated.json();
  expect(body.generated).toBe(2);
  expect(body.skipped).toBe(1);
  expect(body.skippedDetails[0].reason).toMatch(/No Salary Amount/);

  const list = await (await request.get("/api/payroll?month=2&year=2026", { headers })).json();
  const byCode = Object.fromEntries(list.map((r: { employeeCode: string }) => [r.employeeCode, r]));
  expect(Number(byCode.E2E001.finalSalary)).toBe(24000);
  expect(Number(byCode.E2E002.finalSalary)).toBe(15000);

  await request.post("/api/payroll/generate", { headers, data: { month: 2, year: 2026 } });
  const again = await (await request.get("/api/payroll?month=2&year=2026", { headers })).json();
  expect(again).toHaveLength(2);
});
