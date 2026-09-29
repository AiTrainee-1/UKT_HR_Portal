import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Report Center (/hr/reports): catalog, run, PDF/Excel download, view-only access and a sweep of every report.

type Filter = { key: string; kind: string; default: unknown; required: boolean; options?: { value: string }[] };
type Meta = { id: string; title: string; filters: Filter[] };

async function token(page: Page): Promise<string> {
  const t = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  if (!t) throw new Error("not logged in");
  return t;
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** The query string the UI would send for a report's default filters. */
function defaultQuery(filters: Filter[]): string {
  const q = new URLSearchParams();
  for (const f of filters) {
    const v = f.default as unknown;
    if (f.kind === "period" && v) q.set("period", String(v));
    else if (f.kind === "year" && v) q.set("year", String(v));
    else if (f.kind === "dateRange" && v) {
      const r = v as { dateFrom: string; dateTo: string };
      q.set("dateFrom", r.dateFrom);
      q.set("dateTo", r.dateTo);
    } else if (f.kind === "employeeStatus" && v) q.set("employeeStatus", String(v));
    else if (f.kind === "select" && v) q.set(f.key, String(v));
    else if (f.kind === "boolean" && v === true) q.set(f.key, "true");
    else if (f.kind === "number" && v !== null && v !== undefined) q.set(f.key, String(v));
  }
  return q.toString();
}

async function catalog(request: APIRequestContext, t: string): Promise<Meta[]> {
  const res = await request.get("/api/reports/catalog", { headers: auth(t) });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { reports: Meta[] }).reports;
}

test("the catalog groups reports by category and search narrows it", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/reports");
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Payroll & Salary" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Attendance", exact: true })).toBeVisible();

  const search = page.getByLabel("Search reports");
  await search.fill("zzzz-nothing");
  await expect(page.getByText(/No report matches/)).toBeVisible();
  await search.fill("salary");
  await expect(page.getByRole("link", { name: /salary/i }).first()).toBeVisible();
  await search.fill("");
  await expect(page.getByRole("heading", { name: "Gate & Visitors" })).toBeVisible();

  // the page brings its own Refresh button, so the shared strip must not appear as well
  await expect(page.getByTestId("button-page-refresh")).toHaveCount(1);
  await expect(page.getByTestId("page-refresh-bar")).toHaveCount(0);
});

test("opening a report shows its records, keeps the filters in the URL and downloads PDF and Excel", async ({
  page,
}) => {
  await loginAsHr(page);
  await page.goto("/hr/reports?report=employee-master");

  await expect(page).toHaveURL(/report=employee-master.*run=1|run=1.*report=employee-master/);
  await expect(page.getByText("Asha Kumar").first()).toBeVisible();
  await expect(page.getByText("Ravi Nair").first()).toBeVisible();
  await expect(page.getByText("Meena Nosalary").first()).toBeVisible();
  await expect(page.getByTestId("report-applied-filters")).toBeVisible();

  // quick search inside the result narrows the grid
  await page.getByLabel("Search in results").fill("Ravi");
  await expect(page.getByText("Ravi Nair").first()).toBeVisible();
  await expect(page.getByText("Asha Kumar")).toHaveCount(0);
  await page.getByLabel("Search in results").fill("");

  const [xlsx] = await Promise.all([page.waitForEvent("download"), page.getByTestId("report-download-xlsx").click()]);
  expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/);
  expect(
    readFileSync((await xlsx.path()) as string)
      .subarray(0, 2)
      .toString(),
  ).toBe("PK");

  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByTestId("report-download-pdf").click()]);
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
  expect(
    readFileSync((await pdf.path()) as string)
      .subarray(0, 5)
      .toString(),
  ).toBe("%PDF-");
});

test("a report link with filters opens straight into the same result", async ({ page }) => {
  await loginAsHr(page);
  const t = await token(page);
  const reports = await catalog(page.request, t);
  const withRange = reports.find((r) => r.filters.some((f) => f.kind === "dateRange"));
  test.skip(!withRange, "no date-range report in this build");
  const url = `/hr/reports?report=${withRange!.id}&run=1&dateFrom=2026-02-01&dateTo=2026-02-28`;
  await page.goto(url);
  await expect(page.getByTestId("report-applied-filters")).toContainText("Feb-2026");
});

