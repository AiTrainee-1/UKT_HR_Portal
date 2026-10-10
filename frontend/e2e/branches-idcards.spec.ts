import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Manage Branch (summary, search, geofence filter, detail drawer, add with the duplicate-code check, delete, layout) and the
// ID Card Generator (search and filters, selecting, the no-photo warning). Everything made here is called "BI ..." (branches,
// departments) or BI-* (employees) and is removed again. A deleted branch is only switched off on the server and keeps its
// unique code, so every run uses codes of its own.

const RUN = String(Date.now()).slice(-6);
let ALPHA_CODE = `BA${RUN}`;
let BETA_CODE = `BB${RUN}`;
let seeds = 0;

async function api(page: Page, method: string, url: string, data?: unknown) {
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function cleanUp(page: Page) {
  const emps = (await api(page, "GET", "/api/employees?search=BI-")).body as { id: number; employeeCode: string }[];
  for (const e of (emps ?? []).filter((e) => e.employeeCode.startsWith("BI-"))) {
    await api(page, "DELETE", `/api/employees/${e.id}`);
  }
  const departments = (await api(page, "GET", "/api/departments")).body as { id: number; name: string }[];
  for (const d of (departments ?? []).filter((d) => d.name.startsWith("BI "))) {
    await api(page, "DELETE", `/api/departments/${d.id}`);
  }
  const branches = (await api(page, "GET", "/api/branches")).body as { id: number; name: string }[];
  for (const b of (branches ?? []).filter((b) => b.name.startsWith("BI "))) {
    await api(page, "DELETE", `/api/branches/${b.id}`);
  }
}

/** BI Alpha (geofence, a department, one staff and one production employee) and BI Beta (no geofence). */
async function seed(page: Page) {
  // the server refuses a code a deleted branch still holds, so every seed uses fresh ones
  seeds += 1;
  ALPHA_CODE = `BA${RUN}${seeds}`;
  BETA_CODE = `BB${RUN}${seeds}`;
  const alpha = (
    await api(page, "POST", "/api/branches", {
      name: "BI Alpha",
      code: ALPHA_CODE,
      location: "Binagar",
      address: "7 Test Road",
      phone: "+91 90000 00001",
      geofenceLat: 11.1,
      geofenceLng: 77.3,
      geofenceRadiusM: 150,
    })
  ).body;
  await api(page, "POST", "/api/branches", { name: "BI Beta", code: BETA_CODE, location: "Betaville" });
  const dept = (await api(page, "POST", "/api/departments", { name: "BI Dept", branchId: alpha.id })).body;
  for (const [code, first, kind] of [
    ["BI-S1", "Bina", "staff"],
    ["BI-P1", "Bela", "production"],
  ]) {
    const res = await api(page, "POST", "/api/employees", {
      employeeCode: code,
      firstName: first,
      lastName: "Idtest",
      phone: "9000000055",
      employmentType: kind,
      branchId: alpha.id,
      departmentId: dept.id,
      salaryType: "monthly",
      ...(kind === "staff" ? { salaryAmount: 24000 } : { salaryPerShift: 400 }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
  return alpha as { id: number };
}

const card = (page: Page, name: string) => page.locator(`[data-testid^="branch-card-"][data-branch-name="${name}"]`);

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await loginAsHr(page);
  await cleanUp(page);
});

test.afterEach(async ({ page }) => {
  await cleanUp(page);
});

test.describe("Manage Branch", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page);
    await page.goto("/hr/branches");
    await expect(page.getByRole("heading", { name: /Manage Branch/ })).toBeVisible({ timeout: 30_000 });
    await expect(card(page, "BI Alpha")).toBeVisible();
  });

  test("the summary and the figures on a card say who works where", async ({ page }) => {
    await expect(page.getByTestId("stat-branches")).toBeVisible();
    await expect(page.getByTestId("stat-geofence-value")).toContainText(" of ");
    const alpha = card(page, "BI Alpha");
    await expect(alpha).toContainText("Geofence set (150m)");
    await expect(alpha).toContainText("1 staff");
    await expect(alpha).toContainText("1 production");
    await expect(alpha.getByTestId("branch-departments")).toContainText("1 department");
    await expect(card(page, "BI Beta")).toContainText("No location set");
  });

  test("search ANDs the words and the empty state says nothing matches", async ({ page }) => {
    await page.getByTestId("branch-search").fill("binagar test");
    await expect(card(page, "BI Alpha")).toBeVisible();
    await expect(card(page, "BI Beta")).toHaveCount(0);
    await expect(page.getByTestId("branch-count")).toContainText("Showing 1 of");

    await page.getByTestId("branch-search").fill("binagar betaville");
    await expect(page.getByTestId("branches-no-match")).toBeVisible();
    await page.getByTestId("branches-no-match").getByRole("button", { name: "Clear filters" }).click();
    await expect(card(page, "BI Beta")).toBeVisible();
  });

  test("the geofence filter separates branches with and without a location", async ({ page }) => {
    await page.getByRole("tab", { name: /^No geofence/ }).click();
    await expect(card(page, "BI Beta")).toBeVisible();
    await expect(card(page, "BI Alpha")).toHaveCount(0);
    await page.getByRole("tab", { name: /^Geofence set/ }).click();
    await expect(card(page, "BI Alpha")).toBeVisible();
    await expect(card(page, "BI Beta")).toHaveCount(0);
    await page.getByTestId("branch-clear-filters").click();
    await expect(card(page, "BI Beta")).toBeVisible();
  });

  test("a branch opens in a drawer with its departments and the next unit code", async ({ page }) => {
    await card(page, "BI Alpha").click();
    const drawer = page.getByTestId("branch-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId("drawer-departments")).toContainText("BI Dept");
    await expect(drawer.getByTestId("drawer-departments")).toContainText("2 active");
    await expect(drawer.getByTestId("drawer-unit-code")).toContainText(`${ALPHA_CODE}-3`);
    await expect(drawer.getByTestId("drawer-geofence")).toContainText("150 metres");

    await drawer.getByTestId("drawer-edit").click();
    await expect(page.getByTestId("branch-dialog")).toBeVisible();
    await expect(page.getByLabel(/Branch Name/)).toHaveValue("BI Alpha");
  });

  test("adding a branch refuses a code that is taken, then saves and lists it", async ({ page }) => {
    await page.getByTestId("branch-add").click();
    const dialog = page.getByTestId("branch-dialog");
    await dialog.getByLabel(/Branch Name/).fill("BI Gamma");
    await dialog.getByLabel("Code", { exact: true }).fill(ALPHA_CODE.toLowerCase());
    await dialog.getByTestId("branch-save").click();
    await expect(dialog).toContainText("Another branch already uses this code");

    await dialog.getByLabel("Code", { exact: true }).fill(`BG${RUN}`);
    await dialog.getByTestId("branch-save").click();
    await expect(dialog).toHaveCount(0);
    await expect(card(page, "BI Gamma")).toBeVisible();
  });

  test("deleting asks first and then removes the branch from the list", async ({ page }) => {
    const beta = card(page, "BI Beta");
    await beta.getByRole("button", { name: "Delete BI Beta" }).click();
    await expect(page.getByTestId("confirm-delete")).toContainText("BI Beta");
    await page.getByTestId("confirm-cancel").click();
    await expect(beta).toBeVisible();

    await beta.getByRole("button", { name: "Delete BI Beta" }).click();
    await page.getByTestId("confirm-delete-yes").click();
    await expect(card(page, "BI Beta")).toHaveCount(0);
  });

  test("the table layout is remembered after a reload", async ({ page }) => {
    await page.getByTestId("view-list").click();
    await expect(page.getByTestId("branches-table")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("branches-table")).toBeVisible();
    await expect(page.getByTestId("branches-table")).toContainText("BI Alpha");
    await page.getByTestId("view-grid").click();
    await expect(page.getByTestId("branches-table")).toHaveCount(0);
  });

  test("the summary endpoint counts staff, production and departments", async ({ page }) => {
    const res = await api(page, "GET", "/api/branches/summary");
    expect(res.status).toBe(200);
    const branches = (await api(page, "GET", "/api/branches")).body as { id: number; name: string }[];
    const alpha = branches.find((b) => b.name === "BI Alpha")!;
    const row = res.body.branches.find((r: { branchId: number }) => r.branchId === alpha.id);
    expect(row).toMatchObject({ staffActive: 1, productionActive: 1, inactive: 0 });
    expect(row.departments).toEqual([expect.objectContaining({ name: "BI Dept", activeCount: 2 })]);
  });
});

