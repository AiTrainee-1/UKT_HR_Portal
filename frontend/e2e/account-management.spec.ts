import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Account Management: the summary above the lists, searching / filtering / sorting the accounts, creating, disabling and
// deleting a login, and the role editor (module search, set-every-module, copy from another role, sub-module
// exceptions, the unsaved-changes guard). Everything made here is called am_* (accounts) or "AM *" (roles) and is
// removed again, so the other specs only ever see the seed data.

async function api(page: Page, method: string, url: string, data?: unknown) {
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

type Account = { id: number; username: string; isActive: boolean; isSuperAdmin: boolean; roleId?: number | null };
type RoleRow = { id: number; name: string; permissions: Record<string, string> };

const accounts = async (page: Page) => (await api(page, "GET", "/api/hr-users")).body as Account[];
const roles = async (page: Page) => (await api(page, "GET", "/api/roles")).body as RoleRow[];

async function cleanUp(page: Page) {
  for (const u of (await accounts(page)).filter((u) => u.username.startsWith("am_"))) {
    await api(page, "DELETE", `/api/hr-users/${u.id}`);
  }
  for (const r of (await roles(page)).filter((r) => r.name.startsWith("AM "))) {
    await api(page, "DELETE", `/api/roles/${r.id}`);
  }
}

/** Two roles and three logins: one active with a branch, one disabled, one with no role. */
async function seed(page: Page) {
  const branches = (await api(page, "GET", "/api/branches")).body as { id: number }[];
  const auditor = (
    await api(page, "POST", "/api/roles", {
      name: "AM Auditor",
      description: "Reads payroll and reports",
      permissions: { dashboard: "view", payroll: "view", reports: "view", settings: "view", "settings.smtp": "hidden" },
    })
  ).body;
  const clerk = (
    await api(page, "POST", "/api/roles", {
      name: "AM Clerk",
      description: "Attendance data entry",
      permissions: { attendance: "edit", leave: "edit", employees: "view" },
    })
  ).body;
  await api(page, "POST", "/api/hr-users", {
    username: "am_asha",
    password: "Passw0rd!x",
    fullName: "Asha Kumar",
    email: "asha@uktex.net",
    roleId: auditor.id,
    branchId: branches[0].id,
  });
  const ravi = (
    await api(page, "POST", "/api/hr-users", {
      username: "am_ravi",
      password: "Passw0rd!x",
      fullName: "Ravi",
      roleId: clerk.id,
    })
  ).body;
  await api(page, "PUT", `/api/hr-users/${ravi.id}`, { isActive: false });
  await api(page, "POST", "/api/hr-users", { username: "am_temp", password: "Passw0rd!x" });
}

const row = (page: Page, username: string) => page.getByTestId("accounts-table").getByTestId(`account-row-${username}`);
const roleRow = (page: Page, name: string) => page.getByTestId("roles-table").getByTestId(`role-row-${name}`);
const openRoles = (page: Page) => page.getByRole("tab", { name: /^Roles & Permissions/ }).click();

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await loginAsHr(page);
  await cleanUp(page);
});

test.afterEach(async ({ page }) => {
  await cleanUp(page);
});

test("the summary counts accounts and roles, and warns about logins with no role", async ({ page }) => {
  const before = await accounts(page);
  const rolesBefore = await roles(page);
  await seed(page);
  await page.goto("/hr/account-management");
  await expect(page.getByTestId("stat-accounts-value")).toHaveText(String(before.length + 3));
  await expect(page.getByTestId("stat-active-value")).toHaveText(String(before.filter((a) => a.isActive).length + 2));
  await expect(page.getByTestId("stat-disabled-value")).toHaveText(
    String(before.filter((a) => !a.isActive).length + 1),
  );
  await expect(page.getByTestId("stat-roles-value")).toHaveText(String(rolesBefore.length + 2));

  // am_temp has no role; the administrator has full access without one, so is not counted
  const withoutRole = before.filter((a) => !a.roleId && !a.isSuperAdmin).length + 1;
  await expect(page.getByTestId("no-role-notice")).toContainText(
    `${withoutRole} ${withoutRole === 1 ? "account has" : "accounts have"} no role`,
  );
  await page.getByTestId("no-role-notice").getByRole("button", { name: "Show" }).click();
  await expect(row(page, "am_temp")).toBeVisible();
  await expect(row(page, "am_asha")).toHaveCount(0);
});

