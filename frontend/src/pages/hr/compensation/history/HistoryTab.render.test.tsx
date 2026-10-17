import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyReport, reportOf } from "../fixtures";
import {
  click,
  freezeClock,
  installBrowserStubs,
  installWorld,
  mountPage,
  nestedLabels,
  nestedTab,
  must,
  params,
  pickOption,
  q,
  tab,
  text,
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "../harness";

// The History page in jsdom: one subtab per kind of record (its summary cards and its beneficiaries), the counts on the
// pills, Today / Week / Month with a date, the department and branch filters above the subtabs, the types that are
// switched off, and the loaders, empty states and errors. (The cross-type summary and the export are tested in
// ReportsTab.render.test.tsx.)

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: { current: null as { branchId?: number | null } | null },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "t", user: h.user.current }) }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
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

const PAGE = "/hr/compensation/history";
const sub = (name: string) => `${PAGE}/${name}`;
const FIRST = sub("ot-allowance");

async function openHistory(url = FIRST) {
  mountPage(url);
  await waitFor(() => !!q("history-range"), "the report");
}

const all = (prefix: string) => [...document.body.querySelectorAll(`[data-testid^="${prefix}"]`)];
const reportRequests = () => world.requests().filter((r) => r.startsWith("/api/compensation/reports"));
const lastRequest = () => new URLSearchParams(reportRequests().at(-1)!.split("?")[1]);
const sectionTypes = () =>
  all("report-section-").map((e) => e.getAttribute("data-testid")!.slice("report-section-".length));
const rowsOf = (type: string) => [...(q(`report-table-${type}`)?.querySelectorAll("tbody tr") ?? [])];
const nestedLabelsOf = () => nestedLabels("history-nested");
/** Opens a nested subtab from the strip and waits for its section. */
async function openNested(value: string, ready: string) {
  click(nestedTab("history-nested", value));
  await waitFor(() => !!q(ready), `the ${value} subtab`);
}
const subtabs = () =>
  [...document.body.querySelectorAll('[data-testid="history-subtabs"] [role="tab"]')].map((t) =>
    text(t.querySelector(".ptab-label")),
  );