test.describe("ID Card Generator", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page);
    await page.goto("/hr/id-cards");
    await expect(page.getByRole("heading", { name: /ID Card Generator/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("id-row-BI-S1")).toBeVisible({ timeout: 30_000 });
  });

  test("search and the type filter narrow the list, and clearing brings everyone back", async ({ page }) => {
    await page.getByTestId("id-search").fill("idtest bela");
    await expect(page.getByTestId("id-row-BI-P1")).toBeVisible();
    await expect(page.getByTestId("id-row-BI-S1")).toHaveCount(0);
    await page.getByTestId("id-search").fill("nobody-has-this-name");
    await expect(page.getByTestId("id-no-match")).toBeVisible();
    await page.getByTestId("id-clear-filters").click();
    await expect(page.getByTestId("id-row-BI-S1")).toBeVisible();

    await page.getByRole("tab", { name: /^Production/ }).click();
    await expect(page.getByTestId("id-row-BI-P1")).toBeVisible();
    await expect(page.getByTestId("id-row-BI-S1")).toHaveCount(0);
  });

  test("the no-photo filter finds employees whose card would print blank", async ({ page }) => {
    await page.getByTestId("id-filter-details").click();
    await page.getByRole("option", { name: "No photo" }).click();
    await expect(page.getByTestId("id-row-BI-S1")).toBeVisible();
    await expect(page.getByTestId("id-row-BI-S1").getByTestId("id-gap")).toBeVisible();
  });

  test("choosing an employee shows the card, warns about the missing photo, and can undo it", async ({ page }) => {
    await expect(page.getByTestId("id-preview-empty")).toBeVisible();
    await page.getByTestId("id-row-BI-S1").click();
    await expect(page.getByTestId("id-card-BI-S1")).toBeVisible();
    await expect(page.getByTestId("id-card-BI-S1").getByTestId("card-gaps")).toContainText("No photo");
    await expect(page.getByTestId("id-photo-warning")).toContainText("no photo");
    await expect(page.getByTestId("stat-selected-value")).toHaveText("1");
    await expect(page.getByRole("button", { name: /Print Selected \(1\)/ })).toBeEnabled();

    await page.getByTestId("id-deselect-no-photo").click();
    await expect(page.getByTestId("id-card-BI-S1")).toHaveCount(0);
    await expect(page.getByTestId("id-preview-empty")).toBeVisible();
  });

  test("select-all-shown picks the filtered employees only, and clear empties the selection", async ({ page }) => {
    await page.getByTestId("id-search").fill("idtest");
    await page.getByTestId("id-select-shown").click();
    await expect(page.getByTestId("id-card-BI-S1")).toBeVisible();
    await expect(page.getByTestId("id-card-BI-P1")).toBeVisible();
    await expect(page.getByTestId("id-select-shown")).toContainText("Deselect these 2");
    await page.getByTestId("id-clear-selection").click();
    await expect(page.getByTestId("id-preview-empty")).toBeVisible();
  });

  test("a card can be removed from the selection from its own header", async ({ page }) => {
    await page.getByTestId("id-search").fill("idtest");
    await page.getByTestId("id-select-shown").click();
    await page.getByRole("button", { name: "Remove Bina Idtest from the selection" }).click();
    await expect(page.getByTestId("id-card-BI-S1")).toHaveCount(0);
    await expect(page.getByTestId("id-card-BI-P1")).toBeVisible();
  });
});
