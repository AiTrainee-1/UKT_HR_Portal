import { describe, expect, it, vi } from "vitest";
import type { DeleteResult, DeviceControlDevice, FetchRun, PersonRow, PushResult } from "@/lib/api-client/custom-hooks";
import {
  FOLLOW_TIMEOUT_MS,
  LOST_CONTACT_MESSAGE,
  describeOperationWait,
  followOperation,
  isStarted,
  peopleQuery,
  type DeviceOperation,
} from "@/lib/api-client/custom-hooks";
import {
  CONNECTOR_STATE_LABEL,
  CONNECTOR_STATE_TONE,
  EMPTY_FORM,
  NO_FILTERS,
  activeFilterCount,
  byteLength,
  capacityLevel,
  changedFields,
  connectionAdvice,
  copyInput,
  deleteImpact,
  describeConnectorSync,
  describeDeviceFilter,
  describeDiffers,
  describeRun,
  deviceAlerts,
  deviceNameFor,
  fetchProgress,
  filtersActive,
  filtersFromSearch,
  filtersToSearch,
  formFromPerson,
  formatUptime,
  formatCount,
  formatDuration,
  initials,
  isUnreachable,
  isUsable,
  localDate,
  newUserInput,
  pinWidthFor,
  rangeProblem,
  roleLabel,
  shortDeviceName,
  summarizeDelete,
  summarizePush,
  tabFromPath,
  toParams,
  trimToBytes,
  validateConnectorSettings,
  validateForm,
} from "./logic";

const device = (over: Partial<DeviceControlDevice> = {}): DeviceControlDevice => ({
  id: 1,
  name: "HO",
  host: "192.168.0.61",
  port: 4370,
  serialNumber: "SN1",
  deviceType: "aiface_mars",
  isActive: true,
  privateAddress: true,
  via: null,
  connection: { state: "connected", code: "ok", reason: "", latencyMs: 12 },
  push: { state: "live", lastContactAt: null },
  capacity: { users: 345, usersCap: 3000, records: 1000, recordsCap: 150000, faces: 345 },
  deviceTime: null,
  clockSkewSeconds: 0,
  usersRead: { at: null, error: "" },
  ...over,
});

const person = (over: Partial<PersonRow> = {}): PersonRow => ({
  key: "1001",
  userId: "1001",
  name: "Asha K",
  link: "linked",
  restricted: false,
  employee: {
    id: 7,
    code: "1001",
    name: "Asha Kumar",
    status: "active",
    employmentType: "staff",
    department: "Stitching",
    designation: null,
    branch: null,
    photoUrl: null,
  },
  presence: [
    {
      deviceId: 1,
      uid: 1,
      name: "Asha K",
      privilege: 14,
      role: "Super admin",
      card: 555,
      hasPassword: false,
      group: "",
    },
    { deviceId: 2, uid: 4, name: "ASHA K", privilege: 0, role: "User", card: 0, hasPassword: true, group: "" },
  ],
  deviceCount: 2,
  differs: ["role"],
  ...over,
});

describe("device names", () => {
  it("shortens the names of the company's devices to fit a chip", () => {
    expect(shortDeviceName("HO - 1 PROD")).toBe("HO-1");
    expect(shortDeviceName("HO")).toBe("HO");
    expect(shortDeviceName("Unit1 - 2")).toBe("Unit1-2");
    expect(shortDeviceName("  HO   -  5  prod ")).toBe("HO-5");
  });
});

describe("how full a device is", () => {
  it("is calm under 80%, a warning from 80% and a problem from 95%", () => {
    expect(capacityLevel(1000, 150000)).toEqual({ percent: 1, tone: "good" });
    expect(capacityLevel(120000, 150000)).toEqual({ percent: 80, tone: "warn" });
    expect(capacityLevel(140796, 150000)).toEqual({ percent: 94, tone: "warn" });
    expect(capacityLevel(145000, 150000)).toEqual({ percent: 97, tone: "bad" });
    expect(capacityLevel(200000, 150000)?.percent).toBe(100);
  });

  it("says nothing when the device did not report a size", () => {
    expect(capacityLevel(undefined, 100)).toBeNull();
    expect(capacityLevel(5, 0)).toBeNull();
    expect(capacityLevel(5, undefined)).toBeNull();
  });

  it("writes numbers the Indian way", () => {
    expect(formatCount(140796)).toBe("1,40,796");
    expect(formatCount(null)).toBe("–");
  });
});

