import { expect, type Page } from "@playwright/test";

// Must match backend/api/management/commands/seed_e2e.py
export const HR_USERNAME = "e2e_admin";
export const HR_PASSWORD = "E2e-Passw0rd!";

export async function loginAsHr(page: Page) {
  await page.goto("/hr-login");
  await page.getByTestId("input-username").fill(HR_USERNAME);
  await page.getByTestId("input-password").fill(HR_PASSWORD);
  await page.getByTestId("button-submit").click();
  await expect(page).toHaveURL(/\/hr\/dashboard/);
}
