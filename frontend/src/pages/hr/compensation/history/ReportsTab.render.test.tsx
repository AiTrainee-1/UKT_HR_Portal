import type { ReactNode } from "react";
import type ExcelJS from "exceljs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyReport, reportOf } from "../fixtures";
import {
  click,
  freezeClock,
  here,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  params,
  pickOption,
  press,
  q,
  settle,
  tab,
  text,
  unmountPage,
  waitFor,
  type World,
} from "../harness";

// The Reports page in jsdom: the totals, who benefited from each type at a glance (a card opens that type's History subtab),
// the filters (Today / Week / Month, a date, type, department, branch), the Excel workbook (a Summary sheet and a sheet per
// type) and the CSV of every section, and the loaders, empty states and errors. No per-type row tables here.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  csv: vi.fn(),
  download: vi.fn(),
  user: { current: null as { branchId?: number | null } | null },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "t", user: h.user.current }) }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
vi.mock("@/components/payroll/kit/export-table", async (original) => ({
  ...(await original<typeof import("@/components/payroll/kit/export-table")>()),
  exportTableToCsv: h.csv,
}));
vi.mock("@/lib/exportUtils", async (original) => ({
  ...(await original<typeof import("@/lib/exportUtils")>()),
  downloadWorkbook: h.download,
}));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  freezeClock();
  h.user.current = null;
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
  vi.useRealTimers();
});

const REPORTS = "/hr/compensation/reports";
const TYPES = [
  "ot_allowance",
  "ot_shift_relaxation",
  "ot_shift_pay",
  "window_late_in",
  "window_early_out",
  "holiday_work",
  "birthday",
];

async function openReports(url = REPORTS) {
  mountPage(url);
  await waitFor(() => !!q("reports-kpis"), "the report");
}

const all = (prefix: string) => [...document.body.querySelectorAll(`[data-testid^="${prefix}"]`)];
const reportRequests = () => world.requests().filter((r) => r.startsWith("/api/compensation/reports"));
const lastRequest = () => new URLSearchParams(reportRequests().at(-1)!.split("?")[1]);
const overviewTypes = () => all("overview-").map((e) => e.getAttribute("data-testid")!.slice("overview-".length));

