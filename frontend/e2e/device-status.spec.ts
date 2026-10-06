import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// Attendance → Biometric Device Status, end to end against the real backend: devices are added through the Settings
// API, a device "talks to the server" by calling the real ADMS listener (/iclock/*) the way a punching machine does,
// and the connection check runs for real. Nothing here needs a physical device: the check targets are addresses whose
// answer is certain on any machine (a closed local port, a documentation-range address nobody owns).
//
// The server throttles sign-ins (10 a minute), so each role signs in ONCE and every test starts from that token.

const API = "http://127.0.0.1:8180";
const VIEWER_PASSWORD = "Passw0rd!view";
const PAGE = "/hr/attendance/device-status";

let adminToken = "";
let viewerToken = "";
const created: number[] = [];

async function signIn(request: APIRequestContext, username: string, password: string) {
  const res = await request.post("/api/auth/hr-login", { data: { username, password } });
  expect(res.status(), `sign in as ${username}`).toBe(200);
  return (await res.json()).token as string;
}

async function api(request: APIRequestContext, token: string, method: string, url: string, data?: unknown) {
  const res = await request.fetch(url, { method, headers: { Authorization: `Bearer ${token}` }, data });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

async function addDevice(request: APIRequestContext, body: Record<string, unknown>) {
  const res = await api(request, adminToken, "POST", "/api/biometric-devices", {
    deviceType: "aiface_mars",
    connectionConfig: { password: 0 },
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  created.push(res.body.id);
  return res.body as { id: number; name: string };
}

async function cleanUp(request: APIRequestContext) {
  const list = (await api(request, adminToken, "GET", "/api/biometric-devices")).body as {
    id: number | string;
    name: string;
  }[];
  for (const d of list) {
    if (typeof d.id === "number" && d.name.startsWith("ds_"))
      await api(request, adminToken, "DELETE", `/api/biometric-devices/${d.id}`);
  }
  const users = (await api(request, adminToken, "GET", "/api/hr-users")).body as { id: number; username: string }[];
  for (const u of users.filter((u) => u.username.startsWith("ds_")))
    await api(request, adminToken, "DELETE", `/api/hr-users/${u.id}`);
  const roles = (await api(request, adminToken, "GET", "/api/roles")).body as { id: number; name: string }[];
  for (const r of roles.filter((r) => r.name.startsWith("ds_")))
    await api(request, adminToken, "DELETE", `/api/roles/${r.id}`);
}

/** What a punching machine does: poll the listener, and push attendance. Straight to the backend, as a device would. */
const poll = (request: APIRequestContext, serial: string) => request.get(`${API}/iclock/getrequest?SN=${serial}`);
const handshake = (request: APIRequestContext, serial: string) =>
  request.get(`${API}/iclock/cdata?SN=${serial}&options=all&pushver=2.4.1`);
const pushAttendance = (request: APIRequestContext, serial: string, lines: string) =>
  request.post(`${API}/iclock/cdata?SN=${serial}&table=ATTLOG`, {
    data: lines,
    headers: { "Content-Type": "text/plain" },
  });

async function open(page: Page, token: string) {
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), token);
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(PAGE);
      break;
    } catch (error) {
      if (attempt >= 3 || !String(error).includes("ERR_ABORTED")) throw error;
    }
  }
  await expect(page.getByTestId("device-status-page")).toBeVisible();
}

const card = (page: Page, id: number) => page.getByTestId(`device-card-${id}`);

test.describe.configure({ mode: "serial" });

let live: { id: number };
let silent: { id: number };
let closed: { id: number };
let nowhere: { id: number };
let off: { id: number };

