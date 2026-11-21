import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import TrackingAlerts from "./TrackingAlerts";
import TrackingRulesCard from "./TrackingRulesCard";
import { alertState, channelLine, headLine, openSummary } from "./alerts";
import {
  IST,
  buttonNamed,
  click,
  installBrowserStubs,
  installWorld,
  mount,
  q,
  text,
  typeAt,
  unmount,
  waitFor,
  type Raw,
  type World,
} from "./testing";
import type { TrackingAlert } from "@/lib/api-client/custom-hooks";

// Geo Attendance -> Live Map -> "Tracking alerts" (the log of the automatic On-Duty tracking alerts) and the alert timing on
// Tracking Settings, in jsdom against the fake server of testing.tsx.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as Record<string, unknown> | null },
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "tok", user: h.user.current }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

const SUPER = { role: "hr", employeeId: null, isSuperAdmin: true, permissions: {} };

function alertRow(id: number, over: Raw = {}): Raw {
  return {
    id,
    kind: "location_off",
    kindLabel: "Location turned off",
    summary: "Location off since 10:05 AM",
    trackId: 7,
    sessionId: 31,
    destination: "Tirupur buyer visit",
    employeeId: 11,
    employeeName: "Asha Kumar",
    employeeCode: "E2E001",
    department: "Sales",
    detectedAt: IST("10:05"),
    lastSeenAt: IST("10:30"),
    resolvedAt: null,
    resolution: null,
    resolutionLabel: null,
    open: true,
    waiting: false,
    escalates: true,
    hodDueAt: null,
    stages: [
      {
        stage: "employee",
        recipientName: "Asha Kumar",
        sentAt: IST("10:08"),
        push: { outcome: "made", label: "Notification made", status: "delivered", error: null },
        whatsapp: { outcome: "off", label: "Switched off" },
      },
      {
        stage: "hod",
        recipientName: "Suresh R",
        sentAt: IST("10:23"),
        push: { outcome: "made", label: "Notification made", status: "no_device", error: null },
        whatsapp: { outcome: "queued", label: "Queued", status: "sent", error: null },
      },
    ],
    ...over,
  };
}

let world: World;

beforeAll(installBrowserStubs);
beforeEach(() => {
  vi.clearAllMocks();
  h.user.current = SUPER;
  world = installWorld(h.fetch);
});
afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmount();
});

describe("the tracking alerts log", () => {
  it("lists what is open now, with who was told on which channel", async () => {
    const opened = vi.fn();
    world.alerts = [
      alertRow(1),
      alertRow(2, { open: false, resolvedAt: IST("11:00"), resolution: "fixed", resolutionLabel: "Fixed" }),
    ];
    mount("/hr/geo-attendance/live-map", () => <TrackingAlerts onOpenJourney={opened} />);
    await waitFor(() => q("tracking-alert-1") !== null, "the open alert");
    expect(q("tracking-alert-2")).toBeNull(); // "Open now" leaves the fixed one out
    expect(text(q("tracking-alerts-open"))).toBe("1 open now: 1 location turned off");
    const row = text(q("tracking-alert-1"));
    expect(row).toContain("Asha Kumar");
    expect(row).toContain("Location turned off");
    expect(row).toContain("Location off since 10:05 AM");
    expect(text(q("alert-stage-employee"))).toContain("Phone: delivered");
    expect(text(q("alert-stage-employee"))).toContain("WhatsApp: Switched off");
    expect(text(q("alert-stage-hod"))).toContain("Department Head (Suresh R)");
    expect(text(q("alert-stage-hod"))).toContain("WhatsApp: sent");
    await click(buttonNamed("Journey"));
    expect(opened).toHaveBeenCalledWith(7);
    expect(world.requests.some((r) => r.startsWith("GET /api/tracking/live/alerts?status=open"))).toBe(true);
  });

  it("says so when nothing is open", async () => {
    mount("/hr/geo-attendance/live-map", () => <TrackingAlerts />);
    await waitFor(() => q("tracking-alerts-empty") !== null, "the empty note");
    expect(text(q("tracking-alerts-empty"))).toBe("No tracking problem open right now.");
  });
});

describe("the words of a row", () => {
  const row = alertRow(1) as unknown as TrackingAlert;

  it("describes each channel's outcome and the episode's state", () => {
    expect(channelLine(row.stages[0].push, "push")).toMatchObject({ text: "delivered", tone: "success" });
    expect(channelLine(row.stages[1].push, "push")).toMatchObject({ text: "no phone registered", tone: "warning" });
    expect(
      channelLine(
        { outcome: "not_recipient", label: "Not a phone notification recipient", status: null, error: null },
        "push",
      ).text,
    ).toBe("Not a phone notification recipient");
    expect(alertState(row)).toEqual({ label: "Open", tone: "warning" });
    expect(alertState({ ...row, waiting: true }).label).toBe("Seen, alert pending");
    expect(
      alertState({ ...row, open: false, resolution: "fixed", resolutionLabel: "Fixed", resolvedAt: IST("11:00") }),
    ).toEqual({
      label: "Fixed 11:00",
      tone: "success",
    });
  });

  it("says when the Department Head was or will be told", () => {
    expect(headLine(row)).toBe("Department Head told at 10:23 (Suresh R)");
    expect(headLine({ ...row, stages: [row.stages[0]], hodDueAt: IST("10:23") })).toBe(
      "Department Head is told at 10:23 if it is still not fixed",
    );
    const noHead = { ...row.stages[1], push: { ...row.stages[1].push, outcome: "no_head" } };
    expect(headLine({ ...row, stages: [row.stages[0], noHead] })).toBe("No Department Head to tell");
    expect(headLine({ ...row, stages: [row.stages[0]], hodDueAt: null })).toBeNull();
  });

  it("sums up what is open", () => {
    expect(openSummary(0, {}, {})).toBe("Nothing open now");
    expect(
      openSummary(
        3,
        { location_off: 2, missing_punch: 1 },
        { location_off: "Location turned off", missing_punch: "Missing Geo-Punch" },
      ),
    ).toBe("3 open now: 2 location turned off, 1 missing geo-punch");
  });
});

describe("the alert timing on Tracking Settings", () => {
  it("shows the defaults and saves only what changed", async () => {
    mount("/hr/geo-attendance/settings", TrackingRulesCard);
    await waitFor(() => q("rules-alerts") !== null, "the alerts section");
    const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    expect(value("rule-alert-debounce")).toBe("2");
    expect(value("rule-alert-hod-grace")).toBe("15");
    expect(value("rule-alert-cooldown")).toBe("30");
    expect(value("rule-missing-first-punch")).toBe("30");
    expect(value("rule-punch-check")).toBe("19:00");
    expect(value("rule-punch-reminder")).toBe("180");
    await typeAt("#rule-alert-debounce", "5");
    await typeAt("#rule-punch-check", "18:30");
    await click(buttonNamed("Save tracking rules"));
    await waitFor(() => world.writes.some((w) => w.method === "PUT"), "the save");
    expect(world.writes.find((w) => w.method === "PUT")!.body).toEqual({
      alertDebounceMinutes: 5,
      punchCheckTime: "18:30",
    });
  });

  it("refuses a check time in the morning", async () => {
    mount("/hr/geo-attendance/settings", TrackingRulesCard);
    await waitFor(() => q("rules-alerts") !== null, "the alerts section");
    await typeAt("#rule-punch-check", "09:00");
    expect(text(q("rules-alerts"))).toContain("Day's punch check: choose a time between 12:00 and 23:59.");
    expect((buttonNamed("Save tracking rules") as HTMLButtonElement).disabled).toBe(true);
  });
});