describe("what a device needs attention for", () => {
  it("has nothing to say about a healthy device", () => {
    expect(deviceAlerts(device())).toEqual([]);
  });

  it("warns when the log is nearly full, in plain words", () => {
    const alerts = deviceAlerts(
      device({ capacity: { users: 603, usersCap: 3000, faces: 603, records: 145000, recordsCap: 150000 } }),
    );
    expect(alerts[0]).toMatchObject({ key: "log-full", tone: "bad" });
    expect(alerts[0].text).toContain("97% full");
    expect(alerts[0].text).toContain("overwrite");
    expect(deviceAlerts(device({ capacity: { records: 125000, recordsCap: 150000 } }))[0]).toMatchObject({
      tone: "warn",
    });
  });

  it("warns about a clock that is out by more than five minutes, either way", () => {
    expect(deviceAlerts(device({ clockSkewSeconds: 299 }))).toEqual([]);
    expect(deviceAlerts(device({ clockSkewSeconds: 600 }))[0].text).toContain("10 min ahead of");
    expect(deviceAlerts(device({ clockSkewSeconds: -7200 }))[0].text).toContain("2.0 h behind");
  });

  it("notes users who have no face enrolled", () => {
    const alerts = deviceAlerts(device({ capacity: { users: 399, faces: 397 } }));
    expect(alerts[0]).toMatchObject({ key: "faces", tone: "muted" });
    expect(alerts[0].text).toContain("2 users have no face enrolled");
    expect(deviceAlerts(device({ capacity: { users: 10, faces: 9 } }))[0].text).toContain("1 user has no face");
  });

  it("shows why the users could not be read", () => {
    expect(deviceAlerts(device({ usersRead: { at: null, error: "timed out" } }))[0].text).toContain("timed out");
  });
});

describe("what to do about a device that cannot be reached", () => {
  const down = (code: DeviceControlDevice["connection"]["code"]) =>
    device({ connection: { state: "disconnected", code, reason: "x", latencyMs: null } });

  it("gives advice for each kind of failure", () => {
    expect(connectionAdvice(down("cloud"))).toContain("Site Connector");
    expect(connectionAdvice(down("timeout"))).toContain("cable");
    expect(connectionAdvice(down("refused"))).toContain("COMM. Port");
    expect(connectionAdvice(down("auth"))).toContain("Comm Key");
    expect(connectionAdvice(down("config"))).toContain("number");
    expect(connectionAdvice(down("protocol"))).toBe("");
  });

  it("treats a switched-on, connected device as usable and nothing else", () => {
    expect(isUsable(device())).toBe(true);
    expect(isUsable(down("timeout"))).toBe(false);
    expect(isUsable(device({ isActive: false }))).toBe(false);
  });
});

describe("roles", () => {
  it("names the roles the devices have", () => {
    expect([0, 2, 6, 14].map(roleLabel)).toEqual(["User", "Enroller", "Administrator", "Super admin"]);
    expect(roleLabel(9)).toBe("Role 9");
  });
});

describe("names that fit on a device", () => {
  it("counts bytes, not characters", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
  });

  it("cuts a name at 24 bytes without splitting a character", () => {
    expect(trimToBytes("Venkataramanan Subramaniapillai")).toBe("Venkataramanan Subramani");
    expect(trimToBytes("ééééééééééééé")).toBe("éééééééééééé");
    expect(trimToBytes("Asha")).toBe("Asha");
  });

  it("builds the device name for an employee", () => {
    expect(deviceNameFor("  Asha   Kumar ")).toBe("Asha Kumar");
    expect(byteLength(deviceNameFor("Venkataramanan Subramaniapillai Iyer"))).toBeLessThanOrEqual(24);
  });
});

describe("the user form", () => {
  const ok = { ...EMPTY_FORM, userId: "2001", name: "New Person" };

  it("accepts a sensible new user", () => {
    expect(validateForm(ok, { mode: "create" })).toEqual({});
  });

  it("asks for the user ID and the name", () => {
    const errors = validateForm(EMPTY_FORM, { mode: "create" });
    expect(Object.keys(errors).sort()).toEqual(["name", "userId"]);
  });

  it("holds the ID to what the device takes", () => {
    expect(validateForm({ ...ok, userId: "bad id!" }, { mode: "create" }).userId).toContain("Letters");
    expect(validateForm({ ...ok, userId: "1234567890" }, { mode: "create" }).userId).toContain("At most 9");
    expect(validateForm({ ...ok, userId: "12345" }, { mode: "create", pinWidth: 4 }).userId).toContain("At most 4");
  });

  it("holds the name, password, card and group to their limits", () => {
    expect(validateForm({ ...ok, name: "A".repeat(25) }, { mode: "create" }).name).toContain("24");
    expect(validateForm({ ...ok, password: "123456789" }, { mode: "create" }).password).toBeTruthy();
    expect(validateForm({ ...ok, password: "12ab" }, { mode: "create" }).password).toBeTruthy();
    expect(validateForm({ ...ok, card: "abc" }, { mode: "create" }).card).toBeTruthy();
    expect(validateForm({ ...ok, card: "4294967296" }, { mode: "create" }).card).toContain("too large");
    expect(validateForm({ ...ok, card: "4294967295" }, { mode: "create" }).card).toBeUndefined();
    expect(validateForm({ ...ok, group: "12345678" }, { mode: "create" }).group).toBeTruthy();
  });

  it("does not ask for the ID again when editing", () => {
    expect(validateForm({ ...EMPTY_FORM, name: "Asha" }, { mode: "edit" })).toEqual({});
  });

  it("sends a new user with only the fields that have a value", () => {
    expect(newUserInput(ok)).toEqual({ userId: "2001", name: "New Person", privilege: 0 });
    expect(newUserInput({ ...ok, password: "12", card: "99", group: "G1", privilege: 14 }, 7)).toEqual({
      userId: "2001",
      name: "New Person",
      privilege: 14,
      password: "12",
      card: 99,
      group: "G1",
      employeeId: 7,
    });
  });
});

