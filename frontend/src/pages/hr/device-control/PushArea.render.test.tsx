import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DeviceControlDevice,
  DeviceControlOverview,
  PeopleParams,
  PersonRow,
  PushResult,
} from "@/lib/api-client/custom-hooks";
import PushArea from "./PushArea";

// Data Push's five sub-tabs (owner 2026-11-17) against stand-in hooks: what each one asks the server for, and what it
// sends when a change is made (the devices, the people and why, for the history).

const h = vi.hoisted(() => ({
  peopleCalls: [] as unknown[],
  push: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  people: [] as unknown[],
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ token: "t", user: { role: "hr", isSuperAdmin: true, permissions: {} } }),
  permissionLevel: () => "edit",
}));
vi.mock("./PushTab", async () => {
  const { createElement } = await import("react");
  return { default: () => createElement("div", { "data-testid": "stub-overview" }, "the Data Push page") };
});
vi.mock("@/lib/api-client/custom-hooks", () => {
  const onAny = (p: { presence: { deviceId: number }[] }, ids: number[]) =>
    p.presence.some((x) => ids.includes(x.deviceId));
  const missing = (p: { presence: { deviceId: number }[] }, ids: number[]) =>
    ids.some((id) => !p.presence.some((x) => x.deviceId === id));
  const mutation = (fn: (b: unknown) => unknown) => ({ mutateAsync: fn, isPending: false, waiting: "" });
  return {
    useDevicePeople: (params: PeopleParams, enabled = true) => {
      h.peopleCalls.push({ ...params, enabled });
      const ids = params.devices ?? [];
      const items = (h.people as (PersonRow & { presence: { deviceId: number }[] })[]).filter((p) => {
        if (params.link === "active" && !(p.employee && p.employee.status === "active")) return false;
        if (params.deviceMode === "missing") return missing(p, ids);
        if (ids.length && (params.deviceMode ?? "any") === "any") return onAny(p, ids);
        return true;
      });
      return {
        data: {
          total: items.length,
          page: 1,
          pages: 1,
          pageSize: 25,
          items,
          facets: {
            total: 3,
            onDevices: 2,
            linked: 2,
            deviceOnly: 0,
            hrmsOnly: 1,
            inactiveOnDevice: 0,
            restricted: 0,
            multipleDevices: 1,
            singleDevice: 1,
            admins: 0,
            differs: 1,
            perDevice: { "1": 2, "2": 1, "3": 0 },
          },
        },
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      };
    },
    useUserHistory: () => ({
      data: {
        total: 1,
        page: 1,
        pageSize: 25,
        rows: [
          {
            id: 9,
            kind: "create",
            context: "add",
            status: "partial",
            userIds: ["4001"],
            userNames: { "4001": "Nila New" },
            deviceNames: ["Gate A", "Gate B"],
            results: [
              { deviceName: "Gate A", ok: true, added: 1, updated: 0, deleted: 0, absent: 0, skipped: 0, failed: 0 },
              {
                deviceName: "Gate B",
                ok: false,
                error: "Timed out",
                added: 0,
                updated: 0,
                deleted: 0,
                absent: 0,
                skipped: 0,
                failed: 0,
              },
            ],
            rejected: 0,
            viaConnector: true,
            requestedBy: "Admin",
            at: "2026-11-17T09:30:00Z",
          },
        ],
      },
      isLoading: false,
    }),
    usePushDeviceUsers: () => mutation(h.push),
    useUpdateDeviceUsers: () => mutation(h.update),
    useDeleteDeviceUsers: () => mutation(h.remove),
    useRefreshDeviceUsers: () => mutation(vi.fn()),
    useSaveEmployeePhoto: () => mutation(vi.fn()),
    fetchAuthedImageObjectUrl: vi.fn(),
  };
});

