import { expect, test } from "@playwright/test";
import { loginAsHr } from "./helpers";

// The "something is not right" screens: 404, server error, database offline, and the connection-lost takeover.

test("an unknown address shows the 404 page with the address and a way home", async ({ page }) => {
  await page.goto("/no/such/page");
  await expect(page.getByRole("heading", { name: "This page wandered off" })).toBeVisible();
  await expect(page.locator("code")).toContainText("/no/such/page");
  await expect(page.getByRole("link", { name: "Take me home" })).toHaveAttribute("href", "/");
  await expect(page.getByRole("button", { name: "Go back" })).toBeVisible();
  // the technical details are tucked away until asked for
  await page.getByText("Technical details").click();
  await expect(page.getByText("404 · Not found")).toBeVisible();
});

test("the server error page gives a reference to quote and ways to recover", async ({ page }) => {
  await page.goto("/server-error");
  await expect(page.getByRole("heading", { name: "Something broke on our side" })).toBeVisible();
  await page.getByText("Technical details").click();
  await expect(page.getByText(/^ERR-[A-Z0-9]{1,6}$/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
});

test("the database offline page shows where the connection breaks", async ({ page }) => {
  await page.goto("/db-offline");
  await expect(page.getByRole("heading", { name: "Database Server Offline" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Connection path" })).toContainText("Database");
  await expect(page.getByRole("button", { name: "Retry connection" })).toBeVisible();
});

test("when the server can't be reached the takeover says so, counts down, and closes itself when it is back", async ({
  page,
}) => {
  await loginAsHr(page);
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await page.goto("/hr/settings").catch(() => undefined);
  const overlay = page.getByRole("alertdialog");
  await expect(overlay).toBeVisible({ timeout: 20_000 });
  await expect(overlay).toContainText("Can't Reach the Server");
  await expect(overlay.getByRole("img", { name: "Connection path" })).toContainText("Network");
  await expect(overlay).toContainText(/Next automatic check in \d+s|Checking/);
  await expect(overlay.getByRole("button", { name: /Retry now|Checking connection/ })).toBeVisible();

  // the server comes back: the screen closes by itself
  await page.unroute("**/api/**");
  await expect(overlay).toHaveCount(0, { timeout: 20_000 });
});
