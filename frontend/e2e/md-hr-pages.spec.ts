import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// The Managing Director's copies of the HR pages (Dashboard, Employees, Branches, the Attendance pages, Geo Attendance,
// Outpass / Visitors / Tea Break, Manage Shift, Leave & Holiday, Requests): the same page components, inside the MD shell,
// at /md/... . This spec is about the copy holding together: it opens in the MD portal (not the HR one), none of the API
// calls it makes is refused (a 403 here means the MD's access in permission_registry.MD_HR_GRANTS is missing a module the
// page reads) and the browser logs no error. What each page DOES is the HR pages' own tests' job; the MD's Insights are
// tested in md-insights.spec.ts.
//
// The server throttles sign-ins (10 a minute), so the MD signs in ONCE.

const MD_PASSWORD = "Passw0rd!mdhr";

const PAGES: { path: string; id: string; frame: boolean }[] = [
  // the MD's own dashboard (pages/md/home), not a copy of the HR page: no Operations / Insights frame
  { path: "/md/dashboard", id: "dashboard", frame: false },
  { path: "/md/employees", id: "employees", frame: true },
  { path: "/md/branches", id: "branches", frame: true },
  { path: "/md/attendance/staff", id: "attendance", frame: true },
  { path: "/md/attendance/production", id: "attendance-production", frame: true },
  { path: "/md/geo-attendance", id: "geo-attendance", frame: true },
  { path: "/md/attendance/search", id: "attendance-search", frame: true },
  { path: "/md/attendance/report-log", id: "report-log", frame: true },
  { path: "/md/outpass-visitors/outpass", id: "outpass", frame: true },
  { path: "/md/outpass-visitors/visitors", id: "visitors", frame: true },
  { path: "/md/outpass-visitors/tea-break", id: "tea-break", frame: true },
  { path: "/md/shifts", id: "shifts", frame: true },
  { path: "/md/leave", id: "leave", frame: true },
  { path: "/md/requests", id: "requests", frame: true },
];

let adminToken = "";
let mdToken = "";

async function signIn(request: APIRequestContext, username: string, password: string) {
  const res = await request.post("/api/auth/hr-login", { data: { username, password } });
  expect(res.status(), `sign in as ${username}`).toBe(200);
  return (await res.json()).token as string;
}

async function api(request: APIRequestContext, token: string, method: string, url: string, data?: unknown) {
  const res = await request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function cleanUp(request: APIRequestContext) {
  const list = (await api(request, adminToken, "GET", "/api/hr-users")).body as { id: number; username: string }[];
  for (const u of list.filter((u) => u.username.startsWith("mdhr_"))) {
    await api(request, adminToken, "DELETE", `/api/hr-users/${u.id}`);
  }
}

async function goto(page: Page, path: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(path);
      return;
    } catch (error) {
      if (attempt >= 3 || !String(error).includes("ERR_ABORTED")) throw error;
    }
  }
}

