import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// The Staff Payroll page's insight views (dashboard, Issues, Skipped, Rules), the Salary Statement and the details page,
// all read-only explanations of the payroll the engine already stored. Data (seed_e2e.py, February 2026, 24 Mon-Sat days):
//   Asha Kumar  E2E001 - 24,000, present all 24 days -> paid 24,000 (no shift assigned, no bank details)
//   Ravi Nair   E2E002 - 30,000, present 12 days, absent 16-28 Feb (12 working days) -> paid 15,000
//   Meena       E2E003 - no salary -> skipped at generation
// Roles created here are prefixed "pi_" and removed afterwards (the server throttles sign-ins: each signs in once).

const FEB = "/hr/payroll?month=2&year=2026";
// The Payroll tab lists a table by default; the specs that look at the cards ask for them.
const FEB_CARDS = `${FEB}&layout=cards`;
const PASSWORD = "Passw0rd!pinsight";

let adminToken = "";
let viewerToken = "";
let slipOnlyToken = "";
let productionOnlyToken = "";

async function signIn(request: APIRequestContext, username: string, password: string) {
  const res = await request.post("/api/auth/hr-login", { data: { username, password } });
  expect(res.status(), `sign in as ${username}`).toBe(200);
  return (await res.json()).token as string;
}

async function api(request: APIRequestContext, token: string, method: string, url: string, data?: unknown) {
  const res = await request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function purge(request: APIRequestContext) {
  const users = (await api(request, adminToken, "GET", "/api/hr-users")).body as { id: number; username: string }[];
  for (const u of users.filter((u) => u.username.startsWith("pi_")))
    await api(request, adminToken, "DELETE", `/api/hr-users/${u.id}`);
  const roles = (await api(request, adminToken, "GET", "/api/roles")).body as { id: number; name: string }[];
  for (const r of roles.filter((r) => r.name.startsWith("pi_")))
    await api(request, adminToken, "DELETE", `/api/roles/${r.id}`);
}

async function makeRole(request: APIRequestContext, name: string, permissions: Record<string, string>) {
  const role = await api(request, adminToken, "POST", "/api/roles", { name: `pi_${name}`, permissions });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  const user = await api(request, adminToken, "POST", "/api/hr-users", {
    username: `pi_${name}`,
    password: PASSWORD,
    roleId: role.body.id,
  });
  expect(user.status, JSON.stringify(user.body)).toBe(201);
  return signIn(request, `pi_${name}`, PASSWORD);
}

async function openAs(page: Page, token: string, path: string) {
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), token);
  await page.goto(path);
}

const generateFebruary = (request: APIRequestContext) =>
  api(request, adminToken, "POST", "/api/payroll/generate", { month: 2, year: 2026 });

const card = (page: Page, name: string) => page.getByRole("article", { name: `Payroll of ${name}` });
const issueRows = (page: Page, code: string) => page.locator(`[data-testid^="issue-row-"][data-code="${code}"]`);

test.beforeAll(async ({ request }) => {
  adminToken = await signIn(request, HR_USERNAME, HR_PASSWORD);
  await purge(request);
  viewerToken = await makeRole(request, "viewer", {
    dashboard: "view",
    payroll: "view",
    salary: "view",
    salary_slip: "view",
  });
  slipOnlyToken = await makeRole(request, "slips", { dashboard: "view", salary_slip: "view" });
  productionOnlyToken = await makeRole(request, "prod", { dashboard: "view", production_payroll: "view" });
  await generateFebruary(request);
});

test.afterAll(async ({ request }) => {
  await purge(request);
});

