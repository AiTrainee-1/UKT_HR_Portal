import { expect, test, type Page } from "@playwright/test";
import { loginAsHr } from "./helpers";

// Outpass / Visitors / Tea Break: three pages under /hr/outpass-visitors, the sidebar having an entry for each. Outpass and Tea
// Break keep their tabs in the path (/outpass/overview/passes, /outpass/requests, /outpass/in-out, /tea-break/records,
// /tea-break/rule) and Outpass has nested tabs under Overview (/passes, /qr-submissions); Visitors is one list. Each tab shows its
// own section only, a path that stops early (or names something unknown) goes to the first tab, and the three first-level
// addresses keep working.

const BASE = "/hr/outpass-visitors";
const sidebar = (page: Page) => page.getByRole("complementary");
const tab = (page: Page, name: string | RegExp) => page.getByRole("tab", { name });
const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });

async function hrToken(page: Page) {
  return page.evaluate(() => localStorage.getItem("uk_textile_token"));
}

test.describe.configure({ mode: "serial" });

test("the three first-level addresses keep working and open on their first tab", async ({ page }) => {
  await loginAsHr(page);
  await page.goto(`${BASE}/outpass`);
  await expect(page).toHaveURL(`${BASE}/outpass/overview/passes`);
  await expect(heading(page, "Gate Pass")).toBeVisible();
  await expect(page.getByTestId("outpass-passes")).toBeVisible();

  await page.goto(`${BASE}/visitors`);
  await expect(page).toHaveURL(`${BASE}/visitors/visits`);
  await expect(heading(page, "Visitors")).toBeVisible();
  await expect(page.getByTestId("visitors-list")).toBeVisible();
  // two tabs since 2026-11-18: the visits and Manage Reception (the reception desk logins)
  await expect(page.getByTestId("visitors-subtabs")).toBeVisible();
  await expect(page.getByTestId("visitors-subtabs")).toContainText("Manage Reception");

  await page.goto(`${BASE}/tea-break`);
  await expect(page).toHaveURL(`${BASE}/tea-break/records`);
  await expect(heading(page, "Tea Break")).toBeVisible();
  await expect(page.getByTestId("tea-break-list")).toBeVisible();

  // the bare prefix is Outpass
  await page.goto(BASE);
  await expect(page).toHaveURL(`${BASE}/outpass/overview/passes`);
});

test("a path that stops early, or names something unknown, goes to the first tab, keeping the query string", async ({
  page,
}) => {
  await loginAsHr(page);
  for (const [from, to] of [
    [`${BASE}/outpass/overview`, `${BASE}/outpass/overview/passes`],
    [`${BASE}/outpass/overview/nope`, `${BASE}/outpass/overview/passes`],
    [`${BASE}/outpass/nope`, `${BASE}/outpass/overview/passes`],
    [`${BASE}/outpass/requests/deeper`, `${BASE}/outpass/requests`],
    [`${BASE}/tea-break/nope`, `${BASE}/tea-break/records`],
    [`${BASE}/tea-break/rule/deeper`, `${BASE}/tea-break/rule`],
    [`${BASE}/visitors/anything`, `${BASE}/visitors/visits`],
    [`${BASE}/visitors/desks/deeper`, `${BASE}/visitors/desks`],
    [`${BASE}/outpass?from=link`, `${BASE}/outpass/overview/passes?from=link`],
  ]) {
    await page.goto(from);
    await expect(page, from).toHaveURL(to);
  }
});

