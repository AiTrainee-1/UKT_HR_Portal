import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Settings -> Production Shifts against the real backend (backend/api/production_shift_rules_views.py): the owner's default
// timings (Day from 8:30, Night from 9:00 PM, Sunday, the five unpaid breaks, a 5-minute grace) as the migration seeds them,
// the "Try a day" box (the server's own calculation, never the form), a save after the question, the past-date warning,
// the 390 px layout, and the read-only summary that replaced the old editor in Manage Shifts.
//
// The backend is built in parallel with the screen: while GET /api/production-shift-rules answers 404 every case here is
// SKIPPED (not failed). Whatever a case changes it puts back, through the API, before it ends.

const PATH = "/api/production-shift-rules";

test.describe.configure({ mode: "serial" });

type Doc = Record<string, unknown> & {
  graceMinutes: number;
  effectiveFrom: string;
  groups: { id: number; kind: string; label: string; rules: { id: number; outTime: string; shiftValue: number }[] }[];
  breaks: unknown[];
};

async function hrToken(page: Page) {
  return page.evaluate(() => localStorage.getItem("uk_textile_token"));
}

async function api(page: Page, method: string, url: string, data?: unknown) {
  const res = await page.request.fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await hrToken(page)}` },
    data,
  });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

/** Sign in, and skip the case while the endpoint does not exist yet. Returns the rules as they were (to put back). */
async function ready(page: Page): Promise<Doc> {
  await loginAsHr(page);
  const probe = await api(page, "GET", PATH);
  test.skip(probe.status === 404, "GET /api/production-shift-rules is not built yet");
  expect(probe.status, "the rules can be read").toBe(200);
  return probe.body as Doc;
}

/** A saved document as a save sends it: without the keys the server only reports. */
function asSave(doc: Doc) {
  const { updatedAt: _a, updatedBy: _b, warnings: _w, legacy: _l, ...rest } = doc as Record<string, unknown>;
  return rest;
}

async function putBack(page: Page, original: Doc) {
  const res = await api(page, "PUT", PATH, asSave(original));
  expect(res.status, "the rules are put back as they were").toBe(200);
}

/** Today in India (the factory's own time), YYYY-MM-DD. */
const istToday = () => new Date(Date.now() + (5 * 60 + 30) * 60_000).toISOString().slice(0, 10);

/** The first date after `iso` that falls on `weekday` (0 = Sunday ... 6 = Saturday). */
function nextOn(iso: string, weekday: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  do {
    date.setUTCDate(date.getUTCDate() + 1);
  } while (date.getUTCDay() !== weekday);
  return date.toISOString().slice(0, 10);
}

const addDays = (iso: string, n: number) => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
};

async function openTab(page: Page) {
  await page.goto("/hr/settings?tab=production_shifts");
  await expect(page.getByTestId("production-shifts-tab")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("settings-loading")).toHaveCount(0);
}

const card = (page: Page, kind: string) => page.locator(`[data-testid="group-card"][data-kind="${kind}"]`);
const saveButton = (page: Page) => page.getByRole("button", { name: "Save Production Shift Rules" });

/** Type punches and a date into "Try a day", and wait for the server's answer to them. */
async function tryDay(page: Page, punches: string, date: string) {
  await page.locator("#production-try-punches").fill(punches);
  await page.locator("#production-try-date").fill(date);
}

test("Production Shifts sits right after Attendance and opens with the owner's defaults", async ({ page }) => {
  await ready(page);
  await openTab(page);

  const names = await page.getByRole("tab").evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()));
  expect(names.indexOf("Production Shifts")).toBe(names.indexOf("Attendance") + 1);
  await expect(page.getByRole("tab", { name: "Production Shifts", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByTestId("production-only")).toHaveText("Production employees only");

  // the switch, the start date and the 5-minute grace
  await expect(page.locator("#production-rules-switch")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#production-rules-from")).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(page.locator("#production-rules-grace")).toHaveValue("5");

  // the three groups and their ladders: the owner's table as written
  await expect(page.getByTestId("group-card")).toHaveCount(3);
  const ladder = async (kind: string) =>
    card(page, kind)
      .getByTestId("rule-row")
      .evaluateAll((rows) =>
        rows.map((row) => {
          const time = (row.querySelector('input[type="time"]') as HTMLInputElement).value;
          const next = (row.querySelector('input[type="checkbox"]') as HTMLInputElement).checked;
          const shifts = (row.querySelector('input[aria-label$="shifts"]') as HTMLInputElement).value;
          return `${time}${next ? "+1" : ""}=${Number(shifts)}`;
        }),
      );
  expect(await ladder("day")).toEqual([
    "10:30=0.25",
    "12:45=0.5",
    "15:30=0.75",
    "17:45=1",
    "20:00=1.5",
    "22:30=2",
    "00:30+1=2.5",
    "05:30+1=3",
  ]);
  expect(await ladder("night")).toEqual(["00:00+1=0.5", "05:30+1=1.5"]);
  expect(await ladder("sunday")).toEqual(["17:00=1"]);
  await expect(card(page, "day").getByLabel(/: start time$/)).toHaveValue("08:30");
  await expect(card(page, "night").getByLabel(/: start time$/)).toHaveValue("21:00");
  await expect(card(page, "sunday").getByLabel(/: start time$/)).toHaveValue("08:30");

  // the five unpaid breaks
  const breaks = await page.getByTestId("break-row").evaluateAll((rows) =>
    rows.map((r) =>
      Array.from(r.querySelectorAll('input[type="time"]'))
        .map((i) => (i as HTMLInputElement).value)
        .join("-"),
    ),
  );
  expect(breaks).toEqual(["10:30-10:45", "12:45-13:30", "15:30-15:45", "17:45-18:00", "20:00-21:00"]);

  // the two rows the owner has not confirmed are marked, and so is Sunday after 5:00 PM
  await expect(page.getByTestId("unverified-banner")).toContainText("Check these 2 rows with HR");
  await expect(page.getByTestId("unverified-row")).toHaveCount(2);
  await expect(page.getByTestId("sunday-note")).toContainText("Nothing was given for Sunday work after 5:00 PM");

  // nothing to save yet
  await expect(page.getByTestId("save-bar")).toHaveAttribute("data-dirty", "false");
  await expect(saveButton(page)).toBeDisabled();
});

test("Try a day works the owner's examples out as the table says", async ({ page }) => {
  await ready(page);
  await openTab(page);
  // a Wednesday after today: the rules apply from the day they were set up, so a later day is always judged by them
  const wednesday = nextOn(istToday(), 3);
  const answer = page.getByTestId("try-answer");
  const shifts = page.getByTestId("try-shifts");
  const group = page.getByTestId("try-group");

  await tryDay(page, "08:30 12:45 13:30 20:00", wednesday);
  await expect(shifts).toContainText("1.50 shifts", { timeout: 15_000 });
  await expect(group).toContainText(/day/i);

  // works until 10:30 PM instead of leaving at 8:00 PM
  await tryDay(page, "08:30 12:45 13:30 22:30", wednesday);
  await expect(shifts).toContainText("2.00 shifts");

  // a day, then the full night (the 5:30 AM punch is the next morning)
  await tryDay(page, "08:30 12:45 13:30 20:00 21:00 05:30", wednesday);
  await expect(shifts).toContainText("3.00 shifts");

  // the night shift alone: 9:00 PM to 5:30 AM
  await tryDay(page, "21:00 05:30", wednesday);
  await expect(shifts).toContainText("1.50 shifts");
  await expect(group).toContainText(/night/i);

  // the grace: leaving at 5:42 PM with 5 minutes' grace earns what 5:45 PM earns
  await tryDay(page, "08:30 12:45 13:30 17:42", wednesday);
  await expect(shifts).toContainText("1.00 shift");

  // a late first punch and an early departure are flagged
  await tryDay(page, "09:10 12:45 13:30 20:00", wednesday);
  await expect(page.getByTestId("try-late")).toContainText("Yes");
  await tryDay(page, "08:30 12:45 13:30 18:00", wednesday);
  await expect(page.getByTestId("try-early")).toContainText("Yes");

  // Sunday has a group of its own: 8:30 AM to 5:00 PM is one shift
  await page.getByTestId("try-sample-sunday").click();
  await expect(page.getByTestId("try-weekday")).toHaveText("Sunday");
  await expect(group).toContainText(/sunday/i);
  await expect(shifts).toContainText("1.00 shift");
  await expect(answer).toBeVisible();

  // punches it cannot read are said, not sent
  await page.locator("#production-try-punches").fill("08:30 soon");
  await expect(page.getByTestId("try-parse-error")).toContainText('"soon" is not a time');
});

test("changing the grace asks first, saves, and survives a reload", async ({ page }) => {
  const original = await ready(page);
  try {
    await openTab(page);
    await page.locator("#production-rules-grace").fill("7");
    await expect(saveButton(page)).toBeEnabled();
    await saveButton(page).click();

    const dialog = page.getByTestId("confirm-production-shifts");
    await expect(dialog).toContainText("Save these production shift rules?");
    await expect(dialog).toContainText("Grace");
    await expect(dialog).toContainText("5 min");
    await expect(dialog).toContainText("7 min");
    await expect(dialog).toContainText("Only production employees are affected");
    // nothing is saved until the question is answered
    expect(((await api(page, "GET", PATH)).body as Doc).graceMinutes).toBe(original.graceMinutes);
    await page.getByTestId("confirm-production-shifts-confirm").click();
    await expect(page.getByText("Production shift rules saved").first()).toBeVisible();
    await expect(page.getByTestId("save-bar")).toHaveAttribute("data-dirty", "false");
    expect(((await api(page, "GET", PATH)).body as Doc).graceMinutes).toBe(7);

    await page.reload();
    await expect(page.locator("#production-rules-grace")).toHaveValue("7");
    await expect(page.getByTestId("production-shifts-updated")).toContainText("Last saved");
  } finally {
    await putBack(page, original);
  }
});

test("a start date in the past is warned about, and cancelling the question saves nothing", async ({ page }) => {
  const original = await ready(page);
  await openTab(page);
  const yesterday = addDays(istToday(), -1);
  await page.locator("#production-rules-from").fill(yesterday);
  await expect(page.getByTestId("rules-from-note")).toHaveAttribute("data-kind", "past");
  await expect(page.getByTestId("rules-from-note")).toContainText("is in the past");
  await expect(page.getByTestId("rules-from-note")).toContainText("Payslips already generated are never rewritten");

  await saveButton(page).click();
  await expect(page.getByTestId("confirm-production-shifts")).toContainText(
    "is in the past: every production day from then",
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("confirm-production-shifts")).toHaveCount(0);
  expect(((await api(page, "GET", PATH)).body as Doc).effectiveFrom).toBe(original.effectiveFrom);

  // the date can be put back with one click
  await page.getByTestId("rules-from-today").click();
  await expect(page.locator("#production-rules-from")).toHaveValue(istToday());
});

test("an out-of-order ladder is stopped on screen; a row can be added to a ladder, saved, and removed again", async ({
  page,
}) => {
  const original = await ready(page);
  const puts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "PUT" && req.url().includes(PATH)) puts.push(req.url());
  });
  try {
    await openTab(page);

    // 12:45 on the fourth row of the Day ladder is not later than the row before it
    await card(page, "day")
      .getByLabel(/, row 4: leaves at$/)
      .fill("12:45");
    await expect(page.getByTestId("rule-order-error")).toContainText("Must be later than row 3");
    await expect(saveButton(page)).toBeDisabled();
    await expect(page.getByTestId("save-bar")).toContainText("Fix this first");
    expect(puts).toHaveLength(0);
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(page.getByTestId("rule-order-error")).toHaveCount(0);

    // a row added to the Sunday ladder starts an hour after the last one, earning the same
    const sunday = card(page, "sunday");
    await sunday.getByTestId("rule-add").click();
    await expect(sunday.getByTestId("rule-row")).toHaveCount(2);
    await expect(sunday.getByLabel(/, row 2: leaves at$/)).toHaveValue("18:00");
    await expect(sunday.getByLabel(/, row 2: shifts$/)).toHaveValue("1.00");
    await saveButton(page).click();
    await page.getByTestId("confirm-production-shifts-confirm").click();
    await expect(page.getByText("Production shift rules saved").first()).toBeVisible();
    const saved = (await api(page, "GET", PATH)).body as Doc;
    expect(saved.groups.find((g) => g.kind === "sunday")?.rules.map((r) => r.outTime.slice(0, 5))).toEqual([
      "17:00",
      "18:00",
    ]);

    // and the row is removed again
    await sunday.getByLabel(/^Remove .* row 2$/).click();
    await expect(sunday.getByTestId("rule-row")).toHaveCount(1);
    await saveButton(page).click();
    await page.getByTestId("confirm-production-shifts-confirm").click();
    await expect(page.getByText("Production shift rules saved").first()).toBeVisible();
    const after = (await api(page, "GET", PATH)).body as Doc;
    expect(after.groups.find((g) => g.kind === "sunday")?.rules).toHaveLength(1);
  } finally {
    await putBack(page, original);
  }
});

test("the API refuses a bad document with one plain sentence and saves nothing", async ({ page }) => {
  const original = await ready(page);
  const bad = { ...asSave(original), graceMinutes: 99 };
  const refused = await api(page, "PUT", PATH, bad);
  expect(refused.status).toBe(400);
  expect(typeof refused.body.error).toBe("string");
  expect(refused.body.error.length).toBeGreaterThan(5);
  expect(((await api(page, "GET", PATH)).body as Doc).graceMinutes).toBe(original.graceMinutes);

  // the preview reads and never writes
  const preview = await api(page, "POST", `${PATH}/preview`, {
    punches: ["08:30", "12:45", "13:30", "20:00"],
    date: nextOn(istToday(), 3),
  });
  expect(preview.status).toBe(200);
  expect(Number(preview.body.shifts)).toBeCloseTo(1.5, 2);
  expect(((await api(page, "GET", PATH)).body as Doc).updatedAt).toBe(original.updatedAt);
});

test("the tab works at 390 px: no sideways scroll, and every control of a ladder row is in view", async ({ page }) => {
  await ready(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openTab(page);
  for (const id of [
    "production-shifts-when",
    "production-shifts-groups",
    "production-shifts-breaks",
    "production-shifts-advanced",
    "production-shifts-try",
  ]) {
    await page.getByTestId(id).scrollIntoViewIfNeeded();
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(wide, `${id}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
  }
  const row = card(page, "day").getByTestId("rule-row").first();
  await row.scrollIntoViewIfNeeded();
  for (const control of [
    row.getByRole("switch"),
    row.locator('input[type="text"]').first(),
    row.locator('input[type="time"]'),
    row.locator('input[type="checkbox"]'),
    row.locator('input[aria-label$="shifts"]'),
    row.getByRole("button", { name: /^Remove / }),
  ]) {
    const box = await control.boundingBox();
    expect(box, "the control is drawn").not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
  // a break row and the calculator too
  const breakRow = page.getByTestId("break-row").first();
  await breakRow.scrollIntoViewIfNeeded();
  const to = await breakRow.locator('input[type="time"]').nth(1).boundingBox();
  expect(to!.x + to!.width).toBeLessThanOrEqual(390);
  await page.locator("#production-try-punches").scrollIntoViewIfNeeded();
  const punches = await page.locator("#production-try-punches").boundingBox();
  expect(punches!.x + punches!.width).toBeLessThanOrEqual(390);
});

