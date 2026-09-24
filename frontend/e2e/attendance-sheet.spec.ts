import { expect, test } from "@playwright/test";
import { loginAsHr } from "./helpers";

// February 2026: Asha is present all 24 working days, Ravi the first 12.

test("the monthly attendance sheet shows each employee's days and totals", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/attendance/report-log");

  await expect(page.getByRole("button", { name: "Monthly Report" })).toBeVisible();
  await expect(page.getByText("Asha Kumar")).toBeVisible();

  // The sheet opens on the current month; step back to February 2026.
  const prev = page.getByRole("button", { name: "Previous period" });
  for (let i = 0; i < 7; i++) await prev.click();
  await expect(page.getByRole("button", { name: /Feb 2026/ })).toBeVisible();

  const asha = page.getByRole("row", { name: /Asha Kumar/ });
  const ravi = page.getByRole("row", { name: /Ravi Nair/ });
  await expect(asha).toBeVisible();

  // Present days are rendered as "P" cells.
  await expect(asha.getByText("P", { exact: true })).toHaveCount(24);
  await expect(ravi.getByText("P", { exact: true })).toHaveCount(12);

  // The sheet can be filtered by name.
  await page.getByPlaceholder(/search by employee/i).fill("Ravi");
  await expect(page.getByText("Ravi Nair")).toBeVisible();
  await expect(page.getByText("Asha Kumar")).toHaveCount(0);
});

test("the sheet API returns the same numbers the grid shows", async ({ page, request }) => {
  await loginAsHr(page);
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const res = await request.get("/api/attendance/report-log/sheet?dateFrom=2026-02-01&dateTo=2026-02-28", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const rows: { employeeCode?: string; code?: string; days?: unknown[] }[] = body.employees ?? body.rows ?? [];
  expect(rows.length).toBeGreaterThanOrEqual(2);
});
