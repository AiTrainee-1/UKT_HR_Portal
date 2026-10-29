import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Seeded by seed_e2e.py for February 2026 (24 Mon-Sat working days):
//   Asha Kumar  - salary 24,000, present all 24 days  -> paid 24,000
//   Ravi Nair   - salary 30,000, present 12 of 24     -> paid 15,000
//   Meena       - no salary configured                -> skipped

const FEB = "/hr/payroll?month=2&year=2026";
// The Payroll tab lists a table by default; the specs that look at the cards ask for them.
const FEB_CARDS = `${FEB}&layout=cards`;

// A payroll entry is a card (an <article> named "Payroll of <employee>").
const card = (page: Page, name: string) => page.getByRole("article", { name: `Payroll of ${name}` });

test("HR generates staff payroll for a month and the figures are right", async ({ page }) => {
  await loginAsHr(page);
  await page.goto(FEB_CARDS);

  await page.getByTestId("staff-generate-open").click();
  const dialog = page.getByTestId("staff-generate-dialog");
  // the dialog opens on the month the page is showing
  await expect(dialog.getByTestId("staff-generate-month")).toHaveValue("2");
  await expect(dialog.getByTestId("staff-generate-year")).toHaveValue("2026");
  // PF and ESI follow the Co Emp list and the rules in Settings -> PF & ESI; TDS follows the TDS list
  const note = dialog.getByTestId("staff-generate-statutory-note");
  await expect(note).toContainText("PF and ESI are deducted only from Co Emp employees");
  await expect(note).toContainText("Employees on the TDS list have TDS deducted at their own percentage instead");
  await expect(note.getByRole("link", { name: "PF & ESI rules" })).toHaveAttribute("href", "/hr/settings?tab=pf_esi");
  await expect(dialog.getByTestId("staff-generate-statutory")).toBeVisible();
  await dialog.getByTestId("staff-generate-confirm").click();

  const asha = card(page, "Asha Kumar");
  const ravi = card(page, "Ravi Nair");
  await expect(asha).toBeVisible({ timeout: 30_000 });
  await expect(asha).toContainText("24 / 24 days");
  await expect(asha).toContainText("₹24,000");
  await expect(ravi).toContainText("12 / 24 days");
  await expect(ravi).toContainText("₹15,000");
  await expect(page.getByText("Meena Nosalary")).toHaveCount(0);
  await expect(page.getByTestId("staff-record-count")).toHaveText("February 2026 · 2 records");
});

test("the month shows a card per payroll and counts the skipped employee on its view", async ({ page, request }) => {
  await loginAsHr(page);
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  await request.post("/api/payroll/generate", {
    headers: { Authorization: `Bearer ${token}` },
    data: { month: 2, year: 2026 },
  });

  await page.goto(FEB_CARDS);
  // there is no dashboard above the records any more
  await expect(page.getByTestId("staff-payroll-tab")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("staff-dash-root")).toHaveCount(0);
  // the two paid-able payrolls (24,000 and 15,000 net payable) are cards
  await expect(page.getByTestId("staff-record-count")).toContainText("2 records");
  await expect(card(page, "Asha Kumar")).toContainText("₹24,000");
  await expect(card(page, "Ravi Nair")).toContainText("₹15,000");
  // Meena has no salary: she is the one employee skipped at generation, and the Skipped view says so
  await expect(page.getByTestId("view-skipped-count")).toHaveText("1");
});

test("the skipped employee is listed with the reason", async ({ page }) => {
  await loginAsHr(page);
  await page.goto(FEB);

  await page.getByTestId("staff-skipped-open").click();
  await expect(page).toHaveURL(/view=skipped/);
  await expect(page.getByText("Meena Nosalary")).toBeVisible();
  await expect(page.getByText(/No Salary Amount/)).toBeVisible();
});

test("the filters narrow the payroll cards and live in the address", async ({ page, request }) => {
  await loginAsHr(page);
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  await request.post("/api/payroll/generate", {
    headers: { Authorization: `Bearer ${token}` },
    data: { month: 2, year: 2026 },
  });

  await page.goto(FEB_CARDS);
  await expect(card(page, "Asha Kumar")).toBeVisible({ timeout: 30_000 });
  await expect(card(page, "Ravi Nair")).toBeVisible();

  await page.getByTestId("staff-pf-search").fill("Ravi");
  await expect(card(page, "Asha Kumar")).toHaveCount(0);
  await expect(card(page, "Ravi Nair")).toBeVisible();
  await expect(page).toHaveURL(/q=Ravi/);

  // a reload lands on the same filtered view
  await page.reload();
  await expect(page.getByTestId("staff-pf-search")).toHaveValue("Ravi");
  await expect(card(page, "Asha Kumar")).toHaveCount(0);
  await expect(card(page, "Ravi Nair")).toBeVisible();
});

