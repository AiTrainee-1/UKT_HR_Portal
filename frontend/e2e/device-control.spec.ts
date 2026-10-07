import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { HR_PASSWORD, HR_USERNAME } from "./helpers";

// Attendance → Device Control, end to end against the real backend and three FAKE biometric terminals
// (backend/fake_zk_device.py) that speak the real ZK protocol, so the portal's device code runs for real: it connects,
// reads users and punches, writes and deletes users, and the spec reads the terminals back to see what it did.
//
// Everything created here is prefixed "dc" / "DC" and removed afterwards, so the shared seed and the other specs are
// untouched. The server throttles sign-ins (10 a minute), so each role signs in ONCE.

const FAKE = "http://127.0.0.1:14380";
const BASE_PORT = 14371;
const VIEWER_PASSWORD = "Passw0rd!dcview";
const PAGE = "/hr/attendance/DeviceControl";

let adminToken = "";
let viewerToken = "";
let devices: { a: number; b: number; c: number; down: number };
const employees: Record<string, number> = {};

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

type FakeUser = {
  uid: number;
  user_id: string;
  name: string;
  privilege: number;
  card: number;
  flag: number;
  password: string;
};
async function terminal(request: APIRequestContext, index: number) {
  const res = await request.get(`${FAKE}/devices/${index}`);
  expect(res.status()).toBe(200);
  return (await res.json()) as { enabled: boolean; users: FakeUser[]; commands: number[] };
}
const userOn = async (request: APIRequestContext, index: number, id: string) =>
  (await terminal(request, index)).users.find((u) => u.user_id === id);
const flags = (request: APIRequestContext, index: number, body: Record<string, unknown>) =>
  request.post(`${FAKE}/devices/${index}/flags`, { data: body });

async function purge(request: APIRequestContext) {
  const list = (await admin(request, "GET", "/api/biometric-devices")).body as { id: number | string; name: string }[];
  for (const d of list) {
    if (typeof d.id === "number" && d.name.startsWith("dc_"))
      await admin(request, "DELETE", `/api/biometric-devices/${d.id}`);
  }
  const emps = (await admin(request, "GET", "/api/employees")).body as { id: number; employeeCode: string }[];
  for (const e of emps.filter((e) => e.employeeCode.startsWith("DC")))
    await admin(request, "DELETE", `/api/employees/${e.id}`);
  const departments = (await admin(request, "GET", "/api/departments")).body as { id: number; name: string }[];
  for (const d of departments.filter((d) => d.name.startsWith("DC ")))
    await admin(request, "DELETE", `/api/departments/${d.id}`);
  const users = (await admin(request, "GET", "/api/hr-users")).body as { id: number; username: string }[];
  for (const u of users.filter((u) => u.username.startsWith("dc_")))
    await admin(request, "DELETE", `/api/hr-users/${u.id}`);
  const roles = (await admin(request, "GET", "/api/roles")).body as { id: number; name: string }[];
  for (const r of roles.filter((r) => r.name.startsWith("dc_"))) await admin(request, "DELETE", `/api/roles/${r.id}`);
}