test("accounts can be searched, filtered and sorted", async ({ page }) => {
  await seed(page);
  await page.goto("/hr/account-management");
  await expect(row(page, "am_asha")).toBeVisible();

  // a search matches username, name, email, role or branch; every word has to match
  await page.getByTestId("account-search").fill("asha");
  await expect(row(page, "am_asha")).toBeVisible();
  await expect(row(page, "am_ravi")).toHaveCount(0);
  await page.getByTestId("account-search").fill("kumar auditor");
  await expect(row(page, "am_asha")).toBeVisible();
  await expect(page.getByTestId("account-count")).toContainText("Showing 1 of");
  await page.getByTestId("account-search").fill("nobody at all");
  await expect(page.getByTestId("accounts-no-match")).toBeVisible();
  await page.getByTestId("accounts-no-match").getByRole("button", { name: "Clear filters" }).click();
  await expect(row(page, "am_asha")).toBeVisible();
  await expect(page.getByTestId("account-search")).toHaveValue("");

  // status
  await page.getByRole("tab", { name: /^Disabled/ }).click();
  await expect(row(page, "am_ravi")).toBeVisible();
  await expect(row(page, "am_asha")).toHaveCount(0);
  await expect(row(page, "am_ravi")).toHaveAttribute("data-active", "false");
  await page.getByTestId("account-clear-filters").click();

  // role
  await page.getByTestId("filter-role").click();
  await page.getByRole("option", { name: "AM Clerk" }).click();
  await expect(row(page, "am_ravi")).toBeVisible();
  await expect(row(page, "am_asha")).toHaveCount(0);
  await page.getByTestId("account-clear-filters").click();

  // branch: company-wide logins only
  await page.getByTestId("filter-branch").click();
  await page.getByRole("option", { name: "Company-wide only" }).click();
  await expect(row(page, "am_ravi")).toBeVisible();
  await expect(row(page, "am_asha")).toHaveCount(0);
  await page.getByTestId("account-clear-filters").click();

  // sorting by username, both ways
  const first = () => page.getByTestId("accounts-table").locator("tbody tr").first();
  await page.getByTestId("sort-username").click(); // it starts ascending, so this makes it descending
  await expect(first()).toHaveAttribute("data-testid", "account-row-e2e_admin");
  await page.getByTestId("sort-username").click();
  await expect(first()).toHaveAttribute("data-testid", "account-row-am_asha");
});

test("an account is created from the form, disabled, and deleted after a confirmation", async ({ page }) => {
  await seed(page);
  await page.goto("/hr/account-management");

  await page.getByTestId("create-account").click();
  await expect(page.getByTestId("account-dialog")).toBeVisible();
  await page.getByTestId("acct-username").fill("am_new");
  await page.getByTestId("acct-fullname").fill("New Person");
  await page.getByTestId("acct-password").fill("Passw0rd!x");
  await page.getByTestId("acct-role").click();
  await page.getByRole("option", { name: "AM Auditor" }).click();
  await page.getByTestId("acct-save").click();
  await expect(page.getByTestId("account-dialog")).toHaveCount(0);
  await expect(row(page, "am_new")).toBeVisible();
  await expect(row(page, "am_new")).toContainText("AM Auditor");
  await expect(row(page, "am_new")).toContainText("New Person");

  // disable and enable again
  await row(page, "am_new").getByTestId("account-toggle-am_new").click();
  await expect(row(page, "am_new")).toHaveAttribute("data-active", "false");
  await row(page, "am_new").getByTestId("account-toggle-am_new").click();
  await expect(row(page, "am_new")).toHaveAttribute("data-active", "true");

  // delete asks first, in the page, not in a browser pop-up
  await row(page, "am_new").getByTestId("account-delete-am_new").click();
  await expect(page.getByTestId("confirm-delete")).toContainText('Delete account "am_new"?');
  await page.getByTestId("confirm-cancel").click();
  await expect(row(page, "am_new")).toBeVisible();
  await row(page, "am_new").getByTestId("account-delete-am_new").click();
  await page.getByTestId("confirm-delete-yes").click();
  await expect(row(page, "am_new")).toHaveCount(0);
  expect((await accounts(page)).some((a) => a.username === "am_new")).toBe(false);

  // the administrator can be edited but not disabled or deleted from here
  await expect(row(page, "e2e_admin").getByTestId("account-edit-e2e_admin")).toBeVisible();
  await expect(row(page, "e2e_admin").getByTestId("account-delete-e2e_admin")).toHaveCount(0);
  await expect(row(page, "e2e_admin")).toContainText("Full access");
});

