import type { ReactNode } from "react";
import type ExcelJS from "exceljs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyReport, reportOf } from "../fixtures";
import {
  click,
  freezeClock,
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
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "../harness";

// History & Reports in jsdom: who benefited from each type for Today, a Week or a Month, the filters, the section of every type
// with its tiles and its beneficiaries, the Excel workbook (a Summary sheet and a sheet per type) and the CSV, and the loaders,
// empty states and errors.

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

const HISTORY = "/hr/compensation?tab=history";
const TYPES = [
  "ot_allowance",
  "ot_shift_relaxation",
  "ot_shift_pay",
  "window_late_in",
  "window_early_out",
  "holiday_work",
  "birthday",
];

async function openHistory(url = HISTORY) {
  mountPage(url);
  await waitFor(() => !!q("history-kpis"), "the report");
}

const reportRequests = () => world.requests().filter((r) => r.startsWith("/api/compensation/reports"));
const lastRequest = () => new URLSearchParams(reportRequests().at(-1)!.split("?")[1]);
const sectionTypes = () =>
  [...document.body.querySelectorAll('[data-testid^="report-section-"]')].map((e) =>
    e.getAttribute("data-testid")!.slice("report-section-".length),
  );
const rowsOf = (type: string) => [...(q(`report-table-${type}`)?.querySelectorAll("tbody tr") ?? [])];

describe("Today, Week and Month", () => {
  it("opens on today, asks the server for it, and says what the period is", async () => {
    await openHistory();
    expect(reportRequests()).toEqual(["/api/compensation/reports?period=today&date=2026-10-14"]);
    expect(text(q("history-kpi-period"))).toContain("14 Oct 2026");
    expect(text(q("history-kpi-period"))).toContain("One day");
    expect(tab("Today").getAttribute("aria-selected")).toBe("true");
    expect(text(q("history-kpi-employees-value"))).toBe("6");
    expect(text(q("history-kpi-records-value"))).toBe("7");
  });

  it("shows the week the date is in, Monday to Sunday, and keeps it in the address", async () => {
    await openHistory();
    click(tab("Week"));
    expect(params()).toEqual({ tab: "history", period: "week" });
    await waitFor(() => text(q("history-kpi-period")).includes("12 Oct - 18 Oct 2026"), "the week");
    expect(lastRequest().get("period")).toBe("week");
    expect(lastRequest().get("date")).toBe("2026-10-14");
    expect(text(q("history-kpi-period"))).toContain("Monday to Sunday");
  });

  it("shows the month", async () => {
    await openHistory();
    click(tab("Month"));
    await waitFor(() => text(q("history-kpi-period")).includes("1 Oct - 31 Oct 2026"), "the month");
    expect(text(q("history-kpi-period"))).toContain("Calendar month");
    expect(params().period).toBe("month");
  });

  it("steps by a day, a week or a month, and goes back to today", async () => {
    await openHistory(`${HISTORY}&period=week`);
    click(must("history-period-prev"));
    expect(params().date).toBe("2026-10-07");
    await waitFor(() => lastRequest().get("date") === "2026-10-07", "last week");
    click(must("history-period-today"));
    expect(params().date).toBeUndefined();
    // (this week was read before, so it comes from the cache: the date box is what shows it)
    expect((must("history-period-date") as HTMLInputElement).value).toBe("2026-10-14");
    expect((must("history-period-today") as HTMLButtonElement).disabled).toBe(true);
    click(tab("Month"));
    click(must("history-period-next"));
    expect(params().date).toBe("2026-11-14");
    await waitFor(
      () => lastRequest().get("date") === "2026-11-14" && lastRequest().get("period") === "month",
      "next month",
    );
  });

  it("follows a date picked, and restores period and date from the address", async () => {
    await openHistory(`${HISTORY}&period=week&date=2026-09-30`);
    expect(reportRequests()).toEqual(["/api/compensation/reports?period=week&date=2026-09-30"]);
    expect((must("history-period-date") as HTMLInputElement).value).toBe("2026-09-30");
    typeInto(must("history-period-date") as HTMLInputElement, "2026-10-02");
    expect(params().date).toBe("2026-10-02");
  });
});

describe("who benefited from each type", () => {
  it("has a section for every type, in the owner's order", async () => {
    await openHistory();
    expect(sectionTypes()).toEqual(TYPES);
  });

  it("gives an overview: how many employees and records each type has, and jumps to a type", async () => {
    await openHistory();
    expect(text(q("overview-ot_allowance"))).toContain("OT: next-day late-in allowance");
    expect(text(q("overview-ot_allowance"))).toContain("2 employees · 2 records");
    expect(text(q("overview-window_early_out"))).toContain("0 employees · 0 records");
    const scroll = vi.fn();
    const section = document.getElementById("report-birthday")!;
    section.scrollIntoView = scroll;
    click(must("overview-birthday"));
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("says in one sentence who benefits from each type", async () => {
    await openHistory();
    expect(text(q("report-who-ot_allowance"))).toContain(
      "Staff who worked past their shift end and earned a late-in allowance",
    );
    expect(text(q("report-who-ot_shift_pay"))).toContain("shifts × the daily rate");
    expect(text(q("report-who-window_late_in"))).toContain("Staff who used a company-announced late-in window");
    expect(text(q("report-who-holiday_work"))).toContain("the shifts go to the employee's balance");
    expect(text(q("report-who-birthday"))).toContain("Staff whose birthday falls in the period");
  });

  it("shows each type's tiles", async () => {
    await openHistory();
    const tiles = (type: string) => text(q(`report-tiles-${type}`));
    expect(tiles("ot_allowance")).toContain("Earned2");
    expect(tiles("ot_allowance")).toContain("Used it1");
    expect(tiles("ot_shift_pay")).toContain("Waiting for payroll1");
    expect(tiles("ot_shift_pay")).toContain("+ ₹450.00 estimated");
    expect(tiles("window_late_in")).toContain("Staff covered214");
    expect(tiles("holiday_work")).toContain("Approved1");
    expect(tiles("holiday_work")).toContain("Redeemed0.50");
    expect(tiles("birthday")).toContain("Marked1");
  });

  it("lists the beneficiaries of a type with its own columns", async () => {
    await openHistory();
    const heads = [...must("report-table-ot_allowance").querySelectorAll("thead th")].map(text);
    expect(heads).toEqual([
      "Employee",
      "OT date",
      "Last punch",
      "Extra time (min)",
      "Allowance (min)",
      "Used on",
      "Minutes used",
      "First punch",
      "Status",
      "Details",
    ]);
    expect(rowsOf("ot_allowance")).toHaveLength(2);
    const first = text(q("report-row-ot_allowance-0"));
    expect(first).toContain("Asha Kumar");
    expect(first).toContain("E11");
    expect(first).toContain("13 Oct 2026");
    expect(first).toContain("7:00 PM");
    expect(first).toContain("30");
    expect(first).toContain("14 Oct 2026");
    expect(first).toContain("Used");
    expect(q("report-row-ot_allowance-0")!.getAttribute("data-status")).toBe("used");
    expect(text(q("report-row-ot_allowance-1"))).toContain("Pending");
  });

  it("shows the pay amount, and says when it is an estimate", async () => {
    await openHistory();
    const row = text(q("report-row-ot_shift_pay-0"));
    expect(row).toContain("Chitra Devi");
    expect(row).toContain("0.50");
    expect(row).toContain("₹450.00 (estimate)");
    expect(row).toContain("Waiting for payroll");
  });

  it("shows the window used: its time, who announced it and why", async () => {
    await openHistory();
    const row = text(q("report-row-window_late_in-0"));
    expect(row).toContain("10:30 AM");
    expect(row).toContain("Meena");
    expect(row).toContain("Heavy rain");
    expect(row).toContain("10:15 AM");
  });

  it("shows the claim with who raised and who approved it, and the balance redeemed under it", async () => {
    await openHistory();
    const claim = text(q("report-row-holiday_work-0"));
    expect(claim).toContain("Indu Nair");
    expect(claim).toContain("11 Oct 2026");
    expect(claim).toContain("Meena");
    expect(claim).toContain("Suresh Raj");
    expect(claim).toContain("Approved");
    const redeemed = text(q("report-redemption-0"));
    expect(redeemed).toContain("Fara Khan");
    expect(redeemed).toContain("12 Oct 2026");
    expect(redeemed).toContain("0.50");
    expect(text(q("report-section-holiday_work"))).toContain("Balance redeemed as days off");
  });

  it("says nobody benefited for a type with no rows", async () => {
    await openHistory();
    expect(text(q("report-empty-window_early_out"))).toContain("Nobody benefited in this period");
    expect(q("report-table-window_early_out")).toBeNull();
  });

  it("is quiet and clear on a day nothing was given", async () => {
    world.report = (qs) => emptyReport(qs);
    await openHistory();
    expect(text(q("history-kpi-records-value"))).toBe("0");
    expect(all("report-empty-")).toHaveLength(7);
    expect((must("history-export") as HTMLButtonElement).disabled).toBe(true);
  });
});

const all = (prefix: string) => [...document.body.querySelectorAll(`[data-testid^="${prefix}"]`)];

describe("the filters", () => {
  it("narrow to one type, asking the server for just that one", async () => {
    await openHistory();
    pickOption(must("history-type"), "Birthday leave");
    expect(params().type).toBe("birthday");
    await waitFor(() => sectionTypes().length === 1, "the one section");
    expect(sectionTypes()).toEqual(["birthday"]);
    expect(lastRequest().get("type")).toBe("birthday");
    pickOption(must("history-type"), "All types");
    await waitFor(() => sectionTypes().length === 7, "every section");
    expect(params().type).toBeUndefined();
  });

  it("narrow to a department and a branch", async () => {
    await openHistory();
    pickOption(must("history-dept"), "Cutting");
    expect(params().dept).toBe("3");
    await waitFor(() => lastRequest().get("departmentId") === "3", "the department");
    pickOption(must("history-branch"), "Unit 2");
    expect(params().branch).toBe("5");
    await waitFor(() => lastRequest().get("branchId") === "5", "the branch");
    await waitFor(() => !!q("history-kpi-employees"), "the report");
    expect(lastRequest().get("departmentId")).toBe("3");
    expect(text(q("history-kpi-employees"))).toContain("with the filters on");
  });

  it("restore the filters from the address", async () => {
    await openHistory(`${HISTORY}&type=ot_shift_pay&dept=3&branch=2`);
    expect(lastRequest().get("type")).toBe("ot_shift_pay");
    expect(lastRequest().get("departmentId")).toBe("3");
    expect(lastRequest().get("branchId")).toBe("2");
    expect(sectionTypes()).toEqual(["ot_shift_pay"]);
  });

  it("do not offer a branch to a login that sees one branch only, and never send one", async () => {
    h.user.current = { branchId: 2 };
    await openHistory(`${HISTORY}&branch=5`);
    expect(q("history-branch")).toBeNull();
    expect(lastRequest().get("branchId")).toBeNull();
  });

  it("ignore a type or a department that is nonsense", async () => {
    await openHistory(`${HISTORY}&type=lunch&dept=abc`);
    expect(lastRequest().get("type")).toBeNull();
    expect(lastRequest().get("departmentId")).toBeNull();
  });
});

describe("a type that is switched off", () => {
  it("says so on its section, with a link to its switch, and keeps what it gave listed", async () => {
    world.report = (qs) => reportOf(qs, ["ot_shift_pay"]);
    await openHistory();
    const notice = must("report-off-ot_shift_pay");
    expect(text(notice)).toContain("This type is switched off in Settings");
    expect(text(notice)).toContain("what it gave earlier stays listed");
    expect(notice.querySelector("a")!.getAttribute("href")).toBe("/hr/settings?tab=compensation#shift-pay");
    expect(rowsOf("ot_shift_pay")).toHaveLength(1);
    expect(text(q("overview-ot_shift_pay"))).toContain("Off in Settings");
    expect(q("report-off-ot_allowance")).toBeNull();
  });

  it("adds no per-type notice while the master switch is off: the page says it once", async () => {
    world.settings.compensationFeatureEnabled = false;
    world.report = (qs) => reportOf(qs, TYPES as never[]);
    await openHistory();
    await waitFor(() => !!q("compensation-features-off"), "the master notice");
    expect(all("report-off-")).toHaveLength(0);
    // the report is always readable
    expect(rowsOf("ot_allowance")).toHaveLength(2);
  });
});

describe("the export", () => {
  async function openMenu() {
    press(must("history-export"), "Enter");
    await waitFor(() => !!q("history-export-excel"), "the menu");
  }

  it("offers an Excel workbook and a CSV", async () => {
    await openHistory();
    await openMenu();
    expect(text(q("history-export-excel"))).toContain("Excel (.xlsx)");
    expect(text(q("history-export-excel"))).toContain("a Summary sheet and a sheet for every type");
    expect(text(q("history-export-csv"))).toContain("CSV");
  });

  it("builds one workbook: a Summary sheet and one sheet per type, named after the period", async () => {
    await openHistory(`${HISTORY}&period=week`);
    await openMenu();
    click(must("history-export-excel"));
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
    await openHistory(`${HISTORY}&dept=3&branch=2`);
    await openMenu();
    click(must("history-export-excel"));
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

  it("exports every row on screen as one CSV, with the type named", async () => {
    await openHistory();
    await openMenu();
    click(must("history-export-csv"));
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
    await openHistory(`${HISTORY}&type=birthday`);
    await openMenu();
    click(must("history-export-csv"));
    await settle(30);
    await waitFor(() => h.csv.mock.calls.length === 1, "the CSV");
    expect((h.csv.mock.calls[0][0] as { rows: unknown[] }).rows).toHaveLength(1);
    await settle(30);
  });

  it("stays open to a View Only role: it only reads and downloads", async () => {
    const { lockMutatingControls } = await import("@/lib/view-only-lock");
    await openHistory();
    lockMutatingControls(document.body);
    expect((must("history-export") as HTMLButtonElement).disabled).toBe(false);
    expect((must("history-type") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("loading and errors", () => {
  it("shows the shape of the report while it is on its way", async () => {
    const release = world.hold("/api/compensation/reports");
    mountPage(HISTORY);
    await waitFor(() => !!q("history-loading"), "the loader");
    expect(q("skeleton-kpis")).not.toBeNull();
    expect(q("history-kpis")).toBeNull();
    release();
    await waitFor(() => !!q("history-kpis"), "the report");
    expect(q("history-loading")).toBeNull();
  });

  it("shows an error with a Retry, then the report", async () => {
    world.failing.set("/api/compensation/reports", { status: 500 });
    mountPage(HISTORY);
    await waitFor(() => !!q("history-error"), "the error");
    expect(text(q("history-error"))).toContain("Could not load the report");
    world.failing.clear();
    click([...must("history-error").querySelectorAll("button")].find((b) => text(b) === "Retry"));
    await waitFor(() => !!q("history-kpis"), "the report");
  });

  it("explains a refused period the server answers with its own sentence", async () => {
    world.failing.set("/api/compensation/reports", {
      status: 403,
      body: { error: "permission_denied", message: "You do not have access to Compensation." },
    });
    mountPage(HISTORY);
    await waitFor(() => !!q("history-error"), "the error");
    expect(text(q("history-error"))).toContain("You do not have access to Compensation.");
  });
});
