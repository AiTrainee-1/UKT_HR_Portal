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

test("Refresh reloads the data on a page that still has it (the Attendance hub)", async ({ page }) => {
  await loginAsHr(page);
  const employeeCalls = countRequests(page, "/api/employees");
  await page.goto("/hr/attendance");

  const refresh = page.getByTestId("button-page-refresh");
  await expect(refresh).toBeVisible();
  await expect(page.getByTestId("page-last-updated")).toContainText("Updated");
  await expect.poll(employeeCalls).toBeGreaterThan(0);

  // the data is fetched again from the server
  const before = employeeCalls();
  await refresh.click();
  await expect.poll(employeeCalls).toBeGreaterThan(before);
  await expect(refresh).toBeEnabled();
});

test("the header has no Refresh on the pages the owner listed, and the strip stays on the others", async ({ page }) => {
  await loginAsHr(page);

  // 2026-10-10: removed from these headers (the Biometric Connectors pages are in the same list)
  for (const path of [
    "/hr/dashboard",
    "/hr/employees",
    "/hr/departments",
    "/hr/designations",
    "/hr/branches",
    "/hr/attendance/staff",
    "/hr/attendance/production",
    "/hr/attendance/search",
    "/hr/attendance/report-log",
    "/hr/promotion",
    "/hr/increment",
    "/hr/bonus",
    "/hr/id-cards",
    "/hr/payroll",
    "/hr/production-payroll",
    "/hr/compensation",
    "/hr/settlement",
    "/hr/account-management",
    "/hr/user-management",
    "/hr/notifications",
    "/hr/Biometric-Connectors/device-status",
    "/hr/Biometric-Connectors/DeviceControl",
  ]) {
    await page.goto(path);
    await expect(page.locator("main"), path).toBeVisible();
    await expect(page.getByTestId("page-refresh-bar"), path).toHaveCount(0);
    await expect(page.getByTestId("button-page-refresh"), path).toHaveCount(0);
    await expect(page.getByTestId("page-last-updated"), path).toHaveCount(0);
  }

  // a data page that was not listed keeps the strip
  await page.goto("/hr/attendance");
  await expect(page.getByTestId("page-refresh-bar")).toBeVisible();
  await expect(page.getByTestId("button-page-refresh")).toBeVisible();

  // Settings and data-entry forms: nothing to refresh, and a reload must never replace typed values.
  for (const path of ["/hr/settings", "/hr/employees/new"]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.getByTestId("button-page-refresh"), path).toHaveCount(0);
  }

  // Pages with their own Refresh keep exactly one.
  for (const path of ["/hr/requests", "/hr/whatsapp-control", "/hr/gmail-control"]) {
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