test("Outpass: each tab shows only its own section, and the sidebar item stays lit and unchanged", async ({ page }) => {
  await loginAsHr(page);
  await page.goto(`${BASE}/outpass`);
  await expect(page.getByTestId("outpass-passes")).toBeVisible();
  await expect(page.getByTestId("outpass-qr-submissions")).toHaveCount(0);
  await expect(page.getByTestId("outpass-requests")).toHaveCount(0);
  await expect(page.getByTestId("outpass-in-out")).toHaveCount(0);

  await page.getByTestId("outpass-overview-nested-qr-submissions").click();
  await expect(page).toHaveURL(`${BASE}/outpass/overview/qr-submissions`);
  await expect(page.getByTestId("outpass-qr-submissions")).toBeVisible();
  await expect(page.getByTestId("outpass-passes")).toHaveCount(0);

  await tab(page, /^Requests/).click();
  await expect(page).toHaveURL(`${BASE}/outpass/requests`);
  await expect(page.getByTestId("outpass-requests")).toBeVisible();
  await expect(page.getByTestId("outpass-overview")).toHaveCount(0);

  await tab(page, /^In\/Out/).click();
  await expect(page).toHaveURL(`${BASE}/outpass/in-out`);
  await expect(page.getByTestId("outpass-in-out")).toBeVisible();

  await tab(page, "Overview").click();
  await expect(page).toHaveURL(`${BASE}/outpass/overview/passes`);

  // the sidebar keeps its three entries, in this order, and Outpass stays lit on every tab
  await page.goto(`${BASE}/outpass/in-out`);
  const links = sidebar(page).locator(`a[href^="${BASE}/"]`);
  await expect(links).toHaveText([/Gate Pass/, /Visitors/, /Tea Break/]);
  await expect(links.nth(0)).toHaveAttribute("href", `${BASE}/outpass`);
  await expect(links.nth(1)).toHaveAttribute("href", `${BASE}/visitors`);
  await expect(links.nth(2)).toHaveAttribute("href", `${BASE}/tea-break`);
  const lit = async (name: string) =>
    ((await sidebar(page).locator(`a[href="${BASE}/${name}"] > div`).getAttribute("class")) ?? "").includes(
      "clay-nav-active",
    );
  expect([await lit("outpass"), await lit("visitors"), await lit("tea-break")]).toEqual([true, false, false]);
  await page.goto(`${BASE}/tea-break/rule`);
  await expect(page.getByTestId("tea-break-rule")).toBeVisible();
  expect([await lit("outpass"), await lit("visitors"), await lit("tea-break")]).toEqual([false, false, true]);
});