test.describe("Issues: every detection, with the day it was detected", () => {
  test("lists each absent working day on its own date, with the details and the rule behind it", async ({ page }) => {
    await openAs(page, adminToken, `${FEB}&view=issues`);
    const absent = issueRows(page, "absent");
    // Ravi was absent from 16 Feb: 12 working days (Mon-Sat), one issue each
    await expect(absent).toHaveCount(12);
    const first = absent.first();
    await expect(first.getByTestId("issue-detected")).toContainText("Detected on Mon, 16 Feb 2026");
    await expect(first.getByTestId("issue-detail")).toContainText("No attendance recorded");
    await expect(first).toContainText("Ravi Nair");
    await expect(first.getByTestId("issue-impact")).toContainText("1 day");
    await expect(first.getByTestId("issue-rule")).toContainText("Absent");
    await expect(absent.last().getByTestId("issue-detected")).toContainText("Sat, 28 Feb 2026");
    // an absence is a routine loss-of-pay day, not a payroll fault
    await expect(first).toHaveAttribute("data-severity", "warning");
  });

  test("the date range narrows the list and lives in the address", async ({ page }) => {
    await openAs(page, adminToken, `${FEB}&view=issues&ifrom=2026-02-20&ito=2026-02-21`);
    await expect(issueRows(page, "absent")).toHaveCount(2);
    await expect(issueRows(page, "absent").first().getByTestId("issue-detected")).toContainText("Fri, 20 Feb 2026");
    // changing it by hand keeps the rest of the page's state
    await page.getByTestId("issues-from").fill("2026-02-26");
    await page.getByTestId("issues-to").fill("2026-02-26");
    await expect(issueRows(page, "absent")).toHaveCount(1);
    await expect(page).toHaveURL(/ifrom=2026-02-26/);
    await expect(page).toHaveURL(/view=issues/);
    await expect(page).toHaveURL(/month=2/);
  });

  test("the employee skipped at generation is listed as a critical issue, with how to fix it", async ({ page }) => {
    await openAs(page, adminToken, `${FEB}&view=issues`);
    const skipped = issueRows(page, "skipped");
    await expect(skipped).toHaveCount(1);
    await expect(skipped).toContainText("Meena Nosalary");
    await expect(skipped).toContainText("No Salary Amount");
    await expect(skipped.getByTestId("issue-fix")).toContainText("monthly salary");
    await expect(skipped).toHaveAttribute("data-severity", "critical");
    // the Issues view's count includes it too
    await expect(page.getByTestId("view-issues-count")).toHaveText("17");
  });

  test("an address can open the Issues view on one type, and it lists only that type", async ({ page }) => {
    await openAs(page, adminToken, `${FEB}&view=issues&icode=absent`);
    await expect(issueRows(page, "absent")).toHaveCount(12);
    await expect(issueRows(page, "bank_missing")).toHaveCount(0);
  });
});

test.describe("Rules and skipped employees", () => {
  test("the Rules view shows the rules configured in Settings and the rules assigned to each employee", async ({
    page,
  }) => {
    await openAs(page, adminToken, `${FEB}&view=rules`);
    await expect(page.getByText("Rules configured on the Settings page")).toBeVisible();
    await expect(page.getByText("Rules assigned to each employee")).toBeVisible();
    // every rule says where it is changed
    await expect(page.getByRole("link", { name: /Edit in Settings/ }).first()).toHaveAttribute(
      "href",
      /\/hr\/settings\?tab=/,
    );
    await expect(page.getByText("Asha Kumar").first()).toBeVisible();
    await expect(page.getByText("Ravi Nair").first()).toBeVisible();
  });

  test("the record cards carry each employee's rules and issue badges", async ({ page }) => {
    await openAs(page, adminToken, FEB_CARDS);
    const ravi = card(page, "Ravi Nair");
    await expect(ravi).toBeVisible();
    await expect(ravi.getByRole("list", { name: "Rules assigned to this employee" })).toBeVisible();
    await expect(ravi).toContainText("Absent ×12");
  });

  test("Skipped lists who was skipped and why, and the count follows the month", async ({ page }) => {
    await openAs(page, adminToken, `${FEB}&view=skipped`);
    await expect(page.getByText("1 of 3 employees was skipped")).toBeVisible();
    await expect(page.getByText("Meena Nosalary")).toBeVisible();
    await expect(page.getByText("No salary amount").first()).toBeVisible();
  });
});