const device = (id: number, name: string, over: Partial<DeviceControlDevice> = {}): DeviceControlDevice => ({
  id,
  name,
  host: `192.168.0.${id}`,
  port: 4370,
  serialNumber: null,
  deviceType: "zk",
  isActive: true,
  privateAddress: true,
  via: null,
  connection: { state: "connected", code: "ok", reason: "", latencyMs: 5 },
  push: { state: "live", lastContactAt: null },
  capacity: { users: 10, usersCap: 3000, pinWidth: 9 },
  deviceTime: null,
  clockSkewSeconds: null,
  usersRead: { at: "2026-11-17T08:00:00Z", error: "" },
  ...over,
});

const DEVICES = [
  device(1, "Gate A"),
  device(2, "Gate B", { via: { id: 5, name: "Unit 2 PC", online: true } }),
  device(3, "Gate C", { connection: { state: "disconnected", code: "timeout", reason: "", latencyMs: null } }),
];

const at = (deviceId: number, name: string, privilege = 0, card = 0) => ({
  deviceId,
  uid: deviceId,
  name,
  privilege,
  role: privilege ? "Super admin" : "User",
  card,
  hasPassword: false,
  group: "",
});
const emp = (id: number, code: string, name: string, employmentType: string) => ({
  id,
  code,
  name,
  status: "active",
  employmentType,
  department: "Stitching",
  designation: null,
  branch: null,
  photoUrl: null,
});
const PEOPLE: PersonRow[] = [
  {
    key: "2001",
    userId: "2001",
    name: "SARA",
    link: "linked",
    restricted: false,
    employee: emp(11, "2001", "Sara Staff", "staff"),
    presence: [at(1, "SARA")],
    deviceCount: 1,
    differs: [],
  },
  {
    key: "3001",
    userId: "3001",
    name: "KAVI",
    link: "linked",
    restricted: false,
    employee: emp(12, "3001", "Kavi Worker", "production"),
    presence: [at(1, "KAVI"), at(2, "KAVI W")],
    deviceCount: 2,
    differs: ["name"],
  },
  {
    key: "4001",
    userId: "4001",
    name: "Nila New",
    link: "hrms_only",
    restricted: false,
    employee: emp(13, "4001", "Nila New", "staff"),
    presence: [],
    deviceCount: 0,
    differs: [],
  },
];

const entry = (deviceId: number, over: Partial<PushResult["results"][number]> = {}) => ({
  deviceId,
  deviceName: DEVICES.find((d) => d.id === deviceId)!.name,
  ok: true,
  added: [] as string[],
  updated: [] as string[],
  deleted: [] as string[],
  skipped: [] as { userId: string; reason: string }[],
  failed: [] as { userId: string; error: string }[],
  ...over,
});

const OVERVIEW = { devices: DEVICES } as unknown as DeviceControlOverview;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => {
  const el = q(id);
  if (!el) throw new Error(`no ${id}`);
  act(() => el.click());
};
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const lastPeople = () => h.peopleCalls[h.peopleCalls.length - 1] as PeopleParams & { enabled: boolean };

let root: Root | null = null;
let host: HTMLElement | null = null;

async function open(url = "/hr/Biometric-Connectors/DeviceControl/push") {
  window.history.replaceState(null, "", url);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(PushArea, { overview: OVERVIEW, loading: false })));
  await settle();
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  h.peopleCalls = [];
  h.people = PEOPLE;
  h.push.mockReset();
  h.update.mockReset();
  h.remove.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
});

