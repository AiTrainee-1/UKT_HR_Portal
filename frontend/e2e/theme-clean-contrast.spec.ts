import { expect, test, type Page } from "@playwright/test";
import { auditPage, ready, type Result } from "./clean-audit";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// "Invisible text and icons" audit of the Clean Professional theme (src/themes/clean/). On the key pages of every area, in the
// states that used to go wrong (a hovered row, a ticked row, a unit band, the menu open and collapsed, an open dialog), it
// walks every visible piece of text and every icon, works out the colour it is drawn in and the colour it is drawn on (the
// ancestors' fills laid over one another, with their alpha), and fails when the text has less than 4.5:1 (3:1 for large text)
// or an icon less than 3:1. A background that is a gradient or a picture cannot be worked out and is skipped, as are disabled
// controls (they are exempt), charts (their colours are data) and the off-screen export sheets.
// Data: the e2e seed plus a few late arrivals made here (employees "CC-..") and removed again.

const DEVICE_KEY = "uk_textile_theme_device";
const DAY = "2026-08-03";
let token = "";
const made = {
  employees: [] as number[],
  shifts: [] as number[],
  branches: [] as number[],
  departments: [] as number[],
};

async function api(page: Page, method: string, url: string, data?: unknown) {
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function purge(page: Page) {
  const list = async (url: string) => ((await api(page, "GET", url)).body ?? []) as any[];
  for (const e of (await list("/api/employees")).filter((e) => String(e.employeeCode).startsWith("CC-"))) {
    await api(page, "DELETE", `/api/employees/${e.id}`);
  }
  for (const s of (await list("/api/shifts")).filter((s) => String(s.name).startsWith("CC "))) {
    await api(page, "DELETE", `/api/shifts/${s.id}`);
  }
  for (const d of (await list("/api/departments")).filter((d) => String(d.name).startsWith("CC "))) {
    await api(page, "DELETE", `/api/departments/${d.id}`);
  }
  for (const b of (await list("/api/branches")).filter((b) => String(b.name).startsWith("CC "))) {
    await api(page, "DELETE", `/api/branches/${b.id}`);
  }
}

test.describe.configure({ mode: "serial" });

let shared: Page;

test.beforeAll(async ({ browser }) => {
  shared = await browser.newPage({ viewport: { width: 1366, height: 800 } });
  await shared.addInitScript((key) => localStorage.setItem(key, "clean"), DEVICE_KEY);
  const login = await shared.request.post("/api/auth/hr-login", {
    data: { username: HR_USERNAME, password: HR_PASSWORD },
  });
  token = (await login.json()).token as string;
  await purge(shared);
  const make = async (url: string, data: object) => {
    const r = await api(shared, "POST", url, data);
    expect(r.status, `${url}: ${JSON.stringify(r.body)}`).toBe(201);
    return r.body.id as number;
  };
  const head = ((await api(shared, "GET", "/api/branches")).body as any[]).find((b) => b.isHeadOffice);
  const unitNo = 100 + Math.floor(Math.random() * 899);
  const unit = await make("/api/branches", { name: "CC Unit", code: `Unit${unitNo}` });
  const dept = await make("/api/departments", { name: "CC Admin", branchId: head.id });
  const deptUnit = await make("/api/departments", { name: "CC Floor", branchId: unit });
  const des = await make("/api/designations", { title: "CC Clerk", departmentId: dept });
  const desUnit = await make("/api/designations", { title: "CC Operator", departmentId: deptUnit });
  const shift = await make("/api/shifts", {
    name: "CC General",
    shiftType: "staff",
    startTime: "09:00",
    endTime: "18:00",
    gracePeriodMinutes: 15,
  });
  const employee = (code: string, first: string, branchId: number, departmentId: number, designationId: number) =>
    make("/api/employees", {
      employeeCode: code,
      firstName: first,
      lastName: "Latecomer",
      phone: "9000000077",
      gender: "male",
      employmentType: "staff",
      branchId,
      departmentId,
      designationId,
      salaryType: "monthly",
      salaryAmount: 24000,
    });
  const ids = [
    await employee("CC-01", "Tejus", head.id, dept, des),
    await employee("CC-02", "Pandi", head.id, dept, des),
    await employee("CC-03", "Babu", unit, deptUnit, desUnit),
  ];
  made.employees.push(...ids);
  const assign = await api(shared, "POST", "/api/shift-assignments/apply", {
    shiftId: shift,
    effectiveFrom: "2026-01-01",
    selection: { employees: { include: ids } },
  });
  expect(assign.status, JSON.stringify(assign.body)).toBe(201);
  for (const [id, time] of [
    [ids[0], "09:21"],
    [ids[1], "09:34"],
    [ids[2], "10:00"],
  ] as const) {
    for (const [t, type] of [
      [time, "IN"],
      ["18:00", "OUT"],
    ] as const) {
      const r = await api(shared, "POST", "/api/attendance/manual", {
        employeeId: id,
        date: DAY,
        punchTime: t,
        punchType: type,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  }
});

test.afterAll(async () => {
  await purge(shared);
  await shared.close();
});

const all: { page: string; result: Result }[] = [];
const report: string[] = [];

async function check(label: string) {
  // a dialog or a menu that is still fading in is half transparent: wait until every finite animation has finished
  await shared.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await shared.waitForTimeout(150);
  const result = await auditPage(shared);
  all.push({ page: label, result });
  const lines = result.offenders.map((o) => `  ${o.kind} ${o.ratio}:1  ${o.fg} on ${o.bg}  "${o.sample}"  ${o.where}`);
  if (lines.length) report.push(`${label}: ${result.checked} checked\n${lines.join("\n")}`);
}

async function open(path: string, width = 1366) {
  await shared.setViewportSize({ width, height: width === 1366 ? 800 : 844 });
  await shared.goto(path);
  await ready(shared);
}

const PAGES: [string, string][] = [
  ["dashboard", "/hr/dashboard"],
  ["employees", "/hr/employees"],
  ["new employee", "/hr/employees/new"],
  ["production employees", "/hr/employees/productionEmployee"],
  ["bulk upload", "/hr/employees/bulk-upload"],
  ["departments", "/hr/departments"],
  ["designations", "/hr/designations"],
  ["branches", "/hr/branches"],
  ["attendance", "/hr/attendance"],
  ["attendance production", "/hr/attendance/production"],
  ["attendance search", "/hr/attendance/search"],
  ["punch view", "/hr/attendance/punch-view"],
  ["report log monthly", "/hr/attendance/report-log"],
  ["leave & holiday", "/hr/leave"],
  ["casual leave", "/hr/casual-leave"],
  ["requests", "/hr/requests"],
  ["shifts", "/hr/shifts"],
  ["compensation", "/hr/compensation/ot-detection/type-1"],
  ["staff payroll", "/hr/payroll?month=2&year=2026"],
  ["production payroll", "/hr/production-payroll/weekly"],
  ["bonus", "/hr/bonus"],
  ["settlement", "/hr/settlement"],
  ["promotion", "/hr/promotion"],
  ["increment", "/hr/increment"],
  ["reports", "/hr/reports"],
  ["settings themes", "/hr/settings?tab=themes"],
  ["settings payroll", "/hr/settings?tab=payroll"],
  ["settings attendance", "/hr/settings?tab=attendance"],
  ["settings pf esi", "/hr/settings?tab=pf_esi"],
  ["recruitment", "/hr/recruitment/dashboard"],
  ["id cards", "/hr/id-cards"],
  ["whatsapp control", "/hr/whatsapp-control"],
  ["sms control", "/hr/sms-control/overview"],
  ["gmail control", "/hr/gmail-control"],
  ["account management", "/hr/account-management"],
  ["user management", "/hr/user-management"],
  ["activity logs", "/hr/activity-logs"],
  ["device status", "/hr/Biometric-Connectors/device-status"],
  ["notifications", "/hr/notifications"],
];

test("the HR sign-in page and the 404 page", async () => {
  await shared.context().clearCookies();
  await shared.evaluate(() => localStorage.removeItem("uk_textile_token")).catch(() => {});
  await shared.goto("/hr-login");
  await expect(shared.getByTestId("input-username")).toBeVisible();
  await shared.waitForTimeout(500);
  await check("hr sign-in");
  await shared.goto("/no-such-page-here");
  await shared.waitForTimeout(800);
  await check("404");
  await loginAsHr(shared);
});

for (const [label, path] of PAGES) {
  test(`page: ${label}`, async () => {
    await open(path);
    await check(label);
    // the pointer over the first row of a list
    const row = shared.locator("tbody tr").first();
    if (await row.count()) {
      await row.hover({ timeout: 3000 }).catch(() => {});
      await shared.waitForTimeout(600);
      await check(`${label} (a row hovered)`);
    }
  });
}

test("Daily Late Report: group by unit, a ticked row, a hovered row", async () => {
  await open("/hr/attendance/report-log?tab=late");
  await shared.getByTestId("daily-date").fill(DAY);
  await shared.waitForTimeout(1500);
  await check("late report");
  await shared.getByLabel("Group by unit").check();
  await shared.waitForTimeout(500);
  await expect(shared.locator('[data-testid^="late-group-"]').first()).toBeVisible();
  await check("late report, grouped by unit");
  await shared.locator('[data-testid^="late-select-"]').first().click();
  await shared.locator('[data-testid^="late-group-select-"]').first().click();
  await shared.locator('[data-testid^="late-row-"]').nth(1).hover();
  await check("late report, grouped, a unit and a row ticked, a row hovered");
  await open("/hr/attendance/report-log?tab=late", 390);
  await shared.getByTestId("daily-date").fill(DAY);
  await shared.waitForTimeout(1500);
  await check("late report at 390");
});

test("the menu open, collapsed and the phone's drawer", async () => {
  await open("/hr/dashboard");
  await check("menu open");
  await shared.evaluate(() => localStorage.setItem("hr_sidebar_collapsed", "1"));
  await shared.reload();
  await ready(shared);
  await check("menu collapsed");
  await shared.locator('[data-ui-shell="sidebar"] nav .cursor-pointer').first().hover();
  await check("menu collapsed, an item hovered");
  await shared.evaluate(() => localStorage.removeItem("hr_sidebar_collapsed"));
  await open("/hr/dashboard", 390);
  await check("phone");
  await shared.locator('[data-ui-shell="topbar"] button').first().click();
  await shared.waitForTimeout(500);
  await check("phone, the drawer open");
});

test("dialogs: add a department, add a shift, an employee picker's popover", async () => {
  await open("/hr/departments");
  await shared
    .getByRole("button", { name: /add department|new department/i })
    .first()
    .click();
  await expect(shared.getByRole("dialog")).toBeVisible();
  await check("add department dialog");
  await shared.keyboard.press("Escape");
  await open("/hr/shifts");
  const add = shared.getByRole("button", { name: /add shift|new shift|create shift/i }).first();
  if (await add.count()) {
    await add.click();
    await expect(shared.getByRole("dialog")).toBeVisible();
    await check("add shift dialog");
    await shared.keyboard.press("Escape");
  }
  await open("/hr/attendance/search");
  await check("attendance search");
});

test("the audit found no text or icon that cannot be read", () => {
  const checked = all.reduce((n, a) => n + a.result.checked, 0);
  console.log(
    `contrast audit: ${all.length} page states, ${checked} text and icon elements checked, ${report.length} page states with offenders`,
  );
  expect(report.join("\n\n")).toBe("");
});

test.afterAll(() => {
  const pages = all.length;
  const checked = all.reduce((n, a) => n + a.result.checked, 0);
  const offenders = all.reduce((n, a) => n + a.result.offenders.length, 0);
  console.log(
    `contrast audit: ${pages} page states, ${checked} text and icon elements checked, ${offenders} offenders`,
  );
});