async function addDevice(request: APIRequestContext, name: string, port: number) {
  const res = await admin(request, "POST", "/api/biometric-devices", {
    name,
    deviceType: "aiface_mars",
    host: "127.0.0.1",
    port,
    connectionConfig: { password: 0 },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as number;
}

/** Put the terminals, the employees and the portal's copy of the users back to the starting picture. */
async function resetWorld(request: APIRequestContext) {
  expect((await request.post(`${FAKE}/reset`, { data: {} })).status()).toBe(200);
  for (const [code, status] of Object.entries({ DC1003: "active", DC1006: "inactive" })) {
    await admin(request, "PATCH", `/api/employees/${employees[code]}`, { status });
  }
  const read = await admin(request, "POST", "/api/attendance/device-control/users/refresh", {});
  expect(read.status, JSON.stringify(read.body)).toBe(200);
}

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

const row = (page: Page, code: string) => page.getByTestId(`push-row-${code}`);
const codesShown = async (page: Page) =>
  (
    await page
      .locator("[data-testid^='push-row-']")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.slice(9)))
  ).sort();

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  adminToken = await signIn(request, HR_USERNAME, HR_PASSWORD);
  await purge(request);

  devices = {
    a: await addDevice(request, "dc_a", BASE_PORT),
    b: await addDevice(request, "dc_b", BASE_PORT + 1),
    c: await addDevice(request, "dc_c", BASE_PORT + 2),
    down: await addDevice(request, "dc_down", 1), // an address on this machine with nothing listening
  };

  const branches = (await admin(request, "GET", "/api/branches")).body as { id: number }[];
  const dept = await admin(request, "POST", "/api/departments", { name: "DC Stitching", branchId: branches[0].id });
  expect(dept.status, JSON.stringify(dept.body)).toBe(201);
  const make = async (code: string, first: string, last: string) => {
    const res = await admin(request, "POST", "/api/employees", {
      employeeCode: code,
      firstName: first,
      lastName: last,
      phone: "9000000077",
      employmentType: "staff",
      branchId: branches[0].id,
      departmentId: dept.body.id,
      salaryType: "monthly",
      salaryAmount: 20000,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    employees[code] = res.body.id;
  };
  await make("DC1001", "Asha", "Dev");
  await make("DC1002", "Ravi", "Dev");
  await make("DC1003", "Meena", "Dev");
  await make("DC1004", "Kumar", "Dev");
  await make("DC1005", "Nina", "Dev");
  await make("DC1006", "Old", "Inactive");

  const role = await admin(request, "POST", "/api/roles", {
    name: "dc_view_attendance",
    permissions: { attendance: "view" },
  });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  const user = await admin(request, "POST", "/api/hr-users", {
    username: "dc_viewer",
    password: VIEWER_PASSWORD,
    roleId: role.body.id,
  });
  expect(user.status, JSON.stringify(user.body)).toBe(201);
  viewerToken = await signIn(request, "dc_viewer", VIEWER_PASSWORD);
});

test.afterAll(async ({ request }) => {
  await purge(request);
  await request.post(`${FAKE}/reset`, { data: {} });
});

test.beforeEach(async ({ request }) => {
  await resetWorld(request);
});

// ── overview ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("the overview counts the devices this server can reach and says why one cannot be", async ({ page }) => {
  await open(page, adminToken);
  await expect(page.getByRole("heading", { name: "Device Control" })).toBeVisible();

  await expect(page.getByTestId("dc-stat-configured-value")).toHaveText("4");
  await expect(page.getByTestId("dc-stat-connected-value")).toHaveText("3");
  await expect(page.getByTestId("dc-stat-disconnected-value")).toHaveText("1");

  await expect(page.getByTestId(`dc-device-${devices.a}`)).toHaveAttribute("data-state", "connected");
  await expect(page.getByTestId(`dc-device-${devices.down}`)).toHaveAttribute("data-state", "disconnected");
  await expect(page.getByTestId(`dc-device-${devices.down}-reason`)).toContainText("refused");
  await expect(page.getByTestId(`dc-device-${devices.down}-reason`)).toContainText("What to do");

  // what the device reported about itself
  await expect(page.getByTestId(`dc-device-${devices.a}-users`)).toContainText("3,000");
  await expect(page.getByTestId(`dc-device-${devices.a}-users`)).toContainText("4");
  await expect(page.getByTestId(`dc-device-${devices.a}-status`)).toContainText("Connected");
});

test("a device card opens Data Fetch with that device already chosen, and Data Push on that device", async ({
  page,
}) => {
  await open(page, adminToken);
  await page.getByTestId(`dc-device-${devices.b}-fetch`).click();
  await expect(page).toHaveURL(/\/DeviceControl\/fetch\?device=/);
  await expect(page.getByTestId(`fetch-pick-${devices.b}`)).toBeChecked();
  await expect(page.getByTestId(`fetch-pick-${devices.a}`)).not.toBeChecked();

  await open(page, adminToken);
  await page.getByTestId(`dc-device-${devices.b}-manage`).click();
  await expect(page).toHaveURL(/\/DeviceControl\/push\?devices=/);
  await expect(row(page, "DC9002")).toBeVisible();
  await expect(row(page, "DC9001")).toHaveCount(0);
});

test("reading one device from its card refreshes its users", async ({ page, request }) => {
  await open(page, adminToken);
  await page.getByTestId(`dc-device-${devices.a}-read`).click();
  await expect(page.getByText(/Read dc_a/).first()).toBeVisible();
  expect((await terminal(request, 0)).users).toHaveLength(4);
});

// ── Data Push: who is where ──────────────────────────────────────────────────────────────────────────────────────────

