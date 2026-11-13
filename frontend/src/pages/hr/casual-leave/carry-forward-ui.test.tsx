import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionGlobalConfig } from "framer-motion";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CasualLeaveBalance } from "@/lib/api-client/custom-hooks";
import CasualLeave from "../CasualLeave";
import CarryForwardTab from "./CarryForwardTab";
import { DETECT_TIMING } from "./DetectPanel";
import type { CalendarDay, ClAdjustment, ClAdjustmentLog, DetectedDay } from "./carry-forward";
import type { BoardRow, ClBoard } from "./logic";

// The Carry Forward tab of the Casual Leave page (owner 2026-11-04, final form) with a filled query cache: the balance is a
// fixed 12 (no "Add days" anywhere); "Deduct days" = enter the most days, the absent, on-leave and half days of the month
// are detected (with an animation), HR picks dates up to that many days choosing Full day / First half / Second half for
// each, and only those dates are sent. Plus the refusals and the log.

const h = vi.hoisted(() => ({ fetch: vi.fn(), post: vi.fn(), toast: vi.fn() }));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
// the page reads the signed-in role (lib/tab-access.tsx): no user = every tab and part open, as before
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ user: null }),
}));
vi.mock("@/components/ApprovalTrail", async (original) => ({
  ...(await original<typeof import("@/components/ApprovalTrail")>()),
  PipelineNote: () => null,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  MotionGlobalConfig.skipAnimations = true; // enter / exit animations finish at once
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  // the tab draws the table on a wide screen (useIsMobile): jsdom has no matchMedia and is 1024 px wide
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  vi.clearAllMocks();
  h.post.mockReset(); // a save answer a failed test left queued must not leak into the next one
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-20T10:00:00") });
  window.history.replaceState(null, "", "/hr/casual-leave");
  DETECT_TIMING.minMs = 0; // the detection's shortest showing time (tests that look at the animation raise it)
  // reads answer from the fixtures; a save goes to h.post, whose answer each test sets
  h.fetch.mockImplementation(async (url: string, options?: { method?: string; body?: string }) => {
    if (options?.method === "POST") return h.post(url, JSON.parse(options.body ?? "{}"));
    if (url.includes("absent-dates")) return detectionOf(url);
    return url.includes("eligibility") ? board : url.includes("adjustments") ? log : [];
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

const bal = (over: Partial<CasualLeaveBalance> = {}): CasualLeaveBalance => ({
  total: 12,
  used: 0,
  pending: 0,
  remaining: 12,
  year: 2026,
  since: "2026-11-02",
  endsOn: "2026-12-31",
  cutOver: "2026-11-02",
  tracked: true,
  ...over,
});

const person = (id: number, name: string, over: Partial<BoardRow> = {}): BoardRow => ({
  employeeId: id,
  employeeName: name,
  employeeCode: `E${id}`,
  department: "Cutting",
  departmentId: 1,
  branch: "Head Office",
  branchId: 1,
  employmentType: "staff",
  serviceMonths: 24,
  eligible: true,
  usedThisMonth: false,
  balance: bal(),
  ...over,
});

const board: ClBoard = {
  month: 11,
  year: 2026,
  eligibilityMonths: 6,
  rule: "yearly_balance",
  yearlyEntitlement: 12,
  employees: [
    person(1, "Asha Kumar", { balance: bal({ used: 1, pending: 1, remaining: 10 }) }),
    person(2, "Ravi Shankar"),
    person(4, "Suresh Raj", { eligible: false, reasonCode: "under_service", serviceMonths: 4 }),
    person(5, "Bala", { eligible: false, reasonCode: "not_staff", employmentType: "production", balance: null }),
  ],
};

const ANY: Pick<DetectedDay, "portions" | "suggested" | "halves"> = {
  portions: ["full", "first_half", "second_half"],
  suggested: "full",
  halves: { first: "09:00-13:00", second: "14:00-18:00" },
};
const absentOn = (date: string, weekday: string): DetectedDay => ({
  date,
  weekday,
  status: "absent",
  label: "Absent",
  ...ANY,
});

/** Asha (1): absent 5, 6, 10, 12 Nov, on sick leave 13 Nov, worked only the morning of 16 Nov, absent 7 Oct; Ravi (2):
 *  absent 6 Nov, nothing in October. */
const FOUND: Record<string, Record<number, DetectedDay[]>> = {
  "11": {
    1: [
      absentOn("2026-11-05", "Thu"),
      absentOn("2026-11-06", "Fri"),
      absentOn("2026-11-10", "Tue"),
      absentOn("2026-11-12", "Thu"),
      { date: "2026-11-13", weekday: "Fri", status: "on_leave", label: "On Leave · Sick Leave", ...ANY },
      {
        date: "2026-11-16",
        weekday: "Mon",
        status: "half_shift",
        label: "Half Day · worked the morning (09:00-12:30)",
        portions: ["second_half", "full"],
        suggested: "second_half",
        worked: "morning",
        halves: { first: "09:00-13:00", second: "14:00-18:00" },
      },
    ],
    2: [absentOn("2026-11-06", "Fri")],
  },
  "10": { 1: [absentOn("2026-10-07", "Wed")], 2: [] },
};

function detectionOf(url: string) {
  const params = new URL(url, "http://x").searchParams;
  const month = params.get("month")!;
  const ids = params.get("employeeIds")!.split(",").map(Number);
  const days = month === "11" ? 30 : 31;
  return {
    year: 2026,
    month: Number(month),
    monthLabel: month === "11" ? "November 2026" : "October 2026",
    monthStart: `2026-${month}-01`,
    monthEnd: `2026-${month}-${days}`,
    lastDay: month === "11" ? "2026-11-20" : "2026-10-31",
    assignable: true,
    employees: ids.map((id) => {
      const found = FOUND[month]?.[id] ?? [];
      const calendar: CalendarDay[] = Array.from({ length: days }, (_, i) => {
        const date = `2026-${month}-${String(i + 1).padStart(2, "0")}`;
        const hit = found.find((d) => d.date === date);
        return hit
          ? { date, weekday: hit.weekday, status: hit.status, selectable: true, label: hit.label }
          : { date, weekday: "", status: "present", selectable: false, label: "Present" };
      });
      return {
        employeeId: id,
        balance: null,
        absent: found.filter((d) => d.status === "absent"),
        onLeave: found.filter((d) => d.status === "on_leave"),
        halfDay: found.filter((d) => d.status === "half_shift"),
        dates: found,
        calendar,
      };
    }),
  };
}

const round: ClAdjustment = {
  id: 31,
  employeeId: 1,
  employeeCode: "E1",
  employeeName: "Asha Kumar",
  department: "Cutting",
  branch: "Head Office",
  year: 2026,
  days: -2,
  dates: ["2026-10-20", "2026-10-22"],
  reason: "Absent days covered by unused CL",
  balanceBefore: 12,
  balanceAfter: 10,
  createdBy: "Meena",
  createdAt: "2026-11-18T10:15:00+05:30",
};

const log: ClAdjustmentLog = {
  year: 2026,
  items: [round],
  total: 1,
  page: 1,
  pageSize: 500,
  summary: { changes: 1, employees: 1, days: 2 },
};

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["/api/casual-leaves/eligibility", 11, 2026, "board"], board);
  client.setQueryData(["/api/casual-leaves", null, 11, 2026], []);
  client.setQueryData(["/api/casual-leaves/adjustments", 2026], log);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(CasualLeave))));
  return host;
}

