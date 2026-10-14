import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// The Compensation page is mandatory. Settings -> Payroll -> OT / Compensation switches the background OT and
// Compensation FEATURES (after a confirmation); it must never hide the page or leave it unable to load.

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
// (the Settings page also links to Compensation from its headings: the sidebar is the <aside>)
const sidebarLink = (page: Page) =>
  page.getByRole("complementary").getByRole("link", { name: "Compensation", exact: true });

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

test("Compensation is in the sidebar and opens with all four tabs", async ({ page }) => {
  await loginAsHr(page);
  await expect(sidebarLink(page)).toBeVisible();
  await sidebarLink(page).click();
  await expect(page).toHaveURL(/\/hr\/compensation/);
  await expect(page.getByRole("heading", { name: "Compensation", exact: true })).toBeVisible();
  for (const name of ["CTC Breakdown", "OT Detection", "Compensation Leave", "History & Reports"]) {
    await expect(tab(page, name)).toBeVisible();
  }
  await expect(page.getByTestId("compensation-features-off")).toHaveCount(0);
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

  // The sidebar entry is still there, the page opens, and says what is paused.
  await expect(sidebarLink(page)).toBeVisible();
  await sidebarLink(page).click();
  await expect(page).toHaveURL(/\/hr\/compensation/);
  await expect(page.getByRole("heading", { name: "Compensation", exact: true })).toBeVisible();
  const notice = page.getByTestId("compensation-features-off");
  await expect(notice).toContainText("The OT and Compensation features are switched off");
  await expect(notice).toContainText("This page and every record on it stay available");

  // Reading works on every tab (no 403 message, no empty "disabled" screen).
  await expect(page.getByText("Compensation feature is currently disabled")).toHaveCount(0);
  for (const name of ["CTC Breakdown", "OT Detection", "Compensation Leave", "History & Reports"]) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
  }
  await tab(page, "CTC Breakdown").click();
  await expect(page.getByText("E2E001").first()).toBeVisible();

  // Assign / announce / redeem are paused, with the reason on the button.
  await tab(page, "OT Detection").click();
  const assign = page.getByTestId("ot2-assign");
  await expect(assign).toBeDisabled();
  await expect(assign).toHaveAttribute("title", /switched off in Settings/);
  await tab(page, "Compensation Leave").click();
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

  await sidebarLink(page).click();
  await expect(page.getByRole("heading", { name: "Compensation", exact: true })).toBeVisible();
  await expect(page.getByTestId("compensation-features-off")).toHaveCount(0);
  await tab(page, "Compensation Leave").click();
  // The master pause is lifted (the button can still be paused by the feature's own switch on Settings -> Compensation,
  // which says so in its title, but no longer by the master switch).
  await expect(page.getByTestId("window-submit")).not.toHaveAttribute("title", /Settings → Payroll/);
});

test("the Requests hub link opens Compensation Leave on Sunday / holiday work", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/compensation?tab=leave&sub=holiday-work");
  await expect(tab(page, "Compensation Leave")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("holiday-part")).toBeVisible();
  await expect(page.getByTestId("claim-form")).toBeVisible();
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

test("OT Detection keeps Type 1 and Type 2 in two separate lists, under the tiles", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/compensation?tab=ot");
  await expect(tab(page, "OT Detection")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("ot-kpis")).toBeVisible();
  for (const tile of ["earned", "used", "waiting", "assigned", "rejected"]) {
    await expect(page.getByTestId(`ot-kpi-${tile}`)).toBeVisible();
  }
  const type1 = page.getByTestId("ot-type1");
  const type2 = page.getByTestId("ot-type2");
  await expect(type1).toContainText("Type 1");
  await expect(type1).toContainText("Automatic and unpaid");
  await expect(type2).toContainText("Type 2");
  // Type 1 is read-only: nothing to tick, assign or reject inside it
  await expect(type1.getByRole("checkbox")).toHaveCount(0);
  await expect(type1.getByRole("button", { name: /assign|reject|announce/i })).toHaveCount(0);
  // Type 2 has Assign and Reject, with nothing selected yet
  await expect(page.getByTestId("ot2-assign")).toBeDisabled();
  await expect(page.getByTestId("ot2-reject")).toBeDisabled();
  // the month is a control of the page, and the address remembers it
  await page.getByTestId("ot-month").click();
  await page.getByRole("option", { name: "January" }).click();
  await expect(page).toHaveURL(/month=1(&|$)/);
  await expect(page.getByTestId("ot-kpis")).toBeVisible();
});

