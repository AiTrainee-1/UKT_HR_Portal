import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Guards the per-tab split of Settings.tsx: every tab must still render its own
// form, and saves from different tabs must round-trip through the API without
// clobbering each other (each tab now owns its own state).

const TAB_HEADINGS: Record<string, string> = {
  Company: "Company Profile",
  "HR Contact": "HR & Software Support Contacts",
  Attendance: "Attendance Calculation Mode",
  "Late Detection": "Late Detection Policy",
  Devices: "Biometric / Punching Devices",
  "ID Card": "Employee ID Card Template",
  "Company Documents": "Offer Letter",
  Payroll: "Payroll Rules",
  "Production Payroll": "Weekly pay period",
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

  // the address carries the open tab (?tab=smtp), so a reload comes back to the SMTP tab
  await page.reload();
  await expect(page.getByRole("tab", { name: "SMTP / Email", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(field(page, "SMTP Host")).toHaveValue("smtp.e2e.example");
  await openTab(page, "Company");
  await expect(field(page, "Company Name")).toHaveValue("E2E Textiles Pvt Ltd");
  await openTab(page, "SMTP / Email");
  await expect(field(page, "SMTP Host")).toHaveValue("smtp.e2e.example");

  // Saving SMTP must not have reset the company name (each tab sends only its own fields).
  await openTab(page, "Company");
  await expect(field(page, "Company Name")).toHaveValue("E2E Textiles Pvt Ltd");
});

test("the Settings page is plain and flat, and its skin stays on that page only", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/settings");
  await expect(page.getByTestId("settings-page")).toBeVisible();
  const html = page.locator("html");
  await expect(html).toHaveClass(/settings-skin-on/);

  // flat: white panels with a thin border (no blur, no shadow), a plain bordered field, a flat open tab
  const style = (selector: string, property: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);
  expect(await style(".settings-glass", "backdrop-filter")).toBe("none");
  expect(await style(".settings-glass", "box-shadow")).toBe("none");
  expect(await style(".settings-glass", "background-image")).toBe("none");
  expect(await style('[data-slot="input"]', "box-shadow")).toBe("none");
  expect(await style('[role="tab"][aria-selected="true"]', "box-shadow")).toBe("none");

  // the dialogs the page opens are flat too (they render outside the page, so <html> carries the class)
  await openTab(page, "Themes");
  await page
    .getByRole("button", { name: /Customize/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe("none");
  expect(await dialog.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe("none");
  await page.keyboard.press("Escape");

  // any other page: no class on <html>, nothing of this skin
  await page.getByRole("link", { name: "Dashboard", exact: true }).first().click();
  await expect(page).toHaveURL(/\/hr\/dashboard/);
  await expect(html).not.toHaveClass(/settings-skin-on/);
  await expect(page.locator(".settings-skin")).toHaveCount(0);
});
