import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readNotifyAutomation,
  readNotifyRun,
  type NotifyAutomation,
  type NotifyAutomationsParams,
  type NotifyRun,
  type NotifyRunsParams,
} from "@/lib/api-client/custom-hooks/attendance-notify";
import AttendanceNotify from "../AttendanceNotify";

// The Attendance Notify page against stand-in hooks: the dashboard, the tabs in the address, a channel's cards, the
// management table (switch, run now, delete), the history (filters in the address, deliveries, retry), the tab
// permissions, and the Internal Chat warning.

const h = vi.hoisted(() => ({
  automations: [] as unknown[],
  runs: [] as unknown[],
  levels: {} as Record<string, string>,
  automationsCalls: [] as unknown[],
  runsCalls: [] as unknown[],
  groupsCalls: [] as boolean[],
  toggle: vi.fn(),
  run: vi.fn(),
  remove: vi.fn(),
  retry: vi.fn(),
  save: vi.fn(),
  settings: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: { role: "hr", permissions: {} } }),
  permissionLevel: (_user: unknown, key: string) => h.levels[key] ?? "edit",
  isRouteViewOnly: () => false,
}));
vi.mock("@/lib/api-client/custom-hooks", async (original) => {
  const real = await original<typeof import("@/lib/api-client/custom-hooks")>();
  const mutation = (fn: (...a: unknown[]) => unknown) => ({ mutateAsync: fn, mutate: fn, isPending: false });
  return {
    ...real,
    useAttendanceNotifyOverview: () => ({
      data: real.readNotifyOverview({
        channels: { whatsapp: { available: true, note: "" }, email: { available: false, note: "Gmail is not set up" } },
        counts: {
          automations: 3,
          active: 2,
          byChannel: { whatsapp: 2, email: 1, chat: 0 },
          runsToday: 4,
          failedToday: 1,
        },
        settings: { connectedNumber: "+919876543210" },
        upcoming: [
          { automationId: 1, name: "Morning absentees", channel: "whatsapp", at: "2099-01-01T09:30:00+05:30" },
        ],
      }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useAttendanceNotifySnapshot: (p: { date: string; employeeType: string }) => ({
      data: real.readNotifySnapshot({
        date: p.date,
        employeeType: p.employeeType,
        counts: { absent: p.employeeType === "staff" ? 3 : 12, cl: 4, on_leave: 2, permission: 5, compensation: 1 },
        total: 340,
      }),
      isError: false,
      isFetching: false,
      isPlaceholderData: false,
    }),
    useAttendanceNotifyAutomations: (p: NotifyAutomationsParams = {}) => {
      h.automationsCalls.push(p);
      const items = (h.automations as NotifyAutomation[]).filter(
        (a) => (!p.channel || a.channel === p.channel) && (!p.status || (p.status === "active") === a.isActive),
      );
      return { data: items, isError: false, refetch: vi.fn() };
    },
    useAttendanceNotifyRuns: (p: NotifyRunsParams) => {
      h.runsCalls.push(p);
      const items = (h.runs as NotifyRun[]).filter((r) => !p.status || r.status === p.status);
      return { data: { total: items.length, page: 1, pageSize: 25, items }, isError: false, refetch: vi.fn() };
    },
    useAttendanceNotifyRun: (id: number | null) => ({
      data: id === null ? undefined : ((h.runs as NotifyRun[]).find((r) => r.id === id) ?? null),
      isError: false,
    }),
    useToggleAttendanceNotifyAutomation: () => mutation(h.toggle),
    useRunAttendanceNotifyAutomation: () => mutation(h.run),
    useDeleteAttendanceNotifyAutomation: () => mutation(h.remove),
    useRetryAttendanceNotifyRun: () => mutation(h.retry),
    useSaveAttendanceNotifyAutomation: () => mutation(h.save),
    useAttendanceNotifyPreview: () => ({ mutate: vi.fn(), data: undefined, isPending: false, isError: false }),
    useUpdateAttendanceNotifySettings: () => mutation(h.settings),
    useAttendanceNotifyRecipientLists: () => ({ data: [], isLoading: false, isError: false }),
    useSaveAttendanceNotifyRecipientList: () => mutation(vi.fn()),
    useDeleteAttendanceNotifyRecipientList: () => mutation(vi.fn()),
    useAttendanceNotifyWhatsAppGroups: (enabled: boolean) => {
      h.groupsCalls.push(enabled);
      return { data: undefined, isLoading: false, isError: false };
    },
    useRefreshAttendanceNotifyWhatsAppGroups: () => mutation(vi.fn()),
    useAttendanceNotifyChatChannels: () => ({ data: [], isLoading: false, isError: false }),
  };
});

const AUTOMATIONS = [
  readNotifyAutomation({
    id: 1,
    name: "Morning absentees",
    channel: "whatsapp",
    isActive: true,
    categories: ["absent", "cl"],
    employeeType: "staff",
    frequency: "weekly",
    days: [0, 1, 2, 3, 4, 5],
    times: ["09:30", "13:00"],
    recipientSummary: "the connected number, 2 numbers",
    nextRunAt: "2099-01-01T09:30:00+05:30",
    lastRun: { id: 41, at: "2026-11-17T09:30:00+05:30", status: "partial", employees: 12, error: "1 number failed" },
  })!,
  readNotifyAutomation({
    id: 2,
    name: "Production leave",
    channel: "whatsapp",
    isActive: false,
    employeeType: "production",
    recipientSummary: "1 group",
  })!,
  readNotifyAutomation({
    id: 3,
    name: "Daily mail to HR",
    channel: "email",
    isActive: true,
    employeeType: "all",
    recipientSummary: "2 addresses",
  })!,
];

const RUNS = [
  readNotifyRun({
    id: 41,
    automationId: 1,
    automationName: "Morning absentees",
    channel: "whatsapp",
    trigger: "schedule",
    slot: "09:30",
    status: "partial",
    employees: 12,
    counts: { absent: 8, cl: 4 },
    recipients: 3,
    sent: 2,
    failed: 1,
    reportFrom: "2026-11-17",
    reportTo: "2026-11-17",
    startedAt: "2026-11-17T09:30:00+05:30",
    deliveries: [
      { id: 1, kind: "connected", recipient: "+919876543210", status: "sent", attempts: 1 },
      {
        id: 2,
        kind: "number",
        recipient: "+919876543211",
        label: "HR Manager",
        status: "failed",
        note: "Not on WhatsApp",
        attempts: 3,
      },
    ],
  })!,
  readNotifyRun({
    id: 40,
    automationId: null,
    automationName: "Old automation",
    channel: "email",
    trigger: "manual",
    requestedBy: "Meena",
    status: "done",
    recipients: 1,
    sent: 1,
    failed: 0,
  })!,
];

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

beforeEach(() => {
  vi.clearAllMocks();
  h.automations = AUTOMATIONS;
  h.runs = RUNS;
  h.levels = {};
  h.automationsCalls = [];
  h.runsCalls = [];
  h.groupsCalls = [];
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
});

function open(url: string) {
  window.history.replaceState(null, "", url);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(AttendanceNotify))));
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
const tabs = () => [...document.body.querySelectorAll('[data-testid="an-tabs"] [role="tab"]')];
const tab = (label: string) => tabs().find((t) => text(t.querySelector(".ptab-label")).startsWith(label)) ?? null;

describe("the dashboard", () => {
  it("shows the channels, today's numbers by employee type, the counts and the next sends", () => {
    open("/hr/attendance/attendance-notify");
    expect(text(q("an-channel-whatsapp-state"))).toBe("Ready to send");
    expect(text(q("an-channel-email-state"))).toBe("Not ready");
    expect(text(q("an-channel-email"))).toContain("Gmail is not set up");
    expect(text(q("an-channel-whatsapp"))).toContain("+91 98765 43210");
    expect(text(q("an-channel-whatsapp-count"))).toBe("2");
    expect(text(q("an-snapshot-absent-value"))).toBe("12");
    expect(text(q("an-snapshot-total-value"))).toBe("340");
    click(q("an-snapshot-type-staff"));
    expect(text(q("an-snapshot-absent-value"))).toBe("3");
    expect(text(q("an-count-failed"))).toContain("1");
    expect(text(q("an-upcoming"))).toContain("Morning absentees");
  });

  it("a channel card opens its tab", () => {
    open("/hr/attendance/attendance-notify?tab=history");
    click(q("an-channel-email"));
    expect(window.location.search).toBe("?tab=gmail");
    expect(q("an-tab-email")).not.toBeNull();
  });
});

describe("the tabs", () => {
  it("are the five, in the address, WhatsApp first", () => {
    open("/hr/attendance/attendance-notify");
    expect(tabs().map((t) => text(t.querySelector(".ptab-label")))).toEqual([
      "WhatsApp(2)",
      "Gmail(1)",
      "Internal Chat(0)",
      "Automation Management(3)",
      "Execution History",
    ]);
    expect(tab("WhatsApp")?.getAttribute("aria-selected")).toBe("true");
    expect(q("an-tab-whatsapp")).not.toBeNull();
    click(tab("Internal Chat"));
    expect(window.location.search).toBe("?tab=chat");
    expect(q("an-chat-warning")).not.toBeNull();
    expect(text(q("an-empty-chat"))).toContain("No Internal Chat automation yet");
  });

  it("hide a tab the role may not see, and open the first one it may", () => {
    h.levels = {
      "attendance.attendance_notify.whatsapp": "hidden",
      "attendance.attendance_notify.history": "hidden",
    };
    open("/hr/attendance/attendance-notify?tab=history");
    expect(tabs().map((t) => text(t.querySelector(".ptab-label")))).toEqual([
      "Gmail(1)",
      "Internal Chat(0)",
      "Automation Management(3)",
    ]);
    expect(q("an-history")).toBeNull();
    expect(q("an-tab-email")).not.toBeNull();
  });
});

describe("a channel's tab", () => {
  it("lists its automations as cards, the connected number, and opens the form", () => {
    open("/hr/attendance/attendance-notify?tab=whatsapp");
    expect(h.automationsCalls.some((p) => (p as NotifyAutomationsParams).channel === "whatsapp")).toBe(true);
    const card = q("an-card-1");
    expect(text(card)).toContain("Morning absentees");
    expect(text(card)).toContain("Mon–Sat at 9:30 AM and 1:00 PM");
    expect(text(card)).toContain("the connected number, 2 numbers");
    expect(text(card)).toContain("1 number failed");
    expect(q("an-card-2")?.dataset.active).toBe("false");
    expect(q("an-card-3")).toBeNull();
    expect(text(q("an-connected-number-value"))).toContain("+91 98765 43210");

    click(q("an-new-whatsapp"));
    expect(q("an-form")).not.toBeNull();
    expect(text(q("an-form"))).toContain("New WhatsApp automation");
    // the channel is the tab's: not asked for
    expect(q("an-channel-pick")).toBeNull();
  });

  it("saves the connected number, normalised", async () => {
    h.settings.mockResolvedValue({ connectedNumber: "+919123456789" });
    open("/hr/attendance/attendance-notify");
    click(q("an-connected-number-edit"));
    const input = q("an-connected-number-input") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "91234 56789");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(q("an-connected-number-save"));
    await settle();
    expect(h.settings).toHaveBeenCalledWith({ connectedNumber: "+919123456789" });
  });

  it("says when the channel cannot deliver", () => {
    open("/hr/attendance/attendance-notify?tab=gmail");
    expect(text(q("an-channel-unavailable"))).toContain("Gmail cannot deliver right now: Gmail is not set up");
  });
});