test.describe("Salary Statement", () => {
  test("shows the printed statement for the month, grouped by department, with totals", async ({ page }) => {
    await openAs(page, adminToken, `${FEB}&tab=salary`);
    const panel = page.getByTestId("statement-panel");
    await expect(panel).toContainText("Salary Statement From 01-02-2026 To 28-02-2026", { timeout: 30_000 });
    await expect(panel).toContainText("Asha Kumar");
    await expect(panel).toContainText("Ravi Nair");
    await expect(panel).toContainText("GRAND TOTAL");
    await expect(page.getByTestId("statement-count")).toContainText("2 employees in 1 department");
    // the Pages view is the same statement as a paper preview
    await page.getByRole("tab", { name: /^Pages\b/ }).click();
    await expect(page).toHaveURL(/sview=pages/);
    await expect(panel).toContainText("Paper preview");
    await page.getByRole("tab", { name: /^Scroll\b/ }).click();
    await expect(page).not.toHaveURL(/sview=/);
  });

  test("the Excel export has the printed columns and the right figures", async ({ page }) => {
    await openAs(page, adminToken, `${FEB}&tab=salary`);
    await expect(page.getByTestId("statement-panel")).toContainText("Asha Kumar", { timeout: 30_000 });
    await page.getByTestId("statement-export").click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("statement-export-xlsx").click(),
    ]);
    expect(download.suggestedFilename()).toBe("Salary_Statement_February_2026.xlsx");
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile((await download.path())!);
    const sheet = book.worksheets[0];
    const rows: Record<string, unknown>[] = [];
    let header: string[] = [];
    sheet.eachRow((row) => {
      const cells = (row.values as unknown[]).slice(1);
      if (cells[0] === "SNO") header = cells.map((c) => String(c ?? "").split("\n")[0]);
      else if (header.length && typeof cells[0] === "number")
        rows.push(Object.fromEntries(header.map((h, i) => [h, cells[i]])));
    });
    expect(header).toEqual([
      "SNO",
      "ID NO",
      "Name",
      "Designation",
      "Basic salary",
      "Total",
      "Present",
      "CL",
      "LOP",
      "HD",
      "Total Days",
      "PTRL",
      "Others Allow",
      "E salary",
      "T.Advance",
      "Advance",
      "ESI",
      "PF",
      "TDS",
      "Others",
      "Lop& PSAmt",
      "Total Deduction",
      "NET",
      "Remarks",
    ]);
    const asha = rows.find((r) => r["ID NO"] === "E2E001")!;
    const ravi = rows.find((r) => r["ID NO"] === "E2E002")!;
    // Asha: full month, nothing lost. Ravi: salary 30,000, 12 of 24 days -> E salary 15,000, 12 days of LOP
    expect(asha).toMatchObject({
      Total: 24000,
      "Basic salary": 12000,
      Present: 24,
      LOP: 0,
      "Total Days": 24,
      "E salary": 24000,
      NET: 24000,
    });
    expect(ravi).toMatchObject({
      Total: 30000,
      "Basic salary": 15000,
      Present: 12,
      LOP: 12,
      "Total Days": 12,
      "E salary": 15000,
      NET: 15000,
    });
    expect(Number(ravi["Lop& PSAmt"])).toBe(15000);
  });

  test("the statement can be narrowed to one branch, like the printed one for a single unit", async ({ page }) => {
    await openAs(page, adminToken, `${FEB}&tab=salary`);
    await expect(page.getByTestId("statement-panel")).toContainText("Asha Kumar", { timeout: 30_000 });
    await expect(page.getByTestId("statement-company")).toHaveText("UKTextiles");
    // the seed's two branches: the employees are in "E2E Head Office"
    await page.getByTestId("statement-branch").click();
    await page.getByRole("option", { name: "E2E Head Office" }).click();
    await expect(page).toHaveURL(/sbranch=\d+/);
    await expect(page.getByTestId("statement-company")).toContainText("E2E Head Office");
    await expect(page.getByTestId("statement-panel")).toContainText("Asha Kumar");
    // the other branch has nobody on this payroll
    await page.getByTestId("statement-branch").click();
    await page.getByRole("option", { name: "Head Office", exact: true }).click();
    await expect(page.getByTestId("statement-panel")).not.toContainText("Asha Kumar");
    // a reload keeps the branch
    await page.reload();
    await expect(page.getByTestId("statement-branch")).toContainText("Head Office");
    // and "All branches" brings everyone back
    await page.getByTestId("statement-branch").click();
    await page.getByRole("option", { name: "All branches" }).click();
    await expect(page).not.toHaveURL(/sbranch=/);
    await expect(page.getByTestId("statement-panel")).toContainText("Asha Kumar", { timeout: 30_000 });
  });

  test("the PDF export downloads a real PDF, and Print is offered too", async ({ page }) => {
    await openAs(page, adminToken, `${FEB}&tab=salary`);
    await expect(page.getByTestId("statement-panel")).toContainText("Asha Kumar", { timeout: 30_000 });
    await page.getByTestId("statement-export").click();
    await expect(page.getByTestId("statement-export-print")).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("statement-export-pdf").click(),
    ]);
    expect(download.suggestedFilename()).toBe("Salary_Statement_February_2026.pdf");
    const fs = await import("node:fs/promises");
    const head = (await fs.readFile((await download.path())!)).subarray(0, 5).toString("latin1");
    expect(head).toBe("%PDF-");
  });

  test("search and department narrow the statement, and the export follows what is on screen", async ({ page }) => {
    await openAs(page, adminToken, `${FEB}&tab=salary`);
    await expect(page.getByTestId("statement-panel")).toContainText("Asha Kumar", { timeout: 30_000 });
    await page.getByTestId("statement-search").fill("Ravi");
    await expect(page).toHaveURL(/sq=Ravi/);
    await expect(page.getByTestId("statement-count")).toContainText("Showing 1 of 2 employees");
    await expect(page.getByTestId("statement-panel")).not.toContainText("Asha Kumar");
    await page.getByTestId("statement-export").click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("statement-export-xlsx").click(),
    ]);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile((await download.path())!);
    const names: string[] = [];
    book.worksheets[0].eachRow((row) => {
      const cells = (row.values as unknown[]).slice(1);
      if (typeof cells[0] === "number") names.push(String(cells[2]));
    });
    expect(names).toEqual(["Ravi Nair"]);
    // a reload lands on the same filtered statement
    await page.reload();
    await expect(page.getByTestId("statement-search")).toHaveValue("Ravi");
  });

  test("a row is adjusted from the statement and marked paid; the figures follow", async ({ page, request }) => {
    await openAs(page, adminToken, `${FEB}&tab=salary`);
    const ravi = (await api(request, adminToken, "GET", "/api/payroll?month=2&year=2026")).body.find(
      (r: { employeeCode: string }) => r.employeeCode === "E2E002",
    );
    await expect(page.getByTestId("statement-panel")).toContainText("Ravi Nair", { timeout: 30_000 });
    await page.getByTestId(`staff-salary-adjust-${ravi.id}`).click();
    const dialog = page.getByTestId("adjust-payroll-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/bonus/i).fill("1000");
    await expect(page.getByTestId("adjust-net-preview")).toContainText("16,000");
    await dialog.getByRole("button", { name: /apply changes/i }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => {
        const list = (await api(request, adminToken, "GET", "/api/payroll?month=2&year=2026")).body;
        return list.find((r: { id: number }) => r.id === ravi.id)?.finalSalary;
      })
      .toBe(16000);

    await page.getByTestId(`staff-salary-pay-${ravi.id}`).click();
    await expect
      .poll(async () => {
        const list = (await api(request, adminToken, "GET", "/api/payroll?month=2&year=2026")).body;
        return list.find((r: { id: number }) => r.id === ravi.id)?.status;
      })
      .toBe("paid");
    await expect(page.getByTestId(`staff-salary-pay-${ravi.id}`)).toHaveCount(0);

    // put the month back the way the other specs expect it: generating again recomputes it (and resets paid to pending)
    await generateFebruary(request);
    const again = (await api(request, adminToken, "GET", "/api/payroll?month=2&year=2026")).body;
    expect(Number(again.find((r: { employeeCode: string }) => r.employeeCode === "E2E002").finalSalary)).toBe(15000);
  });
});

