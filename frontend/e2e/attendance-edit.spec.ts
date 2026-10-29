import { expect, test } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Attendance -> Employee Attendance Search: the pencil on a day edits it AT ONCE (it used to send a request to the Department
// Head). It needs a reason, shows the day "By hand", can be handed back to the punches, and every step is in the Punch View
// History. Seeded employee E2E001 (Asha Kumar).

test("the pencil edits a day at once with a reason, and the History keeps it", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/attendance");
  const search = page.getByPlaceholder(/Employee code/);
  await search.fill("E2E001");
  await search.press("Enter");
  await expect(page.getByTitle("Edit this day").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Calculation mode")).toHaveCount(0);

  await page.getByTitle("Edit this day").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Edit Attendance")).toBeVisible();
  // every status is a button of its own, Half Day included; the times and the Late / Early Out marks belong to a day worked
  for (const status of ["present", "half_shift", "absent", "on_leave", "holiday"]) {
    await expect(dialog.getByTestId(`attendance-edit-${status}`)).toBeVisible();
  }
  await dialog.getByTestId("attendance-edit-half_shift").click();
  await expect(dialog.getByTestId("attendance-edit-first-in")).toBeVisible();
  await expect(dialog.getByTestId("attendance-edit-last-out")).toBeVisible();
  await expect(dialog.getByTestId("attendance-edit-late")).toBeVisible();
  await expect(dialog.getByTestId("attendance-edit-early-out")).toBeVisible();
  await dialog.getByTestId("attendance-edit-absent").click();
  await expect(dialog.getByTestId("attendance-edit-first-in")).toHaveCount(0);
  // a reason is needed
  await expect(dialog.getByTestId("attendance-edit-save")).toBeDisabled();
  await dialog.getByPlaceholder(/CCTV/).fill("Absent without notice, confirmed by HOD");
  await dialog.getByTestId("attendance-edit-save").click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("By hand").first()).toBeVisible();

  // hand it back to the punches
  await page.getByTitle("Revert to automatic value").first().click();
  await expect(page.getByText("By hand")).toHaveCount(0);

  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const res = await page.request.get("/api/attendance/punches/history?q=E2E001&pageSize=50", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { items: { action: string; note: string }[] };
  const set = body.items.find((i) => i.action === "status_set" && i.note.includes("confirmed by HOD"));
  expect(set, JSON.stringify(body.items.slice(0, 3))).toBeTruthy();
  expect(body.items.some((i) => i.action === "status_reset")).toBe(true);
});
