import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// Clean Professional, area "controls + sign-in + status screens + the rest": the control pages (WhatsApp, SMS, Gmail, user
// and account management, biometric device pages, logs, devices, mobile app login, messages, chat), the sign-in and public
// pages, the "something is not right" screens, the ERP shell and the employee portal.
//
//   * Under the clean theme every page is flat: no horizontal overflow at 1366 and 390 px, no backdrop blur, no soft shadow
//     (only dialogs, menus, popovers and toasts may have one), no gradient anywhere;
//   * representative elements of each area have the clean look (computed styles);
//   * the same pages under the DEFAULT theme keep the glass-and-clay values they had before the theme existed (read from the
//     application without the theme), so a regression in the default theme is caught here too;
//   * the sign-in pages wear the theme before anyone has signed in (the device-only choice).

const DEVICE_KEY = "uk_textile_theme_device";
const EMPLOYEE_PASSWORD = "Passw0rd!ctrl1";
const PAGE_COLOUR = "rgb(234, 238, 243)";
const BRAND = "rgb(29, 86, 179)";
const INK = "rgb(31, 41, 55)";

let adminToken = "";
let employeeToken = "";
let deviceId: number | null = null;
let gateId: number | null = null;
let deskId: number | null = null;
// the public links and sign-ins of the gate, the reception desk and the QR forms, made in beforeAll
let gate = { loginToken: "", session: { token: "", gateId: 0, gateName: "" } };
let desk = { loginToken: "", session: { token: "", deviceId: 0, deskName: "" } };
let outpassQr = "";
let visitorQr = "";

async function api(request: APIRequestContext, token: string, method: string, url: string, data?: unknown) {
  const res = await request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

/** Load a page with the theme (and, when given, the sign-in) already in place: the same as a person who chose it earlier. */
async function open(
  page: Page,
  route: string,
  theme: "clean" | "default",
  token?: string,
  extra: Record<string, string> = {},
) {
  await page.addInitScript(
    ([key, value, tok, more]) => {
      if (value === "default") localStorage.removeItem(key as string);
      else localStorage.setItem(key as string, value as string);
      if (tok) localStorage.setItem("uk_textile_token", tok as string);
      for (const [k, v] of Object.entries(more as Record<string, string>)) localStorage.setItem(k, v);
    },
    [DEVICE_KEY, theme, token ?? "", extra] as const,
  );
  await page.goto(route);
}

const style = (page: Page, selector: string, props: string[]) =>
  page
    .locator(selector)
    .first()
    .evaluate((el, ps) => Object.fromEntries(ps.map((p) => [p, getComputedStyle(el).getPropertyValue(p)])), props);

// What a flat page may not have. Run in the page: nothing here reads the application, only what the browser computed.
const audit = () => {
  const floating =
    '[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="popover-panel"], [data-slot="dropdown-content"], [data-slot="select-content"], [data-slot="toast"], [data-slot="tooltip-panel"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-sonner-toast]';
  const describe = (el: Element) => {
    const cls = typeof el.className === "string" ? el.className : "";
    return `${el.tagName.toLowerCase()}.${cls.trim().split(/\s+/).slice(0, 4).join(".")}`;
  };
  const blur: string[] = [];
  const shadow: string[] = [];
  const gradient: string[] = [];
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.backdropFilter && cs.backdropFilter !== "none") blur.push(describe(el));
    if (cs.backgroundImage && cs.backgroundImage.includes("gradient")) gradient.push(describe(el));
    if (cs.boxShadow && cs.boxShadow !== "none" && !el.closest(floating)) {
      for (const layer of cs.boxShadow.split(/,(?![^(]*\))/)) {
        if (/rgba\([^)]*,\s*0\)/.test(layer) || /\/ 0\)/.test(layer)) continue; // a transparent layer draws nothing
        const m = layer.match(/(-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px/);
        if (m && parseFloat(m[3]) > 0) shadow.push(`${describe(el)} ${layer.trim()}`);
      }
    }
  }
  return {
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    blur,
    shadow,
    gradient,
  };
};

