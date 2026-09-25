import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

const SHARE = "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view?usp=sharing";
const DIRECT = "https://drive.google.com/uc?export=download&id=1AbCdEfGhIjKlMnOpQrStUvWxYz012345";

async function openNewVersionTab(page: Page) {
  await page.goto("/hr/mobile-app-login");
  await page.getByRole("tab", { name: "New Version" }).click();
  await expect(page.getByTestId("new-version-tab")).toBeVisible();
  // Wait for the list itself: it is either the empty message or the first row.
  await expect(
    page.getByTestId("app-version-row").first().or(page.getByText("No versions published yet.")),
  ).toBeVisible();
}

// The app asks this with no login at all.
async function whatTheAppIsTold(page: Page, current: string) {
  const res = await page.request.get(`/api/mobile-app/latest-version?platform=android&current=${current}`);
  expect(res.status()).toBe(200);
  return res.json();
}

// Leave the shared e2e database as we found it, even when a test fails half-way.
test.afterEach(async ({ page }) => {
  try {
    const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    const rows: { id: number }[] = await (await page.request.get("/api/mobile-app/versions", { headers })).json();
    for (const row of rows) await page.request.delete(`/api/mobile-app/versions/${row.id}`, { headers });
  } catch {
    // The page may already be gone; nothing to clean.
  }
});

test("publish a version and the app is told about it", async ({ page }) => {
  await loginAsHr(page);
  await openNewVersionTab(page);
  await expect(page.getByText("No versions published yet.")).toBeVisible();

  // What the person types shows up in the preview of the prompt employees get.
  await page.getByTestId("input-app-version").fill("3.0.0");
  await page.getByTestId("input-app-link").fill(SHARE);
  await page.getByTestId("input-app-notes").fill("Chat input fixed\nFaster start-up");
  const preview = page.getByTestId("version-preview");
  await expect(preview).toContainText("New Version Available");
  await expect(preview).toContainText("Version: 3.0.0");
  await expect(preview).toContainText("Chat input fixed");
  await expect(preview).toContainText("Download and Install");
  await expect(page.getByText(/Google Drive link/)).toBeVisible();

  await page.getByTestId("button-publish-version").click();
  const row = page.getByTestId("app-version-row").filter({ hasText: "v3.0.0" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Latest");
  await expect(row).toContainText("Required update");
  await expect(row).toContainText("Chat input fixed");
  await expect(row.getByRole("link", { name: DIRECT })).toBeVisible(); // stored as a direct download

  // The form is ready for the next release.
  await expect(page.getByTestId("input-app-version")).toHaveValue("");

  // Phones on an older build are told; a phone already on it is not.
  const older = await whatTheAppIsTold(page, "2.0.0");
  expect(older.updateAvailable).toBe(true);
  expect(older.latest).toMatchObject({ version: "3.0.0", downloadUrl: DIRECT, mandatory: true });
  expect(older.latest.releaseNotes).toContain("Faster start-up");
  expect((await whatTheAppIsTold(page, "3.0.0")).updateAvailable).toBe(false);

  // Deleting the only version leaves nothing to offer.
  await row.getByRole("button", { name: /^Delete version/ }).click();
  await page.getByRole("button", { name: "Delete version", exact: true }).click();
  await expect(page.getByTestId("app-version-row")).toHaveCount(0);
  expect((await whatTheAppIsTold(page, "2.0.0")).updateAvailable).toBe(false);
});

test("a later version replaces it, an optional one can be skipped, and withdrawing goes back", async ({ page }) => {
  await loginAsHr(page);
  await openNewVersionTab(page);

  const publish = async (version: string, required: boolean) => {
    await page.getByTestId("input-app-version").fill(version);
    await page.getByTestId("input-app-link").fill(`https://example.test/ukt-${version}.apk`);
    if (!required) await page.getByRole("switch", { name: "Required update" }).click();
    await page.getByTestId("button-publish-version").click();
    await expect(page.getByTestId("app-version-row").filter({ hasText: `v${version}` })).toBeVisible();
    if (!required) await page.getByRole("switch", { name: "Required update" }).click(); // back to the default
  };

  await publish("3.0.0", true);
  // The next number is offered as a shortcut.
  await expect(page.getByRole("button", { name: "Use 3.0.1" })).toBeVisible();
  await publish("3.0.1", false);

  const rows = page.getByTestId("app-version-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("v3.0.1"); // newest first
  await expect(rows.first()).toContainText("Latest");
  await expect(rows.first()).toContainText("Optional update");
  await expect(rows.nth(1)).not.toContainText("Latest");

  // On 3.0.0 the latest is optional; on 2.0.0 the required 3.0.0 is skipped over, so the update is required.
  expect((await whatTheAppIsTold(page, "3.0.0")).latest).toMatchObject({ version: "3.0.1", mandatory: false });
  expect((await whatTheAppIsTold(page, "2.0.0")).latest).toMatchObject({ version: "3.0.1", mandatory: true });

  // Withdraw 3.0.1: the app is offered 3.0.0 again.
  await rows
    .first()
    .getByRole("switch", { name: /Offer version 3\.0\.1/ })
    .click();
  await expect(rows.first()).toContainText("Withdrawn");
  await expect(rows.nth(1)).toContainText("Latest");
  expect((await whatTheAppIsTold(page, "2.0.0")).latest.version).toBe("3.0.0");
  expect((await whatTheAppIsTold(page, "3.0.0")).updateAvailable).toBe(false);
});

test("mistakes are caught before publishing", async ({ page }) => {
  await loginAsHr(page);
  await openNewVersionTab(page);
  const publishButton = page.getByTestId("button-publish-version");
  await expect(publishButton).toBeDisabled();

  await page.getByTestId("input-app-version").fill("three");
  await expect(page.getByText("Use numbers separated by dots, like 3.0.1.")).toBeVisible();
  await page.getByTestId("input-app-link").fill("drive.google.com/abc");
  await expect(page.getByText("Enter the full link, starting with https://")).toBeVisible();
  await expect(publishButton).toBeDisabled();

  await page.getByTestId("input-app-version").fill("3.0.0");
  await page.getByTestId("input-app-link").fill("https://example.test/a.apk");
  await expect(publishButton).toBeEnabled();
  await publishButton.click();
  await expect(page.getByTestId("app-version-row")).toHaveCount(1);

  // The same release, however it is written, can't be published twice.
  await page.getByTestId("input-app-version").fill("v3.0");
  await page.getByTestId("input-app-link").fill("https://example.test/b.apk");
  await expect(page.getByText("Version v3.0 is already published.")).toBeVisible();
  await expect(publishButton).toBeDisabled();

  // A lower number is allowed but explained.
  await page.getByTestId("input-app-version").fill("2.9.0");
  await expect(page.getByText(/lower than the latest published version/)).toBeVisible();
  await expect(publishButton).toBeEnabled();
});

test("the page keeps a single Refresh button on both tabs", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/mobile-app-login");
  const refresh = page.getByRole("button", { name: /^\s*Refresh( this page)?\s*$/ });
  await expect(refresh).toHaveCount(1);
  await page.getByRole("tab", { name: "New Version" }).click();
  await expect(refresh).toHaveCount(1);
  await expect(page.getByTestId("page-refresh-bar")).toHaveCount(0);
});