test("Data Push lists everyone on the devices and who they are in the HRMS", async ({ page }) => {
  await open(page, adminToken, `${PAGE}/push`);
  await expect(row(page, "DC1001")).toHaveAttribute("data-link", "linked");
  await expect(row(page, "DC9001")).toHaveAttribute("data-link", "device_only");
  await expect(row(page, "DC1005")).toHaveAttribute("data-link", "hrms_only");
  await expect(row(page, "DC1006")).toHaveAttribute("data-link", "inactive_on_device");
  await expect(row(page, "DC1001")).toContainText("Asha Dev");
  await expect(row(page, "DC1001")).toContainText("DC Stitching");

  // where each person is
  const on = (code: string, device: number) => page.getByTestId(`presence-${code}-${device}`);
  await expect(on("DC1001", devices.a)).toHaveAttribute("data-on", "true");
  await expect(on("DC1001", devices.b)).toHaveAttribute("data-on", "true");
  await expect(on("DC1001", devices.c)).toHaveAttribute("data-on", "false");
  await expect(on("DC1004", devices.c)).toHaveAttribute("data-on", "true");
  // admin on one device and a normal user on the other: flagged
  await expect(page.getByTestId("push-differs-DC1001")).toContainText("different roles");

  await expect(page.getByTestId("push-statval-device-only-value")).toHaveText("2");
  await expect(page.getByTestId("push-statval-inactive-value")).toHaveText("1");
  await expect(page.getByTestId("push-statval-multiple-value")).toHaveText("2");
});

test("the filters answer: who is on a device, who is not, who is in the HRMS and who is not", async ({ page }) => {
  await open(page, adminToken, `${PAGE}/push`);
  await expect(row(page, "DC1001")).toBeVisible();

  // a device's own people
  await page.getByTestId(`push-device-${devices.b}`).click();
  await expect.poll(() => codesShown(page)).toEqual(["DC1001", "DC1002", "DC9002"]);
  await page.getByTestId(`push-device-${devices.b}`).click();

  // who is NOT on a device
  await page.getByTestId("push-device-filter").click();
  await page.getByTestId("push-device-mode").click();
  await page.getByRole("option", { name: "Is NOT on any of these" }).click();
  await page.getByTestId(`push-device-option-${devices.a}`).click();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await codesShown(page)).includes("DC1001")).toBe(false);
  const missing = await codesShown(page);
  expect(missing).toEqual(expect.arrayContaining(["DC9002", "DC1004", "DC1005", "DC1006"]));
  expect(missing).not.toContain("DC1002");
  await page.getByTestId("push-clear-filters").click();

  // in a device but not in the HRMS
  await page.getByTestId("push-filter-link").click();
  await page.getByRole("option", { name: "Not in HRMS" }).click();
  await expect.poll(() => codesShown(page)).toEqual(["DC9001", "DC9002"]);
  await page.getByTestId("push-clear-filters").click();

  // in the HRMS but on no device, among ours
  await page.getByTestId("push-filter-link").click();
  await page.getByRole("option", { name: /In HRMS, not on any device/ }).click();
  await expect.poll(async () => (await codesShown(page)).includes("DC1001")).toBe(false);
  expect(await codesShown(page)).toContain("DC1005");
  await page.getByTestId("push-clear-filters").click();

  // on several devices; and by search
  await page.getByTestId("push-filter-count").click();
  await page.getByRole("option", { name: "On several devices" }).click();
  await expect.poll(() => codesShown(page)).toEqual(["DC1001", "DC1002"]);
  await page.getByTestId("push-clear-filters").click();
  await page.getByTestId("push-search").fill("stranger");
  await expect.poll(() => codesShown(page)).toEqual(["DC9001", "DC9002"]);
});

test("sorting by the number of devices puts the people on the most devices first, and again the fewest", async ({
  page,
}) => {
  await open(page, adminToken, `${PAGE}/push`);
  await expect(row(page, "DC1001")).toBeVisible();
  await page.getByTestId("push-sort-devices").click(); // descending: the most devices first
  await expect
    .poll(async () => await page.locator("[data-testid^='push-row-']").first().getAttribute("data-testid"))
    .toMatch(/DC1001|DC1002/);
  const first = (await page.locator("[data-testid^='push-row-']").first().getAttribute("data-testid"))!.slice(9);
  expect(["DC1001", "DC1002"]).toContain(first); // the only two on two devices
  await page.getByTestId("push-sort-devices").click(); // ascending: people on no device first
  await expect
    .poll(async () => await page.locator("[data-testid^='push-row-']").first().getAttribute("data-link"))
    .toBe("hrms_only");
});