/**
 * Run a step that loads a page; try it again (up to three times) if the page was reloaded under it or showed the "just
 * updated" screen. The dev server reloads a page, or loses a lazy chunk, whenever a source file changes while it is open.
 */
async function withReload<T>(page: Page, step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      const stale = await page
        .getByText("UKTextiles was just updated")
        .isVisible()
        .catch(() => false);
      if (attempt >= 3 || !(stale || /Execution context was destroyed|navigation/i.test(String(error)))) throw error;
    }
  }
}

type PageSpec = {
  name: string;
  /** A function where the address is only known once beforeAll has made the link (a QR token, a gate's login token). */
  route: string | (() => string);
  /** What the page keeps in this browser (the gate and the reception desk stay signed in on their own device). */
  storage?: () => Record<string, string>;
  ready: (page: Page) => Promise<void>;
  auth?: "hr" | "employee" | "none";
};
const heading = (name: string | RegExp) => (page: Page) =>
  expect(page.getByRole("heading", { name }).first()).toBeVisible({ timeout: 15_000 });
const testId = (id: string) => (page: Page) => expect(page.getByTestId(id).first()).toBeVisible({ timeout: 15_000 });

const PAGES: PageSpec[] = [
  { name: "WhatsApp Control", route: "/hr/whatsapp-control", ready: heading("WhatsApp Control") },
  { name: "SMS Control", route: "/hr/sms-control/overview", ready: heading("SMS Control") },
  { name: "Gmail Control", route: "/hr/gmail-control", ready: heading("Gmail Control") },
  { name: "User Management", route: "/hr/user-management", ready: heading("User Management") },
  { name: "Account Management", route: "/hr/account-management", ready: heading("Account Management") },
  { name: "Device Status", route: "/hr/Biometric-Connectors/device-status", ready: heading("Biometric Device Status") },
  {
    name: "Device Control",
    route: "/hr/Biometric-Connectors/DeviceControl/push",
    ready: testId("device-control-page"),
  },
  { name: "Activity Logs", route: "/hr/activity-logs", ready: heading("Activity Logs") },
  { name: "Login Devices", route: "/hr/login-devices", ready: heading("Login Devices") },
  { name: "Mobile App Login", route: "/hr/mobile-app-login", ready: heading("Mobile App Login") },
  { name: "Employee Messages", route: "/hr/notifications", ready: heading("Employee Messages") },
  { name: "Company Chat", route: "/hr/chat", ready: heading("Company Chat") },
  { name: "ERP dashboard", route: "/erp/dashboard", ready: heading("ERP Dashboard"), auth: "none" },
  {
    name: "Employee dashboard",
    route: "/employee/dashboard",
    ready: heading(/Good (day|morning|afternoon|evening)/),
    auth: "employee",
  },
  { name: "HR sign-in", route: "/hr-login", ready: testId("input-username"), auth: "none" },
  { name: "Employee sign-in", route: "/employee-login", ready: testId("input-identifier"), auth: "none" },
  { name: "Set password", route: "/set-password", ready: testId("input-confirm"), auth: "none" },
  { name: "ERP sign-in", route: "/erp-login", ready: heading("ERP Portal"), auth: "none" },
  { name: "Job application", route: "/apply/job/1", ready: heading("Job Application"), auth: "none" },
  {
    name: "Identity check",
    route: "/verify/ABC123",
    ready: (p) => expect(p.getByText("Not Verified")).toBeVisible(),
    auth: "none",
  },
  { name: "Gate scanner link", route: "/gate-scanner/nothing", ready: heading("Gate Scanner"), auth: "none" },
  {
    name: "Gate scanner sign-in",
    route: () => `/gate-scanner/${gate.loginToken}`,
    ready: heading("Gate Scanner"),
    auth: "none",
  },
  {
    name: "Reception sign-in",
    route: () => `/reception-login/${desk.loginToken}`,
    ready: heading("Reception"),
    auth: "none",
  },
  {
    name: "Gate scanner console",
    route: "/gate-scanner/console",
    storage: () => ({
      gate_device_token: gate.session.token,
      gate_device_id: String(gate.session.gateId),
      gate_device_name: gate.session.gateName,
    }),
    ready: (p) => expect(p.getByText("Today's Gate-Out Report")).toBeVisible({ timeout: 15_000 }),
    auth: "none",
  },
  {
    name: "Reception console",
    route: "/reception/console",
    storage: () => ({
      reception_device_token: desk.session.token,
      reception_device_id: String(desk.session.deviceId),
      reception_device_name: desk.session.deskName,
    }),
    ready: (p) => expect(p.getByText(/Visitors -/).first()).toBeVisible({ timeout: 15_000 }),
    auth: "none",
  },
  {
    name: "Outpass form (QR link)",
    route: () => `/gate/outpass/${outpassQr}`,
    ready: heading("Outpass"),
    auth: "none",
  },
  {
    name: "Visitor pass (QR link)",
    route: () => `/gate/visitor/${visitorQr}`,
    ready: heading("Visitor Pass"),
    auth: "none",
  },
  { name: "404", route: "/no/such/page", ready: heading("This page wandered off"), auth: "none" },
  { name: "Server error", route: "/server-error", ready: heading("Something broke on our side"), auth: "none" },
  { name: "Database offline", route: "/db-offline", ready: heading("Database Server Offline"), auth: "none" },
];