test.describe("Loaders", () => {
  test("the cards and the dashboard show skeletons while the insights are on their way", async ({ page }) => {
    await page.route("**/api/payroll/issues**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.continue();
    });
    await openAs(page, adminToken, FEB_CARDS);
    await expect(card(page, "Ravi Nair")).toBeVisible({ timeout: 30_000 });
    // the records are there; the issue badges are still loading
    await expect(page.getByTestId("payroll-record-issues-loading").first()).toBeVisible();
    await expect(page.getByTestId("payroll-record-issues-loading")).toHaveCount(0, { timeout: 15_000 });
    await expect(card(page, "Ravi Nair")).toContainText("Absent ×12");
  });

  test("the statement shows its loader, then the sheet", async ({ page }) => {
    await page.route("**/api/payroll/salary-statement**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.continue();
    });
    await openAs(page, adminToken, `${FEB}&tab=salary`);
    // a sheet-shaped skeleton while the statement is on its way, then the statement
    await expect(page.getByTestId("statement-skeleton")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("statement-panel")).toContainText("GRAND TOTAL", { timeout: 30_000 });
    await expect(page.getByTestId("statement-skeleton")).toHaveCount(0);
  });

  test("a failed insights request says so and offers a retry", async ({ page }) => {
    let failing = true;
    await page.route("**/api/payroll/salary-statement**", async (route) => {
      if (failing) await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' });
      else await route.continue();
    });
    await openAs(page, adminToken, `${FEB}&tab=salary`);
    // the request is retried once by the app, then the panel says it could not load and offers Retry
    await expect(page.getByTestId("statement-error")).toBeVisible({ timeout: 30_000 });
    failing = false;
    await page.getByTestId("statement-retry").click();
    await expect(page.getByTestId("statement-panel")).toContainText("GRAND TOTAL", { timeout: 30_000 });
  });
});

test.describe("Phone width", () => {
  test("no view of the Payroll page scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAs(page, adminToken, FEB);
    for (const query of [
      "",
      "&view=issues",
      "&view=skipped",
      "&view=rules",
      "&layout=table",
      "&tab=salary",
      "&tab=payslip",
    ]) {
      await page.goto(`${FEB}${query}`);
      await expect(page.getByTestId("staff-payroll-page")).toBeVisible();
      await page.waitForTimeout(1500);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `page-level horizontal scroll at ${query || "records"}`).toBeLessThanOrEqual(1);
    }
  });
});

