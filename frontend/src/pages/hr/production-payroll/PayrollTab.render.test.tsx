import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { BALA, ESHA, NO_RATE, balaPaid, payroll, person } from "./fixtures";
import {
  click,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  params,
  press,
  q,
  settle,
  text,
  unmountPage,
  waitFor,
  here,
  type World,
} from "./harness";

// The Payroll tab of a Production Payroll cycle page in jsdom, with a fake server behind customFetch: the dashboard of the
// period, the four views (Records, Issues, Skipped, Rules), the records as a table one department at a time (as on Staff
// Payroll), the filters, the Export menu (the Report Center's Production Salary Statement), Mark as Cleared, the loaders and
// the empty and error states, what a View Only role may touch, and the Generate Payroll dialog.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  trigger: vi.fn(),
  toast: vi.fn(),
  download: vi.fn(),
  bank: vi.fn(),
  generating: { current: false },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "t", user: null }) }));
vi.mock("@/contexts/PayrollGenerationContext", () => ({
  usePayrollGeneration: () => ({
    isGenerating: h.generating.current,
    showPipeline: false,
    progress: undefined,
    lastResult: null,
    triggerGenerate: vi.fn(),
    triggerGenerateProduction: h.trigger,
    dismiss: vi.fn(),
  }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));
vi.mock("@/lib/report-download", () => ({ downloadReportFile: h.download }));
vi.mock("@/lib/payrollExcelExport", () => ({ exportPayrollToExcel: h.bank }));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  h.generating.current = false;
  h.trigger.mockResolvedValue(null);
  h.download.mockResolvedValue("production_salary_statement.xlsx");
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
});

const WEEKLY = "/hr/production-payroll/weekly";
const WEEK_PARAM = "2026-02-02_2026-02-08";

/** Opens the Payroll tab and waits until the dashboard, the issues and the roster are all in. */
async function openPayroll(url = WEEKLY) {
  mountPage(url);
  await waitFor(
    () => !!q("pcp-dash-kpi-net-value") && !!q("pcp-dash-kpi-issues-value") && !!q("pcp-dash-kpi-skipped-value"),
    "the Payroll tab",
  );
}

/** The payslips listed, as "payroll-record-<id>" whether they are cards or table rows. */
const shownIds = () =>
  [...document.body.querySelectorAll('[data-testid^="payroll-record-"][data-status]')].map((a) =>
    a.getAttribute("data-testid")!.replace("payroll-record-row-", "payroll-record-"),
  );

/** One payslip of the list: its card, or its table row. */
const rec = (id: number) => q(`payroll-record-${id}`) ?? q(`payroll-record-row-${id}`);

describe("the dashboard of the period", () => {
  it("counts who is in the payroll against the cycle's roster, and what is still to be released", async () => {
    await openPayroll();
    expect(text(q("pcp-dash-kpi-employees"))).toContain("1 of 3");
    expect(text(q("pcp-dash-kpi-employees"))).toContain("on the Weekly cycle");
    expect(text(q("pcp-dash-kpi-gross-value"))).toBe("₹3,500");
    expect(text(q("pcp-dash-kpi-deductions-value"))).toBe("₹500");
    expect(text(q("pcp-dash-kpi-net-value"))).toBe("₹3,000");
    expect(text(q("pcp-dash-kpi-pending-value"))).toBe("₹3,000");
    expect(text(q("pcp-dash-kpi-pending"))).toContain("1 employee waiting");
  });

  it("says how many issues payroll detected, and how many employees it skipped", async () => {
    await openPayroll();
    // 3 detected + 1 skipped: the tile counts what the Issues view lists
    expect(text(q("pcp-dash-kpi-issues-value"))).toBe("4");
    expect(text(q("pcp-dash-kpi-skipped-value"))).toBe("1");
    expect(text(q("pcp-dash-kpi-skipped"))).toContain("of 3 checked");
    // the views carry the same counts: 3 detected + 1 skipped, and 1 skipped
    expect(text(q("view-issues-count"))).toBe("4");
    expect(text(q("view-skipped-count"))).toBe("1");
    expect(text(q("view-records-count"))).toBe("1");
  });

  it("opens the Issues view from the issues tile, and the Skipped view from the skipped tile", async () => {
    await openPayroll();
    click(must("pcp-dash-kpi-issues"));
    expect(params().view).toBe("issues");
    click(must("pcp-dash-kpi-skipped"));
    expect(params().view).toBe("skipped");
  });

  it("shows the shape of the dashboard while the figures are on their way", async () => {
    const release = world.hold("/api/payroll/production");
    mountPage(WEEKLY);
    await waitFor(() => !!q("pcp-dash-root"), "the dashboard");
    expect(q("pcp-dash-kpi-net-value")).toBeNull(); // a skeleton where the figure will be
    release();
    await waitFor(() => !!q("pcp-dash-kpi-net-value"), "the figures");
    expect(text(q("pcp-dash-kpi-net-value"))).toBe("₹3,000");
  });
});