test("the roles list shows who uses each role and how much it opens up", async ({ page }) => {
  await seed(page);
  await page.goto("/hr/account-management");
  await openRoles(page);
  await expect(roleRow(page, "AM Auditor")).toContainText("1 account");
  await expect(roleRow(page, "AM Auditor")).toContainText("Reads payroll and reports");
  // dashboard, payroll, reports and the whole of Settings (13 sub-modules + 1) are view; SMTP is hidden on its own
  await expect(roleRow(page, "AM Auditor")).toContainText("0 edit");
  await expect(roleRow(page, "AM Clerk")).toContainText("2 edit");

  // "1 account" jumps to those accounts
  await roleRow(page, "AM Clerk")
    .getByRole("button", { name: /1 account/ })
    .click();
  await expect(page.getByTestId("accounts-table")).toBeVisible();
  await expect(row(page, "am_ravi")).toBeVisible();
  await expect(row(page, "am_asha")).toHaveCount(0);

  // deleting a role that is in use says what will happen to its accounts
  await openRoles(page);
  await roleRow(page, "AM Clerk").getByTestId("role-delete-AM Clerk").click();
  await expect(page.getByTestId("confirm-delete")).toContainText("1 account uses this role");
  await page.getByTestId("confirm-delete-yes").click();
  await expect(roleRow(page, "AM Clerk")).toHaveCount(0);
  expect((await accounts(page)).find((a) => a.username === "am_ravi")?.roleId).toBeNull();
});

test("a role is built with search, set-every-module, copy-from and sub-module exceptions, and saved", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/hr/account-management");
  await openRoles(page);
  await page.getByTestId("create-role").click();
  const dialog = page.getByTestId("role-dialog");
  await expect(dialog).toBeVisible();

  // a name that is taken is refused as you type
  await page.getByTestId("role-name").fill("am auditor");
  await expect(page.getByTestId("role-name-error")).toContainText("already has this name");
  await expect(page.getByTestId("role-save")).toBeDisabled();
  await page.getByTestId("role-name").fill("AM Planner");
  await expect(page.getByTestId("role-name-error")).toHaveCount(0);

  // a new role starts with everything hidden
  await expect(page.getByTestId("count-edit")).toHaveText("0");
  await expect(page.getByTestId("count-view")).toHaveText("0");
  const total = Number(await page.getByTestId("count-hidden").innerText());
  expect(total).toBeGreaterThan(40);

  // search, then set one module
  await page.getByTestId("module-search").fill("payroll");
  await expect(dialog.getByTestId("section-payroll")).toBeVisible();
  await expect(dialog.getByTestId("section-dashboard")).toHaveCount(0);
  await dialog.getByTestId("perm-payroll-edit").click();
  await expect(page.getByTestId("count-edit")).toHaveText("1");
  await page.getByTestId("module-search").fill("zzzz");
  await expect(page.getByTestId("no-modules")).toBeVisible();
  await page.getByRole("button", { name: "Clear module search" }).click();

  // every module at once
  await page.getByTestId("set-all-view").click();
  await expect(page.getByTestId("count-view")).toHaveText(String(total));
  await expect(page.getByTestId("count-edit")).toHaveText("0");

  // copy from another role replaces the list, and says it is not saved yet
  await page.getByTestId("copy-from").click();
  await page.getByRole("option", { name: "AM Clerk" }).click();
  await expect(page.getByTestId("copied-note")).toContainText("copied from AM Clerk");
  await expect(page.getByTestId("count-edit")).toHaveText("2");

  // a sub-module can differ from its section; "reset" makes it follow the section again
  await page.getByTestId("module-search").fill("smtp");
  await dialog.getByTestId("perm-settings.smtp-edit").click();
  await expect(dialog.getByTestId("section-reset-settings")).toContainText("1 custom");
  await dialog.getByTestId("perm-reset-settings.smtp").click();
  await expect(dialog.getByTestId("section-reset-settings")).toHaveCount(0);
  await dialog.getByTestId("perm-settings.smtp-edit").click();
  await dialog.getByTestId("section-reset-settings").click(); // the section-wide reset
  await expect(dialog.getByTestId("section-reset-settings")).toHaveCount(0);
  await page.getByRole("button", { name: "Clear module search" }).click();

  await page.getByTestId("role-description").fill("Plans shifts");
  await page.getByTestId("role-save").click();
  await expect(dialog).toHaveCount(0);
  await expect(roleRow(page, "AM Planner")).toBeVisible();

  const saved = (await roles(page)).find((r) => r.name === "AM Planner")!;
  expect(saved.permissions.attendance).toBe("edit");
  expect(saved.permissions.leave).toBe("edit");
  expect(saved.permissions.employees).toBe("view");
  expect(saved.permissions["settings.smtp"]).toBeUndefined(); // reset: it follows Settings again
});