test("a filter is in the address, so a view can be sent to someone", async ({ page }) => {
  await open(page, adminToken, `${PAGE}/push?link=device_only`);
  await expect.poll(() => codesShown(page)).toEqual(["DC9001", "DC9002"]);
  await page.getByTestId("push-search").fill("two");
  await expect(page).toHaveURL(/search=two/);
  await expect.poll(() => codesShown(page)).toEqual(["DC9002"]);
});

// ── Data Push: changing the devices ──────────────────────────────────────────────────────────────────────────────────

test("an employee is added to the devices with a photo taken with the camera, and the photo is kept on the HRMS profile", async ({
  page,
  request,
}) => {
  await open(page, adminToken, `${PAGE}/push`);
  await page.getByTestId("push-add-user").click();
  await page.getByTestId("user-search").fill("Nina");
  await page.getByTestId("user-pick-DC1005").click();
  await expect(page.getByTestId("user-id")).toHaveValue("DC1005");
  await expect(page.getByTestId("user-name")).toHaveValue("Nina Dev");
  await expect(page.getByTestId(`user-device-${devices.a}`)).toBeChecked();

  // the camera (a fake one in the test browser)
  await page.getByTestId("photo-open-camera").click();
  await expect(page.getByTestId("photo-video")).toBeVisible();
  await page.waitForFunction(
    () => ((document.querySelector("[data-testid=photo-video]") as HTMLVideoElement | null)?.videoWidth ?? 0) > 0,
  );
  await page.getByTestId("photo-capture-button").click();
  await expect(page.getByTestId("photo-preview")).toBeVisible();
  expect(await page.getByTestId("photo-preview").getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);

  await page.getByTestId("user-submit").click();
  await expect(page.getByTestId("change-result-title")).toHaveText("Added 3 entries on the devices");
  await expect(page.getByTestId("change-result")).toContainText("Photo saved");
  await page.getByTestId("change-result-close").click();

  for (const index of [0, 1, 2]) {
    const user = await userOn(request, index, "DC1005");
    expect(user, `on terminal ${index}`).toBeTruthy();
    expect(user!.name).toBe("Nina Dev");
    expect(user!.flag).toBe(1);
  }
  const emp = (await admin(request, "GET", `/api/employees/${employees.DC1005}`)).body;
  expect(emp.photoUrl).toBeTruthy();
  await expect(row(page, "DC1005")).toHaveAttribute("data-link", "linked");
  await expect(page.getByTestId("presence-DC1005-" + devices.c)).toHaveAttribute("data-on", "true");
});

test("someone who is not in the HRMS can be added to chosen devices only", async ({ page, request }) => {
  await open(page, adminToken, `${PAGE}/push`);
  await page.getByTestId("push-add-user").click();
  await page.getByTestId("user-source-manual").click();
  await page.getByTestId("user-id").fill("DC7777");
  await page.getByTestId("user-name").fill("Walk In");
  await page.getByTestId("user-card").fill("123456");
  await page.getByTestId(`user-device-${devices.c}`).click();
  await expect(page.getByTestId("photo-open-camera")).toBeDisabled();
  await page.getByTestId("user-submit").click();
  await expect(page.getByTestId("change-result-title")).toHaveText("Added 2 entries on the devices");
  await page.getByTestId("change-result-close").click();

  const a = await userOn(request, 0, "DC7777");
  expect(a).toMatchObject({ name: "Walk In", card: 123456, privilege: 0, flag: 1 });
  expect(await userOn(request, 1, "DC7777")).toBeTruthy();
  expect(await userOn(request, 2, "DC7777")).toBeUndefined();
  await expect(row(page, "DC7777")).toHaveAttribute("data-link", "device_only");
});

test("the form refuses what the device cannot hold", async ({ page, request }) => {
  await open(page, adminToken, `${PAGE}/push`);
  await page.getByTestId("push-add-user").click();
  await page.getByTestId("user-source-manual").click();
  await page.getByTestId("user-id").fill("bad id!");
  await page.getByTestId("user-name").fill("A".repeat(30));
  await expect(page.getByTestId("user-name-count")).toHaveText("30/24");
  await expect(page.getByTestId("user-submit")).toBeDisabled();
  await page.getByTestId("user-id").fill("DC7000");
  await page.getByTestId("user-name").fill("Fits");
  await page.getByTestId("user-password").fill("12ab");
  await expect(page.getByTestId("user-submit")).toBeDisabled();
  await page.getByTestId("user-password").fill("1234");
  await expect(page.getByTestId("user-submit")).toBeEnabled();
  expect(await userOn(request, 0, "DC7000")).toBeUndefined();
});