// The dev server reloads (or loses a lazy chunk of) any page that is open while a source file changes, which is rare but real
// while several people work in the repository: a test that fails is run again, and only three failures in a row count.
test.describe.configure({ retries: 2 });

test.beforeAll(async ({ request }) => {
  const res = await request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  expect(res.status()).toBe(200);
  adminToken = (await res.json()).token;

  // one biometric device that nobody has heard from (a card on Device Status, a count of zero) and one employee who can
  // sign in (the employee pages)
  const device = await api(request, adminToken, "POST", "/api/biometric-devices", {
    name: "ctrl_theme_device",
    deviceType: "aiface_mars",
    host: "127.0.0.1",
    port: 1,
    connectionConfig: { password: 0 },
  });
  expect(device.status, JSON.stringify(device.body)).toBe(201);
  deviceId = device.body.id;

  // a gate kiosk and a reception desk (their sign-in links, and the consoles they show once signed in), and the two QR links
  // of the head office branch; nothing is left behind (afterAll)
  for (const list of ["gate-devices", "reception-devices"]) {
    const old = (await api(request, adminToken, "GET", `/api/${list}`)).body as { id: number; name: string }[];
    for (const d of old.filter((x) => x.name.startsWith("ctrl_"))) {
      await api(request, adminToken, "DELETE", `/api/${list}/${d.id}`);
    }
  }
  const branches = (await api(request, adminToken, "GET", "/api/branches")).body as { id: number }[];
  const branchId = branches[0].id;
  const gateMade = await api(request, adminToken, "POST", "/api/gate-devices", {
    name: "ctrl_gate",
    branchId,
    username: "ctrl_gate1",
    password: EMPLOYEE_PASSWORD,
  });
  expect(gateMade.status, JSON.stringify(gateMade.body)).toBe(201);
  gateId = gateMade.body.id;
  const gateLogin = await request.post("/api/gate-devices/login", {
    data: { username: "ctrl_gate1", password: EMPLOYEE_PASSWORD },
  });
  expect(gateLogin.status()).toBe(200);
  gate = { loginToken: gateMade.body.loginToken, session: await gateLogin.json() };
  const deskMade = await api(request, adminToken, "POST", "/api/reception-devices", {
    name: "ctrl_desk",
    branchId,
    username: "ctrl_desk1",
    password: EMPLOYEE_PASSWORD,
  });
  expect(deskMade.status, JSON.stringify(deskMade.body)).toBe(201);
  deskId = deskMade.body.id;
  const deskLogin = await request.post("/api/reception-devices/login", {
    data: { username: "ctrl_desk1", password: EMPLOYEE_PASSWORD },
  });
  expect(deskLogin.status()).toBe(200);
  desk = { loginToken: deskMade.body.loginToken, session: await deskLogin.json() };
  outpassQr = (await api(request, adminToken, "GET", `/api/outpass/qr?branchId=${branchId}`)).body.token;
  visitorQr = (await api(request, adminToken, "GET", `/api/visitor/qr?branchId=${branchId}`)).body.token;
  expect(outpassQr).toBeTruthy();
  expect(visitorQr).toBeTruthy();

  const employees = (await api(request, adminToken, "GET", "/api/employees")).body as {
    id: number;
    employeeCode: string;
  }[];
  const asha = employees.find((e) => e.employeeCode === "E2E001");
  expect(asha).toBeTruthy();
  const set = await api(request, adminToken, "POST", `/api/mobile-app-logins/${asha!.id}/reset-password`, {
    password: EMPLOYEE_PASSWORD,
  });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  const login = await request.post("/api/auth/employee-login", {
    data: { identifier: "E2E001", password: EMPLOYEE_PASSWORD },
  });
  expect(login.status()).toBe(200);
  employeeToken = (await login.json()).token;
});