describe("editing", () => {
  const initial = { userId: "1001", name: "Asha K", privilege: 14, password: "", card: "555", group: "" };

  it("sends nothing when nothing changed", () => {
    expect(changedFields(initial, { ...initial })).toBeNull();
    expect(changedFields(initial, { ...initial, name: "  Asha K " })).toBeNull();
  });

  it("sends only what changed, so another device's other fields are never overwritten", () => {
    expect(changedFields(initial, { ...initial, name: "Asha Kumar" })).toEqual({ userId: "1001", name: "Asha Kumar" });
    expect(changedFields(initial, { ...initial, privilege: 0 })).toEqual({ userId: "1001", privilege: 0 });
  });

  it("can clear a card and set a password", () => {
    expect(changedFields(initial, { ...initial, card: "" })).toEqual({ userId: "1001", card: "" });
    expect(changedFields(initial, { ...initial, password: "4455" })).toEqual({ userId: "1001", password: "4455" });
  });

  it("starts the form from what a device holds", () => {
    expect(formFromPerson(person())).toEqual({
      userId: "1001",
      name: "Asha K",
      privilege: 14,
      password: "",
      card: "555",
      group: "",
    });
    expect(formFromPerson(person(), 2)).toMatchObject({ name: "ASHA K", privilege: 0, card: "" });
    const hrmsOnly = person({ presence: [], deviceCount: 0, link: "hrms_only" });
    expect(formFromPerson(hrmsOnly)).toMatchObject({ userId: "1001", name: "Asha K", privilege: 0 });
  });
});

describe("putting a person on another device", () => {
  it("copies what the devices already hold", () => {
    expect(copyInput(person())).toEqual({ userId: "1001", name: "Asha K", privilege: 14, card: 555, employeeId: 7 });
  });

  it("uses the HRMS name, cut to fit, for someone on no device", () => {
    const input = copyInput(
      person({
        presence: [],
        deviceCount: 0,
        link: "hrms_only",
        name: "Venkataramanan Subramaniapillai",
        employee: { ...person().employee!, name: "Venkataramanan Subramaniapillai" },
      }),
    );
    expect(input).toEqual({ userId: "1001", name: "Venkataramanan Subramani", employeeId: 7 });
  });

  it("never copies a password", () => {
    expect(Object.keys(copyInput(person()))).not.toContain("password");
  });
});

describe("what a row says", () => {
  it("describes what differs between devices in words", () => {
    expect(describeDiffers([])).toBe("");
    expect(describeDiffers(["role"])).toBe("different roles");
    expect(describeDiffers(["name", "role"])).toBe("different names and roles");
    expect(describeDiffers(["name", "role", "card"])).toBe("different names, roles and cards");
  });

  it("makes initials from a name", () => {
    expect(initials("Asha Kumar")).toBe("AK");
    expect(initials("joshy")).toBe("J");
    expect(initials("  ")).toBe("?");
    expect(initials("A B C")).toBe("AC");
  });
});

describe("filters", () => {
  it("start empty and know when they are not", () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, search: "asha" })).toBe(true);
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...NO_FILTERS, search: "a", devices: [1, 2], link: "device_only", differs: true })).toBe(
      4,
    );
  });

  it("become a request that only names what is filtered", () => {
    expect(peopleQuery(toParams(NO_FILTERS, 1, "name", "asc"))).toBe("");
    const f = {
      ...NO_FILTERS,
      devices: [1, 6],
      deviceMode: "none" as const,
      link: "hrms_only" as const,
      search: " asha ",
    };
    expect(peopleQuery(toParams(f, 2, "code", "desc"))).toBe(
      "?search=asha&devices=1%2C6&deviceMode=none&link=hrms_only&sort=code&dir=desc&page=2",
    );
  });

  it("round-trip through the address bar", () => {
    const f = {
      ...NO_FILTERS,
      search: "asha",
      devices: [6],
      deviceMode: "all" as const,
      link: "linked" as const,
      count: "multiple" as const,
      role: "admin" as const,
      employmentType: "staff" as const,
      departmentId: 3,
      differs: true,
    };
    expect(filtersFromSearch(filtersToSearch(f))).toEqual(f);
    expect(filtersToSearch(NO_FILTERS)).toBe("");
  });

  it("read an old-style single device link and ignore anything unknown", () => {
    expect(filtersFromSearch("?device=6").devices).toEqual([6]);
    expect(filtersFromSearch("?devices=6,6,x,-1,7").devices).toEqual([6, 7]);
    const junk = filtersFromSearch("?link=drop&count=x&role=root&deviceMode=y&employmentType=z&departmentId=abc");
    expect(junk).toEqual(NO_FILTERS);
    expect(filtersFromSearch("?search=" + "a".repeat(200)).search).toHaveLength(80);
  });

  it("say what the device filter means", () => {
    const devices = [
      { id: 1, name: "HO" },
      { id: 6, name: "HO - 1 PROD" },
    ];
    expect(describeDeviceFilter(NO_FILTERS, devices)).toBe("");
    expect(describeDeviceFilter({ ...NO_FILTERS, devices: [1] }, devices)).toBe("On HO");
    expect(describeDeviceFilter({ ...NO_FILTERS, devices: [1, 6] }, devices)).toBe("On any of HO, HO - 1 PROD");
    expect(describeDeviceFilter({ ...NO_FILTERS, devices: [1, 6], deviceMode: "all" }, devices)).toBe(
      "On all of HO, HO - 1 PROD",
    );
    expect(describeDeviceFilter({ ...NO_FILTERS, devices: [6], deviceMode: "none" }, devices)).toBe(
      "Not on HO - 1 PROD",
    );
    expect(describeDeviceFilter({ ...NO_FILTERS, devices: [99] }, devices)).toBe("On #99");
  });
});