test.beforeAll(async ({ request }) => {
  adminToken = await signIn(request, HR_USERNAME, HR_PASSWORD);
  await cleanUp(request);

  live = await addDevice(request, { name: "ds_live", host: "10.250.0.11", port: 4370, serialNumber: "DSLIVE001" });
  silent = await addDevice(request, { name: "ds_silent", host: "10.250.0.12", port: 4370, serialNumber: "DSSILENT02" });
  // an address on this machine with nothing listening: the connection is refused at once
  closed = await addDevice(request, { name: "ds_closed", host: "127.0.0.1", port: 1, serialNumber: "DSCLOSED03" });
  // a documentation-range address nobody owns: it never answers (or there is no route), either way unreachable
  nowhere = await addDevice(request, {
    name: "ds_nowhere",
    host: "203.0.113.9",
    port: 4370,
    serialNumber: "DSNOWHERE4",
  });
  off = await addDevice(request, {
    name: "ds_off",
    host: "10.250.0.15",
    port: 4370,
    serialNumber: "DSOFF005",
    isActive: false,
  });

  // only the first one has talked to the server: it polls and has pushed a punch for someone the portal does not know
  expect((await handshake(request, "DSLIVE001")).status()).toBe(200);
  expect((await poll(request, "DSLIVE001")).status()).toBe(200);
  expect((await pushAttendance(request, "DSLIVE001", "99999\t2026-10-06 08:00:00\t255\t15\n")).status()).toBe(200);

  // a read-only account
  const role = await api(request, adminToken, "POST", "/api/roles", {
    name: "ds_view_attendance",
    permissions: { attendance: "view" },
  });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  const user = await api(request, adminToken, "POST", "/api/hr-users", {
    username: "ds_viewer",
    password: VIEWER_PASSWORD,
    roleId: role.body.id,
  });
  expect(user.status, JSON.stringify(user.body)).toBe(201);
  viewerToken = await signIn(request, "ds_viewer", VIEWER_PASSWORD);
});

test.afterAll(async ({ request }) => {
  await cleanUp(request);
});

test("the page shows every device with the state the server sees, and sorts the trouble first", async ({ page }) => {
  await open(page, adminToken);
  await expect(page.getByRole("heading", { name: "Biometric Device Status" })).toBeVisible();

  const summary = page.getByTestId("device-summary");
  await expect(page.getByTestId("device-summary-all")).toContainText("5");
  await expect(page.getByTestId("device-summary-connected")).toContainText("1");
  await expect(page.getByTestId("device-summary-disconnected")).toContainText("3");

  await expect(card(page, live.id)).toHaveAttribute("data-status", "connected");
  await expect(card(page, silent.id)).toHaveAttribute("data-status", "disconnected");
  await expect(card(page, off.id)).toHaveAttribute("data-status", "disabled");
  await expect(card(page, silent.id)).toContainText("Never connected");
  await expect(card(page, live.id).getByTestId(`device-lastheard-${live.id}`)).toContainText("just now");

  // disconnected devices come before the connected one, the switched-off one is last
  const names = await page.locator("[data-testid^='device-name-']").allTextContents();
  expect(names.indexOf("ds_live")).toBeGreaterThan(names.indexOf("ds_silent"));
  expect(names[names.length - 1]).toBe("ds_off");
  await expect(summary).toBeVisible();
});

test("a device nobody has heard from says so, and says what to do before any check is run", async ({ page }) => {
  await open(page, adminToken);
  await expect(page.getByTestId(`device-headline-${silent.id}`)).toContainText("Nothing has been received");
  await expect(page.getByTestId(`device-headline-${silent.id}`)).toContainText("What to do");
});

test("the status cards filter the list, and so does the search box", async ({ page }) => {
  await open(page, adminToken);
  await page.getByTestId("device-summary-connected").click();
  await expect(page.locator("[data-testid^='device-card-']")).toHaveCount(1);
  await expect(card(page, live.id)).toBeVisible();
  await page.getByTestId("device-summary-connected").click(); // a second press clears it
  await expect(page.locator("[data-testid^='device-card-']")).toHaveCount(5);

  await page.getByTestId("device-search").fill("dsnowhere4");
  await expect(page.locator("[data-testid^='device-card-']")).toHaveCount(1);
  await expect(card(page, nowhere.id)).toBeVisible();
  await page.getByTestId("device-search").fill("no-such-device");
  await expect(page.getByTestId("device-no-match")).toBeVisible();
});

