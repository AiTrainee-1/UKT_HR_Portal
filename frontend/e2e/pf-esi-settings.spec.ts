import { expect, test, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME, loginAsHr } from "./helpers";

// Settings -> PF & ESI against the real backend (backend/api/pf_esi.py, pf_esi_views.py): the Super Admin adds, edits and
// deletes a Staff PF rule and a Production ESI rule, an overlap is shown on its row, a stale copy is refused (409), a unit
// gets rules of its own and is reset to global, a login that is not the Super Admin sees them read-only, and the old PF /
// ESI controls are gone from the Payroll tab. Whatever a case changes is put back through the API before it ends.

const PATH = "/api/pf-esi-settings";
const SAVE = "Save PF & ESI Rules";

test.describe.configure({ mode: "serial" });

type Reply = { status: number; body: Record<string, any> | null };

async function adminToken(page: Page): Promise<string> {
  const res = await page.request.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
  return (await res.json()).token as string;
}

async function api(page: Page, method: string, url: string, data?: unknown, token?: string): Promise<Reply> {
  const bearer = token ?? (await page.evaluate(() => localStorage.getItem("uk_textile_token")));
  const res = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${bearer}` }, data });
  const text = await res.text();
  let body: Reply["body"] = null;
  try {
    body = text ? (JSON.parse(text) as Reply["body"]) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status(), body };
}

type Rule = { id: string; label: string; basis: string; minAmount: number; maxAmount: number; ratePercent: number };
type Lists = { staff: { pfRules: Rule[]; esiRules: Rule[] }; production: { pfRules: Rule[]; esiRules: Rule[] } };

let original: Lists | null = null;

const listsOf = (body: Record<string, any> | null): Lists => ({
  staff: { pfRules: body?.staff.pfRules ?? [], esiRules: body?.staff.esiRules ?? [] },
  production: { pfRules: body?.production.pfRules ?? [], esiRules: body?.production.esiRules ?? [] },
});

/** Signs in as the e2e super admin, remembers what the global rules were, and starts the case from NO rules at all. */
async function ready(page: Page): Promise<string> {
  await loginAsHr(page);
  const token = await adminToken(page);
  const got = await api(page, "GET", PATH, undefined, token);
  expect(got.status, "the Super Admin can read the PF & ESI rules").toBe(200);
  expect(got.body?.canEdit).toBe(true);
  original ??= listsOf(got.body);
  await writeGlobal(page, token, { staff: { pfRules: [], esiRules: [] }, production: { pfRules: [], esiRules: [] } });
  for (const b of (got.body?.branches ?? []) as { id: number; hasOverride: boolean }[]) {
    if (b.hasOverride) await api(page, "DELETE", `${PATH}?branchId=${b.id}`, undefined, token);
  }
  return token;
}

async function writeGlobal(page: Page, token: string, lists: Lists) {
  const now = await api(page, "GET", PATH, undefined, token);
  const put = await api(page, "PUT", PATH, { expectedVersion: now.body!.version, ...lists }, token);
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return put;
}

/** Puts the rules back as they were before the case, and removes the unit the case made (a unit is only switched off). */
async function putBack(page: Page, token: string, branchIds: number[] = []) {
  for (const id of branchIds) {
    await api(page, "DELETE", `${PATH}?branchId=${id}`, undefined, token);
    await api(page, "DELETE", `/api/branches/${id}`, undefined, token);
  }
  if (original) await writeGlobal(page, token, original);
}

const stamp = () => Date.now().toString(36);

async function openTab(page: Page, hash = "") {
  await page.goto(`/hr/settings?tab=pf_esi${hash}`);
  await expect(page.getByTestId("pf-esi-editor")).toBeVisible({ timeout: 30_000 });
}

const box = (page: Page, label: string) => page.getByLabel(label, { exact: true });

async function save(page: Page) {
  await page.getByRole("button", { name: SAVE }).click();
  await expect(page.getByTestId("confirm-pf-esi")).toBeVisible();
  await page.getByTestId("confirm-pf-esi-confirm").click();
}

test.afterAll(async ({ playwright }, testInfo) => {
  // a safety net: whatever happened, the global rules end as they began
  if (!original) return;
  const ctx = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
  try {
    const login = await ctx.post("/api/auth/hr-login", { data: { username: HR_USERNAME, password: HR_PASSWORD } });
    const headers = { Authorization: `Bearer ${(await login.json()).token}` };
    const now = await (await ctx.get(PATH, { headers })).json();
    await ctx.put(PATH, { headers, data: { expectedVersion: now.version, ...original } });
  } finally {
    await ctx.dispose();
  }
});

test("the Super Admin adds, edits and deletes a Staff PF rule and a Production ESI rule", async ({ page }) => {
  test.setTimeout(180_000);
  const token = await ready(page);
  try {
    await openTab(page);
    await expect(page.getByTestId("pf-esi-readonly")).toHaveCount(0);
    await expect(page.getByTestId("rules-staff-pf-empty")).toContainText("nobody pays PF");

    // add a Staff PF rule: PF below 25,000 (Basic), 12%
    await page.getByTestId("rules-staff-pf-add").click();
    await box(page, "Staff PF rule 1: name").fill("PF below 25,000");
    await box(page, "Staff PF rule 1: to amount").fill("25000");
    await box(page, "Staff PF rule 1: percentage").fill("12");
    // the live example follows it: a 30,000 salary has Basic 5,000, so 12% of the first portion 15,000
    await expect(page.getByTestId("pf-esi-example-staff-pf")).toContainText("12% of ₹15,000.00 = ₹1,800.00");
    await save(page);
    await expect(page.getByText("PF & ESI rules saved").first()).toBeVisible();
    let saved = (await api(page, "GET", PATH, undefined, token)).body!;
    expect(saved.staff.pfRules).toHaveLength(1);
    expect(saved.staff.pfRules[0]).toMatchObject({
      label: "PF below 25,000",
      basis: "basic",
      minAmount: 0,
      maxAmount: 25000,
      ratePercent: 12,
    });
    expect(saved.staff.pfRules[0].id).toBeTruthy();
    expect(saved.staff.esiRules).toHaveLength(0);

    // it is still there after a reload, and the Save bar is quiet
    await page.reload();
    await expect(page.getByTestId("pf-esi-editor")).toBeVisible({ timeout: 30_000 });
    await expect(box(page, "Staff PF rule 1: percentage")).toHaveValue("12");
    await expect(box(page, "Staff PF rule 1: to amount")).toHaveValue("25000");

    // edit it: 10%
    await box(page, "Staff PF rule 1: percentage").fill("10");
    await expect(page.getByTestId("pf-esi-example-staff-pf")).toContainText("10% of ₹15,000.00 = ₹1,500.00");
    await save(page);
    await expect(page.getByTestId("save-bar")).toHaveAttribute("data-dirty", "false");
    saved = (await api(page, "GET", PATH, undefined, token)).body!;
    expect(saved.staff.pfRules).toHaveLength(1);
    expect(saved.staff.pfRules[0].ratePercent).toBe(10);

    // a Production ESI rule on the Production page: ESI below 21,000 a month, 0.75%
    await page.getByRole("tab", { name: "Production", exact: true }).click();
    await expect(page.getByTestId("pf-esi-page-production")).toBeVisible();
    await page.getByTestId("rules-production-esi-add").click();
    await box(page, "Production ESI rule 1: name").fill("ESI below 21,000");
    await box(page, "Production ESI rule 1: range based on").selectOption("total");
    await box(page, "Production ESI rule 1: to amount").fill("21000");
    await box(page, "Production ESI rule 1: percentage").fill("0.75");
    await save(page);
    await expect(page.getByText("PF & ESI rules saved").first()).toBeVisible();
    saved = (await api(page, "GET", PATH, undefined, token)).body!;
    expect(saved.production.esiRules).toHaveLength(1);
    expect(saved.production.esiRules[0]).toMatchObject({
      label: "ESI below 21,000",
      basis: "total",
      minAmount: 0,
      maxAmount: 21000,
      ratePercent: 0.75,
    });
    expect(saved.staff.pfRules[0].ratePercent, "saving Production left the Staff PF list as it was").toBe(10);

    // delete the Staff PF rule: it asks first, and only Save makes it final
    await page.getByRole("tab", { name: "Staff", exact: true }).click();
    await page.getByRole("button", { name: "Delete Staff PF rule 1" }).click();
    await expect(page.getByTestId("confirm-delete-rule-dialog")).toContainText("Delete Staff PF rule 1?");
    await page.getByRole("button", { name: "Keep the rule" }).click();
    await expect(page.getByTestId("rule-row")).toHaveCount(1);
    await page.getByRole("button", { name: "Delete Staff PF rule 1" }).click();
    await page.getByTestId("confirm-delete-rule").click();
    await expect(page.getByTestId("rules-staff-pf-empty")).toBeVisible();
    expect((await api(page, "GET", PATH, undefined, token)).body!.staff.pfRules, "not saved yet").toHaveLength(1);
    await save(page);
    await expect(page.getByTestId("save-bar")).toHaveAttribute("data-dirty", "false");
    saved = (await api(page, "GET", PATH, undefined, token)).body!;
    expect(saved.staff.pfRules).toHaveLength(0);
    expect(saved.production.esiRules).toHaveLength(1);
  } finally {
    await putBack(page, token);
  }
});

test("overlapping ranges are shown on the row and block the Save; the server's own 400 lands on its row and box", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const token = await ready(page);
  try {
    await writeGlobal(page, token, {
      staff: {
        pfRules: [{ id: "", label: "Low", basis: "basic", minAmount: 0, maxAmount: 25000, ratePercent: 12 }],
        esiRules: [],
      },
      production: { pfRules: [], esiRules: [] },
    });
    await openTab(page);
    await page.getByTestId("rules-staff-pf-add").click();
    await box(page, "Staff PF rule 2: name").fill("High");
    await box(page, "Staff PF rule 2: from amount").fill("20000");
    await box(page, "Staff PF rule 2: percentage").fill("8");
    await expect(page.getByTestId("staff-pf-1-from-error")).toContainText('Overlaps rule 1 ("Low")');
    await expect(page.getByTestId("staff-pf-1-from-error")).toContainText("Ranges in one list must not overlap.");
    await expect(page.getByRole("button", { name: SAVE })).toBeDisabled();
    await expect(page.getByTestId("save-bar")).toContainText("Fix this first: Staff PF rule 2");
    await expect(page.getByTestId("pf-esi-attention")).toContainText("Staff");

    // the real server says the same thing when it is sent the overlap directly
    const direct = await api(
      page,
      "PUT",
      PATH,
      {
        expectedVersion: (await api(page, "GET", PATH, undefined, token)).body!.version,
        staff: {
          pfRules: [
            { label: "Low", basis: "basic", minAmount: 0, maxAmount: 25000, ratePercent: 12 },
            { label: "High", basis: "basic", minAmount: 20000, maxAmount: 0, ratePercent: 8 },
          ],
        },
      },
      token,
    );
    expect(direct.status).toBe(400);
    expect(direct.body).toMatchObject({ list: "staff.pfRules", ruleIndex: 1, field: "minAmount", otherRuleIndex: 0 });

    // fixing the row clears the problem
    await box(page, "Staff PF rule 2: from amount").fill("25000.01");
    await expect(page.getByTestId("staff-pf-1-from-error")).toHaveCount(0);
    await expect(page.getByRole("button", { name: SAVE })).toBeEnabled();

    // a refusal that gets past the screen's own checks (simulated: the screen cannot be made to send one) shows the
    // server's sentence under the row and box it names, and opens the page that holds it
    await page.route("**/api/pf-esi-settings", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: 'Staff PF rule 2 ("High"): Maximum amount must be 0 (no upper limit) or at least the minimum amount.',
          list: "staff.pfRules",
          ruleIndex: 1,
          field: "maxAmount",
        }),
      });
    });
    await page.getByRole("tab", { name: "Production", exact: true }).click();
    await save(page);
    await expect(page.getByRole("tab", { name: "Staff", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("staff-pf-1-to-error")).toContainText("Maximum amount must be 0");
    await expect(page.getByTestId("pf-esi-save-error")).toContainText('Staff PF rule 2 ("High")');
    await expect(page.getByRole("button", { name: SAVE })).toBeDisabled();
    await page.unroute("**/api/pf-esi-settings");
  } finally {
    await putBack(page, token);
  }
});

test("a copy that went stale is refused with a reload prompt, and the edits are kept until the reload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const token = await ready(page);
  try {
    await writeGlobal(page, token, {
      staff: {
        pfRules: [{ id: "", label: "PF", basis: "basic", minAmount: 0, maxAmount: 25000, ratePercent: 12 }],
        esiRules: [],
      },
      production: { pfRules: [], esiRules: [] },
    });
    await openTab(page);
    await box(page, "Staff PF rule 1: percentage").fill("9");

    // somebody else saves the same rules meanwhile
    const now = (await api(page, "GET", PATH, undefined, token)).body!;
    const other = await api(
      page,
      "PUT",
      PATH,
      {
        expectedVersion: now.version,
        staff: { pfRules: [{ ...now.staff.pfRules[0], ratePercent: 13 }] },
      },
      token,
    );
    expect(other.status).toBe(200);

    await save(page);
    await expect(page.getByTestId("pf-esi-save-error")).toContainText(
      "Someone else saved these rules while you were editing",
    );
    await expect(box(page, "Staff PF rule 1: percentage")).toHaveValue("9");
    expect((await api(page, "GET", PATH, undefined, token)).body!.staff.pfRules[0].ratePercent).toBe(13);

    // reloading drops the edits, and asks first because there are some
    await page.getByTestId("pf-esi-reload").click();
    await expect(page.getByTestId("pf-esi-reload-confirm")).toContainText("Reload and drop your edits?");
    await page.getByTestId("pf-esi-reload-confirm-yes").click();
    await expect(box(page, "Staff PF rule 1: percentage")).toHaveValue("13");
    await expect(page.getByTestId("pf-esi-save-error")).toHaveCount(0);

    // and the next save goes through on the new version
    await box(page, "Staff PF rule 1: percentage").fill("14");
    await save(page);
    await expect(page.getByTestId("save-bar")).toHaveAttribute("data-dirty", "false");
    expect((await api(page, "GET", PATH, undefined, token)).body!.staff.pfRules[0].ratePercent).toBe(14);
  } finally {
    await putBack(page, token);
  }
});

test("the Super Admin gives a unit rules of its own, then resets it to global", async ({ page }) => {
  test.setTimeout(180_000);
  const token = await ready(page);
  const suffix = stamp();
  const unit = await api(
    page,
    "POST",
    "/api/branches",
    { name: `PF Unit ${suffix}`, code: `PFU${suffix}`.toUpperCase() },
    token,
  );
  expect(unit.status).toBe(201);
  const unitId = unit.body!.id as number;
  try {
    await writeGlobal(page, token, {
      staff: {
        pfRules: [{ id: "", label: "Global PF", basis: "basic", minAmount: 0, maxAmount: 25000, ratePercent: 12 }],
        esiRules: [],
      },
      production: { pfRules: [], esiRules: [] },
    });
    await openTab(page);
    await expect(page.getByTestId("pf-esi-scope-picker")).toBeVisible();
    await expect(page.getByTestId("pf-esi-scope-global")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId(`pf-esi-own-badge-${unitId}`)).toHaveCount(0);

    // the unit follows the global rules until it is given its own
    await page.getByTestId(`pf-esi-scope-${unitId}`).click();
    await expect(page.getByTestId("pf-esi-inherit-notice")).toContainText("is following global rules");
    await expect(page.getByTestId("pf-esi-inherit-notice")).toContainText("saving creates this branch's own rule set");
    await expect(box(page, "Staff PF rule 1: percentage")).toHaveValue("12");
    await expect(page.getByTestId("pf-esi-reset")).toHaveCount(0);

    await box(page, "Staff PF rule 1: percentage").fill("9");
    await page.getByRole("button", { name: SAVE }).click();
    await expect(page.getByTestId("confirm-pf-esi")).toContainText("creates");
    await page.getByTestId("confirm-pf-esi-confirm").click();
    await expect(page.getByTestId(`pf-esi-own-badge-${unitId}`)).toBeVisible();
    await expect(page.getByTestId("pf-esi-own-notice")).toContainText("has its own rule set");

    const own = (await api(page, "GET", `${PATH}?branchId=${unitId}`, undefined, token)).body!;
    expect(own.scope).toMatchObject({ branchId: unitId, isOverride: true });
    expect(own.staff.pfRules[0].ratePercent).toBe(9);
    const global = (await api(page, "GET", PATH, undefined, token)).body!;
    expect(global.staff.pfRules[0].ratePercent, "the global rules were not touched").toBe(12);

    // back to the all-units rules, then to the unit again: its own set is still there
    await page.getByTestId("pf-esi-scope-global").click();
    await expect(box(page, "Staff PF rule 1: percentage")).toHaveValue("12");
    await page.getByTestId(`pf-esi-scope-${unitId}`).click();
    await expect(box(page, "Staff PF rule 1: percentage")).toHaveValue("9");

    // Reset to global asks first
    await page.getByTestId("pf-esi-reset").click();
    await expect(page.getByTestId("pf-esi-reset-confirm")).toContainText("This cannot be undone");
    await page.getByRole("button", { name: "Keep its own rules" }).click();
    expect((await api(page, "GET", `${PATH}?branchId=${unitId}`, undefined, token)).body!.scope.isOverride).toBe(true);
    await page.getByTestId("pf-esi-reset").click();
    await page.getByTestId("pf-esi-reset-confirm-yes").click();
    await expect(page.getByTestId(`pf-esi-own-badge-${unitId}`)).toHaveCount(0);
    await expect(page.getByTestId("pf-esi-inherit-notice")).toBeVisible();
    await expect(box(page, "Staff PF rule 1: percentage")).toHaveValue("12");
    const after = (await api(page, "GET", `${PATH}?branchId=${unitId}`, undefined, token)).body!;
    expect(after.scope.isOverride).toBe(false);
    expect(after.staff.pfRules[0].ratePercent).toBe(12);
  } finally {
    await putBack(page, token, [unitId]);
  }
});

test("a login that is not the Super Admin sees the rules of its unit, read-only, and the server refuses its changes", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const admin = await ready(page);
  const suffix = stamp();
  const unit = await api(
    page,
    "POST",
    "/api/branches",
    { name: `PF RO ${suffix}`, code: `PFR${suffix}`.toUpperCase() },
    admin,
  );
  const other = await api(
    page,
    "POST",
    "/api/branches",
    { name: `PF Other ${suffix}`, code: `PFO${suffix}`.toUpperCase() },
    admin,
  );
  expect([unit.status, other.status]).toEqual([201, 201]);
  const unitId = unit.body!.id as number;
  const otherId = other.body!.id as number;
  const username = `e2e_pf_${suffix}`;
  const password = "E2e-Limited-1!";
  let roleId: number | null = null;
  let userId: number | null = null;
  try {
    // the unit gets rules of its own, the other unit follows the global ones
    await writeGlobal(page, admin, {
      staff: {
        pfRules: [{ id: "", label: "Global PF", basis: "basic", minAmount: 0, maxAmount: 25000, ratePercent: 12 }],
        esiRules: [],
      },
      production: { pfRules: [], esiRules: [] },
    });
    const unitNow = (await api(page, "GET", `${PATH}?branchId=${unitId}`, undefined, admin)).body!;
    const made = await api(
      page,
      "PUT",
      PATH,
      {
        branchId: unitId,
        expectedVersion: unitNow.version,
        staff: { pfRules: [{ label: "Unit PF", basis: "basic", minAmount: 0, maxAmount: 20000, ratePercent: 9 }] },
      },
      admin,
    );
    expect(made.status).toBe(200);

    const role = await api(
      page,
      "POST",
      "/api/roles",
      { name: `e2e-pf-${suffix}`, permissions: { settings: "edit" } },
      admin,
    );
    expect(role.status).toBe(201);
    roleId = role.body!.id as number;
    const user = await api(page, "POST", "/api/hr-users", { username, password, roleId, branchId: unitId }, admin);
    expect(user.status).toBe(201);
    userId = user.body!.id as number;
    const login = await page.request.post("/api/auth/hr-login", { data: { username, password } });
    expect(login.status()).toBe(200);
    const limited = (await login.json()).token as string;
    await page.evaluate((t) => localStorage.setItem("uk_textile_token", t), limited);

    await openTab(page);
    await expect(page.getByTestId("pf-esi-readonly")).toHaveText(
      "Only the Super Admin can change PF/ESI rules. Showing the rules that apply to your unit.",
    );
    await expect(page.getByTestId("pf-esi-scope-picker")).toHaveCount(0);
    await expect(page.getByTestId("pf-esi-scope-text")).toContainText(`PF RO ${suffix}`);
    // its unit's own rule is what it sees, and nothing can be edited
    await expect(box(page, "Staff PF rule 1: name")).toHaveValue("Unit PF");
    await expect(box(page, "Staff PF rule 1: percentage")).toHaveValue("9");
    await expect(box(page, "Staff PF rule 1: percentage")).toBeDisabled();
    await expect(box(page, "Staff PF rule 1: to amount")).toBeDisabled();
    await expect(box(page, "Staff PF rule 1: range based on")).toBeDisabled();
    await expect(page.getByTestId("rules-staff-pf-add")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete Staff PF rule 1" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: SAVE })).toHaveCount(0);
    await expect(page.getByTestId("pf-esi-reset")).toHaveCount(0);

    // the server agrees: read yes, write no, and no peeking at another unit
    const read = await api(page, "GET", PATH, undefined, limited);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ canEdit: false, branches: [] });
    expect(read.body!.scope).toMatchObject({ branchId: unitId, isOverride: true });
    const write = await api(
      page,
      "PUT",
      PATH,
      { branchId: unitId, expectedVersion: read.body!.version, staff: { pfRules: [] } },
      limited,
    );
    expect(write.status).toBe(403);
    expect((await api(page, "DELETE", `${PATH}?branchId=${unitId}`, undefined, limited)).status).toBe(403);
    expect((await api(page, "GET", `${PATH}?branchId=${otherId}`, undefined, limited)).status).toBe(403);
    expect((await api(page, "GET", PATH, undefined, admin)).body!.staff.pfRules[0].ratePercent).toBe(12);
    expect(
      (await api(page, "GET", `${PATH}?branchId=${unitId}`, undefined, admin)).body!.staff.pfRules[0].ratePercent,
    ).toBe(9);
  } finally {
    if (userId !== null) await api(page, "DELETE", `/api/hr-users/${userId}`, undefined, admin);
    if (roleId !== null) await api(page, "DELETE", `/api/roles/${roleId}`, undefined, admin);
    await putBack(page, admin, [unitId, otherId]);
  }
});

test("the old PF and ESI controls are gone from the Payroll and Production Payroll tabs, which point to the new tab", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const token = await ready(page);
  try {
    await page.goto("/hr/settings?tab=payroll");
    await expect(page.getByRole("tab", { name: "Payroll Rules", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("tab", { name: "Bonus", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "OT / Compensation", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Production PF/EF", exact: true })).toHaveCount(0);
    for (const gone of [
      "Staff PF rate",
      "Staff ESI rate",
      "Staff ESI ceiling",
      "Deduct PF and ESI from staff pay",
      "Production PF rate",
      "Production ESI ceiling",
      "Deduct flat-rate PF and ESI from production pay",
      "Use salary bands for production PF and ESI",
      "How each production payslip's PF and ESI is decided",
    ]) {
      await expect(page.getByText(gone, { exact: true }), gone).toHaveCount(0);
    }
    // what is left on the tab is the non-PF settings, untouched
    await expect(page.getByText("Salary pay day", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Financial year start month", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("compensation-split-note")).toContainText("no longer used");
    await expect(page.getByTestId("pf-esi-elsewhere")).toContainText("PF and ESI have their own tab");
    await page
      .getByTestId("pf-esi-elsewhere")
      .getByRole("link", { name: /Open PF & ESI/ })
      .click();
    await expect(page.getByTestId("pf-esi-editor")).toBeVisible({ timeout: 30_000 });

    // the server no longer returns or takes the old fields
    const settings = (await api(page, "GET", "/api/payroll-settings", undefined, token)).body!;
    for (const key of [
      "pfRate",
      "esiRate",
      "esiApplicableBelow",
      "prodPfRate",
      "prodEsiRate",
      "prodEsiApplicableBelow",
      "prodPfEfEnabled",
      "prodPfEfRules",
      "staffPayrollRulesEnabled",
      "prodPayrollRulesEnabled",
    ]) {
      expect(settings, `GET /api/payroll-settings has no ${key}`).not.toHaveProperty(key);
    }

    // the Production Payroll tab keeps only a pointer
    await page.goto("/hr/settings?tab=production_payroll#prod-pf-esi-where");
    await expect(page.getByTestId("production-pf-esi-elsewhere")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("production-pf-order")).toHaveCount(0);
    await page
      .getByTestId("production-pf-esi-elsewhere")
      .getByRole("link", { name: /Open PF & ESI/ })
      .click();
    await expect(page.getByRole("tab", { name: "Production", exact: true })).toHaveAttribute("aria-selected", "true", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("pf-esi-page-production")).toBeVisible();
  } finally {
    await putBack(page, token);
  }
});

test("the search and the address take you to a PF & ESI setting, on the page that holds it", async ({ page }) => {
  test.setTimeout(120_000);
  const token = await ready(page);
  try {
    await page.goto("/hr/settings");
    await expect(page.getByRole("tab", { name: "PF & ESI", exact: true })).toBeVisible({ timeout: 30_000 });
    const search = page.getByRole("combobox", { name: "Find a setting" });
    await search.fill("provident fund");
    const hit = page.getByTestId("settings-search-hit-pf_esi-prod-pf-rules");
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(page.getByRole("tab", { name: "PF & ESI", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/tab=pf_esi/);
    await expect(page.getByRole("tab", { name: "Production", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-setting-id="prod-pf-rules"]')).toBeInViewport({ timeout: 15_000 });

    await page.goto("/hr/settings?tab=pf_esi#staff-esi-rules");
    await expect(page.getByRole("tab", { name: "Staff", exact: true })).toHaveAttribute("aria-selected", "true", {
      timeout: 30_000,
    });
    await expect(page.locator('[data-setting-id="staff-esi-rules"]')).toBeInViewport({ timeout: 15_000 });
  } finally {
    await putBack(page, token);
  }
});

test("the tab fits a 390 px screen without sideways scrolling", async ({ page }) => {
  test.setTimeout(120_000);
  const token = await ready(page);
  try {
    await writeGlobal(page, token, {
      staff: {
        pfRules: [{ id: "", label: "PF", basis: "basic", minAmount: 0, maxAmount: 25000, ratePercent: 12 }],
        esiRules: [{ id: "", label: "ESI", basis: "basic", minAmount: 0, maxAmount: 30000, ratePercent: 0.75 }],
      },
      production: { pfRules: [], esiRules: [] },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    for (const hash of ["#staff-pf-rules", "#prod-pf-rules"]) {
      await openTab(page, hash);
      await expect(page.locator(`[data-setting-id="${hash.slice(1)}"]`)).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${hash}: the page does not scroll sideways`).toBeLessThanOrEqual(1);
    }
  } finally {
    await putBack(page, token);
  }
});
