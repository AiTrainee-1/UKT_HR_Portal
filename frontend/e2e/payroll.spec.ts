import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Seeded by seed_e2e.py for February 2026 (24 Mon-Sat working days):
//   Asha Kumar  - salary 24,000, present all 24 days  -> paid 24,000
//   Ravi Nair   - salary 30,000, present 12 of 24     -> paid 15,000
//   Meena       - no salary configured                -> skipped

// A payroll entry is a card, not a table row: the innermost element that holds
// both the employee's name and the "Mark Paid" action.
const card = (page: Page, name: string) =>
  page.locator("div").filter({ hasText: name }).filter({ hasText: "Mark Paid" }).last();

test("HR generates staff payroll for a month and the figures are right", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/payroll");

  await page
    .getByRole("button", { name: /generate payroll/i })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("select").selectOption({ label: "February" });
  await dialog.locator('input[type="number"]').fill("2026");
  await dialog.getByRole("button", { name: /generate staff payroll/i }).click();

  // The list opens on the current month; show February 2026.
  await page.locator("select").first().selectOption({ label: "February" });
  await page.locator('input[type="number"]').first().fill("2026");

  const asha = card(page, "Asha Kumar");
  const ravi = card(page, "Ravi Nair");
  await expect(asha).toBeVisible({ timeout: 30_000 });
  await expect(asha).toContainText("24 / 24 days");
  await expect(asha).toContainText("₹24,000");
  await expect(ravi).toContainText("12 / 24 days");
  await expect(ravi).toContainText("₹15,000");
  await expect(page.getByText("Meena Nosalary")).toHaveCount(0);
  await expect(page.getByText("February 2026 · 2 records")).toBeVisible();
});

test("the skipped employee is listed with the reason", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/payroll");
  await page.locator("select").first().selectOption({ label: "February" });
  await page.locator('input[type="number"]').first().fill("2026");

  await page.getByRole("button", { name: /skipped employees/i }).click();
  await expect(page.getByText("Meena Nosalary")).toBeVisible();
  await expect(page.getByText(/No Salary Amount/)).toBeVisible();
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
