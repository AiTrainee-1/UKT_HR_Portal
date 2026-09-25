import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Local calendar date, the same way the page reads "today".
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const punch = (time: string, type: "IN" | "OUT", sourceLabel = "Biometric") => ({
  time,
  type,
  source: sourceLabel,
  sourceLabel,
});

function day(date: string, over: Record<string, unknown> = {}) {
  return {
    date,
    status: "present",
    isLate: false,
    isHalfShift: false,
    totalPunches: 0,
    punches: [],
    casualLeave: null,
    leave: null,
    permission: null,
    ...over,
  };
}

// One employee, seven varied days, whatever period the page asks for.
async function mockEmployeeWeek(page: Page) {
  await page.route(/\/api\/attendance\/search\?query=/, (route) =>
    route.fulfill({
      json: {
        date: today(),
        query: "E2E001",
        count: 1,
        results: [
          {
            employeeId: 1,
            employeeCode: "E2E001",
            employeeName: "Asha Kumar",
            department: "Stitching",
            designation: "Operator",
            shift: null,
            punches: [],
            totalPunches: 0,
          },
        ],
      },
    }),
  );
  await page.route(/\/api\/attendance\/search\/range\?/, (route) =>
    route.fulfill({
      json: {
        employeeId: 1,
        employeeCode: "E2E001",
        employeeName: "Asha Kumar",
        department: "Stitching",
        designation: "Operator",
        shift: { name: "General Shift", startTime: "08:30:00", endTime: "17:30:00", gracePeriodMinutes: 10 },
        startDate: "2026-02-02",
        endDate: today(),
        days: [
          day("2026-02-02", {
            punches: [punch("08:32:00", "IN"), null, null, punch("17:37:00", "OUT")],
            totalPunches: 2,
          }),
          day("2026-02-03", {
            isLate: true,
            lateAfternoon: true,
            permissionMorning: true,
            permissionAfternoon: true,
            punches: [
              punch("09:20:00", "IN", "Geo Punch"),
              punch("13:00:00", "OUT"),
              punch("14:00:00", "IN"),
              punch("18:00:00", "OUT"),
            ],
            totalPunches: 4,
          }),
          day("2026-02-04", { status: "half_shift", isHalfShift: true, permissionEscalatedToHalfShift: true }),
          day("2026-02-05", { status: "absent" }),
          day("2026-02-06", {
            status: "on_leave",
            casualLeave: { status: "approved", reason: "Family function" },
          }),
          day("2026-02-07", { status: "holiday" }),
          day(today(), { punches: [punch("08:29:00", "IN"), null, null, null], totalPunches: 1 }),
        ],
      },
    }),
  );
}

test("finds an employee, and keeps them chosen while the period changes", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/attendance/search");

  // Refresh sits in the title row, once, with no strip above it.
  await expect(page.getByRole("heading", { name: "Attendance Search" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^\s*Refresh( this page)?\s*$/ })).toHaveCount(1);
  await expect(page.getByTestId("page-refresh-bar")).toHaveCount(0);
  const title = await page.getByRole("heading", { name: "Attendance Search" }).boundingBox();
  const refresh = await page.getByRole("button", { name: /^\s*Refresh( this page)?\s*$/ }).boundingBox();
  expect(title && refresh && Math.abs(refresh.y - title.y) < 45).toBe(true);

  await expect(page.getByTestId("attendance-search-intro")).toBeVisible();

  // One clear match opens straight onto the person.
  const search = page.getByTestId("attendance-search-input");
  await search.fill("E2E001");
  const card = page.getByTestId("attendance-employee-card");
  await expect(card).toContainText("Asha Kumar");
  await expect(card).toContainText("E2E001");
  await expect(card).toContainText("Stitching");
  await expect(page.getByTestId("attendance-day-row")).toHaveCount(1); // today
  await expect(page.getByTestId("attendance-summary")).toHaveCount(0); // nothing to summarise for one day

  // A month of her records: February 2026 is seeded with Asha present on all 24 working days.
  await page.getByRole("tab", { name: "Month" }).click();
  await page.getByLabel("Month").fill("2026-02");
  await expect(page.getByTestId("attendance-day-row")).toHaveCount(28);
  await expect(page.getByTestId("attendance-summary")).toContainText(/Present\s*24/);
  await expect(page.getByTestId("attendance-period-label")).toContainText("2026");

  // Jump to a day from the strip.
  await page.getByTestId("attendance-summary").getByRole("button").nth(19).click();
  await expect(page.locator("#day-2026-02-20")).toBeInViewport();

  // Clearing goes back to the start.
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByTestId("attendance-search-intro")).toBeVisible();
});

