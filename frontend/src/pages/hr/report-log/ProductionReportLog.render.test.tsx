import { act, createElement, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isRouteViewOnly } from "@/contexts/AuthContext";
import { useSetDayInformed } from "@/lib/api-client/custom-hooks";
import { moduleForPath } from "@/lib/permission-modules";
import ProductionReportLog from "../ProductionReportLog";
import AttendanceReportLog from "../AttendanceReportLog";
import { ReportLogKindProvider, useReportLogKind } from "./kind";
import LateTab from "./LateTab";
import LeaveTab from "./LeaveTab";
import { lateFileStem } from "./late";
import { lateExcelName } from "./late-excel";
import { latePdfName } from "./late-pdf";
import { leaveTitle, localToday } from "./logic";
import { leaveSpec } from "./sheets";

// The Production Report Log (owner 2026-11-16): the staff Report Log's page for production employees. Its title and mode
// badge, that every tab is told whose report it is, that its sub-tabs follow its own permission keys (and, unset, the staff
// Report Log's), that the daily lists ask the production addresses and say "production" in their words, and the titles of
// its downloads. (Whose rows the server returns: backend/api/tests_production_report_log.py.)

const h = vi.hoisted(() => ({
  user: { current: null as Record<string, unknown> | null },
  fetch: vi.fn(),
  settings: { current: {} as Record<string, unknown> },
  /** the category every department picker drawn asked for */
  deptCategories: [] as unknown[],
}));

vi.mock("@/lib/departments", async (original) => {
  const real = await original<typeof import("@/lib/departments")>();
  return {
    ...real,
    departmentOptions: (...args: Parameters<typeof real.departmentOptions>) => {
      h.deptCategories.push(args[1]?.category);
      return real.departmentOptions(...args);
    },
  };
});

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: h.user.current }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
vi.mock("@/lib/api-client/custom-hooks/payroll", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks/payroll")>()),
  usePayrollSettings: () => ({ data: h.settings.current, isLoading: false }),
}));
vi.mock("@/lib/api-client", async (original) => ({
  ...(await original<typeof import("@/lib/api-client")>()),
  useListDepartments: () => ({
    data: [
      { id: 1, name: "ADMIN", category: "staff" },
      { id: 2, name: "STITCHING", category: "production" },
    ],
  }),
}));
// the register and the staff late card stand in: each says whose report it was given
vi.mock("../AttendanceSheet", () => ({
  AttendanceSheetContent: function Stub() {
    return createElement("div", { "data-testid": "stub-monthly", "data-kind": useReportLogKind() });
  },
}));
vi.mock("./LatePenaltyCard", () => ({ default: () => createElement("div", { "data-testid": "stub-late-penalty" }) }));

const role = (permissions: Record<string, string>) => ({
  role: "hr",
  employeeId: null,
  isSuperAdmin: false,
  permissions,
});
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const labels = () =>
  [...document.body.querySelectorAll('[data-testid="report-log-tabs"] [role="tab"]')].map((t) =>
    (t.querySelector(".ptab-label")?.textContent ?? "").trim(),
  );
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: ReactNode, url = "/hr/attendance/production-report-log") {
  window.history.replaceState(null, "", url);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root!.render(createElement(QueryClientProvider, { client }, node)));
}

const ROW = {
  employeeId: 7,
  employeeCode: "P-7",
  employeeName: "Kavi Worker",
  department: "STITCHING",
  designation: "Tailor",
  firstPunch: "09:40",
  shiftStart: "09:00",
  graceMinutes: 15,
  lateDeadline: "09:15",
  minutesAfterStart: 40,
  minutesLate: 25,
  branchId: 1,
  branchName: "Unit One",
  unitLabel: "U-1",
  status: "present",
  isLate: true,
  lateAfternoon: false,
  permissionAfternoon: false,
  isCompensationDay: false,
  isInformed: null,
};
const ABSENT = {
  ...ROW,
  employeeId: 8,
  employeeCode: "P-8",
  employeeName: "Mani Worker",
  status: "absent",
  isLate: false,
};

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  h.user.current = role({ attendance: "edit" });
  h.settings.current = { attendanceMode: "strict", prodAttendanceMode: "simple", prodLateDetectionEnabled: false };
  h.fetch.mockReset();
  h.deptCategories.length = 0;
  h.fetch.mockImplementation((url: string) =>
    Promise.resolve(url.includes("day-informed") ? {} : { date: localToday(), rows: [ROW, ABSENT], count: 2 }),
  );
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
});

describe("the Production Report Log page", () => {
  it("is named for production, shows the production attendance mode, and hands every tab the production kind", () => {
    mount(createElement(ProductionReportLog));
    expect(text(q("report-log-title"))).toBe("Production Report Log");
    expect(q("report-log-page")?.dataset.kind).toBe("production");
    // the staff mode is strict, the production one simple: the badge is the production one
    expect(text(q("mode-badge"))).toBe("Simple Mode");
    expect(labels()).toEqual(["Monthly Report", "Daily Leave Report", "Daily Late Report"]);
    expect(q("stub-monthly")?.dataset.kind).toBe("production");
    // no staff late-penalty card: where production late deductions are, instead
    expect(q("stub-late-penalty")).toBeNull();
    expect(text(q("production-late-note-text"))).toContain("Production Late Detection is off");
  });

  it("points at the three production payroll pages while Production Late Detection is on", () => {
    h.settings.current = { ...h.settings.current, prodLateDetectionEnabled: true };
    mount(createElement(ProductionReportLog));
    expect(text(q("production-late-note-text"))).toContain("worked out per pay period");
    expect(q("production-late-note-weekly")?.getAttribute("href")).toBe("/hr/production-payroll/weekly");
    expect(q("production-late-note-monthly")?.getAttribute("href")).toBe("/hr/production-payroll/monthly");
  });

  it("leaves the staff Report Log as it was", () => {
    mount(createElement(AttendanceReportLog), "/hr/attendance/report-log");
    expect(text(q("report-log-title"))).toBe("Report Log");
    expect(text(q("mode-badge"))).toBe("Strict Mode");
    expect(q("stub-monthly")?.dataset.kind).toBe("staff");
    expect(q("stub-late-penalty")).not.toBeNull();
    expect(q("production-late-note")).toBeNull();
  });
});