test.afterAll(async ({ request }) => {
  if (deviceId !== null) await api(request, adminToken, "DELETE", `/api/biometric-devices/${deviceId}`);
  if (gateId !== null) await api(request, adminToken, "DELETE", `/api/gate-devices/${gateId}`);
  if (deskId !== null) await api(request, adminToken, "DELETE", `/api/reception-devices/${deskId}`);
  const employees = (await api(request, adminToken, "GET", "/api/employees")).body as {
    id: number;
    employeeCode: string;
  }[];
  const asha = employees.find((e) => e.employeeCode === "E2E001");
  // the password this spec gave the seeded employee goes again (the same call, "clear")
  if (asha) await api(request, adminToken, "POST", `/api/mobile-app-logins/${asha.id}/reset-password`, { clear: true });
});

for (const width of [1366, 390]) {
  test(`every page of the area is flat and fits the screen at ${width}px under the clean theme`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
    const problems: string[] = [];
    for (const spec of PAGES) {
      const token = spec.auth === "none" ? undefined : spec.auth === "employee" ? employeeToken : adminToken;
      // the dev server reloads a page when a source file changes under it: such a page is simply loaded again
      const found = await withReload(page, async () => {
        const route = typeof spec.route === "function" ? spec.route() : spec.route;
        await open(page, route, "clean", token, spec.storage?.());
        await spec.ready(page);
        await page.waitForTimeout(700); // fonts, a first answer from the server, animations settling
        expect(await page.evaluate(() => document.documentElement.dataset.theme), `${spec.name}: theme`).toBe("clean");
        return page.evaluate(audit);
      });
      if (found.overflow > 1) problems.push(`${spec.name}: sticks out ${found.overflow}px sideways`);
      for (const b of found.blur) problems.push(`${spec.name}: backdrop blur on ${b}`);
      for (const s of found.shadow) problems.push(`${spec.name}: shadow on ${s}`);
      for (const g of found.gradient) problems.push(`${spec.name}: gradient on ${g}`);
    }
    expect(problems).toEqual([]);
  });
}

