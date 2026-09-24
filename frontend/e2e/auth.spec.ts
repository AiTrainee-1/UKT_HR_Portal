import { expect, test } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

test.describe("HR login", () => {
  test("a wrong password is rejected and stays on the login page", async ({ page }) => {
    await page.goto("/hr-login");
    await page.getByTestId("input-username").fill(HR_USERNAME);
    await page.getByTestId("input-password").fill("not-the-password");
    await page.getByTestId("button-submit").click();
    await expect(page).toHaveURL(/\/hr-login/);
    await expect(page.getByText(/invalid/i).first()).toBeVisible();
  });

  test("valid credentials land on the dashboard and survive a reload", async ({ page }) => {
    await loginAsHr(page);
    await page.reload();
    await expect(page).toHaveURL(/\/hr\/dashboard/);
  });

  test("a protected page redirects an anonymous visitor to sign in", async ({ page }) => {
    await page.goto("/hr/payroll");
    await expect(page).not.toHaveURL(/\/hr\/payroll/);
  });

  test("the API rejects a request with no token", async ({ request }) => {
    const res = await request.get("/api/payroll");
    expect(res.status()).toBe(401);
  });
});

test.describe("employee tokens cannot reach HR data", () => {
  test("an employee can only see their own payroll and cannot open HR endpoints", async ({ request }) => {
    // First-time password setup is open by design; this employee has none yet.
    const set = await request.post("/api/auth/set-password", {
      data: { identifier: "E2E003", password: "employee-pass-1" },
    });
    // 403 only when this same test already ran against a reused database and set it.
    expect([200, 403]).toContain(set.status());

    // ...but once a password exists, it can no longer be overwritten anonymously.
    const takeover = await request.post("/api/auth/set-password", {
      data: { identifier: "E2E003", password: "attacker-pass-1" },
    });
    expect(takeover.status()).toBe(403);

    const login = await request.post("/api/auth/employee-login", {
      data: { identifier: "E2E003", password: "employee-pass-1" },
    });
    expect(login.status()).toBe(200);
    const { token } = await login.json();
    const auth = { Authorization: `Bearer ${token}` };

    expect((await request.get("/api/payroll", { headers: auth })).status()).toBe(403);
    expect((await request.get("/api/employees", { headers: auth })).status()).toBe(403);

    // Asking for a colleague's payroll (Asha is employee id != this one) returns only the caller's own.
    const asHr = await request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
    const hrHeaders = { Authorization: `Bearer ${(await asHr.json()).token}` };
    const employees = await (await request.get("/api/employees", { headers: hrHeaders })).json();
    const asha = employees.find((e: { employeeCode: string }) => e.employeeCode === "E2E001");
    const res = await request.get(`/api/salary-records?employeeId=${asha.id}`, { headers: auth });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