describe("the totals", () => {
  it("opens on today, asks the server for every type, and says what the period is", async () => {
    await openReports();
    expect(reportRequests()).toEqual(["/api/compensation/reports?period=today&date=2026-10-14"]);
    expect(text(q("reports-kpi-period"))).toContain("14 Oct 2026");
    expect(text(q("reports-kpi-period"))).toContain("One day");
    expect(tab("Today").getAttribute("aria-selected")).toBe("true");
    expect(text(q("reports-kpi-employees-value"))).toBe("6");
    expect(text(q("reports-kpi-records-value"))).toBe("7");
    expect(text(q("reports-kpi-employees"))).toContain("across every type");
  });

  it("shows the week or the month, and keeps them in the address", async () => {
    await openReports();
    click(tab("Week"));
    expect(params()).toEqual({ period: "week" });
    await waitFor(() => text(q("reports-kpi-period")).includes("12 Oct - 18 Oct 2026"), "the week");
    expect(text(q("reports-kpi-period"))).toContain("Monday to Sunday");
    click(tab("Month"));
    await waitFor(() => text(q("reports-kpi-period")).includes("1 Oct - 31 Oct 2026"), "the month");
    expect(text(q("reports-kpi-period"))).toContain("Calendar month");
    expect(window.location.pathname).toBe(REPORTS);
  });

  it("steps by a date and restores the period and the date from the address", async () => {
    await openReports(`${REPORTS}?period=week&date=2026-09-30`);
    expect(reportRequests()).toEqual(["/api/compensation/reports?period=week&date=2026-09-30"]);
    click(must("reports-period-prev"));
    expect(params().date).toBe("2026-09-23");
    click(must("reports-period-today"));
    expect(params().date).toBeUndefined();
  });

  it("is quiet and clear on a day nothing was given", async () => {
    world.report = (qs) => emptyReport(qs);
    await openReports();
    expect(text(q("reports-kpi-records-value"))).toBe("0");
    expect((must("reports-export") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("who benefited from each type", () => {
  it("is an overview card per type, in the owner's order, and no row tables", async () => {
    await openReports();
    expect(overviewTypes()).toEqual(TYPES);
    expect(q("report-table-ot_allowance")).toBeNull();
    expect(all("report-section-")).toHaveLength(0);
    expect(text(q("overview-ot_allowance"))).toContain("OT: next-day late-in allowance");
    expect(text(q("overview-ot_allowance"))).toContain("2 employees · 2 records");
    expect(text(q("overview-window_early_out"))).toContain("0 employees · 0 records");
  });

  it("opens the History subtab of a type when its card is clicked, with the period and the filters", async () => {
    await openReports(`${REPORTS}?period=week&date=2026-10-07&dept=3&branch=2`);
    click(must("overview-ot_shift_pay"));
    await waitFor(() => !!q("history-range"), "History");
    expect(window.location.pathname).toBe("/hr/compensation/history/ot-pay");
    expect(params()).toEqual({ period: "week", date: "2026-10-07", dept: "3", branch: "2" });
    expect(tab("OT pay").getAttribute("aria-selected")).toBe("true");
  });

  it("sends each company window to its nested subtab of Company windows, and drops the type filter", async () => {
    await openReports(`${REPORTS}?type=window_late_in`);
    expect(overviewTypes()).toEqual(["window_late_in"]);
    click(must("overview-window_late_in"));
    await waitFor(() => !!q("history-range"), "History");
    expect(here()).toBe("/hr/compensation/history/company-windows/late-in");
    unmountPage();

    await openReports(`${REPORTS}?type=window_early_out&period=week`);
    click(must("overview-window_early_out"));
    await waitFor(() => !!q("history-range"), "History");
    expect(here()).toBe("/hr/compensation/history/company-windows/early-out?period=week");
    unmountPage();

    await openReports(`${REPORTS}?type=holiday_work`);
    click(must("overview-holiday_work"));
    await waitFor(() => !!q("history-range"), "History");
    expect(here()).toBe("/hr/compensation/history/holiday-work/work");
  });
});

describe("the filters", () => {
  it("narrow to one type, asking the server for just that one", async () => {
    await openReports();
    pickOption(must("reports-type"), "Birthday leave");
    expect(params().type).toBe("birthday");
    await waitFor(() => overviewTypes().length === 1, "the one card");
    expect(overviewTypes()).toEqual(["birthday"]);
    expect(lastRequest().get("type")).toBe("birthday");
    pickOption(must("reports-type"), "All types");
    await waitFor(() => overviewTypes().length === 7, "every card");
    expect(params().type).toBeUndefined();
  });

  it("narrow to a department and a branch", async () => {
    await openReports();
    pickOption(must("reports-dept"), "Cutting");
    expect(params().dept).toBe("3");
    await waitFor(() => lastRequest().get("departmentId") === "3", "the department");
    pickOption(must("reports-branch"), "Unit 2");
    expect(params().branch).toBe("5");
    await waitFor(() => lastRequest().get("branchId") === "5", "the branch");
    await waitFor(() => !!q("reports-kpi-employees"), "the report");
    expect(lastRequest().get("departmentId")).toBe("3");
    expect(text(q("reports-kpi-employees"))).toContain("with the filters on");
  });

  it("restore the filters from the address", async () => {
    await openReports(`${REPORTS}?type=ot_shift_pay&dept=3&branch=2`);
    expect(lastRequest().get("type")).toBe("ot_shift_pay");
    expect(lastRequest().get("departmentId")).toBe("3");
    expect(lastRequest().get("branchId")).toBe("2");
    expect(overviewTypes()).toEqual(["ot_shift_pay"]);
  });

  it("do not offer a branch to a login that sees one branch only, and never send one", async () => {
    h.user.current = { branchId: 2 };
    await openReports(`${REPORTS}?branch=5`);
    expect(q("reports-branch")).toBeNull();
    expect(lastRequest().get("branchId")).toBeNull();
  });

  it("ignore a type or a department that is nonsense", async () => {
    await openReports(`${REPORTS}?type=lunch&dept=abc`);
    expect(lastRequest().get("type")).toBeNull();
    expect(lastRequest().get("departmentId")).toBeNull();
  });
});

describe("a type that is switched off", () => {
  it("is flagged on its card, while the master switch is on", async () => {
    world.report = (qs) => reportOf(qs, ["ot_shift_pay"]);
    await openReports();
    expect(text(q("overview-ot_shift_pay"))).toContain("Off in Settings");
    expect(text(q("overview-ot_allowance"))).not.toContain("Off in Settings");
  });

  it("adds no per-type flag while the master switch is off: the page says it once", async () => {
    world.settings.compensationFeatureEnabled = false;
    world.report = (qs) => reportOf(qs, TYPES as never[]);
    await openReports();
    await waitFor(() => !!q("compensation-features-off"), "the master notice");
    expect(text(q("overview-ot_allowance"))).not.toContain("Off in Settings");
  });
});

describe("the export", () => {
  async function openMenu() {
    press(must("reports-export"), "Enter");
    await waitFor(() => !!q("reports-export-excel"), "the menu");
  }

  it("offers an Excel workbook and a CSV", async () => {
    await openReports();
    await openMenu();
    expect(text(q("reports-export-excel"))).toContain("Excel (.xlsx)");
    expect(text(q("reports-export-excel"))).toContain("a Summary sheet and a sheet for every type");
    expect(text(q("reports-export-csv"))).toContain("CSV");
  });

  it("builds one workbook of ALL the sections: a Summary sheet and one sheet per type, named after the period", async () => {
    await openReports(`${REPORTS}?period=week`);
    await openMenu();
    click(must("reports-export-excel"));
    await settle(30);
    await waitFor(() => h.download.mock.calls.length === 1, "the download");
    const [wb, filename] = h.download.mock.calls[0] as [ExcelJS.Workbook, string];
    expect(filename).toBe("Compensation_Report_2026-10-12_to_2026-10-18.xlsx");
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      "Summary",
      "OT allowance",
      "OT relaxation",
      "OT payment",
      "Late-in window",
      "Early-out window",
      "Holiday work",
      "Birthday",
    ]);
    expect(wb.getWorksheet("Summary")!.getCell(1, 1).value).toBe("UK Textiles Ltd");
    await settle(30);
  });

  it("puts the filters on the Summary sheet", async () => {
    await openReports(`${REPORTS}?dept=3&branch=2`);
    await openMenu();
    click(must("reports-export-excel"));
    await settle(30);
    await waitFor(() => h.download.mock.calls.length === 1, "the download");
    const wb = h.download.mock.calls[0][0] as ExcelJS.Workbook;
    const ws = wb.getWorksheet("Summary")!;
    const facts = new Map<string, unknown>();
    for (let r = 1; r <= ws.rowCount; r += 1) facts.set(String(ws.getCell(r, 1).value), ws.getCell(r, 2).value);
    expect(facts.get("Department")).toBe("Cutting");
    expect(facts.get("Branch")).toBe("Head Office");
    await settle(30);
  });

  it("exports every record as one CSV, with the type named", async () => {
    await openReports();
    await openMenu();
    click(must("reports-export-csv"));
    await settle(30);
    await waitFor(() => h.csv.mock.calls.length === 1, "the CSV");
    const arg = h.csv.mock.calls[0][0] as {
      rows: { type: string; status: string }[];
      columns: { key: string }[];
      filename: string;
    };
    expect(arg.filename).toBe("Compensation_Report_2026-10-14");
    expect(arg.rows).toHaveLength(8); // 7 beneficiaries and 1 redeemed balance
    expect(arg.rows.map((r) => r.type)).toContain("holiday_work");
    expect(arg.columns[0].key).toBe("type");
    await settle(30);
  });

  it("exports only the type that is chosen", async () => {
    await openReports(`${REPORTS}?type=birthday`);
    await openMenu();
    click(must("reports-export-csv"));
    await settle(30);
    await waitFor(() => h.csv.mock.calls.length === 1, "the CSV");
    expect((h.csv.mock.calls[0][0] as { rows: unknown[] }).rows).toHaveLength(1);
    await settle(30);
  });

  it("stays open to a View Only role: it only reads and downloads", async () => {
    const { lockMutatingControls } = await import("@/lib/view-only-lock");
    await openReports();
    lockMutatingControls(document.body);
    expect((must("reports-export") as HTMLButtonElement).disabled).toBe(false);
    expect((must("reports-type") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("loading and errors", () => {
  it("shows the shape of the report while it is on its way", async () => {
    const release = world.hold("/api/compensation/reports");
    mountPage(REPORTS);
    await waitFor(() => !!q("reports-loading"), "the loader");
    expect(q("skeleton-kpis")).not.toBeNull();
    expect(q("reports-kpis")).toBeNull();
    release();
    await waitFor(() => !!q("reports-kpis"), "the report");
    expect(q("reports-loading")).toBeNull();
  });

  it("shows an error with a Retry, then the report", async () => {
    world.failing.set("/api/compensation/reports", { status: 500 });
    mountPage(REPORTS);
    await waitFor(() => !!q("reports-error"), "the error");
    expect(text(q("reports-error"))).toContain("Could not load the report");
    world.failing.clear();
    click([...must("reports-error").querySelectorAll("button")].find((b) => text(b) === "Retry"));
    await waitFor(() => !!q("reports-kpis"), "the report");
  });
});
