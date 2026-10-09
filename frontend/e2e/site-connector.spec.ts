import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// Attendance → Device Control → Site connectors, end to end against the real backend.
//
// The connector itself is a separate program (D:\Projects\biometric app). Here a few lines of this spec stand in for it: they
// speak the same HTTP protocol (pair, poll, report a job's result) and answer the jobs with canned data, so what is tested is
// the HRMS in both halves: the server's side of the conversation and the pages that start work and wait for the answer.
// (The real connector against the real backend and fake terminals is that program's scripts/e2e_with_hrms.py.)
//
// Everything created here is prefixed "cn_" and removed afterwards. Each role signs in once: the server throttles sign-ins.

const BASE = "/api/attendance/device-control";
const PAGE = "/hr/attendance/DeviceControl";
// a fresh password every run (this server's .env has pointed at a real database before: nothing fixed is created)
const VIEWER_PASSWORD = `Pw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}!`;

let adminToken = "";
let viewerToken = "";
let connectorId = 0;
let pairingCode = "";
let connectorToken = "";
const deviceIds: Record<string, number> = {};

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
const admin = (request: APIRequestContext, method: string, url: string, data?: unknown) =>
  api(request, adminToken, method, url, data);

/** What the connector does: ask for work (saying how its devices are) and report each job. */
const asConnector = (request: APIRequestContext) => {
  const headers = { Authorization: `Bearer ${connectorToken}` };
  return {
    poll: async (status?: Record<string, unknown>, want = 4) => {
      const res = await request.post("/api/connector/poll", { headers, data: { cfgHash: null, status, want } });
      return { status: res.status(), body: await res.json() };
    },
    report: (jobId: number, body: Record<string, unknown>) =>
      request.post(`/api/connector/jobs/${jobId}/result`, { headers, data: body }),
  };
};

const reachable = (id: number) => ({
  [String(id)]: {
    ok: true,
    code: "ok",
    latencyMs: 7,
    capacity: { users: 1, usersCap: 3000, records: 10, recordsCap: 150000 },
  },
});

async function open(page: Page, token: string, path = PAGE) {
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), token);
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(path);
      break;
    } catch (error) {
      if (attempt >= 3 || !String(error).includes("ERR_ABORTED")) throw error;
    }
  }
  await expect(page.getByTestId("device-control-page")).toBeVisible();
}

async function purge(request: APIRequestContext) {
  const devices = (await admin(request, "GET", "/api/biometric-devices")).body as {
    id: number | string;
    name: string;
  }[];
  for (const d of devices) {
    if (typeof d.id === "number" && d.name.startsWith("cn_"))
      await admin(request, "DELETE", `/api/biometric-devices/${d.id}`);
  }
  const connectors = (await admin(request, "GET", `${BASE}/connectors`)).body?.connectors as
    { id: number; name: string }[] | undefined;
  for (const c of connectors ?? [])
    if (c.name.startsWith("cn_")) await admin(request, "DELETE", `${BASE}/connectors/${c.id}`);
  const users = (await admin(request, "GET", "/api/hr-users")).body as { id: number; username: string }[];
  for (const u of users.filter((u) => u.username.startsWith("cn_")))
    await admin(request, "DELETE", `/api/hr-users/${u.id}`);
  const roles = (await admin(request, "GET", "/api/roles")).body as { id: number; name: string }[];
  for (const r of roles.filter((r) => r.name.startsWith("cn_"))) await admin(request, "DELETE", `/api/roles/${r.id}`);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  adminToken = await signIn(request, HR_USERNAME, HR_PASSWORD);
  await purge(request);
  const role = await admin(request, "POST", "/api/roles", {
    name: "cn_view_attendance",
    permissions: { attendance: "view" },
  });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  const user = await admin(request, "POST", "/api/hr-users", {
    username: "cn_viewer",
    password: VIEWER_PASSWORD,
    roleId: role.body.id,
  });
  expect(user.status, JSON.stringify(user.body)).toBe(201);
  viewerToken = await signIn(request, "cn_viewer", VIEWER_PASSWORD);
});