test("a user is changed on every device they are on, and nothing else about them moves", async ({ page, request }) => {
  const before = await userOn(request, 0, "DC1002");
  await open(page, adminToken, `${PAGE}/push`);
  await page.getByTestId("push-edit-DC1002").click();
  await expect(page.getByTestId("user-id")).toHaveAttribute("readonly", "");
  await page.getByTestId("user-name").fill("Ravi Edited");
  await page.getByTestId("user-role").click();
  await page.getByRole("option", { name: "Administrator" }).click();
  await page.getByTestId("user-submit").click();
  await expect(page.getByTestId("change-result-title")).toHaveText("Changed 2 entries on the devices");
  await page.getByTestId("change-result-close").click();

  for (const index of [0, 1]) {
    const user = await userOn(request, index, "DC1002");
    expect(user).toMatchObject({ name: "Ravi Edited", privilege: 6, card: 0, flag: 1 });
  }
  expect(before).toMatchObject({ name: "Ravi Dev", privilege: 0 });
  await expect(row(page, "DC1002")).toContainText("Administrator");
});

test("editing leaves a device's other details alone when only one thing changes", async ({ page, request }) => {
  await open(page, adminToken, `${PAGE}/push`);
  await page.getByTestId("push-edit-DC1001").click();
  await expect(page.getByTestId("user-differs")).toContainText("different roles");
  await page.getByTestId("user-name").fill("Asha Renamed");
  await page.getByTestId("user-submit").click();
  await expect(page.getByTestId("change-result-title")).toHaveText("Changed 2 entries on the devices");
  await page.getByTestId("change-result-close").click();
  // the role and the card were not in the change: device A still has them, device B still has none
  expect(await userOn(request, 0, "DC1001")).toMatchObject({ name: "Asha Renamed", privilege: 14, card: 555 });
  expect(await userOn(request, 1, "DC1001")).toMatchObject({ name: "Asha Renamed", privilege: 0, card: 0 });
});

test("deleting a user removes them from the devices and makes the employee Inactive, never deletes them", async ({
  page,
  request,
}) => {
  await open(page, adminToken, `${PAGE}/push`);
  await page.getByTestId("push-delete-DC1003").click();
  await expect(page.getByTestId("delete-dialog")).toContainText("never deleted from the HRMS");
  await expect(page.getByTestId("delete-mark-inactive")).toBeChecked();
  await expect(page.getByTestId("delete-inactive-summary")).toContainText("1 employee will become Inactive");
  await page.getByTestId("delete-confirm").click();
  await expect(page.getByTestId("change-result-title")).toContainText(
    "Deleted 1 from the devices. 1 made Inactive in the HRMS.",
  );
  await page.getByTestId("change-result-close").click();

  expect(await userOn(request, 0, "DC1003")).toBeUndefined();
  const emp = await admin(request, "GET", `/api/employees/${employees.DC1003}`);
  expect(emp.status).toBe(200);
  expect(emp.body.status).toBe("inactive");
  await expect(row(page, "DC1003")).toHaveCount(0);
});

test("a delete can leave the employee as they are, and warns about a user who can open the device menu", async ({
  page,
  request,
}) => {
  await open(page, adminToken, `${PAGE}/push`);
  await page.getByTestId("push-delete-DC1001").click();
  await expect(page.getByTestId("delete-admins")).toContainText("Asha Dev (Super admin)");
  await page.getByTestId("delete-mark-inactive").click();
  await expect(page.getByTestId("delete-mark-inactive")).not.toBeChecked();
  await page.getByTestId(`delete-device-${devices.b}`).click(); // keep them on device B
  await page.getByTestId("delete-confirm").click();
  await expect(page.getByTestId("change-result-title")).toHaveText("Deleted 1 from the devices.");
  await page.getByTestId("change-result-close").click();
  expect(await userOn(request, 0, "DC1001")).toBeUndefined();
  expect(await userOn(request, 1, "DC1001")).toBeTruthy();
  expect((await admin(request, "GET", `/api/employees/${employees.DC1001}`)).body.status).toBe("active");
});

