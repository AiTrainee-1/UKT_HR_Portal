import { expect, test, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// User Management -> Approval Workflow Control: every approval in the HRMS with its pipeline, an ON/OFF switch and an
// editor. The rules (who may decide when, what OFF means, what happens to requests already waiting) are covered by
// api/tests_approval_workflow.py; this is the page, and that what it saves is what the API every client reads now says.

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const card = (page: Page, key: string) => page.getByTestId(`wf-card-${key}`);
const pathText = (page: Page, key: string) => page.getByTestId(`wf-path-text-${key}`);
const toast = (page: Page, text: string) => page.getByText(text).first();
// the toolbar button (an empty HOD list shows a second one in its empty state)
const createUser = (page: Page) => page.getByRole("button", { name: "Create User" }).first();

type Reply = { status: number; body: Record<string, unknown> | null };
type Summary = Record<string, { path: string; enabled: boolean; steps: { roles: string[]; mandatory: boolean }[] }>;

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

async function adminToken(page: Page): Promise<string> {
  const res = await page.request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  return (await res.json()).token as string;
}

async function summary(page: Page): Promise<Summary> {
  return (await api(page, "GET", "/api/approval-summary")).body as unknown as Summary;
}

async function openApprovals(page: Page) {
  await loginAsHr(page);
  await page.goto("/hr/user-management");
  await tab(page, "Approval Workflow Control").click();
  await expect(page.getByTestId("approval-workflow-control")).toBeVisible();
  await expect(card(page, "leave")).toBeVisible();
}

// Swap the signed-in person. The page is already on the app's origin (the admin signed in first), and the next
// page.goto() reads the token when the app starts.
async function signInWithToken(page: Page, token: string) {
  await page.evaluate((t) => localStorage.setItem("uk_textile_token", t), token);
}

test.describe.configure({ mode: "serial" });

// Every test hands the built-in pipelines back, whatever happened inside it: the rest of the suite files requests.
const TOUCHED = ["leave", "permission", "missing_punch", "on_duty", "outpass", "request", "advance"];
const leaveIds: number[] = [];

test.afterEach(async ({ page }) => {
  const token = await adminToken(page);
  for (const key of TOUCHED) await api(page, "DELETE", `/api/approval-workflows/${key}`, undefined, token);
  for (const id of leaveIds.splice(0)) await api(page, "DELETE", `/api/leave-requests/${id}`, undefined, token);
});

test("Approval Workflow Control is the second User Management tab and lists every approval with its pipeline", async ({
  page,
}) => {
  await loginAsHr(page);
  await page.goto("/hr/user-management");
  await expect(page.getByRole("heading", { name: "User Management" })).toBeVisible();
  // HOD Assignment is still the page's first tab, exactly as it was
  await expect(tab(page, "HOD Assignment")).toBeVisible();
  await expect(createUser(page)).toBeVisible();

  await tab(page, "Approval Workflow Control").click();
  const control = page.getByTestId("approval-workflow-control");
  await expect(control).toBeVisible();
  // the page never assigns anybody: the introduction says where that is done
  await expect(control).toContainText("Nothing is assigned here");
  await expect(control).toContainText("HOD Assignment");
  for (const group of ["Leave & attendance", "Requests", "Recruitment & payroll"]) {
    await expect(control).toContainText(group);
  }

  const expected: Record<string, string> = {
    leave: "Employee → HOD or HR",
    permission: "Employee → HOD or HR",
    casual_leave: "Employee → HOD or HR",
    missing_punch: "Employee → HOD → HR",
    on_duty: "Employee → HOD → HR",
    on_duty_punch: "Employee → HR",
    attendance_correction: "HR → HOD",
    outpass: "Employee → HOD or HR",
    request: "Employee → HR",
    resignation: "Employee → HOD → HR",
    advance: "HR → HR",
  };
  await expect(page.locator('[data-testid^="wf-card-"]')).toHaveCount(Object.keys(expected).length);
  for (const [key, text] of Object.entries(expected)) await expect(pathText(page, key), key).toHaveText(text);

  // each card says what the request is for; nothing starts out customised or switched off
  await expect(card(page, "missing_punch")).toContainText("forgot to punch");
  await expect(card(page, "resignation")).toContainText("HR can always reject a resignation");
  await expect(page.locator('[data-testid^="wf-customised-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="wf-off-badge-"]')).toHaveCount(0);
  // the per-person switch on a Department Head's profile is a hint, not a warning about the pipeline
  await expect(page.getByTestId("wf-hint-leave")).toContainText("Can approve leaves");
  await expect(page.getByTestId("wf-warnings-leave")).toHaveCount(0);

  // the apps read the same pipelines from one public endpoint
  const s = await summary(page);
  for (const [key, text] of Object.entries(expected)) expect(s[key].path, key).toBe(text);
});

test("HR can change who is responsible and the order; it reaches the API, survives a reload and can be restored", async ({
  page,
}) => {
  await openApprovals(page);
  await page.getByTestId("wf-edit-leave").click();
  await expect(page.getByTestId("wf-editor-leave")).toBeVisible();

  // "HOD or HR" is the only step: give it to HR, then add the Department Head after it
  await page.getByTestId("wf-role-leave-0").selectOption("hr");
  await page.getByTestId("wf-add-leave").click();
  await expect(page.getByTestId("wf-role-leave-1")).toHaveValue("hod");
  await expect(page.getByTestId("wf-preview-leave")).toHaveText("Employee → HR → HOD");
  // two steps is the most a pipeline has: nothing more can be added
  await expect(page.getByTestId("wf-add-leave")).toBeDisabled();
  await page.getByTestId("wf-save-leave").click();
  await expect(toast(page, "Leave pipeline updated")).toBeVisible();
  await expect(pathText(page, "leave")).toHaveText("Employee → HR → HOD");
  await expect(page.getByTestId("wf-customised-leave")).toBeVisible();

  let s = await summary(page);
  expect(s.leave.path).toBe("Employee → HR → HOD");
  expect(s.leave.steps.map((step) => step.roles)).toEqual([["hr"], ["hod"]]);
  // nothing else moved
  expect(s.permission.path).toBe("Employee → HOD or HR");

  // it is saved on the server, not in the page
  await page.reload();
  await tab(page, "Approval Workflow Control").click();
  await expect(pathText(page, "leave")).toHaveText("Employee → HR → HOD");
  await expect(page.getByTestId("wf-customised-leave")).toBeVisible();

  // swap the order (Employee → HR → HOD becomes Employee → HOD → HR)
  await page.getByTestId("wf-edit-leave").click();
  await page.getByTestId("wf-up-leave-1").click();
  await expect(page.getByTestId("wf-preview-leave")).toHaveText("Employee → HOD → HR");
  // the last step can never be skipped, so it is always mandatory
  await expect(page.getByTestId("wf-mandatory-leave-1")).toBeDisabled();
  await expect(page.getByTestId("wf-mandatory-leave-1")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("wf-save-leave").click();
  await expect(pathText(page, "leave")).toHaveText("Employee → HOD → HR");
  s = await summary(page);
  expect(s.leave.steps.map((step) => step.roles)).toEqual([["hod"], ["hr"]]);

  // back to the built-in pipeline
  await page.getByTestId("wf-reset-leave").click();
  await page.getByTestId("wf-confirm-leave").click();
  await expect(toast(page, "Leave is back to its built-in pipeline")).toBeVisible();
  await expect(pathText(page, "leave")).toHaveText("Employee → HOD or HR");
  await expect(page.getByTestId("wf-customised-leave")).toHaveCount(0);
  s = await summary(page);
  expect(s.leave.path).toBe("Employee → HOD or HR");
});

test("Save waits for a real change, Cancel discards, and a step can be optional or removed", async ({ page }) => {
  await openApprovals(page);
  await page.getByTestId("wf-edit-missing_punch").click();
  await expect(page.getByTestId("wf-save-missing_punch")).toBeDisabled();
  await expect(page.getByTestId("wf-add-missing_punch")).toBeDisabled();

  // the Department Head step becomes optional (the last step stays mandatory) ...
  await page.getByTestId("wf-mandatory-missing_punch-0").click();
  await expect(page.getByTestId("wf-mandatory-missing_punch-0")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("wf-save-missing_punch")).toBeEnabled();
  // ... and Cancel throws that away
  await page.getByTestId("wf-cancel-missing_punch").click();
  await expect(page.getByTestId("wf-editor-missing_punch")).toHaveCount(0);
  await page.getByTestId("wf-edit-missing_punch").click();
  await expect(page.getByTestId("wf-mandatory-missing_punch-0")).toHaveAttribute("aria-checked", "true");

  // now really save it: an optional step, which the pipeline strip and the API both say
  await page.getByTestId("wf-mandatory-missing_punch-0").click();
  await page.getByTestId("wf-save-missing_punch").click();
  await expect(toast(page, "Missing Punch pipeline updated")).toBeVisible();
  await expect(page.getByTestId("wf-path-missing_punch")).toContainText("optional");
  expect((await summary(page)).missing_punch.steps.map((step) => step.mandatory)).toEqual([false, true]);

  // remove the HR step: HR is then no longer part of it, and the page says what that means
  await page.getByTestId("wf-edit-missing_punch").click();
  await page.getByTestId("wf-remove-missing_punch-1").click();
  await expect(page.getByTestId("wf-preview-missing_punch")).toHaveText("Employee → HOD");
  await expect(page.getByTestId("wf-remove-missing_punch-0")).toBeDisabled();
  await page.getByTestId("wf-save-missing_punch").click();
  await expect(pathText(page, "missing_punch")).toHaveText("Employee → HOD");
  await expect(page.getByTestId("wf-warnings-missing_punch")).toContainText("HR is not part of this pipeline");
  expect((await summary(page)).missing_punch.path).toBe("Employee → HOD");
});

test("switching a workflow OFF asks first, refuses new requests with a clear message, and ON accepts them again", async ({
  page,
}) => {
  await openApprovals(page);

  // a workflow with its own wording says what OFF does to it
  await page.getByTestId("wf-toggle-advance").click();
  await expect(page.getByRole("alertdialog")).toContainText("HR cannot record new advances while it is off");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("wf-toggle-advance")).toHaveAttribute("aria-checked", "true");

  await page.getByTestId("wf-toggle-leave").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Switch off Leave?");
  await expect(dialog).toContainText("requests already waiting can still be decided");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("wf-toggle-leave")).toHaveAttribute("aria-checked", "true");
  expect((await summary(page)).leave.enabled).toBe(true);

  await page.getByTestId("wf-toggle-leave").click();
  await page.getByTestId("wf-confirm-leave").click();
  await expect(toast(page, "Leave switched OFF")).toBeVisible();
  await expect(page.getByTestId("wf-off-badge-leave")).toBeVisible();
  await expect(page.getByTestId("wf-warnings-leave")).toContainText("Switched OFF");
  await expect(page.getByTestId("wf-toggle-leave")).toHaveAttribute("aria-checked", "false");
  expect((await summary(page)).leave.enabled).toBe(false);

  // a new request is refused with a message the person can read (an old app shows the error text as it is)
  const employees = (await api(page, "GET", "/api/employees")).body as unknown as {
    id: number;
    employeeCode: string;
  }[];
  const asha = employees.find((e) => e.employeeCode === "E2E001")!;
  const refused = await api(page, "POST", "/api/leave-requests", {
    employeeId: asha.id,
    startDate: "2026-03-09",
    endDate: "2026-03-09",
    type: "casual",
  });
  expect(refused.status).toBe(403);
  expect(refused.body).toMatchObject({
    code: "workflow_disabled",
    error: "Leave requests are switched off right now. Please contact HR.",
  });

  // ON needs no confirmation; the workflow is exactly as it was, so it is no longer customised
  await page.getByTestId("wf-toggle-leave").click();
  await expect(toast(page, "Leave switched ON")).toBeVisible();
  await expect(page.getByTestId("wf-off-badge-leave")).toHaveCount(0);
  await expect(page.getByTestId("wf-customised-leave")).toHaveCount(0);
  expect((await summary(page)).leave.enabled).toBe(true);
});