test("several matches: pick one, change the period, they stay picked", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/attendance/search");

  await page.getByTestId("attendance-search-input").fill("E2E00");
  const options = page.getByTestId("attendance-employee-option");
  await expect(options).toHaveCount(3);

  await options.filter({ hasText: "Ravi Nair" }).click();
  const card = page.getByTestId("attendance-employee-card");
  await expect(card).toContainText("Ravi Nair");

  // Changing the period used to send you back to the list; it must not.
  await page.getByRole("button", { name: "Last week" }).click();
  await expect(card).toContainText("Ravi Nair");
  await expect(page.getByRole("button", { name: "Last week" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("attendance-day-row")).toHaveCount(7);

  await page.getByRole("button", { name: "Change employee" }).click();
  await expect(options).toHaveCount(3);

  // Nobody matches.
  await page.getByTestId("attendance-search-input").fill("zzzzqq");
  await expect(page.getByText(/No employee matches/)).toBeVisible();
});

test("each day shows its punches, flags and reasons, and 'Issues only' narrows the list", async ({ page }) => {
  await loginAsHr(page);
  await mockEmployeeWeek(page);
  await page.goto("/hr/attendance/search");
  await page.getByTestId("attendance-search-input").fill("E2E001");

  const card = page.getByTestId("attendance-employee-card");
  await expect(card).toContainText("General Shift");
  await expect(card).toContainText("08:30–17:30");
  await expect(card).toContainText("10 min grace");

  const rows = page.getByTestId("attendance-day-row");
  await expect(rows).toHaveCount(7);

  const steady = page.locator("#day-2026-02-02");
  await expect(steady).toContainText("08:32");
  await expect(steady).toContainText("17:37");
  await expect(steady).toContainText("9h 05m");

  const late = page.locator("#day-2026-02-03");
  await expect(late).toContainText("Late");
  await expect(late).toContainText("after lunch");
  await expect(late).toContainText("Auto permission");
  await expect(late).toContainText("Morning + Afternoon");
  await expect(late).toContainText("Geo Punch");
  await expect(late).toContainText("8h 40m");

  await expect(page.locator("#day-2026-02-04")).toContainText("Permission limit reached");
  await expect(page.locator("#day-2026-02-05")).toContainText("No punches recorded");
  await expect(page.locator("#day-2026-02-06")).toContainText("Casual leave");
  await expect(page.locator("#day-2026-02-06")).toContainText("Family function");

  // Today is marked, and one punch alone has no span to show.
  const now = page.locator(`#day-${today()}`);
  await expect(now).toContainText("Today");
  await expect(now).not.toContainText(/\d+h \d\dm/);

  // Late, half shift and absent are the three days worth a second look.
  await expect(page.getByTestId("attendance-summary")).toContainText(/Late\s*1/);
  const issues = page.getByRole("button", { name: /Issues only/ });
  await expect(issues).toContainText("3");
  await issues.click();
  await expect(rows).toHaveCount(3);
  await expect(page.locator("#day-2026-02-02")).toHaveCount(0);

  // Picking a day from the strip brings the list back so the day can be shown.
  await page
    .getByRole("button", { name: /Mon.*02.*Present/ })
    .first()
    .click();
  await expect(issues).toHaveAttribute("aria-pressed", "false");
  await expect(rows).toHaveCount(7);
  await expect(page.locator("#day-2026-02-02")).toBeInViewport();
});

test("a range the server would refuse is explained instead of failing", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/attendance/search");
  await page.getByTestId("attendance-search-input").fill("E2E001");
  await expect(page.getByTestId("attendance-employee-card")).toBeVisible();

  const asked: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/attendance/search/range")) asked.push(req.url());
  });

  await page.getByRole("tab", { name: "Custom" }).click();
  await page.getByLabel("From").fill("2025-01-01");
  await expect(page.getByText(/That's \d+ days/)).toBeVisible();
  await expect(page.getByText(/up to 100/)).toBeVisible();
  expect(asked.filter((u) => u.includes("startDate=2025-01-01"))).toHaveLength(0);

  // Back to a sensible range and the records return.
  await page.getByRole("button", { name: "This week" }).click();
  await expect(page.getByTestId("attendance-employee-card")).toBeVisible();
});

test("a failed lookup offers another try", async ({ page }) => {
  await loginAsHr(page);
  await page.route(/\/api\/attendance\/search\?query=/, (route) =>
    route.fulfill({ status: 500, json: { error: "boom" } }),
  );
  await page.goto("/hr/attendance/search");
  await page.getByTestId("attendance-search-input").fill("E2E001");
  await expect(page.getByText("Couldn't search right now")).toBeVisible();

  await page.unroute(/\/api\/attendance\/search\?query=/);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("attendance-employee-card")).toContainText("Asha Kumar");
});