describe("the subtabs", () => {
  it("are one per kind of record, with how many records each holds", async () => {
    await openHistory();
    expect(subtabs()).toEqual([
      "OT allowance(2)",
      "OT relaxation(1)",
      "OT pay(1)",
      "Company windows(1)",
      "Holiday / Sunday work(1)",
      "Birthday leave(1)",
    ]);
    expect(tab("OT allowance").getAttribute("aria-selected")).toBe("true");
  });

  it("show only their own section: switching changes the address, not the stacked page", async () => {
    await openHistory();
    expect(sectionTypes()).toEqual(["ot_allowance"]);
    click(tab("OT relaxation"));
    expect(window.location.pathname).toBe(sub("ot-relaxation"));
    expect(sectionTypes()).toEqual(["ot_shift_relaxation"]);
    click(tab("OT pay"));
    expect(window.location.pathname).toBe(sub("ot-pay"));
    expect(sectionTypes()).toEqual(["ot_shift_pay"]);
    click(tab("Holiday / Sunday work"));
    expect(window.location.pathname).toBe(sub("holiday-work/work"));
    expect(sectionTypes()).toEqual(["holiday_work"]);
    click(tab("Birthday leave"));
    expect(window.location.pathname).toBe(sub("birthday-leave"));
    expect(sectionTypes()).toEqual(["birthday"]);
  });

  it("put the two company windows under one subtab, one nested subtab each, not stacked", async () => {
    await openHistory(sub("company-windows"));
    expect(window.location.pathname).toBe(sub("company-windows/late-in"));
    expect(tab("Company windows").getAttribute("aria-selected")).toBe("true");
    expect(nestedLabelsOf()).toEqual(["Late-in window (1)", "Early-out window (0)"]);
    expect(sectionTypes()).toEqual(["window_late_in"]);
    await openNested("early-out", "report-section-window_early_out");
    expect(window.location.pathname).toBe(sub("company-windows/early-out"));
    expect(sectionTypes()).toEqual(["window_early_out"]);
    expect(nestedTab("history-nested", "early-out").getAttribute("aria-selected")).toBe("true");
  });

  it("keep the period, the filters and the one report request across a nested switch", async () => {
    await openHistory(`${sub("company-windows")}?period=week&date=2026-10-07&dept=3`);
    expect(window.location.pathname).toBe(sub("company-windows/late-in"));
    await openNested("early-out", "report-section-window_early_out");
    expect(params()).toEqual({ period: "week", date: "2026-10-07", dept: "3" });
    expect(tab("Week").getAttribute("aria-selected")).toBe("true");
    expect(reportRequests()).toHaveLength(1);
  });

  it("split Holiday / Sunday work into the work and the balance redeemed, the second only when there is some", async () => {
    await openHistory(sub("holiday-work"));
    expect(window.location.pathname).toBe(sub("holiday-work/work"));
    expect(nestedLabelsOf()).toEqual(["Sunday / holiday work (1)", "Balance redeemed (1)"]);
    expect(sectionTypes()).toEqual(["holiday_work"]);
    expect(q("report-table-redemptions")).toBeNull();
    await openNested("redeemed", "report-redemptions");
    expect(window.location.pathname).toBe(sub("holiday-work/redeemed"));
    expect(q("report-section-holiday_work")).toBeNull();
    unmountPage();

    world.report = (qs) => emptyReport(qs);
    await openHistory(sub("holiday-work"));
    expect(nestedLabelsOf()).toEqual(["Sunday / holiday work (0)"]);
  });

  it("have no nested strip under a kind with one section", async () => {
    await openHistory(sub("ot-pay"));
    expect(q("history-nested")).toBeNull();
    expect(window.location.pathname).toBe(sub("ot-pay"));
  });

  it("send a nested subtab that does not exist to the first one, keeping the filters", async () => {
    mountPage(`${sub("company-windows/nonsense")}?dept=3`);
    await waitFor(() => !!q("history-range"), "the report");
    expect(window.location.pathname).toBe(sub("company-windows/late-in"));
    expect(params()).toEqual({ dept: "3" });
  });

  it("do not ask the server again for a switch, and ask for every type in one request", async () => {
    await openHistory();
    expect(reportRequests()).toEqual(["/api/compensation/reports?period=today&date=2026-10-14"]);
    click(tab("OT pay"));
    click(tab("Birthday leave"));
    expect(reportRequests()).toHaveLength(1);
  });

  it("keep the period, the date and the filters when switching", async () => {
    await openHistory(`${FIRST}?period=week&date=2026-10-07&dept=3&branch=2`);
    click(tab("OT pay"));
    expect(window.location.pathname).toBe(sub("ot-pay"));
    expect(params()).toEqual({ period: "week", date: "2026-10-07", dept: "3", branch: "2" });
    expect((must("history-period-date") as HTMLInputElement).value).toBe("2026-10-07");
    expect(tab("Week").getAttribute("aria-selected")).toBe("true");
  });

  it("send the bare page to the first one, and one that does not exist too, keeping the filters", async () => {
    mountPage(`${PAGE}?period=month`);
    await waitFor(() => !!q("history-range"), "the report");
    expect(window.location.pathname).toBe(FIRST);
    expect(params()).toEqual({ period: "month" });
    unmountPage();

    mountPage(`${sub("nonsense")}?dept=3`);
    await waitFor(() => !!q("history-range"), "the report");
    expect(window.location.pathname).toBe(FIRST);
    expect(params()).toEqual({ dept: "3" });
  });
});

describe("Today, Week and Month", () => {
  it("opens on today, asks the server for it, and says what the period is", async () => {
    await openHistory();
    expect(reportRequests()).toEqual(["/api/compensation/reports?period=today&date=2026-10-14"]);
    expect(text(q("history-range"))).toBe("14 Oct 2026");
    expect(tab("Today").getAttribute("aria-selected")).toBe("true");
  });

  it("shows the week the date is in, Monday to Sunday, and keeps it in the address", async () => {
    await openHistory();
    click(tab("Week"));
    expect(params()).toEqual({ period: "week" });
    expect(window.location.pathname).toBe(FIRST);
    await waitFor(() => text(q("history-range")).includes("12 Oct - 18 Oct 2026"), "the week");
    expect(lastRequest().get("period")).toBe("week");
    expect(lastRequest().get("date")).toBe("2026-10-14");
  });

  it("shows the month", async () => {
    await openHistory();
    click(tab("Month"));
    await waitFor(() => text(q("history-range")).includes("1 Oct - 31 Oct 2026"), "the month");
    expect(params().period).toBe("month");
  });

  it("steps by a day, a week or a month, and goes back to today", async () => {
    await openHistory(`${FIRST}?period=week`);
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
    await openHistory(`${FIRST}?period=week&date=2026-09-30`);
    expect(reportRequests()).toEqual(["/api/compensation/reports?period=week&date=2026-09-30"]);
    expect((must("history-period-date") as HTMLInputElement).value).toBe("2026-09-30");
    typeInto(must("history-period-date") as HTMLInputElement, "2026-10-02");
    expect(params().date).toBe("2026-10-02");
  });
});