test.afterAll(async ({ request }) => {
  await purge(request);
});

test("a connector is added and its pairing code is shown once, with what to do with it", async ({ page }) => {
  await open(page, adminToken, `${PAGE}/connectors`);
  await expect(page.getByTestId("connectors-empty")).toBeVisible();
  await page.getByTestId("connector-add").click();
  await expect(page.getByTestId("connector-create")).toBeDisabled();
  await page.getByTestId("connector-name-input").fill("cn_Unit 1");
  await page.getByTestId("connector-create").click();

  await expect(page.getByTestId("connector-code-dialog")).toBeVisible();
  pairingCode = (await page.getByTestId("connector-code").textContent())!.trim();
  expect(pairingCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await expect(page.getByTestId("connector-address")).toContainText("http");
  await page.getByTestId("connector-code-close").click();

  const card = page.locator("[data-testid^='connector-card-']").first();
  await expect(card).toHaveAttribute("data-state", "unpaired");
  await expect(card).toContainText("Waiting for the connector at the factory to be paired");
  connectorId = Number((await card.getAttribute("data-testid"))!.replace("connector-card-", ""));
  // the code is not shown again: only a new one can be made
  await expect(page.getByText(pairingCode)).toHaveCount(0);
});

test("a name already in use is refused with the reason", async ({ page }) => {
  await open(page, adminToken, `${PAGE}/connectors`);
  await page.getByTestId("connector-add").click();
  await page.getByTestId("connector-name-input").fill("cn_Unit 1");
  await page.getByTestId("connector-create").click();
  await expect(page.getByText("There is already a connector with that name.")).toBeVisible();
});

test("once it is paired and has reported, the connector shows Online with its devices as it sees them", async ({
  page,
  request,
}) => {
  const paired = await request.post("/api/connector/pair", {
    data: { code: pairingCode, hostname: "CN-PC", version: "1.0.0", os: "Windows 11" },
  });
  expect(paired.status()).toBe(200);
  connectorToken = (await paired.json()).token;
  const again = await request.post("/api/connector/pair", { data: { code: pairingCode } });
  expect(again.status(), "the code works once").toBe(400);

  const dev = await admin(request, "POST", "/api/biometric-devices", {
    name: "cn_gate",
    deviceType: "aiface_mars",
    host: "192.168.0.50",
    port: 4370,
    connectionConfig: { password: 0 },
    connectorId,
  });
  expect(dev.status, JSON.stringify(dev.body)).toBe(201);
  deviceIds.gate = dev.body.id;

  const poll = await asConnector(request).poll({
    version: "1.0.0",
    hostname: "CN-PC",
    os: "Windows 11",
    uptimeSeconds: 120,
    outbox: 0,
    devices: reachable(deviceIds.gate),
  });
  expect(poll.status).toBe(200);
  expect(poll.body.config.devices.map((d: { id: number }) => d.id)).toEqual([deviceIds.gate]);

  await open(page, adminToken, `${PAGE}/connectors`);
  const card = page.getByTestId(`connector-card-${connectorId}`);
  await expect(card).toHaveAttribute("data-state", "online");
  await expect(page.getByTestId(`connector-state-${connectorId}`)).toHaveText("Online");
  await expect(card).toContainText("CN-PC");
  await expect(page.getByTestId(`connector-devices-${connectorId}`)).toContainText("cn_gate");
  await expect(page.getByTestId(`connector-devices-${connectorId}`)).toContainText("Connected");
});

test("Settings → Devices can choose the connector for a device, and says so in the list", async ({ page, request }) => {
  await page.addInitScript((t) => localStorage.setItem("uk_textile_token", t), adminToken);
  await page.goto("/hr/settings");
  await page.getByRole("tab", { name: /Devices/ }).click();
  await expect(page.getByText("cn_gate")).toBeVisible();
  await expect(page.getByText(/via site connector cn_Unit 1/).first()).toBeVisible();

  await page.getByRole("button", { name: /Add Device/ }).click();
  await page.getByPlaceholder("e.g. Main Gate Scanner").fill("cn_office");
  await page.getByPlaceholder("192.168.1.201").fill("192.168.0.51");
  await page.getByTestId("new-device-connector").selectOption({ label: "Site connector: cn_Unit 1" });
  await page.getByRole("button", { name: "Save Device" }).click();
  await expect(page.getByText("Device added", { exact: true })).toBeVisible();
  const list = (await admin(request, "GET", "/api/biometric-devices")).body as {
    id: number;
    name: string;
    connectorId: number | null;
  }[];
  const office = list.find((d) => d.name === "cn_office")!;
  expect(office.connectorId).toBe(connectorId);
  deviceIds.office = office.id;

  // and back to connecting directly
  await page
    .locator("div.rounded-xl.border", { hasText: "cn_office" })
    .locator("button[title^='Edit connection']")
    .click();
  await page.getByTestId(`edit-device-connector-${office.id}`).selectOption("");
  await page.getByRole("button", { name: "Save Connection" }).click();
  await expect(page.getByText("Device updated", { exact: true })).toBeVisible();
  const after = (
    (await admin(request, "GET", "/api/biometric-devices")).body as { id: number; connectorId: number | null }[]
  ).find((d) => d.id === office.id)!;
  expect(after.connectorId).toBeNull();
  await admin(request, "PUT", `/api/biometric-devices/${office.id}`, { connectorId });
});

test("the overview says which connector reaches each device and what it reported", async ({ page, request }) => {
  await asConnector(request).poll({
    devices: {
      ...reachable(deviceIds.gate),
      [String(deviceIds.office)]: { ok: false, code: "timeout", error: "The device stopped answering." },
    },
  });
  await open(page, adminToken);
  await expect(page.getByTestId(`dc-device-${deviceIds.gate}-via`)).toContainText("cn_Unit 1");
  await expect(page.getByTestId(`dc-device-${deviceIds.gate}`)).toHaveAttribute("data-state", "connected");
  await expect(page.getByTestId(`dc-device-${deviceIds.office}`)).toHaveAttribute("data-state", "disconnected");
  await expect(page.getByTestId(`dc-device-${deviceIds.office}-reason`)).toContainText("The device stopped answering.");
  await expect(page.getByTestId(`dc-device-${deviceIds.office}-reason`)).toContainText(
    "as the connector's computer sees it",
  );
  await expect(page.getByTestId("cloud-notice")).toHaveCount(0);
});

test("reading users through the connector: the connector is asked, answers, and the page shows who is on the device", async ({
  page,
  request,
}) => {
  await open(page, adminToken, `${PAGE}/push`);
  const sim = asConnector(request);
  await page.getByTestId(`push-device-read-${deviceIds.gate}`).click();

  let jobs: { id: number; kind: string; deviceId: number; payload: { target: { host: string; port: number } } }[] = [];
  await expect
    .poll(
      async () => {
        const polled = await sim.poll(undefined, 4);
        expect(polled.status).toBe(200);
        jobs = jobs.concat(polled.body.jobs);
        return jobs.length;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  const read = jobs.find((j) => j.kind === "read_users")!;
  expect(read.deviceId).toBe(deviceIds.gate);
  expect(read.payload.target).toMatchObject({ host: "192.168.0.50", port: 4370 });
  const done = await sim.report(read.id, {
    ok: true,
    data: {
      users: [
        { uid: 1, userId: "CN1001", name: "Connector One", privilege: 0, card: 0, hasPassword: false, group: "" },
      ],
      capacity: { users: 1, usersCap: 3000, records: 10, recordsCap: 150000 },
      ms: 12,
    },
  });
  expect(done.status()).toBe(200);
  await expect(page.getByText("Read 1 device", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("push-row-CN1001")).toBeVisible();
  await expect(page.getByTestId("push-row-CN1001")).toContainText("Connector One");
});

test("a user is added through the connector and the page says what the device did", async ({ page, request }) => {
  await open(page, adminToken, `${PAGE}/push`);
  const sim = asConnector(request);
  await page.getByTestId("push-add-user").click();
  await page.getByTestId("user-source-manual").click();
  await page.getByTestId("user-id").fill("CN2001");
  await page.getByTestId("user-name").fill("Added Remotely");
  await expect(page.getByTestId(`user-device-${deviceIds.gate}`)).toBeChecked();
  await page.getByTestId("user-submit").click();

  let jobs: { id: number; kind: string; payload: { mode: string; specs: { userId: string; name: string }[] } }[] = [];
  await expect
    .poll(
      async () => {
        const polled = await sim.poll(undefined, 4);
        expect(polled.status).toBe(200);
        jobs = jobs.concat(polled.body.jobs);
        return jobs.some((j) => j.kind === "apply_users");
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  const apply = jobs.find((j) => j.kind === "apply_users")!;
  expect(apply.payload.mode).toBe("create");
  expect(apply.payload.specs[0]).toMatchObject({ userId: "CN2001", name: "Added Remotely" });
  await sim.report(apply.id, {
    ok: true,
    data: {
      added: ["CN2001"],
      updated: [],
      skipped: [],
      failed: [],
      users: [
        { uid: 1, userId: "CN1001", name: "Connector One", privilege: 0, card: 0, hasPassword: false, group: "" },
        { uid: 2, userId: "CN2001", name: "Added Remotely", privilege: 0, card: 0, hasPassword: false, group: "" },
      ],
      capacity: { users: 2, usersCap: 3000 },
    },
  });
  await expect(page.getByTestId("change-result-title")).toHaveText("Added 1 entry on the devices", { timeout: 20_000 });
  await page.getByTestId("change-result-close").click();
  await expect(page.getByTestId("push-row-CN2001")).toBeVisible();
});

test("a connector that has gone quiet fails a read at once, with the reason, instead of leaving the page waiting", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  await open(page, adminToken, `${PAGE}/push`);
  // the connector is online while it keeps calling in; after 45 seconds of silence the server treats it as offline
  await expect
    .poll(
      async () =>
        ((await admin(request, "GET", `${BASE}/connectors`)).body.connectors as { id: number; state: string }[]).find(
          (c) => c.id === connectorId,
        )?.state,
      { timeout: 90_000, intervals: [3_000] },
    )
    .toBe("offline");
  await page.getByTestId(`push-device-read-${deviceIds.gate}`).click();
  await expect(page.getByText("Read 0 of 1 devices", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/was last heard from/).first()).toBeVisible();
});

test("a connector disabled in the HRMS is turned away at its next call, and its devices say why", async ({
  page,
  request,
}) => {
  await open(page, adminToken, `${PAGE}/connectors`);
  await page.getByTestId(`connector-toggle-${connectorId}`).click();
  await expect(page.getByTestId("connector-disable-dialog")).toContainText("locked out at its next call");
  await page.getByTestId("connector-disable-confirm").click();
  await expect(page.getByTestId(`connector-state-${connectorId}`)).toHaveText("Switched off");
  const poll = await asConnector(request).poll();
  expect(poll.status).toBe(403);
  expect(poll.body.error).toBe("revoked");

  await open(page, adminToken);
  await expect(page.getByTestId(`dc-device-${deviceIds.gate}-reason`)).toContainText("switched off in the HRMS");
  await open(page, adminToken, `${PAGE}/connectors`);
  await page.getByTestId(`connector-toggle-${connectorId}`).click();
  await expect(page.getByTestId(`connector-state-${connectorId}`)).not.toHaveText("Switched off");
  expect((await asConnector(request).poll()).status).toBe(200);
});

test("the settings of a connector are checked and saved", async ({ page, request }) => {
  await open(page, adminToken, `${PAGE}/connectors`);
  await page.getByTestId(`connector-settings-${connectorId}`).click();
  await page.getByTestId("connector-settings-minutes").fill("1500");
  await expect(page.getByText("Reading punches every 0 (never) to 1440 minutes.")).toBeVisible();
  await expect(page.getByTestId("connector-settings-save")).toBeDisabled();
  await page.getByTestId("connector-settings-minutes").fill("30");
  await page.getByTestId("connector-settings-save").click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const poll = await asConnector(request).poll();
  expect(poll.body.config.punchSyncMinutes).toBe(30);
});

test("a new pairing code can be made, and the old connection keeps working until it is used", async ({
  page,
  request,
}) => {
  await open(page, adminToken, `${PAGE}/connectors`);
  await page.getByTestId(`connector-new-code-${connectorId}`).click();
  await expect(page.getByTestId("connector-code")).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const code = (await page.getByTestId("connector-code").textContent())!.trim();
  expect(code).not.toBe(pairingCode);
  await page.getByTestId("connector-code-close").click();
  expect((await asConnector(request).poll()).status).toBe(200);
  const second = await request.post("/api/connector/pair", { data: { code } });
  expect(second.status()).toBe(200);
  expect((await asConnector(request).poll()).status, "the old token stops working once the new pairing is done").toBe(
    401,
  );
  connectorToken = (await second.json()).token;
});

test("a role that may only view attendance can see the connectors but not change them", async ({ page, request }) => {
  await open(page, viewerToken, `${PAGE}/connectors`);
  await expect(page.getByTestId(`connector-card-${connectorId}`)).toBeVisible();
  await expect(page.getByTestId("connector-add")).toBeDisabled();
  await expect(page.getByTestId(`connector-new-code-${connectorId}`)).toBeDisabled();
  await expect(page.getByTestId(`connector-toggle-${connectorId}`)).toBeDisabled();
  await expect(page.getByTestId(`connector-remove-${connectorId}`)).toBeDisabled();
  expect((await api(request, viewerToken, "POST", `${BASE}/connectors`, { name: "cn_nope" })).status).toBe(403);
  expect(
    (await api(request, viewerToken, "PATCH", `${BASE}/connectors/${connectorId}`, { isActive: false })).status,
  ).toBe(403);
  expect((await api(request, viewerToken, "DELETE", `${BASE}/connectors/${connectorId}`)).status).toBe(403);
  const list = await api(request, viewerToken, "GET", `${BASE}/connectors`);
  expect(list.status).toBe(200);
  expect(JSON.stringify(list.body)).not.toContain(connectorToken);
});

test("removing a connector sends its devices back to being connected directly", async ({ page, request }) => {
  await open(page, adminToken, `${PAGE}/connectors`);
  await page.getByTestId(`connector-remove-${connectorId}`).click();
  await expect(page.getByTestId("connector-remove-dialog")).toContainText("go back to being connected directly");
  await page.getByTestId("connector-remove-confirm").click();
  await expect(page.getByTestId(`connector-card-${connectorId}`)).toHaveCount(0);
  const list = (await admin(request, "GET", "/api/biometric-devices")).body as {
    id: number;
    connectorId: number | null;
  }[];
  expect(list.find((d) => d.id === deviceIds.gate)!.connectorId).toBeNull();
  expect((await asConnector(request).poll()).status, "its token no longer works").toBe(401);
});

test("the section is in the tabs and reachable by address", async ({ page }) => {
  await open(page, adminToken, `${PAGE}/connectors`);
  await expect(page.getByText("Site connectors", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("connectors-tab")).toBeVisible();
});
