import { expect, test, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// Settings, Staff and Production told apart (2026-10-24): the Payroll tab is now "Staff Payroll" and Production Payroll is its own
// page (Overview, Weekly, BiWeekly, Monthly, Pay & Bonus); Attendance, Production Shifts and Late Detection each have a
// Staff | Production pill switch; the production late rules moved from Production Payroll to Late Detection -> Production; and
// Late Detection -> Staff prices permissions separately behind a switch. Whatever a case changes is put back through the API.
//
// What needs the newest server (the production bonus keys and the permission pricing keys) is tested when the server reports
// them and, when it does not, the page is checked to say so and keep them read-only.

const PATH = "/api/payroll-settings";

test.describe.configure({ mode: "serial" });

type Reply = { status: number; body: Record<string, any> | null };

async function adminToken(page: Page): Promise<string> {
  const res = await page.request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  return (await res.json()).token as string;
}

async function api(page: Page, method: string, url: string, data?: unknown, token?: string): Promise<Reply> {
  const bearer = token ?? (await adminToken(page));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${bearer}` }, data });
  const text = await res.text();
  let body: Reply["body"] = null;
  try {
    body = text ? (JSON.parse(text) as Reply["body"]) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status(), body };
}

const settingsOf = async (page: Page) => (await api(page, "GET", PATH)).body ?? {};

/** The pills of a tab ("Staff" / "Production", or a pay cycle). A pill's label is drawn twice, so the role is the handle. */
const pill = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });

async function openSettings(page: Page, address: string, waitFor?: string) {
  await page.goto(address);
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("settings-loading")).toHaveCount(0, { timeout: 30_000 });
  if (waitFor) await expect(page.locator(waitFor)).toBeVisible({ timeout: 30_000 });
}

/** The shipped state: Monday weeks, no dates, the shared production late rules on every cycle. */
async function resetCycles(page: Page) {
  const res = await api(page, "PUT", PATH, {
    prodCycles: {
      weekly: { weekStart: "monday", anchorDate: null, lateFreeAllowance: null, lateSlabs: null },
      biweekly: { weekStart: "monday", anchorDate: null, lateFreeAllowance: null, lateSlabs: null },
      monthly: { weekStart: "monday", anchorDate: null, lateFreeAllowance: null, lateSlabs: null },
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

let original: Record<string, any> = {};

test.beforeAll(async ({ browser }, testInfo) => {
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  original = await settingsOf(page);
  await resetCycles(page);
  await page.close();
});

test.afterAll(async ({ browser }, testInfo) => {
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  await resetCycles(page);
  const back: Record<string, unknown> = {
    defaultSalaryPerShift: original.defaultSalaryPerShift ?? 0,
    prodLateDetectionEnabled: original.prodLateDetectionEnabled ?? false,
    prodAttendanceMode: original.prodAttendanceMode ?? "strict",
    lateFreeAllowance: original.lateFreeAllowance ?? 3,
  };
  if (original.prodBonusPercent !== undefined) {
    back.prodBonusPercent = original.prodBonusPercent;
    back.prodBonusWageCeiling = original.prodBonusWageCeiling;
    back.prodBonusEligibilityCeiling = original.prodBonusEligibilityCeiling;
  }
  if (original.permissionPricingEnabled !== undefined) {
    back.permissionPricingEnabled = original.permissionPricingEnabled;
    back.permissionFreeAllowance = original.permissionFreeAllowance;
    back.permissionDeductionSlabs = original.permissionDeductionSlabs;
  }
  await api(page, "PUT", PATH, back);
  await page.close();
});

// ── Staff Payroll and Production Payroll ──

test("Staff Payroll keeps only staff and company-wide settings, and says the pay day and financial year apply to everyone", async ({
  page,
}) => {
  await loginAsHr(page);
  await openSettings(page, "/hr/settings?tab=payroll", '[data-setting-id="pay-day"]');
  await expect(pill(page, "Staff Payroll")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("settings-panel-payroll")).toContainText("Staff Payroll");
  for (const name of ["Payroll Rules", "Bonus", "OT / Compensation"]) await expect(pill(page, name)).toBeVisible();
  await expect(pill(page, "Payroll Rules")).toHaveAttribute("aria-selected", "true");

  const note = page.getByTestId("calendar-applies-to-everyone");
  await expect(note).toContainText("These two apply to everyone");
  await expect(page.locator("#pay-day-input")).toBeVisible();
  await expect(page.locator("#fy-start-month-input")).toBeVisible();
  // the rate suggested for new production employees is not here any more
  await expect(page.locator('[data-setting-id="default-salary-per-shift"]')).toHaveCount(0);
  await expect(page.locator("#default-salary-per-shift-input")).toHaveCount(0);

  // the Bonus sub-tab is the staff bonus
  await pill(page, "Bonus").click();
  await expect(page.locator('[data-setting-id="bonus-percent"] h4')).toHaveText("Staff bonus rate");
  await expect(page.getByTestId("bonus-fy-pointer")).toContainText("staff and production alike");
});

test("Production Payroll has Overview, Weekly, BiWeekly, Monthly and Pay & Bonus, and no late rules or attendance sub-tab", async ({
  page,
}) => {
  await loginAsHr(page);
  await openSettings(page, "/hr/settings?tab=production_payroll", '[data-testid="production-pay-overview"]');
  for (const name of ["Overview", "Weekly", "BiWeekly", "Monthly", "Pay & Bonus"]) {
    await expect(pill(page, name), name).toBeVisible();
  }
  // (the Settings navigation has a "Late Detection" tab of its own: look inside the Production Payroll panel only)
  const panel = page.getByTestId("settings-panel-production_payroll");
  await expect(panel.getByRole("tab", { name: "Late Detection", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("tab", { name: "Attendance & Shift", exact: true })).toHaveCount(0);
  await expect(pill(page, "Overview")).toHaveAttribute("aria-selected", "true");
  // the Overview keeps what "Attendance & Shift" showed, read-only
  await expect(page.getByTestId("production-pf-esi-elsewhere")).toBeVisible();
  await expect(page.getByTestId("production-shifts-elsewhere")).toBeVisible();
  await expect(panel.locator('[data-slot="input"], select')).toHaveCount(0);

  // a cycle holds its period rule only: the late rules are on Late Detection -> Production
  await pill(page, "Weekly").click();
  await expect(page.locator("#weekly-week-start-input")).toBeVisible();
  await expect(page.locator("#weekly-late-allowance-input")).toHaveCount(0);
  await expect(page.getByTestId("weekly-late-pointer").getByRole("link")).toHaveAttribute(
    "href",
    "/hr/settings?tab=late_detection#weekly-late-allowance",
  );
});

test("Pay & Bonus saves the suggested rate per shift on its own, and the Add Employee form still starts from it", async ({
  page,
}) => {
  await loginAsHr(page);
  const rate = 345.5;
  await openSettings(
    page,
    "/hr/settings?tab=production_payroll#default-salary-per-shift",
    "#default-salary-per-shift-input",
  );
  await expect(pill(page, "Pay & Bonus")).toHaveAttribute("aria-selected", "true");
  await page.locator("#default-salary-per-shift-input").fill(String(rate));
  await page.getByRole("button", { name: "Save Pay & Bonus settings" }).click();
  await expect(page.getByText("Pay & Bonus settings saved").first()).toBeVisible();
  const saved = await settingsOf(page);
  expect(saved.defaultSalaryPerShift).toBe(rate);
  // only that value was sent: the staff bonus and the financial year are as they were
  expect(saved.bonusPercent).toBe(original.bonusPercent);
  expect(saved.bonusFyStartMonth).toBe(original.bonusFyStartMonth);

  // the Add Employee form starts a new production employee from it
  await page.goto("/hr/employees/new");
  await page.getByRole("combobox").filter({ hasText: "Staff (Monthly)" }).click({ timeout: 30_000 });
  await page.getByRole("option", { name: "Production (Per Shift)" }).click();
  await expect(page.getByPlaceholder("e.g. 300")).toHaveValue(String(rate));
});

test("the production bonus is its own setting: saved from Pay & Bonus when the server has it, read-only and said so when it does not", async ({
  page,
}) => {
  await loginAsHr(page);
  const before = await settingsOf(page);
  await openSettings(page, "/hr/settings?tab=production_payroll#prod-bonus-percent", "#prod-bonus-percent-input");
  await expect(page.getByTestId("prod-bonus-fy-pointer")).toContainText("Staff Payroll");
  await expect(page.locator("#fy-start-month-input")).toHaveCount(0);

  test.info().annotations.push({
    type: "server",
    description:
      before.prodBonusPercent === undefined ? "does not report the production bonus" : "reports the production bonus",
  });
  if (before.prodBonusPercent === undefined) {
    // an older server: the three values are shown, locked, with the reason
    await expect(page.locator("#prod-bonus-percent-input")).toBeDisabled();
    await expect(page.getByTestId("prod-bonus-not-reported")).toHaveCount(3);
    return;
  }
  await page.locator("#prod-bonus-percent-input").fill("9.5");
  await page.getByRole("button", { name: "Save Pay & Bonus settings" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Save the new production bonus rules?");
  await page.getByTestId("confirm-settings-save").click();
  await expect(page.getByText("Pay & Bonus settings saved").first()).toBeVisible();
  const after = await settingsOf(page);
  expect(after.prodBonusPercent).toBe(9.5);
  // the staff bonus is a different setting: untouched
  expect(after.bonusPercent).toBe(before.bonusPercent);
  expect(after.bonusWageCeiling).toBe(before.bonusWageCeiling);
  expect(after.bonusFyStartMonth).toBe(before.bonusFyStartMonth);
});

// ── Attendance, Production Shifts and Late Detection: the Staff | Production pills ──

test("Attendance: Staff is the page it always was, Production only explains where production is set, and the address keeps the page", async ({
  page,
}) => {
  await loginAsHr(page);
  await openSettings(page, "/hr/settings?tab=attendance", "#arrival-late-window");
  await expect(pill(page, "Staff")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("attendance-production")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save Attendance Settings" })).toBeVisible();

  await pill(page, "Production").click();
  await expect(page).toHaveURL(/tab=attendance&view=production/);
  await expect(page.getByTestId("attendance-page-production")).toBeVisible();
  await expect(page.locator("#arrival-late-window")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save Attendance Settings" })).toHaveCount(0);
  await expect(page.getByTestId("production-days-elsewhere").getByRole("link")).toHaveAttribute(
    "href",
    "/hr/settings?tab=production_shifts",
  );
  await expect(page.getByTestId("production-days-late-elsewhere").getByRole("link")).toHaveAttribute(
    "href",
    "/hr/settings?tab=late_detection#prod-late-switch",
  );
  await expect(page.locator('[data-setting-id="production-attendance"]')).toBeVisible();

  // a refresh comes back to the same page, and a setting's own address opens the page that holds it
  await page.reload();
  await expect(pill(page, "Production")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
  await openSettings(page, "/hr/settings?tab=attendance#late-window", "#arrival-late-window");
  await expect(pill(page, "Staff")).toHaveAttribute("aria-selected", "true");
  await openSettings(page, "/hr/settings?tab=attendance#production-late", '[data-setting-id="production-late"]');
  await expect(pill(page, "Production")).toHaveAttribute("aria-selected", "true");
});

test("Production Shifts: Production is the page with the rules, Staff only says where staff shifts and grace are set", async ({
  page,
}) => {
  await loginAsHr(page);
  await openSettings(page, "/hr/settings?tab=production_shifts", '[data-testid="production-shifts-tab"]');
  await expect(pill(page, "Production")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#production-rules-switch")).toBeVisible();

  await pill(page, "Staff").click();
  await expect(page).toHaveURL(/view=staff/);
  await expect(page.getByTestId("production-shifts-staff-section")).toBeVisible();
  await expect(page.locator("#production-rules-switch")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save Production Shift Rules" })).toHaveCount(0);
  await expect(page.getByTestId("staff-shifts-manage").getByRole("link")).toHaveAttribute("href", "/hr/shifts");
  await expect(page.getByTestId("staff-shifts-attendance").getByRole("link")).toHaveAttribute(
    "href",
    "/hr/settings?tab=attendance#attendance-mode",
  );

  await openSettings(
    page,
    "/hr/settings?tab=production_shifts#staff-shifts-where",
    '[data-setting-id="staff-shifts-where"]',
  );
  await expect(pill(page, "Staff")).toHaveAttribute("aria-selected", "true");
  await openSettings(page, "/hr/settings?tab=production_shifts#breaks", '[data-setting-id="breaks"]');
  await expect(pill(page, "Production")).toHaveAttribute("aria-selected", "true");
});

test("Late Detection: Staff is today's two policies plus the permission pricing, Production holds the late rules that left Production Payroll", async ({
  page,
}) => {
  await loginAsHr(page);
  await openSettings(page, "/hr/settings?tab=late_detection", "#late-free-allowance");
  await expect(pill(page, "Staff")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("permission-pricing-section")).toBeVisible();
  await expect(page.locator("#prod-late-enabled")).toHaveCount(0);

  await pill(page, "Production").click();
  await expect(page).toHaveURL(/tab=late_detection&view=production/);
  await expect(page.locator("#prod-late-enabled")).toBeVisible();
  await expect(page.locator("#prod-attendance-mode-input")).toBeVisible();
  await expect(pill(page, "Weekly")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#weekly-late-allowance-input")).toBeVisible();
  await expect(page.locator("#late-free-allowance")).toHaveCount(0);
  await pill(page, "BiWeekly").click();
  await expect(page.locator("#biweekly-late-allowance-input")).toBeVisible();
  await expect(page.locator("#weekly-late-allowance-input")).toHaveCount(0);

  // a setting's own address opens its page and its cycle; a refresh keeps the page
  await openSettings(
    page,
    "/hr/settings?tab=late_detection#monthly-late-slabs",
    '[data-setting-id="monthly-late-slabs"]',
  );
  await expect(pill(page, "Production")).toHaveAttribute("aria-selected", "true");
  await expect(pill(page, "Monthly")).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Staff", exact: true }).click();
  await page.reload();
  await expect(pill(page, "Staff")).toHaveAttribute("aria-selected", "true", { timeout: 30_000 });
});

test("what was typed on one page of Late Detection is kept while the other is open", async ({ page }) => {
  await loginAsHr(page);
  await openSettings(page, "/hr/settings?tab=late_detection", "#late-free-allowance");
  await page.locator("#late-free-allowance").fill("7");
  await pill(page, "Production").click();
  await expect(page.getByTestId("settings-unsaved-chip")).toHaveText("Not saved yet: Staff");
  await pill(page, "Staff").click();
  await expect(page.locator("#late-free-allowance")).toHaveValue("7");
  // nothing was sent
  expect((await settingsOf(page)).lateFreeAllowance).toBe(original.lateFreeAllowance ?? 3);
});

test("saving a late rule from Late Detection and a period rule from Production Payroll never overwrite each other", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await loginAsHr(page);
  const weekly = async () => ((await settingsOf(page)).prodCycles as Record<string, any>).weekly;
  expect(await weekly()).toMatchObject({ weekStart: "monday", ownLateRules: false });

  // 1. a late rule, from Late Detection -> Production -> Weekly
  await openSettings(page, "/hr/settings?tab=late_detection#weekly-late-allowance", "#weekly-late-allowance-input");
  await page.locator("#weekly-late-allowance-input").fill("5");
  await page.getByRole("button", { name: "Save Production Late Detection" }).click();
  await expect(page.getByTestId("confirm-production-late")).toContainText("Weekly: free late days a period");
  await page.getByTestId("confirm-production-late-confirm").click();
  await expect(page.getByText("Production Late Detection saved").first()).toBeVisible();
  expect(await weekly()).toMatchObject({ weekStart: "monday", lateFreeAllowance: 5, ownLateRules: true });

  // 2. a period rule, from Production Payroll -> Weekly: the late rule must survive it
  await openSettings(page, "/hr/settings?tab=production_payroll#weekly-week-start", "#weekly-week-start-input");
  await page.locator("#weekly-week-start-input").selectOption("wednesday");
  await page.getByRole("button", { name: "Save Weekly settings" }).click();
  // asked only when payroll was already generated for days the new weeks would cover
  await page
    .getByTestId("confirm-settings-save")
    .click({ timeout: 3_000 })
    .catch(() => undefined);
  await expect(page.getByText("Weekly settings saved").first()).toBeVisible();
  expect(await weekly()).toMatchObject({ weekStart: "wednesday", lateFreeAllowance: 5, ownLateRules: true });

  // 3. the late rule again: the period rule must survive it, and the page shows what the period save left
  await openSettings(page, "/hr/settings?tab=late_detection#weekly-late-allowance", "#weekly-late-allowance-input");
  await expect(page.locator("#weekly-late-allowance-input")).toHaveValue("5");
  await expect(page.getByTestId("weekly-late-source")).toContainText("Weekly has late rules of its own");
  await page.locator("#weekly-late-allowance-input").fill("6");
  await page.getByRole("button", { name: "Save Production Late Detection" }).click();
  await page.getByTestId("confirm-production-late-confirm").click();
  await expect(page.getByText("Production Late Detection saved").first()).toBeVisible();
  expect(await weekly()).toMatchObject({ weekStart: "wednesday", lateFreeAllowance: 6, ownLateRules: true });

  // 4. "Use the shared rules again" hands only the late rules back
  await page.getByRole("button", { name: "Use the shared rules again" }).click();
  await page.getByRole("button", { name: "Use the shared rules", exact: true }).click();
  await expect(page.getByText("Weekly uses the shared late rules again").first()).toBeVisible();
  expect(await weekly()).toMatchObject({ weekStart: "wednesday", ownLateRules: false });
  await expect(page.getByTestId("weekly-late-source")).toContainText("Using the shared production values");

  // 5. and the Production Payroll Overview reads both from the one server answer
  await openSettings(page, "/hr/settings?tab=production_payroll", '[data-testid="production-cycle-summary-weekly"]');
  await expect(page.getByTestId("production-cycle-summary-weekly")).toContainText("Wednesday weeks");
  await expect(page.getByTestId("production-cycle-summary-weekly")).toContainText("(shared)");
  await resetCycles(page);
});

test("the switch and the mode of the production late rules save alone", async ({ page }) => {
  await loginAsHr(page);
  const before = await settingsOf(page);
  await openSettings(page, "/hr/settings?tab=late_detection#prod-late-switch", "#prod-late-enabled");
  const flipped = !(before.prodLateDetectionEnabled ?? false);
  await page.locator("#prod-late-enabled").click();
  await page.getByRole("button", { name: "Save Production Late Detection" }).click();
  await expect(page.getByTestId("confirm-production-late")).toContainText("Late deductions");
  await page.getByTestId("confirm-production-late-confirm").click();
  await expect(page.getByText("Production Late Detection saved").first()).toBeVisible();
  const after = await settingsOf(page);
  expect(after.prodLateDetectionEnabled ?? false).toBe(flipped);
  // only the switch changed: the mode and every cycle's rules are as they were
  expect(after.prodAttendanceMode).toBe(before.prodAttendanceMode);
  expect(after.prodCycles).toEqual(before.prodCycles);
});

// ── permission pricing ──

test("Permission pricing: OFF by default; the switch needs a slab, saves the three company-wide keys, and the example follows", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await loginAsHr(page);
  const before = await settingsOf(page);
  await openSettings(page, "/hr/settings?tab=late_detection#permission-pricing", "#permission-pricing-switch");
  await expect(page.getByTestId("pricing-off-text")).toContainText("one more mark in the late pool");
  await expect(page.getByTestId("pricing-on-text")).toContainText("leave the late pool");

  test.info().annotations.push({
    type: "server",
    description:
      before.permissionPricingEnabled === undefined
        ? "does not report permission pricing"
        : "reports permission pricing",
  });
  if (before.permissionPricingEnabled === undefined) {
    // an older server: the pricing is shown, locked, with the reason
    await expect(page.locator("#permission-pricing-switch")).toBeDisabled();
    await expect(page.getByTestId("pricing-not-reported")).toBeVisible();
    return;
  }
  expect(before.permissionPricingEnabled).toBe(false);
  await page.locator("#permission-pricing-switch").click();
  await expect(page.getByTestId("pricing-needs-slab")).toContainText("Add at least one slab before turning this on.");
  await expect(page.getByRole("button", { name: "Save Permission Pricing" })).toBeDisabled();

  const block = page.locator('[data-setting-id="permission-deduction-slabs"]');
  await block.getByRole("button", { name: "Add Slab" }).click();
  await expect(page.getByTestId("pricing-needs-slab")).toHaveCount(0);
  await expect(block.locator("th").first()).toHaveText("From permissions");
  await page.getByLabel("Row 1: deduct shifts").fill("0.5");
  await page.locator("#permission-free-allowance-input").fill("1");
  // the default month: 6 approved, cap 3 -> 3 extra, 1 free -> 2 billable -> the row from 1 -> half a shift
  await expect(page.getByTestId("pricing-example-billable")).toContainText("1 free");
  await expect(page.getByTestId("pricing-example-permission-cut")).toContainText("-0.5 shift");

  await page.getByRole("button", { name: "Save Permission Pricing" }).click();
  await expect(page.getByTestId("confirm-permission-pricing")).toContainText("Price permissions separately");
  await page.getByTestId("confirm-permission-pricing-confirm").click();
  await expect(page.getByText("Permission pricing saved").first()).toBeVisible();
  const after = await settingsOf(page);
  expect(after.permissionPricingEnabled).toBe(true);
  expect(after.permissionFreeAllowance).toBe(1);
  expect(after.permissionDeductionSlabs).toEqual([{ fromPermissions: 1, deductionShifts: 0.5 }]);

  // and back off
  const off = await api(page, "PUT", PATH, {
    permissionPricingEnabled: false,
    permissionFreeAllowance: 0,
    permissionDeductionSlabs: [],
  });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
});

// ── the search and the addresses ──

test("the search opens the page, the pill and the cycle that hold a moved or new setting", async ({ page }) => {
  test.setTimeout(180_000);
  await loginAsHr(page);
  const search = page.getByRole("combobox", { name: "Find a setting" });
  const go = async (query: string, hit: string) => {
    await openSettings(page, "/hr/settings");
    await search.fill(query);
    const result = page.getByTestId(`settings-search-hit-${hit}`);
    await expect(result).toBeVisible();
    // the list closes a moment after the box loses focus: pick the hit as a click event, without the scroll Playwright does first
    await result.dispatchEvent("click");
  };

  await go("weekly late free days", "late_detection-weekly-late-allowance");
  await expect(pill(page, "Production")).toHaveAttribute("aria-selected", "true");
  await expect(pill(page, "Weekly")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-setting-id="weekly-late-allowance"]')).toBeInViewport({ timeout: 15_000 });

  await go("biweekly late slabs", "late_detection-biweekly-late-slabs");
  await expect(pill(page, "BiWeekly")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-setting-id="biweekly-late-slabs"]')).toBeInViewport({ timeout: 15_000 });

  await go("permission slabs", "late_detection-permission-deduction-slabs");
  await expect(pill(page, "Staff")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-setting-id="permission-deduction-slabs"]')).toBeInViewport({ timeout: 15_000 });

  await go("suggested rate per shift", "production_payroll-default-salary-per-shift");
  await expect(page.getByRole("tab", { name: "Production Payroll", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(pill(page, "Pay & Bonus")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-setting-id="default-salary-per-shift"]')).toBeInViewport({ timeout: 15_000 });

  await go("production bonus rate", "production_payroll-prod-bonus-percent");
  await expect(pill(page, "Pay & Bonus")).toHaveAttribute("aria-selected", "true");

  await go("old production punch times", "attendance-production-attendance");
  await expect(pill(page, "Production")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-setting-id="production-attendance"]')).toBeInViewport({ timeout: 15_000 });

  await go("where staff shifts", "production_shifts-staff-shifts-where");
  await expect(pill(page, "Staff")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-setting-id="staff-shifts-where"]')).toBeInViewport({ timeout: 15_000 });

  await go("financial year", "payroll-fy-start-month");
  await expect(page.getByRole("tab", { name: "Staff Payroll", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(pill(page, "Payroll Rules")).toHaveAttribute("aria-selected", "true");
});

test("every moved setting keeps its id: the old Production Payroll addresses of the late rules now land on Late Detection", async ({
  page,
}) => {
  await loginAsHr(page);
  // the links other pages and the insights catalogue use are the setting ids, which did not change; the tab did
  await openSettings(page, "/hr/settings?tab=late_detection#prod-attendance-mode", "#prod-attendance-mode-input");
  await expect(pill(page, "Production")).toHaveAttribute("aria-selected", "true");
  await openSettings(
    page,
    "/hr/settings?tab=production_payroll#prod-shifts-earned",
    '[data-setting-id="prod-shifts-earned"]',
  );
  await expect(pill(page, "Overview")).toHaveAttribute("aria-selected", "true");
  await openSettings(page, "/hr/settings?tab=production_payroll#monthly-first-period", "#monthly-first-period-input");
  await expect(pill(page, "Monthly")).toHaveAttribute("aria-selected", "true");
});
