import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Departments and Designations: the head-count split into staff and production, searching / filtering / sorting, the
// people drawer, creating / editing / deleting, and the Branch -> Department -> Designation tree. (api/tests_org_structure.py
// covers the counts and the branch scoping; this is what HR sees and can do.) Everything made here is called "ORG ..."
// and the employees have codes ORG-..., and all of it is removed again, so other specs see the seed data only.

async function api(page: Page, method: string, url: string, data?: unknown) {
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function purge(page: Page) {
  const employees = (await api(page, "GET", "/api/employees")).body as { id: number; employeeCode: string }[];
  for (const e of employees.filter((e) => e.employeeCode.startsWith("ORG-"))) {
    await api(page, "DELETE", `/api/employees/${e.id}`);
  }
  const designations = (await api(page, "GET", "/api/designations")).body as { id: number; title: string }[];
  for (const d of designations.filter((d) => d.title.startsWith("ORG "))) {
    await api(page, "DELETE", `/api/designations/${d.id}`);
  }
  const departments = (await api(page, "GET", "/api/departments")).body as { id: number; name: string }[];
  for (const d of departments.filter((d) => d.name.startsWith("ORG "))) {
    await api(page, "DELETE", `/api/departments/${d.id}`);
  }
}

/**
 * "ORG Cutting": 2 staff + 3 production + 1 inactive production, designations ORG Master (senior, the 2 staff) and
 * ORG Helper (junior, the production). "ORG Empty": nobody. "ORG Floating": a designation with no department.
 */
async function seed(page: Page) {
  const branches = (await api(page, "GET", "/api/branches")).body as { id: number; name: string }[];
  const branch = branches[0];
  const dept = async (name: string) => {
    const res = await api(page, "POST", "/api/departments", { name, branchId: branch.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as number;
  };
  const cutting = await dept("ORG Cutting");
  await dept("ORG Empty");
  const desig = async (title: string, departmentId: number | null, level: string) => {
    const res = await api(page, "POST", "/api/designations", { title, departmentId, level });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as number;
  };
  const master = await desig("ORG Master", cutting, "senior");
  const helper = await desig("ORG Helper", cutting, "junior");
  await desig("ORG Floating", null, "manager");
  const emp = async (
    code: string,
    first: string,
    kind: "staff" | "production",
    designationId: number,
    status = "active",
  ) => {
    const res = await api(page, "POST", "/api/employees", {
      employeeCode: code,
      firstName: first,
      lastName: "Org",
      phone: "9000000077",
      employmentType: kind,
      branchId: branch.id,
      departmentId: cutting,
      designationId,
      salaryType: "monthly",
      salaryAmount: 24000,
      ...(kind === "production" ? { salaryPerShift: 600 } : {}),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    if (status !== "active") await api(page, "PATCH", `/api/employees/${res.body.id}`, { status });
  };
  await emp("ORG-S1", "Asha", "staff", master);
  await emp("ORG-S2", "Bala", "staff", master);
  await emp("ORG-P1", "Chitra", "production", helper);
  await emp("ORG-P2", "Dev", "production", helper);
  await emp("ORG-P3", "Esha", "production", helper);
  await emp("ORG-P4", "Farid", "production", helper, "inactive");
  return { branch };
}

const deptRow = (page: Page, name: string) => page.getByTestId("departments-table").getByTestId(`dept-row-${name}`);

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await loginAsHr(page);
  await purge(page);
});

test.afterEach(async ({ page }) => {
  await purge(page);
});

test("a department shows its active staff and production apart, and leaves the inactive out of the totals", async ({
  page,
}) => {
  const before = (await api(page, "GET", "/api/departments")).body as unknown[];
  await seed(page);
  await page.goto("/hr/departments");
  await expect(deptRow(page, "ORG Cutting")).toBeVisible();

  const cutting = deptRow(page, "ORG Cutting");
  await expect(cutting).toHaveAttribute("data-staff", "2");
  await expect(cutting).toHaveAttribute("data-production", "3");
  await expect(cutting).toHaveAttribute("data-active", "5");
  await expect(cutting).toContainText("+1 inactive");
  await expect(cutting.getByTestId("split-bar")).toBeVisible();
  await expect(deptRow(page, "ORG Empty")).toHaveAttribute("data-active", "0");

  // the cards: the number of departments, and the company-wide staff / production totals
  await expect(page.getByTestId("stat-departments-value")).toHaveText(String(before.length + 2));
  const staff = Number(await page.getByTestId("stat-staff-value").innerText());
  const production = Number(await page.getByTestId("stat-production-value").innerText());
  const total = Number(await page.getByTestId("stat-employees-value").innerText());
  expect(staff).toBeGreaterThanOrEqual(2);
  expect(production).toBeGreaterThanOrEqual(3);
  expect(staff + production).toBeLessThanOrEqual(total);
});

test("departments can be searched, filtered to the empty ones and sorted", async ({ page }) => {
  await seed(page);
  await page.goto("/hr/departments");
  await expect(deptRow(page, "ORG Cutting")).toBeVisible();

  await page.getByTestId("dept-search").fill("org cut");
  await expect(deptRow(page, "ORG Cutting")).toBeVisible();
  await expect(deptRow(page, "ORG Empty")).toHaveCount(0);
  await page.getByTestId("dept-search").fill("nothing at all like this");
  await expect(page.getByTestId("departments-no-match")).toBeVisible();
  await page.getByTestId("departments-no-match").getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByTestId("dept-search")).toHaveValue("");

  await page.getByRole("tab", { name: /^No employees/ }).click();
  await expect(deptRow(page, "ORG Empty")).toBeVisible();
  await expect(deptRow(page, "ORG Cutting")).toHaveCount(0);
  await page.getByTestId("dept-clear-filters").click();

  // most employees first: ORG Cutting (5) comes before ORG Empty (0)
  await page.getByTestId("sort-departments").click();
  await page.getByRole("option", { name: "Most employees" }).click();
  await page.getByTestId("dept-search").fill("ORG ");
  const names = await page
    .locator('[data-testid^="dept-row-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(names.indexOf("dept-row-ORG Cutting")).toBeLessThan(names.indexOf("dept-row-ORG Empty"));
});

test("the drawer lists a department's people with staff and production told apart", async ({ page }) => {
  await seed(page);
  await page.goto("/hr/departments");
  await page.locator('[data-testid="dept-open-ORG Cutting"]:visible').click();
  const drawer = page.getByTestId("people-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId("drawer-counts")).toContainText("5 active");
  await expect(drawer.getByTestId("person-ORG-S1")).toHaveAttribute("data-type", "staff");
  await expect(drawer.getByTestId("person-ORG-P1")).toHaveAttribute("data-type", "production");
  await expect(drawer.getByTestId("person-ORG-P4")).toHaveCount(0); // inactive: hidden until asked for

  await drawer.getByRole("tab", { name: /^Production/ }).click();
  await expect(drawer.getByTestId("person-ORG-P1")).toBeVisible();
  await expect(drawer.getByTestId("person-ORG-S1")).toHaveCount(0);
  await drawer.getByRole("tab", { name: /^All/ }).first().click();

  await drawer.getByRole("tab", { name: /^Both/ }).click();
  await expect(drawer.getByTestId("person-ORG-P4")).toHaveAttribute("data-status", "inactive");
  await expect(drawer.getByTestId("drawer-showing")).toContainText("of 6 employees");

  await drawer.getByTestId("drawer-search").fill("master");
  await expect(drawer.getByTestId("person-ORG-S1")).toBeVisible();
  await expect(drawer.getByTestId("person-ORG-P1")).toHaveCount(0);
});

test("a department can be created, refused when the name is taken, renamed and deleted", async ({ page }) => {
  await seed(page);
  await page.goto("/hr/departments");
  await page.getByTestId("new-department").click();
  const dialog = page.getByTestId("department-dialog");
  await dialog.getByTestId("department-name").fill("ORG Cutting");
  const branchSelect = dialog.getByTestId("department-branch");
  if (await branchSelect.count()) await branchSelect.selectOption({ index: 1 });
  await dialog.getByTestId("department-save").click();
  await expect(dialog.getByTestId("department-error")).toContainText("already exists");

  await dialog.getByTestId("department-name").fill("ORG Brand New");
  await dialog.getByTestId("department-save").click();
  await expect(dialog).toHaveCount(0);
  await expect(deptRow(page, "ORG Brand New")).toBeVisible();

  await page.locator('[data-testid="dept-edit-ORG Brand New"]:visible').click();
  await page.getByTestId("department-name").fill("ORG Renamed");
  await page.getByTestId("department-description").fill("Edited in the test");
  await page.getByTestId("department-save").click();
  await expect(deptRow(page, "ORG Renamed")).toBeVisible();
  await expect(deptRow(page, "ORG Renamed")).toContainText("Edited in the test");

  // the delete confirmation says what happens to the people and the designations first
  await page.locator('[data-testid="dept-delete-ORG Cutting"]:visible').click();
  const confirm = page.getByTestId("confirm-delete");
  await expect(confirm).toContainText("6 employees (5 active, 1 inactive) will be left with no department");
  await expect(confirm).toContainText("2 designations will lose their department");
  await confirm.getByTestId("confirm-cancel").click();
  await expect(deptRow(page, "ORG Cutting")).toBeVisible();

  await page.locator('[data-testid="dept-delete-ORG Renamed"]:visible').click();
  await expect(page.getByTestId("confirm-delete")).toContainText("Nobody is in this department");
  await page.getByTestId("confirm-delete-yes").click();
  await expect(deptRow(page, "ORG Renamed")).toHaveCount(0);
});

test("designations hang under their department and branch, and the tree opens and closes", async ({ page }) => {
  const { branch } = await seed(page);
  await page.goto("/hr/designations");
  const tree = page.getByTestId("designation-tree");
  await expect(tree).toBeVisible();

  const branchNode = tree.getByTestId(`branch-node-${branch.name}`);
  const cutting = branchNode.getByTestId("dept-node-ORG Cutting");
  await expect(cutting.getByTestId("desig-row-ORG Master")).toBeVisible();
  await expect(cutting.getByTestId("desig-row-ORG Helper")).toBeVisible();
  await expect(cutting.getByTestId("desig-row-ORG Master")).toHaveAttribute("data-staff", "2");
  await expect(cutting.getByTestId("desig-row-ORG Helper")).toHaveAttribute("data-production", "3");
  await expect(cutting.getByTestId("desig-row-ORG Master").getByTestId("level-chip")).toHaveText("Senior");
  await expect(branchNode.getByTestId("dept-node-ORG Empty")).toBeVisible();
  // a designation with no department is under Unassigned
  await expect(tree.getByTestId("branch-node-Unassigned").getByTestId("desig-row-ORG Floating")).toBeVisible();

  await page.getByTestId("toggle-dept-ORG Cutting").click();
  await expect(cutting.getByTestId("desig-row-ORG Master")).toHaveCount(0);
  await page.getByTestId("toggle-dept-ORG Cutting").click();
  await expect(cutting.getByTestId("desig-row-ORG Master")).toBeVisible();

  await page.getByTestId("toggle-all").click(); // Collapse all
  await expect(tree.getByTestId("dept-node-ORG Cutting")).toHaveCount(0);
  await page.getByTestId("toggle-all").click(); // Expand all
  await expect(tree.getByTestId("dept-node-ORG Cutting")).toBeVisible();
});

test("designations can be searched by title, department or branch and filtered", async ({ page }) => {
  const { branch } = await seed(page);
  await page.goto("/hr/designations");
  await expect(page.getByTestId("desig-row-ORG Master")).toBeVisible();

  await page.getByTestId("desig-search").fill("org helper");
  await expect(page.getByTestId("desig-row-ORG Helper")).toBeVisible();
  await expect(page.getByTestId("desig-row-ORG Master")).toHaveCount(0);

  // the department's name finds all of its designations
  await page.getByTestId("desig-search").fill("org cutting");
  await expect(page.getByTestId("desig-row-ORG Master")).toBeVisible();
  await expect(page.getByTestId("desig-row-ORG Helper")).toBeVisible();
  await expect(page.getByTestId("desig-row-ORG Floating")).toHaveCount(0);

  // so does the branch's
  await page.getByTestId("desig-search").fill(`${branch.name} org`);
  await expect(page.getByTestId("desig-row-ORG Master")).toBeVisible();
  await page.getByTestId("desig-clear-filters").click();

  await page.getByTestId("filter-level").click();
  await page.getByRole("option", { name: "Junior" }).click();
  await expect(page.getByTestId("desig-row-ORG Helper")).toBeVisible();
  await expect(page.getByTestId("desig-row-ORG Master")).toHaveCount(0);
  await page.getByTestId("desig-clear-filters").click();

  // designations nobody holds: ORG Floating, but not the two that have people
  await page.getByTestId("filter-empty").click();
  await expect(page.getByTestId("desig-row-ORG Floating")).toBeVisible();
  await expect(page.getByTestId("desig-row-ORG Master")).toHaveCount(0);
  await page.getByTestId("desig-clear-filters").click();

  await page.getByTestId("desig-search").fill("zzz no such thing");
  await expect(page.getByTestId("designations-no-match")).toBeVisible();
});

test("the list view is an alternative to the tree, and a designation is added from its department", async ({
  page,
}) => {
  await seed(page);
  await page.goto("/hr/designations");
  await page.getByRole("tab", { name: /^List/ }).click();
  await expect(page.getByTestId("designations-table").getByTestId("desig-row-ORG Master")).toContainText("ORG Cutting");
  await expect(page.getByTestId("designation-tree")).toHaveCount(0);
  await page.getByRole("tab", { name: /^Tree/ }).click();

  // "Add" on a department pre-selects that department
  await page.getByTestId("add-desig-ORG Cutting").click();
  const dialog = page.getByTestId("designation-dialog");
  const select = dialog.getByTestId("designation-department");
  await expect(select.locator("option:checked")).toHaveText("ORG Cutting");
  await dialog.getByTestId("designation-title").fill("ORG Trainee");
  await dialog.getByTestId("designation-level").selectOption("junior");
  await dialog.getByTestId("designation-save").click();
  await expect(page.getByTestId("dept-node-ORG Cutting").getByTestId("desig-row-ORG Trainee")).toBeVisible();

  // edit: rename and move it to the empty department
  await page.getByTestId("desig-edit-ORG Trainee").click();
  await page.getByTestId("designation-title").fill("ORG Apprentice");
  await page.getByTestId("designation-department").selectOption({ label: "ORG Empty" });
  await page.getByTestId("designation-save").click();
  await expect(page.getByTestId("dept-node-ORG Empty").getByTestId("desig-row-ORG Apprentice")).toBeVisible();

  // delete explains what happens to the people first
  await page.getByTestId("desig-delete-ORG Master").click();
  await expect(page.getByTestId("confirm-delete")).toContainText(
    "2 employees (2 active) will be left with no designation",
  );
  await page.getByTestId("confirm-cancel").click();
  await page.getByTestId("desig-delete-ORG Apprentice").click();
  await page.getByTestId("confirm-delete-yes").click();
  await expect(page.getByTestId("desig-row-ORG Apprentice")).toHaveCount(0);
});

test("a designation's people open in the drawer", async ({ page }) => {
  await seed(page);
  await page.goto("/hr/designations");
  await page.getByTestId("desig-open-ORG Helper").click();
  const drawer = page.getByTestId("people-drawer");
  await expect(drawer.getByTestId("person-ORG-P1")).toHaveAttribute("data-type", "production");
  await expect(drawer.getByTestId("drawer-counts")).toContainText("3 active");
  await drawer.getByRole("tab", { name: /^Both/ }).click();
  await expect(drawer.getByTestId("person-ORG-P4")).toBeVisible();
});

test("on a phone the departments are cards and the page does not scroll sideways", async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/hr/departments");
  await expect(page.getByTestId("dept-card-ORG Cutting")).toBeVisible();
  await expect(page.getByTestId("departments-table")).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  await page.goto("/hr/designations");
  await expect(page.getByTestId("designation-tree")).toBeVisible();
  const overflow2 = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow2).toBeLessThanOrEqual(1);
});
