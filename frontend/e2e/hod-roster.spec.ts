import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// User Management -> HOD Assignment and the manager's page: the Add Department User dialog with its approval permission
// picker, the employees of an assigned department listed automatically, and removing / restoring them dynamically.
// (api/tests_hod_department_roster.py covers the rules; this is what HR sees and can do.) Everything made here has a
// code starting RS- or a name starting "RS " and is removed again, so other specs see the seed data only.

type Reply = { status: number; body: any };

async function api(page: Page, method: string, url: string, data?: unknown, token?: string): Promise<Reply> {
  const bearer = token ?? (await page.evaluate(() => localStorage.getItem("uk_textile_token")));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${bearer}` }, data });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status(), body };
}

async function adminToken(page: Page): Promise<string> {
  const res = await page.request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  return (await res.json()).token as string;
}

test.describe.configure({ mode: "serial" });

async function purge(page: Page) {
  const token = await adminToken(page);
  const managers = (await api(page, "GET", "/api/department-managers", undefined, token)).body as any[];
  for (const m of managers.filter((m) => m.employeeCode.startsWith("RS-"))) {
    await api(page, "DELETE", `/api/department-managers/${m.id}`, undefined, token);
  }
  const employees = (await api(page, "GET", "/api/employees", undefined, token)).body as any[];
  for (const e of employees.filter((e) => e.employeeCode.startsWith("RS-"))) {
    await api(page, "DELETE", `/api/employees/${e.id}`, undefined, token);
  }
  const departments = (await api(page, "GET", "/api/departments", undefined, token)).body as any[];
  for (const d of departments.filter((d) => d.name.startsWith("RS "))) {
    await api(page, "DELETE", `/api/departments/${d.id}`, undefined, token);
  }
  for (const key of ["leave", "missing_punch"]) {
    await api(page, "DELETE", `/api/approval-workflows/${key}`, undefined, token);
  }
}

test.afterEach(async ({ page }) => {
  await purge(page);
});

type World = {
  cutting: { id: number; name: string };
  packing: { id: number; name: string };
  hod: { id: number; code: string; managerId?: number };
  team: Record<string, number>;
};

// "RS Cutting": the head Hema and Tara, Uma, Vimal.  "RS Packing": Padma.
async function world(page: Page): Promise<World> {
  await purge(page);
  const branches = (await api(page, "GET", "/api/branches")).body as { id: number }[];
  const branchId = branches[0].id;
  const dept = async (name: string) => {
    const res = await api(page, "POST", "/api/departments", { name, branchId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.id as number, name };
  };
  const cutting = await dept("RS Cutting");
  const packing = await dept("RS Packing");
  const emp = async (code: string, firstName: string, departmentId: number) => {
    const res = await api(page, "POST", "/api/employees", {
      employeeCode: code,
      firstName,
      lastName: "Roster",
      phone: "9000000088",
      employmentType: "staff",
      branchId,
      departmentId,
      salaryType: "monthly",
      salaryAmount: 24000,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as number;
  };
  const hodId = await emp("RS-HOD", "Hema", cutting.id);
  const team: Record<string, number> = {
    "RS-T1": await emp("RS-T1", "Tara", cutting.id),
    "RS-T2": await emp("RS-T2", "Uma", cutting.id),
    "RS-T3": await emp("RS-T3", "Vimal", cutting.id),
    "RS-P1": await emp("RS-P1", "Padma", packing.id),
  };
  return { cutting, packing, hod: { id: hodId, code: "RS-HOD" }, team };
}

async function makeHod(page: Page, code: string, extra: Record<string, unknown> = {}) {
  const res = await api(page, "POST", "/api/department-managers", { employeeCode: code, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

const roster = async (page: Page, managerId: number) =>
  (await api(page, "GET", `/api/department-managers/${managerId}/department-employees`)).body as {
    departments: { id: number; employees: { employeeCode: string; state: string }[] }[];
  };

const stateOf = async (page: Page, managerId: number, code: string) =>
  (await roster(page, managerId)).departments[0].employees.find((e) => e.employeeCode === code)?.state;

const row = (page: Page, code: string) => page.getByTestId(`roster-row-${code}`);

async function pickEmployee(page: Page, scope: ReturnType<Page["getByTestId"]>, code: string) {
  await scope.getByTestId("employee-search-select").click();
  await page.getByPlaceholder("Employee code or name…").fill(code);
  await page
    .getByRole("button", { name: new RegExp(code) })
    .first()
    .click();
}

async function addDepartment(page: Page, name: string) {
  await page.getByTestId("add-department-select").click();
  await page.getByRole("option", { name }).click();
  await page.getByTestId("add-department").click();
}

test("the Add Department User dialog has a clear permission picker, hides existing users and leads on to the departments", async ({
  page,
}) => {
  await loginAsHr(page);
  await world(page);
  await page.goto("/hr/user-management");
  await page.getByTestId("create-user").click();
  const dialog = page.getByTestId("create-user-dialog");
  await expect(dialog).toContainText("Add Department User");

  // seven cards, Missing Punch included, all on to begin with, each saying how requests are routed
  await expect(dialog.getByTestId("permission-count")).toContainText("7 of 7");
  await expect(dialog.locator('[data-testid^="perm-can"]')).toHaveCount(7);
  await expect(dialog).toContainText("Missing punch");
  await expect(dialog.getByTestId("perm-note-canApproveLeaves")).toContainText("Employee → HOD or HR");
  await expect(dialog.getByTestId("perm-note-canApproveMissingPunch")).toContainText("Employee → HOD → HR");

  // switching all off warns; switching two back on counts them
  await dialog.getByRole("button", { name: "Disable all" }).click();
  await expect(dialog.getByTestId("permission-count")).toContainText("0 of 7");
  await expect(dialog).toContainText("Every permission is off");
  await dialog.getByTestId("perm-canApproveLeaves").click();
  await dialog.getByTestId("perm-canApproveResignations").click();
  await expect(dialog.getByTestId("permission-count")).toContainText("2 of 7");
  await expect(dialog.getByTestId("perm-canApproveLeaves")).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByTestId("perm-canApproveOnDuty")).toHaveAttribute("aria-checked", "false");
  await expect(dialog).not.toContainText("Every permission is off");

  // nothing can be added until somebody is chosen; choosing shows who
  await expect(dialog.getByTestId("create-user-and-assign")).toBeDisabled();
  await pickEmployee(page, dialog, "RS-HOD");
  await expect(dialog.getByTestId("chosen-employee")).toContainText("Hema");
  await dialog.getByTestId("create-user-and-assign").click();

  // straight on to the new user's page, to choose their departments
  await expect(page).toHaveURL(/\/hr\/user-management\/\d+$/);
  await expect(page.getByTestId("manager-hero")).toContainText("Hema Roster");
  const list = (await api(page, "GET", "/api/department-managers")).body as any[];
  const made = list.find((m) => m.employeeCode === "RS-HOD");
  expect(made).toMatchObject({
    canApproveLeaves: true,
    canApproveResignations: true,
    canApprovePermissions: false,
    canApproveCasualLeave: false,
    canApproveAttendance: false,
    canApproveMissingPunch: false,
    canApproveOnDuty: false,
  });
  await expect(page.getByTestId("departments-card")).toContainText("No departments assigned yet");

  // somebody who already is a department user is no longer offered
  await page.goto("/hr/user-management");
  await page.getByTestId("create-user").click();
  await page.getByTestId("create-user-dialog").getByTestId("employee-search-select").click();
  await page.getByPlaceholder("Employee code or name…").fill("RS-HOD");
  await expect(page.getByRole("button", { name: /RS-HOD/ })).toHaveCount(0);
  await page.getByPlaceholder("Employee code or name…").fill("RS-T1");
  await expect(page.getByRole("button", { name: /RS-T1/ })).toHaveCount(1);
});

test("adding a department lists its employees automatically, and they can be removed and restored dynamically", async ({
  page,
}) => {
  await loginAsHr(page);
  const w = await world(page);
  const managerId = await makeHod(page, "RS-HOD");
  await page.goto(`/hr/user-management/${managerId}`);
  await expect(page.getByTestId("departments-card")).toContainText("No departments assigned yet");

  // the department's people appear the moment it is added: the head and the three in the team
  await addDepartment(page, "RS Cutting");
  const section = page.getByTestId(`dept-section-${w.cutting.id}`);
  await expect(section).toBeVisible();
  for (const code of ["RS-HOD", "RS-T1", "RS-T2", "RS-T3"]) await expect(row(page, code)).toBeVisible();
  await expect(row(page, "RS-P1")).toHaveCount(0); // another department
  await expect(row(page, "RS-HOD")).toHaveAttribute("data-state", "self");
  await expect(row(page, "RS-T1")).toHaveAttribute("data-state", "reporting");
  await expect(page.getByTestId(`dept-summary-${w.cutting.id}`)).toHaveText("3 reporting");
  await expect(page.getByTestId("tile-departments")).toContainText("1");

  // remove one person: they stay in the list as Removed, the numbers follow, and there is an Undo
  await page.getByTestId("roster-remove-RS-T1").click();
  await expect(row(page, "RS-T1")).toHaveAttribute("data-state", "removed");
  await expect(row(page, "RS-T1")).toContainText("Requests go to HR");
  await expect(page.getByTestId(`dept-summary-${w.cutting.id}`)).toHaveText("2 reporting · 1 removed");
  await expect(page.getByTestId("tile-removed")).toContainText("1");
  expect(await stateOf(page, managerId, "RS-T1")).toBe("removed");
  const detail = (await api(page, "GET", `/api/department-managers/${managerId}`)).body;
  expect(detail.assignedEmployeeIds).not.toContain(w.team["RS-T1"]);
  expect(detail.removedCount).toBe(1);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(row(page, "RS-T1")).toHaveAttribute("data-state", "reporting");
  await expect(page.getByTestId(`dept-summary-${w.cutting.id}`)).toHaveText("3 reporting");

  // remove two at once with the checkboxes
  await page.getByTestId("roster-select-RS-T2").click();
  await page.getByTestId("roster-select-RS-T3").click();
  await expect(section).toContainText("2 selected");
  await page.getByTestId(`dept-remove-selected-${w.cutting.id}`).click();
  await expect(row(page, "RS-T2")).toHaveAttribute("data-state", "removed");
  await expect(row(page, "RS-T3")).toHaveAttribute("data-state", "removed");
  await expect(page.getByTestId(`dept-summary-${w.cutting.id}`)).toHaveText("1 reporting · 2 removed");

  // the filter chips and the search narrow the list
  await page.getByTestId(`dept-filter-${w.cutting.id}-removed`).click();
  await expect(row(page, "RS-T2")).toBeVisible();
  await expect(row(page, "RS-T1")).toHaveCount(0);
  await page.getByTestId(`dept-search-${w.cutting.id}`).fill("vimal");
  await expect(row(page, "RS-T3")).toBeVisible();
  await expect(row(page, "RS-T2")).toHaveCount(0);
  await page.getByTestId(`dept-search-${w.cutting.id}`).fill("");
  await page.getByTestId(`dept-filter-${w.cutting.id}-all`).click();

  // put one back
  await page.getByTestId("roster-restore-RS-T2").click();
  await expect(row(page, "RS-T2")).toHaveAttribute("data-state", "reporting");
  expect(await stateOf(page, managerId, "RS-T2")).toBe("reporting");
  expect(await stateOf(page, managerId, "RS-T3")).toBe("removed");

  // someone who joins the department later is listed (and covered) without anybody doing anything
  const branches = (await api(page, "GET", "/api/branches")).body as { id: number }[];
  const late = await api(page, "POST", "/api/employees", {
    employeeCode: "RS-T4",
    firstName: "Wilma",
    lastName: "Roster",
    phone: "9000000088",
    employmentType: "staff",
    branchId: branches[0].id,
    departmentId: w.cutting.id,
    salaryType: "monthly",
    salaryAmount: 24000,
  });
  expect(late.status).toBe(201);
  await page.reload();
  await expect(row(page, "RS-T4")).toHaveAttribute("data-state", "reporting");
});

test("removing a department asks first and clears the people HR had taken out of it", async ({ page }) => {
  await loginAsHr(page);
  const w = await world(page);
  const managerId = await makeHod(page, "RS-HOD");
  await api(page, "POST", `/api/department-managers/${managerId}/departments`, { departmentId: w.cutting.id });
  await api(page, "POST", `/api/department-managers/${managerId}/excluded-employees`, {
    employeeIds: [w.team["RS-T1"]],
  });
  await page.goto(`/hr/user-management/${managerId}`);
  await expect(row(page, "RS-T1")).toHaveAttribute("data-state", "removed");

  await page.getByTestId(`dept-remove-${w.cutting.id}`).click();
  await expect(page.getByTestId("remove-department-dialog")).toContainText("Remove RS Cutting from Hema Roster?");
  await page.getByRole("button", { name: "Keep department" }).click();
  await expect(page.getByTestId(`dept-section-${w.cutting.id}`)).toBeVisible();

  await page.getByTestId(`dept-remove-${w.cutting.id}`).click();
  await page.getByTestId("confirm-remove-department").click();
  await expect(page.getByTestId(`dept-section-${w.cutting.id}`)).toHaveCount(0);
  await expect(page.getByTestId("departments-card")).toContainText("No departments assigned yet");

  // giving it back starts with everyone in it again
  await addDepartment(page, "RS Cutting");
  await expect(row(page, "RS-T1")).toHaveAttribute("data-state", "reporting");
});

test("a department whose people already have another HOD asks, then lists them as reporting elsewhere", async ({
  page,
}) => {
  await loginAsHr(page);
  const w = await world(page);
  const first = await makeHod(page, "RS-HOD");
  const second = await makeHod(page, "RS-P1");
  await api(page, "POST", `/api/department-managers/${second}/employees`, { employeeId: w.team["RS-T3"] });
  await page.goto(`/hr/user-management/${first}`);

  await addDepartment(page, "RS Cutting");
  const conflict = page.getByTestId("department-conflict-dialog");
  await expect(conflict).toContainText("Already assigned to another HOD");
  await expect(conflict).toContainText("RS-T3");
  await conflict.getByRole("button", { name: /assign only the rest of the department/ }).click();

  await expect(row(page, "RS-T1")).toHaveAttribute("data-state", "reporting");
  await expect(row(page, "RS-T3")).toHaveAttribute("data-state", "elsewhere");
  await expect(row(page, "RS-T3")).toContainText("Reports to Padma Roster");
  await expect(page.getByTestId("tile-elsewhere")).toContainText("1");
  await page.getByTestId(`dept-filter-${w.cutting.id}-elsewhere`).click();
  await expect(row(page, "RS-T1")).toHaveCount(0);

  // one click moves them here
  await page.getByTestId("roster-claim-RS-T3").click();
  await page.getByTestId(`dept-filter-${w.cutting.id}-all`).click();
  await expect(row(page, "RS-T3")).toHaveAttribute("data-state", "reporting");
  expect(await stateOf(page, first, "RS-T3")).toBe("reporting");
});

test("approval permissions save as they are switched, and say when the pipeline gives an HOD no step", async ({
  page,
}) => {
  await loginAsHr(page);
  await world(page);
  const managerId = await makeHod(page, "RS-HOD");
  await page.goto(`/hr/user-management/${managerId}`);
  const card = page.getByTestId("permissions-card");
  await expect(card.getByTestId("permission-count")).toContainText("7 of 7");

  const flag = async (key: string) =>
    ((await api(page, "GET", `/api/department-managers/${managerId}`)).body as any)[key] as boolean;

  await card.getByTestId("perm-canApproveMissingPunch").click();
  await expect(card.getByTestId("permission-count")).toContainText("6 of 7");
  await expect(card.getByTestId("perm-canApproveMissingPunch")).toHaveAttribute("aria-checked", "false");
  await expect.poll(() => flag("canApproveMissingPunch")).toBe(false);
  expect(await flag("canApproveLeaves")).toBe(true);

  await card.getByRole("button", { name: "Disable all" }).click();
  await expect(card.getByTestId("permission-count")).toContainText("0 of 7");
  await expect.poll(() => flag("canApproveLeaves")).toBe(false);
  await card.getByRole("button", { name: "Enable all" }).click();
  await expect(card.getByTestId("permission-count")).toContainText("7 of 7");
  await expect.poll(() => flag("canApproveMissingPunch")).toBe(true);

  // the card reads the approval pipelines: HR-only leave means the HOD's switch changes nothing
  await api(page, "PUT", "/api/approval-workflows/leave", { steps: [{ roles: ["hr"], mandatory: true }] });
  await page.reload();
  await expect(page.getByTestId("perm-note-canApproveLeaves")).toContainText("no step");
  await api(page, "PUT", "/api/approval-workflows/leave", { enabled: false });
  await page.reload();
  await expect(page.getByTestId("perm-note-canApproveLeaves")).toContainText("Switched off");

  // pausing the HOD from the header
  await page.getByTestId("manager-active-switch").click();
  await expect(page.getByTestId("manager-hero")).toContainText("Approvals paused");
  await expect.poll(() => flag("isActive")).toBe(false);
});

test("the HOD list shows what each user may approve, and enabling, disabling and filtering work", async ({ page }) => {
  await loginAsHr(page);
  const w = await world(page);
  const managerId = await makeHod(page, "RS-HOD", { canApproveResignations: false, canApproveOnDuty: false });
  await api(page, "POST", `/api/department-managers/${managerId}/departments`, { departmentId: w.cutting.id });
  await api(page, "POST", `/api/department-managers/${managerId}/excluded-employees`, {
    employeeIds: [w.team["RS-T1"]],
  });
  await page.goto("/hr/user-management");

  const card = page.getByTestId(`hod-card-${managerId}`);
  await expect(card).toContainText("Hema Roster");
  await expect(card).toContainText("1 department");
  await expect(card).toContainText("3 reporting"); // Hema, Uma, Vimal; Tara was removed
  await expect(card).toContainText("1 removed");
  const perms = page.getByTestId(`hod-perms-${managerId}`);
  await expect(perms).toContainText("Leave");
  await expect(perms).toContainText("Missing punch");
  await expect(perms).not.toContainText("Resignations");
  await expect(perms).toContainText("2 off");

  await page.getByTestId(`hod-active-${managerId}`).click();
  await expect(card).toContainText("Inactive");
  await page.getByTestId("hod-filter-inactive").click();
  await expect(card).toBeVisible();
  await page.getByTestId("hod-filter-active").click();
  await expect(card).toHaveCount(0);
  await page.getByTestId("hod-filter-all").click();

  // opening a card goes to the manager's page; removing asks first and says what happens
  await card.click();
  await expect(page).toHaveURL(new RegExp(`/hr/user-management/${managerId}$`));
  await page.goBack();
  await page.getByTestId(`hod-delete-${managerId}`).click();
  await expect(page.getByRole("dialog")).toContainText("Remove department user?");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(card).toBeVisible();
});

test("a View-only role can look at the manager's page but cannot remove, restore or change anything", async ({
  page,
}) => {
  await loginAsHr(page);
  const w = await world(page);
  const managerId = await makeHod(page, "RS-HOD");
  await api(page, "POST", `/api/department-managers/${managerId}/departments`, { departmentId: w.cutting.id });
  await api(page, "POST", `/api/department-managers/${managerId}/excluded-employees`, {
    employeeIds: [w.team["RS-T1"]],
  });
  const admin = await adminToken(page);
  const stamp = Date.now().toString(36);
  const role = await api(
    page,
    "POST",
    "/api/roles",
    { name: `e2e-rs-view-${stamp}`, permissions: { user_management: "view" } },
    admin,
  );
  expect(role.status).toBe(201);
  const username = `e2e_rs_view_${stamp}`;
  const password = "E2e-Limited-1!";
  const user = await api(page, "POST", "/api/hr-users", { username, password, roleId: role.body.id }, admin);
  expect(user.status).toBe(201);
  try {
    const login = await page.request.post("/api/auth/hr-login", { data: { username, password } });
    const token = (await login.json()).token as string;
    await page.evaluate((t) => localStorage.setItem("uk_textile_token", t), token);
    await page.goto(`/hr/user-management/${managerId}`);

    await expect(row(page, "RS-T1")).toHaveAttribute("data-state", "removed"); // everything is visible
    await expect(page.getByTestId("roster-restore-RS-T1")).toBeDisabled();
    await expect(page.getByTestId("roster-remove-RS-T2")).toBeDisabled();
    await expect(page.getByTestId("perm-canApproveLeaves")).toBeDisabled();
    await expect(page.getByTestId(`dept-remove-${w.cutting.id}`)).toBeDisabled();
    await expect(page.getByTestId("manager-active-switch")).toBeDisabled();

    // and the API refuses too
    const put = await api(
      page,
      "POST",
      `/api/department-managers/${managerId}/excluded-employees`,
      { employeeIds: [w.team["RS-T2"]] },
      token,
    );
    expect(put.status).toBe(403);
    expect(await stateOf(page, managerId, "RS-T2")).toBe("reporting");
  } finally {
    await api(page, "DELETE", `/api/hr-users/${user.body.id}`, undefined, admin);
    await api(page, "DELETE", `/api/roles/${role.body.id}`, undefined, admin);
  }
});

test("both pages fit a phone and a laptop, with screenshots for review", async ({ page }, testInfo: TestInfo) => {
  await loginAsHr(page);
  const w = await world(page);
  const managerId = await makeHod(page, "RS-HOD", { canApproveOnDuty: false });
  await makeHod(page, "RS-P1");
  await api(page, "POST", `/api/department-managers/${managerId}/departments`, { departmentId: w.cutting.id });
  await api(page, "POST", `/api/department-managers/${managerId}/excluded-employees`, {
    employeeIds: [w.team["RS-T1"]],
  });

  const noSideways = async (what: string) => {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(wide, `${what} scrolls sideways by ${wide}px`).toBeLessThanOrEqual(0);
  };
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });

  for (const [label, size] of [
    ["desktop", { width: 1366, height: 860 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(size);
    await page.goto("/hr/user-management");
    await expect(page.getByTestId(`hod-card-${managerId}`)).toBeVisible();
    await noSideways(`${label} list`);
    await shot(`${label}-1-list`);

    await page.getByTestId("create-user").click();
    const dialog = page.getByTestId("create-user-dialog");
    await expect(dialog).toBeVisible();
    await dialog.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished))); // it slides in
    const box = (await dialog.boundingBox())!;
    expect(box.x, `${label} dialog left edge`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${label} dialog right edge`).toBeLessThanOrEqual(size.width + 0.5);
    expect(box.y + box.height, `${label} dialog bottom edge`).toBeLessThanOrEqual(size.height + 0.5);
    await expect(dialog.getByTestId("create-user-and-assign")).toBeVisible(); // the footer is never scrolled out of reach
    await page.screenshot({ path: testInfo.outputPath(`${label}-2-dialog.png`) });
    await page.keyboard.press("Escape");

    await page.goto(`/hr/user-management/${managerId}`);
    await expect(row(page, "RS-T1")).toBeVisible();
    await noSideways(`${label} manager page`);
    await shot(`${label}-3-manager`);
    await page.getByTestId("departments-card").screenshot({ path: testInfo.outputPath(`${label}-4-departments.png`) });
    await page.getByTestId("permissions-card").screenshot({ path: testInfo.outputPath(`${label}-5-permissions.png`) });
  }
});
