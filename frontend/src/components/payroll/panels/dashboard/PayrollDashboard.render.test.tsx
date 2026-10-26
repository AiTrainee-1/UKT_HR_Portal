import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PayrollIssuesSummary, PayrollRunItem } from "@/lib/api-client/custom-hooks";
import { PayrollDashboard, type PayrollDashboardProps } from "./PayrollDashboard";

// The dashboard in jsdom: a skeleton in every tile while its figure loads, the figures, the tiles and bars that are
// buttons (and the ones that are not when the page gives no handler), the three charts, and their empty states.

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const run = (id: number, over: Partial<PayrollRunItem> = {}): PayrollRunItem => ({
  id,
  employeeId: id * 10,
  employeeName: `Employee ${id}`,
  employeeCode: `E${id}`,
  departmentId: 1,
  departmentName: "Weaving",
  salaryMode: "monthly",
  month: 10,
  year: 2026,
  totalWorkingDays: 26,
  presentDays: 26,
  absentDays: 0,
  otHours: 0,
  otAmount: 0,
  baseSalary: 30000,
  grossSalary: 30000,
  deductions: 3000,
  bonus: 0,
  finalSalary: 27000,
  status: "pending",
  ...over,
});

const RUNS: PayrollRunItem[] = [
  run(1, { status: "paid", departmentId: 1, departmentName: "Weaving" }), // 27,000 paid
  run(2, { departmentId: 2, departmentName: "Stitching", grossSalary: 20000, deductions: 2000, finalSalary: 18000 }),
  run(3, { departmentId: 2, departmentName: "Stitching", grossSalary: 10000, deductions: 1000, finalSalary: 9000 }),
];
// gross 60,000 · deductions 6,000 · net 54,000 · paid 27,000 · pending 27,000 (2 employees)

const ISSUES: PayrollIssuesSummary = {
  employees: 3,
  employeesWithIssues: 2,
  total: 17,
  bySeverity: { critical: 2, warning: 12, info: 3 },
  byCode: [
    { code: "late_in", label: "Late arrival", severity: "warning", category: "attendance", count: 9 },
    { code: "absent", label: "Absent", severity: "critical", category: "attendance", count: 2 },
    { code: "late_penalty", label: "Late deduction", severity: "warning", category: "pay", count: 3 },
    { code: "ot_pay", label: "Overtime pay", severity: "info", category: "pay", count: 3 },
  ],
  byDepartment: [{ department: "Stitching", count: 12 }],
};

function mount(over: Partial<PayrollDashboardProps> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(PayrollDashboard, {
        kind: "staff",
        accent: "indigo",
        periodLabel: "October 2026",
        runs: RUNS,
        expected: { count: 4, label: "active staff" },
        issues: ISSUES,
        skipped: { count: 1, total: 4 },
        ...over,
      }),
    ),
  );
  return host;
}

