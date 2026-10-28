import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// The Settings page keeps its section menu pinned to the top of the page. On a window shorter than the list the lower
// items (Salary Slip, Backup ...) used to sit below the screen with no way to reach them: the menu has to scroll on its own.

const NAV = 'nav[aria-label="Settings sections"]';

async function openSettings(page: Page, theme: "default" | "clean", height: number) {
  await page.setViewportSize({ width: 1366, height });
  await page.addInitScript((id) => {
    try {
      localStorage.setItem("uk_textile_theme_device", id);
    } catch {
      /* the page still renders without it */
    }
  }, theme);
  await loginAsHr(page);
  await page.goto("/hr/settings");
  await expect(page.locator(NAV)).toBeVisible();
}

for (const theme of ["default", "clean"] as const) {
  test(`${theme} theme: a short window can still reach every settings tab`, async ({ page }) => {
    await openSettings(page, theme, 560);
    const nav = page.locator(NAV);

    // The menu is pinned only once the page has scrolled past the title: scroll down, as a user reading a long tab does.
    await page.waitForLoadState("networkidle");
    await page.locator('[data-ui-shell="main"]').evaluate((el) => {
      el.scrollTop = 400;
    });
    await expect.poll(() => nav.evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBeLessThanOrEqual(44);
    const box = await nav.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
      top: el.getBoundingClientRect().top,
      bottom: el.getBoundingClientRect().bottom,
      innerHeight: window.innerHeight,
    }));
    expect(box.overflowY).toBe("auto");
    expect(box.scrollHeight, "the menu is longer than the window").toBeGreaterThan(box.clientHeight);
    expect(box.top, "the menu is pinned below the top edge").toBeGreaterThanOrEqual(0);
    expect(box.bottom, "the pinned menu stays inside the window").toBeLessThanOrEqual(box.innerHeight);

    const last = nav.getByRole("tab").last();
    await last.scrollIntoViewIfNeeded();
    const lastBottom = await last.evaluate((el) => el.getBoundingClientRect().bottom);
    expect(lastBottom, "the last tab can be scrolled into the window").toBeLessThanOrEqual(box.innerHeight);

    const label = ((await last.innerText()) || "").trim();
    await last.click();
    await expect(page.getByRole("tab", { name: label, exact: true })).toHaveAttribute("aria-selected", "true");
  });

  test(`${theme} theme: a tall window shows the whole menu with no scrollbar of its own`, async ({ page }) => {
    await openSettings(page, theme, 1200);
    const m = await page.locator(NAV).evaluate((el) => ({ s: el.scrollHeight, c: el.clientHeight }));
    expect(m.s).toBeLessThanOrEqual(m.c + 1);
  });
}
