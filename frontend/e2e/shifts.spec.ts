import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// Manage Shifts: the shift cards and their validation, and the assign dialog (include / exclude employees, departments and
// designations, a preview of what happens to each person, keep or reassign for people already on a shift). The rules are
// pinned by api/tests_shift_assignment_plan.py; this is what HR sees and can do. Everything made here is named "SH ..." or
// has the code "SH-..." and is removed again.

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
  const list = async (url: string) => ((await api(page, "GET", url, undefined, token)).body ?? []) as any[];
  for (const e of (await list("/api/employees")).filter((e) => e.employeeCode.startsWith("SH-"))) {
    await api(page, "DELETE", `/api/employees/${e.id}`, undefined, token);
  }
  for (const s of (await list("/api/shifts")).filter((s) => s.name.startsWith("SH "))) {
    await api(page, "DELETE", `/api/shifts/${s.id}`, undefined, token);
  }
  for (const d of (await list("/api/designations")).filter((d) => d.title.startsWith("SH "))) {
    await api(page, "DELETE", `/api/designations/${d.id}`, undefined, token);
  }
  for (const d of (await list("/api/departments")).filter((d) => d.name.startsWith("SH "))) {
    await api(page, "DELETE", `/api/departments/${d.id}`, undefined, token);
  }
}

test.afterEach(async ({ page }) => {
  await purge(page);
});

type World = {
  stitching: number;
  cutting: number;
  operator: number;
  helper: number;
  morning: number;
  evening: number;
  ladies: number;
  emp: Record<string, number>;
};

// "SH Stitching": Sara (F, operator), Sunil (M, operator), Suma (F, helper) and a production employee Prem.
// "SH Cutting": Chandra (M, operator), Chitra (F, helper).  Shifts: Morning, Evening, Ladies (female only).
async function world(page: Page): Promise<World> {
  await purge(page);
  const branchId = ((await api(page, "GET", "/api/branches")).body as { id: number }[])[0].id;
  const make = async (url: string, data: object) => {
    const r = await api(page, "POST", url, data);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };
  const stitching = await make("/api/departments", { name: "SH Stitching", branchId });
  const cutting = await make("/api/departments", { name: "SH Cutting", branchId });
  const operator = await make("/api/designations", { title: "SH Operator", departmentId: stitching });
  const helper = await make("/api/designations", { title: "SH Helper", departmentId: stitching });
  const employee = (
    code: string,
    firstName: string,
    gender: string,
    departmentId: number,
    designationId: number | null,
    type = "staff",
  ) =>
    make("/api/employees", {
      employeeCode: code,
      firstName,
      lastName: "Shifty",
      phone: "9000000077",
      gender,
      employmentType: type,
      branchId,
      departmentId,
      designationId,
      salaryType: "monthly",
      ...(type === "staff" ? { salaryAmount: 24000 } : { salaryPerShift: 400 }),
    });
  const emp: Record<string, number> = {
    "SH-S1": await employee("SH-S1", "Sara", "female", stitching, operator),
    "SH-S2": await employee("SH-S2", "Sunil", "male", stitching, operator),
    "SH-S3": await employee("SH-S3", "Suma", "female", stitching, helper),
    "SH-PR": await employee("SH-PR", "Prem", "male", stitching, null, "production"),
    "SH-C1": await employee("SH-C1", "Chandra", "male", cutting, operator),
    "SH-C2": await employee("SH-C2", "Chitra", "female", cutting, helper),
  };
  const shift = (name: string, start: string, end: string, genderRule = "all") =>
    make("/api/shifts", {
      name,
      shiftType: "staff",
      startTime: start,
      endTime: end,
      genderRule,
      gracePeriodMinutes: 15,
    });
  return {
    stitching,
    cutting,
    operator,
    helper,
    morning: await shift("SH Morning", "09:00", "18:00"),
    evening: await shift("SH Evening", "12:00", "21:00"),
    ladies: await shift("SH Ladies", "08:00", "17:00", "female"),
    emp,
  };
}