test("people are put on more devices with the details the devices already hold", async ({ page, request }) => {
  await open(page, adminToken, `${PAGE}/push`);
  await page.getByTestId("push-select-DC1004").click();
  await page.getByTestId("push-bulk-add").click();
  await expect(page.getByTestId(`add-device-${devices.a}`)).toBeChecked();
  await expect(page.getByTestId(`add-device-${devices.c}`)).toBeDisabled(); // already has them
  await page.getByTestId("add-to-devices-confirm").click();
  await expect(page.getByTestId("change-result-title")).toHaveText("Added 2 entries on the devices");
  await page.getByTestId("change-result-close").click();
  expect(await userOn(request, 0, "DC1004")).toMatchObject({ name: "Kumar Dev", privilege: 0 });
  expect(await userOn(request, 1, "DC1004")).toMatchObject({ name: "Kumar Dev" });
});

test("when one device refuses, the others still get the change and the result says which failed", async ({
  page,
  request,
}) => {
  await flags(request, 1, { refuse_writes: true });
  await open(page, adminToken, `${PAGE}/push`);
  await page.getByTestId("push-add-user").click();
  await page.getByTestId("user-source-manual").click();
  await page.getByTestId("user-id").fill("DC7778");
  await page.getByTestId("user-name").fill("Half Done");
  await page.getByTestId(`user-device-${devices.c}`).click();
  await page.getByTestId("user-submit").click();
  await expect(page.getByTestId("change-result-title")).toHaveText("Added 1, but 1 did not go through");
  await expect(page.getByTestId(`change-result-${devices.b}`)).toContainText("failed");
  await expect(page.getByTestId("change-result-notes")).toContainText("dc_b");
  expect(await userOn(request, 0, "DC7778")).toBeTruthy();
  expect(await userOn(request, 1, "DC7778")).toBeUndefined();
  expect((await terminal(request, 1)).enabled).toBe(true);
});

// ── Data Fetch ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function punchCount(request: APIRequestContext, code: string) {
  const res = await admin(request, "GET", `/api/attendance/punches?search=${code}&limit=1`);
  expect(res.status).toBe(200);
  return res.body.total as number;
}

test("a preview says what an update would add and changes nothing; the update then adds exactly that", async ({
  page,
  request,
}) => {
  await open(page, adminToken, `${PAGE}/fetch`);
  await expect(page.getByTestId(`fetch-pick-${devices.a}`)).toBeChecked();
  await expect(page.getByTestId(`fetch-pick-${devices.down}`)).not.toBeChecked(); // it cannot be reached
  await page.getByTestId("fetch-preset-last7").click();

  await page.getByTestId("fetch-preview").click();
  await expect(page.getByTestId("fetch-run")).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(page.getByTestId("fetch-run")).toHaveAttribute("data-mode", "preview");
  await expect(page.getByTestId("fetch-stat-new-value")).toHaveText("8");
  await expect(page.getByTestId("fetch-unmatched")).toContainText("DC9001");
  await expect(page.getByTestId("fetch-samples")).toContainText("Asha Dev");
  expect(await punchCount(request, "DC1001")).toBe(0);
  expect(await punchCount(request, "DC1002")).toBe(0);

  await page.getByTestId("fetch-update").click();
  await expect(page.getByTestId("fetch-confirm")).toContainText("nothing is ever deleted");
  await page.getByTestId("fetch-confirm-yes").click();
  await expect(page.getByTestId("fetch-run")).toHaveAttribute("data-mode", "update", { timeout: 30_000 });
  await expect(page.getByTestId("fetch-run")).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(page.getByTestId("fetch-stat-new-value")).toHaveText("8");
  await expect(page.getByTestId(`fetch-device-${devices.a}-new`)).toHaveText("8");
  expect(await punchCount(request, "DC1001")).toBe(4);
  expect(await punchCount(request, "DC1002")).toBe(4);
  expect(await punchCount(request, "DC9001")).toBe(0); // not an employee: not recorded

  // the same range again: the HRMS already has everything, so nothing is added and nothing doubles
  await page.getByTestId("fetch-update").click();
  await page.getByTestId("fetch-confirm-yes").click();
  await expect(page.getByTestId("fetch-run-line")).toContainText("Nothing to add", { timeout: 30_000 });
  expect(await punchCount(request, "DC1001")).toBe(4);

  // the history keeps the earlier runs
  await expect(page.getByTestId("fetch-history").locator("button")).toHaveCount(2);
});

