import { describe, expect, it } from "vitest";
import {
  notifyAutomationsQuery,
  notifyRunsQuery,
  readChatReport,
  readNotifyAutomation,
  readNotifyAutomations,
  readNotifyChatChannels,
  readNotifyOverview,
  readNotifyPreview,
  readNotifyRecipientLists,
  readNotifyRun,
  readNotifyRunPage,
  readNotifySnapshot,
  readNotifyStartedRun,
  readNotifyWhatsAppGroups,
} from "./attendance-notify";

// Attendance Notify's answers are read leniently: whatever an older or newer server leaves out, the page gets every key.

describe("readNotifyAutomation", () => {
  it("fills every key, drops unknown values and keeps every channel's recipient keys", () => {
    const a = readNotifyAutomation({
      id: 7,
      name: "Morning absentees",
      channel: "email",
      categories: ["absent", "late", "cl"],
      days: [5, 1, 9, 1, "x"],
      times: ["13:00", "09:30", ""],
      frequency: "fortnightly",
      employeeType: "staff",
      recipients: { to: ["a@b.in", 4], numbers: ["+919876543210", { value: " ", label: "x" }] },
      branch: { id: 3, name: "Unit 2" },
      lastRun: { id: 41, status: "partial", employees: 12, error: "1 failed" },
    })!;
    expect(a).toMatchObject({
      id: 7,
      channel: "email",
      isActive: true,
      categories: ["absent", "cl"],
      days: [1, 5],
      times: ["09:30", "13:00"],
      frequency: "daily",
      employeeType: "staff",
      reportType: "daily",
      content: "both",
      emailFormat: "html",
      branch: { id: 3, name: "Unit 2" },
      lastRun: { id: 41, status: "partial", employees: 12, error: "1 failed", at: null },
      nextRunAt: null,
    });
    expect(a.recipients).toEqual({
      connected: false,
      numbers: [{ value: "+919876543210", label: "" }],
      groups: [],
      listIds: [],
      to: ["a@b.in"],
      cc: [],
      bcc: [],
      channelIds: [],
    });
  });

  it("refuses what is not an automation, and reads a list from {items} or a bare array", () => {
    expect(readNotifyAutomation({ id: 1, channel: "sms" })).toBeNull();
    expect(readNotifyAutomation({ name: "x", channel: "chat" })).toBeNull();
    expect(readNotifyAutomation({ id: 2, channel: "chat" })?.name).toBe("Automation #2");
    expect(readNotifyAutomations({ items: [{ id: 1, channel: "chat" }, { id: "x" }] })).toHaveLength(1);
    expect(readNotifyAutomations([{ id: 1, channel: "whatsapp" }])).toHaveLength(1);
    expect(readNotifyAutomations(null)).toEqual([]);
  });
});

describe("the dashboard", () => {
  it("reads the overview with every channel and count present", () => {
    const o = readNotifyOverview({
      channels: { whatsapp: { available: false, note: "Not linked" }, email: {} },
      counts: { automations: 4, byChannel: { whatsapp: 2 } },
      settings: { connectedNumber: "+919876543210" },
      upcoming: [
        { automationId: 7, name: "Morning", channel: "whatsapp", at: "2026-11-18T09:30:00+05:30" },
        { automationId: 8, name: "Bad", channel: "fax", at: "x" },
      ],
    });
    expect(o.channels).toEqual({
      whatsapp: { available: false, note: "Not linked" },
      email: { available: true, note: "" },
      chat: { available: true, note: "" },
    });
    expect(o.counts).toEqual({
      automations: 4,
      active: 0,
      byChannel: { whatsapp: 2, email: 0, chat: 0 },
      runsToday: 0,
      failedToday: 0,
    });
    expect(o.settings.connectedNumber).toBe("+919876543210");
    expect(o.upcoming).toHaveLength(1);
    expect(readNotifyOverview(undefined).upcoming).toEqual([]);
  });

  it("reads the snapshot, falling back to what was asked", () => {
    expect(
      readNotifySnapshot({ counts: { absent: 5, cl: "2" }, total: 340 }, { date: "2026-11-17", employeeType: "staff" }),
    ).toEqual({
      date: "2026-11-17",
      employeeType: "staff",
      counts: { absent: 5, cl: 0, on_leave: 0, on_duty: 0, permission: 0, compensation: 0 },
      total: 340,
      generatedAt: null,
    });
  });
});