describe("who benefited from each kind", () => {
  it("has no type filter and no export: the subtab is the type, the export is on Reports", async () => {
    await openHistory();
    expect(q("history-type")).toBeNull();
    expect(q("history-export")).toBeNull();
    expect(q("history-overview")).toBeNull();
    expect(lastRequest().get("type")).toBeNull();
  });

  it("says in one sentence who benefits from the kind", async () => {
    await openHistory();
    expect(text(q("report-who-ot_allowance"))).toContain(
      "Staff who worked past their shift end and earned a late-in allowance",
    );
    click(tab("OT pay"));
    expect(text(q("report-who-ot_shift_pay"))).toContain("shifts × the daily rate");
    click(tab("Company windows"));
    expect(text(q("report-who-window_late_in"))).toContain("Staff who used a company-announced late-in window");
    click(tab("Holiday / Sunday work"));
    expect(text(q("report-who-holiday_work"))).toContain("the shifts go to the employee's balance");
    click(tab("Birthday leave"));
    expect(text(q("report-who-birthday"))).toContain("Staff whose birthday falls in the period");
  });

  it("shows the tiles of the kind", async () => {
    await openHistory();
    const tiles = (type: string) => text(q(`report-tiles-${type}`));
    expect(tiles("ot_allowance")).toContain("Earned2");
    expect(tiles("ot_allowance")).toContain("Used it1");
    click(tab("OT pay"));
    expect(tiles("ot_shift_pay")).toContain("Waiting for payroll1");
    expect(tiles("ot_shift_pay")).toContain("+ ₹450.00 estimated");
    click(tab("Company windows"));
    expect(tiles("window_late_in")).toContain("Staff covered214");
    click(tab("Holiday / Sunday work"));
    expect(tiles("holiday_work")).toContain("Approved1");
    expect(tiles("holiday_work")).toContain("Redeemed0.50");
    click(tab("Birthday leave"));
    expect(tiles("birthday")).toContain("Marked1");
  });

  it("lists the beneficiaries with the kind's own columns", async () => {
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
    await openHistory(sub("ot-pay"));
    const row = text(q("report-row-ot_shift_pay-0"));
    expect(row).toContain("Chitra Devi");
    expect(row).toContain("0.50");
    expect(row).toContain("₹450.00 (estimate)");
    expect(row).toContain("Waiting for payroll");
  });

  it("shows the window used: its time, who announced it and why, and says nobody for the early-out", async () => {
    await openHistory(sub("company-windows"));
    const row = text(q("report-row-window_late_in-0"));
    expect(row).toContain("10:30 AM");
    expect(row).toContain("Meena");
    expect(row).toContain("Heavy rain");
    expect(row).toContain("10:15 AM");
    await openNested("early-out", "report-section-window_early_out");
    expect(text(q("report-empty-window_early_out"))).toContain("Nobody benefited in this period");
    expect(q("report-table-window_early_out")).toBeNull();
  });

  it("shows the claim with who raised and who approved it, and the balance redeemed under it", async () => {
    await openHistory(sub("holiday-work"));
    const claim = text(q("report-row-holiday_work-0"));
    expect(claim).toContain("Indu Nair");
    expect(claim).toContain("11 Oct 2026");
    expect(claim).toContain("Meena");
    expect(claim).toContain("Suresh Raj");
    expect(claim).toContain("Approved");
    await openNested("redeemed", "report-redemptions");
    const redeemed = text(q("report-redemption-0"));
    expect(redeemed).toContain("Fara Khan");
    expect(redeemed).toContain("12 Oct 2026");
    expect(redeemed).toContain("0.50");
    expect(text(q("report-redemptions"))).toContain("Balance redeemed as days off");
  });

  it("is quiet and clear on a day nothing was given: counts of zero and an empty note in every subtab", async () => {
    world.report = (qs) => emptyReport(qs);
    await openHistory();
    expect(subtabs().every((label) => label.endsWith("(0)"))).toBe(true);
    expect(all("report-empty-")).toHaveLength(1);
    click(tab("Company windows"));
    expect(all("report-empty-")).toHaveLength(1);
    await openNested("early-out", "report-section-window_early_out");
    expect(all("report-empty-")).toHaveLength(1);
  });
});