test("a device that cannot be reached fails by itself and the run still finishes for the others", async ({ page }) => {
  await open(page, adminToken, `${PAGE}/fetch`);
  await page.getByTestId(`fetch-pick-${devices.down}`).click();
  await page.getByTestId("fetch-preset-today").click();
  await page.getByTestId("fetch-preview").click();
  await expect(page.getByTestId("fetch-run")).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  await expect(page.getByTestId(`fetch-device-${devices.down}`)).toHaveAttribute("data-status", "failed");
  await expect(page.getByTestId(`fetch-device-${devices.down}-error`)).toContainText("refused");
  await expect(page.getByTestId(`fetch-device-${devices.a}`)).toHaveAttribute("data-status", "done");
});

test("a custom range checks its dates before anything is asked of a device", async ({ page }) => {
  await open(page, adminToken, `${PAGE}/fetch`);
  await page.getByTestId("fetch-preset-custom").click();
  await page.getByTestId("fetch-from").fill("2026-10-05");
  await page.getByTestId("fetch-to").fill("2026-10-01");
  await expect(page.getByText("The start date is after the end date.")).toBeVisible();
  await expect(page.getByTestId("fetch-preview")).toBeDisabled();
  await expect(page.getByTestId("fetch-update")).toBeDisabled();
});

// ── who may do what ──────────────────────────────────────────────────────────────────────────────────────────────────

test("a role that may only view attendance can look but not change anything", async ({ page, request }) => {
  await open(page, viewerToken, PAGE);
  await expect(page.getByTestId("dc-go-push")).toBeEnabled(); // its words say "add, change or delete": still only a link
  await expect(page.getByTestId("dc-go-fetch")).toBeEnabled();
  await page.getByTestId("dc-go-push").click();
  await expect(row(page, "DC1001")).toBeVisible();
  await expect(page.getByTestId("push-stat-inactive")).toBeEnabled(); // "delete them from the device": a filter
  await page.getByTestId("push-stat-inactive").click();
  await expect.poll(() => codesShown(page)).toEqual(["DC1006"]);
  await page.getByTestId("push-stat-all").click();
  await expect(page.getByTestId("push-add-user")).toBeDisabled();
  await expect(page.getByTestId("push-edit-DC1002")).toBeDisabled();
  await expect(page.getByTestId("push-delete-DC1003")).toBeDisabled();

  const base = "/api/attendance/device-control";
  expect((await api(request, viewerToken, "GET", `${base}/people`)).status).toBe(200);
  expect((await api(request, viewerToken, "POST", `${base}/users/delete`, { userIds: ["DC1003"] })).status).toBe(403);
  expect(
    (
      await api(request, viewerToken, "POST", `${base}/users/push`, {
        deviceIds: [devices.a],
        users: [{ userId: "DC7", name: "x" }],
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await api(request, viewerToken, "POST", `${base}/fetch/start`, {
        deviceIds: [devices.a],
        range: { preset: "today" },
      })
    ).status,
  ).toBe(403);
  expect(await userOn(request, 0, "DC1003")).toBeTruthy();
});

test("the section is in the Attendance menu", async ({ page }) => {
  await open(page, adminToken);
  await expect(page.getByRole("link", { name: "Device Control" }).first()).toBeVisible();
});

// ── review fixes ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("a device's chip opens the person as that device holds them, with only that device chosen", async ({
  page,
  request,
}) => {
  const onA = await userOn(request, 0, "DC1001");
  await open(page, adminToken, `${PAGE}/push`);
  await page.getByTestId(`presence-DC1001-${devices.b}`).click();
  await expect(page.getByTestId("user-dialog")).toBeVisible();
  await expect(page.getByTestId("user-role")).toContainText("User"); // device B holds a normal user; A holds a super admin
  await expect(page.getByTestId(`user-device-${devices.b}`)).toBeChecked();
  await expect(page.getByTestId(`user-device-${devices.a}`)).not.toBeChecked();
  await page.getByTestId("user-name").fill("Asha On B");
  await page.getByTestId("user-submit").click();
  await expect(page.getByTestId("change-result-title")).toHaveText("Changed 1 entry on the devices");
  await page.getByTestId("change-result-close").click();
  expect(await userOn(request, 1, "DC1001")).toMatchObject({ name: "Asha On B" });
  expect(await userOn(request, 0, "DC1001")).toMatchObject({ name: onA!.name, privilege: 14 });
});