describe("its sub-tabs and the role's keys", () => {
  it("follow the staff Report Log page while its own page key is unset", async () => {
    // the staff page view only: every production tab is locked too
    h.user.current = role({ attendance: "edit", "attendance.report_log": "view" });
    mount(createElement(ProductionReportLog), "/hr/attendance/production-report-log?tab=late");
    await settle();
    expect(labels()).toEqual(["Monthly Report", "Daily Leave Report", "Daily Late Report"]);
    // the page as a whole is View only (the portal's route lock, which HrLayout draws, decides that)
    const path = "/hr/attendance/production-report-log";
    expect(moduleForPath(path)).toBe("attendance.production_report_log");
    expect(isRouteViewOnly(h.user.current as never, path, moduleForPath(path))).toBe(true);
  });

  it("follow its own page key once set", () => {
    h.user.current = role({
      attendance: "edit",
      "attendance.report_log": "hidden",
      "attendance.production_report_log": "edit",
      "attendance.production_report_log.late": "hidden",
    });
    mount(createElement(ProductionReportLog));
    expect(labels()).toEqual(["Monthly Report", "Daily Leave Report"]);
  });

  it("follow its own keys once set, leaving the staff page alone", () => {
    h.user.current = role({ attendance: "edit", "attendance.production_report_log.monthly": "hidden" });
    mount(createElement(ProductionReportLog), "/hr/attendance/production-report-log?tab=monthly");
    expect(labels()).toEqual(["Daily Leave Report", "Daily Late Report"]);
    expect(q("stub-monthly")).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    mount(createElement(AttendanceReportLog), "/hr/attendance/report-log");
    expect(labels()).toEqual(["Monthly Report", "Daily Leave Report", "Daily Late Report"]);
  });
});

describe("the daily lists of production employees", () => {
  const inProduction = (node: ReactNode) => createElement(ReportLogKindProvider, { value: "production" }, node);
  const filters = { date: "2026-11-16", department: "all", search: "" };

  it("the late list asks the production address and speaks of production employees", async () => {
    mount(inProduction(createElement(LateTab, { filters, onFilters: () => {} })));
    await settle();
    expect(h.fetch.mock.calls[0][0]).toBe("/api/attendance/production-report-log?date=2026-11-16");
    expect(text(q("figure-checked"))).toContain("Production employees checked");
    expect(text(q("late-note"))).toContain("Production employees only: staff are not part of this report");
    expect(text(q("late-note"))).toContain("the same one Production Attendance shows");
    // the department picker is asked for production departments only (its list is drawn when it opens)
    expect(h.deptCategories).toContain("production");
    expect(h.deptCategories).not.toContain("staff");
  });

  it("the leave list asks the production address and its Informed call goes to the production one", async () => {
    mount(inProduction(createElement(LeaveTab, { filters, onFilters: () => {} })));
    await settle();
    expect(h.fetch.mock.calls[0][0]).toBe("/api/attendance/production-report-log?date=2026-11-16");
    expect(text(q("figure-absent"))).toContain("Production employees with no punch and no leave");

    act(() => root?.unmount());
    host?.remove();
    h.fetch.mockClear();
    function Mark() {
      const informed = useSetDayInformed("production");
      useEffect(() => {
        informed.mutate({ employeeId: 8, date: "2026-11-16", isInformed: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return null;
    }
    mount(createElement(Mark));
    await settle();
    expect(h.fetch.mock.calls[0][0]).toBe("/api/attendance/production-report-log/day-informed");
    expect(h.fetch.mock.calls[0][1]).toMatchObject({ method: "PATCH" });
  });
});

describe("the titles of its downloads", () => {
  it("say PRODUCTION / Production where the staff ones say STAFF / nothing", () => {
    expect(leaveTitle("2026-11-16")).toBe("16.11.2026 STAFF LEAVE LIST");
    expect(leaveTitle("2026-11-16", "PRODUCTION")).toBe("16.11.2026 PRODUCTION LEAVE LIST");
    expect(leaveSpec("2026-11-16", [], "PRODUCTION").title).toBe("16.11.2026 PRODUCTION LEAVE LIST");
    expect(lateFileStem("2026-11-16")).toBe("Daily_Late_Report_2026-11-16");
    expect(lateFileStem("2026-11-16", "Production Daily Late Report")).toBe("Production_Daily_Late_Report_2026-11-16");
    expect(lateExcelName("2026-11-16", "Production Daily Late Report")).toBe(
      "Production_Daily_Late_Report_2026-11-16.xlsx",
    );
    expect(latePdfName("2026-11-16", "Production Daily Late Report")).toBe(
      "Production_Daily_Late_Report_2026-11-16.pdf",
    );
  });
});