test("a connection check tells apart a closed port and an address nobody answers, with the reason", async ({
  page,
}) => {
  await open(page, adminToken);

  // the one that never answers takes a few seconds: catch it while the check is running
  await page.getByTestId(`device-check-${nowhere.id}`).click();
  await expect(card(page, nowhere.id)).toContainText("Pinging…");
  await expect(card(page, nowhere.id)).toHaveAttribute("data-reach", "unreachable", { timeout: 30_000 });
  await expect(card(page, nowhere.id)).toContainText("Unreachable");

  await page.getByTestId(`device-check-${closed.id}`).click();
  await expect(card(page, closed.id)).toHaveAttribute("data-reach", "refused", { timeout: 30_000 });
  await expect(card(page, closed.id)).toContainText("Port closed");

  // both are still Disconnected: reaching a device is not the same as it sending to the server
  await expect(card(page, closed.id)).toHaveAttribute("data-status", "disconnected");

  // the diagnosis names the layer and shows what was tried
  await page.getByTestId(`device-toggle-${closed.id}`).click();
  await expect(page.getByTestId(`layer-${closed.id}-port`)).toHaveAttribute("data-state", "problem");
  await expect(page.getByTestId(`device-steps-${closed.id}`)).toContainText("refused");
});

test("the diagnosis of an unreachable device explains that the cloud cannot see the factory network", async ({
  page,
}) => {
  await open(page, adminToken);
  await page.getByTestId(`device-toggle-${nowhere.id}`).click();
  const lan = page.getByTestId(`layer-${nowhere.id}-lan`);
  await expect(lan).toHaveAttribute("data-state", /problem|na/);
  await expect(page.getByTestId(`device-diagnosis-${nowhere.id}`)).toContainText("Recent connection checks");
  await expect(page.getByTestId(`device-check-history`).first()).toBeVisible();
});

test("a device calling the server shows as connected, with where it called from and its attendance data", async ({
  page,
  request,
}) => {
  await poll(request, "DSSILENT02"); // it starts calling in
  await open(page, adminToken);
  await expect(card(page, silent.id)).toHaveAttribute("data-status", "connected");
  await expect(card(page, silent.id)).not.toContainText("Never connected");
  await expect(page.getByTestId(`device-lastheard-${silent.id}`)).toContainText("127.0.0.1");
  await expect(page.getByTestId("device-summary-connected")).toContainText("2");
  await expect(page.getByTestId("device-verdict")).toContainText("2 of 4 devices are connected");
  // the live device pushed one punch for an ID with no employee: it shows up as skipped, not as an error
  await page.getByTestId(`device-toggle-${live.id}`).click();
  await expect(page.getByTestId(`device-diagnosis-${live.id}`)).toContainText("no matching employee");
});

test("a machine nobody added is listed with its serial number", async ({ page, request }) => {
  // two devices still wait for a serial, so the server cannot guess which one a stranger is
  const a = await addDevice(request, { name: "ds_blank_a", host: "10.250.0.21" });
  const b = await addDevice(request, { name: "ds_blank_b", host: "10.250.0.22" });
  expect((await handshake(request, "STRANGER9")).status()).toBe(200);
  await open(page, adminToken);
  const unknown = page.getByTestId("device-unknown-senders");
  await expect(unknown).toContainText("STRANGER9");
  await expect(unknown).toContainText("not set up here");
  await expect(card(page, a.id)).toHaveAttribute("data-status", "disconnected");
  await expect(card(page, b.id)).toHaveAttribute("data-status", "disconnected");
});

