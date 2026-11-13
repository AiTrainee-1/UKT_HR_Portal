import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import AttendanceReportLog from "../AttendanceReportLog";

// The Report Log's three sub-tabs against the role's own keys (Account Management -> Roles & Permissions): only the ones the
// role may see are offered, a hidden one asked for by the address opens the first it may see (and is never drawn), one it may
// only view is locked, and a role that may see none is told so. The tabs' contents are stand-ins here.

const h = vi.hoisted(() => ({ user: { current: null as Record<string, unknown> | null } }));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: h.user.current }),
}));
vi.mock("@/lib/api-client/custom-hooks", () => ({
  usePayrollSettings: () => ({ data: { attendanceMode: "strict" } }),
}));
vi.mock("../AttendanceSheet", () => ({
  AttendanceSheetContent: () => createElement("div", { "data-testid": "stub-monthly" }),
}));
vi.mock("./LatePenaltyCard", () => ({ default: () => null }));
vi.mock("./LeaveTab", () => ({
  default: () => createElement("button", { "data-testid": "stub-leave" }, "Save the leave list"),
}));
vi.mock("./LateTab", () => ({ default: () => createElement("div", { "data-testid": "stub-late" }) }));

const role = (permissions: Record<string, string>) => ({
  role: "hr",
  employeeId: null,
  isSuperAdmin: false,
  permissions,
});
const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const labels = () =>
  [...document.body.querySelectorAll('[data-testid="report-log-tabs"] [role="tab"]')].map((t) =>
    (t.querySelector(".ptab-label")?.textContent ?? "").trim(),
  );

let root: Root | null = null;
let host: HTMLElement | null = null;

function open(url: string) {
  window.history.replaceState(null, "", url);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(AttendanceReportLog)));
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  h.user.current = null;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
});

describe("Report Log: the sub-tabs a role may see", () => {
  it("offers all three to a role that set nothing on them", () => {
    h.user.current = role({ attendance: "edit" });
    open("/hr/attendance/report-log?tab=late");
    expect(labels()).toEqual(["Monthly Report", "Daily Leave Report", "Daily Late Report"]);
    expect(q("stub-late")).not.toBeNull();
  });

  it("opens the first one it may see when the address asks for a hidden one, and never draws the hidden one", () => {
    h.user.current = role({ attendance: "edit", "attendance.report_log.monthly": "hidden" });
    open("/hr/attendance/report-log");
    expect(labels()).toEqual(["Daily Leave Report", "Daily Late Report"]);
    expect(q("stub-monthly")).toBeNull();
    expect(q("stub-leave")).not.toBeNull();
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("leave");
  });

  it("locks a tab it may only view on a page it may edit, and says so", async () => {
    h.user.current = role({ attendance: "edit", "attendance.report_log.leave": "view" });
    open("/hr/attendance/report-log?tab=leave");
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    expect(q("tab-view-only")).not.toBeNull();
    expect((q("stub-leave") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says so when none of them is open to it", () => {
    h.user.current = role({
      attendance: "edit",
      "attendance.report_log.monthly": "hidden",
      "attendance.report_log.leave": "hidden",
      "attendance.report_log.late": "hidden",
    });
    open("/hr/attendance/report-log");
    expect(q("nothing-open")?.textContent).toBe("Nothing on this page is open to your role.");
    expect(q("report-log-tabs")).toBeNull();
    expect(q("stub-monthly")).toBeNull();
  });
});