describe("Data Push sub-tabs", () => {
  it("keeps the Data Push page as Overview and opens a sub-tab from the address", async () => {
    await open();
    const tabs = [...document.body.querySelectorAll('[data-testid="push-views"] [role="tab"]')].map((t) =>
      t.textContent?.trim(),
    );
    expect(tabs).toEqual(["Overview", "Add Users", "Edit Users", "Delete Users", "Users in Device"]);
    expect(q("stub-overview")).not.toBeNull();
    click("push-views-users");
    expect(window.location.search).toBe("?view=users");
    expect(q("push-users")).not.toBeNull();
    act(() => root?.unmount());
    root = createRoot(host!);
    act(() => root!.render(createElement(PushArea, { overview: OVERVIEW, loading: false })));
    expect(q("push-users")).not.toBeNull();
  });

  it("Add Users: lists the active employees missing from the reachable devices and adds the chosen ones", async () => {
    await open("/x?view=add");
    // Gate C is disconnected: not chosen, and it cannot be ticked
    expect(lastPeople()).toMatchObject({ link: "active", deviceMode: "missing", devices: [1, 2], enabled: true });
    expect((q("push-add-devices-3") as HTMLButtonElement).disabled).toBe(true);
    expect(q("push-add-devices-2")?.textContent).toContain("Site Connector · Unit 2 PC");
    expect(q("push-add-row-2001")).not.toBeNull(); // on Gate A, not on Gate B
    expect(q("push-add-row-3001")).toBeNull(); // on both
    click("push-add-kind-production");
    expect(lastPeople().employmentType).toBe("production");
    click("push-add-kind-all");

    h.push.mockResolvedValue({
      mode: "create",
      rejected: [],
      results: [entry(1, { added: ["4001"] }), entry(2, { added: ["2001", "4001"] })],
      summary: { added: 3, updated: 0, failed: 0 },
    });
    click("push-add-row-2001");
    click("push-add-row-4001");
    expect(q("push-add-bar")?.textContent).toContain("3 entries on 2 devices");
    click("push-add-review");
    expect(q("push-add-confirm")?.textContent).toContain("Gate A, Gate B");
    click("push-add-go");
    await settle();
    expect(h.push).toHaveBeenCalledWith({
      deviceIds: [1, 2],
      users: [
        { userId: "2001", name: "SARA", privilege: 0, employeeId: 11 },
        { userId: "4001", name: "Nila New", employeeId: 13 },
      ],
      context: "add",
    });
    expect(q("change-result")).not.toBeNull();
    expect(q("change-result-2")?.textContent).toContain("2 added");
  });

  it("shows the history of a sub-tab with each device's result", async () => {
    await open("/x?view=add");
    const row = q("push-add-history-row-9");
    expect(row?.textContent).toContain("Partly done");
    expect(row?.textContent).toContain("Nila New (4001)");
    expect(row?.textContent).toContain("Gate B Timed out");
    expect(row?.textContent).toContain("through a Site Connector");
  });

  it("Edit Users: moves people to another device and only then takes them off the old one", async () => {
    await open("/x?view=edit");
    expect(lastPeople()).toMatchObject({ devices: [1], deviceMode: "any" });
    expect(q("push-edit-row-2001")).not.toBeNull();
    h.push.mockResolvedValue({
      mode: "create",
      rejected: [],
      results: [entry(2, { added: ["2001"], skipped: [{ userId: "3001", reason: "Already on this device." }] })],
      summary: { added: 1, updated: 0, failed: 0 },
    });
    h.remove.mockResolvedValue({
      results: [entry(1, { deleted: ["2001", "3001"] })],
      inactive: [],
      rejected: [],
      summary: { deleted: 2, failed: 0, madeInactive: 0 },
    });
    const boxes = q("push-edit-table")!.querySelectorAll<HTMLElement>('tbody [role="checkbox"]');
    act(() => boxes.forEach((b) => b.click()));
    click("push-edit-bulk-move");
    expect(q("move-dialog")).not.toBeNull();
    expect(q("move-targets-1")).toBeNull(); // not back to where they are
    click("move-targets-2");
    click("move-confirm");
    await settle();
    expect(h.push).toHaveBeenCalledWith(expect.objectContaining({ deviceIds: [2], context: "transfer" }));
    // what Gate A holds is what travels
    expect(h.push.mock.calls[0][0].users[0]).toMatchObject({ userId: "2001", name: "SARA" });
    expect(h.remove).toHaveBeenCalledWith({
      userIds: ["2001", "3001"],
      deviceIds: [1],
      markInactive: false,
      context: "transfer",
    });
    expect(q("change-result")?.textContent).toContain("Taken off Gate A: 2 of 2.");
  });

  it("Edit Users: a person a new device did not take stays on the old one", async () => {
    await open("/x?view=edit");
    h.push.mockResolvedValue({
      mode: "create",
      rejected: [],
      results: [entry(2, { failed: [{ userId: "2001", error: "full" }] })],
      summary: { added: 0, updated: 0, failed: 1 },
    });
    click("push-edit-move-2001");
    click("move-targets-2");
    click("move-confirm");
    await settle();
    expect(h.remove).not.toHaveBeenCalled();
    expect(q("change-result")?.textContent).toContain("1 person stays on Gate A");
  });

  it("Delete Users: shows where someone is and deletes them from the devices ticked", async () => {
    await open("/x?view=delete");
    expect(lastPeople()).toMatchObject({ devices: [1, 2, 3], deviceMode: "any" });
    expect(q("push-delete-row-4001")).toBeNull(); // on no device
    act(() => q("push-delete-row-3001")!.querySelector<HTMLElement>('[role="checkbox"]')!.click());
    const where = q("push-delete-where")!;
    expect(where.textContent).toContain("is on 2 devices");
    expect(q("push-delete-device-2")?.textContent).toContain("holds “KAVI W”");
    act(() => q("push-delete-device-2")!.querySelector<HTMLElement>('[role="checkbox"]')!.click());
    expect(q("push-delete-review")?.textContent).toContain("Delete from 1 device");
    h.remove.mockResolvedValue({
      results: [entry(1, { deleted: ["3001"] })],
      inactive: [],
      rejected: [],
      summary: { deleted: 1, failed: 0, madeInactive: 0 },
    });
    click("push-delete-review");
    expect(q("delete-dialog")).not.toBeNull();
    click("delete-mark-inactive"); // keep the employee active
    click("delete-confirm");
    await settle();
    expect(h.remove).toHaveBeenCalledWith({
      userIds: ["3001"],
      deviceIds: [1],
      markInactive: false,
      context: "delete",
    });
  });

  it("Users in Device: marks what differs and what is missing, and makes a person the same", async () => {
    await open("/x?view=users");
    expect(lastPeople()).toMatchObject({ devices: [1, 2, 3], deviceMode: "any" });
    // Kavi: Gate A and Gate B hold different names (a tie: both marked), not on Gate C
    expect(q("push-users-cell-3001-1")?.closest("td")?.dataset.state).toBe("differs");
    expect(q("push-users-cell-3001-3")?.closest("td")?.dataset.state).toBe("missing");
    expect(q("push-users-cell-2001-1")?.closest("td")?.dataset.state).toBe("same");
    click("push-users-show-differs");
    expect(lastPeople().differs).toBe(true);
    click("push-users-show-missing");
    expect(lastPeople()).toMatchObject({ deviceMode: "missing", link: "active" });
    click("push-users-show-all");

    h.update.mockResolvedValue({
      mode: "update",
      rejected: [],
      results: [entry(2, { updated: ["3001"] })],
      summary: { added: 0, updated: 1, failed: 0 },
    });
    click("push-users-same-3001");
    expect(q("make-same-dialog")).not.toBeNull();
    // the first record (Gate A's "KAVI") is chosen: Gate B is the one changed
    expect(q("make-same-plan")?.textContent).toBe("Changes Gate B.");
    click("make-same-confirm");
    await settle();
    expect(h.update).toHaveBeenCalledWith({
      deviceIds: [2],
      users: [{ userId: "3001", name: "KAVI", privilege: 0, card: 0 }],
      context: "make_same",
    });
  });

  it("Users in Device: the HRMS name goes to every device holding another name", async () => {
    await open("/x?view=users");
    h.update.mockResolvedValue({
      mode: "update",
      rejected: [],
      results: [],
      summary: { added: 0, updated: 0, failed: 0 },
    });
    click("push-users-same-3001");
    click("make-same-hrms");
    expect(q("make-same-plan")?.textContent).toBe("Changes Gate A, Gate B.");
    click("make-same-confirm");
    await settle();
    expect(h.update).toHaveBeenCalledWith({
      deviceIds: [1, 2],
      users: [{ userId: "3001", employeeId: 12 }],
      context: "make_same",
    });
  });
});