describe("the filters", () => {
  it("narrow to a department and a branch, for every subtab", async () => {
    await openHistory();
    pickOption(must("history-dept"), "Cutting");
    expect(params().dept).toBe("3");
    await waitFor(() => lastRequest().get("departmentId") === "3", "the department");
    pickOption(must("history-branch"), "Unit 2");
    expect(params().branch).toBe("5");
    await waitFor(() => lastRequest().get("branchId") === "5", "the branch");
    await waitFor(() => text(q("history-range")).includes("with the filters on"), "the report");
    expect(lastRequest().get("departmentId")).toBe("3");
    click(tab("OT pay"));
    expect(params()).toEqual({ dept: "3", branch: "5" });
  });

  it("restore the filters from the address", async () => {
    await openHistory(`${FIRST}?dept=3&branch=2`);
    expect(lastRequest().get("departmentId")).toBe("3");
    expect(lastRequest().get("branchId")).toBe("2");
  });

  it("do not offer a branch to a login that sees one branch only, and never send one", async () => {
    h.user.current = { branchId: 2 };
    await openHistory(`${FIRST}?branch=5`);
    expect(q("history-branch")).toBeNull();
    expect(lastRequest().get("branchId")).toBeNull();
  });

  it("ignore a department that is nonsense, and the old type filter of the single page", async () => {
    await openHistory(`${FIRST}?type=lunch&dept=abc`);
    expect(lastRequest().get("type")).toBeNull();
    expect(lastRequest().get("departmentId")).toBeNull();
  });
});

describe("a type that is switched off", () => {
  it("says so on its section, with a link to its switch, and keeps what it gave listed", async () => {
    world.report = (qs) => reportOf(qs, ["ot_shift_pay"]);
    await openHistory(sub("ot-pay"));
    const notice = must("report-off-ot_shift_pay");
    expect(text(notice)).toContain("This type is switched off in Settings");
    expect(text(notice)).toContain("what it gave earlier stays listed");
    expect(notice.querySelector("a")!.getAttribute("href")).toBe("/hr/settings?tab=compensation#shift-pay");
    expect(rowsOf("ot_shift_pay")).toHaveLength(1);
    click(tab("OT allowance"));
    expect(q("report-off-ot_allowance")).toBeNull();
  });

  it("adds no per-type notice while the master switch is off: the page says it once", async () => {
    world.settings.compensationFeatureEnabled = false;
    world.report = (qs) => reportOf(qs, ["ot_allowance", "ot_shift_pay"]);
    await openHistory();
    await waitFor(() => !!q("compensation-features-off"), "the master notice");
    expect(all("report-off-")).toHaveLength(0);
    // the history is always readable
    expect(rowsOf("ot_allowance")).toHaveLength(2);
  });
});

describe("loading and errors", () => {
  it("shows the shape of the report while it is on its way, the subtabs without counts", async () => {
    const release = world.hold("/api/compensation/reports");
    mountPage(FIRST);
    await waitFor(() => !!q("history-loading"), "the loader");
    expect(q("skeleton-kpis")).not.toBeNull();
    expect(q("history-range")).toBeNull();
    expect(subtabs()).toHaveLength(6);
    expect(subtabs().some((label) => label.includes("("))).toBe(false);
    release();
    await waitFor(() => !!q("history-range"), "the report");
    expect(q("history-loading")).toBeNull();
  });

  it("shows an error with a Retry, then the report", async () => {
    world.failing.set("/api/compensation/reports", { status: 500 });
    mountPage(FIRST);
    await waitFor(() => !!q("history-error"), "the error");
    expect(text(q("history-error"))).toContain("Could not load the report");
    world.failing.clear();
    click([...must("history-error").querySelectorAll("button")].find((b) => text(b) === "Retry"));
    await waitFor(() => !!q("history-range"), "the report");
  });

  it("explains a refused period the server answers with its own sentence", async () => {
    world.failing.set("/api/compensation/reports", {
      status: 403,
      body: { error: "permission_denied", message: "You do not have access to Compensation." },
    });
    mountPage(FIRST);
    await waitFor(() => !!q("history-error"), "the error");
    expect(text(q("history-error"))).toContain("You do not have access to Compensation.");
  });
});