test("closing a role with unsaved changes asks before throwing them away", async ({ page }) => {
  await seed(page);
  await page.goto("/hr/account-management");
  await openRoles(page);
  await roleRow(page, "AM Auditor").getByTestId("role-edit-AM Auditor").click();
  const dialog = page.getByTestId("role-dialog");
  await expect(dialog).toContainText("1 account has this role");

  // nothing changed: it closes straight away
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  // something changed: it asks
  await roleRow(page, "AM Auditor").getByTestId("role-edit-AM Auditor").click();
  await page.getByTestId("module-search").fill("payroll");
  await dialog.getByTestId("perm-payroll-edit").click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("discard-confirm")).toBeVisible();
  await page.getByTestId("discard-keep").click();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("count-edit")).toHaveText("1");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("discard-confirm").click();
  await expect(dialog).toHaveCount(0);
  expect((await roles(page)).find((r) => r.name === "AM Auditor")?.permissions.payroll).toBe("view"); // not saved

  // renaming onto another role's name is refused by the server too, not a crash
  const clerk = (await roles(page)).find((r) => r.name === "AM Clerk")!;
  const clash = await api(page, "PUT", `/api/roles/${clerk.id}`, { name: "AM Auditor" });
  expect(clash.status).toBe(400);
});

test("on a phone the page fits the screen and the lists become cards", async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/hr/account-management");
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  await expect(page.getByTestId("accounts-cards")).toBeVisible();
  await expect(page.getByTestId("accounts-table")).toBeHidden();
  await expect(page.getByTestId("account-card-am_asha")).toContainText("Asha Kumar");
  expect(await fits()).toBe(true);

  await openRoles(page);
  await expect(page.getByTestId("roles-cards")).toBeVisible();
  await expect(page.getByTestId("role-card-AM Auditor")).toContainText("Reads payroll and reports");
  expect(await fits()).toBe(true);

  await page.getByTestId("create-role").click();
  const dialog = page.getByTestId("role-dialog");
  await expect(dialog).toBeVisible();
  // the dialog slides in for a third of a second: measure it once it has settled
  await expect
    .poll(async () => {
      const b = (await dialog.boundingBox())!;
      return [b.x >= 0, b.x + b.width <= 390.5, b.y >= 0, b.y + b.height <= 844.5];
    })
    .toEqual([true, true, true, true]);
  await expect(page.getByTestId("role-save")).toBeVisible(); // the buttons stay on screen while the list scrolls
});
