import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { EmployeeShiftMonthlyStats } from "@/lib/api-client/custom-hooks";

// The shift stats dialog (Manage Shifts -> Assignments -> an employee) has a Daily Log: a day on which the employee used a
// compensation carries its chip and note in the Notes column, and a day made up by a relaxation says so instead of "½ Shift".

const stats = vi.hoisted(() => ({ data: null as unknown }));

vi.mock("@/lib/api-client/custom-hooks", () => ({
  useEmployeeShiftMonthlyStats: () => ({ data: stats.data, isLoading: false, isError: false }),
  usePayrollSettings: () => ({ data: { halfDayFirstHalfEndTime: "13:30", halfDaySecondHalfStartTime: "14:30" } }),
}));
vi.mock("@/components/ui/CircleLoader", () => ({ CircleLoader: () => null }));

import EmployeeShiftStatsDialog from "./EmployeeShiftStatsDialog";

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

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

type Log = EmployeeShiftMonthlyStats["dailyLogs"][number];

const log = (date: string, over: Partial<Log> = {}): Log => ({
  date,
  day: "Mon",
  status: "present",
  firstPunch: "09:00",
  lastPunch: "18:00",
  totalPunches: 2,
  shiftsCompleted: "1.00",
  isHalfShift: false,
  isLate: false,
  isEarlyOut: false,
  lateMorning: false,
  lateReturn: false,
  compensationKind: null,
  compensationMinutes: 0,
  compensationNote: null,
  ...over,
});

function open(dailyLogs: Log[]): HTMLElement {
  const data: EmployeeShiftMonthlyStats = {
    employeeId: 1,
    employeeCode: "E001",
    employeeName: "Asha Kumar",
    employmentType: "staff",
    month: 10,
    year: 2026,
    presentDays: dailyLogs.length,
    absentDays: 0,
    leaveDays: 0,
    halfShiftDays: 0,
    fullShiftDays: dailyLogs.length,
    totalEffectiveShifts: "4.50",
    lateMorningDays: 0,
    lateReturnDays: 0,
    totalLateCount: 0,
    summary: null,
    dailyLogs,
  };
  stats.data = data;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(EmployeeShiftStatsDialog, { employeeId: 1, employeeName: "Asha Kumar", onClose: () => {} }),
    ),
  );
  return document.body;
}

const rowOf = (el: HTMLElement, date: string) =>
  Array.from(el.querySelectorAll("tbody tr")).find((tr) => tr.querySelector("td")?.textContent?.startsWith(date))!;
const notesOf = (tr: Element) => tr.querySelectorAll("td")[5];

const LOGS = [
  log("2026-10-05", {
    compensationKind: "window_late_in",
    compensationNote: "Late-in of 10:30 announced for 5 Oct.",
  }),
  log("2026-10-06", {
    status: "half_shift",
    isHalfShift: true,
    shiftsCompleted: "0.50",
    firstPunch: null,
    lastPunch: null,
    totalPunches: 0,
    compensationKind: "relaxation",
    compensationNote: "0.5 shift relaxation applied.",
  }),
  log("2026-10-07", {
    status: "half_shift",
    isHalfShift: true,
    shiftsCompleted: "0.50",
    lastPunch: "12:30",
    firstPunch: "09:00",
  }),
  log("2026-10-08"),
];

describe("the shift stats Daily Log marks a day that used a compensation", () => {
  it("puts the chip and its note in the Notes column", () => {
    const el = open(LOGS);
    const notes = notesOf(rowOf(el, "2026-10-05"));
    expect(notes.querySelector('[data-testid="compensation-chip-window_late_in"]')?.textContent).toContain(
      "Announced late-in",
    );
    expect(notes.querySelector('[data-testid="compensation-note"]')?.textContent).toBe(
      "Late-in of 10:30 announced for 5 Oct.",
    );
    // an ordinary day keeps its tick
    expect(notesOf(rowOf(el, "2026-10-08")).textContent).toBe("✓");
  });

  it("a relaxation day says so instead of '½ Shift'", () => {
    const el = open(LOGS);
    const notes = notesOf(rowOf(el, "2026-10-06"));
    expect(notes.querySelector('[data-testid="compensation-chip-relaxation"]')).not.toBeNull();
    expect(notes.textContent).not.toContain("½ Shift");
    expect(notes.textContent).not.toContain("half only");
    // a real half day still says which half was worked
    expect(notesOf(rowOf(el, "2026-10-07")).textContent).toContain("Morning half only");
  });

  it("lists the kinds in view in a legend under the log", () => {
    const el = open(LOGS);
    const legend = el.querySelector('[data-testid="compensation-legend"]')!;
    expect(legend).not.toBeNull();
    expect(legend.querySelector('[data-testid="compensation-legend-window_late_in"]')?.textContent).toContain("×1");
    expect(legend.querySelector('[data-testid="compensation-legend-relaxation"]')?.textContent).toContain("×1");
  });

  it("has no legend when no day used a compensation", () => {
    const el = open([log("2026-10-05"), log("2026-10-06")]);
    expect(el.querySelector('[data-testid="compensation-legend"]')).toBeNull();
  });
});