test("fixed pipelines cannot be edited or switched off, and the server refuses an invalid edit", async ({ page }) => {
  await openApprovals(page);
  for (const key of ["on_duty_punch", "attendance_correction", "request", "advance"]) {
    await expect(page.getByTestId(`wf-fixed-${key}`), key).toBeVisible();
    await expect(page.getByTestId(`wf-edit-${key}`), key).toHaveCount(0);
  }
  // On-Duty punch verification belongs to On-Duty: it has no switch of its own; the others can still be switched off
  await expect(page.getByTestId("wf-toggle-on_duty_punch")).toBeDisabled();
  await expect(page.getByTestId("wf-toggle-request")).toBeEnabled();
  await expect(page.getByTestId("wf-edit-leave")).toBeVisible();

  const refuse = async (key: string, body: unknown, status = 400) =>
    expect(
      (await api(page, "PUT", `/api/approval-workflows/${key}`, body)).status,
      `${key} ${JSON.stringify(body)}`,
    ).toBe(status);
  await refuse("on_duty_punch", { enabled: false });
  await refuse("request", { steps: [{ roles: ["hod"], mandatory: true }] }); // no Department Head screen exists for it
  await refuse("leave", { steps: [] });
  await refuse("leave", {
    steps: [
      { roles: ["hr"], mandatory: true },
      { roles: ["hr"], mandatory: true },
    ],
  }); // a role can only sit in one step
  await refuse("leave", {
    steps: [
      { roles: ["hod", "hr"], mandatory: true },
      { roles: ["hr"], mandatory: true },
    ],
  }); // "HOD or HR" only as the single step
  await refuse("leave", { steps: [{ roles: ["employee"], mandatory: true }] });
  await refuse("leave", { enabled: "off" });
  await refuse("leave", {});
  await refuse("nope", { enabled: false }, 404);

  // none of that changed anything
  const s = await summary(page);
  expect(s.leave.path).toBe("Employee → HOD or HR");
  expect(s.leave.enabled).toBe(true);
  expect(s.on_duty_punch.enabled).toBe(true);
});

