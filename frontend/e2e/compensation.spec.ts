import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// The Compensation page is mandatory. Settings -> Payroll -> OT / Compensation switches the background OT and
// Compensation FEATURES (after a confirmation); it must never hide the page or leave it unable to load.

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const sidebarLink = (page: Page) => page.getByRole("link", { name: "Compensation", exact: true });

async function hrToken(page: Page) {
  return page.evaluate(() => localStorage.getItem("uk_textile_token"));
}

async function openFeatureSwitch(page: Page) {
  await page.goto("/hr/settings");
  await tab(page, "Payroll").click();
  await tab(page, "OT / Compensation").click();
  const toggle = page.getByTestId("toggle-compensation-features");
  await expect(toggle).toBeVisible();
  return toggle;
}

test.describe.configure({ mode: "serial" });

test("Compensation is in the sidebar and opens with all four tabs", async ({ page }) => {
  await loginAsHr(page);
  await expect(sidebarLink(page)).toBeVisible();
  await sidebarLink(page).click();
  await expect(page).toHaveURL(/\/hr\/compensation/);
  await expect(page.getByRole("heading", { name: "Compensation" })).toBeVisible();
  for (const name of ["CTC Breakdown", "OT Detection", "Compensation Leave", "History & Reports"]) {
    await expect(tab(page, name)).toBeVisible();
  }
  await expect(page.getByTestId("compensation-features-off")).toHaveCount(0);
});

test("turning the features off asks first, and Cancel changes nothing", async ({ page }) => {
  await loginAsHr(page);
  const toggle = await openFeatureSwitch(page);
  await expect(toggle).toBeChecked();
  await toggle.click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Turn off the OT & Compensation features?");
  await expect(dialog).toContainText("Compensation page stays in the sidebar");
  await dialog.getByRole("button", { name: "Keep them on" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(toggle).toBeChecked();

  // Nothing was saved.
  const token = await hrToken(page);
  const settings = await (
    await page.request.get("/api/payroll-settings", { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  expect(settings.compensationFeatureEnabled).toBe(true);
});

test("with the features off the page stays in the sidebar and still works; only the changes are paused", async ({
  page,
}) => {
  await loginAsHr(page);
  const toggle = await openFeatureSwitch(page);
  await toggle.click();
  await page.getByTestId("confirm-compensation-features-off").click();
  await expect(page.getByText("OT & Compensation features OFF").first()).toBeVisible();
  await expect(toggle).not.toBeChecked();

  // The sidebar entry is still there, the page opens, and says what is paused.
  await expect(sidebarLink(page)).toBeVisible();
  await sidebarLink(page).click();
  await expect(page).toHaveURL(/\/hr\/compensation/);
  await expect(page.getByRole("heading", { name: "Compensation" })).toBeVisible();
  const notice = page.getByTestId("compensation-features-off");
  await expect(notice).toContainText("The OT and Compensation features are switched off");
  await expect(notice).toContainText("This page and every record on it stay available");

  // Reading works on every tab (no 403 message, no empty "disabled" screen).
  await expect(page.getByText("Compensation feature is currently disabled")).toHaveCount(0);
  for (const name of ["CTC Breakdown", "OT Detection", "Compensation Leave", "History & Reports"]) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
  }
  await tab(page, "CTC Breakdown").click();
  await expect(page.getByText("E2E001").first()).toBeVisible();

  // Announce / add / redeem are paused, with the reason on the button.
  await tab(page, "OT Detection").click();
  const announce = page.getByRole("button", { name: "Announce as Pay" });
  await expect(announce).toBeDisabled();
  await expect(announce).toHaveAttribute("title", /switched off in Settings/);
  await tab(page, "Compensation Leave").click();
  await expect(page.getByRole("button", { name: "Announce Compensation Day" })).toBeDisabled();

  // The API agrees: reads answer, changes are refused with the reason.
  const auth = { Authorization: `Bearer ${await hrToken(page)}` };
  for (const path of ["", "/ot", "/credits", "/leave-days", "/summary"]) {
    const r = await page.request.get(`/api/compensation${path}`, { headers: auth });
    expect(r.status(), path || "/").toBe(200);
  }
  const refused = await page.request.post("/api/compensation/leave-days", {
    headers: auth,
    data: { date: "2030-01-01" },
  });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error).toContain("switched off in Settings");
});

test("switching the features back on needs no confirmation and lifts the pause", async ({ page }) => {
  await loginAsHr(page);
  const toggle = await openFeatureSwitch(page);
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByText("OT & Compensation features ON").first()).toBeVisible();
  await expect(toggle).toBeChecked();

  await sidebarLink(page).click();
  await expect(page.getByRole("heading", { name: "Compensation" })).toBeVisible();
  await expect(page.getByTestId("compensation-features-off")).toHaveCount(0);
  await tab(page, "Compensation Leave").click();
  await expect(page.getByRole("button", { name: "Announce Compensation Day" })).toBeEnabled();
});
