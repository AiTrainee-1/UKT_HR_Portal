import { expect, test, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// Requests -> HoD's and Notify (2026-11-04): every Department Head with what is pending WITH them, and the scheduled
// reminder that goes to each of them. Ravi (E2E002) is made a Department Head of Asha (E2E001), Asha asks for a leave,
// and the board, the drill-down, the preview and a "Send now" round are checked. The only WhatsApp here is the fake
// WAClient of the e2e stack; nobody has a phone registered for push and no SMTP is set up, so nothing real goes out.

const FAKE_WACLIENT = "http://127.0.0.1:8190";

type Reply = { status: number; body: Record<string, unknown> | null };

async function api(page: Page, method: string, url: string, data?: unknown, token?: string): Promise<Reply> {
  const bearer = token ?? (await page.evaluate(() => localStorage.getItem("uk_textile_token")));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${bearer}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function adminToken(page: Page): Promise<string> {
  const res = await page.request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  return (await res.json()).token as string;
}

const made = { manager: null as number | null, leave: null as number | null };

test.afterEach(async ({ page }) => {
  const token = await adminToken(page);
  if (made.leave) await api(page, "DELETE", `/api/leave-requests/${made.leave}`, undefined, token);
  if (made.manager) await api(page, "DELETE", `/api/department-managers/${made.manager}`, undefined, token);
  await api(
    page,
    "PUT",
    "/api/hr/hod-reminders/settings",
    { enabled: false, times: ["10:00", "16:00"], days: [0, 1, 2, 3, 4, 5], template: null },
    token,
  );
  made.leave = made.manager = null;
});

test("HoD's lists what is pending with each Department Head, and Notify sends each of them their own reminder", async ({
  page,
}) => {
  await loginAsHr(page);
  const token = await adminToken(page);
  const employees = (await api(page, "GET", "/api/employees?search=E2E00", undefined, token)).body as unknown as {
    id: number;
    employeeCode: string;
  }[];
  const asha = employees.find((e) => e.employeeCode === "E2E001")!;
  const manager = await api(page, "POST", "/api/department-managers", { employeeCode: "E2E002" }, token);
  expect(manager.status, JSON.stringify(manager.body)).toBe(201);
  made.manager = manager.body!.id as number;
  const assign = await api(
    page,
    "POST",
    `/api/department-managers/${made.manager}/employees`,
    { employeeCode: "E2E001" },
    token,
  );
  expect(assign.status, JSON.stringify(assign.body)).toBeLessThan(300);
  const leave = await api(
    page,
    "POST",
    "/api/leave-requests",
    { employeeId: asha.id, startDate: "2026-03-16", endDate: "2026-03-17", type: "casual", reason: "e2e HoD reminder" },
    token,
  );
  expect(leave.status, JSON.stringify(leave.body)).toBe(201);
  made.leave = leave.body!.id as number;

  // ── HoD's: the board, then Ravi's drill-down ──
  await page.goto("/hr/requests");
  await page.getByRole("tab", { name: /HoD/ }).click();
  await expect(page).toHaveURL(/tab=hods/);
  const row = page.locator(`[data-testid="hod-row-${made.manager}"]:visible`);
  await expect(row).toContainText("Ravi", { timeout: 30_000 });
  await expect(page.locator(`[data-testid="hod-total-${made.manager}"]:visible`)).toHaveText("1");
  await expect(page.locator(`[data-testid="hod-cell-${made.manager}-leave"]:visible`)).toHaveText("1");
  await page.locator(`[data-testid="hod-open-${made.manager}"]:visible`).click();
  const detail = page.getByTestId("hod-detail");
  await expect(detail).toContainText("Asha");
  await expect(detail.getByTestId(`hod-item-leave-${made.leave}`)).toBeVisible();
  await page.keyboard.press("Escape");

  // ── Notify: the preview is Ravi's own message ──
  await page.getByRole("tab", { name: "Notify" }).click();
  await expect(page).toHaveURL(/tab=notify/);
  await expect(page.getByTestId("notify-tab")).toBeVisible();
  const preview = page.getByTestId("notify-preview-text");
  await expect(preview).toContainText("Dear Ravi Nair", { timeout: 30_000 });
  await expect(preview).toContainText("Leave Requests: 1");
  await expect(preview).toContainText("HR Team");

  // ── Send now: one round, WhatsApp through the fake WAClient, email and push skipped with a reason ──
  await page.request.post(`${FAKE_WACLIENT}/reset`);
  await page.getByTestId("notify-send-now").click();
  const dialog = page.getByTestId("notify-send-dialog");
  await expect(dialog).toContainText("Ravi");
  await page.getByTestId("notify-send-confirm").click();
  await expect
    .poll(
      async () => {
        const runs = (await api(page, "GET", "/api/hr/hod-reminders/runs", undefined, token)).body as {
          items: { status: string }[];
        };
        return runs.items[0]?.status;
      },
      { timeout: 60_000 },
    )
    .toBe("done");
  const sent = (await (await page.request.get(`${FAKE_WACLIENT}/messages`)).json()) as { message: string }[];
  const reminder = sent.find((m) => m.message.includes("Dear Ravi Nair"));
  expect(reminder, JSON.stringify(sent)).toBeTruthy();
  expect(reminder!.message).toContain("Leave Requests: 1");
  const runs = (await api(page, "GET", "/api/hr/hod-reminders/runs", undefined, token)).body as {
    items: { id: number }[];
  };
  const run = (await api(page, "GET", `/api/hr/hod-reminders/runs/${runs.items[0].id}`, undefined, token)).body as {
    deliveries: {
      managerId: number;
      whatsapp: { status: string };
      push: { status: string };
      email: { status: string };
    }[];
  };
  const ravi = run.deliveries.find((d) => d.managerId === made.manager)!;
  expect([ravi.whatsapp.status, ravi.push.status, ravi.email.status]).toEqual(["sent", "skipped", "skipped"]);
});
