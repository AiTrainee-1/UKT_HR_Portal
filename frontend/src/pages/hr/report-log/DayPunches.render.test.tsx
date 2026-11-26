import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttendanceSheetResponse, ReportLogDayPunches } from "@/lib/api-client/custom-hooks";
import { AttendanceSheetContent } from "../AttendanceSheet";
import { ReportLogKindProvider } from "./kind";

// The register's day card (owner 2026-11-16): a single click on a day (not a hover) opens it, and it lists every punch
// the employee made that day, how many, each time (IN / OUT by order, where it came from, a night shift's
// after-midnight punch marked), asked from the register's own address when the card opens.

const h = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
vi.mock("@/lib/api-client/custom-hooks/payroll", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks/payroll")>()),
  usePayrollSettings: () => ({ data: { companyName: "UK Textiles", companyLogo: null } }),
}));
vi.mock("@/lib/api-client", async (original) => ({
  ...(await original<typeof import("@/lib/api-client")>()),
  useListDepartments: () => ({ data: [] }),
}));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: { branchName: null } }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock("@/components/ui/AttendanceLoader", () => ({ AttendanceLoader: () => null }));

const DAY = "2026-10-26";

const SHEET: AttendanceSheetResponse = {
  dateFrom: DAY,
  dateTo: DAY,
  dates: [DAY, "2026-10-27"],
  employees: [
    {
      employeeId: 7,
      employeeCode: "E007",
      employeeName: "Asha Kumar",
      department: "Cutting",
      designation: null,
      days: [
        { date: DAY, status: "present", isLate: true, firstPunch: "08:30", lastPunch: "22:32", shiftsEarned: "2.01" },
        { date: "2026-10-27", status: "absent", firstPunch: null, lastPunch: null, shiftsEarned: "0.00" },
      ],
      summary: {
        totalDays: 2,
        workingDays: 2,
        present: 1,
        halfShift: 0,
        absent: 1,
        onLeave: 0,
        holidays: 0,
        late: 1,
        totalShifts: "2.01",
        effectiveDays: "2.01",
      },
    },
  ],
  strength: [1, 0],
};

