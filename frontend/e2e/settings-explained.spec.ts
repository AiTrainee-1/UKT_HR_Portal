import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";
import { ALL_SETTINGS } from "../src/pages/hr/settings/metas";

// The redesigned Settings page (2026-10-12): every setting says what it is for and what changes when it changes, the page's
// search and its addresses (/hr/settings?tab=attendance#late-window) take you to a setting, and the groups of tabs in the
// navigation are the ones the owner asked for. The values themselves are covered by settings.spec.ts and the per-tab specs.

const TABS: [id: string, label: string][] = [
  ["company", "Company"],
  ["hr_contact", "HR Contact"],
  ["themes", "Themes"],
  ["attendance", "Attendance"],
  ["production_shifts", "Production Shifts"],
  ["late_detection", "Late Detection"],
  ["compensation", "Compensation"],
  ["devices", "Devices"],
  ["payroll", "Staff Payroll"],
  ["production_payroll", "Production Payroll"],
  ["pf_esi", "PF & ESI"],
  ["salary-slip", "Salary Slip"],
  ["documents", "Company Documents"],
  ["idcard", "ID Card"],
  ["smtp", "SMTP / Email"],
  ["whatsapp", "WhatsApp"],
  // Endpoint Sharing is for the super admin only: the e2e admin is one, so it is in this list (and hidden for everybody else,
  // see endpoint-sharing.spec.ts)
  ["endpoint_sharing", "Endpoint Sharing"],
  ["backup", "Backup"],
];

async function openSettingsTab(page: Page, id: string) {
  await page.goto(`/hr/settings?tab=${id}`);
  await expect(page.getByTestId(`settings-panel-${id}`)).toBeVisible({ timeout: 30_000 });
  // the tab's code loads on demand: wait until the skeleton is gone
  await expect(page.getByTestId("settings-loading")).toHaveCount(0, { timeout: 30_000 });
}

test.describe.configure({ mode: "serial" });

test("the navigation has every tab, in the five groups, each a real tab", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/settings");
  await expect(page.getByRole("tab", { name: "Company", exact: true })).toBeVisible();
  const names = await page.getByRole("tab").evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()));
  expect(names).toEqual(TABS.map(([, label]) => label));
  for (const heading of ["Organisation", "Attendance & time", "Pay", "Documents & cards", "Messages & data"]) {
    await expect(page.getByTestId("settings-nav").getByText(heading, { exact: true })).toBeVisible();
  }
  // the arrow keys move between tabs
  await page.getByRole("tab", { name: "Company", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("tab", { name: "HR Contact", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("every setting on every tab says what it is for, and every searchable setting is on its tab", async ({ page }) => {
  test.setTimeout(240_000);
  await loginAsHr(page);
  for (const [id, label] of TABS) {
    await openSettingsTab(page, id);
    const blocks = await page.locator("[data-setting-id]").evaluateAll((els) =>
      els.map((el) => ({
        id: (el as HTMLElement).dataset.settingId ?? "",
        purpose: el.querySelector('[data-testid="setting-purpose"]')?.textContent?.trim().length ?? 0,
        title: el.querySelector("h4")?.textContent?.trim() ?? "",
      })),
    );
    const known = new Set(blocks.map((b) => b.id));

    // each block has a heading and a real explanation (not a stub)
    for (const b of blocks) {
      expect(b.title.length, `${label}: ${b.id} has a heading`).toBeGreaterThan(2);
      expect(b.purpose, `${label}: ${b.id} says what it is for`).toBeGreaterThan(25);
    }
    // the search catalogue and the page agree: every catalogued setting has its anchor. Some tabs keep settings in
    // sub-tabs (Payroll, Production Payroll): the address names the setting and the tab opens the sub-tab that holds it.
    for (const meta of ALL_SETTINGS.filter((m) => m.tab === id)) {
      if (!known.has(meta.id)) {
        await page.evaluate((target) => {
          window.location.hash = target;
        }, meta.id);
        await expect(
          page.locator(`[data-setting-id="${meta.id}"]`),
          `${label}: search target #${meta.id} opens its sub-tab and exists`,
        ).toHaveCount(1, { timeout: 10_000 });
        const purpose = await page
          .locator(`[data-setting-id="${meta.id}"] [data-testid="setting-purpose"]`)
          .first()
          .innerText();
        expect(purpose.trim().length, `${label}: ${meta.id} says what it is for`).toBeGreaterThan(25);
      }
    }
    // a tab with settings in its catalogue also lists what changes for at least one of them
    // (Endpoint Sharing opens on its list of endpoints; its settings only exist inside an endpoint's editor)
    if (id !== "endpoint_sharing" && ALL_SETTINGS.some((m) => m.tab === id)) {
      await expect(page.getByTestId("setting-affects").first(), `${label}: a 'What changes' list`).toBeVisible();
    }
  }
});

test("the search takes you to the setting: its tab opens and it is scrolled to and flashed", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/settings");
  const search = page.getByRole("combobox", { name: "Find a setting" });
  await search.fill("late window");
  const hit = page.getByTestId("settings-search-hit-attendance-late-window");
  await expect(hit).toBeVisible();
  await hit.click();

  await expect(page.getByRole("tab", { name: "Attendance", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/tab=attendance/);
  const block = page.locator('[data-setting-id="late-window"]');
  await expect(block).toBeInViewport();
  await expect(block).toHaveClass(/setting-flash/);

  // nothing matches: it says so
  await search.fill("zzzzqqq");
  await expect(page.getByTestId("settings-search-results")).toContainText('No setting mentions "zzzzqqq"');
});

test("an address names a tab and a setting: /hr/settings?tab=attendance#late-window", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/settings?tab=attendance#late-window");
  await expect(page.getByRole("tab", { name: "Attendance", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-setting-id="late-window"]')).toBeInViewport({ timeout: 15_000 });

  // an unknown tab falls back to the first one; the address follows the tab that is open
  await page.goto("/hr/settings?tab=nonsense");
  await expect(page.getByRole("tab", { name: "Company", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Backup", exact: true }).click();
  await expect(page).toHaveURL(/tab=backup/);
});

test("a setting with a worked example shows it, and it follows what is typed", async ({ page }) => {
  await loginAsHr(page);
  await openSettingsTab(page, "attendance");
  const block = page.locator('[data-setting-id="late-window"]');
  await block.scrollIntoViewIfNeeded();
  const preview = block.getByTestId("setting-preview");
  await expect(preview).toBeVisible();
  const before = (await preview.innerText()).trim();
  await block.getByRole("spinbutton").first().fill("30");
  await expect
    .poll(async () => (await preview.innerText()).trim(), { message: "the example changes with the value" })
    .not.toBe(before);
});