test("the controls can be reached with the keyboard and say what they are", async ({ page }) => {
  await ready(page);
  await openTab(page);
  // every control is named
  const unnamed = await page
    .locator(
      '[data-testid="production-shifts-tab"] input:not([type="hidden"]), [data-testid="production-shifts-tab"] select, [data-testid="production-shifts-tab"] [role="switch"]',
    )
    .evaluateAll((els) =>
      els
        .filter((el) => {
          const input = el as HTMLInputElement;
          return !el.getAttribute("aria-label") && !(input.labels && input.labels.length > 0);
        })
        .map((el) => el.outerHTML.slice(0, 100)),
    );
  expect(unnamed).toEqual([]);
  // a ladder row's controls come in reading order (in use, name, leaves at, next day, shifts, remove), so Tab follows the eye
  const first = card(page, "day").getByTestId("rule-row").first();
  const order = await first
    .locator("[aria-label]")
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
  expect(order.slice(0, 5).map((l) => l.replace(/^.*row 1: /, ""))).toEqual([
    "in use",
    "name",
    "leaves at",
    "next day",
    "shifts",
  ]);
  expect(order[5]).toMatch(/^Remove .* row 1$/);
  // and a switch works from the keyboard: Space turns the row off, Space again turns it back on
  const toggle = first.getByRole("switch");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("save-bar")).toHaveAttribute("data-dirty", "true");
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("save-bar")).toHaveAttribute("data-dirty", "false");
});

