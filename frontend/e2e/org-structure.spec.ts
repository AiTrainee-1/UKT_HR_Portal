import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Departments and Designations: Staff and Production apart behind the switch at the top (?category=), searching /
// filtering / sorting, the people drawer, creating / editing / deleting, and the Branch -> Department -> Designation tree. (api/tests_org_structure.py
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
 * Staff and production have departments of their own (owner, 2026-11-16), so "ORG Cutting" exists twice:
 * the Staff one holds 2 staff with ORG Master (senior); the Production one holds 3 production + 1 inactive production
 * with ORG Helper (junior). "ORG Empty": a Staff department with nobody. "ORG Floating": a Staff designation with no
 * department.
 */
async function seed(page: Page) {
  const branches = (await api(page, "GET", "/api/branches")).body as { id: number; name: string }[];
  const branch = branches[0];
  const dept = async (name: string, category: "staff" | "production" = "staff") => {
    const res = await api(page, "POST", "/api/departments", { name, branchId: branch.id, category });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as number;
  };
  const cutting = await dept("ORG Cutting");
  const prodCutting = await dept("ORG Cutting", "production");
  await dept("ORG Empty");
  const desig = async (title: string, departmentId: number | null, level: string) => {
    const res = await api(page, "POST", "/api/designations", { title, departmentId, level });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as number;
  };
  const master = await desig("ORG Master", cutting, "senior");
  const helper = await desig("ORG Helper", prodCutting, "junior");
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
      departmentId: kind === "production" ? prodCutting : cutting,
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

test("Staff and Production departments are apart behind the switch, the inactive left out of the totals", async ({
  page,
}) => {
  const before = (await api(page, "GET", "/api/departments")).body as { category?: string }[];
  const staffBefore = before.filter((d) => (d.category ?? "staff") === "staff").length;
  await seed(page);
  await page.goto("/hr/departments");
  await expect(page.getByTestId("org-category-switch")).toHaveAttribute("data-value", "staff");
  await expect(deptRow(page, "ORG Cutting")).toBeVisible();

  // the Staff ORG Cutting: its 2 staff only
  const cutting = deptRow(page, "ORG Cutting");
  await expect(cutting).toHaveAttribute("data-staff", "2");
  await expect(cutting).toHaveAttribute("data-production", "0");
  await expect(cutting).toHaveAttribute("data-active", "2");
  await expect(cutting.getByTestId("split-bar")).toBeVisible();
  await expect(deptRow(page, "ORG Empty")).toHaveAttribute("data-active", "0");
  await expect(page.getByTestId("stat-departments-value")).toHaveText(String(staffBefore + 2));

  // the switch moves the whole page (and the address) to Production: the other ORG Cutting, no ORG Empty
  await page.getByTestId("org-category-production").click();
  await expect(page).toHaveURL(/category=production/);
  const prod = deptRow(page, "ORG Cutting");
  await expect(prod).toHaveAttribute("data-production", "3");
  await expect(prod).toHaveAttribute("data-active", "3");
  await expect(prod).toContainText("+1 inactive");
  await expect(deptRow(page, "ORG Empty")).toHaveCount(0);
  await expect(page.getByTestId("new-department")).toContainText("New Production Department");

  // a link lands on the same view
  await page.goto("/hr/departments?category=production");
  await expect(page.getByTestId("org-category-switch")).toHaveAttribute("data-value", "production");
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

  // most employees first: ORG Cutting (2) comes before ORG Empty (0)
  await page.getByTestId("sort-departments").click();
  await page.getByRole("option", { name: "Most employees" }).click();
  await page.getByTestId("dept-search").fill("ORG ");
  const names = await page
    .locator('[data-testid^="dept-row-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(names.indexOf("dept-row-ORG Cutting")).toBeLessThan(names.indexOf("dept-row-ORG Empty"));
});

test("the drawer lists a department's people, of the department's kind only", async ({ page }) => {
  await seed(page);
  await page.goto("/hr/departments?category=production");
  await page.locator('[data-testid="dept-open-ORG Cutting"]:visible').click();
  const drawer = page.getByTestId("people-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId("drawer-category")).toHaveText("Production");
  await expect(drawer.getByTestId("drawer-counts")).toContainText("3 active");
  await expect(drawer.getByTestId("person-ORG-P1")).toHaveAttribute("data-type", "production");
  await expect(drawer.getByTestId("person-ORG-S1")).toHaveCount(0); // the staff are in the Staff ORG Cutting
  await expect(drawer.getByTestId("person-ORG-P4")).toHaveCount(0); // inactive: hidden until asked for

  await drawer.getByRole("tab", { name: /^Both/ }).click();
  await expect(drawer.getByTestId("person-ORG-P4")).toHaveAttribute("data-status", "inactive");
  await expect(drawer.getByTestId("drawer-showing")).toContainText("of 4 employees");

  await drawer.getByTestId("drawer-search").fill("dev");
  await expect(drawer.getByTestId("person-ORG-P2")).toBeVisible();
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

  // a department with people keeps its kind; the dialog says why
  await page.locator('[data-testid="dept-edit-ORG Cutting"]:visible').click();
  await expect(page.getByTestId("department-category-lock")).toContainText("2 employees are in this department");
  await expect(page.getByTestId("department-category-production")).toBeDisabled();
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.locator('[data-testid="dept-edit-ORG Brand New"]:visible').click();
  await page.getByTestId("department-name").fill("ORG Renamed");
  await page.getByTestId("department-description").fill("Edited in the test");
  await page.getByTestId("department-save").click();
  await expect(deptRow(page, "ORG Renamed")).toBeVisible();
  await expect(deptRow(page, "ORG Renamed")).toContainText("Edited in the test");

  // the delete confirmation says what happens to the people and the designations first
  await page.locator('[data-testid="dept-delete-ORG Cutting"]:visible').click();
  const confirm = page.getByTestId("confirm-delete");
  await expect(confirm).toContainText("2 employees (2 active) will be left with no department");
  await expect(confirm).toContainText("1 designation will lose its department");
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
  await expect(cutting.getByTestId("desig-row-ORG Master")).toHaveAttribute("data-staff", "2");
  await expect(cutting.getByTestId("desig-row-ORG Master").getByTestId("level-chip")).toHaveText("Senior");
  // ORG Helper is a Production designation: on the other side of the switch
  await expect(page.getByTestId("desig-row-ORG Helper")).toHaveCount(0);
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

  await page.getByTestId("org-category-production").click();
  await expect(page).toHaveURL(/category=production/);
  const prodCutting = tree.getByTestId(`branch-node-${branch.name}`).getByTestId("dept-node-ORG Cutting");
  await expect(prodCutting.getByTestId("desig-row-ORG Helper")).toHaveAttribute("data-production", "3");
  await expect(page.getByTestId("desig-row-ORG Master")).toHaveCount(0);
  await expect(tree.getByTestId("dept-node-ORG Empty")).toHaveCount(0);
});

test("designations can be searched by title, department or branch and filtered", async ({ page }) => {
  const { branch } = await seed(page);
  await page.goto("/hr/designations");
  await expect(page.getByTestId("desig-row-ORG Master")).toBeVisible();

  await page.getByTestId("desig-search").fill("org master");
  await expect(page.getByTestId("desig-row-ORG Master")).toBeVisible();
  await expect(page.getByTestId("desig-row-ORG Floating")).toHaveCount(0);

  // the department's name finds all of its designations
  await page.getByTestId("desig-search").fill("org cutting");
  await expect(page.getByTestId("desig-row-ORG Master")).toBeVisible();
  await expect(page.getByTestId("desig-row-ORG Floating")).toHaveCount(0);

  // so does the branch's
  await page.getByTestId("desig-search").fill(`${branch.name} org`);
  await expect(page.getByTestId("desig-row-ORG Master")).toBeVisible();
  await page.getByTestId("desig-clear-filters").click();

  await page.getByTestId("filter-level").click();
  await page.getByRole("option", { name: "Manager" }).click();
  await expect(page.getByTestId("desig-row-ORG Floating")).toBeVisible();
  await expect(page.getByTestId("desig-row-ORG Master")).toHaveCount(0);
  await page.getByTestId("desig-clear-filters").click();

  // designations nobody holds: ORG Floating, but not ORG Master that has people
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
  await page.goto("/hr/designations?category=production");
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
  await expect(page.getByTestId("org-category-switch")).toBeVisible();
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
