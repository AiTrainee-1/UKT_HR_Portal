import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getListProductionPayrollQueryKey,
  getProductionCyclesQueryKey,
  getProductionPeriodStatusQueryKey,
  getProductionPeriodsQueryKey,
  type CycleSummary,
  type PayCycle,
  type PeriodEmployee,
  type ProductionCyclesSummary,
  type ProductionPayrollItem,
  type ProductionPeriods,
  type ProductionPeriodStatus,
} from "@/lib/api-client/custom-hooks";
import ProductionCyclePage from "./ProductionCyclePage";

// The pages of Production Payroll (Weekly / BiWeekly / Monthly) with a filled query cache (nothing is fetched): who is
// on the page, what a "Generate" click asks the server for (the cycle, the period and, for one person, their id), and
// the states a cycle can be in (set up, not set up, nobody assigned).

const run = vi.hoisted(() => ({ trigger: vi.fn() }));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/contexts/PayrollGenerationContext", () => ({
  usePayrollGeneration: () => ({
    isGenerating: false,
    showPipeline: false,
    progress: undefined,
    lastResult: null,
    triggerGenerate: vi.fn(),
    triggerGenerateProduction: run.trigger,
    dismiss: vi.fn(),
  }),
}));
vi.mock("@/contexts/SalarySlipBulkContext", () => ({
  useSalarySlipBulk: () => ({
    isRunning: false,
    kind: null,
    showPipeline: false,
    progress: undefined,
    lastEmailResult: null,
    triggerBulkDownload: vi.fn(),
    triggerBulkEmail: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("@/contexts/WhatsAppBulkContext", () => ({
  useWhatsAppBulk: () => ({
    isRunning: false,
    showPipeline: false,
    progress: undefined,
    lastResult: null,
    triggerBulkWhatsApp: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "t", user: null }) }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

beforeEach(() => {
  run.trigger.mockReset();
  run.trigger.mockResolvedValue(null);
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const WEEK = { periodStart: "2026-02-02", periodEnd: "2026-02-08" };

const payroll = (id: number, employeeId: number, name: string, code: string, over = {}): ProductionPayrollItem =>
  ({
    id,
    employeeId,
    employeeName: name,
    employeeCode: code,
    departmentId: 4,
    departmentName: "Weaving",
    salaryMode: "shift",
    month: 2,
    year: 2026,
    periodStart: WEEK.periodStart,
    periodEnd: WEEK.periodEnd,
    totalWorkingDays: 7,
    presentDays: 7,
    absentDays: 0,
    otHours: 0,
    otAmount: 0,
    baseSalary: 3500,
    grossSalary: 3500,
    deductions: 500,
    bonus: 0,
    finalSalary: 3000,
    status: "pending",
    bankAccount: "",
    bankIfsc: "",
    bankName: "",
    email: "",
    payCycle: "weekly",
    ...over,
  }) as ProductionPayrollItem;

const person = (id: number, name: string, code: string, over: Partial<PeriodEmployee> = {}): PeriodEmployee => ({
  employeeId: id,
  employeeCode: code,
  name,
  departmentName: "Weaving",
  salaryPerShift: 500,
  payroll: null,
  blockedReason: null,
  ...over,
});

const weeklyPeople: PeriodEmployee[] = [
  person(1, "Asha Worker", "PC-W1", { payroll: payroll(11, 1, "Asha Worker", "PC-W1") }),
  person(2, "Bala Worker", "PC-W2"),
  person(3, "Esha Worker", "PC-N1", {
    salaryPerShift: null,
    blockedReason: "No Salary Per Shift set on this employee's profile",
  }),
];

const summaryOf = (cycle: PayCycle, over: Partial<CycleSummary> = {}): CycleSummary => ({
  cycle,
  label: { weekly: "Weekly", biweekly: "BiWeekly", monthly: "Monthly" }[cycle],
  days: { weekly: 7, biweekly: 14, monthly: 28 }[cycle],
  assigned: cycle === "weekly" ? 3 : 0,
  configured: true,
  configError: null,
  weekStart: "monday",
  anchorDate: "2026-02-02",
  next: { ...WEEK, periodEnded: true },
  pending: { records: 1, employees: 1, amount: 3000 },
  ...over,
});

function mount(
  cycle: PayCycle,
  opts: { unassigned?: number; summaries?: CycleSummary[]; people?: PeriodEmployee[] } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const people = opts.people ?? weeklyPeople;
  const cycles: ProductionCyclesSummary = {
    cycles: opts.summaries ?? (["weekly", "biweekly", "monthly"] as PayCycle[]).map((c) => summaryOf(c)),
    totalProduction: 6,
    unassigned: opts.unassigned ?? 0,
  };
  client.setQueryData(getProductionCyclesQueryKey(), cycles);
  const periods: ProductionPeriods = {
    cycle,
    label: summaryOf(cycle).label,
    days: summaryOf(cycle).days,
    roster: people.length,
    periods: [
      { ...WEEK, periodEnded: true, isNext: true, generated: 1, paid: 0 },
      { periodStart: "2026-01-26", periodEnd: "2026-02-01", periodEnded: true, isNext: false, generated: 0, paid: 0 },
    ],
  };
  client.setQueryData(getProductionPeriodsQueryKey(cycle, null), periods);
  const status: ProductionPeriodStatus = {
    cycle,
    label: periods.label,
    ...WEEK,
    periodEnded: true,
    counts: {
      generated: people.filter((p) => p.payroll && p.payroll.status !== "paid").length,
      paid: people.filter((p) => p.payroll?.status === "paid").length,
      ready: people.filter((p) => !p.payroll && !p.blockedReason).length,
      blocked: people.filter((p) => !p.payroll && p.blockedReason).length,
    },
    employees: people,
  };
  client.setQueryData(getProductionPeriodStatusQueryKey(cycle, WEEK), status);
  client.setQueryData(
    getListProductionPayrollQueryKey({ cycle, periodStart: WEEK.periodStart, periodEnd: WEEK.periodEnd, limit: 500 }),
    people.flatMap((p) => (p.payroll ? [p.payroll as ProductionPayrollItem] : [])),
  );
  client.setQueryData(
    getListProductionPayrollQueryKey({ cycle, limit: 500 }),
    people.flatMap((p) => (p.payroll ? [p.payroll as ProductionPayrollItem] : [])),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(createElement(QueryClientProvider, { client }, createElement(ProductionCyclePage, { cycle }))),
  );
  return host;
}

const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ");
const q = (el: Element | Document, id: string) => el.querySelector(`[data-testid="${id}"]`);
const tab = (el: Element, name: string) =>
  [...el.querySelectorAll('[role="tab"]')].find((t) => text(t).trim().startsWith(name));

describe("a Production Payroll cycle page", () => {
  it("names its cycle, what the period is, and the people it pays", () => {
    const el = mount("weekly");
    expect(text(q(el, "pcp-cycle-badge"))).toBe("Weekly");
    expect(text(el.querySelector("h2")!.parentElement!.querySelector("p"))).toContain("One-week calculation");
    expect(text(el.querySelector("h2")!.parentElement!.querySelector("p"))).toContain("7-day pay period");
    expect(q(el, "production-payroll-weekly")).not.toBeNull();
    expect(text(el)).toContain("Production Employees(3)");
    expect(text(tab(el, "Employees") ?? null)).toContain("3");
  });

  it("shows the other cycles with their own length", () => {
    expect(text(q(mount("biweekly"), "pcp-cycle-badge"))).toBe("BiWeekly");
    act(() => root?.unmount());
    host?.remove();
    const month = mount("monthly");
    expect(text(month.querySelector("h2")!.parentElement!.querySelector("p"))).toContain("Four-week calculation");
    expect(text(month.querySelector("h2")!.parentElement!.querySelector("p"))).toContain("28-day pay period");
  });

  it("opens on the next due period, with its figures and the payslips generated for it", () => {
    const el = mount("weekly");
    expect(text(q(el, "pcp-period"))).toContain("2 Feb - 8 Feb 2026");
    expect(text(q(el, "pcp-period"))).toContain("next due");
    expect(text(q(el, "pcp-rows"))).toContain("Asha Worker");
    expect(text(q(el, "pcp-rows"))).not.toContain("Bala Worker"); // nothing generated for them yet
    expect(text(q(el, "pcp-kpi-roster"))).toContain("3");
    expect(text(q(el, "pcp-kpi-net"))).toContain("₹3,000");
    expect(text(q(el, "pcp-kpi-todo"))).toContain("2"); // Bala (ready) + Esha (blocked)
    expect(text(q(el, "pcp-kpi-todo"))).toContain("1 cannot be generated");
  });

  it("Generate Payroll says who it will compute and who is left alone, then asks for exactly that cycle and period", () => {
    const el = mount("weekly");
    click(q(el, "pcp-generate-open"));
    const dialog = q(document, "pcp-generate-dialog")!;
    expect(text(dialog)).toContain("Generate Weekly Payroll");
    expect(text(q(document, "pcp-generate-period"))).toBe("2 Feb - 8 Feb 2026");
    expect(text(q(document, "pcp-generate-ready"))).toBe("1 employee");
    expect(text(dialog)).toContain("1 employee already has payroll");
    expect(text(dialog)).toContain("1 employee cannot be generated");
    click(q(document, "pcp-generate-confirm"));
    expect(run.trigger).toHaveBeenCalledTimes(1);
    expect(run.trigger).toHaveBeenCalledWith({ cycle: "weekly", periodStart: "2026-02-02", periodEnd: "2026-02-08" });
  });

  it("an empty roster says so and points to Production Employees", () => {
    const el = mount("weekly", { people: [] });
    expect(text(q(el, "pcp-empty-roster"))).toContain("No employees are assigned to the Weekly cycle yet");
    expect(el.querySelector('a[href="/hr/employees/productionEmployee"]')).not.toBeNull();
  });

  it("reminds that some production employees are in no cycle", () => {
    expect(q(mount("weekly", { unassigned: 0 }), "pcp-unassigned-notice")).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    const el = mount("weekly", { unassigned: 4 });
    expect(text(q(el, "pcp-unassigned-notice"))).toContain(
      "4 production employees are not assigned to a pay cycle yet",
    );
  });

  it("a cycle with no first period start asks for it instead of showing a period", () => {
    const el = mount("biweekly", {
      summaries: [
        summaryOf("weekly"),
        summaryOf("biweekly", {
          configured: false,
          configError: "Set the first period start date for BiWeekly in Settings -> Production Payroll -> BiWeekly.",
          next: null,
        }),
        summaryOf("monthly"),
      ],
    });
    expect(text(q(el, "pcp-setup-needed"))).toContain("BiWeekly payroll is not set up yet");
    expect(text(q(el, "pcp-setup-needed"))).toContain("Set the first period start date for BiWeekly");
    expect(el.querySelector('a[href*="biweekly-first-period"]')).not.toBeNull();
    expect(q(el, "pcp-generate-open")).toBeNull();
    click(tab(el, "Employees")!);
    expect(q(el, "pcp-setup-needed")).not.toBeNull();
    // the history tabs still work
    click(tab(el, "Salary")!);
    expect(q(el, "pcp-salary-tab")).not.toBeNull();
  });
});

describe("the Employees tab of a cycle", () => {
  it("lists only the roster, each with what they have for the period", () => {
    const el = mount("weekly");
    click(tab(el, "Employees")!);
    expect(text(q(el, "pcp-roster-counts"))).toContain("3 on the Weekly cycle");
    expect(text(q(el, "pcp-roster-state-PC-W1"))).toBe("Generated - pending");
    expect(text(q(el, "pcp-roster-state-PC-W2"))).toBe("Not generated");
    expect(text(q(el, "pcp-roster-state-PC-N1"))).toBe("Cannot be generated");
    expect(text(q(el, "pcp-roster-row-PC-N1"))).toContain("No Salary Per Shift");
    expect(text(q(el, "pcp-roster-row-PC-N1"))).toContain("Not set");
    expect(q(el, "pcp-roster-row-PC-U1")).toBeNull();
  });

  it("generates one employee on their own", () => {
    const el = mount("weekly");
    click(tab(el, "Employees")!);
    expect(q(el, "pcp-generate-PC-W1")).toBeNull(); // already has payroll
    expect(q(el, "pcp-generate-PC-N1")).toBeNull(); // blocked
    click(q(el, "pcp-generate-PC-W2"));
    expect(run.trigger).toHaveBeenCalledWith({
      cycle: "weekly",
      periodStart: "2026-02-02",
      periodEnd: "2026-02-08",
      employeeIds: [2],
      regenerate: false,
    });
  });

  it("a pending payslip is generated again only after a confirmation that says what it replaces", () => {
    const el = mount("weekly");
    click(tab(el, "Employees")!);
    click(q(el, "pcp-regenerate-PC-W1"));
    const dialog = q(document, "pcp-regenerate-dialog")!;
    expect(text(dialog)).toContain("Generate again for Asha Worker?");
    expect(text(dialog)).toContain("Anything you adjusted on it");
    expect(run.trigger).not.toHaveBeenCalled();
    click(q(document, "pcp-regenerate-confirm"));
    expect(run.trigger).toHaveBeenCalledWith({
      cycle: "weekly",
      periodStart: "2026-02-02",
      periodEnd: "2026-02-08",
      employeeIds: [1],
      regenerate: true,
    });
  });

  it("a paid payslip offers no way to generate again", () => {
    const paid = [
      person(1, "Asha Worker", "PC-W1", { payroll: payroll(11, 1, "Asha Worker", "PC-W1", { status: "paid" }) }),
    ];
    const el = mount("weekly", { people: paid });
    click(tab(el, "Employees")!);
    expect(text(q(el, "pcp-roster-state-PC-W1"))).toBe("Paid");
    expect(q(el, "pcp-regenerate-PC-W1")).toBeNull();
    expect(q(el, "pcp-generate-PC-W1")).toBeNull();
  });

  it("several ready employees can be generated together, and only the ready ones can be selected", () => {
    const people = [person(1, "Asha Worker", "PC-W1"), person(2, "Bala Worker", "PC-W2"), ...weeklyPeople.slice(2)];
    const el = mount("weekly", { people });
    click(tab(el, "Employees")!);
    expect(q(el, "pcp-roster-select-PC-N1")).toBeNull();
    click(q(el, "pcp-roster-select-PC-W1"));
    click(q(el, "pcp-roster-select-PC-W2"));
    expect(text(q(el, "pcp-roster-bulk"))).toContain("2 selected");
    click(q(el, "pcp-generate-selected"));
    expect(run.trigger).toHaveBeenCalledWith({
      cycle: "weekly",
      periodStart: "2026-02-02",
      periodEnd: "2026-02-08",
      employeeIds: [1, 2],
      regenerate: false,
    });
  });
});

describe("the Salary tab of a cycle", () => {
  it("lists the cycle's payslips across periods", () => {
    const el = mount("weekly");
    click(tab(el, "Salary")!);
    expect(text(q(el, "pcp-salary-row-11"))).toContain("Asha Worker");
    expect(text(q(el, "pcp-salary-row-11"))).toContain("2026-02-02 – 2026-02-08");
  });
});
