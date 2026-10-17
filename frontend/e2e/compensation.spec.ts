import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Compensation is five pages under /hr/compensation (CTC Breakdown, OT Detection, Compensation Leave, History, Reports),
// each with its own address and its own entry in the sidebar group, and subtabs in the path
// (/hr/compensation/ot-detection/type-2), with a second level of nested subtabs where a subtab has several sections
// (/hr/compensation/ot-detection/type-2/waiting). The pages are mandatory. Settings -> Payroll -> OT / Compensation switches the
// background OT and Compensation FEATURES (after a confirmation); it must never hide a page or leave it unable to load.

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
// (the Settings page also links to Compensation from its headings: the sidebar is the <aside>)
const sidebar = (page: Page) => page.getByRole("complementary");
const sidebarGroup = (page: Page) => sidebar(page).getByText("Compensation", { exact: true });
// (found by address: the Report Center has a top-level "Reports" link of its own)
const SLUGS: Record<string, string> = {
  "CTC Breakdown": "ctc-breakdown",
  "OT Detection": "ot-detection",
  "Compensation Leave": "compensation-leave",
  History: "history",
  Reports: "reports",
};
const sidebarChild = (page: Page, name: string) => sidebar(page).locator(`a[href="/hr/compensation/${SLUGS[name]}"]`);
const PAGES = [
  { name: "CTC Breakdown", path: "/hr/compensation/ctc-breakdown" },
  { name: "OT Detection", path: "/hr/compensation/ot-detection/type-1/allowance" },
  { name: "Compensation Leave", path: "/hr/compensation/compensation-leave/announcements/announce" },
  { name: "History", path: "/hr/compensation/history/ot-allowance" },
  { name: "Reports", path: "/hr/compensation/reports" },
];
const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });
/** Opens the Compensation group of the sidebar (it is closed on every page that is not one of its own). */
async function openGroup(page: Page) {
  await sidebarGroup(page).click();
  await expect(sidebarChild(page, "CTC Breakdown")).toBeVisible();
}

async function hrToken(page: Page) {
  return page.evaluate(() => localStorage.getItem("uk_textile_token"));
}

async function openFeatureSwitch(page: Page) {
  await page.goto("/hr/settings");
  await tab(page, "Payroll").click();
  await tab(page, "OT / Compensation").click();
  const toggle = page.getByTestId("toggle-compensation-features");
  await expect(toggle).toBeVisible();
  return toggle;
}

test.describe.configure({ mode: "serial" });

test("Compensation is a sidebar group of five pages, each its own address and heading, with no tab strip on top", async ({
  page,
}) => {
  await loginAsHr(page);
  await expect(sidebarGroup(page)).toBeVisible();
  await openGroup(page);
  for (const { name } of PAGES) await expect(sidebarChild(page, name)).toBeVisible();

  // the group's own click shows its children, the first child is the first page
  await sidebarChild(page, "CTC Breakdown").click();
  await expect(page).toHaveURL(/\/hr\/compensation\/ctc-breakdown$/);
  await expect(heading(page, "CTC Breakdown")).toBeVisible();

  for (const { name, path } of PAGES) {
    await sidebarChild(page, name).click();
    await expect(page).toHaveURL(new RegExp(`${path.replace(/[/]/g, "\\/")}$`));
    await expect(heading(page, name)).toBeVisible();
    // the clicked child is the lit one, and the only one
    await expect(sidebarChild(page, name).locator(".clay-nav-active")).toHaveCount(1);
    await expect(sidebar(page).locator("a .clay-nav-active")).toHaveCount(1);
  }

  // the old strip of four pill tabs is gone: no tab is named after a page
  for (const name of ["CTC Breakdown", "OT Detection", "Compensation Leave", "History & Reports"]) {
    await expect(tab(page, name)).toHaveCount(0);
  }
  await expect(page.getByTestId("compensation-features-off")).toHaveCount(0);
});