test("the sign-in pages wear the theme before anyone has signed in", async ({ page }) => {
  await open(page, "/hr-login", "clean");
  await expect(page.getByTestId("input-username")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("clean");
  // the form half is the page colour with one white bordered card, the glass orb behind it is not drawn, the brand half is flat
  expect(
    await style(page, 'div[class*="flex-1"][class*="relative"][class*="overflow-hidden"]', [
      "background-color",
      "background-image",
    ]),
  ).toEqual({ "background-color": PAGE_COLOUR, "background-image": "none" });
  expect(await style(page, "div.max-w-sm", ["background-color", "border-top-width", "border-top-left-radius"])).toEqual(
    {
      "background-color": "rgb(255, 255, 255)",
      "border-top-width": "1px",
      "border-top-left-radius": "8px",
    },
  );
  expect(await style(page, ".orb-container", ["display"])).toEqual({ display: "none" });
  expect(await style(page, 'div[class*="lg:w-[46%]"]', ["background-color", "background-image"])).toEqual({
    "background-color": BRAND,
    "background-image": "none",
  });
  expect(
    await style(page, '[data-testid="button-submit"]', [
      "background-color",
      "background-image",
      "border-top-left-radius",
    ]),
  ).toEqual({
    "background-color": BRAND,
    "background-image": "none",
    "border-top-left-radius": "6px",
  });
  // a wrong password: a plain danger alert, not an inset clay box
  await page.getByTestId("input-username").fill("nobody");
  await page.getByTestId("input-password").fill("wrong-password");
  await page.getByTestId("button-submit").click();
  const alert = page.getByText("Invalid username or password");
  await expect(alert).toBeVisible();
  expect(
    await alert.evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      border: getComputedStyle(el).borderTopWidth,
    })),
  ).toEqual({
    bg: "rgb(252, 235, 233)",
    border: "1px",
  });
});

test("the employee sign-in is a light page: the Back link and the contact card can be read", async ({ page }) => {
  await open(page, "/employee-login", "clean");
  await expect(page.getByTestId("input-identifier")).toBeVisible();
  expect(await style(page, "div.min-h-screen", ["background-color"])).toEqual({ "background-color": PAGE_COLOUR });
  expect(await style(page, "button.flex.items-center.gap-2", ["color"])).toEqual({ color: "rgb(70, 81, 97)" });
  await expect(page.getByTestId("support-contact-card")).toBeVisible();
  expect(await style(page, '[data-testid="support-contact-card"] p', ["color"])).toEqual({ color: INK });
  expect(await style(page, "div.bg-card.rounded-2xl", ["border-top-left-radius", "border-top-width"])).toEqual({
    "border-top-left-radius": "8px",
    "border-top-width": "1px",
  });
});

test("the status screens are a flat light card with the seriousness in one colour", async ({ page }) => {
  await open(page, "/db-offline", "clean");
  await expect(page.getByRole("heading", { name: "Database Server Offline" })).toBeVisible();
  expect(await style(page, ".ss-root", ["background-color", "color"])).toEqual({
    "background-color": PAGE_COLOUR,
    color: INK,
  });
  expect(await style(page, ".ss-bg", ["display"])).toEqual({ display: "none" });
  expect(
    await style(page, ".ss-card", [
      "background-image",
      "backdrop-filter",
      "border-top-left-radius",
      "border-top-width",
      "box-shadow",
    ]),
  ).toEqual({
    "background-image": "none",
    "backdrop-filter": "none",
    "border-top-left-radius": "8px",
    "border-top-width": "1px",
    "box-shadow": "none",
  });
  expect(
    await style(page, ".ss-btn", ["background-color", "background-image", "border-top-left-radius", "box-shadow"]),
  ).toEqual({
    "background-color": BRAND,
    "background-image": "none",
    "border-top-left-radius": "6px",
    "box-shadow": "none",
  });
  expect(await style(page, ".ss-title", ["color", "font-weight"])).toEqual({ color: INK, "font-weight": "700" });
  // the broken link of the path is a dashed line, not a striped gradient
  expect(
    await style(page, '.ss-link[data-state="bad"]', ["background-image", "border-top-style", "border-top-width"]),
  ).toEqual({
    "background-image": "none",
    "border-top-style": "dashed",
    "border-top-width": "2px",
  });

  // a server error is amber, a missing page is the brand blue (the tone is the one place colour carries meaning)
  await open(page, "/server-error", "clean");
  await expect(page.getByRole("heading", { name: "Something broke on our side" })).toBeVisible();
  expect(await style(page, ".ss-code", ["color", "background-image"])).toEqual({
    color: "rgb(151, 88, 0)",
    "background-image": "none",
  });
  await open(page, "/no/such/page", "clean");
  await expect(page.getByRole("heading", { name: "This page wandered off" })).toBeVisible();
  expect(await style(page, ".ss-code", ["color"])).toEqual({ color: BRAND });
});

