import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// Visitors -> Manage Reception (/hr/outpass-visitors/visitors/desks) in a real browser: a desk made through the API is
// listed, opening it shows its login, View shows the password it was given (the server keeps an encrypted copy), the records
// and the tiles are there, and on a phone the list comes first, then the desk with a way back, with nothing sticking out
// sideways. Then the desk itself signs in at the one shared /reception-login, sees its console, and Sign out ends only the
// desk's session and lands on the desk sign-in page (never an HR page). The desk is named "mr_..." and removed again.

const PAGE = "/hr/outpass-visitors/visitors/desks";
const PASSWORD = "mr-e2e-Pass1";

let token = "";
let deskId: number | null = null;

async function api(request: APIRequestContext, method: string, url: string, data?: unknown) {
  const res = await request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function open(page: Page, path: string, width: number) {
  await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), token);
  await page.goto(path);
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  const login = await request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  token = (await login.json()).token as string;
  for (const d of ((await api(request, "GET", "/api/reception-devices")).body ?? []) as {
    id: number;
    name: string;
  }[]) {
    if (d.name.startsWith("mr_")) await api(request, "DELETE", `/api/reception-devices/${d.id}`);
  }
  const branches = (await api(request, "GET", "/api/branches")).body as { id: number }[];
  const made = await api(request, "POST", "/api/reception-devices", {
    name: "mr_desk",
    branchId: branches[0].id,
    username: "mr_desk1",
    password: PASSWORD,
    location: "E2E lobby",
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  deskId = made.body.id;
});

test.afterAll(async ({ request }) => {
  if (deskId !== null) await api(request, "DELETE", `/api/reception-devices/${deskId}`);
});

test("a desk's page: its login, View password, its records and the tiles", async ({ page }) => {
  await open(page, `${PAGE}?desk=${deskId}`, 1366);
  await expect(page.locator("main h1, main h2").first()).toContainText("Visitors");
  await expect(page.getByTestId("visitors-subtabs")).toContainText("Manage Reception");
  await expect(page.getByTestId("desk-name")).toHaveText("mr_desk");
  await expect(page.getByTestId("desk-username")).toHaveText("mr_desk1");
  await expect(page.getByTestId(`desk-card-${deskId}`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("desk-signin-address")).toContainText("/reception-login");
  await expect(page.getByTestId("desk-tile-desks-value")).not.toHaveText("—");
  await expect(page.getByTestId("desk-password")).not.toContainText(PASSWORD);
  await page.getByTestId("desk-password-view").click();
  await expect(page.getByTestId("desk-password")).toHaveText(PASSWORD);
  await expect(page.getByTestId("desk-records-table")).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
});

test("on a phone: the list first, then the desk with a way back, nothing sideways", async ({ page }) => {
  await open(page, PAGE, 390);
  const card = page.getByTestId(`desk-card-${deskId}`);
  await expect(card).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  await card.click();
  await expect(page.getByTestId("desk-name")).toHaveText("mr_desk");
  await expect(card).toBeHidden();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  await page.getByTestId("desk-back").click();
  await expect(card).toBeVisible();
});

test("the desk signs in at /reception-login, and Sign out lands back there, signed out", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/reception-login");
  await page.locator("#reception-sign-in-username").fill("mr_desk1");
  await page.locator("#reception-sign-in-password").fill(PASSWORD);
  await page.getByTestId("reception-signin-submit").click();
  await expect(page).toHaveURL(/\/reception\/console$/);
  await expect(page.getByText(/Visitors - Today/).first()).toBeVisible({ timeout: 15_000 });
  const deskToken = await page.evaluate(() => localStorage.getItem("reception_device_token"));
  expect(deskToken).toBeTruthy();
  // HR sees the browser signed in to the desk
  const detail = await api(request, "GET", `/api/reception-devices/${deskId}`);
  expect(detail.body.sessions.length).toBeGreaterThan(0);

  await page.getByTestId("reception-sign-out").click();
  await page.getByTestId("reception-sign-out-confirm").click();
  await expect(page).toHaveURL(/\/reception-login/);
  await expect(page.getByRole("heading", { name: "Reception" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("reception_device_token"))).toBeNull();
  // the ended session's token is refused by the server
  const me = await request.get("/api/reception-devices/me", { headers: { Authorization: `Bearer ${deskToken}` } });
  expect(me.status()).toBe(401);
});