describe("Automation Management", () => {
  it("lists every automation with its type, times and last run, and filters them", () => {
    open("/hr/attendance/attendance-notify?tab=automations");
    expect(q("an-row-1")).not.toBeNull();
    expect(q("an-row-3")).not.toBeNull();
    const row = text(q("an-row-1"));
    expect(row).toContain("Staff");
    expect(row).toContain("9:30 AM and 1:00 PM");
    expect(row).toContain("Partly sent");
    expect(q("an-row-errors-1")).not.toBeNull();
    expect(q("an-row-errors-3")).toBeNull();
    click(q("an-filter-kind-production"));
    expect(q("an-row-1")).toBeNull();
    expect(q("an-row-2")).not.toBeNull();
    click(q("an-filter-kind-any"));
    click(q("an-filter-channel-email"));
    expect((h.automationsCalls.at(-1) as NotifyAutomationsParams).channel).toBe("email");
    expect(q("an-row-1")).toBeNull();
    expect(q("an-row-3")).not.toBeNull();
  });

  it("switches one off and on", async () => {
    h.toggle.mockResolvedValue(null);
    open("/hr/attendance/attendance-notify?tab=automations");
    click(q("an-row-toggle-1"));
    await settle();
    expect(h.toggle).toHaveBeenCalledWith({ id: 1, isActive: false });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "“Morning absentees” is off" }));
  });

  it("Run now asks first, then starts the run and follows it", async () => {
    h.run.mockResolvedValue({ ...RUNS[0], id: 50, status: "running" });
    h.runs = [...RUNS, { ...RUNS[0], id: 50, status: "running", sent: 1, failed: 0 }];
    open("/hr/attendance/attendance-notify?tab=automations");
    click(q("an-row-run-1"));
    expect(text(q("an-run-confirm"))).toContain("Send “Morning absentees” now?");
    expect(h.run).not.toHaveBeenCalled();
    click(q("an-run-go"));
    await settle();
    expect(h.run).toHaveBeenCalledWith(1);
    expect(text(q("an-live-run"))).toContain("Morning absentees");
    click(q("an-live-run-open"));
    expect(window.location.search).toBe("?tab=history&automation=1&run=50");
  });

  it("Delete asks first and says the history is kept", async () => {
    h.remove.mockResolvedValue(1);
    open("/hr/attendance/attendance-notify?tab=automations");
    click(q("an-row-delete-3"));
    const confirm = text(q("an-delete-confirm"));
    expect(confirm).toContain("Delete “Daily mail to HR”?");
    expect(confirm).toContain("execution history is kept");
    click(q("an-delete-go"));
    await settle();
    expect(h.remove).toHaveBeenCalledWith(3);
  });

  it("View errors opens the history of that automation on its last run", () => {
    open("/hr/attendance/attendance-notify?tab=automations");
    click(q("an-row-errors-1"));
    expect(window.location.search).toBe("?tab=history&automation=1&run=41");
    expect(q("an-run-41-details")).not.toBeNull();
    expect((h.runsCalls.at(-1) as NotifyRunsParams).automation).toBe(1);
  });
});

