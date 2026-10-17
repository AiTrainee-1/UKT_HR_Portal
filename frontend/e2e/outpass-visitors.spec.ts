import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Outpass / Visitors / Tea Break: three pages under /hr/outpass-visitors, the sidebar having an entry for each. Outpass and Tea
// Break keep their tabs in the path (/outpass/overview/passes, /outpass/requests, /outpass/in-out, /tea-break/records,
// /tea-break/rule) and Outpass has nested tabs under Overview (/passes, /qr-submissions); Visitors is one list. Each tab shows its
// own section only, a path that stops early (or names something unknown) goes to the first tab, and the three first-level
// addresses keep working.

const BASE = "/hr/outpass-visitors";
const sidebar = (page: Page) => page.getByRole("complementary");
const tab = (page: Page, name: string | RegExp) => page.getByRole("tab", { name });
const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });

async function hrToken(page: Page) {
  return page.evaluate(() => localStorage.getItem("uk_textile_token"));
}

test.describe.configure({ mode: "serial" });

test("the three first-level addresses keep working and open on their first tab", async ({ page }) => {
  await loginAsHr(page);
  await page.goto(`${BASE}/outpass`);
  await expect(page).toHaveURL(`${BASE}/outpass/overview/passes`);
  await expect(heading(page, "Outpass")).toBeVisible();
  await expect(page.getByTestId("outpass-passes")).toBeVisible();

  await page.goto(`${BASE}/visitors`);
  await expect(page).toHaveURL(`${BASE}/visitors`);
  await expect(heading(page, "Visitors")).toBeVisible();
  await expect(page.getByTestId("visitors-list")).toBeVisible();
  // one list: no tab strip at all
  await expect(page.locator('[data-testid$="subtabs"]')).toHaveCount(0);

  await page.goto(`${BASE}/tea-break`);
  await expect(page).toHaveURL(`${BASE}/tea-break/records`);
  await expect(heading(page, "Tea Break")).toBeVisible();
  await expect(page.getByTestId("tea-break-list")).toBeVisible();

  // the bare prefix is Outpass
  await page.goto(BASE);
  await expect(page).toHaveURL(`${BASE}/outpass/overview/passes`);
});

test("a path that stops early, or names something unknown, goes to the first tab, keeping the query string", async ({
  page,
}) => {
  await loginAsHr(page);
  for (const [from, to] of [
    [`${BASE}/outpass/overview`, `${BASE}/outpass/overview/passes`],
    [`${BASE}/outpass/overview/nope`, `${BASE}/outpass/overview/passes`],
    [`${BASE}/outpass/nope`, `${BASE}/outpass/overview/passes`],
    [`${BASE}/outpass/requests/deeper`, `${BASE}/outpass/requests`],
    [`${BASE}/tea-break/nope`, `${BASE}/tea-break/records`],
    [`${BASE}/tea-break/rule/deeper`, `${BASE}/tea-break/rule`],
    [`${BASE}/visitors/anything`, `${BASE}/visitors`],
    [`${BASE}/outpass?from=link`, `${BASE}/outpass/overview/passes?from=link`],
  ]) {
    await page.goto(from);
    await expect(page, from).toHaveURL(to);
  }
});

test("Outpass: each tab shows only its own section, and the sidebar item stays lit and unchanged", async ({ page }) => {
  await loginAsHr(page);
  await page.goto(`${BASE}/outpass`);
  await expect(page.getByTestId("outpass-passes")).toBeVisible();
  await expect(page.getByTestId("outpass-qr-submissions")).toHaveCount(0);
  await expect(page.getByTestId("outpass-requests")).toHaveCount(0);
  await expect(page.getByTestId("outpass-in-out")).toHaveCount(0);

  await page.getByTestId("outpass-overview-nested-qr-submissions").click();
  await expect(page).toHaveURL(`${BASE}/outpass/overview/qr-submissions`);
  await expect(page.getByTestId("outpass-qr-submissions")).toBeVisible();
  await expect(page.getByTestId("outpass-passes")).toHaveCount(0);

  await tab(page, /^Requests/).click();
  await expect(page).toHaveURL(`${BASE}/outpass/requests`);
  await expect(page.getByTestId("outpass-requests")).toBeVisible();
  await expect(page.getByTestId("outpass-overview")).toHaveCount(0);

  await tab(page, /^In\/Out/).click();
  await expect(page).toHaveURL(`${BASE}/outpass/in-out`);
  await expect(page.getByTestId("outpass-in-out")).toBeVisible();

  await tab(page, "Overview").click();
  await expect(page).toHaveURL(`${BASE}/outpass/overview/passes`);

  // the sidebar keeps its three entries, in this order, and Outpass stays lit on every tab
  await page.goto(`${BASE}/outpass/in-out`);
  const links = sidebar(page).locator(`a[href^="${BASE}/"]`);
  await expect(links).toHaveText([/Outpass/, /Visitors/, /Tea Break/]);
  await expect(links.nth(0)).toHaveAttribute("href", `${BASE}/outpass`);
  await expect(links.nth(1)).toHaveAttribute("href", `${BASE}/visitors`);
  await expect(links.nth(2)).toHaveAttribute("href", `${BASE}/tea-break`);
  const lit = async (name: string) =>
    ((await sidebar(page).locator(`a[href="${BASE}/${name}"] > div`).getAttribute("class")) ?? "").includes(
      "clay-nav-active",
    );
  expect([await lit("outpass"), await lit("visitors"), await lit("tea-break")]).toEqual([true, false, false]);
  await page.goto(`${BASE}/tea-break/rule`);
  await expect(page.getByTestId("tea-break-rule")).toBeVisible();
  expect([await lit("outpass"), await lit("visitors"), await lit("tea-break")]).toEqual([false, false, true]);
});