const ago = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function put(page: Page, w: World, code: string, shiftId: number, from: string) {
  const r = await api(page, "POST", "/api/shift-assignments/apply", {
    shiftId,
    effectiveFrom: from,
    selection: { employees: { include: [w.emp[code]] } },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

const assignments = async (page: Page) =>
  ((await api(page, "GET", "/api/shift-assignments")).body as any[]).filter((a) => a.employeeCode.startsWith("SH-"));

const dialog = (page: Page) => page.getByTestId("assign-dialog");
const tile = (page: Page, name: string) => dialog(page).getByTestId(`tile-${name}`).locator("p").first();
const row = (page: Page, code: string) => dialog(page).getByTestId(`plan-row-${code}`);

async function openAssign(page: Page, shiftId: number) {
  await page.goto("/hr/shifts");
  await page.getByTestId(`shift-assign-${shiftId}`).click();
  await expect(dialog(page)).toBeVisible();
}

async function include(page: Page, kind: "employee" | "department" | "designation", id: number) {
  await dialog(page).getByTestId(`sel-kind-${kind}`).click();
  await dialog(page).getByTestId(`sel-include-${kind}-${id}`).click();
}
async function exclude(page: Page, kind: "employee" | "department" | "designation", id: number) {
  await dialog(page).getByTestId(`sel-kind-${kind}`).click();
  await dialog(page).getByTestId(`sel-exclude-${kind}-${id}`).click();
}

test("the shift form validates while typing, refuses duplicates, and a created shift appears with nobody on it", async ({
  page,
}) => {
  await loginAsHr(page);
  await world(page);
  await page.goto("/hr/shifts");
  await page.getByTestId("new-shift").click();
  const form = page.getByTestId("shift-form-dialog");

  // nothing is valid yet: the errors appear on pressing Create
  await form.getByTestId("shift-save").click();
  await expect(form).toContainText("Shift name is required");

  // end before start is refused (overnight shifts are not supported), and a shift needs a sensible length
  await form.getByTestId("shift-name").fill("SH Night");
  await form.getByTestId("shift-start").fill("22:00");
  await form.getByTestId("shift-end").fill("06:00");
  await expect(form).toContainText("Overnight shifts are not supported");
  await form.getByTestId("shift-start").fill("09:00");
  await form.getByTestId("shift-end").fill("09:30");
  await expect(form).toContainText("at least 1 hour");
  await form.getByTestId("shift-end").fill("17:30");
  await expect(form.getByTestId("shift-length")).toHaveText("8h 30m");

  // a duplicate name (any case) is refused
  await form.getByTestId("shift-name").fill("sh morning");
  await form.getByTestId("shift-save").click();
  await expect(form).toContainText("A staff shift called 'sh morning' already exists");

  // the lunch break must sit inside the shift
  await form.getByTestId("shift-name").fill("SH General");
  await form.getByTestId("shift-half").fill("08:00");
  await form.getByTestId("shift-save").click();
  await expect(form).toContainText("first half must end between");
  await form.getByTestId("shift-half").fill("13:00");

  // a female-only shift, then save
  await form.getByTestId("shift-gender-female").click();
  await form.getByTestId("shift-save").click();
  await expect(form).toHaveCount(0);
  const made = ((await api(page, "GET", "/api/shifts")).body as any[]).find((s) => s.name === "SH General");
  expect(made).toMatchObject({
    startTime: "09:00",
    endTime: "17:30",
    genderRule: "female",
    firstHalfEnd: "13:00",
    assignedCount: 0,
  });
  const card = page.getByTestId(`shift-card-${made.id}`);
  await expect(card).toContainText(/female only/i);
  await expect(card).toContainText("09:00");
  await expect(card).toContainText("Nobody on it yet");
});

test("a shift in use keeps its type, cannot be deleted or disabled, and an unused one can be edited, disabled and deleted", async ({
  page,
}) => {
  await loginAsHr(page);
  const w = await world(page);
  await put(page, w, "SH-S1", w.morning, ago(10));
  await page.goto("/hr/shifts");

  // in use: the edit dialog says so and locks the type
  await page.getByTestId(`shift-edit-${w.morning}`).click();
  const form = page.getByTestId("shift-form-dialog");
  await expect(form.getByTestId("shift-in-use-note")).toContainText("1 employee is on this shift");
  await expect(form.getByTestId("shift-type-production")).toBeDisabled();
  await form.getByTestId("shift-grace").fill("20");
  await form.getByTestId("shift-save").click();
  await expect(form).toHaveCount(0);
  expect(((await api(page, "GET", `/api/shifts/${w.morning}`)).body as any).gracePeriodMinutes).toBe(20);

  // it cannot be deleted while anyone is on it, nor disabled
  await page.getByTestId(`shift-delete-${w.morning}`).click();
  await expect(page.getByTestId("delete-shift-dialog")).toContainText("is in use");
  await expect(page.getByTestId("delete-shift-confirm")).toHaveCount(0);
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByTestId(`shift-toggle-${w.morning}`).click();
  await expect(page.getByText("Could not change the shift")).toBeVisible();
  expect(((await api(page, "GET", `/api/shifts/${w.morning}`)).body as any).isActive).toBe(true);

  // an unused one: disable (it can no longer be assigned), enable, delete
  await page.getByTestId(`shift-toggle-${w.evening}`).click();
  await expect(page.getByTestId(`shift-card-${w.evening}`)).toContainText("Inactive");
  await expect(page.getByTestId(`shift-assign-${w.evening}`)).toBeDisabled();
  await page.getByTestId(`shift-toggle-${w.evening}`).click();
  await expect(page.getByTestId(`shift-assign-${w.evening}`)).toBeEnabled();
  await page.getByTestId(`shift-delete-${w.evening}`).click();
  await page.getByTestId("delete-shift-confirm").click();
  await expect(page.getByTestId(`shift-card-${w.evening}`)).toHaveCount(0);
});

test("assigning to departments, designations and people with includes and excludes shows exactly what will happen", async ({
  page,
}) => {
  await loginAsHr(page);
  const w = await world(page);
  await put(page, w, "SH-S2", w.evening, ago(30)); // Sunil is already on the Evening shift
  await openAssign(page, w.morning);
  await expect(dialog(page).getByTestId("assign-locked-shift")).toContainText("SH Morning");

  // nothing chosen: no preview, nothing to press
  await expect(dialog(page).getByTestId("plan-empty")).toBeVisible();
  await expect(dialog(page).getByTestId("assign-confirm")).toBeDisabled();

  // include the Stitching department, leave out Suma by name
  await include(page, "department", w.stitching);
  await exclude(page, "employee", w.emp["SH-S3"]);
  await expect(dialog(page).getByTestId(`chip-department-${w.stitching}`)).toHaveAttribute("data-mode", "include");
  await expect(dialog(page).getByTestId(`chip-employee-${w.emp["SH-S3"]}`)).toHaveAttribute("data-mode", "exclude");

  // Sara is new, Sunil is on another shift, Suma is left out, Prem is a production employee
  await expect(row(page, "SH-S1")).toHaveAttribute("data-status", "new");
  await expect(row(page, "SH-S2")).toHaveAttribute("data-status", "conflict");
  await expect(row(page, "SH-S3")).toHaveAttribute("data-status", "excluded");
  await expect(row(page, "SH-PR")).toHaveAttribute("data-status", "skipped");
  await expect(row(page, "SH-PR")).toContainText("This is a staff shift");
  await expect(row(page, "SH-S2")).toContainText("Now on SH Evening");
  await expect(row(page, "SH-S1")).toContainText("Department: SH Stitching");
  await expect(tile(page, "new")).toHaveText("1");
  await expect(tile(page, "already")).toHaveText("1");
  await expect(tile(page, "reassign")).toHaveText("0");
  await expect(tile(page, "kept")).toHaveText("1");
  await expect(tile(page, "skipped")).toHaveText("2");
  await expect(dialog(page).getByTestId("assign-confirm")).toHaveText("Assign 1 employee");

  // the default is to keep people on the shift they have; choosing Reassign for Sunil moves only him
  await expect(row(page, "SH-S2")).toHaveAttribute("data-action", "keep");
  await dialog(page).getByTestId("decision-reassign-SH-S2").click();
  await expect(row(page, "SH-S2")).toHaveAttribute("data-action", "reassign");
  await expect(tile(page, "reassign")).toHaveText("1");
  await expect(tile(page, "kept")).toHaveText("0");
  await expect(dialog(page).getByTestId("assign-confirm")).toHaveText("Assign 1 and reassign 1");

  // writing it asks for confirmation because someone is being moved
  await dialog(page).getByTestId("assign-confirm").click();
  await expect(page.getByTestId("reassign-confirm")).toContainText("Reassign 1 employee?");
  await page.getByTestId("reassign-confirm-yes").click();
  await expect(dialog(page)).toHaveCount(0);

  const rows = await assignments(page);
  const by = (code: string) => rows.filter((a) => a.employeeCode === code);
  expect(by("SH-S1").map((a) => a.shiftName)).toEqual(["SH Morning"]);
  expect(by("SH-S3")).toHaveLength(0); // left out
  expect(by("SH-PR")).toHaveLength(0); // not eligible
  const sunil = (await api(page, "GET", `/api/shift-assignments?employeeId=${w.emp["SH-S2"]}`)).body as any[];
  const old = sunil.find((a) => a.shiftName === "SH Evening");
  const now = sunil.find((a) => a.shiftName === "SH Morning");
  expect(now.effectiveTo).toBeNull();
  expect(old.effectiveTo).toBe(ago(1)); // the old shift ends the day before the new one starts
  expect(now.effectiveFrom > old.effectiveTo).toBe(true);

  // doing it again changes nothing, and the dialog says so
  await openAssign(page, w.morning);
  await include(page, "department", w.stitching);
  await exclude(page, "employee", w.emp["SH-S3"]);
  await expect(row(page, "SH-S1")).toHaveAttribute("data-status", "unchanged");
  await expect(row(page, "SH-S2")).toHaveAttribute("data-status", "unchanged");
  await expect(dialog(page).getByTestId("assign-confirm")).toBeDisabled();
  await expect(dialog(page).getByTestId("assign-summary")).toContainText("Nobody would be assigned or changed");
});

test("several departments and designations: an excluded designation is left out of every included department", async ({
  page,
}) => {
  await loginAsHr(page);
  const w = await world(page);
  await openAssign(page, w.morning);
  await include(page, "department", w.stitching);
  await include(page, "department", w.cutting);
  await exclude(page, "designation", w.helper);
  await expect(row(page, "SH-S1")).toHaveAttribute("data-status", "new");
  await expect(row(page, "SH-S2")).toHaveAttribute("data-status", "new");
  await expect(row(page, "SH-C1")).toHaveAttribute("data-status", "new");
  await expect(row(page, "SH-S3")).toHaveAttribute("data-status", "excluded");
  await expect(row(page, "SH-C2")).toHaveAttribute("data-status", "excluded");
  await expect(row(page, "SH-S3")).toContainText("designation SH Helper excluded");
  await expect(tile(page, "new")).toHaveText("3");

  // a chip can be flipped between include and exclude, or removed
  await dialog(page).getByTestId(`chip-flip-designation-${w.helper}`).click();
  await expect(dialog(page).getByTestId(`chip-designation-${w.helper}`)).toHaveAttribute("data-mode", "include");
  await expect(row(page, "SH-S3")).toHaveAttribute("data-status", "new");
  await dialog(page).getByTestId(`chip-remove-designation-${w.helper}`).click();
  await expect(dialog(page).getByTestId(`chip-designation-${w.helper}`)).toHaveCount(0);

  // the plan can be filtered and searched
  await dialog(page).getByTestId("plan-filter-skipped").click();
  await expect(row(page, "SH-PR")).toBeVisible();
  await expect(row(page, "SH-C1")).toHaveCount(0);
  await dialog(page).getByTestId("plan-filter-all").click();
  await dialog(page).getByTestId("plan-search").fill("chitra");
  await expect(row(page, "SH-C2")).toBeVisible();
  await expect(row(page, "SH-C1")).toHaveCount(0);
});

test("everyone already on a shift can be kept or reassigned together, a gendered shift skips the rest, and bad input is stopped", async ({
  page,
}) => {
  await loginAsHr(page);
  const w = await world(page);
  for (const code of ["SH-S1", "SH-S2", "SH-S3"]) await put(page, w, code, w.evening, ago(30));
  await openAssign(page, w.ladies);
  await include(page, "department", w.stitching);

  // Sara and Suma are women; Sunil is not, so the shift cannot be his
  await expect(row(page, "SH-S2")).toHaveAttribute("data-status", "skipped");
  await expect(row(page, "SH-S2")).toContainText("female only");
  await expect(dialog(page).getByTestId("conflict-policy")).toContainText("2 employees are already on a shift");
  await expect(tile(page, "kept")).toHaveText("2");
  await dialog(page).getByTestId("policy-reassign").click();
  await expect(tile(page, "reassign")).toHaveText("2");
  await expect(dialog(page).getByTestId("assign-confirm")).toHaveText("Reassign 2 employees");
  await dialog(page).getByTestId("policy-keep").click();
  await expect(tile(page, "kept")).toHaveText("2");
  await expect(dialog(page).getByTestId("assign-confirm")).toBeDisabled();

  // an overnight custom schedule is an error the preview shows, and nothing can be pressed
  await dialog(page).getByTestId("assign-options").locator("summary").click();
  await dialog(page).getByTestId("assign-cstart").fill("10:00");
  await dialog(page).getByTestId("assign-cend").fill("09:00");
  await expect(dialog(page).getByTestId("plan-errors")).toContainText("cannot end before it starts");
  await expect(dialog(page).getByTestId("assign-confirm")).toBeDisabled();
  await dialog(page).getByTestId("assign-cend").fill("19:00");
  await expect(dialog(page).getByTestId("plan-errors")).toHaveCount(0);

  // a date in the past warns; a date before a shift that already began blocks that person
  await dialog(page).getByTestId("assign-date").fill(ago(60));
  await expect(dialog(page).getByTestId("plan-warnings")).toContainText("in the past");
  await expect(row(page, "SH-S1")).toHaveAttribute("data-status", "blocked");
  await expect(row(page, "SH-S1")).toContainText("Already on 'SH Evening' since");
  await expect(tile(page, "errors")).toHaveText("2");
  await dialog(page).getByTestId("plan-filter-errors").click();
  await expect(row(page, "SH-S3")).toBeVisible();
  await expect(row(page, "SH-S2")).toHaveCount(0);
});

test("the assignments tab: remove people from a shift from a chosen day, move them, and change one person's schedule", async ({
  page,
}) => {
  await loginAsHr(page);
  const w = await world(page);
  for (const code of ["SH-S1", "SH-S2", "SH-S3"]) await put(page, w, code, w.morning, ago(20));
  await page.goto("/hr/shifts");
  await page.getByRole("tab", { name: /Assign(ments|ed)/ }).click();
  await page.getByTestId(`group-toggle-${w.morning}`).click();
  await expect(page.getByTestId("member-SH-S1")).toBeVisible();
  await expect(page.getByTestId(`group-count-${w.morning}`)).toHaveText("3");

  // a person's own hours
  await page.getByTestId("member-edit-SH-S1").click();
  const edit = page.getByTestId("edit-schedule-dialog");
  await edit.getByTestId("es-start").fill("10:00");
  await edit.getByTestId("es-end").fill("09:00");
  await expect(edit).toContainText("cannot end before it starts");
  await expect(edit.getByTestId("es-save")).toBeDisabled();
  await edit.getByTestId("es-end").fill("19:00");
  await edit.getByTestId("es-saturday").click();
  await edit.getByTestId("es-save").click();
  await expect(page.getByTestId("member-SH-S1")).toContainText("10:00–19:00");
  await expect(page.getByTestId("member-SH-S1")).toContainText("Sat off");

  // two people moved to another shift: the assign dialog opens with them included and "reassign" chosen
  await page.getByTestId("member-select-SH-S2").click();
  await page.getByTestId("member-select-SH-S3").click();
  await page.getByTestId(`group-move-${w.morning}`).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByTestId(`chip-employee-${w.emp["SH-S2"]}`)).toHaveAttribute("data-mode", "include");
  await dialog(page).getByTestId("assign-shift-select").click();
  await page.getByRole("option", { name: /SH Evening/ }).click();
  await expect(row(page, "SH-S2")).toHaveAttribute("data-action", "reassign");
  await expect(dialog(page).getByTestId("assign-confirm")).toHaveText("Reassign 2 employees");
  await dialog(page).getByTestId("assign-confirm").click();
  await page.getByTestId("reassign-confirm-yes").click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("member-SH-S2")).toHaveCount(0);
  await expect(page.getByTestId(`group-count-${w.morning}`)).toHaveText("1");

  // taking someone off a shift keeps their past and ends it on the day chosen
  await page.getByTestId("member-remove-SH-S1").click();
  const remove = page.getByTestId("remove-shift-dialog");
  await remove.getByTestId("last-day").fill(ago(30));
  await expect(remove).toContainText("The last day cannot be before that");
  await expect(remove.getByTestId("remove-shift-confirm")).toBeDisabled();
  await remove.getByTestId("last-day").fill(ago(1));
  await remove.getByTestId("remove-shift-confirm").click();
  await expect(page.getByTestId("member-SH-S1")).toHaveCount(0);
  const ended = ((await api(page, "GET", `/api/shift-assignments?employeeId=${w.emp["SH-S1"]}`)).body as any[])[0];
  expect(ended.effectiveTo).toBe(ago(1)); // still on record, up to and including that day
});

test("the unassigned tab assigns several people at once", async ({ page }) => {
  await loginAsHr(page);
  const w = await world(page);
  await page.goto("/hr/shifts");
  await page.getByRole("tab", { name: /Unassigned/ }).click();
  await page.getByTestId("unassigned-search").fill("shifty");
  await page.getByTestId("unassigned-select-SH-C1").click();
  await page.getByTestId("unassigned-select-SH-C2").click();
  await page.getByTestId("unassigned-assign-selected").click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByTestId(`chip-employee-${w.emp["SH-C1"]}`)).toHaveAttribute("data-mode", "include");
  await dialog(page).getByTestId("assign-shift-select").click();
  await page.getByRole("option", { name: /SH Morning/ }).click();
  await expect(row(page, "SH-C1")).toHaveAttribute("data-status", "new");
  await expect(row(page, "SH-C2")).toHaveAttribute("data-status", "new");
  await dialog(page).getByTestId("assign-confirm").click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await assignments(page)).map((a) => a.employeeCode).sort()).toEqual(["SH-C1", "SH-C2"]);
  await expect(page.getByTestId("unassigned-row-SH-C1")).toHaveCount(0);
  await expect(page.getByTestId("unassigned-row-SH-S1")).toBeVisible();
});