test("Manage Shifts shows a read-only summary of the rules instead of the old editor, with a link to Settings", async ({
  page,
}) => {
  await ready(page);
  await page.goto("/hr/shifts");
  await page.getByTestId("type-chip-production").click();
  const summary = page.getByTestId("production-rules-summary");
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("Production shift rules");
  await expect(page.getByTestId("production-rules-summary-groups")).toContainText(/day/i);
  await expect(page.getByRole("button", { name: "Save Punch Times" })).toHaveCount(0);
  await expect(page.getByText("Shift-Value Segments")).toHaveCount(0);
  await page.getByTestId("production-rules-edit-link").click();
  await expect(page).toHaveURL(/\/hr\/settings\?tab=production_shifts/);
  await expect(page.getByTestId("production-shifts-tab")).toBeVisible();
});

test("the page's search and addresses take you to the production shift settings", async ({ page }) => {
  await ready(page);
  await page.goto("/hr/settings");
  const search = page.getByRole("combobox", { name: "Find a setting" });
  await search.fill("night shift");
  const hit = page.getByTestId("settings-search-hit-production_shifts-shift-groups");
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page.getByRole("tab", { name: "Production Shifts", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page).toHaveURL(/tab=production_shifts/);
  await expect(page.locator('[data-setting-id="shift-groups"]')).toBeInViewport({ timeout: 15_000 });

  await page.goto("/hr/settings?tab=production_shifts#breaks");
  await expect(page.locator('[data-setting-id="breaks"]')).toBeInViewport({ timeout: 15_000 });
  await expect(page.locator('[data-setting-id="breaks"]')).toHaveClass(/setting-flash/);
});