test.describe("Who may see what", () => {
  test("a view-only role browses, filters and exports the statement but cannot generate, adjust or pay", async ({
    page,
  }) => {
    await openAs(page, viewerToken, FEB_CARDS);
    await expect(page.getByText(/View only/).first()).toBeVisible();
    await expect(card(page, "Ravi Nair")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("staff-generate-open")).toBeDisabled();
    await expect(page.getByTestId("staff-export-bank")).toBeDisabled();
    await expect(card(page, "Ravi Nair").getByRole("button", { name: /Mark as Cleared/ })).toBeDisabled();
    // reading is untouched: filters, views, the export menu, the details link
    await page.getByTestId("staff-pf-search").fill("Ravi");
    await expect(card(page, "Asha Kumar")).toHaveCount(0);
    await page.getByTestId("view-issues").click();
    await expect(issueRows(page, "absent").first()).toBeVisible();
    await page.getByTestId("view-records").click();
    await expect(page.getByTestId("staff-export")).toBeEnabled();

    await page.goto(`${FEB}&tab=salary`);
    await expect(page.getByTestId("statement-panel")).toContainText("Ravi Nair", { timeout: 30_000 });
    await expect(page.getByTestId("statement-export")).toBeEnabled();
    await expect(page.getByRole("button", { name: /Edit the bonus and deductions of Ravi Nair/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Update the status of Ravi Nair/ })).toBeDisabled();
  });

  test("a payslip-only role sees only the Payslip tab, and the payroll insights are closed to it", async ({
    page,
    request,
  }) => {
    await openAs(page, slipOnlyToken, FEB);
    await expect(page.getByRole("tab", { name: /^Payslip\b/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /^Payroll\b/ })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /^Salary\b/ })).toHaveCount(0);
    await expect(page.getByTestId("staff-payroll-tab")).toHaveCount(0);
    for (const url of [
      "/api/payroll/issues?month=2&year=2026",
      "/api/payroll/rules?month=2&year=2026",
      "/api/payroll/salary-statement?month=2&year=2026",
    ]) {
      expect((await api(request, slipOnlyToken, "GET", url)).status, url).toBe(403);
    }
  });

  test("production and staff payroll roles each reach only their own insight endpoints", async ({ request }) => {
    const staffRun = (await api(request, adminToken, "GET", "/api/payroll?month=2&year=2026")).body.find(
      (r: { salaryMode: string }) => r.salaryMode === "monthly",
    );
    for (const url of [
      "/api/payroll/production/issues?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08",
      "/api/payroll/production/salary-statement?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08",
    ]) {
      // production role: its own endpoints open (200 or a 4xx about the period, never 403) ...
      expect((await api(request, productionOnlyToken, "GET", url)).status, url).not.toBe(403);
      // ... the viewer role has no production module
      expect((await api(request, viewerToken, "GET", url)).status, url).toBe(403);
    }
    for (const url of [`/api/payroll/${staffRun.id}/details`, "/api/payroll/issues?month=2&year=2026"]) {
      expect((await api(request, productionOnlyToken, "GET", url)).status, url).toBe(403);
      expect((await api(request, viewerToken, "GET", url)).status, url).toBe(200);
    }
    // a staff payroll id on the production URL is not found
    expect((await api(request, adminToken, "GET", `/api/payroll/production/${staffRun.id}/details`)).status).toBe(404);
    // nothing is open without a token
    expect((await request.get("/api/payroll/issues?month=2&year=2026")).status()).toBe(401);
  });

  test("a login scoped to another branch sees none of this branch's payroll in any insight", async ({ request }) => {
    const ravi = (await api(request, adminToken, "GET", "/api/payroll?month=2&year=2026")).body.find(
      (r: { employeeCode: string }) => r.employeeCode === "E2E002",
    );
    const branch = await api(request, adminToken, "POST", "/api/branches", {
      name: "PI Other Unit",
      code: "PIOU",
      location: "Elsewhere",
    });
    expect(branch.status, JSON.stringify(branch.body)).toBeLessThan(300);
    let roleId = 0;
    let userId = 0;
    try {
      const role = await api(request, adminToken, "POST", "/api/roles", {
        name: "pi_branch",
        permissions: { payroll: "view", production_payroll: "view", salary: "view" },
      });
      expect(role.status, JSON.stringify(role.body)).toBeLessThan(300);
      roleId = role.body.id;
      const user = await api(request, adminToken, "POST", "/api/hr-users", {
        username: "pi_branch",
        password: PASSWORD,
        roleId: role.body.id,
        branchId: branch.body.id,
      });
      expect(user.status, JSON.stringify(user.body)).toBeLessThan(300);
      userId = user.body.id;
      const scoped = await signIn(request, "pi_branch", PASSWORD);

      const issues = (await api(request, scoped, "GET", "/api/payroll/issues?month=2&year=2026")).body;
      expect(issues.issues).toEqual([]);
      expect(issues.summary.employees).toBe(0);
      const rules = (await api(request, scoped, "GET", "/api/payroll/rules?month=2&year=2026")).body;
      expect(rules.employees).toEqual([]);
      const statement = (await api(request, scoped, "GET", "/api/payroll/salary-statement?month=2&year=2026")).body;
      expect(statement.groups.flatMap((g: { rows: unknown[] }) => g.rows)).toEqual([]);
      expect(statement.counts.employees).toBe(0);
      // a payroll of another branch is not found, as if it did not exist
      expect((await api(request, scoped, "GET", `/api/payroll/${ravi.id}/details`)).status).toBe(404);
      // the admin still sees all of it
      expect((await api(request, adminToken, "GET", `/api/payroll/${ravi.id}/details`)).status).toBe(200);
    } finally {
      // only what this test made: the other tests keep using the viewer / slip / production logins
      if (userId) await api(request, adminToken, "DELETE", `/api/hr-users/${userId}`);
      if (roleId) await api(request, adminToken, "DELETE", `/api/roles/${roleId}`);
      await api(request, adminToken, "DELETE", `/api/branches/${branch.body.id}`);
    }
  });
});

