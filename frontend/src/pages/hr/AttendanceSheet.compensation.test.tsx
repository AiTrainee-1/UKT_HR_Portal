import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AttendanceSheetDayCell, AttendanceSheetResponse } from "@/lib/api-client/custom-hooks";

// The Attendance Sheet (Report Log -> Monthly Report) marks a day on which the employee used a compensation: a compact
// symbol in the cell, the chip and note in its tooltip / wide cell, a legend, a code in the Excel export, and a
// relaxation-only day keeps its Half Shift credit without the endpoint's default "afternoon" half.

const sheet = vi.hoisted(() => ({ data: null as unknown }));
const exported = vi.hoisted(() => ({
  cells: new Map<string, { value?: unknown; note?: string; font?: unknown; fill?: unknown }>(),
  saved: [] as string[],
  /** Whether the block the PDF is made from held the compensation legend at that moment (null: no PDF made). */
  pdfLegend: null as boolean | null,
}));

vi.mock("@/lib/api-client/custom-hooks", () => ({
  useAttendanceReportSheet: () => ({ data: sheet.data, isLoading: false }),
  usePayrollSettings: () => ({ data: { companyName: "UK Textiles", companyLogo: null } }),
}));
vi.mock("@/lib/api-client", () => ({ useListDepartments: () => ({ data: [] }) }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { branchName: null } }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock("@/components/ui/pill-tabs", () => ({ PillTabs: () => null }));
vi.mock("@/components/ui/AttendanceLoader", () => ({ AttendanceLoader: () => null }));
vi.mock("@/lib/exportUtils", () => {
  const cell = (r: number, c: number) => {
    const key = `${r}:${c}`;
    if (!exported.cells.has(key)) exported.cells.set(key, {});
    return exported.cells.get(key)!;
  };
  const sheetFake = {
    getColumn: () => ({ width: 0 }),
    getRow: (r: number) => ({ height: 0, getCell: (c: number) => cell(r, c) }),
    getCell: (r: number, c: number) => cell(r, c),
    views: [] as unknown[],
  };
  return {
    addTitleBlock: () => {},
    downloadWorkbook: async (_wb: unknown, name: string) => {
      exported.saved.push(name);
    },
    exportElementToFile: async (el: HTMLElement) => {
      exported.pdfLegend = el.querySelector('[data-testid="compensation-legend"]') !== null;
    },
    fileSafe: (s: string) => s,
    newWorkbook: () => ({ addWorksheet: () => sheetFake }),
    solidFill: (c: string) => ({ fill: c }),
    styleHeaderCell: () => {},
  };
});

import { AttendanceSheetContent } from "./AttendanceSheet";

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
  exported.cells.clear();
  exported.saved.length = 0;
  exported.pdfLegend = null;
});

const cell = (date: string, over: Partial<AttendanceSheetDayCell> = {}): AttendanceSheetDayCell => ({
  date,
  status: "present",
  isLate: false,
  isEarlyOut: false,
  isHalfShift: false,
  halfDayPeriod: null,
  firstPunch: "09:00",
  lastPunch: "18:00",
  shiftsEarned: "1.00",
  compensationKind: null,
  compensationMinutes: 0,
  compensationNote: null,
  ...over,
});

function response(days: AttendanceSheetDayCell[]): AttendanceSheetResponse {
  return {
    dateFrom: days[0].date,
    dateTo: days[days.length - 1].date,
    dates: days.map((d) => d.date),
    employees: [
      {
        employeeId: 1,
        employeeCode: "E001",
        employeeName: "Asha Kumar",
        department: "Cutting",
        designation: null,
        days,
        summary: {
          totalDays: days.length,
          workingDays: days.length,
          present: days.length,
          halfShift: 0,
          absent: 0,
          onLeave: 0,
          holidays: 0,
          late: 0,
          totalShifts: "5.00",
          effectiveDays: "5.00",
        },
      },
    ],
    strength: days.map(() => 1),
  };
}

const FIVE_KINDS: AttendanceSheetDayCell[] = [
  cell("2026-10-05", {
    compensationKind: "ot_allowance",
    compensationMinutes: 30,
    compensationNote: "Arrived 09:47, inside the 30 min allowance.",
  }),
  cell("2026-10-06", { compensationKind: "window_late_in", compensationNote: "Late-in of 10:30 announced." }),
  cell("2026-10-07", { compensationKind: "window_early_out", compensationNote: "Early-out of 15:00 announced." }),
  cell("2026-10-08", { compensationKind: "birthday", compensationNote: "Birthday: paid leave." }),
  // an absent day made 0.50 by a relaxation: no punches, and the endpoint's default half is "afternoon"
  cell("2026-10-09", {
    status: "half_shift",
    isHalfShift: true,
    halfDayPeriod: "afternoon",
    firstPunch: null,
    lastPunch: null,
    shiftsEarned: "0.50",
    compensationKind: "relaxation",
    compensationNote: "0.5 shift relaxation applied.",
  }),
  cell("2026-10-10"),
];

function mount(days: AttendanceSheetDayCell[]): HTMLElement {
  sheet.data = response(days);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(AttendanceSheetContent)));
  return host;
}

