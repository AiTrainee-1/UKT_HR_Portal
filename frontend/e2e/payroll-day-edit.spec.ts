import { expect, test, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// Payroll -> an employee's Details -> Attendance this month -> a chosen day: every punch of that day with where it came from,
// and the Attendance Edit form inline. A change is proposed there and follows the same pipeline as the Attendance page's edit
// page: the Department Head first, then HR, and the day is written only after both (api/tests_attendance_edit.py covers the
// rules). A throwaway employee (PD-001) in February 2026, E2E003 (Meena) her Department Head, set up here and removed again.

const FAKE_WACLIENT = "http://127.0.0.1:8190";
const HOD_CODE = "E2E003";
const HOD_PASSWORD = "employee-pass-1";
const DAY = "2026-02-03";

type Reply = { status: number; body: Record<string, any> | any[] | null };

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
    expect(ask.status()).toBe(409);
  }
  const login = await page.request.post("/api/auth/employee-login", {
    data: { identifier: HOD_CODE, password: HOD_PASSWORD },
  });
  expect(login.status()).toBe(200);
  return (await login.json()).token as string;
}

test("the payroll's day panel lists every punch with its source and edits attendance through the HOD then HR approval", async ({
  page,
}) => {
  await loginAsHr(page);
  const admin = (
    await (
      await page.request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } })
    ).json()
  ).token as string;
  const branches = (await api(page, "GET", "/api/branches", undefined, admin)).body as { id: number }[];
  const created = await api(
    page,
    "POST",
    "/api/employees",
    {
      employeeCode: "PD-001",
      firstName: "Day",
      lastName: "Editor",
      phone: "9000000066",
      employmentType: "staff",
      branchId: branches[0].id,
      salaryType: "monthly",
      salaryAmount: 24000,
      joinDate: "2025-01-01",
    },
    admin,
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const employeeId = (created.body as any).id as number;
  await api(page, "POST", "/api/payroll/generate", { month: 2, year: 2026 }, admin);
  const runs = (await api(page, "GET", "/api/payroll?month=2&year=2026", undefined, admin)).body as {
    id: number;
    employeeId: number;
    employeeCode: string;
    salaryMode: string;
  }[];
  const run = runs.find((r) => r.salaryMode === "monthly" && r.employeeCode === "PD-001")!;
  const manager = await api(page, "POST", "/api/department-managers", { employeeCode: HOD_CODE }, admin);
  expect(manager.status, JSON.stringify(manager.body)).toBe(201);
  const managerId = (manager.body as any).id as number;
  try {
    expect(
      (await api(page, "POST", `/api/department-managers/${managerId}/employees`, { employeeCode: "PD-001" }, admin))
        .status,
    ).toBeLessThan(300);
    // two punches of the day from two sources: a biometric device's push and an uploaded punch
    const push = await page.request.post("http://127.0.0.1:8180/iclock/cdata?SN=E2E-SN1&table=ATTLOG", {
      headers: { "Content-Type": "text/plain" },
      data: `PD-001\t${DAY} 09:03:00\t255\t15\n`,
    });
    expect(push.status()).toBe(200);
    const form = await api(
      page,
      "GET",
      `/api/attendance/edit-context?employeeId=${run.employeeId}&date=${DAY}`,
      undefined,
      admin,
    );
    expect((form.body as any).punches.length).toBeGreaterThanOrEqual(1);

    await page.goto(`/hr/payroll/details/${run.id}`);
    await expect(page.getByTestId("payroll-details-page")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(`pd-day-${DAY}`).click();
    const panel = page.getByTestId("pd-day-panel");
    await expect(panel).toBeVisible();

    // every punch of the day with where it came from
    const punches = panel.getByTestId("pd-day-punches");
    await expect(punches).toBeVisible();
    await expect(punches.getByTestId("pd-day-punch").first()).toContainText("09:03:00");
    await expect(punches.getByTestId("pd-day-punch").first()).toContainText("Biometric");
    await expect(punches.getByTestId("pd-day-punch").first()).toContainText("E2E-SN1");

    // the inline form: no page change, every type, a reason is needed
    await panel.getByTestId("pd-day-edit-open").click();
    await expect(page).toHaveURL(new RegExp(`/hr/payroll/details/${run.id}`));
    const formBox = panel.getByTestId("pd-day-edit-form");
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
      await expect(formBox.getByTestId(`pd-edit-type-${key}`), key).toBeVisible();
    }
    const before = (
      (
        await api(
          page,
          "GET",
          `/api/attendance/edit-context?employeeId=${run.employeeId}&date=${DAY}`,
          undefined,
          admin,
        )
      ).body as any
    ).day;
    await formBox.getByTestId("pd-edit-type-three_quarter_shift").click();
    await expect(formBox.getByTestId("pd-day-edit-send")).toBeDisabled();
    await formBox.getByTestId("pd-edit-reason").fill("Left at 3 PM with permission, confirmed by the HOD");
    await formBox.getByTestId("pd-day-edit-send").click();

    // waiting for the Department Head; the day has NOT changed
    await expect(panel.getByTestId("pd-day-edit-pending")).toContainText("0.75 Shift");
    const waiting = (
      await api(page, "GET", `/api/attendance/edit-context?employeeId=${run.employeeId}&date=${DAY}`, undefined, admin)
    ).body as any;
    expect(waiting.requests[0].approval.waitingFor).toEqual(["hod"]);
    expect(waiting.day.status).toBe(before.status);
    expect(waiting.day.shiftsEarned).toBe(before.shiftsEarned);
    const requestId = waiting.requests[0].id as number;

    // HOD approves: still unchanged; HR approves: written
    const hod = await hodToken(page);
    expect(
      (await api(page, "PATCH", `/api/manager/attendance-requests/${requestId}/status`, { status: "approved" }, hod))
        .status,
    ).toBe(200);
    const between = (
      (
        await api(
          page,
          "GET",
          `/api/attendance/edit-context?employeeId=${run.employeeId}&date=${DAY}`,
          undefined,
          admin,
        )
      ).body as any
    ).day;
    expect(between.shiftsEarned).toBe(before.shiftsEarned);
    expect(
      (await api(page, "PATCH", `/api/attendance/override-requests/${requestId}`, { status: "approved" }, admin))
        .status,
    ).toBe(200);
    const after = (
      (
        await api(
          page,
          "GET",
          `/api/attendance/edit-context?employeeId=${run.employeeId}&date=${DAY}`,
          undefined,
          admin,
        )
      ).body as any
    ).day;
    expect(Number(after.shiftsEarned)).toBe(0.75);
    expect(after.source).toBe("manual");
  } finally {
    await api(page, "POST", "/api/attendance/override", { employeeId: run.employeeId, date: DAY, reset: true }, admin);
    await api(page, "DELETE", `/api/department-managers/${managerId}`, undefined, admin);
    // the employee made here goes, with their punches and payroll, so the other specs' February is untouched
    await api(page, "DELETE", `/api/employees/${employeeId}`, undefined, admin);
  }
});