describe("the Records view", () => {
  it("lists the payslips of the period as cards, with the issues and the rules of each employee", async () => {
    await openPayroll(`${WEEKLY}?layout=cards`);
    await waitFor(() => !!rec(11), "the card");
    expect(shownIds()).toEqual(["payroll-record-11"]); // Bala has no payslip yet
    const card = text(rec(11));
    expect(card).toContain("Asha Worker");
    expect(card).toContain("PC-W1 · Weaving");
    expect(card).toContain("7 shifts");
    expect(card).toContain("₹3,000");
    expect(card).toContain("Weekly"); // the pay cycle it was generated on
    expect(card).toContain("2 Feb - 8 Feb 2026");
    expect(card).toContain("3 Needs a look");
    expect(card).toContain("Absent ×1");
    await waitFor(() => text(rec(11)).includes("₹500 per shift"), "the rule chips");
    expect(text(rec(11))).toContain("Weekly cycle");
    expect(rec(11)!.getAttribute("aria-label")).toBe("Payroll of Asha Worker");
  });

  it("asks the server for this cycle and period only", async () => {
    await openPayroll();
    const asked = world.requests();
    expect(asked).toContain(
      "/api/payroll/production?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08&limit=500",
    );
    expect(asked).toContain("/api/payroll/production/issues?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08");
    expect(asked).toContain("/api/payroll/production/rules?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08");
    expect(asked).toContain(
      "/api/payroll/production/period-status?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08",
    );
    // never the heavy dry run: the Skipped view comes from the roster
    expect(asked.some((r) => r.includes("/skip-check"))).toBe(false);
  });

  it("shows skeleton rows while the payslips load, then the cards", async () => {
    const release = world.hold("/api/payroll/production");
    mountPage(WEEKLY);
    await waitFor(() => !!q("pcp-records"), "the list");
    expect(q("pcp-records")!.getAttribute("aria-busy")).toBe("true");
    expect(q("skeleton-rows")).not.toBeNull();
    expect(rec(11)).toBeNull();
    release();
    await waitFor(() => !!rec(11), "the cards");
    expect(q("skeleton-rows")).toBeNull();
  });

  it("says so, with a way to try again, when the payslips cannot be loaded", async () => {
    world.failing.set("/api/payroll/production", 500);
    mountPage(WEEKLY);
    await waitFor(() => !!q("pcp-records-error"), "the error");
    expect(text(q("pcp-records-error"))).toContain("The payroll records could not be loaded");
    world.failing.delete("/api/payroll/production");
    click(must("pcp-records-error").querySelector("button"));
    await waitFor(() => !!rec(11), "the cards");
    expect(q("pcp-records-error")).toBeNull();
  });

  it("filters by name and keeps the filter in the address", async () => {
    world.people = [...world.people.slice(0, 1), balaPaid(), world.people[2]];
    await openPayroll(`${WEEKLY}?q=bala`);
    await waitFor(() => !!rec(12), "the cards");
    expect(shownIds()).toEqual(["payroll-record-12"]);
    expect((must("pcp-pf-search") as HTMLInputElement).value).toBe("bala");
    expect(text(q("pcp-pf-count"))).toBe("Showing 1 of 2");
  });

  it("the pending tile shows only what is still to be released", async () => {
    world.people = [...world.people.slice(0, 1), balaPaid(), world.people[2]];
    await openPayroll();
    await waitFor(() => shownIds().length === 2, "both cards");
    click(must("pcp-dash-kpi-pending"));
    expect(params().status).toBe("pending");
    await waitFor(() => shownIds().length === 1, "the pending card");
    expect(shownIds()).toEqual(["payroll-record-11"]);
    click(must("pcp-pf-reset"));
    expect(params().status).toBeUndefined();
    await waitFor(() => shownIds().length === 2, "both cards again");
  });

  it("opens as a table, like Staff Payroll, offers Cards, and keeps the choice in the address", async () => {
    await openPayroll();
    await waitFor(() => !!rec(11), "the row");
    expect(must("pcp-records").dataset.layout).toBe("table");
    expect(q("payroll-record-row-11")).not.toBeNull();
    expect(text(q("payroll-record-row-11"))).toContain("Asha Worker");
    expect(text(q("payroll-record-row-11"))).toContain("₹3,000");
    click(must("payroll-record-layout-cards"));
    expect(params().layout).toBe("cards");
    expect(must("pcp-records").dataset.layout).toBe("cards");
    expect(q("payroll-record-11")).not.toBeNull();
    click(must("payroll-record-layout-table"));
    expect(params().layout).toBeUndefined();
  });

  it("opens a payslip's details on its own page", async () => {
    await openPayroll();
    await waitFor(() => !!q("payroll-record-details-11"), "the card");
    click(must("payroll-record-details-11"));
    expect(here()).toBe("/hr/production-payroll/details/11");
    expect(window.history.state).toEqual({ fromPayroll: true });
  });

  it("opens the details at the issues from the issue badges", async () => {
    await openPayroll();
    await waitFor(() => !!q("payroll-record-issues-11"), "the badges");
    click(must("payroll-record-issues-11"));
    expect(here()).toBe("/hr/production-payroll/details/11?section=issues");
  });

  it("marks a payslip paid, and the figures follow", async () => {
    await openPayroll();
    await waitFor(() => !!q("payroll-record-markpaid-11"), "the card");
    click(must("payroll-record-markpaid-11"));
    await waitFor(() => world.writes.length === 1, "the update");
    expect(world.writes[0]).toMatchObject({ method: "PATCH", url: "/api/payroll/11", body: { status: "paid" } });
    expect(h.toast).toHaveBeenCalledWith({ title: "Asha Worker's salary marked as cleared" });
    await waitFor(() => !q("payroll-record-markpaid-11"), "the button to go");
    expect(rec(11)!.getAttribute("data-status")).toBe("paid");
    await waitFor(() => text(q("pcp-dash-kpi-pending")).includes("Everything is released"), "the dashboard");
  });
});