test("a View-only role can look at every tab but cannot assign, edit or remove", async ({ page }) => {
  await loginAsHr(page);
  const w = await world(page);
  await put(page, w, "SH-S1", w.morning, ago(20));
  const admin = await adminToken(page);
  const stamp = Date.now().toString(36);
  const role = await api(
    page,
    "POST",
    "/api/roles",
    { name: `e2e-sh-view-${stamp}`, permissions: { shifts: "view" } },
    admin,
  );
  expect(role.status).toBe(201);
  const username = `e2e_sh_view_${stamp}`;
  const user = await api(
    page,
    "POST",
    "/api/hr-users",
    { username, password: "E2e-Limited-1!", roleId: role.body.id },
    admin,
  );
  expect(user.status).toBe(201);
  try {
    const login = await page.request.post("/api/auth/hr-login", { data: { username, password: "E2e-Limited-1!" } });
    const token = (await login.json()).token as string;
    await page.evaluate((t) => localStorage.setItem("uk_textile_token", t), token);
    await page.goto("/hr/shifts");
    await expect(page.getByTestId(`shift-card-${w.morning}`)).toBeVisible();
    await expect(page.getByTestId(`shift-assign-${w.morning}`)).toBeDisabled();
    await expect(page.getByTestId(`shift-edit-${w.morning}`)).toBeDisabled();
    await expect(page.getByTestId(`shift-delete-${w.morning}`)).toBeDisabled();
    await expect(page.getByTestId("new-shift")).toBeDisabled();
    await page.getByRole("tab", { name: /Assign(ments|ed)/ }).click();
    await page.getByTestId(`group-toggle-${w.morning}`).click();
    await expect(page.getByTestId("member-SH-S1")).toBeVisible();
    await expect(page.getByTestId("member-remove-SH-S1")).toBeDisabled();
    await expect(page.getByTestId("member-move-SH-S1")).toBeDisabled();
    await expect(page.getByTestId("member-edit-SH-S1")).toBeDisabled();
    // and the API refuses
    const denied = await api(
      page,
      "POST",
      "/api/shift-assignments/apply",
      { shiftId: w.morning, effectiveFrom: ago(0), selection: { includeAll: true } },
      token,
    );
    expect(denied.status).toBe(403);
  } finally {
    await api(page, "DELETE", `/api/hr-users/${user.body.id}`, undefined, admin);
    await api(page, "DELETE", `/api/roles/${role.body.id}`, undefined, admin);
  }
});