test("the API agrees with the screen, and regenerating never duplicates", async ({ page, request }) => {
  await loginAsHr(page);
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  const headers = { Authorization: `Bearer ${token}` };

  const generated = await request.post("/api/payroll/generate", { headers, data: { month: 2, year: 2026 } });
  expect(generated.status()).toBe(201);
  const body = await generated.json();
  expect(body.generated).toBe(2);
  expect(body.skipped).toBe(1);
  expect(body.skippedDetails[0].reason).toMatch(/No Salary Amount/);

  const list = await (await request.get("/api/payroll?month=2&year=2026", { headers })).json();
  const byCode = Object.fromEntries(list.map((r: { employeeCode: string }) => [r.employeeCode, r]));
  expect(Number(byCode.E2E001.finalSalary)).toBe(24000);
  expect(Number(byCode.E2E002.finalSalary)).toBe(15000);

  await request.post("/api/payroll/generate", { headers, data: { month: 2, year: 2026 } });
  const again = await (await request.get("/api/payroll?month=2&year=2026", { headers })).json();
  expect(again).toHaveLength(2);
});

// ── PF, ESI and TDS on the Payroll page ──────────────────────────────────────────────────────────────────────────────
// Asha (E2E001, 24,000 a month, present all 24 days) is the one employee these tests move between categories. Every test
// puts everything back (not on the TDS list, not Co Emp, no PF rules) and regenerates February, so the tests above and in
// the other specs still see the plain 24,000 / 15,000.

type Json = Record<string, unknown>;

async function asAdmin(page: Page) {
  await loginAsHr(page);
  const token = await page.evaluate(() => localStorage.getItem("uk_textile_token"));
  return { Authorization: `Bearer ${token}` };
}

test("an employee on the TDS list has TDS on the Payroll page, and nobody else does", async ({ page, request }) => {
  const headers = await asAdmin(page);
  const added = await request.post("/api/tds/employees", { headers, data: { employeeCode: "E2E001", percent: 10 } });
  expect(added.status()).toBe(201);
  const ashaId = ((await added.json()) as { employee: { id: number } }).employee.id;
  try {
    const generated = await request.post("/api/payroll/generate", { headers, data: { month: 2, year: 2026 } });
    expect(generated.status()).toBe(201);
    const list = (await (await request.get("/api/payroll?month=2&year=2026", { headers })).json()) as Json[];
    const asha = list.find((r) => r.employeeCode === "E2E001")!;
    const ravi = list.find((r) => r.employeeCode === "E2E002")!;
    // 10% of Asha's earned gross 24,000, taken as TDS; PF and ESI never apply to her
    expect(Number(asha.tdsDeduction)).toBe(2400);
    expect(Number(asha.tdsPercent)).toBe(10);
    expect(Number(asha.deductions)).toBe(2400);
    expect(Number(asha.finalSalary)).toBe(21600);
    expect(Number(ravi.tdsDeduction ?? 0)).toBe(0);
    expect(ravi.tdsPercent ?? null).toBeNull();
    expect(Number(ravi.finalSalary)).toBe(15000);

    // the cards: a TDS figure on Asha's card only
    await page.goto(FEB_CARDS);
    const ashaCard = card(page, "Asha Kumar");
    await expect(ashaCard).toBeVisible({ timeout: 30_000 });
    await expect(ashaCard.getByTestId(`payroll-record-tds-${asha.id}`)).toContainText("TDS (10%)");
    await expect(ashaCard.getByTestId(`payroll-record-tds-${asha.id}`)).toContainText("₹2,400");
    await expect(ashaCard.getByTestId(`payroll-record-net-${asha.id}`)).toHaveText("₹21,600");
    await expect(card(page, "Ravi Nair").getByTestId(/payroll-record-tds-/)).toHaveCount(0);

    // the register has a TDS column while someone on it has TDS
    await page.goto(`${FEB}&layout=table`);
    const table = page.getByTestId("payroll-record-table");
    await expect(table).toBeVisible({ timeout: 30_000 });
    await expect(table.locator("thead")).toContainText("TDS");
    await expect(table.getByTestId(`payroll-record-tds-${asha.id}`)).toContainText("₹2,400");
    await expect(table.getByTestId(`payroll-record-tds-${ravi.id}`)).toHaveText("—");
    await expect(page.getByTestId("payroll-record-totals-tds")).toHaveText("₹2,400");

    // the details page explains where the TDS came from
    await table.getByTestId(`payroll-record-details-${asha.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/hr/payroll/details/${asha.id}`));
    const statutory = page.getByTestId("pd-section-statutory");
    await expect(statutory).toBeVisible({ timeout: 30_000 });
    await expect(statutory.getByTestId("pd-statutory-headline")).toHaveAttribute("data-category", "tds");
    await expect(statutory.getByTestId("pd-statutory-line-tds")).toContainText("10% of the earned gross ₹24,000.00");
    await expect(statutory.getByTestId("pd-statutory-line-tds")).toContainText("− ₹2,400.00");
    await expect(statutory.getByTestId("pd-statutory-line-pf")).toHaveCount(0);

    // the stored breakdown (what the Breakdown drawer and that card read) says the same
    const stored = (await (await request.get(`/api/payroll/${asha.id}/breakdown`, { headers })).json()) as {
      breakdown: { deductions: { tds: number; statutory: { category: string } } };
    };
    expect(stored.breakdown.deductions.tds).toBe(2400);
    expect(stored.breakdown.deductions.statutory.category).toBe("tds");
  } finally {
    const removed = await request.delete(`/api/tds/employees/${ashaId}`, { headers });
    expect(removed.status()).toBe(200);
    await request.post("/api/payroll/generate", { headers, data: { month: 2, year: 2026 } });
  }
  // everything is back: Asha is on no list and her payroll is the plain 24,000 again
  const after = (await (await request.get("/api/payroll?month=2&year=2026", { headers })).json()) as Json[];
  const asha = after.find((r) => r.employeeCode === "E2E001")!;
  expect(Number(asha.finalSalary)).toBe(24000);
  expect(Number(asha.tdsDeduction ?? 0)).toBe(0);
});