describe("the empty states", () => {
  it("an empty roster says so and points to Production Employees", async () => {
    world.people = [];
    await openPayroll();
    await waitFor(() => !!q("pcp-empty-roster"), "the note");
    expect(text(q("pcp-empty-roster"))).toContain("No employees are assigned to the Weekly cycle yet");
    expect(must("pcp-empty-roster").querySelector('a[href="/hr/employees/productionEmployee"]')).not.toBeNull();
  });

  it("nothing generated yet says so and offers Generate Payroll", async () => {
    world.people = [BALA, ESHA];
    await openPayroll();
    await waitFor(() => !!q("pcp-empty-period"), "the note");
    expect(text(q("pcp-empty-period"))).toContain("No payroll generated for this period yet");
    expect(text(q("pcp-empty-period"))).toContain("2 Feb - 8 Feb 2026");
    click(must("pcp-empty-period").querySelector("button"));
    expect(q("pcp-generate-dialog")).not.toBeNull();
  });

  it("filters that match nothing say so and offer to reset", async () => {
    await openPayroll(`${WEEKLY}?q=zzz`);
    await waitFor(() => !!q("pcp-empty-filters"), "the note");
    expect(text(q("pcp-empty-filters"))).toContain("No payroll record matches these filters");
    click(must("pcp-empty-filters").querySelector("button"));
    expect(params().q).toBeUndefined();
    await waitFor(() => !!rec(11), "the card");
  });

  it("a pay period the server cannot work out says so, and the picker is the way out", async () => {
    world.failing.set("/api/payroll/production/period-status", 400);
    mountPage(WEEKLY);
    await waitFor(() => !!q("pcp-period-error"), "the error");
    expect(text(q("pcp-period-error"))).toContain("This pay period could not be loaded");
    expect(text(q("pcp-period-error"))).toContain("Pick another pay period above");
    expect(q("pcp-period")).not.toBeNull();
    expect(q("pcp-generate-open")).toBeNull();
  });

  it("a period that has not ended says so, and still opens the Generate dialog (which cannot be confirmed)", async () => {
    await openPayroll(`${WEEKLY}?period=2099-01-05_2099-01-11`);
    await waitFor(() => !!q("pcp-not-ended"), "the note");
    expect(text(q("pcp-not-ended"))).toContain("5 Jan - 11 Jan 2099 has not ended yet");
    click(must("pcp-generate-open"));
    expect(text(q("pcp-generate-dialog"))).toContain("This period has not ended yet");
    expect((must("pcp-generate-confirm") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the Skipped view", () => {
  it("lists the people the roster says cannot be generated, with the reason, and writes nothing", async () => {
    await openPayroll();
    click(must("pcp-skipped-open"));
    expect(params().view).toBe("skipped");
    await waitFor(() => !!q("skipped-banner-title"), "the Skipped view");
    expect(text(q("skipped-banner-title"))).toBe("1 of 3 employees was skipped");
    expect(text(q("skipped-row-PC-N1"))).toContain("Esha Worker");
    expect(text(q("skipped-row-PC-N1"))).toContain(NO_RATE);
    expect(text(q("skipped-row-PC-N1"))).toContain("Weaving");
    // it explains how to fix it
    expect(text(q("skipped-fix"))).toContain("salary per shift");
    expect(world.writes).toEqual([]);
    expect(world.requests().some((r) => r.includes("/skip-check"))).toBe(false);
  });

  it("says nobody is skipped when the whole roster can be generated", async () => {
    world.people = world.people.slice(0, 2);
    await openPayroll(`${WEEKLY}?view=skipped`);
    await waitFor(() => !!q("skipped-banner-title"), "the Skipped view");
    expect(text(q("skipped-banner-title"))).toBe("Nobody is skipped");
    expect(text(q("skipped-banner-hint"))).toContain("All 2 employees can be paid for 2 Feb - 8 Feb 2026");
  });

  it("Re-check asks the roster again", async () => {
    await openPayroll(`${WEEKLY}?view=skipped`);
    await waitFor(() => !!q("skipped-recheck"), "the Skipped view");
    const asked = () => world.requests().filter((r) => r.startsWith("/api/payroll/production/period-status")).length;
    expect(asked()).toBe(1);
    click(must("skipped-recheck"));
    await waitFor(() => asked() === 2, "the roster to be asked for again");
  });

  it("shows a loader while the roster is on its way", async () => {
    const release = world.hold("/api/payroll/production/period-status");
    mountPage(`${WEEKLY}?view=skipped`);
    await waitFor(() => !!q("skipped-loading"), "the loader");
    expect(q("skipped-banner-title")).toBeNull();
    release();
    await waitFor(() => !!q("skipped-banner-title"), "the Skipped view");
  });
});

describe("the Issues view", () => {
  it("lists each issue with the day it was detected, and the whole-period ones as such", async () => {
    await openPayroll(`${WEEKLY}?view=issues`);
    await waitFor(() => !!q("issues-list"), "the issues");
    const absent = must("issue-row-11:absent:2026-02-03");
    expect(text(absent.querySelector('[data-testid="issue-detected"]'))).toBe("Detected on Tue, 3 Feb 2026");
    expect(absent.querySelector('[data-testid="issue-detected"]')!.getAttribute("data-kind")).toBe("day");
    expect(text(absent.querySelector('[data-testid="issue-detail"]'))).toContain("no shift was earned");
    expect(text(absent)).toContain("Asha Worker");
    const bank = must("issue-row-11:bank_missing:period");
    expect(bank.querySelector('[data-testid="issue-detected"]')!.getAttribute("data-kind")).toBe("period");
    expect(text(bank.querySelector('[data-testid="issue-detected"]'))).toContain("Whole period");
    expect(world.requests()).toContain(
      "/api/payroll/production/issues?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08",
    );
  });

  it("adds the employee the roster says cannot be generated, beside what payroll detected", async () => {
    await openPayroll(`${WEEKLY}?view=issues`);
    await waitFor(() => !!q("issue-row-skipped:3"), "the skipped issue");
    expect(text(q("issue-row-skipped:3"))).toContain("Esha Worker");
    expect(text(q("issue-row-skipped:3"))).toContain(NO_RATE);
  });

  it("keeps its filters in the address, apart from the records' filters", async () => {
    await openPayroll(`${WEEKLY}?view=issues&q=bala`);
    await waitFor(() => !!q("issues-list"), "the issues");
    // `q` belongs to the records: the issues are not narrowed by it
    expect(document.body.querySelectorAll('[data-testid^="issue-row-"]').length).toBe(4);
    click(must("issues-kpi-warning"));
    expect(params()).toMatchObject({ view: "issues", q: "bala", isev: "warning" });
    expect(document.body.querySelectorAll('[data-testid^="issue-row-"]').length).toBe(3);
  });

  it("opens the payroll's details at its issues", async () => {
    await openPayroll(`${WEEKLY}?view=issues`);
    await waitFor(() => !!q("issue-row-11:absent:2026-02-03"), "the issue");
    click(must("issue-row-11:absent:2026-02-03").querySelector('[data-testid="issue-open-details"]'));
    expect(here()).toBe("/hr/production-payroll/details/11?section=issues");
  });
});

describe("the Rules view", () => {
  it("lists the rules of the cycle and the rules assigned to each employee", async () => {
    await openPayroll(`${WEEKLY}?view=rules`);
    await waitFor(() => !!q("rules-table"), "the rules");
    expect(text(q("rules-settings"))).toContain("Free late days");
    expect(text(q("rules-settings"))).toContain("2 free, then slabs");
    expect(text(q("rules-row-PC-W1"))).toContain("Asha Worker");
    expect(text(q("rules-row-PC-W1"))).toContain("₹500 per shift");
    expect(text(q("rules-row-PC-N1"))).toContain("No rate");
    expect(world.requests()).toContain(
      "/api/payroll/production/rules?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08",
    );
  });
});

describe("the Export menu", () => {
  const openMenu = async () => {
    press(must("pcp-export"), "Enter");
    await waitFor(() => !!q("pcp-export-statement-xlsx"), "the menu");
  };

  it("offers the printed Production Salary Statement as Excel and PDF, and no longer the register or CSV", async () => {
    await openPayroll();
    await waitFor(() => !!rec(11), "the records");
    await openMenu();
    expect(text(q("pcp-export-statement-xlsx"))).toContain("Production Salary Statement (Excel)");
    expect(text(q("pcp-export-statement-pdf"))).toContain("Production Salary Statement (PDF)");
    expect(text(q("pcp-export-statement-pdf"))).toContain("The printed statement for Weekly 2 Feb - 8 Feb 2026");
    expect(q("pcp-export-register-xlsx")).toBeNull();
    expect(q("pcp-export-register-csv")).toBeNull();
  });

  it("downloads the Report Center file for this cycle and pay period", async () => {
    await openPayroll();
    await waitFor(() => !!rec(11), "the records");
    await openMenu();
    click(must("pcp-export-statement-pdf"));
    await settle();
    await waitFor(() => h.download.mock.calls.length === 1, "the download");
    const sent = h.download.mock.calls[0][0];
    expect(sent).toMatchObject({
      reportId: "hr-production-salary-statement",
      format: "pdf",
      title: "Production Salary Statement Weekly 2 Feb - 8 Feb 2026",
    });
    expect(sent.query.toString()).toBe("cycle=weekly&dateFrom=2026-02-02&dateTo=2026-02-08");
    // the menu closes once the file is saved; Excel is the same report
    await waitFor(() => !q("pcp-export-statement-pdf"), "the menu to close");
    await openMenu();
    click(must("pcp-export-statement-xlsx"));
    await settle();
    await waitFor(() => h.download.mock.calls.length === 2, "the second download");
    expect(h.download.mock.calls[1][0]).toMatchObject({ reportId: "hr-production-salary-statement", format: "xlsx" });
  });

  it("covers every department, and only Cleared or only Pending when the page shows that", async () => {
    world.people = [...world.people.slice(0, 1), balaPaid(), world.people[2]];
    await openPayroll(`${WEEKLY}?status=paid`);
    await waitFor(() => !!rec(12), "the record");
    await openMenu();
    click(must("pcp-export-statement-xlsx"));
    await settle();
    await waitFor(() => h.download.mock.calls.length === 1, "the download");
    expect(h.download.mock.calls[0][0].query.toString()).toBe(
      "cycle=weekly&dateFrom=2026-02-02&dateTo=2026-02-08&paymentStatus=paid",
    );
  });

  it("says why when the file cannot be made", async () => {
    h.download.mockRejectedValueOnce(new Error("Your role does not have access to the data in this report."));
    await openPayroll();
    await waitFor(() => !!rec(11), "the records");
    await openMenu();
    click(must("pcp-export-statement-pdf"));
    await settle();
    await waitFor(() => h.toast.mock.calls.length > 0, "the toast");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not export Production Salary Statement (PDF)",
        description: "Your role does not have access to the data in this report.",
        variant: "destructive",
      }),
    );
  });

  it("shows a TDS employee's TDS on the record", async () => {
    // Asha is on the TDS list: 10% of her 3,500 earned gross is TDS, and it is part of her 350 deductions
    world.people = [
      person(1, "Asha Worker", "PC-W1", {
        payroll: payroll(11, 1, "Asha Worker", "PC-W1", {
          deductions: 350,
          tdsDeduction: 350,
          tdsPercent: 10,
          finalSalary: 3150,
        }),
      }),
      world.people[1],
      world.people[2],
    ];
    await openPayroll(`${WEEKLY}?layout=cards`);
    await waitFor(() => !!rec(11), "the card");
    expect(text(q("payroll-record-tds-11"))).toBe("TDS (10%)₹350");
  });

  it("the bank transfer file is a button of its own, for the payslips of every department on screen", async () => {
    world.people = [
      world.people[0],
      person(2, "Bala Worker", "PC-W2", {
        departmentName: "Packing",
        payroll: payroll(12, 2, "Bala Worker", "PC-W2", { departmentId: 7, departmentName: "Packing" }),
      }),
      world.people[2],
    ];
    await openPayroll();
    await waitFor(() => !!q("pcp-dept-tabs"), "the department tabs");
    click(must("pcp-export-bank"));
    expect(h.bank).toHaveBeenCalledTimes(1);
    const [rows, label, stem] = h.bank.mock.calls[0];
    expect(rows.map((r: { id: number }) => r.id).sort()).toEqual([11, 12]);
    expect(label).toBe("Production");
    expect(stem).toBe("Weekly_2026-02-02_2026-02-08");
  });

  it("has nothing to export for a period with no payroll", async () => {
    world.people = [BALA, ESHA];
    await openPayroll();
    await waitFor(() => !!q("pcp-empty-period"), "the note");
    expect((must("pcp-export-bank") as HTMLButtonElement).disabled).toBe(true);
    await openMenu();
    expect(must("pcp-export-statement-xlsx").getAttribute("aria-disabled")).toBe("true");
    expect(must("pcp-export-statement-pdf").getAttribute("aria-disabled")).toBe("true");
  });
});

describe("one department at a time", () => {
  const twoDepartments = () => {
    world.people = [
      world.people[0],
      person(2, "Bala Worker", "PC-W2", {
        departmentName: "Packing",
        payroll: payroll(12, 2, "Bala Worker", "PC-W2", { departmentId: 7, departmentName: "Packing" }),
      }),
      world.people[2],
    ];
  };

  it("opens the first department by name, and the count still covers every department", async () => {
    twoDepartments();
    await openPayroll();
    await waitFor(() => !!q("pcp-dept-tabs") && shownIds().length === 1, "the tabs");
    expect(text(q("pcp-dept-tab-7"))).toContain("Packing");
    expect(must("pcp-dept-tab-7").getAttribute("aria-pressed")).toBe("true");
    expect(must("pcp-dept-tab-4").getAttribute("aria-pressed")).toBe("false");
    expect(shownIds()).toEqual(["payroll-record-12"]);
    expect(text(q("pcp-dept-summary"))).toContain("Packing · 1 employee");
    expect(text(q("pcp-record-count"))).toBe("2 Feb - 8 Feb 2026 · 2 records");
    expect(text(q("view-records-count"))).toBe("2");
  });

  it("switches department with a tab and keeps it in the address", async () => {
    twoDepartments();
    await openPayroll();
    await waitFor(() => !!q("pcp-dept-tab-4"), "the tabs");
    click(must("pcp-dept-tab-4"));
    expect(params().pdept).toBe("4");
    await waitFor(() => shownIds()[0] === "payroll-record-11", "Weaving");
    expect(shownIds()).toEqual(["payroll-record-11"]);
  });

  it("opens the department the address names", async () => {
    twoDepartments();
    await openPayroll(`${WEEKLY}?pdept=4`);
    await waitFor(() => shownIds().length === 1, "the records");
    expect(shownIds()).toEqual(["payroll-record-11"]);
    expect(must("pcp-dept-tab-4").getAttribute("aria-pressed")).toBe("true");
  });

  it("has no department filter in the filter bar: the tabs pick the department", async () => {
    twoDepartments();
    await openPayroll(`${WEEKLY}?dept=4`);
    await waitFor(() => !!q("pcp-dept-tabs"), "the tabs");
    expect(q("pcp-pf-dept")).toBeNull();
    // an old address naming a department filter is ignored: both departments are still there as tabs
    expect(q("pcp-dept-tab-7")).not.toBeNull();
    expect(q("pcp-dept-tab-4")).not.toBeNull();
  });

  it("the tabs follow the filters", async () => {
    twoDepartments();
    await openPayroll(`${WEEKLY}?q=asha`);
    await waitFor(() => !!q("pcp-dept-tab-4"), "the tabs");
    expect(q("pcp-dept-tab-7")).toBeNull();
    expect(shownIds()).toEqual(["payroll-record-11"]);
  });
});

describe("a View Only role", () => {
  it("can browse, filter and export, but not generate, pay or write the bank file", async () => {
    await openPayroll();
    await waitFor(() => !!q("payroll-record-markpaid-11") && !!q("payroll-record-details-11"), "the card");
    lockMutatingControls(document.body);
    // everything that changes something is locked
    expect((must("pcp-generate-open") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pcp-export-bank") as HTMLButtonElement).disabled).toBe(true);
    expect((must("payroll-record-markpaid-11") as HTMLButtonElement).disabled).toBe(true);
    // everything that only reads stays usable
    expect((must("pcp-export") as HTMLButtonElement).disabled).toBe(false);
    expect((must("pcp-skipped-open") as HTMLButtonElement).disabled).toBe(false);
    expect((must("payroll-record-details-11") as HTMLButtonElement).disabled).toBe(false);
    for (const view of ["records", "issues", "skipped", "rules"]) {
      expect((must(`view-${view}`) as HTMLButtonElement).disabled).toBe(false);
    }
    expect((must("pcp-period") as HTMLButtonElement).disabled).toBe(false);
    // and the export menu works
    press(must("pcp-export"), "Enter");
    await waitFor(() => !!q("pcp-export-statement-xlsx"), "the menu");
    lockMutatingControls(document.body);
    click(must("pcp-export-statement-xlsx"));
    await settle();
    await waitFor(() => h.download.mock.calls.length === 1, "the export");
  });
});

describe("Generate Payroll", () => {
  const openDialog = async () => {
    await openPayroll();
    await waitFor(() => !(must("pcp-generate-open") as HTMLButtonElement).disabled, "Generate Payroll to be ready");
    click(must("pcp-generate-open"));
    return must("pcp-generate-dialog");
  };

  it("says who it will compute and who is left alone, then asks for exactly that cycle and period", async () => {
    const dialog = await openDialog();
    expect(text(dialog)).toContain("Generate Weekly Payroll");
    expect(text(q("pcp-generate-period"))).toBe("2 Feb - 8 Feb 2026");
    expect(text(q("pcp-generate-ready"))).toBe("1 employee");
    expect(text(dialog)).toContain("1 employee already has payroll");
    expect(text(dialog)).toContain("1 employee cannot be generated");
    // who cannot be generated, and why
    expect(text(q("pcp-generate-who"))).toContain("Esha Worker");
    expect(text(q("pcp-generate-who"))).toContain(NO_RATE);
    expect(text(dialog)).toContain("This period has ended - ready to generate.");
    click(must("pcp-generate-confirm"));
    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(h.trigger).toHaveBeenCalledWith({ cycle: "weekly", periodStart: "2026-02-02", periodEnd: "2026-02-08" });
    expect(q("pcp-generate-dialog")).toBeNull();
  });

  it("keeps the page on the period it was started for", async () => {
    await openDialog();
    expect(params().period).toBeUndefined();
    click(must("pcp-generate-confirm"));
    expect(params().period).toBe(WEEK_PARAM);
  });

  it("shows the rules the run will use, with a link to change them", async () => {
    const dialog = await openDialog();
    await waitFor(() => !q("pcp-generate-rules-loading"), "the rules");
    const rules = text(q("pcp-generate-rules"));
    expect(rules).toContain("7 days, weeks run Monday to Sunday");
    expect(rules).toContain("Strict attendance");
    expect(rules).toContain("Late: 2 free, 1 slab");
    const link = dialog.querySelector<HTMLAnchorElement>('a[href="/hr/settings?tab=production_payroll"]');
    expect(text(link)).toBe("Review in Settings");
  });

  it("says how PF, ESI and TDS apply: Co Emp employees only, by the rules set for Production", async () => {
    const dialog = await openDialog();
    await waitFor(() => !q("pcp-generate-rules-loading") && !q("pcp-generate-statutory-loading"), "the rules");
    expect(text(q("pcp-generate-statutory"))).toBe("PF: 1 rule · ESI: 0 rules");
    expect(q("pcp-generate-statutory")!.dataset.state).toBe("set");
    const note = text(q("pcp-generate-statutory-note"));
    expect(note).toContain("PF and ESI are deducted only from Co Emp employees");
    expect(note).toContain("Employees on the TDS list have TDS deducted at their own percentage instead");
    expect(dialog.querySelector('a[href="/hr/settings?tab=pf_esi"]')).not.toBeNull();
    expect(dialog.querySelector('a[href="/hr/employees"]')).not.toBeNull();
    // the old description of the old model is gone
    expect(text(dialog)).not.toContain("with the production rates");
    expect(q("pcp-generate-statutory-note-none")).toBeNull();
    expect(world.requests()).toContain("/api/pf-esi-settings");
  });

  it("says so when no PF or ESI rule is set for Production, and stays silent when the rules cannot be read", async () => {
    world.pfEsi = { ...world.pfEsi, production: { pfRules: [], esiRules: [] } };
    await openDialog();
    await waitFor(() => !!q("pcp-generate-statutory") && !q("pcp-generate-statutory-loading"), "the rules");
    expect(text(q("pcp-generate-statutory"))).toBe("No PF or ESI rules are set for Production");
    expect(q("pcp-generate-statutory")!.dataset.state).toBe("none");
    expect(text(q("pcp-generate-statutory-note-none"))).toContain("nobody will have PF or ESI deducted");
  });

  it("does not claim the rules are empty when the server would not tell", async () => {
    world.failing.set("/api/pf-esi-settings", 403);
    await openDialog();
    await waitFor(() => !!q("pcp-generate-statutory") && !q("pcp-generate-statutory-loading"), "the rules");
    expect(q("pcp-generate-statutory")!.dataset.state).toBe("unknown");
    expect(text(q("pcp-generate-statutory"))).toBe("PF / ESI: Co Emp employees only");
    expect(q("pcp-generate-statutory-note-none")).toBeNull();
  });

  it("follows the week start the Settings page has saved", async () => {
    world.settings = {
      ...world.settings,
      prodCycles: {
        weekly: { weekStart: "wednesday", anchorDate: null, lateFreeAllowance: 0, lateSlabs: [], ownLateRules: true },
      },
      prodLateDetectionEnabled: false,
    };
    await openDialog();
    await waitFor(() => !q("pcp-generate-rules-loading"), "the rules");
    expect(text(q("pcp-generate-rules"))).toContain("weeks run Wednesday to Tuesday");
    expect(text(q("pcp-generate-rules"))).toContain("Late detection off");
  });

  it("checks who would be skipped only when asked, with the engine's own dry run", async () => {
    await openDialog();
    expect(world.requests().some((r) => r.includes("/skip-check"))).toBe(false);
    click(must("pcp-generate-check"));
    await waitFor(() => !!q("pcp-generate-skips"), "the result");
    expect(world.requests()).toContain(
      "/api/payroll/production/skip-check?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08",
    );
    expect(text(q("pcp-generate-skips"))).toContain("1 of 3 would be skipped");
    expect(text(q("pcp-generate-skips"))).toContain("1 already have payroll and are left alone");
    expect(text(q("pcp-generate-skips"))).toContain("Esha Worker");
    expect(world.writes).toEqual([]);
  });

  it("says when nobody would be skipped", async () => {
    world.skipCheck = { ...world.skipCheck, skippedCount: 0, skipped: [], alreadyGenerated: 0, totalChecked: 2 };
    await openDialog();
    click(must("pcp-generate-check"));
    await waitFor(() => !!q("pcp-generate-skips-none"), "the result");
    expect(text(q("pcp-generate-skips-none"))).toContain("Nobody would be skipped: all 2 employees can be paid");
  });

  it("will not start a second run while one is in progress", async () => {
    h.generating.current = true;
    await openPayroll();
    click(must("pcp-generate-open"));
    const confirm = must("pcp-generate-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(text(confirm)).toContain("A run is already in progress");
    click(confirm);
    expect(h.trigger).not.toHaveBeenCalled();
  });

  it("cannot be confirmed when nobody is left to generate", async () => {
    world.people = world.people.slice(0, 1).concat(world.people[2]);
    await openPayroll();
    await waitFor(() => !(must("pcp-generate-open") as HTMLButtonElement).disabled, "Generate Payroll to be ready");
    click(must("pcp-generate-open"));
    expect(text(q("pcp-generate-ready"))).toBe("0 employees");
    expect((must("pcp-generate-confirm") as HTMLButtonElement).disabled).toBe(true);
  });

  it("can be cancelled without starting anything", async () => {
    const dialog = await openDialog();
    click([...dialog.querySelectorAll("button")].find((b) => text(b) === "Cancel"));
    await waitFor(() => !q("pcp-generate-dialog"), "the dialog to close");
    expect(h.trigger).not.toHaveBeenCalled();
    expect(params().period).toBeUndefined();
  });
});