const PUNCHES: ReportLogDayPunches = {
  employeeId: 7,
  employeeCode: "E007",
  employeeName: "Asha Kumar",
  date: DAY,
  count: 5,
  punches: [
    { time: "08:30:12", type: "IN", source: "device", sourceLabel: "Biometric" },
    { time: "13:01:00", type: "OUT", source: "device", sourceLabel: "Biometric" },
    { time: "13:44:00", type: "IN", source: "mobile", sourceLabel: "Mobile app" },
    { time: "22:32:00", type: "OUT", source: "device", sourceLabel: "Biometric" },
    { time: "01:05:00", type: "IN", source: "device", sourceLabel: "Biometric", nextDay: true },
  ],
  shift: { name: "General", source: "shift", start: "09:00", end: "18:00", endNextDay: false, graceMinutes: 15 },
  earned: {
    method: "staff",
    steps: [
      { label: "Full day", shifts: "1.00", kind: "base" },
      { label: "Arrived after the Late window (quarter shift)", shifts: "-0.25", kind: "minus" },
    ],
    total: "0.75",
    note: null,
  },
  detections: [
    { key: "late", label: "Late", detail: "Late morning: arrived 09:40, deadline 09:15", tone: "bad" },
    { key: "ot", label: "Worked past the shift end", detail: "45 min", tone: "info" },
  ],
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
const punchCalls = () => h.fetch.mock.calls.map((c) => c[0] as string).filter((u) => u.includes("day-punches"));

function mount(kind: "staff" | "production" = "staff") {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree: ReactNode = createElement(
    QueryClientProvider,
    { client },
    createElement(ReportLogKindProvider, { value: kind }, createElement(AttendanceSheetContent)),
  );
  act(() => root!.render(tree));
}

beforeEach(() => {
  h.fetch.mockReset();
  h.fetch.mockImplementation((url: string) => Promise.resolve(url.includes("day-punches") ? PUNCHES : SHEET));
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
});

describe("the register's day card", () => {
  it("opens on a click, not on a hover, and asks for nothing until then", async () => {
    mount();
    await settle();
    const cell = q(`day-cell-7-${DAY}`)!;
    expect(cell.tagName).toBe("BUTTON");
    expect(cell.getAttribute("aria-label")).toContain("Asha Kumar");
    act(() => {
      cell.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      cell.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await settle();
    expect(q("day-card")).toBeNull();
    expect(punchCalls()).toEqual([]);

    act(() => cell.click());
    await settle();
    expect(q("day-card")).not.toBeNull();
    expect(text(q("day-card"))).toContain("Present");
    expect(text(q("day-card-head"))).toContain("In 08:30 · Out 22:32");
  });

  it("lists every punch of the day with how many, in order, IN / OUT, the source and the after-midnight one", async () => {
    mount();
    await settle();
    act(() => q(`day-cell-7-${DAY}`)!.click());
    await settle();
    expect(punchCalls()).toEqual([`/api/attendance/report-log/day-punches?employeeId=7&date=${DAY}`]);
    expect(text(q("day-punches-count"))).toBe("5 punches");
    const rows = [...document.body.querySelectorAll('[data-testid^="day-punch-"]')]
      .filter((el) => /^day-punch-\d+$/.test(el.getAttribute("data-testid") ?? ""))
      .map((el) => [...el.children].map((part) => text(part)).join(" "));
    expect(rows).toEqual([
      "1 IN 08:30:12 Biometric",
      "2 OUT 13:01 Biometric",
      "3 IN 13:44 Mobile app",
      "4 OUT 22:32 Biometric",
      "5 IN 01:05 next day Biometric",
    ]);
  });

  it("says so when the day has no punch, and closes on Escape", async () => {
    h.fetch.mockImplementation((url: string) =>
      Promise.resolve(url.includes("day-punches") ? { ...PUNCHES, date: "2026-10-27", count: 0, punches: [] } : SHEET),
    );
    mount();
    await settle();
    act(() => q("day-cell-7-2026-10-27")!.click());
    await settle();
    expect(text(q("day-punches-count"))).toBe("0 punches");
    expect(text(q("day-punches-empty"))).toBe("No punch was recorded on this day.");
    act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(q("day-card")).toBeNull();
  });

  it("counts a night shift's after-midnight last punch into the duration", async () => {
    const night = structuredClone(SHEET);
    Object.assign(night.employees[0].days[0], { firstPunch: "03:00", lastPunch: "05:31" });
    h.fetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("day-punches")
          ? {
              ...PUNCHES,
              count: 2,
              punches: [
                { time: "03:00:39", type: "IN", source: "device", sourceLabel: "Biometric" },
                { time: "05:31:43", type: "OUT", source: "device", sourceLabel: "Biometric", nextDay: true },
              ],
            }
          : night,
      ),
    );
    mount("production");
    await settle();
    act(() => q(`day-cell-7-${DAY}`)!.click());
    await settle();
    expect(text(q("day-card-head"))).toContain("Duration 26h 31m");
  });

  it("shows the detected shift, the earned-shift breakdown and the detections beside the punches", async () => {
    mount();
    await settle();
    act(() => q(`day-cell-7-${DAY}`)!.click());
    await settle();
    expect([...q("day-shift")!.children].map((p) => text(p))).toEqual(["General", "09:00 – 18:00 · 15 min grace"]);
    const steps = [...q("day-earned-steps")!.querySelectorAll("li")].map((li) =>
      [...li.children].map((part) => text(part)).join(" | "),
    );
    expect(steps).toEqual(["Full day | 1.00", "Arrived after the Late window (quarter shift) | -0.25"]);
    expect([...q("day-earned-total")!.children].map((p) => text(p))).toEqual(["Shift credit", "0.75"]);
    expect([...q("day-detection-late")!.children].map((p) => text(p))).toEqual([
      "Late",
      "Late morning: arrived 09:40, deadline 09:15",
    ]);
    expect(text(q("day-detection-ot"))).toContain("45 min");
    // the breakdown sits before (left of) the punches in the card
    const body = q("day-card-body")!;
    const order = [...body.querySelectorAll('[data-testid="day-earned"], [data-testid="day-punches"]')].map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(order).toEqual(["day-earned", "day-punches"]);
  });

  it("shows a day still running as In progress: the first punch, no verdict, the credit not decided yet", async () => {
    const until = "2026-10-26T18:16:00+05:30";
    const running = { inProgress: true, provisionalUntil: until };
    h.fetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("day-punches")
          ? { ...PUNCHES, ...running }
          : {
              ...SHEET,
              employees: SHEET.employees.map((e) => ({
                ...e,
                days: e.days.map((d) => (d.date === DAY ? { ...d, ...running } : d)),
              })),
            },
      ),
    );
    mount();
    await settle();
    const cell = q(`day-cell-7-${DAY}`)!;
    expect(text(cell)).toContain("…");
    expect(text(cell)).not.toContain("P");
    expect(cell.getAttribute("aria-label")).toContain("In progress (Counted after the shift ends at 18:16)");
    act(() => cell.click());
    await settle();
    expect(text(q("day-card"))).toContain("In progress");
    expect(text(q("day-card"))).not.toContain("Present");
    expect(text(q("day-card-in-progress"))).toBe("In 08:30 · at work · Counted after the shift ends at 18:16");
    expect(text(q("day-card-head"))).not.toContain("Duration");
    const total = q("day-earned-total")!;
    expect(q("day-earned-in-progress")).not.toBeNull();
    expect(text(total)).toContain("—");
    expect(text(total)).not.toContain("0.75");
  });

  it("asks the production address on the Production Report Log", async () => {
    mount("production");
    await settle();
    act(() => q(`day-cell-7-${DAY}`)!.click());
    await settle();
    expect(punchCalls()).toEqual([`/api/attendance/production-report-log/day-punches?employeeId=7&date=${DAY}`]);
  });
});