test("OT Detection says which of its features are switched off in Settings, and links to the switch", async ({
  page,
}) => {
  await loginAsHr(page);
  const config = await readConfig(page);
  await page.goto("/hr/compensation?tab=ot");
  await expect(page.getByTestId("ot-kpis")).toBeVisible();
  const m = config.masterEnabled;
  await expect(page.getByTestId("ot-type1-off")).toHaveCount(offCount(m, config.allowance.enabled));
  await expect(page.getByTestId("ot-type2-off")).toHaveCount(offCount(m, config.shift.enabled));
  await expect(page.getByTestId("ot-modes-off")).toHaveCount(
    m && config.shift.enabled && !config.shift.relaxationEnabled && !config.shift.payEnabled ? 1 : 0,
  );
  if (m && !config.allowance.enabled) {
    await page
      .getByTestId("ot-type1-off")
      .getByRole("link", { name: /Settings → Compensation/ })
      .click();
    await expect(page).toHaveURL(/\/hr\/settings\?tab=compensation/);
    await expect(page.getByTestId("compensation-tab")).toBeVisible();
  }
});

test("Compensation Leave has three parts, each with its own notice for its own switch", async ({ page }) => {
  await loginAsHr(page);
  const config = await readConfig(page);
  const m = config.masterEnabled;
  await page.goto("/hr/compensation?tab=leave");
  await expect(tab(page, "Compensation Leave")).toHaveAttribute("aria-selected", "true");
  const part = (name: RegExp) => page.getByRole("tab", { name });

  // A. announce late-in / early-out (the first part, so a bare address opens it)
  await expect(part(/^A\. Announce late-in \/ early-out/)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("windows-part")).toBeVisible();
  await expect(page.getByTestId("windows-form")).toContainText("Announce late-in / early-out");
  await expect(page.getByTestId("windows-off")).toHaveCount(offCount(m, config.windows.enabled));
  await expect(page.getByTestId("window-submit")).toHaveText("Add announcement");

  // B. work on Sundays and company holidays, with the compensation balance
  await part(/^B\. Work on Sundays and company holidays/).click();
  await expect(page).toHaveURL(/sub=holiday-work/);
  await expect(page.getByTestId("holiday-part")).toBeVisible();
  await expect(page.getByTestId("holiday-how")).toContainText("only HR raises a claim here");
  await expect(page.getByTestId("holiday-how")).toContainText("Department Head approves it in Approvals");
  await expect(page.getByTestId("holiday-off")).toHaveCount(offCount(m, config.holidayWork.enabled));
  await expect(page.getByTestId("balance-part")).toBeVisible();
  await expect(page.getByTestId("claim-list")).toBeVisible();

  // C. birthdays
  await part(/^C\. Birthdays/).click();
  await expect(page).toHaveURL(/sub=birthdays/);
  await expect(page.getByTestId("birthdays-part")).toBeVisible();
  await expect(page.getByTestId("birthday-how")).toContainText("Automatic: HR does nothing.");
  await expect(page.getByTestId("birthday-off")).toHaveCount(offCount(m, config.birthday.enabled));
  await tab(page, "Week").click();
  await expect(page).toHaveURL(/bperiod=week/);
  await expect(page.getByTestId("birthday-kpis")).toBeVisible();

  // the part is in the address: a reload lands on it again
  await page.reload();
  await expect(page.getByTestId("birthdays-part")).toBeVisible();
});

test("a date that is neither a Sunday nor a holiday cannot be claimed for, and says why", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/compensation?tab=leave&sub=holiday-work");
  await expect(page.getByTestId("claim-no-date")).toBeVisible();
  // 3 Aug 2026 is a Monday
  await page.getByTestId("claim-date").fill("2026-08-03");
  await expect(page.getByTestId("claim-not-claimable")).toContainText("neither a Sunday nor a declared holiday");
  await expect(page.getByTestId("claim-submit")).toHaveCount(0);
});

test("History & Reports shows who benefited from each type, by Today, Week and Month", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/compensation?tab=history");
  await expect(page.getByTestId("history-kpis")).toBeVisible();
  const sections = page.locator('[data-testid^="report-section-"]');
  await expect(sections).toHaveCount(7);
  for (const type of [
    "ot_allowance",
    "ot_shift_relaxation",
    "ot_shift_pay",
    "window_late_in",
    "window_early_out",
    "holiday_work",
    "birthday",
  ]) {
    await expect(page.getByTestId(`report-who-${type}`)).toBeVisible();
    await expect(page.getByTestId(`overview-${type}`)).toBeVisible();
  }
  await expect(page.getByTestId("history-kpi-period")).toContainText("One day");

  await tab(page, "Week").click();
  await expect(page).toHaveURL(/period=week/);
  await expect(page.getByTestId("history-kpi-period")).toContainText("Monday to Sunday");
  await tab(page, "Month").click();
  await expect(page).toHaveURL(/period=month/);
  await expect(page.getByTestId("history-kpi-period")).toContainText("Calendar month");

  // one type only
  await page.getByTestId("history-type").click();
  await page.getByRole("option", { name: "Birthday leave" }).click();
  await expect(page).toHaveURL(/type=birthday/);
  await expect(sections).toHaveCount(1);
  await expect(page.getByTestId("report-section-birthday")).toBeVisible();

  // the export is there for everyone who can read the page
  await expect(page.getByTestId("history-export")).toBeVisible();
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
    await page.goto("/hr/compensation?tab=leave");
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
