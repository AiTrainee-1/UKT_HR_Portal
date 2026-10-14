import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EmployeeMonthlyAttendance, FinalAttendanceDay } from "@/lib/api-client/custom-hooks";

// Employee Attendance Search (Staff Attendance page): a day on which the employee used a compensation carries its chip and
// note beside the status, a legend says which kinds the month holds, and a day made up by a relaxation does not claim that a
// Morning / Evening half was worked.

const month = vi.hoisted(() => ({ data: null as unknown }));

vi.mock("@/lib/api-client/custom-hooks", () => ({
  useEmployeeMonthlyAttendance: () => ({ data: month.data, isLoading: false, isError: false }),
  useAttendanceOverride: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAttendanceOverrideRequests: () => ({ data: [] }),
  usePayrollSettings: () => ({ data: { halfDayFirstHalfEndTime: "13:30", halfDaySecondHalfStartTime: "14:30" } }),
}));
vi.mock("@/lib/api-client", () => ({ useListEmployees: () => ({ data: [] }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock("@/components/ui/AttendanceLoader", () => ({ AttendanceLoader: () => null }));

import AttendanceSearchSection from "./AttendanceSearch";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const day = (date: string, over: Partial<FinalAttendanceDay> = {}): FinalAttendanceDay => ({
  date,
  day: "Mon",
  status: "present",
  isLate: false,
  isHalfShift: false,
  earlyLeave: false,
  shiftsEarned: "1.00",
  firstPunch: "09:00",
  lastPunch: "18:00",
  totalPunches: 2,
  source: "auto",
  compensationKind: null,
  compensationMinutes: 0,
  compensationNote: null,
  ...over,
});

const NOTE = "Arrived 09:47, inside the 30 min allowance.";

function monthWith(days: FinalAttendanceDay[]): EmployeeMonthlyAttendance {
  return {
    employee: { id: 1, code: "E001", name: "Asha Kumar", department: "Cutting", employmentType: "staff" },
    assignedShift: { name: "General", startTime: "09:00", endTime: "18:00", gracePeriodMinutes: 15 },
    month: 10,
    year: 2026,
    attendanceMode: "simple",
    weeks: [{ week: 1, days }],
    summary: {
      totalDays: days.length,
      workingDays: days.length,
      present: days.length,
      halfShift: 0,
      absent: 0,
      onLeave: 0,
      holidays: 0,
      late: 0,
      totalShifts: "4.50",
      effectiveDays: "4.50",
    },
  };
}

async function open(days: FinalAttendanceDay[]): Promise<HTMLElement> {
  month.data = monthWith(days);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(AttendanceSearchSection, { employmentType: "staff" })));
  // type a code and search it, so the month is shown
  const input = host.querySelector("input[placeholder^='Employee code']") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "E001");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  return host;
}

const rowOf = (el: HTMLElement, date: string) =>
  Array.from(el.querySelectorAll("tbody tr")).find((tr) => tr.querySelector("td")?.textContent === date)!;
const cells = (tr: Element) => Array.from(tr.querySelectorAll("td"));

const DAYS = [
  day("2026-10-05", {
    compensationKind: "ot_allowance",
    compensationMinutes: 30,
    compensationNote: NOTE,
  }),
  day("2026-10-06", { compensationKind: "birthday", compensationNote: "Birthday: paid leave." }),
  // an absent day made 0.50 by a relaxation: no punches
  day("2026-10-07", {
    status: "half_shift",
    isHalfShift: true,
    shiftsEarned: "0.50",
    firstPunch: null,
    lastPunch: null,
    totalPunches: 0,
    compensationKind: "relaxation",
    compensationNote: "0.5 shift relaxation applied.",
  }),
  // a real half day, worked in the morning
  day("2026-10-08", {
    status: "half_shift",
    isHalfShift: true,
    shiftsEarned: "0.50",
    firstPunch: "09:00",
    lastPunch: "12:30",
    arrivalZone: "on_time",
  }),
  day("2026-10-09"),
];

describe("Employee Attendance Search marks a day that used a compensation", () => {
  it("puts the chip and its note beside the day's status", async () => {
    const el = await open(DAYS);
    const status = cells(rowOf(el, "2026-10-05"))[2];
    const chip = status.querySelector('[data-testid="compensation-chip-ot_allowance"]')!;
    expect(chip.textContent).toContain("OT allowance used (30 min)");
    expect(status.querySelector('[data-testid="compensation-note"]')?.textContent).toBe(NOTE);
    expect(
      cells(rowOf(el, "2026-10-06"))[2].querySelector('[data-testid="compensation-chip-birthday"]'),
    ).not.toBeNull();
    // an ordinary day has none
    expect(cells(rowOf(el, "2026-10-09"))[2].querySelector('[data-testid^="compensation-chip-"]')).toBeNull();
  });

  it("does not mark an allowance-covered arrival as Late (the day is not flagged)", async () => {
    const el = await open(DAYS);
    const flags = cells(rowOf(el, "2026-10-05"))[6];
    expect(flags.textContent).toBe("—");
    expect(flags.querySelector('[data-testid="day-flag-late"]')).toBeNull();
  });

  it("says which kinds the month holds, with how many days of each", async () => {
    const el = await open(DAYS);
    const legend = el.querySelector('[data-testid="compensation-legend"]')!;
    expect(legend).not.toBeNull();
    expect(
      Array.from(legend.querySelectorAll('[data-testid^="compensation-legend-"]')).map((e) =>
        e.getAttribute("data-testid"),
      ),
    ).toEqual(["compensation-legend-ot_allowance", "compensation-legend-birthday", "compensation-legend-relaxation"]);
    expect(legend.querySelector('[data-testid="compensation-legend-relaxation"]')?.textContent).toContain("×1");
  });

  it("shows no legend for a month nobody used a compensation in", async () => {
    const el = await open([day("2026-10-05"), day("2026-10-06")]);
    expect(el.querySelector('[data-testid="compensation-legend"]')).toBeNull();
  });

  it("a relaxation day shows its chip and note, not a Half Day half", async () => {
    const el = await open(DAYS);
    const row = rowOf(el, "2026-10-07");
    const status = cells(row)[2];
    expect(status.textContent).toContain("Half Shift"); // the day's real credit is still 0.50
    expect(status.querySelector('[data-testid="compensation-chip-relaxation"]')?.textContent).toContain(
      "Relaxation (compensation day)",
    );
    expect(status.querySelector('[data-testid="compensation-note"]')?.textContent).toBe(
      "0.5 shift relaxation applied.",
    );
    // the Half column does not claim a Morning / Evening half was worked
    expect(cells(row)[7].textContent).toBe("—");
  });

  it("still says which half a real half day was worked", async () => {
    const el = await open(DAYS);
    expect(cells(rowOf(el, "2026-10-08"))[7].textContent).toContain("½");
    expect(cells(rowOf(el, "2026-10-08"))[7].textContent).toContain("Morning");
  });
});