describe("the Attendance Sheet marks a day that used a compensation", () => {
  it("puts a symbol in the cell of each kind, and none in an ordinary day", () => {
    const el = mount(FIVE_KINDS);
    const symbols = Array.from(el.querySelectorAll("table [data-testid^='compensation-symbol-']"));
    expect(symbols.map((s) => s.textContent)).toEqual(["OT", "LI", "EO", "BD", "RX"]);
    // the cell has its own tooltip: the symbol keeps only the label a screen reader says
    expect(symbols[0].getAttribute("aria-label")).toBe(
      "OT allowance used (30 min): Arrived 09:47, inside the 30 min allowance.",
    );
    expect(symbols.every((s) => !s.hasAttribute("title"))).toBe(true);
  });

  it("lists the kinds in view in a legend, with how many days of each", () => {
    const el = mount(FIVE_KINDS);
    const legend = el.querySelector('[data-testid="compensation-legend"]')!;
    expect(legend).not.toBeNull();
    for (const kind of ["ot_allowance", "window_late_in", "window_early_out", "birthday", "relaxation"]) {
      expect(legend.querySelector(`[data-testid="compensation-legend-${kind}"]`)?.textContent, kind).toContain("×1");
    }
  });

  it("shows no legend when nobody used a compensation", () => {
    const el = mount([cell("2026-10-05"), cell("2026-10-06")]);
    expect(el.querySelector('[data-testid="compensation-legend"]')).toBeNull();
    expect(el.querySelector("[data-testid^='compensation-symbol-']")).toBeNull();
  });

  it("keeps a relaxation-only day as a plain Half Shift: no Morning / Evening half was worked", () => {
    const el = mount(FIVE_KINDS);
    const cells = Array.from(el.querySelectorAll("tbody tr td")).map((td) => (td.textContent ?? "").trim());
    // a real evening half would read "½E"; the relaxation day reads "½" and its symbol, never "½E"
    expect(cells.some((t) => t.startsWith("½RX"))).toBe(true);
    expect(cells.some((t) => t.includes("½E") || t.includes("½M"))).toBe(false);
  });

  it("still splits a real half day into Morning and Evening", () => {
    const el = mount([
      cell("2026-10-05", { status: "half_shift", isHalfShift: true, halfDayPeriod: "afternoon", firstPunch: "14:40" }),
      cell("2026-10-06", { status: "half_shift", isHalfShift: true, halfDayPeriod: "morning" }),
    ]);
    const cells = Array.from(el.querySelectorAll("tbody tr td")).map((td) => (td.textContent ?? "").trim());
    expect(cells).toContain("½E");
    expect(cells).toContain("½M");
  });

  it("a day view draws the full chip with its note in the wide cell", () => {
    const el = mount([FIVE_KINDS[0]]);
    const chip = el.querySelector("table [data-testid='compensation-chip-ot_allowance']")!;
    expect(chip.textContent).toContain("OT allowance used (30 min)");
    expect(el.querySelector("table [data-testid^='compensation-symbol-']")).toBeNull();
  });

  it("adds the short code and a cell note to the Excel export, and a legend row per kind", async () => {
    const el = mount(FIVE_KINDS);
    const button = Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Excel")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(exported.saved).toHaveLength(1);

    // the employee's row is the first after the header (row 5): day cells start at column 5
    const codes = [5, 6, 7, 8, 9, 10].map((i) => exported.cells.get(`6:${i}`)?.value);
    expect(codes).toEqual(["P·OT", "P·LI", "P·EO", "P·BD", "½·RX", "P"]);
    expect(exported.cells.get("6:5")?.note).toBe(
      "OT allowance used (30 min): Arrived 09:47, inside the 30 min allowance.",
    );
    expect(exported.cells.get("6:10")?.note).toBeUndefined();

    const legend = Array.from(exported.cells.values())
      .map((c) => c.value)
      .filter((v): v is string => typeof v === "string" && v.includes("(the day used a compensation)"));
    expect(legend).toEqual([
      "OT = OT allowance used (the day used a compensation)",
      "LI = Announced late-in (the day used a compensation)",
      "EO = Announced early-out (the day used a compensation)",
      "BD = Birthday leave (the day used a compensation)",
      "RX = Relaxation (compensation day) (the day used a compensation)",
    ]);
  });

  it("puts the legend into the picture the PDF is made from, and only while it is made", async () => {
    const el = mount(FIVE_KINDS);
    // on screen the legend sits with the other legend, above the grid: the grid block itself has none
    const gridBlock = el.querySelector("table")!.closest(".bg-white")!;
    expect(gridBlock.querySelector('[data-testid="compensation-legend"]')).toBeNull();
    const button = Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.trim() === "PDF")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      // the export waits one animation frame for the un-clamped table to paint
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(exported.pdfLegend).toBe(true);
    expect(gridBlock.querySelector('[data-testid="compensation-legend"]')).toBeNull();
  });

  it("leaves the Excel codes alone for a sheet with no compensation", async () => {
    const el = mount([cell("2026-10-05"), cell("2026-10-06", { isLate: true })]);
    const button = Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Excel")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect([5, 6].map((i) => exported.cells.get(`6:${i}`)?.value)).toEqual(["P", "P"]);
    expect(Array.from(exported.cells.values()).some((c) => c.note)).toBe(false);
  });
});
