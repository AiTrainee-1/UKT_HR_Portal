import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AttendanceSearchDay, AttendanceSearchRangeResponse } from "@/lib/api-client/custom-hooks";

// Attendance Search (punches, any range): a day on which the employee used a compensation has its chip beside the status,
// the engine's sentence among the day's notes, a symbol on its calendar cell and a legend under the calendar.

const search = vi.hoisted(() => ({ range: null as unknown }));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/lib/api-client/custom-hooks", () => ({
  useAttendanceSearch: () => ({
    data: {
      date: "2026-10-12",
      query: "asha",
      count: 1,
      results: [
        {
          employeeId: 1,
          employeeCode: "E001",
          employeeName: "Asha Kumar",
          department: "Cutting",
          designation: null,
          shift: null,
          punches: [],
          totalPunches: 0,
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useAttendanceSearchRange: () => ({ data: search.range, isLoading: false, isError: false }),
  usePayrollSettings: () => ({ data: { halfDayFirstHalfEndTime: "13:30", halfDaySecondHalfStartTime: "14:30" } }),
}));
vi.mock("@/components/ui/pill-tabs", () => ({ PillTabs: () => null }));

import AttendancePunchSearch from "./AttendancePunchSearch";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const punch = (time: string, type: "IN" | "OUT" = "IN") => ({
  time,
  type,
  source: "biometric",
  sourceLabel: "Biometric",
});

const day = (date: string, over: Partial<AttendanceSearchDay> = {}): AttendanceSearchDay => ({
  date,
  status: "present",
  isLate: false,
  isHalfShift: false,
  totalPunches: 2,
  punches: [punch("09:00"), null, null, punch("18:00", "OUT")],
  casualLeave: null,
  leave: null,
  permission: null,
  compensationKind: null,
  compensationMinutes: 0,
  compensationNote: null,
  ...over,
});

const NOTE = "Arrived 09:47, inside the 30 min allowance earned by working until 20:10 on 4 Oct.";

const DAYS: AttendanceSearchDay[] = [
  day("2026-10-05", {
    punches: [punch("09:47"), null, null, punch("18:00", "OUT")],
    compensationKind: "ot_allowance",
    compensationMinutes: 30,
    compensationNote: NOTE,
  }),
  day("2026-10-06", { compensationKind: "birthday", compensationNote: "Birthday: paid compensation leave." }),
  // an absent day made 0.50 by a relaxation: no punches at all
  day("2026-10-07", {
    status: "half_shift",
    isHalfShift: true,
    totalPunches: 0,
    punches: [],
    compensationKind: "relaxation",
    compensationNote: "0.5 shift relaxation applied.",
  }),
  day("2026-10-08"),
];

function range(days: AttendanceSearchDay[]): AttendanceSearchRangeResponse {
  return {
    employeeId: 1,
    employeeCode: "E001",
    employeeName: "Asha Kumar",
    department: "Cutting",
    designation: null,
    shift: null,
    startDate: days[0].date,
    endDate: days[days.length - 1].date,
    days,
  };
}

async function open(days: AttendanceSearchDay[]): Promise<HTMLElement> {
  search.range = range(days);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(TooltipProvider, null, createElement(AttendancePunchSearch))));
  const input = host.querySelector('[data-testid="attendance-search-input"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "asha");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // the page waits a moment after typing before it looks the person up
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  return host;
}

const rowOf = (el: HTMLElement, date: string) => el.querySelector(`#day-${date}`)!;

describe("Attendance Search marks a day that used a compensation", () => {
  it("puts the chip beside the status of the day, and the engine's sentence among its notes", async () => {
    const el = await open(DAYS);
    const row = rowOf(el, "2026-10-05");
    expect(row.querySelector('[data-testid="compensation-chip-ot_allowance"]')?.textContent).toContain(
      "OT allowance used (30 min)",
    );
    expect(row.textContent).toContain(`Compensation: ${NOTE}`);
    // a day on which the allowance covered the arrival is not flagged Late
    expect(row.querySelector('[data-testid="day-flag-late"]')).toBeNull();
    expect(rowOf(el, "2026-10-06").querySelector('[data-testid="compensation-chip-birthday"]')).not.toBeNull();
    expect(rowOf(el, "2026-10-08").querySelector('[data-testid^="compensation-chip-"]')).toBeNull();
  });

  it("a relaxation day shows the chip and its note instead of a Half Day half", async () => {
    const el = await open(DAYS);
    const row = rowOf(el, "2026-10-07");
    expect(row.querySelector('[data-testid="compensation-chip-relaxation"]')?.textContent).toContain(
      "Relaxation (compensation day)",
    );
    expect(row.textContent).toContain("Compensation: 0.5 shift relaxation applied.");
    expect(row.textContent).toContain("No punches recorded");
    expect(row.querySelector('[data-testid="day-flag-halfDay"]')).toBeNull();
    expect(row.textContent).not.toContain("half only");
  });

  it("puts a symbol on the calendar cell and says it to a screen reader, without adding a second button", async () => {
    const el = await open(DAYS);
    const summary = el.querySelector('[data-testid="attendance-summary"]')!;
    const buttons = Array.from(summary.querySelectorAll("button"));
    expect(buttons).toHaveLength(4); // one per day, nothing else
    const ot = buttons[0];
    expect(ot.getAttribute("aria-label")).toContain(`OT allowance used (30 min): ${NOTE}`);
    expect(ot.querySelector('[data-testid="compensation-symbol-ot_allowance"]')?.textContent).toBe("OT");
    expect(buttons[1].querySelector('[data-testid="compensation-symbol-birthday"]')?.textContent).toBe("BD");
    expect(buttons[3].querySelector('[data-testid^="compensation-symbol-"]')).toBeNull();
  });

  it("explains the symbols in a legend under the calendar, for the kinds the period holds", async () => {
    const el = await open(DAYS);
    const legend = el.querySelector('[data-testid="attendance-summary"] [data-testid="compensation-legend"]')!;
    expect(
      Array.from(legend.querySelectorAll('[data-testid^="compensation-legend-"]')).map((e) =>
        e.getAttribute("data-testid"),
      ),
    ).toEqual(["compensation-legend-ot_allowance", "compensation-legend-birthday", "compensation-legend-relaxation"]);
  });

  it("has no legend and no symbols for a period with no compensation", async () => {
    const el = await open([day("2026-10-05"), day("2026-10-06")]);
    expect(el.querySelector('[data-testid="compensation-legend"]')).toBeNull();
    expect(el.querySelector('[data-testid^="compensation-symbol-"]')).toBeNull();
  });
});