test("the connection-lost takeover is the same flat card", async ({ page }) => {
  await open(page, "/hr/settings", "clean", adminToken);
  await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  await page.route("**/api/**", (route) => route.abort("connectionrefused"));
  await page.goto("/hr/settings").catch(() => undefined);
  const overlay = page.getByRole("alertdialog");
  await expect(overlay).toBeVisible({ timeout: 20_000 });
  expect(await style(page, '.ss-root[data-overlay="true"]', ["background-color"])).toEqual({
    "background-color": PAGE_COLOUR,
  });
  expect(await style(page, '.ss-root[data-overlay="true"] .ss-card', ["backdrop-filter", "background-image"])).toEqual({
    "backdrop-filter": "none",
    "background-image": "none",
  });
  // and its contact card (written for a dark screen) can be read
  expect(await style(page, '.ss-root[data-overlay="true"] [data-testid="support-contact-card"] p', ["color"])).toEqual({
    color: INK,
  });
  await page.unroute("**/api/**");
});

test("the boot loader's mark is the brand colour, not a washed-out light blue", async ({ page }) => {
  await page.addInitScript(
    ([key, tok]) => {
      localStorage.setItem(key as string, "clean");
      localStorage.setItem("uk_textile_token", tok as string);
    },
    [DEVICE_KEY, adminToken] as const,
  );
  // hold the answer that says who is signed in: the app stays on its boot screen
  await page.route("**/api/auth/me", () => undefined);
  await page.goto("/hr/dashboard");
  const mark = page.locator('[role="status"][aria-label="Loading"] > svg ellipse[fill="#4FB8F0"]').first();
  await expect(mark).toBeAttached({ timeout: 15_000 });
  expect(await mark.evaluate((el) => getComputedStyle(el).fill)).toBe(BRAND);
  expect(await style(page, "div.min-h-screen", ["background-image", "background-color"])).toEqual({
    "background-image": "none",
    "background-color": PAGE_COLOUR,
  });
  await page.unroute("**/api/auth/me");
});

test("the ERP shell has the same white menu as the HR portal", async ({ page }) => {
  await open(page, "/erp/dashboard", "clean");
  await expect(page.getByRole("heading", { name: "ERP Dashboard" })).toBeVisible();
  expect(await style(page, "aside", ["background-color", "background-image", "border-right-color"])).toEqual({
    "background-color": "rgb(255, 255, 255)",
    "background-image": "none",
    "border-right-color": "rgb(195, 204, 216)",
  });
  // the open page: the soft fill and the brand text
  expect(
    await style(page, "aside nav div[class*='bg-white/10']", ["background-color", "color", "background-image"]),
  ).toEqual({
    "background-color": "rgb(221, 232, 247)",
    color: "rgb(23, 63, 134)",
    "background-image": "none",
  });
  // the brand tile keeps its white icon
  expect(await style(page, "aside div[style*='rgb(6, 182, 212)'] svg", ["color"])).toEqual({
    color: "rgb(255, 255, 255)",
  });
});