test("the bare address, an unknown subtab and an unknown page land on the first page or subtab", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/compensation");
  await expect(page).toHaveURL(/\/hr\/compensation\/ctc-breakdown$/);
  for (const [from, to] of [
    ["/hr/compensation/ot-detection", /\/ot-detection\/type-1\/allowance$/],
    ["/hr/compensation/ot-detection/nonsense", /\/ot-detection\/type-1\/allowance$/],
    ["/hr/compensation/ot-detection/type-2", /\/ot-detection\/type-2\/waiting$/],
    ["/hr/compensation/ot-detection/type-2/nonsense?month=3", /\/ot-detection\/type-2\/waiting\?month=3$/],
    ["/hr/compensation/compensation-leave", /\/compensation-leave\/announcements\/announce$/],
    ["/hr/compensation/compensation-leave/holiday-work", /\/holiday-work\/raise$/],
    ["/hr/compensation/compensation-leave/holiday-work/nonsense", /\/holiday-work\/raise$/],
    ["/hr/compensation/compensation-leave/birthdays", /\/birthdays\/list$/],
    ["/hr/compensation/history", /\/history\/ot-allowance$/],
    ["/hr/compensation/history/company-windows", /\/history\/company-windows\/late-in$/],
    ["/hr/compensation/history/holiday-work", /\/history\/holiday-work\/work$/],
    ["/hr/compensation/nonsense", /\/ctc-breakdown$/],
  ] as const) {
    await page.goto(from);
    await expect(page, from).toHaveURL(to);
  }
});

test("the old ?tab= addresses redirect to the new paths and keep the other parameters", async ({ page }) => {
  await loginAsHr(page);
  for (const [from, to] of [
    ["/hr/compensation?tab=ctc", /\/ctc-breakdown$/],
    ["/hr/compensation?tab=ot&month=1", /\/ot-detection\/type-1\/allowance\?month=1$/],
    ["/hr/compensation?tab=ot&otstatus=rejected", /\/ot-detection\/type-2\/assigned\?otstatus=rejected$/],
    ["/hr/compensation?tab=leave&sub=birthdays&bperiod=week", /\/compensation-leave\/birthdays\/list\?bperiod=week$/],
    ["/hr/compensation?tab=leave&sub=holiday_work&hstatus=pending", /\/holiday-work\/claims\?hstatus=pending$/],
    ["/hr/compensation?tab=leave&sub=holiday_work", /\/holiday-work\/raise$/],
    ["/hr/compensation?tab=history&type=birthday&period=week", /\/history\/birthday-leave\?period=week$/],
    ["/hr/compensation?tab=history&type=window_early_out", /\/history\/company-windows\/early-out$/],
    ["/hr/compensation?tab=history&type=holiday_work", /\/history\/holiday-work\/work$/],
  ] as const) {
    await page.goto(from);
    await expect(page, from).toHaveURL(to);
  }
});

test("a role without the Compensation module cannot open any of its pages", async ({ page }) => {
  await loginAsHr(page);
  const admin = { Authorization: `Bearer ${await hrToken(page)}` };
  const stamp = Date.now().toString(36);
  const role = await page.request.post("/api/roles", {
    headers: admin,
    data: { name: `e2e-no-comp-${stamp}`, permissions: { dashboard: "view" } },
  });
  expect(role.status()).toBe(201);
  const roleId = (await role.json()).id as number;
  const username = `e2e_nocomp_${stamp}`;
  const password = "E2e-Limited-1!";
  const user = await page.request.post("/api/hr-users", { headers: admin, data: { username, password, roleId } });
  expect(user.status()).toBe(201);
  try {
    const login = await page.request.post("/api/auth/hr-login", { data: { username, password } });
    const token = (await login.json()).token as string;
    await page.evaluate((t) => localStorage.setItem("uk_textile_token", t), token);
    await page.goto("/hr/dashboard");
    await expect(page).toHaveURL(/\/hr\/dashboard/);
    await expect(sidebar(page).getByText("Compensation", { exact: true })).toHaveCount(0);
    for (const path of [
      "/hr/compensation",
      "/hr/compensation/ctc-breakdown",
      "/hr/compensation/ot-detection/type-2",
      "/hr/compensation/compensation-leave/holiday-work",
      "/hr/compensation/history/ot-pay",
      "/hr/compensation/reports",
      "/hr/compensation?tab=leave&sub=holiday-work",
    ]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/hr\/dashboard/);
    }
  } finally {
    await page.request.delete(`/api/hr-users/${(await user.json()).id}`, { headers: admin });
    await page.request.delete(`/api/roles/${roleId}`, { headers: admin });
  }
});