const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ");
const q = (id: string) => document.body.querySelector(`[data-testid="${id}"]`);
const type = (el: Element | null, value: string) =>
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
const tab = (el: Element, name: string) =>
  [...el.querySelectorAll('[role="tab"]')].find((t) => text(t).trim().startsWith(name));
// lets the (mocked) loads, saves and the detection finish: a few rounds of the event loop (only Date is faked)
const settle = (rounds = 4) =>
  act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });

function openTab() {
  const el = mount();
  click(tab(el, "Carry Forward")!);
  return el;
}

describe("Carry Forward: the balances", () => {
  it("lists each staff member's fixed 12 with what is used and left, and keeps the tab in the address", () => {
    openTab();
    expect(q("tab-carry-forward")).not.toBeNull();
    expect(window.location.search).toBe("?tab=carry-forward");
    expect(text(q("cf-row-1"))).toContain("Asha Kumar");
    expect(text(q("cf-left-1"))).toBe("10 of 12");
    expect(text(q("cf-table"))).not.toContain("HR changes");
    expect(text(q("cf-row-4"))).toContain("Under 6 months");
    expect(q("cf-row-5")).toBeNull(); // production has no Casual Leave
    expect(text(q("cf-assign-1")).trim()).toBe("Assign CL");
  });
});