test("Outpass: the range filter is kept across the two sections of Overview", async ({ page }) => {
  await loginAsHr(page);
  await page.goto(`${BASE}/outpass/overview/passes`);
  await tab(page, "This Month").click();
  await expect(tab(page, "This Month")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("outpass-overview-nested-qr-submissions").click();
  await expect(page.getByTestId("outpass-qr-submissions")).toBeVisible();
  await expect(tab(page, "This Month")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("outpass-qr-submissions")).toContainText("this month");
});

test("Outpass: a Gate QR submission is listed, and counted on its tab", async ({ page }) => {
  await loginAsHr(page);
  const headers = { Authorization: `Bearer ${await hrToken(page)}` };
  const branches = await (await page.request.get("/api/branches", { headers })).json();
  const qr = await page.request.get(`/api/outpass/qr?branchId=${branches[0].id}`, { headers });
  expect(qr.status()).toBe(200);
  const { token } = await qr.json();
  const submit = await page.request.post(`/api/outpass/gate/${token}/submit`, {
    data: { name: "E2E Gate Person", employeeCode: "E2E-NOBODY", destination: "E2E Bank" },
  });
  expect(submit.status()).toBe(201);

  await page.goto(`${BASE}/outpass/overview/qr-submissions`);
  await expect(page.getByTestId("outpass-qr-submissions")).toContainText("E2E Gate Person");
  await expect(page.getByTestId("outpass-overview-nested-qr-submissions")).toContainText(/\(\d+\)/);
});

test("Outpass: the arrow keys move between the nested tabs", async ({ page }) => {
  await loginAsHr(page);
  await page.goto(`${BASE}/outpass/overview/passes`);
  const passes = page.getByTestId("outpass-overview-nested-passes");
  await passes.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(`${BASE}/outpass/overview/qr-submissions`);
  await expect(page.getByTestId("outpass-qr-submissions")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(page).toHaveURL(`${BASE}/outpass/overview/passes`);
});

// ── Gate Pass -> In/Out: a real pass, approved by HR, scanned out at a real gate (and refused a second time), seen on the
// page with its figures, its filters, its drawer and its files.

type Json = Record<string, unknown>;

async function api(page: Page, token: string, method: string, url: string, data?: Json) {
  const r = await page.request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const type = r.headers()["content-type"] ?? "";
  return { status: r.status(), body: type.includes("json") ? await r.json() : null, response: r };
}

test("Gate Pass In/Out: a pass that went out today is counted, filtered, opened and exported", async ({ page }) => {
  await loginAsHr(page);
  const token = (await hrToken(page))!;
  const stamp = Date.now().toString(36);
  const destination = `E2E InOut Bank ${stamp}`;

  const employees = (await api(page, token, "GET", "/api/employees")).body as { id: number; employeeCode: string }[];
  const ravi = employees.find((e) => e.employeeCode === "E2E002")!;
  expect(ravi).toBeTruthy();
  const branches = (await api(page, token, "GET", "/api/branches")).body as { id: number; name: string }[];
  const branchId = (branches.find((b) => b.name === "E2E Head Office") ?? branches[0]).id;

  const gate = await api(page, token, "POST", "/api/gate-devices", {
    name: `E2E InOut Gate ${stamp}`,
    branchId,
    username: `e2e_inout_${stamp}`,
    password: "E2e-Gate-Pass-1",
  });
  expect(gate.status, JSON.stringify(gate.body)).toBe(201);
  const gateId = (gate.body as { id: number }).id;
  try {
    // the pass: asked for, approved by HR, scanned out, then shown again (refused: already out)
    const back = new Date(Date.now() + 30 * 60_000).toISOString();
    const asked = await api(page, token, "POST", "/api/outpass-requests", {
      employeeId: ravi.id,
      destination,
      reason: "E2E cash deposit",
      passType: "official",
      expectedReturnAt: back,
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    const passId = (asked.body as { id: number }).id;
    const approved = await api(page, token, "PUT", `/api/outpass-requests/${passId}/hr-status`, { status: "approved" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const qrToken = (approved.body as { qrToken: string | null }).qrToken;
    expect(qrToken).toBeTruthy();
    const login = await page.request.post("/api/gate-devices/login", {
      data: { username: `e2e_inout_${stamp}`, password: "E2e-Gate-Pass-1" },
    });
    expect(login.status()).toBe(200);
    const gateToken = (await login.json()).token as string;
    const scan = (code: string) =>
      page.request.post("/api/gate-devices/scan", {
        headers: { Authorization: `Bearer ${gateToken}` },
        data: { qrToken: code },
      });
    expect((await scan(qrToken!)).status()).toBe(200);
    expect((await scan(qrToken!)).status()).toBe(409);

    // the API: its own permission, never a pass code, the same row in the files
    const q = encodeURIComponent(destination);
    const today = await api(page, token, "GET", `/api/outpass/in-out?q=${q}`);
    expect(today.status).toBe(200);
    const items = (today.body as { items: Json[] }).items;
    expect(items.map((r) => r.destination)).toEqual([destination]);
    expect(items[0].status).toBe("out");
    expect(JSON.stringify(today.body)).not.toContain("qrToken");
    const xlsx = await api(page, token, "GET", `/api/outpass/in-out/export?fmt=xlsx&q=${q}`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.response.headers()["content-type"]).toContain("spreadsheetml");
    const pdf = await api(page, token, "GET", `/api/outpass/in-out/export?fmt=pdf&q=${q}`);
    expect(pdf.status).toBe(200);
    expect((await pdf.response.body()).subarray(0, 4).toString()).toBe("%PDF");

    // the page: today's figures, the row, the filters in the address
    await page.goto(`${BASE}/outpass/in-out`);
    await expect(page.getByTestId("outpass-in-out")).toBeVisible();
    await expect(page.getByTestId("inout-tile-went-out-value")).not.toHaveText("0");
    await expect(page.getByTestId("inout-tile-out-value")).not.toHaveText("0");
    await expect(tab(page, /^In\/Out\s*\(\d+\)/)).toBeVisible();
    await page.getByTestId("inout-search").fill(destination);
    await expect(page).toHaveURL(/[?&]q=E2E/);
    const row = page.getByTestId("inout-table").locator("tbody tr");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Ravi Nair");
    await expect(row).toContainText(`E2E InOut Gate ${stamp}`);

    await page.getByTestId("inout-status").selectOption("back");
    await expect(page).toHaveURL(/status=back/);
    await expect(page.getByTestId("inout-table")).toContainText("No pass matches these filters");
    await page.getByTestId("inout-status").selectOption("out");
    await expect(row).toHaveCount(1);
    await page.getByTestId("inout-gate").selectOption(String(gateId));
    await expect(page).toHaveURL(new RegExp(`gateId=${gateId}`));
    await expect(row).toHaveCount(1);

    // the drawer: the pass, its approval and both scans (the refused one too); Esc closes it
    await row.click();
    const drawer = page.getByTestId("inout-drawer");
    await expect(drawer).toContainText("E2E cash deposit");
    await expect(drawer.getByTestId("inout-scan")).toHaveCount(2);
    await expect(drawer.locator('[data-testid="inout-scan"][data-result="denied"]')).toContainText("Already scanned");
    await expect(drawer.getByTestId("approval-trail")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);

    // Export: the same filters, as a real file
    await page.getByTestId("inout-export").click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("inout-export-xlsx").click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^gate_pass_in_out_\d{8}_\d{4}\.xlsx$/);

    // Clear puts every filter back (today, all gates, any status)
    await page.getByTestId("inout-clear").click();
    await expect(page).toHaveURL(`${BASE}/outpass/in-out`);
  } finally {
    await api(page, token, "DELETE", `/api/gate-devices/${gateId}`);
  }
});

test("Gate Pass In/Out works for a role without the Requests module, and not for one with In/Out hidden", async ({
  page,
}) => {
  await loginAsHr(page);
  const admin = (await hrToken(page))!;
  const stamp = Date.now().toString(36);
  const made: { roles: number[]; users: number[] } = { roles: [], users: [] };
  const signIn = async (permissions: Record<string, string>, name: string) => {
    const role = await api(page, admin, "POST", "/api/roles", { name: `e2e-${name}-${stamp}`, permissions });
    expect(role.status).toBe(201);
    const roleId = (role.body as { id: number }).id;
    made.roles.push(roleId);
    const username = `e2e_${name}_${stamp}`;
    const password = "E2e-Limited-1!";
    const user = await api(page, admin, "POST", "/api/hr-users", { username, password, roleId });
    expect(user.status).toBe(201);
    made.users.push((user.body as { id: number }).id);
    const login = await page.request.post("/api/auth/hr-login", { data: { username, password } });
    return (await login.json()).token as string;
  };
  try {
    const viewer = await signIn({ dashboard: "view", outpass_visitors: "view" }, "inout_view");
    expect((await api(page, viewer, "GET", "/api/outpass/in-out")).status).toBe(200);
    expect((await api(page, viewer, "GET", "/api/outpass/in-out/summary")).status).toBe(200);
    expect((await api(page, viewer, "GET", "/api/outpass-requests")).status).toBe(403);
    await page.evaluate((t) => localStorage.setItem("uk_textile_token", t), viewer);
    await page.goto(`${BASE}/outpass/in-out`);
    await expect(page.getByTestId("inout-table")).toBeVisible();
    await expect(page.getByTestId("inout-table")).not.toContainText("Could not load this list.");
    // View only: the filters still work (they change nothing)
    await page.getByTestId("inout-dates-week").click();
    await expect(page).toHaveURL(/range=week/);

    const hidden = await signIn(
      { dashboard: "view", outpass_visitors: "edit", "outpass_visitors.outpass.in_out": "hidden" },
      "inout_hidden",
    );
    expect((await api(page, hidden, "GET", "/api/outpass/in-out")).status).toBe(403);
    await page.evaluate((t) => localStorage.setItem("uk_textile_token", t), hidden);
    await page.goto(`${BASE}/outpass/in-out`);
    await expect(page).toHaveURL(`${BASE}/outpass/overview/passes`);
  } finally {
    await page.evaluate((t) => localStorage.setItem("uk_textile_token", t), admin);
    for (const id of made.users) await api(page, admin, "DELETE", `/api/hr-users/${id}`);
    for (const id of made.roles) await api(page, admin, "DELETE", `/api/roles/${id}`);
  }
});

test("Tea Break: Records and Rule are separate tabs, and the filters are kept between them", async ({ page }) => {
  await loginAsHr(page);
  await page.goto(`${BASE}/tea-break`);
  await expect(page.getByTestId("tea-break-list")).toBeVisible();
  await expect(page.getByTestId("tea-break-rule")).toHaveCount(0);

  // the filters live in the address, so they go along with a switch of tab
  await page.getByTestId("tea-dates-week").click();
  await page.getByTestId("tea-status").selectOption("overtime");
  await expect(page).toHaveURL(`${BASE}/tea-break/records?range=week&status=overtime`);

  await tab(page, "Rule").click();
  await expect(page).toHaveURL(`${BASE}/tea-break/rule?range=week&status=overtime`);
  await expect(page.getByTestId("tea-break-rule")).toBeVisible();
  await expect(page.getByTestId("tea-break-list")).toHaveCount(0);

  await tab(page, "Records").click();
  await expect(page).toHaveURL(`${BASE}/tea-break/records?range=week&status=overtime`);
  await expect(page.getByTestId("tea-dates-week")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("tea-status")).toHaveValue("overtime");
});

test("a role without the Outpass / Visitors module cannot open any of its tabs", async ({ page }) => {
  await loginAsHr(page);
  const admin = { Authorization: `Bearer ${await hrToken(page)}` };
  const stamp = Date.now().toString(36);
  const role = await page.request.post("/api/roles", {
    headers: admin,
    data: { name: `e2e-no-gate-${stamp}`, permissions: { dashboard: "view" } },
  });
  expect(role.status()).toBe(201);
  const roleId = (await role.json()).id as number;
  const username = `e2e_nogate_${stamp}`;
  const password = "E2e-Limited-1!";
  const user = await page.request.post("/api/hr-users", { headers: admin, data: { username, password, roleId } });
  expect(user.status()).toBe(201);
  try {
    const login = await page.request.post("/api/auth/hr-login", { data: { username, password } });
    const token = (await login.json()).token as string;
    await page.evaluate((t) => localStorage.setItem("uk_textile_token", t), token);
    await page.goto("/hr/dashboard");
    await expect(page).toHaveURL(/\/hr\/dashboard/);
    await expect(sidebar(page).getByText("Outpass / Visitors", { exact: true })).toHaveCount(0);
    for (const path of [
      BASE,
      `${BASE}/outpass`,
      `${BASE}/outpass/overview/passes`,
      `${BASE}/outpass/overview/qr-submissions`,
      `${BASE}/outpass/requests`,
      `${BASE}/outpass/in-out`,
      `${BASE}/visitors`,
      `${BASE}/tea-break`,
      `${BASE}/tea-break/rule`,
    ]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/hr\/dashboard/);
    }
  } finally {
    await page.request.delete(`/api/hr-users/${(await user.json()).id}`, { headers: admin });
    await page.request.delete(`/api/roles/${roleId}`, { headers: admin });
  }
});
