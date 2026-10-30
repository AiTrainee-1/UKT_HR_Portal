import { expect, test, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// Attendance -> the pencil on a day opens the Attendance Edit page. Every change is proposed, approved by the employee's
// Department Head first and by HR second, and the day is written only when both have approved (api/tests_attendance_edit.py
// covers the rules for every type; this is the pages and the whole path). Employee E2E001 (Asha Kumar) is the employee,
// E2E003 (Meena) her Department Head, set up here and removed again.

const FAKE_WACLIENT = "http://127.0.0.1:8190";
const HOD_CODE = "E2E003";
const HOD_PASSWORD = "employee-pass-1"; // the password auth.spec.ts and approval-screens.spec.ts also use for this account

type Reply = { status: number; body: Record<string, any> | null };

async function api(page: Page, method: string, url: string, data?: unknown, token?: string): Promise<Reply> {
  const bearer = token ?? (await page.evaluate(() => localStorage.getItem("uk_textile_token")));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${bearer}` }, data });
  const text = await res.text();
  let body: Reply["body"] = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status(), body };
}

async function hodToken(page: Page): Promise<string> {
  await page.request.post(`${FAKE_WACLIENT}/reset`);
  const ask = await page.request.post("/api/auth/otp/request", {
    data: { employeeCode: HOD_CODE, purpose: "activate" },
  });
  if (ask.status() === 200) {
    const sent = await (await page.request.get(`${FAKE_WACLIENT}/messages`)).json();
    const otp = sent[0].message.match(/\b(\d{6})\b/)![1];
    const activate = await page.request.post("/api/auth/otp/activate", {
      data: { employeeCode: HOD_CODE, otp, password: HOD_PASSWORD },
    });
    expect(activate.status()).toBe(200);
  } else {
    expect(ask.status()).toBe(409); // already activated
  }
  const login = await page.request.post("/api/auth/employee-login", {
    data: { identifier: HOD_CODE, password: HOD_PASSWORD },
  });
  expect(login.status()).toBe(200);
  return (await login.json()).token as string;
}

test("the pencil opens the Attendance Edit page; a change needs the Department Head and then HR before the day changes", async ({
  page,
}) => {
  await loginAsHr(page);
  const admin = (
    await (
      await page.request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } })
    ).json()
  ).token as string;
  const employees = (await api(page, "GET", "/api/employees?search=E2E00", undefined, admin)).body as unknown as {
    id: number;
    employeeCode: string;
  }[];
  const asha = employees.find((e) => e.employeeCode === "E2E001")!;
  const manager = await api(page, "POST", "/api/department-managers", { employeeCode: HOD_CODE }, admin);
  expect(manager.status, JSON.stringify(manager.body)).toBe(201);
  const managerId = manager.body!.id as number;
  try {
    const assign = await api(
      page,
      "POST",
      `/api/department-managers/${managerId}/employees`,
      { employeeCode: "E2E001" },
      admin,
    );
    expect(assign.status, JSON.stringify(assign.body)).toBeLessThan(300);

    // ── the pencil leads to the page, not to a dialog ──
    await page.goto("/hr/attendance");
    const search = page.getByPlaceholder(/Employee code/);
    await search.fill("E2E001");
    await search.press("Enter");
    const pencil = page.getByTitle("Edit this day").first();
    await expect(pencil).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await pencil.click();
    await expect(page).toHaveURL(new RegExp(`/hr/attendance/edit/${asha.id}/\\d{4}-\\d{2}-\\d{2}\\?back=`));
    const day = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByTestId("attendance-edit-page")).toBeVisible();

    // coming back keeps the searched employee, month and filters: nothing has to be searched again
    await page.getByRole("button", { name: "Back to Attendance" }).click();
    await expect(page).toHaveURL(/\/hr\/attendance(\/staff)?\?.*code=E2E001/);
    await expect(page.getByPlaceholder(/Employee code/)).toHaveValue("E2E001");
    await expect(page.getByTitle("Edit this day").first()).toBeVisible({ timeout: 30_000 });
    await page.getByTitle("Edit this day").first().click();
    await expect(page.getByTestId("attendance-edit-page")).toBeVisible();
    // the browser's own Back does the same
    await page.goBack();
    await expect(page.getByPlaceholder(/Employee code/)).toHaveValue("E2E001");
    await expect(page.getByTitle("Edit this day").first()).toBeVisible({ timeout: 30_000 });
    await page.getByTitle("Edit this day").first().click();
    await expect(page.getByTestId("attendance-edit-page")).toBeVisible();
    await expect(page.getByTestId("edit-approval-path")).toContainText("Meena");

    // every attendance type of the HRMS is offered
    for (const key of [
      "present",
      "half_day",
      "full_day",
      "quarter_shift",
      "three_quarter_shift",
      "compensation",
      "sunday_compensation",
      "ot_compensation",
      "absent",
      "on_leave",
      "holiday",
    ]) {
      await expect(page.getByTestId(`edit-type-${key}`), key).toBeVisible();
    }
    await expect(page.getByTestId("edit-send")).toBeDisabled();

    const before = (
      await api(page, "GET", `/api/attendance/edit-context?employeeId=${asha.id}&date=${day}`, undefined, admin)
    ).body!.day;

    // Sunday Compensation, worth half a shift
    await page.getByTestId("edit-type-sunday_compensation").click();
    await page.getByTestId("edit-shifts-0.50").click();
    await expect(page.getByTestId("edit-send")).toBeDisabled(); // a reason is needed
    await page.getByTestId("edit-reason").fill("Worked last Sunday, confirmed by the HOD");
    await page.getByTestId("edit-send").click();
    // after sending, the same employee is still on screen
    await expect(page).toHaveURL(/\/hr\/attendance(\/staff)?\?.*code=E2E001/);
    await expect(page.getByTitle("Edit this day").first()).toBeVisible({ timeout: 30_000 });

    // it is waiting for the Department Head and the day has NOT changed
    const waiting = (
      await api(page, "GET", `/api/attendance/edit-context?employeeId=${asha.id}&date=${day}`, undefined, admin)
    ).body!;
    expect(waiting.requests[0].approval.waitingFor).toEqual(["hod"]);
    expect(waiting.day.status).toBe(before.status);
    expect(waiting.day.source).toBe(before.source);

    // HR's list: nothing is waiting for HR yet; the request shows under the Department Head and cannot be approved here
    await page.goto("/hr/attendance/edit-requests");
    await expect(page.getByTestId("edit-requests-empty")).toBeVisible();
    await page.getByRole("tab", { name: /Waiting for the Department Head/ }).click();
    const requestId = waiting.requests[0].id as number;
    await expect(page.getByTestId(`edit-request-${requestId}`)).toContainText("Sunday Compensation");
    await expect(page.getByTestId(`edit-request-approve-${requestId}`)).toHaveCount(0);
    expect(
      (await api(page, "PATCH", `/api/attendance/override-requests/${requestId}`, { status: "approved" }, admin))
        .status,
    ).toBe(400);

    // the Department Head approves; the day is still unchanged and the request moves to HR
    const hod = await hodToken(page);
    const decided = await api(
      page,
      "PATCH",
      `/api/manager/attendance-requests/${requestId}/status`,
      { status: "approved" },
      hod,
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const between = (
      await api(page, "GET", `/api/attendance/edit-context?employeeId=${asha.id}&date=${day}`, undefined, admin)
    ).body!;
    expect(between.day.status).toBe(before.status);
    expect(between.requests[0].approval.waitingFor).toEqual(["hr"]);

    // HR approves from the list: only now does the day change
    await page.goto("/hr/attendance/edit-requests");
    await expect(page.getByTestId(`edit-request-${requestId}`)).toContainText("Sunday Compensation");
    await page.getByTestId(`edit-request-approve-${requestId}`).click();
    await expect(page.getByTestId("edit-requests-empty")).toBeVisible();
    const after = (
      await api(page, "GET", `/api/attendance/edit-context?employeeId=${asha.id}&date=${day}`, undefined, admin)
    ).body!;
    expect(after.day.status).toBe("present");
    expect(Number(after.day.shiftsEarned)).toBe(0.5);
    expect(after.day.source).toBe("manual");
  } finally {
    const days = (await api(page, "GET", `/api/attendance/override-requests?employeeId=${asha.id}`, undefined, admin))
      .body as unknown as {
      date: string;
    }[];
    for (const d of new Set((days ?? []).map((r) => r.date))) {
      await api(page, "POST", "/api/attendance/override", { employeeId: asha.id, date: d, reset: true }, admin);
    }
    await api(page, "DELETE", `/api/department-managers/${managerId}`, undefined, admin);
  }
});
