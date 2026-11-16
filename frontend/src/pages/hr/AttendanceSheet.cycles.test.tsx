import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttendanceSheetParams, AttendanceSheetResponse } from "@/lib/api-client/custom-hooks";
import { ReportLogKindProvider } from "./report-log/kind";

// The Production Report Log's register by pay cycle (owner 2026-11-16: "weekly, biweekly, monthly like payroll"): Weekly /
// BiWeekly / Monthly in place of Day / Week / Month, asked by `payCycle` + a day inside the period (the server answers
// with that cycle's pay period and only its workers), the arrows step period by period from the period on screen, and
// the label opens the period that holds today. The staff register keeps Day / Week / Month and its plain date range.

const h = vi.hoisted(() => ({
  calls: [] as { params: AttendanceSheetParams; kind: string }[],
  answer: (params: AttendanceSheetParams): AttendanceSheetResponse | undefined => {
    void params;
    return undefined;
  },
}));

vi.mock("@/lib/api-client/custom-hooks", () => ({
  useAttendanceReportSheet: (params: AttendanceSheetParams, _enabled: boolean, kind = "staff") => {
    h.calls.push({ params, kind });
    return { data: h.answer(params), isLoading: false };
  },
  usePayrollSettings: () => ({ data: { companyName: "UK Textiles", companyLogo: null } }),
}));
vi.mock("@/lib/api-client", () => ({ useListDepartments: () => ({ data: [] }) }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { branchName: null } }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock("@/components/ui/AttendanceLoader", () => ({ AttendanceLoader: () => null }));
// the pill tabs as plain buttons, so a click picks a value
vi.mock("@/components/ui/pill-tabs", () => ({
  PillTabs: ({
    items,
    value,
    onChange,
  }: {
    items: { value: string; label: string }[];
    value: string;
    onChange: (v: string) => void;
  }) =>
    createElement(
      "div",
      null,
      items.map((i) =>
        createElement(
          "button",
          { key: i.value, "data-tab": i.value, "aria-pressed": i.value === value, onClick: () => onChange(i.value) },
          i.label,
        ),
      ),
    ),
}));

import { AttendanceSheetContent } from "./AttendanceSheet";

const PERIODS: Record<string, [string, string, number]> = {
  monthly: ["2026-10-26", "2026-11-22", 28],
  weekly: ["2026-11-16", "2026-11-22", 7],
  biweekly: ["2026-11-09", "2026-11-22", 14],
};

const COUNTS = { weekly: 2, biweekly: 112, monthly: 0 };

/** A server that answers the cycle's period holding `around` (fixed periods per cycle are enough here); "auto" is the
 *  cycle with the most workers. */
function periodFor(params: AttendanceSheetParams): AttendanceSheetResponse | undefined {
  if (!params.payCycle) return undefined;
  const cycle = params.payCycle === "auto" ? "biweekly" : params.payCycle;
  const days = PERIODS[cycle][2];
  const [start, end] =
    params.around && params.around < PERIODS[cycle][0] ? ["2026-09-28", "2026-10-25"] : PERIODS[cycle];
  return {
    dateFrom: start,
    dateTo: end,
    dates: [start, end],
    employees: [],
    strength: [0, 0],
    period: { cycle, label: cycle, days, periodStart: start, periodEnd: end, cycleCounts: COUNTS },
  };
}

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
const tab = (value: string) => document.body.querySelector<HTMLButtonElement>(`button[data-tab="${value}"]`)!;
const button = (label: string) => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const last = () => h.calls[h.calls.length - 1];

function mount(kind: "staff" | "production") {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(ReportLogKindProvider, { value: kind }, createElement(AttendanceSheetContent))));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T10:00:00"));
  h.calls.length = 0;
  h.answer = periodFor;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

describe("the production register by pay cycle", () => {
  it("offers Weekly / BiWeekly / Monthly with their workers, and opens the cycle with the most on today's period", () => {
    mount("production");
    expect(
      [...document.body.querySelectorAll("[data-testid=register-cycle-tabs] button")].map((b) => b.textContent),
    ).toEqual(["Weekly · 2", "BiWeekly · 112", "Monthly · 0"]);
    expect(h.calls[0]).toMatchObject({ kind: "production", params: { payCycle: "auto", around: "2026-11-16" } });
    expect(last().params.dateFrom).toBeUndefined();
    // the server chose BiWeekly: that tab is the chosen one
    expect(tab("biweekly").getAttribute("aria-pressed")).toBe("true");
    expect(text(q("register-range"))).toMatch(/9 Nov.*22 Nov, 2026/);
    expect(text(q("register-cycle-note"))).toContain("BiWeekly pay period · 14 days");
    expect(text(q("register-cycle-note"))).toContain("only workers on the BiWeekly cycle (0)");
  });

  it("keeps to the cycle the server chose once it moves", () => {
    mount("production");
    act(() => button("Next period").click());
    expect(last().params).toMatchObject({ payCycle: "biweekly", around: "2026-11-23" });
  });

  it("switches cycle keeping the day, and steps period by period from the period on screen", () => {
    mount("production");
    act(() => tab("weekly").click());
    expect(last().params).toMatchObject({ payCycle: "weekly", around: "2026-11-16" });
    expect(text(q("register-cycle-note"))).toContain("Weekly pay period · 7 days");
    act(() => button("Next period").click());
    expect(last().params.around).toBe("2026-11-23");
    act(() => tab("biweekly").click());
    act(() => button("Previous period").click());
    // the BiWeekly period on screen starts 9 Nov: the one before it holds 8 Nov
    expect(last().params).toMatchObject({ payCycle: "biweekly", around: "2026-11-08" });
    act(() => q("register-range")!.click());
    expect(last().params.around).toBe("2026-11-16");
  });

  it("keeps the arrows off until the server has said which period it is", () => {
    h.answer = () => undefined;
    mount("production");
    expect(button("Next period").disabled).toBe(true);
    expect(text(q("register-range"))).toBe("Loading the pay period…");
  });
});

describe("the staff register", () => {
  it("keeps Day / Week / Month and its plain month range", () => {
    h.answer = () => undefined;
    mount("staff");
    expect(q("register-cycle-tabs")).toBeNull();
    expect(tab("day").textContent).toBe("Day");
    expect(last()).toMatchObject({ kind: "staff", params: { dateFrom: "2026-11-01", dateTo: "2026-11-30" } });
    expect(last().params.payCycle).toBeUndefined();
    expect(q("register-cycle-note")).toBeNull();
  });
});
