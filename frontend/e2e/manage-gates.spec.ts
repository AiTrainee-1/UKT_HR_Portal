import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// Gate Pass -> Manage Gates (/hr/outpass-visitors/outpass/gates) in a real browser: a gate made through the API is listed,
// opening it shows its login, View shows the password it was given (the server keeps an encrypted copy), the records list
// and the tiles are there, and on a phone the list comes first, then the gate with a way back, with nothing sticking out
// sideways. The gate is named "mg_..." and removed again.

const PAGE = "/hr/outpass-visitors/outpass/gates";
const PASSWORD = "mg-e2e-Pass1";

let token = "";
let gateId: number | null = null;

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
  for (const g of ((await api(request, "GET", "/api/gate-devices")).body ?? []) as { id: number; name: string }[]) {
    if (g.name.startsWith("mg_")) await api(request, "DELETE", `/api/gate-devices/${g.id}`);
  }
  const branches = (await api(request, "GET", "/api/branches")).body as { id: number }[];
  const made = await api(request, "POST", "/api/gate-devices", {
    name: "mg_gate",
    branchId: branches[0].id,
    username: "mg_gate1",
    password: PASSWORD,
    location: "E2E side",
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  gateId = made.body.id;
});

test.afterAll(async ({ request }) => {
  if (gateId !== null) await api(request, "DELETE", `/api/gate-devices/${gateId}`);
});

test("a gate's page: its login, View password, its records and the tiles", async ({ page }) => {
  await open(page, `${PAGE}?gate=${gateId}`, 1366);
  await expect(page.locator("main h1, main h2").first()).toContainText("Gate Pass");
  await expect(page.getByTestId("gate-name")).toHaveText("mg_gate");
  await expect(page.getByTestId("gate-username")).toHaveText("mg_gate1");
  await expect(page.getByTestId(`gate-card-${gateId}`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("gate-monitor-address")).toContainText("/gatemonitor");
  await expect(page.getByTestId("gate-tile-gates-value")).not.toHaveText("—");
  await expect(page.getByTestId("gate-password")).not.toContainText(PASSWORD);
  await page.getByTestId("gate-password-view").click();
  await expect(page.getByTestId("gate-password")).toHaveText(PASSWORD);
  await expect(page.getByTestId("gate-records-table")).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
});

test("on a phone: the list first, then the gate with a way back, nothing sideways", async ({ page }) => {
  await open(page, PAGE, 390);
  const card = page.getByTestId(`gate-card-${gateId}`);
  await expect(card).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  await card.click();
  await expect(page.getByTestId("gate-name")).toHaveText("mg_gate");
  await expect(card).toBeHidden();
  expect(await overflow(page)).toBeLessThanOrEqual(1);
  await page.getByTestId("gate-back").click();
  await expect(card).toBeVisible();
});