const entry = (over: Partial<PushResult["results"][number]> = {}): PushResult["results"][number] => ({
  deviceId: 1,
  deviceName: "HO",
  ok: true,
  added: [],
  updated: [],
  deleted: [],
  skipped: [],
  failed: [],
  ...over,
});

describe("telling the person what happened after a change", () => {
  it("is plain good news when everything went through", () => {
    const r: PushResult = {
      mode: "create",
      rejected: [],
      results: [entry({ added: ["1", "2"] })],
      summary: { added: 2, updated: 0, failed: 0 },
    };
    expect(summarizePush(r)).toEqual({ title: "Added 2 entries on the devices", tone: "good", lines: [] });
    const one: PushResult = { ...r, mode: "update", summary: { added: 0, updated: 1, failed: 0 } };
    expect(summarizePush(one).title).toBe("Changed 1 entry on the devices");
  });

  it("names every device and user that did not go through", () => {
    const r: PushResult = {
      mode: "create",
      rejected: [{ userId: "bad id", error: "The user ID must be 1 to 24 letters." }],
      results: [
        entry({ added: ["1"], skipped: [{ userId: "2", reason: "Already on this device." }] }),
        entry({ deviceId: 2, deviceName: "HO-2", ok: false, error: "did not answer", code: "timeout" }),
        entry({
          deviceId: 3,
          deviceName: "HO-3",
          failed: [{ userId: "3", error: "The device is full (3000 users)." }],
        }),
      ],
      summary: { added: 1, updated: 0, failed: 3 },
    };
    const out = summarizePush(r);
    expect(out.tone).toBe("warn");
    expect(out.title).toBe("Added 1, but 3 did not go through");
    expect(out.lines).toEqual([
      "1 left alone (already there, or not on that device).",
      "HO-2: did not answer",
      "HO-3, 3: The device is full (3000 users).",
      "bad id: The user ID must be 1 to 24 letters.",
    ]);
  });

  it("is a problem when nothing went through", () => {
    const r: PushResult = {
      mode: "create",
      rejected: [],
      results: [entry({ ok: false, error: "x" })],
      summary: { added: 0, updated: 0, failed: 1 },
    };
    expect(summarizePush(r)).toMatchObject({ title: "Nothing was added", tone: "bad" });
  });

  it("reports a delete, and what happened to the employee", () => {
    const r: DeleteResult = {
      results: [
        entry({ deleted: ["1001"] }),
        entry({
          deviceId: 2,
          deviceName: "HO-2",
          failed: [{ userId: "1001", error: "The device still has this user." }],
        }),
      ],
      inactive: [{ userId: "1001", employeeId: 7, name: "Asha Kumar", changed: true, reason: "" }],
      rejected: [],
      summary: { deleted: 1, failed: 1, madeInactive: 1 },
    };
    const out = summarizeDelete(r);
    expect(out.tone).toBe("warn");
    expect(out.title).toBe("Deleted 1, but 1 did not go through. 1 made Inactive in the HRMS.");
    expect(out.lines).toEqual(["HO-2, 1001: The device still has this user."]);
  });

  it("explains an employee left as they were", () => {
    const r: DeleteResult = {
      results: [entry({ deleted: ["1001"] })],
      inactive: [
        {
          userId: "1001",
          employeeId: 7,
          name: "Asha Kumar",
          changed: false,
          reason: "Your role cannot edit employees, so the employee was left as it is.",
        },
      ],
      rejected: [],
      summary: { deleted: 1, failed: 0, madeInactive: 0 },
    };
    const out = summarizeDelete(r);
    expect(out.title).toBe("Deleted 1 from the devices.");
    expect(out.lines[0]).toContain("Asha Kumar: Your role cannot edit employees");
  });

  it("says when there was nothing to delete", () => {
    const r: DeleteResult = {
      results: [],
      inactive: [],
      rejected: [],
      summary: { deleted: 0, failed: 0, madeInactive: 0 },
    };
    expect(summarizeDelete(r)).toMatchObject({ title: "There was nothing to delete", tone: "muted" });
  });
});

