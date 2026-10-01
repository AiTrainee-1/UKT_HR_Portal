import { expect, test, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// The HR screens follow the approval pipeline HR configured in User Management -> Approval Workflow Control: an Approve /
// Reject button appears only when it is HR's turn under that pipeline, a request says who it is waiting for, and the
// sidebar badge counts only what HR can decide. (approval-workflow.spec.ts covers the configuration page itself, and
// api/tests_approval_workflow.py the rules; this is what HR sees and can do on the screens that use them.)

const FAKE_WACLIENT = "http://127.0.0.1:8190";
const EMPLOYEE_CODE = "E2E003";
// The password auth.spec.ts also sets for this employee, so whichever spec activates the account first, both can sign in.
const EMPLOYEE_PASSWORD = "employee-pass-1";

type Reply = { status: number; body: Record<string, unknown> | null };

// An employee may only request a date in the current month, and a Missing Punch never one in the future, so the spec
// asks for today (in India, the clock the server uses) rather than a fixed date that falls out of the window.
const todayInIndia = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

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

// An employee's own token: the account is activated with the code the fake WAClient receives (as auth.spec.ts does), or
// simply signed in when it was already activated.
async function employeeToken(page: Page): Promise<string> {
  await page.request.post(`${FAKE_WACLIENT}/reset`);
  const ask = await page.request.post("/api/auth/otp/request", {
    data: { employeeCode: EMPLOYEE_CODE, purpose: "activate" },
  });
  if (ask.status() === 200) {
    const sent = await (await page.request.get(`${FAKE_WACLIENT}/messages`)).json();
    const otp = sent[0].message.match(/\b(\d{6})\b/)![1];
    const activate = await page.request.post("/api/auth/otp/activate", {
      data: { employeeCode: EMPLOYEE_CODE, otp, password: EMPLOYEE_PASSWORD },
    });
    expect(activate.status()).toBe(200);
  } else {
    expect(ask.status()).toBe(409); // already activated
  }
  const login = await page.request.post("/api/auth/employee-login", {
    data: { identifier: EMPLOYEE_CODE, password: EMPLOYEE_PASSWORD },
  });
  expect(login.status()).toBe(200);
  return (await login.json()).token as string;
}

async function employeeId(page: Page, code: string): Promise<number> {
  const list = (await api(page, "GET", "/api/employees")).body as unknown as { id: number; employeeCode: string }[];
  return list.find((e) => e.employeeCode === code)!.id;
}

const steps = (...roles: ("hod" | "hr")[]) => ({ steps: roles.map((r) => ({ roles: [r], mandatory: true })) });
const configure = async (page: Page, key: string, body: unknown) =>
  expect((await api(page, "PUT", `/api/approval-workflows/${key}`, body)).status, key).toBe(200);

// The number on a sidebar entry (0 when it has no badge).
async function sidebarBadge(page: Page, label: string): Promise<number> {
  const text = await page
    .getByRole("link", { name: new RegExp(`^${label}(\\s+\\d+)?$`) })
    .first()
    .innerText();
  return Number(text.match(/\d+/)?.[0] ?? 0);
}

const buttons = (scope: ReturnType<Page["getByTestId"]>, name: "Approve" | "Reject") =>
  scope.getByRole("button", { name, exact: true });

test.describe.configure({ mode: "serial" });

// Every test hands the built-in pipelines back and removes what it made, whatever happened inside it.
const TOUCHED = ["leave", "permission", "missing_punch", "resignation"];
const made = {
  leave: [] as number[],
  permission: [] as number[],
  missingPunch: [] as number[],
  resignation: [] as number[],
};

test.afterEach(async ({ page }) => {
  const token = await adminToken(page);
  for (const key of TOUCHED) await api(page, "DELETE", `/api/approval-workflows/${key}`, undefined, token);
  for (const id of made.leave.splice(0)) await api(page, "DELETE", `/api/leave-requests/${id}`, undefined, token);
  for (const id of made.permission.splice(0)) await api(page, "DELETE", `/api/permissions/${id}`, undefined, token);
  for (const id of made.missingPunch.splice(0))
    await api(page, "DELETE", `/api/missing-punch-requests/${id}/status`, undefined, token);
  for (const id of made.resignation.splice(0))
    await api(page, "DELETE", `/api/recruitment/resignations/${id}/delete`, undefined, token);
});

test("Leave, Permission and Requests give HR buttons only on HR's turn, say who a request waits for, and the badge follows", async ({
  page,
}) => {
  await loginAsHr(page);
  const asha = await employeeId(page, "E2E001");
  const leave = await api(page, "POST", "/api/leave-requests", {
    employeeId: asha,
    startDate: "2026-03-16",
    endDate: "2026-03-16",
    type: "casual",
    reason: "e2e pipeline",
  });
  expect(leave.status).toBe(201);
  const leaveId = leave.body!.id as number;
  made.leave.push(leaveId);
  const permission = await api(page, "POST", "/api/permissions", {
    employeeId: asha,
    date: "2026-03-16",
    type: "Late In",
    permissionTime: "09:30",
    reason: "e2e pipeline",
  });
  expect(permission.status, JSON.stringify(permission.body)).toBe(201);
  const permissionId = permission.body!.id as number;
  made.permission.push(permissionId);

  const leaveCard = page.getByTestId(`leave-${leaveId}`);
  const permissionCard = page.getByTestId(`permission-${permissionId}`);

  // ── built-in pipeline (HOD or HR, whoever acts first): HR can decide, nothing to explain ──
  await page.goto("/hr/leave");
  await expect(leaveCard).toBeVisible();
  await expect(page.getByTestId("pipeline-note-leave")).toContainText("Employee → HOD or HR");
  await expect(buttons(leaveCard, "Approve")).toBeVisible();
  await expect(buttons(leaveCard, "Reject")).toBeVisible();
  await expect(leaveCard).not.toContainText("Waiting for");
  await expect.poll(() => sidebarBadge(page, "Requests")).toBeGreaterThanOrEqual(2);
  const all = await sidebarBadge(page, "Requests");

  // ── HOD only: HR is not in the pipeline, so HR can watch but not decide, and the badge leaves it out ──
  await configure(page, "leave", steps("hod"));
  await page.reload();
  await expect(leaveCard).toContainText("Waiting for HOD");
  await expect(buttons(leaveCard, "Approve")).toHaveCount(0);
  await expect(buttons(leaveCard, "Reject")).toHaveCount(0);
  await expect(page.getByTestId("pipeline-note-leave")).toContainText("Employee → HOD");
  await expect.poll(() => sidebarBadge(page, "Requests")).toBe(all - 1);
  // the details dialog agrees: the step trail, and no decision buttons
  await leaveCard.click();
  await expect(page.getByRole("dialog").getByTestId("approval-trail")).toContainText("HOD");
  await expect(buttons(page.getByRole("dialog"), "Approve")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // the permission is still on the built-in pipeline; switch it too and the Permissions tab follows
  await page.getByRole("tab", { name: "Permissions", exact: true }).click();
  await expect(permissionCard).toBeVisible();
  await expect(buttons(permissionCard, "Approve")).toBeVisible();
  await configure(page, "permission", steps("hod"));
  await page.reload();
  await page.getByRole("tab", { name: "Permissions", exact: true }).click();
  await expect(permissionCard).toContainText("Waiting for HOD");
  await expect(buttons(permissionCard, "Approve")).toHaveCount(0);
  await expect(buttons(permissionCard, "Reject")).toHaveCount(0);
  await expect.poll(() => sidebarBadge(page, "Requests")).toBe(all - 2);

  // the Requests page: same request, same answer
  await page.goto("/hr/requests");
  const requestCard = page.getByTestId(`request-leave-${leaveId}`);
  await expect(requestCard).toContainText("Waiting for HOD");
  await expect(buttons(requestCard, "Approve")).toHaveCount(0);
  await expect(page.getByTestId("pipeline-summary")).toContainText("Leave");

  // ── HR only: it is HR's turn, and the decision goes through ──
  await configure(page, "leave", steps("hr"));
  await page.reload();
  await expect(requestCard).toBeVisible();
  await expect(requestCard).not.toContainText("Waiting for");
  await buttons(requestCard, "Approve").click();
  await expect(page.getByText("Leave approved").first()).toBeVisible();
  await expect(requestCard).toContainText("approved");
  await expect(buttons(requestCard, "Approve")).toHaveCount(0);

  // ── the note leads to the configuration page ──
  await page.goto("/hr/leave");
  await page.getByTestId("pipeline-note-leave").getByRole("link", { name: "Change" }).click();
  await expect(page).toHaveURL(/\/hr\/user-management\?tab=approvals/);
  await expect(page.getByTestId("approval-workflow-control")).toBeVisible();
});

test("Missing Punch: HR decides only on its turn; a request waiting for the HOD says so", async ({ page }) => {
  await loginAsHr(page);
  const employee = await employeeToken(page);
  const created = await api(
    page,
    "POST",
    "/api/missing-punch-requests",
    { date: todayInIndia(), punchTime: "09:05", punchSlot: "morning_in", reason: "e2e pipeline" },
    employee,
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body!.id as number;
  made.missingPunch.push(id);
  const row = page.getByTestId(`missing-punch-${id}`);

  // built-in pipeline: the HOD first, then HR
  await page.goto("/hr/missing-punch");
  await expect(page.getByTestId("pipeline-note-missing_punch")).toContainText("Employee → HOD → HR");
  await expect(row).toContainText("Waiting for HOD");
  await expect(row).toContainText("HR cannot decide this request until that step is done");
  await expect(buttons(row, "Approve")).toHaveCount(0);
  await expect(buttons(row, "Reject")).toHaveCount(0);

  // HR only: the request is HR's now (an older status label for it, "Awaiting HR", is fine) and the buttons appear
  await configure(page, "missing_punch", steps("hr"));
  await page.reload();
  await expect(page.getByTestId("pipeline-note-missing_punch")).toContainText("Employee → HR");
  await expect(row).toContainText("Awaiting HR");
  await expect(buttons(row, "Approve")).toBeVisible();
  await buttons(row, "Reject").click();
  await expect(page.getByText("Missing Punch rejected").first()).toBeVisible();
  await expect(row).toHaveCount(0); // it left the Pending list
});

test("Resignations: the stepper follows the pipeline, HR may always reject, and an approval says whether it is final", async ({
  page,
}) => {
  await loginAsHr(page);
  const employee = await employeeToken(page);
  const created = await api(page, "POST", "/api/my/resignation", { reason: "e2e pipeline" }, employee);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body!.id as number;
  made.resignation.push(id);
  const row = page.getByTestId(`resignation-${id}`);

  // built-in pipeline (HOD then HR): waiting for the HOD; HR cannot approve yet but may reject
  await page.goto("/hr/recruitment/resignations");
  await expect(page.getByTestId("pipeline-note-resignation")).toContainText("Employee → HOD → HR");
  await expect(row).toBeVisible();
  // the stepper is the row's status: the HOD's step is pending, HR's is not reached yet
  await expect(row.getByTestId("approval-trail")).toContainText(/SubmittedHODPendingHRNot reached/);
  await expect(buttons(row, "Approve")).toHaveCount(0);
  await expect(buttons(row, "Reject")).toBeVisible();
  // the details dialog says it in words
  await row.getByRole("button", { name: "View" }).click();
  await expect(page.getByRole("dialog")).toContainText("Waiting for HOD");
  await page.keyboard.press("Escape");

  // HR first, then the HOD: it is HR's turn, but HR's approval is not the last one
  await configure(page, "resignation", steps("hr", "hod"));
  await page.reload();
  await expect(page.getByTestId("pipeline-note-resignation")).toContainText("Employee → HR → HOD");
  await expect(row.getByTestId("approval-trail")).toContainText(/SubmittedHRPendingHODNot reached/);
  await buttons(row, "Approve").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Approve Resignation?");
  await expect(dialog).not.toContainText("Final Approve");
  await expect(dialog).toContainText("It still needs HOD before it is final");
  await expect(dialog).toContainText("the account stays Active until then");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // HR only: its approval would be final, and the dialog says what that does; leave it undecided
  await configure(page, "resignation", steps("hr"));
  await page.reload();
  await buttons(row, "Approve").click();
  await expect(page.getByRole("alertdialog")).toContainText("Final Approve Resignation?");
  await expect(page.getByRole("alertdialog")).toContainText("Inactive");
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();

  // back to the built-in pipeline: waiting for the HOD again, and HR rejects it out of turn
  await api(page, "DELETE", "/api/approval-workflows/resignation");
  await page.reload();
  await expect(row.getByTestId("approval-trail")).toContainText(/SubmittedHODPendingHRNot reached/);
  await buttons(row, "Reject").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Yes, Reject" }).click();
  await expect(page.getByText("Resignation Rejected").first()).toBeVisible();
  await expect(row).toHaveCount(0); // it left the Active tab
});