test("Device Status: a count of zero is a grey that can be read", async ({ page }) => {
  await open(page, "/hr/Biometric-Connectors/device-status", "clean", adminToken);
  await expect(page.getByTestId("device-summary")).toBeVisible();
  const zero = page.locator('[data-testid="device-summary-connected"] p[class*="text-slate-300"]');
  await expect(zero).toHaveText("0");
  expect(await zero.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(90, 102, 118)");
});

test("the role editor: the chosen level shows, a disabled button is grey, a hand-built search box is one white field", async ({
  page,
}) => {
  await open(page, "/hr/account-management", "clean", adminToken);
  await page.getByRole("tab", { name: /Roles/ }).click();
  await page
    .getByRole("button", { name: /Create role/i })
    .first()
    .click();
  await expect(page.getByTestId("role-save")).toBeVisible();
  // an empty name: the save button is disabled, and looks it
  expect(await style(page, '[data-testid="role-save"]', ["background-color", "color", "opacity"])).toEqual({
    "background-color": "rgb(230, 235, 241)",
    color: "rgb(90, 102, 118)",
    opacity: "1",
  });
  await page.getByRole("button", { name: "Edit", exact: true }).first().click(); // "Set every module to Edit"
  const chosen = page.locator('[data-testid^="perm-"][data-testid$="-edit"][data-active="true"]').first();
  await expect(chosen).toBeVisible();
  await page.waitForTimeout(450); // the colour fades in
  expect(
    await chosen.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color })),
  ).toEqual({
    bg: BRAND,
    color: "rgb(255, 255, 255)",
  });
  await page.keyboard.press("Escape");

  // the HOD search box of User Management: a bordered white wrapper around a bare, transparent input
  await open(page, "/hr/user-management", "clean", adminToken);
  const wrapper = page.locator('div[class*="focus-within:ring"]').first();
  await expect(wrapper).toBeVisible();
  expect(
    await wrapper.evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      r: getComputedStyle(el).borderTopLeftRadius,
    })),
  ).toEqual({
    bg: "rgb(255, 255, 255)",
    r: "6px",
  });
  expect(await style(page, 'div[class*="focus-within:ring"] input', ["background-color"])).toEqual({
    "background-color": "rgba(0, 0, 0, 0)",
  });
});

test("Activity Logs: the filter chips are 6px chips and the chosen one is a soft brand chip", async ({ page }) => {
  await open(page, "/hr/activity-logs", "clean", adminToken);
  const all = page.getByRole("button", { name: /^All Actions/ });
  await expect(all).toBeVisible();
  await page.waitForTimeout(450); // the chips fade between colours
  expect(
    await all.evaluate((el) => ({
      color: getComputedStyle(el).color,
      line: getComputedStyle(el).borderTopColor,
      r: getComputedStyle(el).borderTopLeftRadius,
      solid: getComputedStyle(el).backgroundColor === "rgb(29, 86, 179)",
    })),
  ).toEqual({ color: "rgb(18, 55, 111)", line: BRAND, r: "6px", solid: false }); // dark brand ink (--clean-b-800)
  const login = page.getByRole("button", { name: /^Login\b/ }).first();
  expect(
    await login.evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      r: getComputedStyle(el).borderTopLeftRadius,
    })),
  ).toEqual({
    bg: "rgb(255, 255, 255)",
    r: "6px",
  });
});