describe("what deleting would do, before it is done", () => {
  const other = person({
    userId: "9001",
    key: "9001",
    employee: null,
    link: "device_only",
    presence: [{ deviceId: 1, uid: 3, name: "x", privilege: 0, role: "User", card: 0, hasPassword: false, group: "" }],
    deviceCount: 1,
    differs: [],
  });

  it("counts the removals, the devices, the employees and the administrators", () => {
    const impact = deleteImpact([person(), other], null);
    expect(impact.removals).toBe(3);
    expect(impact.devices.sort()).toEqual([1, 2]);
    expect(impact.employees.map((p) => p.userId)).toEqual(["1001"]);
    expect(impact.admins.map((a) => [a.person.userId, a.role])).toEqual([["1001", "Super admin"]]);
    expect(impact.stayingElsewhere).toEqual([]);
  });

  it("notes who stays on a device that is not chosen", () => {
    const impact = deleteImpact([person()], [2]);
    expect(impact.removals).toBe(1);
    expect(impact.devices).toEqual([2]);
    expect(impact.stayingElsewhere.map((p) => p.userId)).toEqual(["1001"]);
    expect(impact.admins).toEqual([]);
  });

  it("does not count an Inactive or another branch's employee as one to change", () => {
    const inactive = person({ employee: { ...person().employee!, status: "inactive" }, link: "inactive_on_device" });
    expect(deleteImpact([inactive], null).employees).toEqual([]);
    expect(deleteImpact([person({ restricted: true })], null).employees).toEqual([]);
  });
});

describe("Data Fetch", () => {
  it("accepts the presets and checks a custom range", () => {
    expect(rangeProblem({ preset: "today" })).toBe("");
    expect(rangeProblem({ preset: "custom" })).toContain("Choose");
    expect(rangeProblem({ preset: "custom", from: "2026-10-05", to: "2026-10-01" })).toContain("after");
    expect(rangeProblem({ preset: "custom", from: "2026-10-01", to: "2026-10-05" })).toBe("");
  });

  const run = (over: Partial<FetchRun> = {}): FetchRun => ({
    id: 1,
    mode: "update",
    status: "running",
    startedBy: "Admin",
    rangeLabel: "Last 7 days",
    dateFrom: null,
    dateTo: null,
    deviceIds: [1, 2],
    results: [
      { deviceId: 1, deviceName: "HO", status: "done" },
      { deviceId: 2, deviceName: "HO-1", status: "reading" },
    ],
    summary: null,
    error: "",
    createdAt: "2026-10-06T10:00:00Z",
    finishedAt: null,
    elapsedSeconds: 5,
    ...over,
  });

  it("shows how far a run has got", () => {
    expect(fetchProgress(run())).toEqual({ done: 1, total: 2, percent: 50, label: "Reading the devices" });
    const writing = run({
      results: [
        { deviceId: 1, deviceName: "HO", status: "processing" },
        { deviceId: 2, deviceName: "x", status: "done" },
      ],
    });
    expect(fetchProgress(writing).label).toBe("Writing to the HRMS");
    expect(fetchProgress(run({ status: "done" }))).toMatchObject({ percent: 100, label: "Finished" });
    expect(fetchProgress(run({ status: "failed", results: [] }))).toMatchObject({ percent: 100, label: "Failed" });
  });

  it("formats how long something took", () => {
    expect(formatDuration(null)).toBe("–");
    expect(formatDuration(11004)).toBe("11 s");
    expect(formatDuration(65000)).toBe("1m 05s");
  });

  const summary = (over: Partial<NonNullable<FetchRun["summary"]>> = {}): NonNullable<FetchRun["summary"]> => ({
    devices: 2,
    devicesDone: 2,
    devicesFailed: 0,
    onDevice: 100,
    inRange: 50,
    alreadyInHrms: 40,
    new: 10,
    created: 10,
    unmatchedPunches: 0,
    unmatched: [],
    suspiciousDays: [],
    ...over,
  });

  it("says in one line what a finished run did", () => {
    expect(describeRun(run({ status: "done", mode: "preview", summary: summary() }))).toBe(
      "10 new punches for last 7 days: an update would add them.",
    );
    expect(describeRun(run({ status: "done", mode: "preview", summary: summary({ new: 0 }) }))).toContain(
      "already has every punch",
    );
    expect(describeRun(run({ status: "done", summary: summary({ created: 1 }) }))).toBe(
      "Added 1 punch for last 7 days.",
    );
    expect(describeRun(run({ status: "done", summary: summary({ created: 0 }) }))).toContain("Nothing to add");
    expect(describeRun(run({ status: "failed", error: "No device could be read." }))).toBe("No device could be read.");
    expect(describeRun(run())).toBe("Running…");
  });
});

