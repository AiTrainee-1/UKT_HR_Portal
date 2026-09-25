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

  for (const path of ["/hr/dashboard", "/hr/departments", "/hr/attendance/staff"]) {
    await page.goto(path);
    await expect(page.getByTestId("page-refresh-bar"), path).toBeVisible();
    await expect(page.getByTestId("button-page-refresh"), path).toBeVisible();
  }

  // Settings and data-entry forms: nothing to refresh, and a reload must never replace typed values.
  for (const path of ["/hr/settings", "/hr/employees/new"]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.getByTestId("button-page-refresh"), path).toHaveCount(0);
  }

  // Pages with their own Refresh keep exactly one.
  for (const path of ["/hr/requests", "/hr/whatsapp-control", "/hr/attendance/search"]) {
    await page.goto(path);
    await expect(page.getByRole("button", { name: /^\s*Refresh( this page)?\s*$/ }), path).toHaveCount(1);
    await expect(page.getByTestId("page-refresh-bar"), path).toHaveCount(0);
  }
});

test("the pages you asked for have Refresh in the title row, once", async ({ page }) => {
  await loginAsHr(page);
  const pages = [
    "/hr/recruitment/dashboard",
    "/hr/recruitment/new-joinees",
    "/hr/recruitment/resignations",
    "/hr/recruitment/required-roles",
    "/hr/casual-leave",
    "/hr/leave",
    "/hr/shifts",
    "/hr/outpass-visitors/outpass",
    "/hr/outpass-visitors/visitors",
    "/hr/geo-attendance",
    "/hr/missing-punch",
  ];
  for (const path of pages) {
    const calls = countRequests(page, "/api/");
    await page.goto(path);
    const button = page.getByRole("button", { name: /^\s*Refresh( this page)?\s*$/ });
    await expect(button, path).toHaveCount(1);
    await expect(page.getByTestId("page-refresh-bar"), path).toHaveCount(0);

    // It sits on the same row as the page title, not above it.
    const title = await page.locator("main h1, main h2").first().boundingBox();
    const box = await button.boundingBox();
    expect(title && box && Math.abs(box.y - title.y) < 45, `${path}: button beside the title`).toBe(true);

    // ...and really reloads the page's data.
    await page.waitForTimeout(1000);
    const before = calls();
    await button.click();
    await expect.poll(calls, { message: path }).toBeGreaterThan(before);
    page.removeAllListeners("request");
  }
});
