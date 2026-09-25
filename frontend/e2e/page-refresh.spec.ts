import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Counts the API calls a page makes to a path, so a test can prove Refresh really reloads its data.
function countRequests(page: Page, needle: string) {
  let count = 0;
  page.on("request", (req) => {
    if (req.url().includes(needle)) count += 1;
  });
  return () => count;
}

test("Refresh reloads the data on a page and keeps what you were doing", async ({ page }) => {
  await loginAsHr(page);
  const employeeCalls = countRequests(page, "/api/employees");
  await page.goto("/hr/employees");

  const refresh = page.getByTestId("button-page-refresh");
  await expect(refresh).toBeVisible();
  await expect(page.getByTestId("page-last-updated")).toContainText("Updated");
  await expect(page.getByText("Asha Kumar").first()).toBeVisible();

  // What the person typed stays put...
  const search = page.getByPlaceholder(/search/i).first();
  await search.fill("Asha");
  await expect(search).toHaveValue("Asha");

  // ...while the data is fetched again from the server.
  const before = employeeCalls();
  await refresh.click();
  await expect.poll(employeeCalls).toBeGreaterThan(before);
  await expect(search).toHaveValue("Asha");
  await expect(refresh).toBeEnabled();
});

test("Refresh also reloads a page that loads its data by hand (Staff Payroll)", async ({ page }) => {
  await loginAsHr(page);
  const payrollCalls = countRequests(page, "/api/payroll?");
  await page.goto("/hr/payroll");
  await expect(page.getByTestId("button-page-refresh")).toBeVisible();
  await expect.poll(payrollCalls).toBeGreaterThan(0);
  const before = payrollCalls();
  await page.getByTestId("button-page-refresh").click();
  await expect.poll(payrollCalls).toBeGreaterThan(before);
});

test("the button is on data pages and left off the pages that don't need it", async ({ page }) => {
  await loginAsHr(page);

  for (const path of ["/hr/dashboard", "/hr/leave", "/hr/departments", "/hr/attendance/staff", "/hr/geo-attendance"]) {
    await page.goto(path);
    await expect(page.getByTestId("button-page-refresh"), path).toBeVisible();
  }

  // Settings and data-entry forms: nothing to refresh, and a reload must never replace typed values.
  for (const path of ["/hr/settings", "/hr/employees/new"]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.getByTestId("button-page-refresh"), path).toHaveCount(0);
  }

  // Pages with their own Refresh keep exactly one.
  for (const path of ["/hr/requests", "/hr/whatsapp-control"]) {
    await page.goto(path);
    await expect(page.getByRole("button", { name: /^\s*Refresh\s*$/ }), path).toHaveCount(1);
    await expect(page.getByTestId("page-refresh-bar"), path).toHaveCount(0);
  }
});