describe("review fixes", () => {
  const dev = (deviceId: number, over: Partial<PersonRow["presence"][number]> = {}) => ({
    deviceId,
    uid: deviceId,
    name: "x",
    privilege: 0,
    role: "User",
    card: 0,
    hasPassword: false,
    group: "",
    ...over,
  });
  const employee = (over: Partial<NonNullable<PersonRow["employee"]>> = {}) => ({
    id: 7,
    code: "1001",
    name: "Asha Kumar",
    status: "active",
    employmentType: "staff",
    department: null,
    designation: null,
    branch: null,
    photoUrl: null,
    ...over,
  });

  it("does not say an employee will become Inactive when no device that can be reached will remove them", () => {
    const onlyDown = person({ presence: [dev(2)], deviceCount: 1, differs: [] });
    const onBoth = person({ presence: [dev(1), dev(2)], deviceCount: 2, differs: [] });
    // device 2 cannot be reached: the person who is only there is not one this delete will change in the HRMS
    expect(deleteImpact([onlyDown], null, [1]).employees).toEqual([]);
    expect(deleteImpact([onBoth], null, [1]).employees).toHaveLength(1);
    // and one whose only device was unticked is not either
    expect(deleteImpact([onlyDown], [1]).employees).toEqual([]);
    // with no reachability given every device counts, as before
    expect(deleteImpact([onlyDown], null).employees).toHaveLength(1);
    void employee;
  });

  it("does not claim the HRMS has everything when some devices could not be read", () => {
    const base = {
      id: 1,
      mode: "preview" as const,
      status: "done" as const,
      startedBy: "A",
      rangeLabel: "Last 7 days",
      dateFrom: null,
      dateTo: null,
      deviceIds: [1, 2, 3],
      results: [],
      error: "",
      createdAt: "2026-10-06T10:00:00Z",
      finishedAt: null,
      elapsedSeconds: 1,
    };
    const summary = (over: Partial<NonNullable<FetchRun["summary"]>>): NonNullable<FetchRun["summary"]> => ({
      devices: 3,
      devicesDone: 1,
      devicesFailed: 2,
      onDevice: 10,
      inRange: 5,
      alreadyInHrms: 5,
      new: 0,
      created: 0,
      unmatchedPunches: 0,
      unmatched: [],
      suspiciousDays: [],
      ...over,
    });
    const nothing = describeRun({ ...base, summary: summary({}) });
    expect(nothing).not.toContain("already has every punch");
    expect(nothing).toContain("2 of 3 devices could not be read");
    expect(describeRun({ ...base, summary: summary({ new: 4 }) })).toContain("2 of 3 devices could not be read");
    expect(describeRun({ ...base, mode: "update", summary: summary({}) })).toContain(
      "from the devices that could be read",
    );
    expect(describeRun({ ...base, mode: "update", summary: summary({ created: 3 }) })).toBe(
      "Added 3 punches for last 7 days. 2 of 3 devices could not be read.",
    );
    expect(describeRun({ ...base, summary: summary({ devicesFailed: 1, devices: 1 }) })).toContain(
      "1 of 1 device could not be read",
    );
  });

  it("starts the form from a name that fits on the device", () => {
    const long = person({
      presence: [],
      deviceCount: 0,
      link: "hrms_only",
      name: "Venkatasubramanian Ramachandran",
      employee: employee({ name: "Venkatasubramanian Ramachandran" }),
    });
    const form = formFromPerson(long);
    expect(byteLength(form.name)).toBeLessThanOrEqual(24);
    expect(form.name).toBe("Venkatasubramanian Ramac");
    expect(validateForm(form, { mode: "edit" })).toEqual({});
  });

  it("is not good news when nothing was added because everyone was already there", () => {
    const r: PushResult = {
      mode: "create",
      rejected: [],
      results: [entry({ skipped: [{ userId: "1", reason: "Already on this device." }] })],
      summary: { added: 0, updated: 0, failed: 0 },
    };
    expect(summarizePush(r)).toMatchObject({ title: "Nothing was added", tone: "muted" });
  });

  it("does not count the device mode on its own as a filter", () => {
    expect(filtersActive({ ...NO_FILTERS, deviceMode: "none" })).toBe(false);
    expect(activeFilterCount({ ...NO_FILTERS, deviceMode: "none" })).toBe(0);
    expect(filtersActive({ ...NO_FILTERS, devices: [1], deviceMode: "none" })).toBe(true);
  });

  it("knows which devices the server will not reach, and does not guess about unchecked ones", () => {
    const state = (s: DeviceControlDevice["connection"]["state"], isActive = true) =>
      device({ isActive, connection: { state: s, code: "ok", reason: "", latencyMs: null } });
    expect(isUnreachable(state("connected"))).toBe(false);
    expect(isUnreachable(state("unknown"))).toBe(false);
    expect(isUnreachable(state("disconnected"))).toBe(true);
    expect(isUnreachable(state("disabled"))).toBe(true);
    expect(isUnreachable(state("connected", false))).toBe(true);
  });

  it("takes the user ID limit from the devices the user is going onto", () => {
    const short = device({
      id: 1,
      capacity: { users: 1, usersCap: 3000, records: 1, recordsCap: 1, faces: 0, pinWidth: 5 },
    });
    const wide = device({ id: 2, capacity: { users: 1, usersCap: 3000, records: 1, recordsCap: 1, faces: 0 } });
    expect(pinWidthFor([wide])).toBe(9);
    expect(pinWidthFor([short, wide])).toBe(5);
    expect(pinWidthFor([])).toBe(9);
    expect(
      validateForm({ ...EMPTY_FORM, userId: "123456", name: "A" }, { mode: "create", pinWidth: pinWidthFor([wide]) }),
    ).toEqual({});
    expect(
      validateForm({ ...EMPTY_FORM, userId: "123456", name: "A" }, { mode: "create", pinWidth: pinWidthFor([short]) })
        .userId,
    ).toMatch(/At most 5/);
  });

  it("writes today's date the way this computer's calendar shows it, not in UTC", () => {
    // 00:30 on 7 October in India is still 6 October in UTC
    expect(localDate(new Date(2026, 9, 7, 0, 30))).toBe("2026-10-07");
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("shows the details of the device that was clicked in the form", () => {
    const two = person({
      presence: [
        { ...dev(1, { name: "Asha K", privilege: 0 }) },
        { ...dev(2, { name: "Asha Kumar", privilege: 14, card: 77 }) },
      ],
      deviceCount: 2,
    });
    expect(formFromPerson(two).name).toBe("Asha K");
    expect(formFromPerson(two, 2)).toMatchObject({ name: "Asha Kumar", privilege: 14, card: "77" });
    expect(formFromPerson(two, 99).name).toBe("Asha K"); // a device the person is not on falls back to the first
  });

  it("does not make someone Inactive who is only on a device that is down", () => {
    const active = person({
      presence: [dev(1), dev(2)],
      deviceCount: 2,
      employee: employee({ status: "active" }),
    });
    expect(deleteImpact([active], null, [1]).employees).toHaveLength(1);
    expect(deleteImpact([active], [2], [1]).employees).toHaveLength(0);
    expect(deleteImpact([active], [2], null).employees).toHaveLength(1);
  });
});

describe("site connectors", () => {
  const operation = (over: Partial<DeviceOperation> = {}): DeviceOperation => ({
    id: 7,
    kind: "apply",
    status: "running",
    pending: [],
    final: null,
    error: "",
    createdAt: "2026-10-09T10:00:00Z",
    finishedAt: null,
    ...over,
  });
  const quick = { sleep: async () => undefined, intervalMs: 1 };

  it("recognises an answer that is an operation to follow, and nothing else", () => {
    expect(isStarted({ operation: operation() })).toBe(true);
    expect(isStarted({ results: [] })).toBe(false);
    expect(isStarted(null)).toBe(false);
    expect(isStarted("text")).toBe(false);
  });

  it("returns an ordinary answer as it is, without asking anything", async () => {
    const load = vi.fn();
    const body = { results: [{ deviceId: 1 }], summary: {} };
    expect(await followOperation(body, { ...quick, load })).toBe(body);
    expect(load).not.toHaveBeenCalled();
  });

  it("follows an operation until the connector has reported, then returns its final answer", async () => {
    const answers = [
      operation(),
      operation({ pending: [{ deviceId: 1, deviceName: "A", connector: "S", state: "working" }] }),
      operation({ status: "done", final: { summary: { added: 2 } } }),
    ];
    const load = vi.fn(async () => answers.shift()!);
    const seen: string[] = [];
    const result = await followOperation(
      { operation: operation() },
      { ...quick, load, onUpdate: (o) => seen.push(o.status) },
    );
    expect(result).toEqual({ summary: { added: 2 } });
    expect(load).toHaveBeenCalledTimes(3);
    expect(load).toHaveBeenCalledWith(7);
    expect(seen).toEqual(["running", "running", "running", "done"]); // the one it started with, then each look
  });

  it("an operation that failed is an error with the server's words", async () => {
    const load = async () => operation({ status: "failed", error: "The operation could not be finished: boom" });
    await expect(followOperation({ operation: operation() }, { ...quick, load })).rejects.toThrow(
      "could not be finished: boom",
    );
  });

  it("an operation that is done but has no answer is an error, not a silent nothing", async () => {
    const load = async () => operation({ status: "done", final: null });
    await expect(followOperation({ operation: operation() }, { ...quick, load })).rejects.toThrow("did not finish");
  });

  it("a look that fails now and then (a dropped connection, a deploy) is tried again and the operation is still followed", async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls <= 5) throw new Error("network");
      return operation({ status: "done", final: { ok: true } });
    };
    expect(await followOperation({ operation: operation() }, { ...quick, load: flaky })).toEqual({ ok: true });
    expect(calls).toBe(6);
  });

  it("after losing contact for too long it says the change may still go through, not that it failed", async () => {
    const down = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(
      followOperation({ operation: operation() }, { ...quick, load: down, networkGiveUpMs: 0 }),
    ).rejects.toThrow(LOST_CONTACT_MESSAGE);
    expect(LOST_CONTACT_MESSAGE).toMatch(/may still go through/);
    expect(down).toHaveBeenCalledTimes(1);
  });

  it("a look the server refuses (signed out, the operation gone) is not retried", async () => {
    for (const status of [401, 403, 404]) {
      const refused = vi.fn(async () => {
        throw Object.assign(new Error("refused"), { status });
      });
      await expect(followOperation({ operation: operation() }, { ...quick, load: refused })).rejects.toThrow("refused");
      expect(refused).toHaveBeenCalledTimes(1);
    }
  });

  it("a run of failures that ends resets the count", async () => {
    const answers: Array<"fail" | DeviceOperation> = [
      "fail",
      "fail",
      operation(),
      "fail",
      "fail",
      operation({ status: "done", final: { ok: 1 } }),
    ];
    const load = vi.fn(async () => {
      const next = answers.shift()!;
      if (next === "fail") throw new Error("blip");
      return next;
    });
    expect(await followOperation({ operation: operation() }, { ...quick, load, networkGiveUpMs: 60_000 })).toEqual({
      ok: 1,
    });
  });

  it("waits longer than the server's own longest job, so the server's specific answer is what a person gets", () => {
    // writes: 7 minutes to be taken + 3 minutes grace once taken = 10 minutes at the most
    expect(FOLLOW_TIMEOUT_MS).toBeGreaterThan(10 * 60_000);
  });

  it("says what is being waited for", () => {
    expect(describeOperationWait(operation({ status: "done" }))).toBe("");
    expect(describeOperationWait(operation({ pending: [] }))).toBe("Finishing…");
    expect(
      describeOperationWait(
        operation({ pending: [{ deviceId: 1, deviceName: "HO-1", connector: "Unit 2", state: "waiting" }] }),
      ),
    ).toBe("Waiting for the site connector “Unit 2” to pick this up (HO-1)…");
    expect(
      describeOperationWait(
        operation({
          pending: [
            { deviceId: 1, deviceName: "HO-1", connector: "Unit 2", state: "working" },
            { deviceId: 2, deviceName: "HO-2", connector: "Unit 2", state: "waiting" },
          ],
        }),
      ),
    ).toBe("The site connector “Unit 2” is working on HO-1, HO-2…");
  });

  it("stops waiting after the time allowed and says to read the devices again", async () => {
    const load = async () => operation();
    await expect(
      followOperation(
        { operation: operation() },
        { ...quick, load, timeoutMs: 5, sleep: () => new Promise((r) => setTimeout(r, 4)) },
      ),
    ).rejects.toThrow("Read the devices again");
  });

  it("tells a person what to do about each reason a connector's device cannot be used", () => {
    const behind = (
      code: DeviceControlDevice["connection"]["code"],
      via: DeviceControlDevice["via"] = { id: 1, name: "Unit 2", online: true },
    ) => device({ via, connection: { state: "disconnected", code, reason: "", latencyMs: null } });
    expect(connectionAdvice(behind("connector_offline"))).toMatch(/computer running the Site Connector is on/);
    expect(connectionAdvice(behind("connector_off"))).toMatch(/Switch the Site Connector on/);
    expect(connectionAdvice(behind("pending"))).toMatch(/Check connections/);
    expect(connectionAdvice(behind("timeout"))).toMatch(/as the connector's computer sees it/);
    expect(connectionAdvice(behind("timeout", null))).not.toMatch(/connector/);
    expect(connectionAdvice(behind("cloud", null))).toMatch(/Install a Site Connector/);
  });

  it("finds the connectors tab from the address", () => {
    expect(tabFromPath("/hr/Biometric-Connectors/DeviceControl/connectors")).toBe("connectors");
    expect(tabFromPath("/hr/Biometric-Connectors/DeviceControl/push")).toBe("push");
    expect(tabFromPath("/hr/Biometric-Connectors/DeviceControl")).toBe("overview");
  });

  it("labels every state of a connector", () => {
    expect(CONNECTOR_STATE_LABEL).toEqual({
      online: "Online",
      offline: "Offline",
      unpaired: "Waiting to be paired",
      off: "Switched off",
    });
    expect(CONNECTOR_STATE_TONE.online).toBe("good");
    expect(CONNECTOR_STATE_TONE.offline).toBe("bad");
  });

  it("describes the last time a connector read a device's punches, and when", () => {
    const now = new Date().toISOString();
    expect(describeConnectorSync(null)).toMatch(/not read by the connector yet/);
    expect(describeConnectorSync({})).toMatch(/not read by the connector yet/);
    expect(describeConnectorSync({ at: now, ok: false, error: "The device stopped answering." })).toBe(
      "Could not read punches: The device stopped answering.",
    );
    expect(describeConnectorSync({ at: now, ok: true, skipped: true })).toMatch(
      /nothing new on the device \(just now\)/,
    );
    expect(describeConnectorSync({ at: now, ok: true, read: 1500, created: 12 })).toBe(
      "Punches: 1,500 read, 12 new in the HRMS (just now).",
    );
    const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    expect(describeConnectorSync({ at: old, ok: true, read: 5, created: 0 })).toMatch(/\(3 h ago\)|\(3 hours ago\)/);
  });

  it("writes how long a connector has been running", () => {
    expect(formatUptime(30)).toBe("30 s");
    expect(formatUptime(600)).toBe("10 min");
    expect(formatUptime(3 * 3600 + 125)).toBe("3 h 2 min");
    expect(formatUptime(5 * 86400)).toBe("5 days");
  });

  it("checks the connector settings form", () => {
    const ok = { name: "Unit 2", minutes: "15", days: "2" };
    expect(validateConnectorSettings(ok)).toBe("");
    expect(validateConnectorSettings({ ...ok, minutes: "0" })).toBe("");
    expect(validateConnectorSettings({ ...ok, name: "  " })).toMatch(/name/);
    expect(validateConnectorSettings({ ...ok, name: "x".repeat(81) })).toMatch(/at most 80/);
    expect(validateConnectorSettings({ ...ok, minutes: "-1" })).toMatch(/every 0/);
    expect(validateConnectorSettings({ ...ok, minutes: "1441" })).toMatch(/every 0/);
    expect(validateConnectorSettings({ ...ok, minutes: "ab" })).toMatch(/every 0/);
    expect(validateConnectorSettings({ ...ok, days: "0" })).toMatch(/1 to 31/);
    expect(validateConnectorSettings({ ...ok, days: "32" })).toMatch(/1 to 31/);
  });
});