test("a Co Emp employee gets PF from the rules in Settings, and the details page says which rule", async ({
  page,
  request,
}) => {
  const headers = await asAdmin(page);
  const employees = (await (await request.get("/api/employees?search=E2E001", { headers })).json()) as {
    id: number;
    employeeCode: string;
  }[];
  const ashaId = employees.find((e) => e.employeeCode === "E2E001")!.id;
  const rules = async (pfRules: Json[]) => {
    const current = (await (await request.get("/api/pf-esi-settings", { headers })).json()) as { version: string };
    const saved = await request.put("/api/pf-esi-settings", {
      headers,
      data: { expectedVersion: current.version, staff: { pfRules } },
    });
    expect(saved.status()).toBe(200);
  };
  try {
    // 12% of Basic + DA + Retaining Allowance (the first half of the salary) for every staff salary
    await rules([{ label: "E2E PF", basis: "total", minAmount: 0, maxAmount: 0, ratePercent: 12 }]);
    const toggled = await request.patch(`/api/employees/${ashaId}`, { headers, data: { coEmpEnabled: true } });
    expect(toggled.status()).toBe(200);
    await request.post("/api/payroll/generate", { headers, data: { month: 2, year: 2026 } });
    const list = (await (await request.get("/api/payroll?month=2&year=2026", { headers })).json()) as Json[];
    const asha = list.find((r) => r.employeeCode === "E2E001")!;
    const ravi = list.find((r) => r.employeeCode === "E2E002")!;
    expect(Number(asha.deductions)).toBe(1440); // 12% of 12,000 (24,000 x 50%), for a full month
    expect(Number(asha.finalSalary)).toBe(22560);
    expect(Number(asha.tdsDeduction ?? 0)).toBe(0);
    expect(Number(ravi.deductions)).toBe(0); // not Co Emp: no PF, whatever the rules say
    expect(Number(ravi.finalSalary)).toBe(15000);

    // the Generate dialog counts the rules set for Staff
    await page.goto(FEB_CARDS);
    await expect(card(page, "Asha Kumar")).toContainText("₹1,440", { timeout: 30_000 });
    await expect(card(page, "Asha Kumar").getByTestId(/payroll-record-tds-/)).toHaveCount(0);
    await page.getByTestId("staff-generate-open").click();
    await expect(page.getByTestId("staff-generate-statutory")).toHaveText("PF: 1 rule · ESI: 0 rules");
    await page.keyboard.press("Escape");

    // the details page explains the PF from the rule that matched
    await page.getByTestId(`payroll-record-details-${asha.id}`).click();
    const statutory = page.getByTestId("pd-section-statutory");
    await expect(statutory).toBeVisible({ timeout: 30_000 });
    await expect(statutory.getByTestId("pd-statutory-headline")).toHaveAttribute("data-category", "co_emp");
    await expect(statutory.getByTestId("pd-statutory-line-pf")).toContainText('Rule "E2E PF"');
    await expect(statutory.getByTestId("pd-statutory-line-pf")).toContainText("12% of ₹12,000.00");
    await expect(statutory.getByTestId("pd-statutory-line-pf")).toContainText("− ₹1,440.00");
    await expect(statutory.getByTestId("pd-statutory-line-esi")).toContainText("No rule matched");
  } finally {
    await request.patch(`/api/employees/${ashaId}`, { headers, data: { coEmpEnabled: false } });
    await rules([]);
    await request.post("/api/payroll/generate", { headers, data: { month: 2, year: 2026 } });
  }
  const after = (await (await request.get("/api/payroll?month=2&year=2026", { headers })).json()) as Json[];
  expect(Number(after.find((r) => r.employeeCode === "E2E001")!.finalSalary)).toBe(24000);
});