test("an impossible date range is explained before anything is sent", async ({ page }) => {
  await loginAsHr(page);
  const t = await token(page);
  const reports = await catalog(page.request, t);
  const withRange = reports.find((r) => r.filters.some((f) => f.kind === "dateRange" && f.required));
  test.skip(!withRange, "no required date-range report in this build");
  await page.goto(`/hr/reports?report=${withRange!.id}`);
  await page.getByLabel("From date").fill("2026-03-10");
  await page.getByLabel("To date").fill("2026-03-01");
  await page.getByTestId("report-show").click();
  await expect(page.getByTestId("report-form-error")).toContainText(/after/i);
});

test("every report in the catalog runs and exports with its default filters", async ({ page }) => {
  test.setTimeout(600_000);
  await loginAsHr(page);
  const t = await token(page);
  const reports = await catalog(page.request, t);
  expect(reports.length).toBeGreaterThan(20);

  const problems: string[] = [];
  for (const r of reports) {
    const q = defaultQuery(r.filters);
    const run = await page.request.get(`/api/reports/run/${r.id}?${q}`, { headers: auth(t) });
    if (run.status() !== 200) {
      problems.push(`${r.id} run -> ${run.status()} ${(await run.text()).slice(0, 160)}`);
      continue;
    }
    const body = (await run.json()) as { rows: unknown[]; columns: unknown[] };
    if (!Array.isArray(body.rows) || !Array.isArray(body.columns) || body.columns.length === 0) {
      problems.push(`${r.id} run -> malformed payload`);
    }
    const x = await page.request.get(`/api/reports/export/${r.id}?fmt=xlsx&${q}`, { headers: auth(t) });
    const xb = await x.body();
    if (x.status() !== 200 || xb.subarray(0, 2).toString() !== "PK") problems.push(`${r.id} xlsx -> ${x.status()}`);
    const p = await page.request.get(`/api/reports/export/${r.id}?fmt=pdf&${q}`, { headers: auth(t) });
    const pb = await p.body();
    if (p.status() !== 200 || pb.subarray(0, 5).toString() !== "%PDF-") problems.push(`${r.id} pdf -> ${p.status()}`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

test("a view-only role can open, run and download reports, but only for data it may see", async ({ page, browser }) => {
  await loginAsHr(page);
  const admin = auth(await token(page));
  const suffix = Date.now();
  const roleRes = await page.request.post("/api/roles", {
    headers: admin,
    data: { name: `report-viewer-${suffix}`, permissions: { dashboard: "view", reports: "view", employees: "view" } },
  });
  expect(roleRes.status()).toBe(201);
  const roleId = ((await roleRes.json()) as { id: number }).id;
  const username = `report_viewer_${suffix}`;
  const password = "Viewer-Passw0rd!";
  const userRes = await page.request.post("/api/hr-users", {
    headers: admin,
    data: { username, password, fullName: "Report Viewer", roleId },
  });
  expect(userRes.status()).toBe(201);

  const ctx = await browser.newContext({ baseURL: "http://127.0.0.1:5180" });
  const vp = await ctx.newPage();
  await vp.goto("/hr-login");
  await vp.getByTestId("input-username").fill(username);
  await vp.getByTestId("input-password").fill(password);
  await vp.getByTestId("button-submit").click();
  await expect(vp).toHaveURL(/\/hr\/(dashboard|reports)/);

  await vp.goto("/hr/reports?report=employee-master");
  await expect(vp.getByText("Asha Kumar").first()).toBeVisible();
  await expect(vp.getByTestId("report-show")).toBeEnabled();
  await expect(vp.getByTestId("report-download-xlsx")).toBeEnabled();
  const [dl] = await Promise.all([vp.waitForEvent("download"), vp.getByTestId("report-download-xlsx").click()]);
  expect(dl.suggestedFilename()).toMatch(/\.xlsx$/);

  // payroll data is owned by the payroll modules this role does not have: not listed, and refused if asked for by id
  const vt = await token(vp);
  const visible = await catalog(vp.request, vt);
  expect(visible.some((r) => r.id === "salary-register")).toBe(false);
  expect(visible.some((r) => r.id === "employee-master")).toBe(true);
  const denied = await vp.request.get("/api/reports/run/salary-register", { headers: auth(vt) });
  expect(denied.status()).toBe(403);
  expect(((await denied.json()) as { error: string }).error).toBe("report_forbidden");
  await ctx.close();
});

test("the existing Attendance Report Log page still works", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/attendance/report-log");
  await expect(page.getByText(/Report Log|Monthly Report/i).first()).toBeVisible();
});