test("the default theme keeps the glass-and-clay look on the same pages", async ({ page }) => {
  // sign-in
  await open(page, "/hr-login", "default");
  await expect(page.getByTestId("input-username")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("default");
  expect(
    await style(page, 'div[class*="flex-1"][class*="relative"][class*="overflow-hidden"]', ["background-image"]),
  ).toEqual({
    "background-image":
      "linear-gradient(135deg, rgb(246, 250, 254) 0%, rgb(238, 244, 250) 50%, rgb(240, 246, 252) 100%)",
  });
  expect(await style(page, ".orb-container", ["display"])).toEqual({ display: "block" });
  expect(await style(page, 'div[class*="lg:w-[46%]"]', ["background-image"])).toEqual({
    "background-image": "linear-gradient(160deg, rgb(0, 46, 70) 0%, rgb(0, 100, 150) 55%, rgb(0, 150, 199) 100%)",
  });
  expect(await style(page, '[data-testid="button-submit"]', ["background-image", "border-top-left-radius"])).toEqual({
    "background-image": "linear-gradient(135deg, rgb(0, 100, 150) 0%, rgb(0, 150, 199) 100%)",
    "border-top-left-radius": "12px",
  });
  expect(await style(page, "div.max-w-sm", ["border-top-width", "padding-top"])).toEqual({
    "border-top-width": "0px",
    "padding-top": "0px",
  });

  // the employee sign-in
  await open(page, "/employee-login", "default");
  await expect(page.getByTestId("input-identifier")).toBeVisible();
  expect(await style(page, "div.min-h-screen", ["background-color"])).toEqual({
    "background-color": "rgb(247, 250, 252)",
  });
  expect(await style(page, "div.bg-card.rounded-2xl", ["border-top-left-radius"])).toEqual({
    "border-top-left-radius": "16px",
  });

  // the status screens: midnight canvas, frosted card, gradient buttons
  await open(page, "/db-offline", "default");
  await expect(page.getByRole("heading", { name: "Database Server Offline" })).toBeVisible();
  expect(await style(page, ".ss-root", ["background-color", "color"])).toEqual({
    "background-color": "rgb(6, 10, 19)",
    color: "rgb(232, 238, 252)",
  });
  expect(await style(page, ".ss-bg", ["display"])).toEqual({ display: "block" });
  expect(await style(page, ".ss-card", ["backdrop-filter", "border-top-left-radius"])).toEqual({
    "backdrop-filter": "blur(26px) saturate(1.4)",
    "border-top-left-radius": "28px",
  });
  expect(await style(page, ".ss-btn", ["background-image", "border-top-left-radius"])).toEqual({
    "background-image": "linear-gradient(135deg, rgb(47, 128, 255), rgb(106, 92, 255))",
    "border-top-left-radius": "14px",
  });
  expect(await style(page, ".ss-title", ["color", "font-weight"])).toEqual({
    color: "rgb(255, 255, 255)",
    "font-weight": "900",
  });
  expect(await style(page, '.ss-link[data-state="bad"]', ["border-top-width"])).toEqual({ "border-top-width": "0px" });

  // the ERP shell keeps its navy menu
  await open(page, "/erp/dashboard", "default");
  await expect(page.getByRole("heading", { name: "ERP Dashboard" })).toBeVisible();
  expect(await style(page, "aside", ["background-image"])).toEqual({
    "background-image": "linear-gradient(rgb(13, 33, 55) 0%, rgb(15, 42, 30) 100%)",
  });

  // Device Status: the zero is slate-300, as it always was
  await open(page, "/hr/Biometric-Connectors/device-status", "default", adminToken);
  await expect(page.getByTestId("device-summary")).toBeVisible();
  const zero = page.locator('[data-testid="device-summary-connected"] p[class*="text-slate-300"]');
  await expect(zero).toHaveText("0");
  expect(await zero.evaluate((el) => getComputedStyle(el).color)).toBe("oklch(0.869 0.022 252.894)");

  // the role editor: a disabled save button is half transparent, the chosen level is blue-600, chips are pills
  await open(page, "/hr/account-management", "default", adminToken);
  await page.getByRole("tab", { name: /Roles/ }).click();
  await page
    .getByRole("button", { name: /Create role/i })
    .first()
    .click();
  await expect(page.getByTestId("role-save")).toBeVisible();
  expect(await style(page, '[data-testid="role-save"]', ["opacity"])).toEqual({ opacity: "0.5" });
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  const chosen = page.locator('[data-testid^="perm-"][data-testid$="-edit"][data-active="true"]').first();
  await page.waitForTimeout(450); // the colour fades in
  expect(await chosen.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("oklch(0.546 0.245 262.881)");
  await page.keyboard.press("Escape");
  await open(page, "/hr/activity-logs", "default", adminToken);
  const all = page.getByRole("button", { name: /^All Actions/ });
  await expect(all).toBeVisible();
  await page.waitForTimeout(450); // the chips fade between colours
  expect(
    await all.evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      big: parseFloat(getComputedStyle(el).borderTopLeftRadius) > 100,
    })),
  ).toEqual({
    bg: "oklch(0.279 0.041 260.031)",
    big: true,
  });
  await open(page, "/hr/user-management", "default", adminToken);
  const wrapper = page.locator('div[class*="focus-within:ring"]').first();
  await expect(wrapper).toBeVisible();
  expect(await wrapper.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("8px");
});
