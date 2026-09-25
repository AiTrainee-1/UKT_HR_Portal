import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Guards the per-tab split of Settings.tsx: every tab must still render its own
// form, and saves from different tabs must round-trip through the API without
// clobbering each other (each tab now owns its own state).

const TAB_HEADINGS: Record<string, string> = {
  Company: "Company Profile",
  Attendance: "Attendance Calculation Mode",
  "Late Detection": "Late Detection Policy",
  Devices: "Biometric / Punching Devices",
  "ID Card": "Employee ID Card Template",
  "Company Documents": "Offer Letter",
  Payroll: "Payroll Rules",
  "Production Payroll": "Period Configuration",
  "Salary Slip": "Salary Slip Settings",
  "SMTP / Email": "SMTP / Email Configuration",
  WhatsApp: "WAClient WhatsApp API",
  Backup: "Scheduled Backup",
  Themes: "Themes",
};

const openTab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true }).click();
const field = (page: Page, label: string) =>
  page.getByText(label, { exact: true }).locator("xpath=following::input[1]");

test("every settings tab opens and shows its own form", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await loginAsHr(page);
  await page.goto("/hr/settings");
  for (const [tab, heading] of Object.entries(TAB_HEADINGS)) {
    await openTab(page, tab);
    await expect(page.getByText(heading, { exact: true }).first(), `${tab} tab`).toBeVisible();
  }
  expect(errors).toEqual([]);
});

test("saves from different tabs persist and do not overwrite each other", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/settings");

  await field(page, "Company Name").fill("E2E Textiles Pvt Ltd");
  await page.getByRole("button", { name: "Save Company Settings" }).click();
  await expect(page.getByText("Company settings saved").first()).toBeVisible();

  await openTab(page, "SMTP / Email");
  await field(page, "SMTP Host").fill("smtp.e2e.example");
  await page.getByRole("button", { name: "Save SMTP Settings" }).click();
  await expect(page.getByText("SMTP settings saved").first()).toBeVisible();

  await page.reload();
  await expect(field(page, "Company Name")).toHaveValue("E2E Textiles Pvt Ltd");
  await openTab(page, "SMTP / Email");
  await expect(field(page, "SMTP Host")).toHaveValue("smtp.e2e.example");

  // Saving SMTP must not have reset the company name (each tab sends only its own fields).
  await openTab(page, "Company");
  await expect(field(page, "Company Name")).toHaveValue("E2E Textiles Pvt Ltd");
});
