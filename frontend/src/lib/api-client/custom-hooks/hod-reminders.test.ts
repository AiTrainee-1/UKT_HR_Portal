import { describe, expect, it } from "vitest";
import {
  hodPendingQuery,
  readHodPending,
  readHodPreview,
  readHodRun,
  readHodRunPage,
  readHodSettings,
} from "./hod-reminders";

// The HoD's / Notify answers are read leniently: whatever an older or newer server leaves out, the page gets every key.

describe("readHodPending", () => {
  it("keeps a null category (not allowed) apart from a zero, and drops what is not a head or a request", () => {
    const out = readHodPending({
      generatedAt: "2026-11-04T05:00:00Z",
      categories: [{ key: "leave", label: "Leave" }, { key: "" }, { key: "permission" }],
      totals: { hods: 2, withPending: 1, pending: 3, byCategory: { leave: 3, junk: "x" } },
      hods: [
        {
          managerId: 1,
          name: "Ravi",
          departments: ["Cutting", 5, ""],
          pending: 3,
          byCategory: { leave: 3, permission: null, casual_leave: 0, bad: "2" },
          devices: 2,
          items: [{ id: 4, category: "leave", openPath: "/hr/requests?kind=leave&focus=4" }, { category: "leave" }],
        },
        { name: "no id" },
      ],
    });
    expect(out.categories).toEqual([
      { key: "leave", label: "Leave" },
      { key: "permission", label: "permission" },
    ]);
    expect(out.totals).toEqual({ hods: 2, withPending: 1, pending: 3, byCategory: { leave: 3 } });
    expect(out.hods).toHaveLength(1);
    const [ravi] = out.hods;
    expect(ravi.byCategory).toEqual({ leave: 3, permission: null, casual_leave: 0 });
    expect(ravi.departments).toEqual(["Cutting"]);
    expect(ravi.items).toHaveLength(1);
    expect(ravi.items[0]).toMatchObject({ id: 4, categoryLabel: "leave", employeeName: "", waitingDays: null });
    expect(ravi.phone).toBeNull();
    expect(ravi.devices).toBe(2);
  });

  it("works out the totals when the server sends none, and reads nothing as an empty board", () => {
    const out = readHodPending({
      hods: [
        { managerId: 1, pending: 2, items: [] },
        { managerId: 2, pending: 0 },
      ],
    });
    expect(out.totals).toEqual({ hods: 2, withPending: 1, pending: 2, byCategory: {} });
    expect(out.hods[1].name).toBe("HoD #2");
    expect(readHodPending(null)).toEqual({
      generatedAt: null,
      categories: [],
      totals: { hods: 0, withPending: 0, pending: 0, byCategory: {} },
      hods: [],
    });
  });
});

describe("readHodSettings", () => {
  it("fills the server's defaults: channels on, Mon-Sat, editable, company-wide", () => {
    const s = readHodSettings({});
    expect(s.enabled).toBe(false);
    expect(s.days).toEqual([0, 1, 2, 3, 4, 5]);
    expect(s.channels).toEqual({ whatsapp: true, email: true, push: true });
    expect(s.canEdit).toBe(true);
    expect(s.companyWide).toBe(true);
    expect(s.lastRun).toBeNull();
    expect(s.channelStatus.email).toEqual({ available: true, note: "" });
  });

  it("reads what is there, cleaning the days and the times", () => {
    const s = readHodSettings({
      enabled: true,
      times: ["10:00", "", 7],
      days: [5, 1, 1, 9, "2"],
      channels: { whatsapp: false },
      canEdit: false,
      channelStatus: { email: { available: false, note: "SMTP not set up" } },
      lastRun: { id: 3, status: "running" },
    });
    expect(s.times).toEqual(["10:00"]);
    expect(s.days).toEqual([1, 5]);
    expect(s.channels).toEqual({ whatsapp: false, email: true, push: true });
    expect(s.canEdit).toBe(false);
    expect(s.channelStatus.email).toEqual({ available: false, note: "SMTP not set up" });
    expect(s.lastRun?.status).toBe("running");
    // days present but empty stay empty (the schedule never runs), they are not the default
    expect(readHodSettings({ days: [] }).days).toEqual([]);
  });
});

describe("readHodRun", () => {
  it("reads a run with its deliveries, a channel still waiting as pending, an unknown status as off", () => {
    const run = readHodRun({
      id: 7,
      trigger: "schedule",
      slot: "10:00",
      status: "running",
      error: null,
      counts: { whatsapp: { sent: 1 } },
      deliveries: [
        {
          managerId: 1,
          name: "Ravi",
          pending: 3,
          text: "Dear Ravi",
          whatsapp: { status: "sent", note: null },
          email: { status: "pending" },
          push: { status: "weird", note: "x" },
        },
        { name: "no id" },
      ],
    });
    expect(run).not.toBeNull();
    expect(run!.counts.whatsapp).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(run!.counts.push).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(run!.deliveries).toHaveLength(1);
    expect(run!.deliveries![0].whatsapp).toEqual({ status: "sent", note: "" });
    expect(run!.deliveries![0].email.status).toBe("pending");
    expect(run!.deliveries![0].push.status).toBe("off");
    expect(readHodRun({ status: "done" })).toBeNull();
    expect(readHodRun({ id: 1 })).toMatchObject({ trigger: "manual", status: "done", error: null });
    expect(readHodRun({ id: 1 })!.deliveries).toBeUndefined();
  });

  it("reads a page of runs and a preview", () => {
    expect(readHodRunPage({ items: [{ id: 1 }, { id: "x" }], total: 30, page: 2, pageSize: 8 })).toMatchObject({
      total: 30,
      page: 2,
      pageSize: 8,
      items: [{ id: 1 }],
    });
    expect(readHodRunPage(undefined)).toEqual({ items: [], total: 0, page: 1, pageSize: 1 });
    expect(
      readHodPreview({ messages: [{ managerId: 1, name: "Ravi", pending: 2, text: "Hi" }, { name: "x" }] }),
    ).toEqual([{ managerId: 1, name: "Ravi", pending: 2, text: "Hi" }]);
  });
});

describe("hodPendingQuery", () => {
  it("sends only what narrows", () => {
    expect(hodPendingQuery({})).toBe("");
    expect(hodPendingQuery({ branchId: "2", departmentId: "", search: "  ravi ", onlyPending: true })).toBe(
      "branchId=2&search=ravi&onlyPending=1",
    );
  });
});