const q = (id: string) => host!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the dashboard shows: ${text(host)}`);
  return el;
};
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const skeletons = (el: Element | null) => el?.querySelectorAll('[data-slot="skeleton"]').length ?? 0;

const TILES = ["employees", "gross", "deductions", "net", "pending", "issues", "skipped"] as const;

describe("while it loads", () => {
  it("every tile shows its own skeleton and no figure", () => {
    mount({
      loading: true,
      issuesLoading: true,
      skippedLoading: true,
      runs: undefined,
      issues: undefined,
      skipped: undefined,
    });
    for (const tile of TILES) {
      expect(skeletons(must(`dash-kpi-${tile}`)), tile).toBeGreaterThan(0);
      expect(q(`dash-kpi-${tile}-value`), tile).toBeNull();
    }
    expect(q("dash-card-payment-loading")).not.toBeNull();
    expect(q("dash-card-departments-loading")).not.toBeNull();
    expect(q("dash-card-issues-loading")).not.toBeNull();
  });

  it("each part loads on its own: the payroll figures show while the issues and the skipped list are still coming", () => {
    mount({ issuesLoading: true, skippedLoading: true, issues: undefined, skipped: undefined });
    expect(text(must("dash-kpi-net-value"))).toBe("₹54,000");
    expect(q("dash-kpi-issues-value")).toBeNull();
    expect(skeletons(must("dash-kpi-issues"))).toBeGreaterThan(0);
    expect(skeletons(must("dash-kpi-skipped"))).toBeGreaterThan(0);
    expect(q("dash-card-payment-loading")).toBeNull();
    expect(q("dash-card-issues-loading")).not.toBeNull();
  });

  it("the payroll figures wait for the payroll, the issues tile does not", () => {
    mount({ loading: true });
    expect(q("dash-kpi-gross-value")).toBeNull();
    expect(text(must("dash-kpi-issues-value"))).toBe("17");
  });
});

describe("the figures", () => {
  it("shows the payroll's totals, and who is in it out of who is expected", () => {
    mount();
    expect(text(must("dash-kpi-employees"))).toContain("Employees in payroll");
    expect(text(must("dash-kpi-employees-value"))).toBe("3 of 4");
    expect(text(must("dash-kpi-employees"))).toContain("active staff");
    expect(text(must("dash-kpi-gross-value"))).toBe("₹60,000");
    expect(text(must("dash-kpi-gross"))).toContain("3 payslips");
    expect(text(must("dash-kpi-deductions-value"))).toBe("₹6,000");
    expect(text(must("dash-kpi-deductions"))).toContain("10% of gross");
    expect(text(must("dash-kpi-net-value"))).toBe("₹54,000");
    expect(text(must("dash-kpi-net"))).toContain("₹18,000 per employee on average");
  });

  it("names the TDS inside the deductions only when an employee on the TDS list has some", () => {
    mount();
    expect(text(must("dash-kpi-deductions"))).not.toContain("TDS");
    act(() => root!.unmount());
    mount({ runs: [...RUNS, run(4, { deductions: 2500, tdsDeduction: 2500, tdsPercent: 10, finalSalary: 27500 })] });
    // the total is the whole deduction (the TDS is part of it), the TDS is named beside the share of the gross
    expect(text(must("dash-kpi-deductions-value"))).toBe("₹8,500");
    expect(text(must("dash-kpi-deductions"))).toContain("9% of gross · incl. ₹2,500 TDS");
  });

  it("without an expected count it shows how many are in the payroll", () => {
    mount({ expected: undefined });
    expect(text(must("dash-kpi-employees-value"))).toBe("3");
    expect(text(must("dash-kpi-employees"))).toContain("3 payslips");
  });

  it("pending release: the rupees and how many people are waiting", () => {
    mount();
    expect(text(must("dash-kpi-pending-value"))).toBe("₹27,000");
    expect(text(must("dash-kpi-pending"))).toContain("2 employees waiting");
  });

  it("issues: the total and the split by severity", () => {
    mount();
    expect(text(must("dash-kpi-issues-value"))).toBe("17");
    expect(text(must("dash-kpi-issues"))).toContain("2 critical · 12 need a look · 3 info");
  });

  it("skipped: how many of how many were checked", () => {
    mount();
    expect(text(must("dash-kpi-skipped-value"))).toBe("1");
    expect(text(must("dash-kpi-skipped"))).toContain("of 4 checked");
    act(() => root!.unmount());
    host!.remove();
    mount({ skipped: { count: 0, total: 4 } });
    expect(text(must("dash-kpi-skipped"))).toContain("Nobody skipped · 4 checked");
  });

  it("says 'Everything is released' when nothing is pending, and 'No payroll generated yet' for an empty period", () => {
    mount({ runs: RUNS.map((r) => ({ ...r, status: "paid" })) });
    expect(text(must("dash-kpi-pending-value"))).toBe("₹0");
    expect(text(must("dash-kpi-pending"))).toContain("Everything is released");
    act(() => root!.unmount());
    host!.remove();
    mount({ runs: [] });
    expect(text(must("dash-kpi-pending"))).toContain("No payroll generated yet");
    expect(text(must("dash-kpi-gross-value"))).toBe("₹0");
  });

  it("shows a dash, not a made-up zero, where the issues or the skipped list are not available", () => {
    mount({ issues: undefined, skipped: undefined });
    expect(text(must("dash-kpi-issues-value"))).toBe("—");
    expect(text(must("dash-kpi-skipped-value"))).toBe("—");
    expect(text(must("dash-kpi-issues"))).toContain("Not available for this period");
  });

  it("an accent colours the first tile and the department bars", () => {
    mount({ accent: "indigo" });
    expect(must("dash-kpi-employees").className).toContain("bg-indigo-50");
    expect(must("dash-card-departments-row-id:1").querySelector(".bg-indigo-500")).not.toBeNull();
    act(() => root!.unmount());
    host!.remove();
    mount({ accent: "amber", kind: "production" });
    expect(must("dash-kpi-employees").className).toContain("bg-amber-50");
    expect(must("dash-card-departments-row-id:1").querySelector(".bg-amber-500")).not.toBeNull();
    expect(must("dash-root").dataset.kind).toBe("production");
  });

  it("the issues tile takes the colour of its worst severity", () => {
    mount();
    expect(must("dash-kpi-issues").className).toContain("bg-red-50");
    act(() => root!.unmount());
    host!.remove();
    mount({ issues: { ...ISSUES, bySeverity: { critical: 0, warning: 4, info: 1 } } });
    expect(must("dash-kpi-issues").className).toContain("bg-amber-50");
    act(() => root!.unmount());
    host!.remove();
    mount({ issues: { ...ISSUES, total: 0, bySeverity: { critical: 0, warning: 0, info: 0 }, byCode: [] } });
    expect(must("dash-kpi-issues").className).toContain("bg-emerald-50");
  });
});

describe("the tiles that open something", () => {
  it("are buttons when the page gives a handler, and call it", () => {
    const onFilterStatus = vi.fn();
    const onOpenIssues = vi.fn();
    const onOpenSkipped = vi.fn();
    mount({ onFilterStatus, onOpenIssues, onOpenSkipped });
    for (const tile of ["pending", "issues", "skipped"] as const) {
      expect(must(`dash-kpi-${tile}`).tagName, tile).toBe("BUTTON");
    }
    click(must("dash-kpi-pending"));
    expect(onFilterStatus).toHaveBeenCalledWith("pending");
    click(must("dash-kpi-issues"));
    expect(onOpenIssues).toHaveBeenCalledTimes(1);
    expect(onOpenIssues.mock.calls[0]).toEqual([]); // the tile opens the issues, not one kind of them
    click(must("dash-kpi-skipped"));
    expect(onOpenSkipped).toHaveBeenCalledTimes(1);
  });

  it("are plain tiles without a handler", () => {
    mount();
    for (const tile of TILES) {
      expect(must(`dash-kpi-${tile}`).tagName, tile).toBe("DIV");
    }
    expect(host!.querySelector("button")).toBeNull();
  });

  it("the totals tiles never are", () => {
    mount({ onFilterStatus: vi.fn(), onOpenIssues: vi.fn(), onOpenSkipped: vi.fn() });
    for (const tile of ["employees", "gross", "deductions", "net"] as const) {
      expect(must(`dash-kpi-${tile}`).tagName, tile).toBe("DIV");
    }
  });

  it("Pending release is not a button when nothing is pending: there would be nothing to show", () => {
    mount({ runs: RUNS.map((r) => ({ ...r, status: "paid" })), onFilterStatus: vi.fn() });
    expect(must("dash-kpi-pending").tagName).toBe("DIV");
  });

  it("the Issues tile is not a button while there are no issues to open", () => {
    mount({ issues: undefined, onOpenIssues: vi.fn() });
    expect(must("dash-kpi-issues").tagName).toBe("DIV");
  });
});

describe("the payment status card", () => {
  it("shows the share paid, as a bar with its numbers beside it", () => {
    mount();
    expect(text(must("dash-card-payment-percent"))).toBe("50% paid");
    expect(text(must("dash-card-payment"))).toContain("₹27,000 of ₹54,000 net payable");
    const bar = must("dash-card-payment-bar");
    expect(bar.getAttribute("role")).toBe("img");
    expect(bar.getAttribute("aria-label")).toBe("50% of the net payable is paid: ₹27,000 paid, ₹27,000 pending");
    expect(bar.querySelector('[data-segment="paid"]')).not.toBeNull();
    expect(bar.querySelector('[data-segment="pending"]')).not.toBeNull();
    expect(text(must("dash-card-payment-paid"))).toBe("Paid 1 employee ₹27,000 50%");
    expect(text(must("dash-card-payment-pending"))).toBe("Pending 2 employees ₹27,000 50%");
  });

  it("has no pending segment once everything is paid", () => {
    mount({ runs: RUNS.map((r) => ({ ...r, status: "paid" })) });
    expect(text(must("dash-card-payment-percent"))).toBe("100% paid");
    const bar = must("dash-card-payment-bar");
    expect(bar.querySelector('[data-segment="pending"]')).toBeNull();
    expect(bar.querySelector('[data-segment="paid"]')?.className).toContain("rounded-[4px]");
  });

  it("the two lines are buttons that show that payroll, when the page can", () => {
    const onFilterStatus = vi.fn();
    mount({ onFilterStatus });
    click(must("dash-card-payment-paid"));
    expect(onFilterStatus).toHaveBeenLastCalledWith("paid");
    click(must("dash-card-payment-pending"));
    expect(onFilterStatus).toHaveBeenLastCalledWith("pending");
    expect(must("dash-card-payment-paid").getAttribute("aria-label")).toBe(
      "Show the paid payroll: 1 employee, ₹27,000",
    );
  });

  it("a line with nothing behind it is not a button", () => {
    mount({ runs: RUNS.map((r) => ({ ...r, status: "paid" })), onFilterStatus: vi.fn() });
    expect(must("dash-card-payment-paid").tagName).toBe("BUTTON");
    expect(must("dash-card-payment-pending").tagName).toBe("DIV");
  });

  it("says what to do when nothing has been generated", () => {
    mount({ runs: [] });
    expect(text(must("dash-card-payment-empty"))).toContain("Generate payroll for October 2026");
  });
});

describe("the department card", () => {
  const dept = (id: number, net: number) =>
    run(id, { departmentId: id, departmentName: `Dept ${id}`, finalSalary: net, grossSalary: net });

  it("lists the departments biggest first, each bar against the longest", () => {
    mount();
    const rows = [...host!.querySelectorAll('[data-testid^="dash-card-departments-row-"]')];
    expect(rows.map((r) => text(r.querySelector("span.truncate")))).toEqual(["Stitching", "Weaving"]);
    expect(text(must("dash-card-departments-row-id:2"))).toContain("₹27,000");
    expect(text(must("dash-card-departments-row-id:2"))).toContain("50%");
    expect(text(must("dash-card-departments-row-id:1"))).toContain("₹27,000");
  });

  it("draws a smaller bar for a smaller department", () => {
    mount({ runs: [dept(1, 40000), dept(2, 10000)] });
    const width = (id: string) =>
      must(`dash-card-departments-row-${id}`).querySelector<HTMLElement>("span.block.h-2 > span")!.style.width;
    expect(width("id:1")).toBe("100%");
    expect(width("id:2")).toBe("25%");
  });

  it("shows the top six and groups the rest as Others", () => {
    const nine = Array.from({ length: 9 }, (_, i) => dept(i + 1, (9 - i) * 1000));
    mount({ runs: nine });
    const rows = [...host!.querySelectorAll('[data-testid^="dash-card-departments-row-"]')];
    expect(rows).toHaveLength(7);
    const others = must("dash-card-departments-row-others");
    expect(text(others)).toContain("Others");
    expect(text(others)).toContain("3 departments");
    expect(text(others)).toContain("₹6,000");
    expect(others.querySelector(".bg-slate-300")).not.toBeNull();
  });

  it("names a row's detail in its tooltip, not only in colour", () => {
    mount();
    const title = must("dash-card-departments-row-id:2").querySelector("[title]")?.getAttribute("title");
    expect(title).toBe("Stitching: ₹27,000 (50%) for 2 employees");
  });

  it("says what to do when there is no payroll", () => {
    mount({ runs: [] });
    expect(text(must("dash-card-departments-empty"))).toContain("Generate payroll for October 2026");
  });
});

describe("the issues card", () => {
  it("draws a bar per type, most frequent first, coloured by severity", () => {
    mount();
    const rows = [...host!.querySelectorAll('[data-testid^="dash-card-issues-row-"]')] as HTMLElement[];
    // 9, then the two with 3 (worse severity first), then 2
    expect(rows.map((r) => r.dataset.testid?.replace("dash-card-issues-row-", ""))).toEqual([
      "late_in",
      "late_penalty",
      "ot_pay",
      "absent",
    ]);
    expect(rows.map((r) => r.dataset.severity)).toEqual(["warning", "warning", "info", "critical"]);
    expect(rows[0].querySelector(".bg-amber-500")).not.toBeNull();
    expect(rows[2].querySelector(".bg-sky-500")).not.toBeNull();
    expect(rows[3].querySelector(".bg-red-500")).not.toBeNull();
    expect(text(rows[0])).toContain("Late arrival");
    expect(text(rows[0])).toContain("9");
  });

  it("names the severity in words as well as colour: the legend and each bar's label", () => {
    mount();
    const legend = text(must("dash-card-issues-legend"));
    expect(legend).toContain("Critical");
    expect(legend).toContain("Needs a look");
    expect(legend).toContain("For information");
    expect(must("dash-card-issues-row-absent").querySelector("[title]")?.getAttribute("title")).toBe(
      "Absent: 2 (Critical)",
    );
  });

  it("only the severities drawn are in the legend", () => {
    mount({
      issues: {
        ...ISSUES,
        byCode: [{ code: "ot_pay", label: "Overtime pay", severity: "info", category: "pay", count: 3 }],
      },
    });
    const legend = text(must("dash-card-issues-legend"));
    expect(legend).toContain("For information");
    expect(legend).not.toContain("Critical");
  });

  it("each type is a button that opens the issues for that type; the card's link opens them all", () => {
    const onOpenIssues = vi.fn();
    mount({ onOpenIssues });
    const row = must("dash-card-issues-row-absent");
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("aria-label")).toBe("Open Absent: 2 (Critical)");
    click(row);
    expect(onOpenIssues).toHaveBeenLastCalledWith("absent");
    click(must("dash-card-issues-open"));
    expect(onOpenIssues).toHaveBeenLastCalledWith();
  });

  it("the bars are plain rows when the page gives no handler", () => {
    mount();
    expect(must("dash-card-issues-row-absent").tagName).toBe("DIV");
    expect(q("dash-card-issues-open")).toBeNull();
  });

  it("says how many more types there are than bars", () => {
    const codes = [
      "late_in",
      "absent",
      "early_out",
      "half_day",
      "quarter_day",
      "missing_punch",
      "no_attendance",
      "no_shift",
      "late_penalty",
    ] as const;
    const many = codes.map((code, i) => ({
      code,
      label: `Type ${i + 1}`,
      severity: "warning" as const,
      category: "attendance" as const,
      count: 10 - i,
    }));
    mount({ issues: { ...ISSUES, byCode: many } });
    expect(host!.querySelectorAll('[data-testid^="dash-card-issues-row-"]')).toHaveLength(6);
    expect(text(must("dash-card-issues-more"))).toBe("+3 more types");
  });

  it("is green when payroll flagged nothing", () => {
    mount({ issues: { ...ISSUES, total: 0, bySeverity: { critical: 0, warning: 0, info: 0 }, byCode: [] } });
    expect(text(must("dash-card-issues-none"))).toContain("No issues detected");
  });

  it("says the issues are not available when there are none to read", () => {
    mount({ issues: undefined });
    expect(text(must("dash-card-issues-empty"))).toContain("Issues are not available");
  });
});
