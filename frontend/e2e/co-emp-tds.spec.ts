import { expect, test, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// Employees > Co Emp and TDS. PF/ESI applies ONLY to employees whose Co Emp switch is on; an employee can instead be in TDS
// (tax deducted at source, never PF/ESI); everyone else has neither. The Co Emp tab keeps Staff and Production apart, has no
// actions column (no view, edit, inactive or delete), replaces Inactive / Bulk Upload / Add Employee with ONE "TDS – Tax
// Deducted at Source" button, shows how many employees have PF/ESI and how many do not, and can download that as Excel / PDF.
// The TDS panel (/hr/employees?tab=coemp&view=tds) lists the TDS employees, adds one by code (moving a Co Emp employee out of
// PF/ESI), edits the percentage and removes.
//
// Every employee made here has a code starting CT- and is removed again, so other specs see the seed data only. The counts
// of the coverage strip include whoever else is in the database, so they are compared before and after, never to a number.
// The Excel / PDF endpoint is stubbed in the browser (route): what is tested here is the page's side of the download.

type Reply = { status: number; body: any };

// The token comes from the login API, not from the page: a page that is still navigating after the UI login would make
// page.evaluate fail with "Execution context was destroyed".
const tokens = new Map<string, string>();

async function tokenOf(page: Page): Promise<string> {
  const known = tokens.get(HR_USERNAME);
  if (known) return known;
  const res = await page.request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  const token = (await res.json()).token as string;
  tokens.set(HR_USERNAME, token);
  return token;
}

async function api(page: Page, method: string, url: string, data?: unknown): Promise<Reply> {
  const token = await tokenOf(page);
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

type TestEmployee = {
  id: number;
  employeeCode: string;
  coEmpEnabled: boolean;
  tdsEnabled: boolean;
  tdsPercent: number | null;
};

async function testEmployees(page: Page): Promise<TestEmployee[]> {
  const list = (await api(page, "GET", "/api/employees?search=CT-")).body as TestEmployee[];
  return list.filter((e) => e.employeeCode.startsWith("CT-"));
}

async function employeeOf(page: Page, code: string): Promise<TestEmployee> {
  const found = (await testEmployees(page)).find((e) => e.employeeCode === code);
  if (!found) throw new Error(`no test employee ${code}`);
  return found;
}

async function removeTestEmployees(page: Page) {
  for (const e of await testEmployees(page)) await api(page, "DELETE", `/api/employees/${e.id}`);
}

async function makeEmployee(page: Page, code: string, first: string, type: "staff" | "production") {
  const branches = (await api(page, "GET", "/api/branches")).body as { id: number }[];
  const res = await api(page, "POST", "/api/employees", {
    employeeCode: code,
    firstName: first,
    lastName: "Tester",
    phone: "9000000088",
    employmentType: type,
    branchId: branches[0].id,
    salaryType: "monthly",
    salaryAmount: 30000,
    ...(type === "production" ? { salaryPerShift: 600 } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

const setCoEmp = (page: Page, id: number, enabled: boolean) =>
  api(page, "PATCH", `/api/employees/${id}`, { coEmpEnabled: enabled });

const setTds = async (page: Page, code: string, percent: number) => {
  const res = await api(page, "POST", "/api/tds/employees", { employeeCode: code, percent });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
};

// The tab row of each page draws every label twice (its animation), so a tab is found by its role, inside its own tab row.
const headerTab = (page: Page, label: "Staff" | "Production" | "Co Emp") =>
  page.getByTestId("employees-tabs").getByRole("tab", { name: new RegExp(`^${label}\\b`) });
const classTab = (page: Page, label: "Staff" | "Production") =>
  page.getByTestId("coemp-class-tabs").getByRole("tab", { name: new RegExp(`^${label}\\b`) });
const tdsTab = (page: Page, label: "Staff" | "Production") =>
  page.getByTestId("tds-class-tabs").getByRole("tab", { name: new RegExp(`^${label}\\b`) });

const coEmpRows = (page: Page) => page.locator('[data-testid^="row-employee-"]');
const coEmpRow = (page: Page, code: string) => page.locator('[data-testid^="row-employee-"]', { hasText: code });
const tdsRow = (page: Page, code: string) => page.locator('[data-testid^="row-tds-"]', { hasText: code });

async function openCoEmp(page: Page, cls: "staff" | "production" = "staff") {
  await page.goto(`/hr/employees?tab=coemp${cls === "production" ? "&type=production" : ""}`);
  await expect(page.getByTestId("coemp-tab")).toBeVisible();
  // Retried as a whole: a dev server that reloads the page (another file saved meanwhile) empties the search box.
  await expect(async () => {
    await page.getByTestId("input-search").fill("CT-");
    await expect(coEmpRows(page)).toHaveCount(cls === "staff" ? 3 : 2, { timeout: 4000 });
  }).toPass({ timeout: 25_000 });
}

async function openTds(page: Page, cls: "staff" | "production" = "staff") {
  await page.goto(`/hr/employees?tab=coemp&view=tds${cls === "production" ? "&type=production" : ""}`);
  await expect(page.getByTestId("tds-panel")).toBeVisible();
}

const strip = async (page: Page, cls: "staff" | "production", key: string) =>
  Number((await page.getByTestId(`coverage-${cls}-${key}`).innerText()).trim());

/** The Add Employee dialog: fill it in and press the button. */
async function addToTds(page: Page, code: string, percent: string) {
  await page.getByTestId("button-tds-add-employee").click();
  await expect(page.getByTestId("tds-add-dialog")).toBeVisible();
  await page.getByTestId("tds-add-code").fill(code);
  await page.getByTestId("tds-add-percent").fill(percent);
  await page.getByTestId("tds-add-submit").click();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }, testInfo) => {
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  await removeTestEmployees(page);
  await makeEmployee(page, "CT-S1", "Asha", "staff");
  await makeEmployee(page, "CT-S2", "Bala", "staff");
  await makeEmployee(page, "CT-S3", "Chitra", "staff");
  await makeEmployee(page, "CT-P1", "Deepa", "production");
  await makeEmployee(page, "CT-P2", "Esha", "production");
  // Chitra starts in TDS (10%), to test the question asked when Co Emp is switched on for her
  await setTds(page, "CT-S3", 10);
  await page.close();
});

test.afterAll(async ({ browser }, testInfo) => {
  const page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  await removeTestEmployees(page);
  await page.close();
});

test.beforeEach(async ({ page }) => {
  // Retried as a whole: a dev server that reloads the page (another file saved meanwhile) empties the login form.
  await expect(async () => {
    await loginAsHr(page);
  }).toPass({ timeout: 45_000 });
});

test("the Co Emp tab keeps Staff and Production apart, with the TDS button instead of Inactive / Bulk Upload / Add Employee", async ({
  page,
}) => {
  await page.goto("/hr/employees");
  // the Staff tab keeps its three buttons and the roster's actions
  await expect(page.getByTestId("button-toggle-inactive")).toBeVisible();
  await expect(page.getByTestId("button-bulk-upload")).toBeVisible();
  await expect(page.getByTestId("button-add-employee")).toBeVisible();
  await expect(page.getByTestId("button-tds")).toHaveCount(0);
  await expect(page.locator('[data-testid^="button-edit-"]').first()).toBeVisible();

  await headerTab(page, "Co Emp").click();
  await expect(page).toHaveURL(/\/hr\/employees\?tab=coemp$/);
  await expect(page.getByTestId("coemp-tab")).toBeVisible();
  // ONE header button now
  await expect(page.getByTestId("button-tds")).toHaveText("TDS – Tax Deducted at Source");
  for (const gone of ["button-toggle-inactive", "button-bulk-upload", "button-add-employee"]) {
    await expect(page.getByTestId(gone)).toHaveCount(0);
  }

  await page.getByTestId("input-search").fill("CT-");
  // Staff pill: only the staff
  await expect(classTab(page, "Staff")).toHaveAttribute("aria-selected", "true");
  await expect(coEmpRows(page)).toHaveCount(3);
  for (const code of ["CT-S1", "CT-S2", "CT-S3"]) await expect(coEmpRow(page, code)).toHaveCount(1);
  for (const code of ["CT-P1", "CT-P2"]) await expect(coEmpRow(page, code)).toHaveCount(0);

  // the table has what decides the switch and NO actions column
  const headers = await page.getByTestId("coemp-table").locator("th").allInnerTexts();
  expect(headers.map((h) => h.trim())).toEqual([
    "Code",
    "Unit Code",
    "Name",
    "Department",
    "Branch",
    "Phone",
    "Status",
    "PF/ESI status",
    "Co Emp",
  ]);
  for (const prefix of ["button-view-", "button-edit-", "button-delete-", "button-toggle-"]) {
    await expect(page.locator(`[data-testid^="${prefix}"]`)).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: /view|edit|delete|deactivate|activate/i })).toHaveCount(0);

  // Production pill: only the production employees, and the address says so
  await classTab(page, "Production").click();
  await expect(page).toHaveURL(/tab=coemp&type=production/);
  await expect(coEmpRows(page)).toHaveCount(2);
  for (const code of ["CT-P1", "CT-P2"]) await expect(coEmpRow(page, code)).toHaveCount(1);
  for (const code of ["CT-S1", "CT-S2", "CT-S3"]) await expect(coEmpRow(page, code)).toHaveCount(0);

  // a reload lands on the same class
  await page.reload();
  await expect(classTab(page, "Production")).toHaveAttribute("aria-selected", "true");

  // back on Staff the three buttons are back and the TDS button is gone
  await headerTab(page, "Staff").click();
  await expect(page).toHaveURL(/\/hr\/employees$/);
  await expect(page.getByTestId("button-toggle-inactive")).toBeVisible();
  await expect(page.getByTestId("button-bulk-upload")).toBeVisible();
  await expect(page.getByTestId("button-add-employee")).toBeVisible();
  await expect(page.getByTestId("button-tds")).toHaveCount(0);
});

test("the Co Emp switch turns on and off, and the coverage numbers follow", async ({ page }) => {
  const bala = await employeeOf(page, "CT-S2");
  await openCoEmp(page);
  await expect(page.getByTestId("coverage-staff-coEmp")).toBeVisible();
  const before = {
    coEmp: await strip(page, "staff", "coEmp"),
    notCoEmp: await strip(page, "staff", "notCoEmp"),
  };

  const toggle = page.getByTestId(`switch-coemp-${bala.id}`);
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId(`coemp-hint-${bala.id}`)).toContainText("Not Co Emp");

  await toggle.click();
  await expect(page.getByText("CT-S2 is now Co Emp", { exact: true })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect((await employeeOf(page, "CT-S2")).coEmpEnabled).toBe(true);
  // the strip moved by one: one more Co Emp employee, one fewer who is not
  await expect.poll(() => strip(page, "staff", "coEmp")).toBe(before.coEmp + 1);
  await expect.poll(() => strip(page, "staff", "notCoEmp")).toBe(before.notCoEmp - 1);
  // and the row now says what the rules do for this salary (PF, ESI, both, or "No deduction" when no rule matches)
  await expect(page.getByTestId(`coemp-hint-${bala.id}`)).toContainText(/PF \+ ESI|PF only|ESI only|No deduction/);
  await expect(page.getByTestId(`coemp-hint-${bala.id}`)).not.toContainText("Not Co Emp");
  await expect(page.getByTestId(`coemp-hint-${bala.id}`)).not.toContainText("TDS");

  await toggle.click();
  await expect(page.getByText("CT-S2 is no longer Co Emp", { exact: true })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect((await employeeOf(page, "CT-S2")).coEmpEnabled).toBe(false);
  await expect.poll(() => strip(page, "staff", "coEmp")).toBe(before.coEmp);
  await expect.poll(() => strip(page, "staff", "notCoEmp")).toBe(before.notCoEmp);
  await expect(page.getByTestId(`coemp-hint-${bala.id}`)).toContainText("Not Co Emp");
});

test("the coverage strip matches the server, class by class, in the owner's columns", async ({ page }) => {
  await openCoEmp(page);
  const server = (await api(page, "GET", "/api/pf-esi/coverage?type=all")).body as Record<
    string,
    Record<string, number>
  >;
  await expect(page.getByTestId("coverage-table")).toBeVisible();
  const headers = await page.getByTestId("coverage-table").locator("th").allInnerTexts();
  expect(headers.map((h) => h.trim())).toEqual([
    "Class",
    "Co Emp",
    "With PF",
    "With ESI",
    "With PF + ESI",
    "Co Emp, no deduction",
    "TDS",
    "Not Co Emp",
  ]);
  for (const cls of ["staff", "production"] as const) {
    for (const key of ["coEmp", "withPf", "withEsi", "withBoth", "withNeither", "tds", "notCoEmp"]) {
      await expect.poll(() => strip(page, cls, key), `${cls}.${key}`).toBe(server[cls][key]);
    }
    // the parts add up to the class
    expect(server[cls].coEmp + server[cls].tds + server[cls].notCoEmp).toBe(server[cls].total);
  }
});

test("turning Co Emp on for a TDS employee asks first, and moves them out of TDS only when confirmed", async ({
  page,
}) => {
  const chitra = await employeeOf(page, "CT-S3");
  expect(chitra).toMatchObject({ coEmpEnabled: false, tdsEnabled: true, tdsPercent: 10 });
  await openCoEmp(page);
  await expect(page.getByTestId(`coemp-hint-${chitra.id}`)).toContainText("TDS 10%");

  const toggle = page.getByTestId(`switch-coemp-${chitra.id}`);
  await toggle.click();
  const dialog = page.getByTestId("coemp-confirm-dialog");
  await expect(dialog).toContainText(
    "This employee is in TDS. Turning Co Emp on moves them out of TDS and applies PF/ESI rules.",
  );
  await expect(dialog).toContainText("CT-S3");
  // Cancel: nothing changed
  await page.getByTestId("coemp-confirm-cancel").click();
  await expect(dialog).toBeHidden();
  expect(await employeeOf(page, "CT-S3")).toMatchObject({ coEmpEnabled: false, tdsEnabled: true });
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  // Confirm: out of TDS, into Co Emp
  await toggle.click();
  await page.getByTestId("coemp-confirm").click();
  await expect(page.getByText("CT-S3 is now Co Emp", { exact: true })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(await employeeOf(page, "CT-S3")).toMatchObject({ coEmpEnabled: true, tdsEnabled: false, tdsPercent: null });
  await expect(page.getByTestId(`coemp-hint-${chitra.id}`)).not.toContainText("TDS");

  // switching it OFF again asks nothing (she is not in TDS any more)
  await toggle.click();
  await expect(page.getByTestId("coemp-confirm-dialog")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(await employeeOf(page, "CT-S3")).toMatchObject({ coEmpEnabled: false, tdsEnabled: false });

  // put her back in TDS for the tests that follow
  await setTds(page, "CT-S3", 10);
});

test("the TDS panel: opens from the button, in the address, and goes back to Co Emp", async ({ page }) => {
  await openCoEmp(page);
  await page.getByTestId("button-tds").click();
  await expect(page).toHaveURL(/tab=coemp&view=tds/);
  await expect(page.getByTestId("tds-panel")).toContainText("TDS – Tax Deducted at Source");
  await expect(page.getByTestId("button-tds-add-employee")).toBeVisible();
  // Staff and Production are kept apart here too
  await expect(tdsTab(page, "Staff")).toHaveAttribute("aria-selected", "true");
  await expect(tdsRow(page, "CT-S3")).toHaveCount(1);
  await expect(page.getByTestId(`tds-percent-${(await employeeOf(page, "CT-S3")).id}`)).toHaveText("10%");
  await tdsTab(page, "Production").click();
  await expect(page).toHaveURL(/type=production/);
  await expect(tdsRow(page, "CT-S3")).toHaveCount(0);

  // a pasted address opens the same screen, on the same class
  await page.reload();
  await expect(page.getByTestId("tds-panel")).toBeVisible();
  await expect(tdsTab(page, "Production")).toHaveAttribute("aria-selected", "true");

  // Back returns to the Co Emp list
  await page.getByTestId("tds-back").click();
  await expect(page.getByTestId("coemp-tab")).toBeVisible();
  await expect(page.getByTestId("tds-panel")).toHaveCount(0);
  await expect(page).not.toHaveURL(/view=tds/);
  // and the same button opens the panel again
  await page.getByTestId("button-tds").click();
  await expect(page.getByTestId("tds-panel")).toBeVisible();
});

test("TDS: add by code (a Co Emp employee is moved out of PF/ESI), unknown code, already in TDS, bad percentage", async ({
  page,
}) => {
  const asha = await employeeOf(page, "CT-S1");
  const bala = await employeeOf(page, "CT-S2");
  // Asha is in Co Emp (PF/ESI); Bala is in neither
  expect((await setCoEmp(page, asha.id, true)).status).toBe(200);
  await openCoEmp(page);
  await expect(page.getByTestId(`switch-coemp-${asha.id}`)).toHaveAttribute("aria-checked", "true");
  const coverageBefore = { coEmp: await strip(page, "staff", "coEmp"), tds: await strip(page, "staff", "tds") };

  await page.getByTestId("button-tds").click();
  await expect(page.getByTestId("tds-panel")).toBeVisible();

  // an unknown code: the server's message, in the dialog, which stays open
  await addToTds(page, "NOPE-999", "10");
  await expect(page.getByTestId("tds-add-code-error")).toHaveText("No employee with code 'NOPE-999'.");
  await expect(page.getByTestId("tds-add-dialog")).toBeVisible();

  // a percentage outside 0 - 100 is refused before the server is asked
  await page.getByTestId("tds-add-code").fill("CT-S1");
  await page.getByTestId("tds-add-percent").fill("150");
  await page.getByTestId("tds-add-submit").click();
  await expect(page.getByTestId("tds-add-percent-error")).toContainText("greater than 0 and at most 100");
  await expect(page.getByTestId("tds-add-code-error")).toHaveCount(0);
  expect(await employeeOf(page, "CT-S1")).toMatchObject({ coEmpEnabled: true, tdsEnabled: false });

  // a Co Emp employee: moved out of PF/ESI, and the user is told so
  await page.getByTestId("tds-add-percent").fill("10");
  await page.getByTestId("tds-add-submit").click();
  await expect(page.getByTestId("tds-add-dialog")).toBeHidden();
  await expect(page.getByText("CT-S1 moved from PF/ESI to TDS at 10%", { exact: true })).toBeVisible();
  await expect(tdsRow(page, "CT-S1")).toHaveCount(1);
  await expect(page.getByTestId(`tds-percent-${asha.id}`)).toHaveText("10%");
  expect(await employeeOf(page, "CT-S1")).toMatchObject({ coEmpEnabled: false, tdsEnabled: true, tdsPercent: 10 });

  // someone who was in neither: added without any fuss (and no "moved" message)
  await addToTds(page, "CT-S2", "12.5");
  await expect(page.getByTestId("tds-add-dialog")).toBeHidden();
  await expect(page.getByText("CT-S2 added to TDS at 12.5%", { exact: true })).toBeVisible();
  await expect(page.getByTestId(`tds-percent-${bala.id}`)).toHaveText("12.5%");
  expect(await employeeOf(page, "CT-S2")).toMatchObject({ coEmpEnabled: false, tdsEnabled: true, tdsPercent: 12.5 });

  // already in TDS: the server says so, the dialog stays open, nothing changes
  await addToTds(page, "CT-S2", "20");
  await expect(page.getByTestId("tds-add-code-error")).toHaveText(
    "CT-S2 is already in TDS (12.5%). Edit the percentage instead.",
  );
  expect((await employeeOf(page, "CT-S2")).tdsPercent).toBe(12.5);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("tds-add-dialog")).toBeHidden();

  // the dialog starts empty when opened again
  await page.getByTestId("button-tds-add-employee").click();
  await expect(page.getByTestId("tds-add-code")).toHaveValue("");
  await expect(page.getByTestId("tds-add-percent")).toHaveValue("");
  await page.getByRole("button", { name: "Cancel" }).click();

  // a production employee goes to the Production pill, not the Staff one
  await addToTds(page, "CT-P1", "5");
  await expect(page.getByText("CT-P1 added to TDS at 5%", { exact: true })).toBeVisible();
  await expect(tdsRow(page, "CT-P1")).toHaveCount(0);
  await tdsTab(page, "Production").click();
  await expect(tdsRow(page, "CT-P1")).toHaveCount(1);
  await expect(tdsRow(page, "CT-S1")).toHaveCount(0);
  await tdsTab(page, "Staff").click();

  // search inside the panel
  await page.getByTestId("tds-search").fill("CT-S1");
  await expect(page.locator('[data-testid^="row-tds-"]')).toHaveCount(1);
  await page.getByTestId("tds-search").fill("zzz-nobody");
  await expect(page.getByTestId("tds-empty")).toContainText("No staff TDS employee matches");
  await page.getByTestId("tds-search").fill("");

  // the Co Emp list and its coverage numbers follow: Asha left Co Emp for TDS
  await page.getByTestId("tds-back").click();
  await expect(page.getByTestId("coemp-tab")).toBeVisible();
  await expect.poll(() => strip(page, "staff", "coEmp")).toBe(coverageBefore.coEmp - 1);
  await expect.poll(() => strip(page, "staff", "tds")).toBe(coverageBefore.tds + 2); // Asha and Bala
  await expect(page.getByTestId(`switch-coemp-${asha.id}`)).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId(`coemp-hint-${asha.id}`)).toContainText("TDS 10%");
  await expect(page.getByTestId(`coemp-hint-${bala.id}`)).toContainText("TDS 12.5%");
});

test("TDS: edit the percentage (with its validation) and remove with a confirmation", async ({ page }) => {
  const bala = await employeeOf(page, "CT-S2");
  expect(bala).toMatchObject({ tdsEnabled: true, tdsPercent: 12.5 });
  await openTds(page);
  await expect(tdsRow(page, "CT-S2")).toHaveCount(1);

  // edit: an invalid percentage is refused in the dialog
  await page.getByTestId(`button-tds-edit-${bala.id}`).click();
  const edit = page.getByTestId("tds-edit-dialog");
  await expect(edit).toContainText("CT-S2 · Bala Tester");
  await expect(page.getByTestId("tds-edit-percent")).toHaveValue("12.5");
  await page.getByTestId("tds-edit-percent").fill("0");
  await page.getByTestId("tds-edit-submit").click();
  await expect(page.getByTestId("tds-edit-percent-error")).toContainText("greater than 0");
  await expect(edit).toBeVisible();
  expect((await employeeOf(page, "CT-S2")).tdsPercent).toBe(12.5);

  // a good one is saved and shown
  await page.getByTestId("tds-edit-percent").fill("15");
  await page.getByTestId("tds-edit-submit").click();
  await expect(edit).toBeHidden();
  await expect(page.getByText("CT-S2 TDS changed to 15%", { exact: true })).toBeVisible();
  await expect(page.getByTestId(`tds-percent-${bala.id}`)).toHaveText("15%");
  expect((await employeeOf(page, "CT-S2")).tdsPercent).toBe(15);

  // remove: asks first; Cancel changes nothing
  await page.getByTestId(`button-tds-remove-${bala.id}`).click();
  const confirm = page.getByTestId("tds-remove-dialog");
  await expect(confirm).toContainText("Remove CT-S2 from TDS?");
  await page.getByTestId("tds-remove-cancel").click();
  await expect(confirm).toBeHidden();
  await expect(tdsRow(page, "CT-S2")).toHaveCount(1);

  // confirmed: gone from the list; the employee ends up in NO category
  await page.getByTestId(`button-tds-remove-${bala.id}`).click();
  await page.getByTestId("tds-remove-confirm").click();
  await expect(page.getByText("CT-S2 removed from TDS", { exact: true })).toBeVisible();
  await expect(tdsRow(page, "CT-S2")).toHaveCount(0);
  expect(await employeeOf(page, "CT-S2")).toMatchObject({ coEmpEnabled: false, tdsEnabled: false, tdsPercent: null });

  // and the Co Emp list shows it: switch off, "No PF/ESI"
  await page.getByTestId("tds-back").click();
  await page.getByTestId("input-search").fill("CT-");
  await expect(page.getByTestId(`switch-coemp-${bala.id}`)).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId(`coemp-hint-${bala.id}`)).toContainText("Not Co Emp");
});

test("the coverage report downloads as Excel and as PDF", async ({ page }) => {
  const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const asked: { url: string; auth: string | undefined }[] = [];
  await page.route("**/api/pf-esi/coverage/export**", async (route) => {
    const url = route.request().url();
    asked.push({ url, auth: route.request().headers()["authorization"] });
    const pdf = new URL(url).searchParams.get("format") === "pdf";
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": pdf ? "application/pdf" : XLSX,
        "content-disposition": `attachment; filename="pf_esi_coverage_all_test.${pdf ? "pdf" : "xlsx"}"`,
      },
      body: Buffer.from(pdf ? "%PDF-1.4 fake" : "PK fake"),
    });
  });
  await openCoEmp(page);
  await expect(page.getByTestId("coverage-download-xlsx")).toHaveText("Download Excel");
  await expect(page.getByTestId("coverage-download-pdf")).toHaveText("Download PDF");

  const [excel] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("coverage-download-xlsx").click(),
  ]);
  expect(excel.suggestedFilename()).toBe("pf_esi_coverage_all_test.xlsx");
  await expect(page.getByText("Excel downloaded", { exact: true })).toBeVisible();

  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByTestId("coverage-download-pdf").click()]);
  expect(pdf.suggestedFilename()).toBe("pf_esi_coverage_all_test.pdf");

  // both asked for the whole report, signed in
  expect(asked.map((a) => new URL(a.url).searchParams.get("format"))).toEqual(["xlsx", "pdf"]);
  for (const a of asked) {
    expect(new URL(a.url).searchParams.get("type")).toBe("all");
    expect(a.auth).toMatch(/^Bearer .+/);
  }
});

test("a refused download says why, and the buttons work again", async ({ page }) => {
  await page.route("**/api/pf-esi/coverage/export**", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "permission_denied", message: "You cannot download this report." }),
    }),
  );
  await openCoEmp(page);
  await page.getByTestId("coverage-download-pdf").click();
  await expect(page.getByText("Could not download the PDF file", { exact: true })).toBeVisible();
  await expect(page.getByText("You cannot download this report.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("coverage-download-pdf")).toBeEnabled();
  await expect(page.getByTestId("coverage-download-xlsx")).toBeEnabled();
});