test("turning the features off asks first, and Cancel changes nothing", async ({ page }) => {
  await loginAsHr(page);
  const toggle = await openFeatureSwitch(page);
  await expect(toggle).toBeChecked();
  await toggle.click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Turn off the OT & Compensation features?");
  await expect(dialog).toContainText("Compensation page stays in the sidebar");
  await dialog.getByRole("button", { name: "Keep them on" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(toggle).toBeChecked();

  // Nothing was saved.
  const token = await hrToken(page);
  const settings = await (
    await page.request.get("/api/payroll-settings", { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  expect(settings.compensationFeatureEnabled).toBe(true);
});

test("with the features off the page stays in the sidebar and still works; only the changes are paused", async ({
  page,
}) => {
  await loginAsHr(page);
  const toggle = await openFeatureSwitch(page);
  await toggle.click();
  await page.getByTestId("confirm-compensation-features-off").click();
  await expect(page.getByText("OT & Compensation features OFF").first()).toBeVisible();
  await expect(toggle).not.toBeChecked();

  // The sidebar group is still there, the pages open, and say what is paused.
  await expect(sidebarGroup(page)).toBeVisible();
  await openGroup(page);
  await sidebarChild(page, "OT Detection").click();
  await expect(page).toHaveURL(/\/hr\/compensation\/ot-detection/);
  await expect(heading(page, "OT Detection")).toBeVisible();
  const notice = page.getByTestId("compensation-features-off");
  await expect(notice).toContainText("The OT and Compensation features are switched off");
  await expect(notice).toContainText("This page and every record on it stay available");

  // Reading works on every page (no 403 message, no empty "disabled" screen); the notice is on every page but CTC.
  await expect(page.getByText("Compensation feature is currently disabled")).toHaveCount(0);
  for (const { name } of PAGES) {
    await sidebarChild(page, name).click();
    await expect(heading(page, name)).toBeVisible();
    await expect(page.getByTestId("compensation-features-off")).toHaveCount(name === "CTC Breakdown" ? 0 : 1);
  }
  await sidebarChild(page, "CTC Breakdown").click();
  await expect(page.getByText("E2E001").first()).toBeVisible();

  // Assign / announce / redeem are paused, with the reason on the button.
  await page.goto("/hr/compensation/ot-detection/type-2");
  const assign = page.getByTestId("ot2-assign");
  await expect(assign).toBeDisabled();
  await expect(assign).toHaveAttribute("title", /switched off in Settings/);
  await page.goto("/hr/compensation/compensation-leave/announcements");
  const announce = page.getByTestId("window-submit");
  await expect(announce).toBeDisabled();
  await expect(announce).toHaveAttribute("title", /switched off in Settings/);

  // The API agrees: reads answer, changes are refused with the reason.
  const auth = { Authorization: `Bearer ${await hrToken(page)}` };
  const reads = ["", "/ot", "/credits", "/leave-days", "/summary", "/config", "/windows", "/holiday-work", "/balance"];
  for (const path of [...reads, "/birthdays", "/reports"]) {
    const r = await page.request.get(`/api/compensation${path}`, { headers: auth });
    expect(r.status(), path || "/").toBe(200);
  }
  // every kind of change is refused with the same reason: the old Compensation Day, an announced window, a Sunday /
  // holiday work claim, an OT assignment and a redemption of the balance
  for (const path of ["/leave-days", "/windows", "/holiday-work", "/ot/assign", "/balance/redeem"]) {
    const refused = await page.request.post(`/api/compensation${path}`, {
      headers: auth,
      data: path === "/leave-days" ? { date: "2030-01-01" } : {},
    });
    expect(refused.status(), path).toBe(403);
    expect((await refused.json()).error, path).toContain("switched off in Settings");
  }
});

test("switching the features back on needs no confirmation and lifts the pause", async ({ page }) => {
  await loginAsHr(page);
  const toggle = await openFeatureSwitch(page);
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByText("OT & Compensation features ON").first()).toBeVisible();
  await expect(toggle).toBeChecked();

  await openGroup(page);
  await sidebarChild(page, "Compensation Leave").click();
  await expect(heading(page, "Compensation Leave")).toBeVisible();
  await expect(page.getByTestId("compensation-features-off")).toHaveCount(0);
  // The master pause is lifted (the button can still be paused by the feature's own switch on Settings -> Compensation,
  // which says so in its title, but no longer by the master switch).
  await expect(page.getByTestId("window-submit")).not.toHaveAttribute("title", /Settings → Payroll/);
});

test("the Requests hub link opens Sunday & holiday work on its Claims section, and the older addresses land on the right section", async ({
  page,
}) => {
  await loginAsHr(page);
  // the hub's own link
  await page.goto("/hr/compensation/compensation-leave/holiday-work/claims");
  await expect(page).toHaveURL(/\/hr\/compensation\/compensation-leave\/holiday-work\/claims$/);
  await expect(heading(page, "Compensation Leave")).toBeVisible();
  await expect(tab(page, "B. Sunday & holiday work")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("holiday-nested-claims")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("claim-list")).toBeVisible();
  await expect(page.getByTestId("claim-form")).toHaveCount(0);
  await expect(page.getByTestId("balance-part")).toHaveCount(0);

  // the older addresses: the subtab alone opens its first section, a claim filter opens Claims
  for (const [address, section] of [
    ["/hr/compensation/compensation-leave/holiday-work", "raise"],
    ["/hr/compensation?tab=leave&sub=holiday-work", "raise"],
    ["/hr/compensation?tab=leave&sub=holiday-work&hstatus=pending", "claims"],
  ] as const) {
    await page.goto(address);
    await expect(page, address).toHaveURL(new RegExp(`/hr/compensation/compensation-leave/holiday-work/${section}`));
    await expect(page.getByTestId("holiday-nested-" + section), address).toHaveAttribute("aria-selected", "true");
  }
});

// ── The rebuilt tabs ─────────────────────────────────────────────────────────────────────────────────────────────────
// What each tab shows depends on the switches of Settings -> Compensation (all off in a fresh database), so these cases
// read the settings first and expect the notice of a switched-off feature exactly when it is off.

type CompensationConfig = {
  masterEnabled: boolean;
  allowance: { enabled: boolean };
  shift: { enabled: boolean; relaxationEnabled: boolean; payEnabled: boolean };
  windows: { enabled: boolean };
  holidayWork: { enabled: boolean };
  birthday: { enabled: boolean };
};

async function api(page: Page, method: string, url: string, data?: unknown) {
  const res = await page.request.fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await hrToken(page)}` },
    data,
  });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

const readConfig = async (page: Page) =>
  (await api(page, "GET", "/api/compensation/config")).body as CompensationConfig;
/** 1 when the notice of a switched-off feature should be on screen, else 0. */
const offCount = (master: boolean, featureOn: boolean) => (master && !featureOn ? 1 : 0);

test("OT Detection keeps Type 1 and Type 2 in two subtabs with their own addresses, under the same tiles", async ({
  page,
}) => {
  await loginAsHr(page);
  await page.goto("/hr/compensation/ot-detection");
  await expect(page).toHaveURL(/\/ot-detection\/type-1\/allowance$/);
  await expect(heading(page, "OT Detection")).toBeVisible();
  await expect(tab(page, "Type 1 · Late-in allowance")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("ot-kpis")).toBeVisible();
  for (const tile of ["earned", "used", "waiting", "assigned", "rejected"]) {
    await expect(page.getByTestId(`ot-kpi-${tile}`)).toBeVisible();
  }
  const type1 = page.getByTestId("ot-type1");
  await expect(type1).toContainText("Type 1");
  await expect(type1).toContainText("Automatic and unpaid");
  // only Type 1 is on screen
  await expect(page.getByTestId("ot-type2")).toHaveCount(0);
  // Type 1 is read-only: nothing to tick, assign or reject inside it
  await expect(type1.getByRole("checkbox")).toHaveCount(0);
  await expect(type1.getByRole("button", { name: /assign|reject|announce/i })).toHaveCount(0);

  // the month and the search are controls of the page, the address remembers them, and the subtab switch keeps them
  await page.getByTestId("ot-month").click();
  await page.getByRole("option", { name: "January" }).click();
  await expect(page).toHaveURL(/month=1(&|$)/);
  await page.getByTestId("ot-search").fill("zzz");
  await expect(page).toHaveURL(/otq=zzz/);
  await tab(page, "Type 2 · Shift compensation").click();
  await expect(page).toHaveURL(/\/ot-detection\/type-2\/waiting\?/);
  await expect(page).toHaveURL(/month=1(&|$)/);
  await expect(page).toHaveURL(/otq=zzz/);
  await expect(page.getByTestId("ot-kpis")).toBeVisible();
  await expect(page.getByTestId("ot-search")).toHaveValue("zzz");

  // Type 2 has Assign and Reject, with nothing selected yet; Type 1 is gone from the screen
  await expect(page.getByTestId("ot-type2")).toContainText("Type 2");
  await expect(page.getByTestId("ot-type1")).toHaveCount(0);
  await expect(page.getByTestId("ot2-assign")).toBeDisabled();
  await expect(page.getByTestId("ot2-reject")).toBeDisabled();

  // Type 2's sections are nested subtabs: one at a time, each with its own address, the filters kept
  await expect(page.getByTestId("ot-type2-nested-waiting")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("ot-type2-nested-assigned").click();
  await expect(page).toHaveURL(/\/ot-detection\/type-2\/assigned\?/);
  await expect(page).toHaveURL(/otq=zzz/);
  await expect(page.getByTestId("ot-type2-assigned")).toBeVisible();
  await expect(page.getByTestId("ot-type2")).toHaveCount(0);
  await page.getByTestId("ot-type2-nested-how").click();
  await expect(page).toHaveURL(/\/ot-detection\/type-2\/how\?/);
  await expect(page.getByTestId("rules-type2")).toBeVisible();
  await expect(page.getByTestId("ot-type2-assigned")).toHaveCount(0);
  // the arrow keys move along the strip
  await page.getByTestId("ot-type2-nested-how").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(/\/ot-detection\/type-2\/assigned\?/);
  await page.keyboard.press("Home");
  await expect(page).toHaveURL(/\/ot-detection\/type-2\/waiting\?/);
});

test("OT Detection says which of its features are switched off in Settings, and links to the switch", async ({
  page,
}) => {
  await loginAsHr(page);
  const config = await readConfig(page);
  await page.goto("/hr/compensation/ot-detection/type-1");
  await expect(page.getByTestId("ot-kpis")).toBeVisible();
  const m = config.masterEnabled;
  // each notice stays with its own type: Type 1's on Type 1, Type 2's on Type 2
  await expect(page.getByTestId("ot-type1-off")).toHaveCount(offCount(m, config.allowance.enabled));
  await expect(page.getByTestId("ot-type2-off")).toHaveCount(0);
  await page.goto("/hr/compensation/ot-detection/type-2");
  await expect(page.getByTestId("ot-kpis")).toBeVisible();
  await expect(page.getByTestId("ot-type1-off")).toHaveCount(0);
  await expect(page.getByTestId("ot-type2-off")).toHaveCount(offCount(m, config.shift.enabled));
  await expect(page.getByTestId("ot-modes-off")).toHaveCount(
    m && config.shift.enabled && !config.shift.relaxationEnabled && !config.shift.payEnabled ? 1 : 0,
  );
  if (m && !config.allowance.enabled) {
    await page.goto("/hr/compensation/ot-detection/type-1");
    await page
      .getByTestId("ot-type1-off")
      .getByRole("link", { name: /Settings → Compensation/ })
      .click();
    await expect(page).toHaveURL(/\/hr\/settings\?tab=compensation/);
    await expect(page.getByTestId("compensation-tab")).toBeVisible();
  }
});

test("Compensation Leave has three subtabs, each with its own notice for its own switch", async ({ page }) => {
  await loginAsHr(page);
  const config = await readConfig(page);
  const m = config.masterEnabled;
  await page.goto("/hr/compensation/compensation-leave");
  await expect(page).toHaveURL(/\/compensation-leave\/announcements\/announce$/);
  await expect(heading(page, "Compensation Leave")).toBeVisible();
  const part = (name: RegExp) => page.getByRole("tab", { name });

  // A. announce late-in / early-out (the first part, so a bare address opens it)
  await expect(part(/^A\. Announce late-in \/ early-out/)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("windows-part")).toBeVisible();
  await expect(page.getByTestId("windows-form")).toContainText("Announce late-in / early-out");
  await expect(page.getByTestId("windows-off")).toHaveCount(offCount(m, config.windows.enabled));
  await expect(page.getByTestId("window-submit")).toHaveText("Add announcement");
  // one section at a time: the announcements are the other nested subtab
  await expect(page.getByTestId("windows-list")).toHaveCount(0);
  await page.getByTestId("windows-nested-list").click();
  await expect(page).toHaveURL(/\/compensation-leave\/announcements\/list$/);
  await expect(page.getByTestId("windows-list")).toBeVisible();
  await expect(page.getByTestId("windows-form")).toHaveCount(0);

  // B. work on Sundays and company holidays, one nested subtab per section
  await part(/^B\. Sunday & holiday work/).click();
  await expect(page).toHaveURL(/\/compensation-leave\/holiday-work\/raise$/);
  await expect(page.getByTestId("holiday-part")).toBeVisible();
  await expect(page.getByTestId("holiday-how")).toContainText("only HR raises a claim here");
  await expect(page.getByTestId("holiday-how")).toContainText("Department Head approves it in Approvals");
  await expect(page.getByTestId("holiday-off")).toHaveCount(offCount(m, config.holidayWork.enabled));
  await expect(page.getByTestId("claim-form")).toBeVisible();
  await expect(page.getByTestId("claim-list")).toHaveCount(0);
  await expect(page.getByTestId("balance-part")).toHaveCount(0);
  await page.getByTestId("holiday-nested-claims").click();
  await expect(page).toHaveURL(/\/holiday-work\/claims$/);
  await expect(page.getByTestId("claim-list")).toBeVisible();
  await expect(page.getByTestId("claim-form")).toHaveCount(0);
  await page.getByTestId("holiday-nested-balance").click();
  await expect(page).toHaveURL(/\/holiday-work\/balance$/);
  await expect(page.getByTestId("balance-part")).toBeVisible();
  await expect(page.getByTestId("claim-list")).toHaveCount(0);
  await page.getByTestId("holiday-nested-credits").click();
  await expect(page).toHaveURL(/\/holiday-work\/credits$/);
  await expect(page.getByTestId("credits-card")).toBeVisible();
  await expect(page.getByTestId("balance-part")).toHaveCount(0);

  // C. birthdays
  await part(/^C\. Birthdays/).click();
  await expect(page).toHaveURL(/\/compensation-leave\/birthdays\/list$/);
  await expect(page.getByTestId("birthdays-part")).toBeVisible();
  await expect(page.getByTestId("birthday-off")).toHaveCount(offCount(m, config.birthday.enabled));
  await tab(page, "Week").click();
  await expect(page).toHaveURL(/bperiod=week/);
  await expect(page.getByTestId("birthday-kpis")).toBeVisible();
  await page.getByTestId("birthday-nested-how").click();
  await expect(page).toHaveURL(/\/birthdays\/how\?bperiod=week/);
  await expect(page.getByTestId("birthday-how")).toContainText("Automatic: HR does nothing.");
  await expect(page.getByTestId("birthday-kpis")).toHaveCount(0);

  // the section is in the address: a reload lands on it again
  await page.reload();
  await expect(page.getByTestId("birthday-how")).toBeVisible();
});

test("a date that is neither a Sunday nor a holiday cannot be claimed for, and says why", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/compensation/compensation-leave/holiday-work");
  await expect(page.getByTestId("claim-no-date")).toBeVisible();
  // 3 Aug 2026 is a Monday
  await page.getByTestId("claim-date").fill("2026-08-03");
  await expect(page.getByTestId("claim-not-claimable")).toContainText("neither a Sunday nor a declared holiday");
  await expect(page.getByTestId("claim-submit")).toHaveCount(0);
});

const TYPES = [
  "ot_allowance",
  "ot_shift_relaxation",
  "ot_shift_pay",
  "window_late_in",
  "window_early_out",
  "holiday_work",
  "birthday",
];

test("History has one subtab per kind of record, each showing only its own section, by Today, Week and Month", async ({
  page,
}) => {
  await loginAsHr(page);
  await page.goto("/hr/compensation/history");
  await expect(page).toHaveURL(/\/history\/ot-allowance$/);
  await expect(heading(page, "History")).toBeVisible();
  await expect(page.getByTestId("history-range")).toBeVisible();
  const sections = page.locator('[data-testid^="report-section-"]');
  const subtabs: [string, string[]][] = [
    ["OT allowance", ["ot_allowance"]],
    ["OT relaxation", ["ot_shift_relaxation"]],
    ["OT pay", ["ot_shift_pay"]],
    // two sections: one nested subtab each, the first opens
    ["Company windows", ["window_late_in"]],
    ["Holiday / Sunday work", ["holiday_work"]],
    ["Birthday leave", ["birthday"]],
  ];
  for (const [name, types] of subtabs) {
    await page
      .getByRole("tab", { name: new RegExp(`^${name.replace(/[/]/g, "\\/")}`) })
      .first()
      .click();
    await expect(sections).toHaveCount(types.length);
    for (const type of types) {
      await expect(page.getByTestId(`report-section-${type}`)).toBeVisible();
      await expect(page.getByTestId(`report-who-${type}`)).toBeVisible();
    }
  }
  await expect(page).toHaveURL(/\/history\/birthday-leave$/);

  // Company windows: the early-out window is its own nested subtab, not stacked under the late-in one
  await page
    .getByRole("tab", { name: /^Company windows/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/history\/company-windows\/late-in$/);
  await page.getByTestId("history-nested-early-out").click();
  await expect(page).toHaveURL(/\/history\/company-windows\/early-out$/);
  await expect(sections).toHaveCount(1);
  await expect(page.getByTestId("report-section-window_early_out")).toBeVisible();
  await expect(page.getByTestId("report-section-window_late_in")).toHaveCount(0);
  await page
    .getByRole("tab", { name: /^Birthday leave/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/history\/birthday-leave$/);

  // the period and the filters sit above the subtabs and go with a switch
  await tab(page, "Week").click();
  await expect(page).toHaveURL(/\/history\/birthday-leave\?period=week/);
  await page
    .getByRole("tab", { name: /^OT pay/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/history\/ot-pay\?period=week/);
  await expect(tab(page, "Week")).toHaveAttribute("aria-selected", "true");
  await tab(page, "Month").click();
  await expect(page).toHaveURL(/period=month/);

  // the type filter and the export live on Reports, not here
  await expect(page.getByTestId("history-type")).toHaveCount(0);
  await expect(page.getByTestId("history-export")).toHaveCount(0);
});

test("Reports summarises every type, opens a type's History subtab, and offers the export", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/compensation/reports");
  await expect(heading(page, "Reports")).toBeVisible();
  await expect(page.getByTestId("reports-kpis")).toBeVisible();
  // the overview of every type, no row tables
  for (const type of TYPES) await expect(page.getByTestId(`overview-${type}`)).toBeVisible();
  await expect(page.locator('[data-testid^="report-section-"]')).toHaveCount(0);
  await expect(page.getByTestId("reports-kpi-period")).toContainText("One day");

  await tab(page, "Week").click();
  await expect(page).toHaveURL(/period=week/);
  await expect(page.getByTestId("reports-kpi-period")).toContainText("Monday to Sunday");
  await tab(page, "Month").click();
  await expect(page).toHaveURL(/period=month/);
  await expect(page.getByTestId("reports-kpi-period")).toContainText("Calendar month");

  // one type only
  await page.getByTestId("reports-type").click();
  await page.getByRole("option", { name: "Birthday leave" }).click();
  await expect(page).toHaveURL(/type=birthday/);
  await expect(page.locator('[data-testid^="overview-"]')).toHaveCount(1);
  await page.getByTestId("reports-type").click();
  await page.getByRole("option", { name: "All types" }).click();
  await expect(page.locator('[data-testid^="overview-"]')).toHaveCount(7);

  // the export is there for everyone who can read the page
  await expect(page.getByTestId("reports-export")).toBeVisible();

  // a card opens that type's History subtab, with the period
  await page.getByTestId("overview-holiday_work").click();
  await expect(page).toHaveURL(/\/history\/holiday-work\/work\?period=month/);
  await expect(page.getByTestId("report-section-holiday_work")).toBeVisible();
  await expect(tab(page, "Month")).toHaveAttribute("aria-selected", "true");
});

test("announcing a late-in window: add it, see it with who announced it, delete it", async ({ page }) => {
  await loginAsHr(page);
  const before = await readConfig(page);
  test.skip(!before.masterEnabled, "the master switch is off, so nothing can be announced");

  // The announcement has its own switch in Settings -> Compensation: put it on for this case, and back after it.
  const switchedOn = !before.windows.enabled;
  if (switchedOn) {
    const on = await api(page, "PUT", "/api/compensation/settings", { windows: { enabled: true } });
    expect(on.status).toBe(200);
  }
  const reason = `E2E rain ${Date.now()}`;
  const when = new Date(Date.now() + (5 * 60 + 30) * 60_000 + 9 * 24 * 3600_000).toISOString().slice(0, 10);
  try {
    await page.goto("/hr/compensation/compensation-leave/announcements");
    await expect(page).toHaveURL(/\/announcements\/announce$/);
    await expect(page.getByTestId("windows-off")).toHaveCount(0);
    await expect(page.getByTestId("window-submit")).toBeEnabled();

    // an incomplete form says what is missing and sends nothing
    await page.getByTestId("window-submit").click();
    await expect(page.getByTestId("windows-form")).toContainText("Enter the latest arrival time.");

    await page.getByTestId("window-date").fill(when);
    await page.getByTestId("window-time").fill("10:30");
    await page.getByTestId("window-reason").fill(reason);
    await expect(page.getByTestId("window-summary")).toContainText("may arrive up to 10:30 AM");
    await page.getByTestId("window-submit").click();

    // the form stays on Announce (ready for the next one); the list is the Announcements subtab
    await expect(page.getByTestId("window-reason")).toHaveValue("");
    await page.getByTestId("windows-nested-list").click();
    await expect(page).toHaveURL(/\/announcements\/list$/);
    const row = page.getByTestId("windows-upcoming").locator("tr", { hasText: reason });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Late-in");
    await expect(row).toContainText("Arrive up to 10:30 AM");
    await expect(row).toContainText("E2E Admin");
    await expect(row).toContainText("staff");

    // a future announcement can be deleted, after a question
    await row.getByRole("button", { name: /^Delete the announcement of/ }).click();
    await expect(page.getByTestId("window-delete-dialog")).toContainText("normal shifts again");
    await page.getByTestId("window-delete-confirm").click();
    await expect(row).toHaveCount(0);
  } finally {
    // leave nothing behind: any announcement of this case that is still there, and the switch as it was
    const list = (await api(page, "GET", "/api/compensation/windows?kind=all")).body as {
      results: { id: number; reason: string | null }[];
    };
    for (const w of list.results.filter((r) => r.reason === reason)) {
      await api(page, "DELETE", `/api/compensation/windows/${w.id}`);
    }
    if (switchedOn) await api(page, "PUT", "/api/compensation/settings", { windows: { enabled: false } });
  }
});