describe("Execution History", () => {
  it("lists the runs, opens one with its deliveries, and retries the failed ones", async () => {
    h.retry.mockResolvedValue({ ...RUNS[0], id: 51, status: "running", trigger: "retry" });
    open("/hr/attendance/attendance-notify?tab=history");
    expect(text(q("an-run-41"))).toContain("Scheduled · 9:30 AM");
    expect(text(q("an-run-41"))).toContain("2 of 3 sent · 1 failed");
    expect(text(q("an-run-40"))).toContain("(deleted)");
    expect(text(q("an-run-40"))).toContain("Run now by Meena");
    click(q("an-run-41-toggle"));
    const deliveries = q("an-run-41-deliveries");
    expect(text(deliveries)).toContain("HR Manager");
    expect(text(deliveries)).toContain("Not on WhatsApp");
    expect(q("an-delivery-2")?.dataset.status).toBe("failed");
    click(q("an-run-41-retry"));
    await settle();
    expect(h.retry).toHaveBeenCalledWith(41);
    // the done run has nothing to retry
    click(q("an-run-40-toggle"));
    expect(q("an-run-40-retry")).toBeNull();
  });

  it("keeps its filters in the address", () => {
    open("/hr/attendance/attendance-notify?tab=history");
    click(q("an-history-status-failed"));
    expect(window.location.search).toBe("?tab=history&status=failed");
    expect((h.runsCalls.at(-1) as NotifyRunsParams).status).toBe("failed");
    expect(text(q("an-history-empty"))).toContain("No send matches these filters");
    click(q("an-history-clear"));
    expect(window.location.search).toBe("?tab=history");
  });
});

describe("the form's WhatsApp groups", () => {
  it("are only read from WhatsApp when asked", () => {
    open("/hr/attendance/attendance-notify?tab=whatsapp");
    click(q("an-card-edit-1"));
    click(q("an-form-step-recipients"));
    expect(q("an-groups-load")).not.toBeNull();
    expect(h.groupsCalls.every((on) => on === false)).toBe(true);
    click(q("an-groups-load"));
    expect(h.groupsCalls.at(-1)).toBe(true);
  });
});