test.describe("Details page", () => {
  const idOf = async (request: APIRequestContext, code: string) => {
    const runs = (await api(request, adminToken, "GET", "/api/payroll?month=2&year=2026")).body as {
      id: number;
      employeeCode: string;
      salaryMode: string;
    }[];
    return runs.find((r) => r.salaryMode === "monthly" && r.employeeCode === code)!.id;
  };
  const detailsPath = (id: number, section = "") => `/hr/payroll/details/${id}${section ? `?section=${section}` : ""}`;

  test("Details opens a page of its own, and Back returns to the same filtered list", async ({ page, request }) => {
    const ravi = await idOf(request, "E2E002");
    await openAs(page, adminToken, `${FEB_CARDS}&q=Ravi`);
    await page.getByTestId(`payroll-record-details-${ravi}`).click();
    await expect(page).toHaveURL(new RegExp(`/hr/payroll/details/${ravi}$`));
    await expect(page.getByTestId("payroll-details-page")).toBeVisible();
    await expect(page.getByTestId("pd-employee-name")).toHaveText("Ravi Nair");
    await expect(page.getByTestId("pd-back")).toContainText("Back to Payroll · February 2026");

    // the page's own Back button lands on the list exactly as it was left
    await page.getByTestId("pd-back").click();
    await expect(page).toHaveURL(/\/hr\/payroll\?/);
    await expect(page).toHaveURL(/q=Ravi/);
    await expect(page).toHaveURL(/month=2/);
    await expect(page.getByTestId("staff-pf-search")).toHaveValue("Ravi");
    await expect(card(page, "Ravi Nair")).toBeVisible();
    await expect(card(page, "Asha Kumar")).toHaveCount(0);

    // so does the browser's
    await page.getByTestId(`payroll-record-details-${ravi}`).click();
    await expect(page.getByTestId("payroll-details-page")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("staff-pf-search")).toHaveValue("Ravi");
  });

  test("a pasted link has no history, and its Back button still leads to that month's payroll", async ({
    page,
    request,
  }) => {
    const ravi = await idOf(request, "E2E002");
    await openAs(page, adminToken, detailsPath(ravi));
    await expect(page.getByTestId("pd-employee-name")).toHaveText("Ravi Nair");
    await page.getByTestId("pd-back").click();
    await expect(page).toHaveURL(/\/hr\/payroll\?month=2&year=2026/);
    await expect(page.getByTestId("staff-payroll-tab")).toBeVisible();
  });

  test("explains the payroll: the figures, the days with their attendance categories, every issue with its date and the pay", async ({
    page,
    request,
  }) => {
    const ravi = await idOf(request, "E2E002");
    await openAs(page, adminToken, detailsPath(ravi));
    await expect(page.getByTestId("pd-kpis")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("pd-kpi-net")).toContainText("₹15,000");
    await expect(page.getByTestId("pd-kpi-gross")).toContainText("₹15,000");
    await expect(page.getByTestId("pd-kpi-days")).toContainText("12");
    await expect(page.getByTestId("pd-kpi-days")).toContainText("12 LOP");
    await expect(page.getByTestId("pd-status")).toContainText("Pending");
    await expect(page.getByTestId("pd-net-bridge")).toBeVisible();

    // a simple page: the days first, then the issues, then the pay; no Overview, Rules, Employee or History
    await expect(page.getByTestId("pd-nav").getByRole("button")).toHaveText([
      /^Attendance$/,
      /^Issues/,
      /^Pay & deductions$/,
    ]);
    for (const gone of ["overview", "rules", "employee", "history"]) {
      await expect(page.getByTestId(`pd-nav-${gone}`)).toHaveCount(0);
      await expect(page.getByTestId(`pd-section-${gone}`)).toHaveCount(0);
    }
    const attendance = await page.getByTestId("pd-section-attendance").boundingBox();
    const issues = await page.getByTestId("pd-section-issues").boundingBox();
    expect(attendance!.y).toBeLessThan(issues!.y);

    // Attendance: the key names all six attendance types
    for (const kind of ["late", "permission", "excess_permission", "on_duty", "on_duty_punch", "missed_punch"]) {
      await expect(page.getByTestId(`pd-mark-legend-${kind}`)).toBeVisible();
    }

    // Issues: one per absent day, each on its own date
    await page.getByTestId("pd-nav-issues").click();
    const absent = page.getByTestId(`pd-issue-${ravi}:absent:2026-02-16`);
    await expect(absent).toBeVisible();
    await expect(absent.getByTestId("pd-issue-date")).toContainText("Mon, 16 Feb 2026");
    await expect(absent.getByTestId("pd-issue-detail")).toContainText("No attendance recorded");
    await expect(page.getByTestId("pd-issue-count")).toContainText("14");

    // Attendance: the calendar says what each day counted as; the table lists the same days
    await page.getByTestId("pd-nav-attendance").click();
    await expect(page.getByTestId("pd-day-2026-02-16")).toBeVisible();
    await expect(page.getByTestId("pd-day-2026-02-02")).toBeVisible();
    await page.getByTestId("pd-view-table").click();
    await expect(page.getByTestId("pd-days-table")).toContainText(
      "2026-02-16".split("-").reverse().join("-").slice(0, 2),
    );

    // the pay and deductions are the last section
    await page.getByTestId("pd-nav-pay").click();
    await expect(page.getByTestId("pd-section-pay")).toBeVisible();
  });

  test("?section= opens the page on that section", async ({ page, request }) => {
    const ravi = await idOf(request, "E2E002");
    await openAs(page, adminToken, detailsPath(ravi, "issues"));
    await expect(page.getByTestId("pd-nav-issues")).toHaveAttribute("aria-current", "location", { timeout: 30_000 });
    await expect(page.getByTestId(`pd-issue-${ravi}:absent:2026-02-16`)).toBeInViewport();
  });

  test("the Issues section filters by type and by date, and groups by type", async ({ page, request }) => {
    const ravi = await idOf(request, "E2E002");
    await openAs(page, adminToken, detailsPath(ravi, "issues"));
    await expect(page.getByTestId(`pd-issue-${ravi}:absent:2026-02-16`)).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("pd-issue-from").fill("2026-02-26");
    await expect(page.locator('[data-testid^="pd-issue-' + ravi + ':absent"]')).toHaveCount(3);
    await page.getByTestId("pd-issue-reset").click();
    await expect(page.locator('[data-testid^="pd-issue-' + ravi + ':absent"]')).toHaveCount(12);
    await page.getByTestId("pd-issue-group-type").click();
    await expect(page.getByTestId("pd-issues-by-type")).toBeVisible();
    await expect(page.getByTestId("pd-issue-type-absent")).toBeVisible();
  });

  test("Previous and Next move between the month's payrolls without piling up history", async ({ page, request }) => {
    const asha = await idOf(request, "E2E001");
    await openAs(page, adminToken, `${FEB}&q=Asha`);
    await page.getByTestId(`payroll-record-details-${asha}`).click();
    await expect(page.getByTestId("pd-employee-name")).toHaveText("Asha Kumar");
    await expect(page.getByTestId("pd-position")).toContainText("1 of 2");
    await expect(page.getByTestId("pd-prev")).toBeDisabled();
    await page.getByTestId("pd-next").click();
    await expect(page.getByTestId("pd-employee-name")).toHaveText("Ravi Nair", { timeout: 30_000 });
    await expect(page.getByTestId("pd-position")).toContainText("2 of 2");
    await expect(page.getByTestId("pd-next")).toBeDisabled();
    // the move replaced the entry: Back leaves for the list, not for Asha
    await page.goBack();
    await expect(page.getByTestId("staff-pf-search")).toHaveValue("Asha");
  });

  test("the details export: workbook, issues as Excel and CSV, with the detection dates", async ({ page, request }) => {
    const ravi = await idOf(request, "E2E002");
    await openAs(page, adminToken, detailsPath(ravi));
    await expect(page.getByTestId("pd-kpis")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("export-menu").click();
    const [workbook] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export-menu-workbook").click(),
    ]);
    expect(workbook.suggestedFilename()).toMatch(/\.xlsx$/);
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile((await workbook.path())!);
    expect(book.worksheets.length).toBeGreaterThanOrEqual(4);
    const text = book.worksheets
      .flatMap((sheet) => {
        const out: string[] = [];
        sheet.eachRow((row) => out.push(...(row.values as unknown[]).slice(1).map((c) => String(c ?? ""))));
        return out;
      })
      .join("\n");
    expect(text).toContain("Ravi Nair");
    expect(text).toContain("No attendance recorded on this working day");

    // the menu closes by itself once the workbook is made: wait for that, or the next click would toggle it shut again
    await expect(page.getByTestId("export-menu-workbook")).toHaveCount(0);
    await page.getByTestId("export-menu").click();
    const [csv] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export-menu-issues-csv").click(),
    ]);
    expect(csv.suggestedFilename()).toMatch(/\.csv$/);
    const fs = await import("node:fs/promises");
    const lines = (await fs.readFile((await csv.path())!, "utf8")).split(/\r?\n/).filter(Boolean);
    expect(lines[0]).toMatch(/detected/i);
    // one line per issue (12 absences + the whole-period ones) and the header
    expect(lines.length).toBeGreaterThanOrEqual(13);
    expect(lines.some((l) => l.includes("16-02-2026") || l.includes("2026-02-16") || l.includes("16 Feb 2026"))).toBe(
      true,
    );
  });

  test("Mark as Cleared from the details page updates the status; generating again restores the month", async ({
    page,
    request,
  }) => {
    const asha = await idOf(request, "E2E001");
    await openAs(page, adminToken, detailsPath(asha));
    await expect(page.getByTestId("pd-status")).toContainText("Pending", { timeout: 30_000 });
    await page.getByTestId("pd-mark-paid").click();
    await expect(page.getByTestId("pd-status")).toContainText("Cleared", { timeout: 30_000 });
    await expect(page.getByTestId("pd-mark-paid")).toHaveCount(0);
    const list = (await api(request, adminToken, "GET", "/api/payroll?month=2&year=2026")).body;
    expect(list.find((r: { id: number }) => r.id === asha).status).toBe("paid");
    await generateFebruary(request);
  });

  test("an unknown payroll says so, and a production-only role cannot open a staff payroll", async ({
    page,
    request,
  }) => {
    await openAs(page, adminToken, detailsPath(99999999));
    await expect(page.getByTestId("pd-not-found")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("pd-not-found-back").click();
    await expect(page).toHaveURL(/\/hr\/payroll/);

    const ravi = await idOf(request, "E2E002");
    await openAs(page, productionOnlyToken, detailsPath(ravi));
    await expect(page.getByTestId("payroll-details-page")).toHaveCount(0);
    expect((await api(request, productionOnlyToken, "GET", `/api/payroll/${ravi}/details`)).status).toBe(403);
  });

  test("a view-only role can read the details page, export it, and cannot mark as cleared", async ({
    page,
    request,
  }) => {
    const ravi = await idOf(request, "E2E002");
    await openAs(page, viewerToken, detailsPath(ravi));
    await expect(page.getByTestId("pd-kpis")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("pd-mark-paid")).toBeDisabled();
    await expect(page.getByTestId("export-menu")).toBeEnabled();
    await page.getByTestId("pd-nav-issues").click();
    await expect(page.getByTestId(`pd-issue-${ravi}:absent:2026-02-16`)).toBeVisible();
  });

  test("no section of the page scrolls sideways on a phone", async ({ page, request }) => {
    const ravi = await idOf(request, "E2E002");
    await page.setViewportSize({ width: 390, height: 844 });
    for (const section of ["", "rules", "issues", "attendance", "pay", "employee", "history"]) {
      await openAs(page, adminToken, detailsPath(ravi, section));
      await expect(page.getByTestId("pd-kpis")).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(800);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `page-level horizontal scroll at section ${section || "overview"}`).toBeLessThanOrEqual(1);
    }
  });
});

test("signed in as the admin once more, the page works after all of that", async ({ page }) => {
  await loginAsHr(page);
  await page.goto(FEB_CARDS);
  await expect(card(page, "Asha Kumar")).toBeVisible({ timeout: 30_000 });
});