test("Outpass: the range filter is kept across the two sections of Overview", async ({ page }) => {
  await loginAsHr(page);
  await page.goto(`${BASE}/outpass/overview/passes`);
  await tab(page, "This Month").click();
  await expect(tab(page, "This Month")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("outpass-overview-nested-qr-submissions").click();
  await expect(page.getByTestId("outpass-qr-submissions")).toBeVisible();
  await expect(tab(page, "This Month")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("outpass-qr-submissions")).toContainText("this month");
});

test("Outpass: a Gate QR submission is listed, and counted on its tab", async ({ page }) => {
  await loginAsHr(page);
  const headers = { Authorization: `Bearer ${await hrToken(page)}` };
  const branches = await (await page.request.get("/api/branches", { headers })).json();
  const qr = await page.request.get(`/api/outpass/qr?branchId=${branches[0].id}`, { headers });
  expect(qr.status()).toBe(200);
  const { token } = await qr.json();
  const submit = await page.request.post(`/api/outpass/gate/${token}/submit`, {
    data: { name: "E2E Gate Person", employeeCode: "E2E-NOBODY", destination: "E2E Bank" },
  });
  expect(submit.status()).toBe(201);

  await page.goto(`${BASE}/outpass/overview/qr-submissions`);
  await expect(page.getByTestId("outpass-qr-submissions")).toContainText("E2E Gate Person");
  await expect(page.getByTestId("outpass-overview-nested-qr-submissions")).toContainText(/\(\d+\)/);
});

test("Outpass: the arrow keys move between the nested tabs", async ({ page }) => {
  await loginAsHr(page);
  await page.goto(`${BASE}/outpass/overview/passes`);
  const passes = page.getByTestId("outpass-overview-nested-passes");
  await passes.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(`${BASE}/outpass/overview/qr-submissions`);
  await expect(page.getByTestId("outpass-qr-submissions")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(page).toHaveURL(`${BASE}/outpass/overview/passes`);
});

test("Tea Break: Records and Rule are separate tabs, and the filters are kept between them", async ({ page }) => {
  await loginAsHr(page);
  await page.goto(`${BASE}/tea-break`);
  await expect(page.getByTestId("tea-break-list")).toBeVisible();
  await expect(page.getByTestId("tea-break-rule")).toHaveCount(0);

  await tab(page, "This Week").click();
  await page.getByRole("button", { name: "Overtime", exact: true }).click();

  await tab(page, "Rule").click();
  await expect(page).toHaveURL(`${BASE}/tea-break/rule`);
  await expect(page.getByTestId("tea-break-rule")).toBeVisible();
  await expect(page.getByTestId("tea-break-list")).toHaveCount(0);

  await tab(page, "Records").click();
  await expect(page).toHaveURL(`${BASE}/tea-break/records`);
  await expect(tab(page, "This Week")).toHaveAttribute("aria-selected", "true");
});

test("a role without the Outpass / Visitors module cannot open any of its tabs", async ({ page }) => {
  await loginAsHr(page);
  const admin = { Authorization: `Bearer ${await hrToken(page)}` };
  const stamp = Date.now().toString(36);
  const role = await page.request.post("/api/roles", {
    headers: admin,
    data: { name: `e2e-no-gate-${stamp}`, permissions: { dashboard: "view" } },
  });
  expect(role.status()).toBe(201);
  const roleId = (await role.json()).id as number;
  const username = `e2e_nogate_${stamp}`;
  const password = "E2e-Limited-1!";
  const user = await page.request.post("/api/hr-users", { headers: admin, data: { username, password, roleId } });
  expect(user.status()).toBe(201);
  try {
    const login = await page.request.post("/api/auth/hr-login", { data: { username, password } });
    const token = (await login.json()).token as string;
    await page.evaluate((t) => localStorage.setItem("uk_textile_token", t), token);
    await page.goto("/hr/dashboard");
    await expect(page).toHaveURL(/\/hr\/dashboard/);
    await expect(sidebar(page).getByText("Outpass / Visitors", { exact: true })).toHaveCount(0);
    for (const path of [
      BASE,
      `${BASE}/outpass`,
      `${BASE}/outpass/overview/passes`,
      `${BASE}/outpass/overview/qr-submissions`,
      `${BASE}/outpass/requests`,
      `${BASE}/outpass/in-out`,
      `${BASE}/visitors`,
      `${BASE}/tea-break`,
      `${BASE}/tea-break/rule`,
    ]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/hr\/dashboard/);
    }
  } finally {
    await page.request.delete(`/api/hr-users/${(await user.json()).id}`, { headers: admin });
    await page.request.delete(`/api/roles/${roleId}`, { headers: admin });
  }
});