test("the server panel says it is a local server and what every device must be set to", async ({ page }) => {
  await open(page, adminToken);
  await expect(page.getByTestId("device-local-notice")).toContainText("local server");
  const panel = page.getByTestId("device-server-panel");
  await expect(panel).toContainText("What each device must be set to");
  await expect(panel).toContainText("ADMS");
  await expect(panel).toContainText("Server address");
});

test("the path from this computer to the server can be measured", async ({ page }) => {
  await open(page, adminToken);
  await page.getByTestId("device-path-test").click();
  const result = page.getByTestId("device-path-result");
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toContainText("Average");
});

test("the Attendance page links to it, and so does the sync indicator", async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), adminToken);
  await page.goto("/hr/attendance");
  await page.getByTestId("open-device-status").click();
  await expect(page).toHaveURL(/\/hr\/attendance\/device-status/);
  await expect(page.getByTestId("device-status-page")).toBeVisible();

  await page.goBack();
  await page
    .getByRole("button", { name: /Sync (Live|Offline)|Checking/ })
    .first()
    .click();
  await page.getByTestId("open-full-device-status").click();
  await expect(page).toHaveURL(/\/hr\/attendance\/device-status/);
});

test("a role that may only view attendance sees everything but cannot run a check", async ({ page, request }) => {
  await open(page, viewerToken);
  await expect(card(page, live.id)).toBeVisible();
  await expect(page.getByTestId("device-run-check")).toBeDisabled();
  await expect(page.getByTestId(`device-check-${live.id}`)).toBeDisabled();
  // and the server refuses it too, whatever the page does
  const refused = await api(request, viewerToken, "POST", "/api/attendance/biometric-status/check", {});
  expect(refused.status).toBe(403);
  // but the read-only things still work
  await page.getByTestId("device-path-test").click();
  await expect(page.getByTestId("device-path-result")).toBeVisible({ timeout: 30_000 });
});

test("a role without attendance cannot read the status at all", async ({ request }) => {
  const role = await api(request, adminToken, "POST", "/api/roles", {
    name: "ds_no_attendance",
    permissions: { leave: "view" },
  });
  const user = await api(request, adminToken, "POST", "/api/hr-users", {
    username: "ds_nobody",
    password: VIEWER_PASSWORD,
    roleId: role.body.id,
  });
  expect(user.status).toBe(201);
  // sign-ins are throttled, so sign the token with the same login the page uses only once
  const token = await signIn(request, "ds_nobody", VIEWER_PASSWORD);
  expect((await api(request, token, "GET", "/api/attendance/biometric-status")).status).toBe(403);
});

test("the serial number is set in Settings → Devices and two devices cannot share one", async ({ page, request }) => {
  const clash = await api(request, adminToken, "POST", "/api/biometric-devices", {
    name: "ds_clash",
    host: "10.250.0.30",
    serialNumber: "DSLIVE001",
  });
  expect(clash.status).toBe(400);
  expect(clash.body.error).toContain("already belongs");

  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), adminToken);
  await page.goto("/hr/settings");
  await page.getByRole("tab", { name: /Devices/ }).click();
  await expect(page.getByText("ds_off")).toBeVisible();
  await expect(page.getByText("DSOFF005")).toBeVisible();
});

test("on a phone nothing scrolls sideways, even with a diagnosis open", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, adminToken);
  await page.getByTestId(`device-toggle-${closed.id}`).click();
  await expect(page.getByTestId(`device-diagnosis-${closed.id}`)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("the page loads without a script error or a server error", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`script error: ${e.message}`));
  page.on("response", (r) => {
    if (r.url().includes("/api/") && r.status() >= 500) problems.push(`${r.status()} ${r.url()}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource"))
      problems.push(`console: ${m.text().slice(0, 200)}`);
  });
  await open(page, adminToken);
  await page.getByTestId(`device-toggle-${live.id}`).click();
  await page.waitForTimeout(800);
  expect(problems).toEqual([]);
});