describe("preview, runs, lists, groups and channels", () => {
  it("reads a preview", () => {
    const p = readNotifyPreview({
      dates: ["2026-11-17"],
      counts: { absent: 2 },
      total: 300,
      employees: 2,
      messages: [{ kind: "text", text: "*Absent*: 2" }, { kind: "document", filename: "report.pdf" }, { kind: "text" }],
      html: "<p>hi</p>",
      rows: [{ name: "Asha", code: "E1", category: "absent" }, {}],
      truncated: true,
      warnings: ["WhatsApp is not linked", 5],
    });
    expect(p.messages).toEqual([
      { kind: "text", text: "*Absent*: 2", filename: null },
      { kind: "document", text: "", filename: "report.pdf" },
    ]);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ name: "Asha", code: "E1", photoUrl: null, employeeId: null });
    expect(p).toMatchObject({
      html: "<p>hi</p>",
      subject: null,
      truncated: true,
      warnings: ["WhatsApp is not linked"],
    });
  });

  it("reads a run, counting from its deliveries when the totals are missing", () => {
    const r = readNotifyRun({
      id: 41,
      automationId: null,
      automationName: "Morning",
      channel: "email",
      trigger: "retry",
      status: "partial",
      deliveries: [
        { id: 1, kind: "email", recipient: "a@b.in", status: "sent", attempts: 1 },
        { id: 2, kind: "email", recipient: "c@d.in", status: "failed", note: "Mailbox full", attempts: 3 },
        { kind: "email" },
      ],
    })!;
    expect(r).toMatchObject({ id: 41, automationId: null, trigger: "retry", recipients: 2, sent: 1, failed: 1 });
    expect(r.deliveries[1]).toMatchObject({ status: "failed", note: "Mailbox full", attempts: 3, label: "" });
    expect(readNotifyRun({ id: 1, status: "weird", channel: "x" })).toMatchObject({
      status: "done",
      channel: "whatsapp",
    });
    expect(readNotifyStartedRun({ run: { id: 9, status: "running" } })?.id).toBe(9);
    expect(readNotifyStartedRun({ id: 10 })?.id).toBe(10);
    expect(readNotifyStartedRun({})).toBeNull();
    expect(readNotifyRunPage({ items: [{ id: 1 }], total: 30 })).toMatchObject({ total: 30, page: 1, pageSize: 25 });
  });

  it("reads saved lists by their channel", () => {
    const [wa, mail] = readNotifyRecipientLists({
      items: [
        { id: 1, name: "HR", channel: "whatsapp", items: [{ value: "+919876543210", label: "Meena" }] },
        { id: 2, name: "", channel: "email", items: { to: ["a@b.in"], cc: [], bcc: ["x@y.in"] } },
      ],
    });
    expect(wa.numbers).toEqual([{ value: "+919876543210", label: "Meena" }]);
    expect(mail).toMatchObject({ name: "List #2", emails: { to: ["a@b.in"], cc: [], bcc: ["x@y.in"] }, numbers: [] });
  });

  it("reads the WhatsApp groups (not supported unless the server says so) and the chat channels", () => {
    expect(readNotifyWhatsAppGroups({ note: "WhatsApp is not linked" })).toEqual({
      supported: false,
      groups: [],
      note: "WhatsApp is not linked",
      fetchedAt: null,
    });
    expect(
      readNotifyWhatsAppGroups({ supported: true, groups: [{ id: "1@g.us", name: "HO", size: 12 }, { name: "x" }] })
        .groups,
    ).toEqual([{ id: "1@g.us", name: "HO", size: 12 }]);
    expect(
      readNotifyChatChannels({
        items: [
          { id: 1, type: "company", name: "Unit 1", branch: "Unit 1", members: 120, note: "Its branch reads it." },
          { id: 2, type: "x" },
        ],
      }),
    ).toEqual([
      { id: 1, type: "company", name: "Unit 1", branch: "Unit 1", members: 120, note: "Its branch reads it." },
      { id: 2, type: "department", name: "Channel #2", branch: "", members: null, note: "" },
    ]);
  });

  it("reads a chat message's report, or none", () => {
    expect(readChatReport(null)).toBeNull();
    expect(readChatReport("text")).toBeNull();
    expect(readChatReport({})).toBeNull();
    const r = readChatReport({
      title: "Morning absentees",
      date: "2026-11-17",
      counts: { absent: 2 },
      categories: ["absent", "nope"],
      content: "summary",
      employees: 2,
      total: 300,
      asOf: "2026-11-17T09:30:00+05:30",
    })!;
    expect(r).toMatchObject({
      dateLabel: "2026-11-17",
      categories: ["absent"],
      rows: [],
      content: "summary",
      employees: 2,
      total: 300,
      truncated: false,
    });
    expect(readChatReport({ title: "x" })?.categories).toEqual([
      "absent",
      "cl",
      "on_leave",
      "on_duty",
      "permission",
      "compensation",
    ]);
  });

  it("writes the list and history query strings without empty keys", () => {
    expect(notifyAutomationsQuery({ channel: "email", status: "active", search: " morning " })).toBe(
      "channel=email&status=active&search=morning",
    );
    expect(notifyAutomationsQuery({})).toBe("");
    expect(notifyRunsQuery({ automation: 7, channel: null, status: "failed", page: 2 })).toBe(
      "automation=7&status=failed&page=2",
    );
    expect(notifyRunsQuery({ page: 1 })).toBe("");
  });
});
