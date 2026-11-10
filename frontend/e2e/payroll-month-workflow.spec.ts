import ExcelJS from "exceljs";
import { expect, test, type Download, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// The Staff Payroll month workflow (owner 2026-11-10), end to end on January 2026 (no other spec uses that month: a
// finalized month is locked for good):
//   Hold on the details page -> the bank file leaves the held salary (and the parked new joiner) out -> Payroll Done (the
//   owner's question, Yes) -> the month is locked (generate / adjust / hold refused) -> Mark as Paid -> the employee's own
//   app says Paid (Cleared alone said "Not paid yet") and they got a "Salary Paid" notification -> Release & pay of the
//   held employee, with a bank file of just them.
// Three throwaway staff employees are made here and removed again (their payrolls go with them).

const FAKE_WACLIENT = "http://127.0.0.1:8190";
const JAN = "/hr/payroll?month=1&year=2026";
const PERIOD = { month: 1, year: 2026 };
const MAIN_PASSWORD = "main-pass-2026";

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

/** The employee codes in a downloaded bank file (column C, from row 3). */
async function bankFileCodes(download: Download): Promise<string[]> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile((await download.path())!);
  const sheet = book.worksheets[0];
  const codes: string[] = [];
  sheet.eachRow((row, n) => {
    if (n >= 3) codes.push(String(row.getCell(3).value ?? ""));
  });
  return codes;
}

/** Which of this spec's employees (and the seeded Asha / Ravi) a downloaded Salary Statement workbook lists. */
async function statementCodes(download: Download): Promise<string[]> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile((await download.path())!);
  const found = new Set<string>();
  const sheet = book.worksheets[0];
  sheet.eachRow((row) =>
    row.eachCell((cell) => {
      const value = String(cell.value ?? "");
      if (/^E2E(WF)?\d+$/.test(value)) found.add(value);
    }),
  );
  return [...found].sort();
}

/** An employee login for the throwaway employee (activated through the fake WhatsApp one-time code). */
async function employeeToken(page: Page, code: string): Promise<string> {
  await page.request.post(`${FAKE_WACLIENT}/reset`);
  const ask = await page.request.post("/api/auth/otp/request", { data: { employeeCode: code, purpose: "activate" } });
  expect(ask.status(), await ask.text()).toBe(200);
  const sent = await (await page.request.get(`${FAKE_WACLIENT}/messages`)).json();
  const otp = sent[sent.length - 1].message.match(/\b(\d{6})\b/)![1];
  const activate = await page.request.post("/api/auth/otp/activate", {
    data: { employeeCode: code, otp, password: MAIN_PASSWORD },
  });
  expect(activate.status(), await activate.text()).toBe(200);
  const login = await page.request.post("/api/auth/employee-login", {
    data: { identifier: code, password: MAIN_PASSWORD },
  });
  expect(login.status()).toBe(200);
  return (await login.json()).token as string;
}

async function januaryPayLabel(page: Page, token: string): Promise<string> {
  const insights = await api(page, "GET", "/api/my/salary-insights?year=2026", undefined, token);
  expect(insights.status).toBe(200);
  const period = insights.body.periods.find((p: any) => p.payroll && p.month === 1);
  return period.payroll.statusLabel as string;
}