test("the page and the assign dialog fit a phone and a laptop, with screenshots for review", async ({
  page,
}, testInfo: TestInfo) => {
  await loginAsHr(page);
  const w = await world(page);
  await put(page, w, "SH-S2", w.evening, ago(30));
  const noSideways = async (what: string) => {
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(wide, `${what} scrolls sideways by ${wide}px`).toBeLessThanOrEqual(0);
  };
  for (const [label, size] of [
    ["desktop", { width: 1366, height: 860 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(size);
    await page.goto("/hr/shifts");
    await expect(page.getByTestId(`shift-card-${w.morning}`)).toBeVisible();
    await noSideways(`${label} shifts`);
    await page.screenshot({ path: testInfo.outputPath(`${label}-1-shifts.png`) });

    await page.getByRole("tab", { name: /Assign(ments|ed)/ }).click();
    await page.getByTestId(`group-toggle-${w.evening}`).click();
    await expect(page.getByTestId("member-SH-S2")).toBeVisible();
    await noSideways(`${label} assignments`);
    await page.screenshot({ path: testInfo.outputPath(`${label}-2-assignments.png`) });

    await page
      .getByRole("tab", { name: /Shifts/ })
      .first()
      .click();
    await page.getByTestId(`shift-assign-${w.morning}`).click();
    await expect(dialog(page)).toBeVisible();
    await include(page, "department", w.stitching);
    await exclude(page, "employee", w.emp["SH-S3"]);
    await expect(row(page, "SH-S2")).toBeVisible();
    await dialog(page).evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const box = (await dialog(page).boundingBox())!;
    expect(box.x, `${label} dialog left`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${label} dialog right`).toBeLessThanOrEqual(size.width + 0.5);
    expect(box.y + box.height, `${label} dialog bottom`).toBeLessThanOrEqual(size.height + 0.5);
    await expect(dialog(page).getByTestId("assign-confirm")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${label}-3-assign.png`) });
    await page.keyboard.press("Escape");

    await page.getByTestId("new-shift").click();
    await expect(page.getByTestId("shift-form-dialog")).toBeVisible();
    await page
      .getByTestId("shift-form-dialog")
      .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: testInfo.outputPath(`${label}-4-form.png`) });
    await page.keyboard.press("Escape");
  }
});