test("saving a change while requests are waiting says so first, and does not decide the waiting request", async ({
  page,
}) => {
  await openApprovals(page);
  const employees = (await api(page, "GET", "/api/employees")).body as unknown as {
    id: number;
    employeeCode: string;
  }[];
  const asha = employees.find((e) => e.employeeCode === "E2E001")!;
  const created = await api(page, "POST", "/api/leave-requests", {
    employeeId: asha.id,
    startDate: "2026-03-09",
    endDate: "2026-03-09",
    type: "casual",
  });
  expect(created.status).toBe(201);
  const requestId = created.body!.id as number;
  leaveIds.push(requestId);

  const requestNow = async () => {
    const list = (await api(page, "GET", `/api/leave-requests?employeeId=${asha.id}`)).body as unknown as {
      id: number;
      status: string;
      approval: { canAct: { hod: boolean; hr: boolean }; waitingFor: string[] };
    }[];
    return list.find((r) => r.id === requestId)!;
  };
  // under the built-in pipeline whoever acts first can decide it
  let leave = await requestNow();
  expect(leave.status).toBe("pending");
  expect(leave.approval.canAct).toEqual({ hod: true, hr: true });

  await page.reload();
  await tab(page, "Approval Workflow Control").click();
  await expect(page.getByTestId("wf-waiting-leave")).toContainText("1 waiting now");

  await page.getByTestId("wf-edit-leave").click();
  await page.getByTestId("wf-role-leave-0").selectOption("hr");
  await page.getByTestId("wf-save-leave").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("1 request(s) are waiting right now");
  await expect(dialog).toContainText("nothing is approved or rejected by this change");
  await dialog.getByTestId("wf-confirm-leave").click();
  await expect(toast(page, "Leave pipeline updated")).toBeVisible();
  await expect(page.getByTestId("wf-waiting-leave")).toContainText("HR can decide 1");
  await expect(page.getByTestId("wf-waiting-leave")).toContainText("HOD can decide 0");

  // the waiting request follows the new pipeline from where it is: still pending, now HR's alone
  leave = await requestNow();
  expect(leave.status).toBe("pending");
  expect(leave.approval.canAct).toEqual({ hod: false, hr: true });
  expect(leave.approval.waitingFor).toEqual(["hr"]);
});