test("Hold, bank file, Payroll Done, the lock, Mark as Paid, the employee's Paid, and release & pay", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await loginAsHr(page);
  const admin = (
    await (
      await page.request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } })
    ).json()
  ).token as string;
  const branches = (await api(page, "GET", "/api/branches", undefined, admin)).body as { id: number }[];
  const made: number[] = [];
  const employee = async (code: string, first: string, joinDate: string, phone: string) => {
    const created = await api(
      page,
      "POST",
      "/api/employees",
      {
        employeeCode: code,
        firstName: first,
        lastName: "Workflow",
        phone,
        employmentType: "staff",
        branchId: branches[0].id,
        salaryType: "monthly",
        salaryAmount: 20000,
        joinDate,
        bankAccount: `ACC${code}`,
        bankIfsc: "HDFC0000001",
        bankName: "HDFC",
      },
      admin,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    made.push(created.body.id);
    return created.body.id as number;
  };

  try {
    await employee("E2EWF1", "Hari", "2025-01-01", "9000000071"); // held, then released and paid on his own
    await employee("E2EWF2", "Nila", "2026-01-15", "9000000072"); // joined in January: parked
    await employee("E2EWF3", "Mani", "2025-01-01", "9000000073"); // in the payroll: paid with the month
    expect((await api(page, "POST", "/api/payroll/generate", PERIOD, admin)).status).toBe(201);
    const skippedLists = (await api(page, "GET", "/api/payroll/month-skipped?month=1&year=2026", undefined, admin))
      .body;
    expect(skippedLists.newJoiners.map((r: any) => r.employeeCode)).toEqual(["E2EWF2"]);
    const listed = (await api(page, "GET", "/api/payroll?month=1&year=2026", undefined, admin)).body as any[];
    const hari = listed.find((r) => r.employeeCode === "E2EWF1");
    const mani = listed.find((r) => r.employeeCode === "E2EWF3");
    expect(listed.some((r) => r.employeeCode === "E2EWF2")).toBe(false);

    // ── Hold on the details page ─────────────────────────────────────────────────────────────────────────────────────
    await page.goto(`/hr/payroll/details/${hari.id}`);
    const hold = page.getByTestId("pd-hold");
    await expect(hold).toHaveText("Hold", { timeout: 30_000 });
    await expect(hold).toBeEnabled();
    await hold.click();
    await expect(page.getByTestId("pd-hold")).toHaveText("Unhold");
    await expect(page.getByTestId("pd-on-hold")).toHaveText("On hold");

    // ── the bank file leaves the held salary and the parked new joiner out ──────────────────────────────────────────
    await page.goto(JAN);
    await expect(page.getByTestId("staff-record-count")).toContainText("January 2026", { timeout: 30_000 });
    await expect(page.getByTestId("month-status-button")).toHaveText("Payroll Done");
    const [bank] = await Promise.all([page.waitForEvent("download"), page.getByTestId("staff-export-bank").click()]);
    const codes = await bankFileCodes(bank);
    expect(codes).toContain("E2EWF3");
    expect(codes).toContain("E2E001");
    expect(codes).not.toContain("E2EWF1");
    expect(codes).not.toContain("E2EWF2");

    // ── Skipped Employees: on hold and new joiners, each listed ─────────────────────────────────────────────────────
    await page.getByTestId("staff-skipped-open").click();
    await expect(page.getByTestId("skipped-on_hold-row-E2EWF1")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("skipped-new_joiner-row-E2EWF2")).toBeVisible();
    await expect(page.getByTestId("skipped-group-not_generated")).toContainText("Meena Nosalary", { timeout: 60_000 });

    // ── the Skipped section's own two exports: the main payroll's statement and bank file, skipped employees only ──
    await expect(page.getByTestId("skipped-section-export-note")).toContainText("1 employee with no payroll yet");
    await page.getByTestId("skipped-section-export").click();
    const [skippedStatement] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("skipped-section-export-statement-xlsx").click(),
    ]);
    // held (HOLD) and the parked new joiner (NEW JOINER); nobody from the month's payroll, nor Meena (no payroll)
    expect(await statementCodes(skippedStatement)).toEqual(["E2EWF1", "E2EWF2"]);
    const [skippedBank] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("skipped-section-bank").click(),
    ]);
    expect(skippedBank.suggestedFilename()).toBe("Payroll_Staff_Skipped_January_2026.xlsx");
    expect(await bankFileCodes(skippedBank)).toEqual(["E2EWF1", "E2EWF2"]);
    // ... and the month's own statement is the main payroll + the held salary, never the new joiner
    await page.goto(JAN);
    await page.getByTestId("staff-export").click();
    const [mainStatement] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("staff-export-statement-xlsx").click(),
    ]);
    const mainCodes = await statementCodes(mainStatement);
    expect(mainCodes).toEqual(expect.arrayContaining(["E2E001", "E2E002", "E2EWF1", "E2EWF3"]));
    expect(mainCodes).not.toContain("E2EWF2");

    // ── Cleared alone is NOT paid on the employee's side ────────────────────────────────────────────────────────────
    expect((await api(page, "PATCH", `/api/payroll/${mani.id}`, { status: "paid" }, admin)).status).toBe(200);
    const maniToken = await employeeToken(page, "E2EWF3");
    expect(await januaryPayLabel(page, maniToken)).toBe("Not paid yet");

    // ── Payroll Done: the owner's question, Yes -> Payment Pending with a timer, Generate is off ─────────────────────
    await page.goto(JAN);
    await page.getByTestId("month-status-button").click();
    await expect(page.getByTestId("month-finalize-question")).toHaveText(
      "Are you sure you want to finalize this month's payroll? Once confirmed, payroll generation and recomputation will be permanently locked for this month.",
    );
    await expect(page.getByTestId("month-finalize-warnings")).toContainText("1 salary is on hold");
    await page.getByTestId("month-finalize-yes").click();
    await expect(page.getByTestId("month-status-button")).toHaveAttribute("data-state", "finalized", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("month-status-button")).toContainText("Payment Pending");
    await expect(page.getByTestId("month-status-detail")).toHaveText(/^0h \d+m$/);
    await expect(page.getByTestId("staff-generate-open")).toBeDisabled();
    await expect(page.getByTestId("staff-month-locked")).toBeVisible();

    // ── the lock, server side ───────────────────────────────────────────────────────────────────────────────────────
    const generated = await api(page, "POST", "/api/payroll/generate", PERIOD, admin);
    expect(generated.status).toBe(409);
    expect(generated.body.error).toContain("locked");
    expect((await api(page, "PATCH", `/api/payroll/${mani.id}`, { bonus: 500 }, admin)).status).toBe(409);
    expect((await api(page, "POST", `/api/payroll/${mani.id}/hold`, { hold: true }, admin)).status).toBe(409);

    // ── Mark as Paid -> Paid, and the employee sees Paid + got the notification ─────────────────────────────────────
    await page.getByTestId("month-status-button").click();
    await page.getByTestId("month-mark-paid").click();
    await expect(page.getByTestId("month-paid-question")).toContainText("marked Paid with today's date");
    await page.getByTestId("month-paid-yes").click();
    await expect(page.getByTestId("month-status-button")).toHaveAttribute("data-state", "paid", { timeout: 15_000 });
    await expect(page.getByTestId("month-status-detail")).toContainText("the same day as finalizing");
    await expect(page.getByTestId("month-timeline-strip").getByTestId("month-step-paid")).toHaveAttribute(
      "data-done",
      "true",
    );

    expect(await januaryPayLabel(page, maniToken)).toBe("Paid");
    await expect
      .poll(async () => {
        const notes = await api(page, "GET", "/api/notifications", undefined, maniToken);
        const rows = Array.isArray(notes.body) ? notes.body : (notes.body?.results ?? []);
        return rows.filter((n: any) => n.title === "Salary Paid").map((n: any) => n.message);
      })
      .toEqual(["Your salary for January 2026 has been paid."]);

    // ── Release & pay the held employee, with a bank file of just him ───────────────────────────────────────────────
    await page.goto(`${JAN}&view=skipped`);
    await page.getByTestId(`skipped-release-${hari.id}`).click({ timeout: 30_000 });
    await expect(page.getByTestId("skipped-release-dialog")).toContainText("Hari Workflow leaves On hold");
    await page.getByTestId("skipped-release-yes").click();
    const [own1] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("skipped-release-bankfile").click(),
    ]);
    expect(await bankFileCodes(own1)).toEqual(["E2EWF1"]);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("skipped-paid_separately-row-E2EWF1")).toBeVisible();
    const hariNow = (
      await api(page, "GET", `/api/payroll?employeeId=${hari.employeeId}&month=1&year=2026`, undefined, admin)
    ).body[0];
    expect([hariNow.paymentStatus, hariNow.releasedFrom, hariNow.onHold]).toEqual(["paid", "hold", false]);
    // the figures never moved
    expect(hariNow.finalSalary).toBe(hari.finalSalary);
  } finally {
    for (const id of made) await api(page, "DELETE", `/api/employees/${id}`, undefined, admin);
  }
});