test("a device the person is not on offers to add them there, and only there", async ({ page, request }) => {
  await open(page, adminToken, `${PAGE}/push`);
  await page.getByTestId(`presence-DC1004-${devices.a}`).click(); // DC1004 is on device C only
  await expect(page.getByTestId("add-to-devices-dialog")).toBeVisible();
  await expect(page.getByTestId(`add-device-${devices.a}`)).toBeChecked();
  await expect(page.getByTestId(`add-device-${devices.b}`)).not.toBeChecked();
  await page.getByTestId("add-to-devices-confirm").click();
  await expect(page.getByTestId("change-result-title")).toHaveText("Added 1 entry on the devices");
  await page.getByTestId("change-result-close").click();
  expect(await userOn(request, 0, "DC1004")).toBeTruthy();
  expect(await userOn(request, 1, "DC1004")).toBeUndefined();
});

test("devices ticked in the form stay as they were chosen", async ({ page }) => {
  await open(page, adminToken, `${PAGE}/push`);
  await page.getByTestId("push-add-user").click();
  await page.getByTestId("user-search").fill("Nina");
  await page.getByTestId("user-pick-DC1005").click();
  await expect(page.getByTestId(`user-device-${devices.b}`)).toBeChecked();
  await page.getByTestId(`user-device-${devices.b}`).click();
  await expect(page.getByTestId(`user-device-${devices.b}`)).not.toBeChecked();
  // the page re-checks the devices on its own: that must not tick the box again
  await page.getByTestId("dc-recheck").dispatchEvent("click"); // the dialog covers the button: click it directly
  await page.waitForTimeout(1500);
  await expect(page.getByTestId(`user-device-${devices.b}`)).not.toBeChecked();
  await expect(page.getByTestId("user-submit")).toContainText("Add to 2 devices");
});

test("a photo saved again replaces the one on show, without reloading the page", async ({ page }) => {
  await open(page, adminToken, `${PAGE}/push`);
  const capture = async () => {
    await page.getByTestId("photo-open-camera").click();
    await page.waitForFunction(
      () => ((document.querySelector("[data-testid=photo-video]") as HTMLVideoElement | null)?.videoWidth ?? 0) > 0,
    );
    await page.getByTestId("photo-capture-button").click();
    await expect(page.getByTestId("photo-preview")).toBeVisible();
  };
  await page.getByTestId("push-edit-DC1001").click();
  await capture();
  await page.getByTestId("user-submit").click();
  await expect(page.getByTestId("user-dialog")).toBeHidden();
  const photo = row(page, "DC1001").getByTestId("person-photo");
  await expect(photo).toBeVisible();
  const first = await photo.getAttribute("src");
  expect(first).toMatch(/^blob:/);

  await page.getByTestId("push-edit-DC1001").click();
  await capture();
  await page.getByTestId("user-submit").click();
  await expect(page.getByTestId("user-dialog")).toBeHidden();
  await expect
    .poll(async () => await row(page, "DC1001").getByTestId("person-photo").getAttribute("src"))
    .not.toBe(first);
});

test("the search waits for a pause in typing, then narrows the list", async ({ page }) => {
  await open(page, adminToken, `${PAGE}/push`);
  await expect(row(page, "DC1001")).toBeVisible();
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/device-control/people")) asked.push(new URL(r.url()).searchParams.get("search") ?? "");
  });
  await page.getByTestId("push-search").pressSequentially("Meena", { delay: 40 });
  // the shared seed has another Meena, so the list is the matches, not just ours
  await expect
    .poll(async () => {
      const shown = await codesShown(page);
      return shown.includes("DC1003") && !shown.includes("DC1001");
    })
    .toBe(true);
  expect(asked.filter((x) => x !== "").length, `asked for ${JSON.stringify(asked)}`).toBeLessThanOrEqual(2);
  await page.getByLabel("Clear search").click();
  await expect.poll(async () => (await codesShown(page)).length).toBeGreaterThan(3);
  await expect(page.getByTestId("push-search")).toHaveValue("");
});

test("when the devices cannot be loaded, Data Push and Data Fetch say so instead of claiming there are none", async ({
  page,
}) => {
  let broken = true;
  await page.route("**/device-control/overview**", (route) =>
    broken
      ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' })
      : route.continue(),
  );
  await open(page, adminToken, `${PAGE}/push`);
  await expect(page.getByTestId("dc-error")).toContainText("could not be loaded");
  await expect(page.getByTestId("push-no-devices")).toHaveCount(0);
  await page.getByText("Data Fetch", { exact: true }).first().click();
  await expect(page.getByTestId("dc-error")).toBeVisible();
  await expect(page.getByTestId("fetch-no-devices")).toHaveCount(0);
  broken = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("fetch-tab")).toBeVisible();
});