test("HOD Assignment keeps its Create User dialog, now with the missing punch switch", async ({ page }) => {
  await loginAsHr(page);
  await page.goto("/hr/user-management");
  await createUser(page).click();
  // the dialog lists every permission as a card (hod-roster.spec.ts covers the picker itself)
  await expect(page.getByRole("dialog")).toContainText("Missing punch");
  await expect(page.getByRole("dialog")).toContainText("Leave");
  await expect(page.getByRole("dialog").locator('[data-testid^="perm-can"]')).toHaveCount(7);
});

test("a role sees only the tabs it has, and View only cannot change a pipeline", async ({ page }) => {
  await loginAsHr(page);
  const admin = await adminToken(page);
  const stamp = Date.now().toString(36);
  const made: { userId: number; roleId: number }[] = [];

  const limited = async (name: string, permissions: Record<string, string>) => {
    const role = await api(page, "POST", "/api/roles", { name: `e2e-${name}-${stamp}`, permissions }, admin);
    expect(role.status).toBe(201);
    const username = `e2e_${name}_${stamp}`;
    const password = "E2e-Limited-1!";
    const user = await api(page, "POST", "/api/hr-users", { username, password, roleId: role.body!.id }, admin);
    expect(user.status).toBe(201);
    made.push({ userId: user.body!.id as number, roleId: role.body!.id as number });
    const login = await page.request.post("/api/auth/hr-login", { data: { username, password } });
    expect(login.status()).toBe(200);
    return (await login.json()).token as string;
  };

  try {
    const editor = await limited("wf-editor", { "user_management.approval_workflow": "edit" });
    const viewer = await limited("wf-viewer", { "user_management.approval_workflow": "view" });
    const hodOnly = await limited("wf-hod", { user_management: "edit", "user_management.approval_workflow": "hidden" });

    // a role that has only Approval Workflow Control gets the page with that one tab, and it works
    await signInWithToken(page, editor);
    await page.goto("/hr/user-management");
    await expect(page.getByTestId("approval-workflow-control")).toBeVisible();
    await expect(tab(page, "Approval Workflow Control")).toBeVisible();
    await expect(tab(page, "HOD Assignment")).toHaveCount(0);
    await expect(page.getByTestId("wf-edit-leave")).toBeEnabled();
    await expect(page.getByTestId("wf-toggle-leave")).toBeEnabled();
    await expect(page.getByText("View only")).toHaveCount(0);
    expect((await api(page, "PUT", "/api/approval-workflows/leave", { enabled: true }, editor)).status).toBe(200);
    expect((await api(page, "GET", "/api/department-managers", undefined, editor)).status).toBe(403);

    // View only: everything is visible, nothing can be changed (the page locks the buttons, the API refuses)
    await signInWithToken(page, viewer);
    await page.goto("/hr/user-management");
    await expect(page.getByTestId("approval-workflow-control")).toBeVisible();
    await expect(page.getByText("View only").first()).toBeVisible();
    await expect(page.getByTestId("wf-edit-leave")).toBeDisabled();
    await expect(page.getByTestId("wf-toggle-leave")).toBeDisabled();
    await expect(pathText(page, "leave")).toHaveText("Employee → HOD or HR");
    expect((await api(page, "GET", "/api/approval-workflows", undefined, viewer)).status).toBe(200);
    expect((await api(page, "PUT", "/api/approval-workflows/leave", { enabled: false }, viewer)).status).toBe(403);
    expect((await api(page, "DELETE", "/api/approval-workflows/leave", undefined, viewer)).status).toBe(403);

    // a role with HOD Assignment but not Approval Workflow Control gets only the first tab
    await signInWithToken(page, hodOnly);
    await page.goto("/hr/user-management");
    await expect(createUser(page)).toBeVisible();
    await expect(tab(page, "HOD Assignment")).toBeVisible();
    await expect(tab(page, "Approval Workflow Control")).toHaveCount(0);
    expect((await api(page, "GET", "/api/approval-workflows", undefined, hodOnly)).status).toBe(403);
    // the pipelines themselves are not secret: the apps read them for any signed-in person
    expect((await api(page, "GET", "/api/approval-summary", undefined, hodOnly)).status).toBe(200);
    expect((await summary(page)).leave.path).toBe("Employee → HOD or HR");
  } finally {
    for (const { userId, roleId } of made) {
      await api(page, "DELETE", `/api/hr-users/${userId}`, undefined, admin);
      await api(page, "DELETE", `/api/roles/${roleId}`, undefined, admin);
    }
  }
});