describe("Carry Forward: Deduct days", () => {
  it("offers only Deduct days, and waits for the number before detecting", () => {
    openTab();
    click(q("cf-assign-1"));
    const dialog = q("cf-dialog")!;
    expect(text(dialog)).toContain("Deduct days · Asha Kumar");
    expect(text(dialog)).not.toContain("Add days");
    expect(q("cf-direction-add")).toBeNull();
    expect(text(q("cf-meter"))).toContain("10 of 12 left");
    expect(text(q("cf-idle"))).toContain("marked Absent, On Leave or Half Day in November 2026");
    expect(h.fetch.mock.calls.some(([url]) => String(url).includes("absent-dates"))).toBe(false);
  });

  it("shows the detection at work while it looks through the month", async () => {
    DETECT_TIMING.minMs = 60_000; // hold the animation on screen
    openTab();
    click(q("cf-assign-1"));
    type(q("cf-days"), "3");
    await settle();
    expect(text(q("cf-detecting"))).toContain("Detecting attendance");
    expect(text(q("cf-detecting"))).toContain("Asha Kumar · November 2026");
    expect(text(q("cf-detecting"))).toContain("Finding the days marked On Leave");
    expect(q("cf-result-1")).toBeNull();
    expect((q("cf-month-prev") as HTMLButtonElement).disabled).toBe(true); // the month stays put while it works
    expect((q("cf-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("then says what it found and how to pick", async () => {
    openTab();
    click(q("cf-assign-1"));
    type(q("cf-days"), "3");
    await settle();
    expect(q("cf-detecting")).toBeNull();
    expect(text(q("cf-count-absent-1"))).toContain("4");
    expect(text(q("cf-count-leave-1"))).toContain("1");
    expect(text(q("cf-absent-1"))).toContain("These are the dates on which Asha Kumar was marked Absent");
    expect(text(q("cf-onleave-1"))).toContain("These are the dates on which Asha Kumar was marked On Leave");
    expect(text(q("cf-onleave-1"))).toContain("Fri 13 Nov · Sick Leave");
    expect(text(q("cf-count-half-1"))).toContain("1");
    expect(text(q("cf-halfday-1"))).toContain("These are the dates on which Asha Kumar was marked Half Day");
    expect(text(q("cf-halfday-1"))).toContain("Mon 16 Nov · worked the morning (09:00-12:30)");
    expect(text(q("cf-result-1"))).toContain(
      "Please select the dates you want to convert into Casual Leave (up to 3 days), then choose Full day or Half day for each.",
    );
    expect(text(q("cf-types-1"))).toContain("Tick dates above or in the calendar");
    expect(q("cf-cal-1-2026-11-05")).not.toBeNull();
    expect(q("cf-cal-1-2026-11-04")).toBeNull(); // a present day is shown but cannot be picked
  });

  it("only the picked dates are sent, and the number is only the most that may be picked", async () => {
    h.post.mockResolvedValueOnce({
      count: 1,
      days: 2,
      items: [{ ...round, id: 40, dates: ["2026-11-05", "2026-11-13"], balanceBefore: 10, balanceAfter: 8 }],
    });
    openTab();
    click(q("cf-assign-1"));
    type(q("cf-days"), "3");
    await settle();
    click(q("cf-date-1-2026-11-05")); // from the Absent list
    click(q("cf-cal-1-2026-11-13")); // the On Leave day, from the calendar
    expect(text(q("cf-picked-1"))).toBe("2 of 3 days picked");
    expect(q("cf-cal-1-2026-11-05")!.getAttribute("aria-pressed")).toBe("true"); // the list and the calendar agree
    expect(q("cf-type-1-2026-11-05")).not.toBeNull(); // each picked date has its leave type
    expect(q("cf-portion-1-2026-11-05-full")!.getAttribute("aria-checked")).toBe("true");
    expect(text(q("cf-preview"))).toContain("108 of 12 left");
    expect(text(q("cf-save"))).toBe("Assign CL to 2 dates");
    type(q("cf-reason"), "Absent days covered by unused CL");
    click(q("cf-save"));
    await settle();
    expect(h.post).toHaveBeenCalledWith("/api/casual-leaves/assign", {
      reason: "Absent days covered by unused CL",
      items: [
        {
          employeeId: 1,
          limit: 3,
          dates: [
            { date: "2026-11-05", portion: "full" },
            { date: "2026-11-13", portion: "full" },
          ],
        },
      ],
    });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Casual Leave assigned" }));
    expect(q("cf-dialog")).toBeNull();
  });

  it("stops at the number, lowers the picks with it, and never takes more than is left", async () => {
    openTab();
    click(q("cf-assign-1"));
    type(q("cf-days"), "2");
    await settle();
    click(q("cf-date-1-2026-11-05"));
    click(q("cf-date-1-2026-11-06"));
    expect(text(q("cf-picked-1"))).toBe("2 of 2 days picked");
    expect((q("cf-date-1-2026-11-10") as HTMLButtonElement).disabled).toBe(true);
    expect((q("cf-cal-1-2026-11-10") as HTMLButtonElement).disabled).toBe(true);
    type(q("cf-days"), "1");
    expect(text(q("cf-picked-1"))).toBe("1 of 1 day picked");
    expect(q("cf-date-1-2026-11-06")!.getAttribute("aria-pressed")).toBe("false");
    type(q("cf-days"), "11"); // Asha has 10 left
    expect(text(q("cf-line-error"))).toBe("Only 10 days left: enter 10 at most");
    type(q("cf-reason"), "Absent days covered");
    click(q("cf-save"));
    expect(h.post).not.toHaveBeenCalled();
  });

  it("a half day starts on its missed half; each date's leave type can be Full day or a half", async () => {
    h.post.mockResolvedValueOnce({ count: 1, days: 1, items: [{ ...round, id: 41 }] });
    openTab();
    click(q("cf-assign-1"));
    type(q("cf-days"), "1");
    await settle();
    click(q("cf-date-1-2026-11-16")); // the half day: the morning was worked
    expect(q("cf-portion-1-2026-11-16-second_half")!.getAttribute("aria-checked")).toBe("true");
    expect(q("cf-portion-1-2026-11-16-first_half")).toBeNull(); // the worked half is not offered
    expect(text(q("cf-type-1-2026-11-16"))).toContain(
      "The morning was worked: the second half covers the rest of the day.",
    );
    expect(text(q("cf-type-1-2026-11-16"))).toContain("14:00-18:00");
    expect(q("cf-cal-1-2026-11-16")!.getAttribute("data-portion")).toBe("second_half");
    expect(text(q("cf-picked-1"))).toBe("0.5 of 1 day picked");
    // half a day left in the number: an absent day starts as a half, and a full day for it does not fit
    click(q("cf-date-1-2026-11-05"));
    expect(q("cf-portion-1-2026-11-05-first_half")!.getAttribute("aria-checked")).toBe("true");
    expect((q("cf-portion-1-2026-11-05-full") as HTMLButtonElement).disabled).toBe(true);
    expect((q("cf-date-1-2026-11-06") as HTMLButtonElement).disabled).toBe(true); // nothing more fits
    click(q("cf-portion-1-2026-11-05-second_half"));
    expect(q("cf-cal-1-2026-11-05")!.getAttribute("data-portion")).toBe("second_half");
    expect(text(q("cf-preview"))).toContain("109 of 12 left");
    expect(text(q("cf-save"))).toBe("Assign CL to 2 dates (1 day)");
    // the X takes a date off again
    click(q("cf-untick-1-2026-11-05"));
    await settle();
    expect(q("cf-type-1-2026-11-05")).toBeNull();
    click(q("cf-date-1-2026-11-05"));
    type(q("cf-reason"), "Half days covered by unused CL");
    click(q("cf-save"));
    await settle();
    expect(h.post.mock.calls[0][1]).toEqual({
      reason: "Half days covered by unused CL",
      items: [
        {
          employeeId: 1,
          limit: 1,
          dates: [
            { date: "2026-11-05", portion: "first_half" },
            { date: "2026-11-16", portion: "second_half" },
          ],
        },
      ],
    });
  });

  it("a full day can be chosen for a half day when the number allows it", async () => {
    openTab();
    click(q("cf-assign-1"));
    type(q("cf-days"), "2");
    await settle();
    click(q("cf-cal-1-2026-11-16"));
    click(q("cf-portion-1-2026-11-16-full"));
    expect(q("cf-portion-1-2026-11-16-full")!.getAttribute("aria-checked")).toBe("true");
    expect(text(q("cf-picked-1"))).toBe("1 of 2 days picked");
    // a lower number keeps what still fits
    type(q("cf-days"), "0.5");
    await settle();
    expect(q("cf-type-1-2026-11-16")).toBeNull();
  });

  it("another month detects that month; a month with nothing says so", async () => {
    openTab();
    click(q("cf-assign-2"));
    type(q("cf-days"), "1");
    await settle();
    expect(q("cf-date-2-2026-11-06")).not.toBeNull();
    expect((q("cf-month-next") as HTMLButtonElement).disabled).toBe(true); // nothing after this month
    click(q("cf-month-prev"));
    await settle();
    expect(text(q("cf-month"))).toBe("October 2026");
    expect(text(q("cf-none-2"))).toContain("No absent, leave or half days in October 2026");
  });

  it("several ticked employees: one number for all, a section each to pick, all in one save", async () => {
    h.post.mockResolvedValueOnce({ count: 2, days: 2, items: [round, { ...round, id: 33, employeeId: 2 }] });
    openTab();
    click(q("cf-select-1"));
    click(q("cf-select-2"));
    expect(text(q("cf-selection"))).toContain("2 employees ticked");
    click(q("cf-assign-selected"));
    expect(text(q("cf-dialog"))).toContain("Deduct days · 2 employees");
    type(q("cf-days"), "1");
    await settle();
    expect(q("cf-lines")!.querySelectorAll(":scope > li")).toHaveLength(2);
    click(q("cf-date-1-2026-11-12")); // Asha's section is open first
    click(q("cf-line-toggle-2"));
    click(q("cf-date-2-2026-11-06"));
    type(q("cf-reason"), "Absent days covered by unused CL");
    expect(text(q("cf-save"))).toBe("Assign CL for 2 employees");
    click(q("cf-save"));
    await settle();
    expect(h.post.mock.calls[0][1]).toEqual({
      reason: "Absent days covered by unused CL",
      items: [
        { employeeId: 1, limit: 1, dates: [{ date: "2026-11-12", portion: "full" }] },
        { employeeId: 2, limit: 1, dates: [{ date: "2026-11-06", portion: "full" }] },
      ],
    });
    expect(q("cf-selection")).toBeNull(); // the ticks are cleared once saved
  });

  it("shows the server's refusal under the employee it is about, and keeps the form", async () => {
    h.post.mockRejectedValueOnce(
      Object.assign(new Error("400"), {
        data: {
          error: "Nothing was changed: 1 employee need a look.",
          problems: [{ employeeId: 2, employeeName: "Ravi Shankar", error: "This employee is not active." }],
        },
      }),
    );
    openTab();
    click(q("cf-select-1"));
    click(q("cf-select-2"));
    click(q("cf-assign-selected"));
    type(q("cf-days"), "1");
    await settle();
    click(q("cf-date-1-2026-11-05"));
    click(q("cf-line-toggle-2"));
    click(q("cf-date-2-2026-11-06"));
    type(q("cf-reason"), "Absent days covered");
    click(q("cf-save"));
    await settle();
    expect(text(q("cf-problem"))).toBe("Nothing was changed: 1 employee need a look.");
    expect(text(q("cf-line-2"))).toContain("This employee is not active.");
    expect((q("cf-reason") as HTMLTextAreaElement).value).toBe("Absent days covered");
  });
});

describe("Carry Forward: the change log", () => {
  it("lists every round with its dates, and nothing can be added or undone there", () => {
    const el = openTab();
    click(tab(el, "Change log")!);
    expect(text(q("cf-log-31"))).toContain("Asha Kumar");
    expect(text(q("cf-log-dates-31"))).toBe("Tue 20 OctThu 22 Oct");
    expect(text(q("cf-log-31"))).toContain("1210");
    expect(text(q("cf-log-31"))).toContain("Absent days covered by unused CL");
    expect(text(q("cf-log-summary"))).toContain("2 days given as Casual Leave to 1 employee in 1 round");
    expect(q("cf-log-31")!.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("another year", () => {
  it("can be read but not changed", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(CarryForwardTab, {
            board: board.employees,
            loading: false,
            failed: false,
            onRetry: () => {},
            branches: [],
            departments: [],
            year: 2025,
            month: 11,
            today: { year: 2026, month: 11 },
            onHistory: () => {},
          }),
        ),
      ),
    );
    expect(text(q("tab-carry-forward"))).toContain("only this year's (2026) Casual Leave can be given");
    expect((q("cf-assign-1") as HTMLButtonElement).disabled).toBe(true);
    expect((q("cf-history-1") as HTMLButtonElement).disabled).toBe(false);
  });
});
