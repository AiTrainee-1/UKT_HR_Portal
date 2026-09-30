import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Settings -> Attendance -> Staff -> Arrival timeline: where a morning arrival falls, measured from each shift's own
// start and grace, and what HR can change. The engine itself is covered in the backend tests; this is the page.

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const row = (page: Page, zone: string) => page.getByTestId(`arrival-preview-${zone}`);

async function openTimeline(page: Page) {
  await loginAsHr(page);
  await page.goto("/hr/settings");
  await tab(page, "Attendance").click();
  await expect(page.getByTestId("arrival-timeline")).toBeVisible();
}

async function apiSettings(page: Page) {
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  return (await (
    await page.request.get("/api/payroll-settings", { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as Record<string, number | string>;
}

test.describe.configure({ mode: "serial" });

test("the Arrival timeline opens with the agreed numbers and says what they mean for a 09:00 shift", async ({
  page,
}) => {
  await openTimeline(page);
  await expect(page.getByLabel("Late window (minutes)")).toHaveValue("60");
  await expect(page.getByLabel("Permission window (minutes)")).toHaveValue("60");
  await expect(page.getByLabel("Extra minutes", { exact: true })).toHaveValue("20");
  await expect(page.getByLabel("Quarter-shift deduction (shifts)")).toHaveValue("0.25");

  // the example shift is 09:00 with 10 minutes of grace
  await expect(row(page, "on_time")).toContainText("up to 09:10");
  await expect(row(page, "late")).toContainText("09:11 - 10:10");
  await expect(row(page, "late")).toContainText("1.00 shift");
  await expect(row(page, "excused")).toContainText("09:11 - 11:10 (with a permission)");
  await expect(row(page, "quarter")).toContainText("10:11 - 11:30");
  await expect(row(page, "quarter")).toContainText("0.75 shift");
  await expect(row(page, "second_half")).toContainText("after 11:30");
  await expect(row(page, "second_half")).toContainText("0.50 shift");

  // the old fixed First Half End time is gone; Second Half Start stays
  await expect(page.getByText("First Half End Time", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Second Half Start Time", { exact: true })).toBeVisible();
});

test("the preview follows the numbers, the example shift and Second Half Start as you type", async ({ page }) => {
  await openTimeline(page);
  await page.getByLabel("Late window (minutes)").fill("30");
  await expect(row(page, "late")).toContainText("09:11 - 09:40");
  await expect(row(page, "quarter")).toContainText("09:41 - 11:00");
  await expect(row(page, "second_half")).toContainText("after 11:00");

  await page.getByLabel("Quarter-shift deduction (shifts)").fill("0.5");
  await expect(row(page, "quarter")).toContainText("0.50 shift");

  // a different shift: the limits follow ITS start and grace
  await page.getByLabel("Shift start", { exact: true }).fill("14:00");
  await page.getByLabel("Grace (min)", { exact: true }).fill("5");
  await expect(row(page, "on_time")).toContainText("up to 14:05");
  await expect(row(page, "late")).toContainText("14:06 - 14:35");

  // a first-half limit that reaches Second Half Start is called out
  await expect(page.getByTestId("arrival-preview-warning")).toBeVisible();
  await page.getByLabel("Second Half Start Time", { exact: true }).fill("20:00");
  await expect(page.getByTestId("arrival-preview-warning")).toHaveCount(0);
});

test("a change saves and reaches the API; an invalid one is refused before anything is sent", async ({ page }) => {
  await openTimeline(page);
  await page.getByLabel("Late window (minutes)").fill("45");
  await page.getByLabel("Permission window (minutes)").fill("30");
  await page.getByLabel("Extra minutes", { exact: true }).fill("10");
  await page.getByLabel("Quarter-shift deduction (shifts)").fill("0.5");
  await page.getByRole("button", { name: "Save Attendance Settings" }).click();
  await expect(page.getByText("Attendance settings saved").first()).toBeVisible();

  let s = await apiSettings(page);
  expect([
    s.arrivalLateWindowMinutes,
    s.arrivalPermissionWindowMinutes,
    s.arrivalExtraMinutes,
    s.arrivalQuarterDeduction,
  ]).toEqual([45, 30, 10, 0.5]);
  // the retired fixed First Half End time was never sent, so it is exactly as it was
  expect(s.halfDayFirstHalfEndTime).toBe("13:30");

  await page.reload();
  await tab(page, "Attendance").click();
  await expect(page.getByLabel("Late window (minutes)")).toHaveValue("45");
  await expect(row(page, "late")).toContainText("09:11 - 09:55");

  // out of range: the message shows next to the fields and Save refuses to send it
  await page.getByLabel("Late window (minutes)").fill("300");
  await expect(page.getByTestId("arrival-error")).toContainText(
    "Late window must be a whole number of minutes between 0 and 240",
  );
  await page.getByRole("button", { name: "Save Attendance Settings" }).click();
  await expect(page.getByText("Arrival timeline is not valid").first()).toBeVisible();
  s = await apiSettings(page);
  expect(s.arrivalLateWindowMinutes).toBe(45);

  // and the server refuses it too when it is asked directly
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const refused = await page.request.put("/api/payroll-settings", {
    headers: { Authorization: `Bearer ${token}` },
    data: { arrivalQuarterDeduction: 1.5 },
  });
  expect(refused.status()).toBe(400);

  // put the agreed numbers back for everything after this
  await page.getByLabel("Late window (minutes)").fill("60");
  await page.getByLabel("Permission window (minutes)").fill("60");
  await page.getByLabel("Extra minutes", { exact: true }).fill("20");
  await page.getByLabel("Quarter-shift deduction (shifts)").fill("0.25");
  await page.getByRole("button", { name: "Save Attendance Settings" }).click();
  await expect(page.getByText("Attendance settings saved").first()).toBeVisible();
  s = await apiSettings(page);
  expect([
    s.arrivalLateWindowMinutes,
    s.arrivalPermissionWindowMinutes,
    s.arrivalExtraMinutes,
    s.arrivalQuarterDeduction,
  ]).toEqual([60, 60, 20, 0.25]);
});
