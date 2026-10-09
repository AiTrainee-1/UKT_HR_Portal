import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// The Biometric Connectors section of the sidebar: Biometric Device Status and Device Control moved there from the
// Attendance menu. This spec is only about WHERE they are (the menu, the addresses, who may open them); what the two
// pages do is covered by device-status.spec.ts and device-control.spec.ts.
//
// Everything created here is prefixed "bcn_" and removed afterwards. The server throttles sign-ins, so each role signs
// in once.

const BASE = "/hr/Biometric-Connectors";
const PASSWORD = "Passw0rd!bcnav";

let adminToken = "";
let viewerToken = "";
let noAttendanceToken = "";

async function signIn(request: APIRequestContext, username: string, password: string) {
  const res = await request.post("/api/auth/hr-login", { data: { username, password } });
  expect(res.status(), `sign in as ${username}`).toBe(200);
  return (await res.json()).token as string;
}

async function api(request: APIRequestContext, method: string, url: string, data?: unknown) {
  const res = await request.fetch(url, { method, headers: { Authorization: `Bearer ${adminToken}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function purge(request: APIRequestContext) {
  const users = (await api(request, "GET", "/api/hr-users")).body as { id: number; username: string }[];
  for (const u of users.filter((u) => u.username.startsWith("bcn_")))
    await api(request, "DELETE", `/api/hr-users/${u.id}`);
  const roles = (await api(request, "GET", "/api/roles")).body as { id: number; name: string }[];
  for (const r of roles.filter((r) => r.name.startsWith("bcn_"))) await api(request, "DELETE", `/api/roles/${r.id}`);
}

async function makeRole(request: APIRequestContext, name: string, permissions: Record<string, string>) {
  const role = await api(request, "POST", "/api/roles", { name: `bcn_${name}`, permissions });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  const user = await api(request, "POST", "/api/hr-users", {
    username: `bcn_${name}`,
    password: PASSWORD,
    roleId: role.body.id,
  });
  expect(user.status, JSON.stringify(user.body)).toBe(201);
  return signIn(request, `bcn_${name}`, PASSWORD);
}

async function openAs(page: Page, token: string, path: string) {
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), token);
  await page.goto(path);
}

const sidebar = (page: Page) => page.locator("nav");

test.beforeAll(async ({ request }) => {
  adminToken = await signIn(request, HR_USERNAME, HR_PASSWORD);
  await purge(request);
  viewerToken = await makeRole(request, "viewer", { dashboard: "view", attendance: "view" });
  noAttendanceToken = await makeRole(request, "noatt", { dashboard: "view" });
});

test.afterAll(async ({ request }) => {
  await purge(request);
});

test("Biometric Connectors sits below Gmail Control, above Settings, with the two pages inside it", async ({
  page,
}) => {
  await openAs(page, adminToken, "/hr/dashboard");
  const text = await sidebar(page).innerText();
  const at = (label: string) => text.indexOf(label);
  expect(at("Gmail Control")).toBeGreaterThan(-1);
  expect(at("Biometric Connectors")).toBeGreaterThan(at("Gmail Control"));
  expect(at("Settings")).toBeGreaterThan(at("Biometric Connectors"));

  // it opens like the Attendance menu does, and its two sub-items go to the two pages
  await sidebar(page).getByText("Biometric Connectors", { exact: true }).click();
  await expect(sidebar(page).getByRole("link", { name: "Device Control" })).toBeVisible();
  await sidebar(page).getByRole("link", { name: "Device Control" }).click();
  await expect(page).toHaveURL(/\/hr\/Biometric-Connectors\/DeviceControl$/);
  await expect(page.getByTestId("device-control-page")).toBeVisible();

  await sidebar(page).getByRole("link", { name: "Biometric Device Status" }).click();
  await expect(page).toHaveURL(/\/hr\/Biometric-Connectors\/device-status$/);
  await expect(page.getByTestId("device-status-page")).toBeVisible();
});

test("the section is already open when one of its pages is, and Device Control's tabs stay inside it", async ({
  page,
}) => {
  await openAs(page, adminToken, `${BASE}/DeviceControl`);
  await expect(page.getByTestId("device-control-page")).toBeVisible();
  await expect(sidebar(page).getByRole("link", { name: "Biometric Device Status" })).toBeVisible();

  await page.getByRole("tab", { name: /Data Fetch/ }).click();
  await expect(page).toHaveURL(/\/hr\/Biometric-Connectors\/DeviceControl\/fetch$/);
  await page.getByRole("tab", { name: /Data Push/ }).click();
  await expect(page).toHaveURL(/\/hr\/Biometric-Connectors\/DeviceControl\/push$/);
  await page.getByRole("tab", { name: /Site connectors/ }).click();
  await expect(page).toHaveURL(/\/hr\/Biometric-Connectors\/DeviceControl\/connectors$/);
  await page.getByRole("tab", { name: /Overview/ }).click();
  await expect(page).toHaveURL(/\/hr\/Biometric-Connectors\/DeviceControl$/);
});

test("the Attendance menu no longer lists them", async ({ page }) => {
  await openAs(page, adminToken, "/hr/attendance/staff");
  await expect(sidebar(page).getByRole("link", { name: "Staff Attendance" })).toBeVisible();
  const hrefs = await sidebar(page)
    .locator("a[href^='/hr/attendance']")
    .evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  expect(hrefs).toContain("/hr/attendance/search");
  expect(hrefs).toContain("/hr/attendance/report-log");
  expect(hrefs.join(" ")).not.toMatch(/device-status|DeviceControl/i);
});

test("the old addresses still open the pages, in their new place, with the query kept", async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), adminToken);

  await page.goto("/hr/attendance/device-status");
  await expect(page).toHaveURL(/\/hr\/Biometric-Connectors\/device-status$/);
  await expect(page.getByTestId("device-status-page")).toBeVisible();

  await page.goto("/hr/attendance/DeviceControl");
  await expect(page).toHaveURL(/\/hr\/Biometric-Connectors\/DeviceControl$/);
  await expect(page.getByTestId("device-control-page")).toBeVisible();

  await page.goto("/hr/attendance/DeviceControl/fetch?device=5");
  await expect(page).toHaveURL(/\/hr\/Biometric-Connectors\/DeviceControl\/fetch\?device=5$/);
  await expect(page.getByTestId("device-control-page")).toBeVisible();

  // and the bare section address goes to its first page
  await page.goto(BASE);
  await expect(page).toHaveURL(/\/hr\/Biometric-Connectors\/device-status$/);
});

test("Back from a moved page does not bounce through the old address", async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), adminToken);
  await page.goto("/hr/dashboard");
  await page.goto("/hr/attendance/device-status");
  await expect(page).toHaveURL(/\/hr\/Biometric-Connectors\/device-status$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/hr\/dashboard$/);
});

test("a role that may view Attendance sees the section and opens its pages", async ({ page }) => {
  await openAs(page, viewerToken, "/hr/dashboard");
  await expect(sidebar(page).getByText("Biometric Connectors", { exact: true })).toBeVisible();
  await page.goto(`${BASE}/DeviceControl`);
  await expect(page.getByTestId("device-control-page")).toBeVisible();
  await page.goto(`${BASE}/device-status`);
  await expect(page.getByTestId("device-status-page")).toBeVisible();
});

test("a role without Attendance does not see the section, and its addresses send it home (in any case)", async ({
  page,
}) => {
  await openAs(page, noAttendanceToken, "/hr/dashboard");
  await expect(sidebar(page).getByText("Staff Attendance")).toHaveCount(0);
  await expect(sidebar(page).getByText("Biometric Connectors", { exact: true })).toHaveCount(0);
  for (const path of [`${BASE}/DeviceControl`, `${BASE}/device-status`, "/hr/biometric-connectors/devicecontrol"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/hr\/dashboard$/);
  }
});