/** What went wrong while the page loaded: API calls the server refused or failed, script errors, console errors. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on("response", (res) => {
    const url = res.url();
    if (!url.includes("/api/")) return;
    if (res.status() === 401 || res.status() === 403 || res.status() >= 500) {
      problems.push(`${res.status()} ${res.request().method()} ${url.replace(/^https?:\/\/[^/]+/, "")}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`script error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
      problems.push(`console: ${message.text().slice(0, 200)}`);
    }
  });
  return problems;
}

async function open(page: Page, path: string) {
  await goto(page, path);
  await expect(page.getByTestId("md-shell")).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(500);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  adminToken = await signIn(request, HR_USERNAME, HR_PASSWORD);
  await cleanUp(request);
  const made = await api(request, adminToken, "POST", "/api/hr-users", {
    username: "mdhr_tester",
    password: MD_PASSWORD,
    fullName: "MD Copy Tester",
    isMd: true,
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  mdToken = await signIn(request, "mdhr_tester", MD_PASSWORD);
});

test.afterAll(async ({ request }) => {
  await cleanUp(request);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), mdToken);
});

for (const { path, id, frame } of PAGES) {
  test(`${path} opens in the MD portal and none of its API calls is refused`, async ({ page }) => {
    const problems = watch(page);
    await open(page, path);
    await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, "\\/")}$`));
    // the MD shell, not the HR one
    await expect(page.getByTestId("md-identity").first()).toBeVisible();
    if (frame) {
      await expect(page.getByTestId("md-frame")).toHaveAttribute("data-page", id);
      await expect(page.getByTestId("md-tab-operations")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId("md-tab-insights")).toBeVisible();
    }
    expect(problems, `trouble on ${path}`).toEqual([]);
  });
}

test("every MD page opens with the same title row: Live beside the title, the switch in the row, Updated / Refresh in the corner", async ({
  page,
}) => {
  test.setTimeout(240_000);
  // (the dashboard is left out on purpose: it has no title strip, its welcome card is the top of the page)
  const paths = [
    ...PAGES.map((p) => p.path).filter((p) => p !== "/md/dashboard"),
    "/md/payroll",
    "/md/reports",
    "/md/recruitment",
    "/md/activity",
  ];
  const rowLeft: number[] = [];
  const stackRight: number[] = [];

  for (const path of paths) {
    await open(page, path);
    const row = page.locator('[data-md-header-row], [data-testid="md-page-header"]').first();
    await expect(row, path).toBeVisible();
    const box = async (loc: ReturnType<Page["locator"]>, what: string) => {
      const b = await loc.first().boundingBox();
      expect(b, `${path}: ${what}`).not.toBeNull();
      return b!;
    };
    const rowBox = await box(row, "the title row");
    const title = await box(page.locator('[data-md-title], [data-testid="md-page-title"]'), "the title");
    const live = await box(page.getByTestId("md-live"), "the Live chip");
    const stack = await box(page.getByTestId("md-refresh-stack"), "the Updated / Refresh stack");
    await expect(page.getByTestId("md-refresh"), path).toBeVisible();
    // only one Refresh button in the title row: the page's own is replaced by the stack
    await expect(
      page.locator('[data-testid="md-refresh"], [data-testid="button-page-refresh"]:visible'),
      path,
    ).toHaveCount(1);

    // Live sits right after the title words, on the title's line
    expect(live.x, `${path}: Live after the title`).toBeGreaterThan(title.x);
    expect(
      Math.abs(live.y + live.height / 2 - (title.y + title.height / 2)),
      `${path}: Live on the title line`,
    ).toBeLessThan(14);
    // the stack is in the top-right corner of the row
    expect(Math.abs(stack.y - rowBox.y), `${path}: the stack at the top of the row`).toBeLessThan(14);
    // the switch is inside the title row and does not sit on the title (a crowded row wraps it onto a line of its own)
    if (await page.getByTestId("md-tab-operations").count()) {
      const tabs = await box(page.getByTestId("md-tabs"), "the switch");
      const clear = tabs.x >= title.x + title.width || tabs.y >= title.y + title.height - 2;
      expect(clear, `${path}: the switch clear of the title`).toBe(true);
      expect(tabs.y, `${path}: the switch inside the row`).toBeGreaterThanOrEqual(rowBox.y - 4);
      expect(tabs.y + tabs.height, `${path}: the switch inside the row`).toBeLessThanOrEqual(
        rowBox.y + rowBox.height + 4,
      );
    }
    rowLeft.push(rowBox.x);
    stackRight.push(Math.round(stack.x + stack.width));
  }

  // the same left edge and the same right edge on every page
  expect(Math.max(...rowLeft) - Math.min(...rowLeft), `left edges: ${rowLeft}`).toBeLessThan(3);
  expect(Math.max(...stackRight) - Math.min(...stackRight), `right edges: ${stackRight}`).toBeLessThan(3);
});

test("the seven pages with a tall title row line up alike: same title edge, switch and stack in the same place, buttons on the stack's right edge", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const paths = [
    "/md/employees",
    "/md/attendance/staff",
    "/md/attendance/production",
    "/md/outpass-visitors/outpass",
    "/md/outpass-visitors/visitors",
    "/md/shifts",
    "/md/requests",
  ];
  const seen: Record<string, number[]> = { titleX: [], titleMid: [], tabsX: [], tabsMid: [], stackX: [], stackMid: [] };

  for (const path of paths) {
    await open(page, path);
    const row = page.locator("[data-md-header-row][data-md-grid][data-md-aligned]");
    await expect(row, `${path}: laid out as the grid`).toHaveCount(1);
    const box = async (loc: ReturnType<Page["locator"]>, what: string) => {
      const b = await loc.first().boundingBox();
      expect(b, `${path}: ${what}`).not.toBeNull();
      return b!;
    };
    const rowBox = await box(row, "the title row");
    const title = await box(page.locator("[data-md-title]"), "the title");
    const tabs = await box(page.getByTestId("md-tabs"), "the switch");
    const stack = await box(page.getByTestId("md-refresh-stack"), "the Updated / Refresh stack");
    seen.titleX.push(Math.round(title.x));
    seen.titleMid.push(Math.round(title.y + title.height / 2 - rowBox.y));
    seen.tabsX.push(Math.round(tabs.x));
    seen.tabsMid.push(Math.round(tabs.y + tabs.height / 2 - rowBox.y));
    seen.stackX.push(Math.round(stack.x));
    seen.stackMid.push(Math.round(stack.y + stack.height / 2 - rowBox.y));

    // the page's own buttons end on the stack's right edge, under it, and never on the title line
    const actions = page.locator("[data-md-header-row] > [data-md-actions]:visible");
    for (let i = 0; i < (await actions.count()); i++) {
      const a = await box(actions.nth(i), "the page's buttons");
      expect(Math.abs(a.x + a.width - (stack.x + stack.width)), `${path}: buttons on the right edge`).toBeLessThan(3);
      expect(a.y, `${path}: buttons under the title row`).toBeGreaterThanOrEqual(title.y + title.height);
    }
    // the page's own icon is not drawn before the title: it starts where every other title starts
    await expect(page.locator("[data-md-title] > svg:first-child"), path).toBeHidden();
  }

  for (const [what, values] of Object.entries(seen)) {
    expect(Math.max(...values) - Math.min(...values), `${what}: ${values}`).toBeLessThan(3);
  }
});

test("the old analytics addresses go to the pages that now hold them", async ({ page }) => {
  await goto(page, "/md/visitors");
  await expect(page).toHaveURL(/\/md\/outpass-visitors\/visitors$/);
  await goto(page, "/md/tea-break");
  await expect(page).toHaveURL(/\/md\/outpass-visitors\/tea-break$/);
  await goto(page, "/md/attendance");
  await expect(page).toHaveURL(/\/md\/attendance\/staff$/);
});

test("the MD sidebar lists the fourteen pages and offers no way into the HR portal to an MD with no HR role", async ({
  page,
}) => {
  await open(page, "/md/dashboard");
  for (const id of PAGES.map((p) => p.id)) await expect(page.getByTestId(`md-nav-${id}`), id).toHaveCount(1);
  for (const id of ["payroll", "reports", "recruitment", "activity"])
    await expect(page.getByTestId(`md-nav-${id}`)).toHaveCount(1);
  await expect(page.getByTestId("md-to-hr")).toHaveCount(0);
});

test("a button on a copied page stays inside the MD portal, and Back returns to the page", async ({ page }) => {
  await open(page, "/md/employees");
  await page.getByRole("button", { name: /Add Employee/ }).click();
  await expect(page).toHaveURL(/\/md\/employees\/new$/);
  await expect(page.getByTestId("md-shell")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/md\/employees$/);
  await expect(page.getByTestId("md-frame")).toHaveAttribute("data-page", "employees");
});

test("what was typed on the page is still there after a look at the Insights tab", async ({ page }) => {
  await open(page, "/md/employees");
  const search = page.getByPlaceholder(/Search by name/);
  await search.fill("Asha");
  await page.getByTestId("md-tab-insights").click();
  await expect(page.getByTestId("md-frame-insights")).toBeVisible();
  await expect(page.getByTestId("md-frame-operations")).toBeHidden();
  await page.getByTestId("md-tab-operations").click();
  await expect(search).toHaveValue("Asha");
});

test("the MD only views requests: no Approve or Reject on Leave, Requests or the dashboard, and the server refuses a decision", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const employees = (await api(request, adminToken, "GET", "/api/employees")).body as {
    id: number;
    employeeCode: string;
  }[];
  const asha = employees.find((e) => e.employeeCode === "E2E001")!.id;
  const leave = await api(request, adminToken, "POST", "/api/leave-requests", {
    employeeId: asha,
    startDate: "2026-10-26",
    endDate: "2026-10-26",
    type: "casual",
    reason: "md view-only e2e",
  });
  expect(leave.status, JSON.stringify(leave.body)).toBe(201);
  const permission = await api(request, adminToken, "POST", "/api/permissions", {
    employeeId: asha,
    date: "2026-10-26",
    type: "Late In",
    permissionTime: "09:30",
    reason: "md view-only e2e",
  });
  expect(permission.status, JSON.stringify(permission.body)).toBe(201);
  const leaveId = leave.body.id as number;
  const permissionId = permission.body.id as number;

  const decisionButtons = (scope: ReturnType<Page["locator"]>) =>
    scope.getByRole("button", { name: /^(Approve|Reject|Confirm reject)$/ });

  try {
    // Leave & Holiday: the request is there to look at, with nothing to decide it and no bin to delete it
    await open(page, "/md/leave");
    const leaveCard = page.getByTestId(`leave-${leaveId}`);
    await expect(leaveCard).toBeVisible();
    await expect(decisionButtons(leaveCard)).toHaveCount(0);
    await expect(leaveCard.locator("button:visible")).toHaveCount(0);
    await expect(page.getByTestId("md-view-only")).toContainText("HR and the Department Heads decide requests");
    await expect(decisionButtons(page.locator("main"))).toHaveCount(0);

    // Requests: leave and permission, same
    await open(page, "/md/requests");
    for (const id of [`request-leave-${leaveId}`, `request-permission-${permissionId}`]) {
      await expect(page.getByTestId(id), id).toBeVisible();
    }
    await expect(decisionButtons(page.locator("main"))).toHaveCount(0);
    await expect(page.getByTestId("md-view-only")).toBeVisible();

    // the dashboard lists them as waiting, with who they wait for, and no way to decide
    await open(page, "/md/dashboard");
    await expect(page.getByTestId(`md-request-leave-${leaveId}`)).toBeVisible();
    await expect(page.getByTestId(`md-request-permission-${permissionId}`)).toBeVisible();
    await expect(page.getByTestId(`md-request-leave-${leaveId}-waiting-for`)).toContainText("Waiting for");
    await expect(decisionButtons(page.getByTestId("md-home-requests"))).toHaveCount(0);

    // and the server says no to every way of deciding, editing or deleting them
    const refused = async (method: string, url: string, data?: unknown) => {
      const r = await api(request, mdToken, method, url, data);
      expect(r.status, `${method} ${url}`).toBe(403);
      expect(JSON.stringify(r.body)).toContain("can view this section but cannot change it");
    };
    await refused("PATCH", `/api/leave-requests/${leaveId}/status`, { status: "approved" });
    await refused("PUT", `/api/permissions/${permissionId}`, { status: "approved" });
    await refused("PATCH", "/api/outpass-requests/999999/hr-status", { status: "approved" });
    await refused("DELETE", `/api/leave-requests/${leaveId}`);
    await refused("DELETE", `/api/permissions/${permissionId}`);
    const still = (await api(request, adminToken, "GET", `/api/leave-requests?employeeId=${asha}`)).body as {
      id: number;
      status: string;
    }[];
    expect(still.find((l) => l.id === leaveId)?.status).toBe("pending");
  } finally {
    await api(request, adminToken, "DELETE", `/api/leave-requests/${leaveId}`);
    await api(request, adminToken, "DELETE", `/api/permissions/${permissionId}`);
  }
});

test("the MD can make a change on a copied page's data, and nobody else can open the copies", async ({
  page,
  request,
}) => {
  const made = await api(request, mdToken, "POST", "/api/branches", { name: "mdhr_unit" });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const gone = await api(request, mdToken, "DELETE", `/api/branches/${made.body.id}`);
  expect(gone.status).toBeLessThan(300);
  // the Super Admin is not the MD: the MD's pages answer to the MD alone
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), adminToken);
  await goto(page, "/md/employees");
  await expect(page).toHaveURL(/\/hr\/dashboard$/);
});

test("the MD skin stays inside the MD portal: wine for the MD, nothing of it in the HR portal", async ({ page }) => {
  const skin = () =>
    page.evaluate(() => {
      const root = document.documentElement;
      const button = document.querySelector('[data-slot="button"][data-variant="default"]');
      return {
        on: root.hasAttribute("data-md-theme"),
        primary: getComputedStyle(root).getPropertyValue("--primary").trim(),
        buttonBackground: button ? getComputedStyle(button).backgroundImage : "",
      };
    });

  // the MD portal: the skin is on, the primary colour is wine, a primary button is wine glass
  await open(page, "/md/branches");
  const md = await skin();
  expect(md.on).toBe(true);
  expect(md.primary).toBe("346 98% 25%");
  expect(md.buttonBackground).toContain("rgba(127, 1, 31");

  // the HR portal, signed in as the Super Admin: no attribute, the original blue, the original gradient
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), adminToken);
  await goto(page, "/hr/branches");
  await expect(page.getByRole("heading", { name: /Manage Branch/ })).toBeVisible({ timeout: 30_000 });
  const hr = await skin();
  expect(hr.on).toBe(false);
  expect(hr.primary).toBe("201 100% 29%");
  expect(hr.buttonBackground).toContain("rgb(0, 100, 150)");
});
