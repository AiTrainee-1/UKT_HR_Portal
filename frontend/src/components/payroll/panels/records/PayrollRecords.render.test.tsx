import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PayrollRunItem } from "@/lib/api-client/custom-hooks";
import { lockMutatingControls } from "@/lib/view-only-lock";
import type { PayrollIssueSummary } from "../filters/filter-logic";
import { PayrollRecordCard, type PayrollRecordCardProps } from "./PayrollRecordCard";
import { PayrollRecordList, type PayrollRecordListProps, type RecordRules } from "./PayrollRecordList";

// The payroll record card and list in jsdom: what a card says (who, which period, the figures, the issue badges, the
// rule chips), its two actions and their loaders, the paged list with its Cards | Table toggle, and the one thing the
// e2e suite relies on: the innermost element holding an employee's name and "Mark Paid" also holds their figures.

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const run = (id: number, name: string, code: string, over: Partial<PayrollRunItem> = {}): PayrollRunItem => ({
  id,
  employeeId: id * 100,
  employeeName: name,
  employeeCode: code,
  departmentId: 1,
  departmentName: "Weaving",
  salaryMode: "monthly",
  month: 2,
  year: 2026,
  totalWorkingDays: 24,
  presentDays: 24,
  absentDays: 0,
  otHours: 0,
  otAmount: 0,
  baseSalary: 24000,
  grossSalary: 24000,
  deductions: 0,
  bonus: 0,
  finalSalary: 24000,
  status: "pending",
  ...over,
});

const ASHA = run(1, "Asha Kumar", "E2E001");
const RAVI = run(2, "Ravi Nair", "E2E002", { presentDays: 12, grossSalary: 15000, deductions: 0, finalSalary: 15000 });

const SUMMARY: PayrollIssueSummary = {
  total: 6,
  bySeverity: { critical: 1, warning: 4, info: 1 },
  codes: [
    { code: "late_in", count: 3, severity: "warning", label: "Late arrival" },
    { code: "absent", count: 1, severity: "critical", label: "Absent" },
    { code: "late_penalty", count: 1, severity: "warning", label: "Late deduction" },
    { code: "ot_pay", count: 1, severity: "info", label: "Overtime pay" },
  ],
};

const CHIPS: RecordRules["chips"] = [
  { key: "shift", label: "General 09:00-18:00", tone: "info" },
  { key: "mode", label: "Strict (4-punch)", tone: "neutral" },
  { key: "late", label: "3 free lates", tone: "warning" },
];

function render(node: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}
const unmount = () => {
  act(() => root!.unmount());
  host!.remove();
};

const q = (id: string) => host!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the page shows: ${text(host)}`);
  return el;
};
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const buttons = (el: Element) => [...el.querySelectorAll("button")];
const buttonNamed = (el: Element, label: string) => buttons(el).find((b) => text(b).startsWith(label));

// ── the card ──────────────────────────────────────────────────────────────────

function card(over: Partial<PayrollRecordCardProps> = {}) {
  const fns = { onOpenDetails: vi.fn(), onOpenIssues: vi.fn(), onMarkPaid: vi.fn() };
  render(createElement(PayrollRecordCard, { run: ASHA, kind: "staff", accent: "indigo", ...fns, ...over }));
  return fns;
}

describe("a payroll record card", () => {
  it("says who it is: name, code, department, designation, status and the month", () => {
    card({ designation: "Weaver" });
    const el = must("payroll-record-1");
    expect(text(el.querySelector("p.font-bold"))).toBe("Asha Kumar");
    expect(text(el)).toContain("E2E001 · Weaving · Weaver");
    expect(text(el)).toContain("Pending");
    expect(text(el)).toContain("February 2026");
    expect(el.dataset.status).toBe("pending");
    expect(el.getAttribute("aria-label")).toBe("Payroll of Asha Kumar");
    // a staff row has no pay cycle
    expect(text(el)).not.toContain("Weekly");
  });

  it("falls back to the code or the id when the name is missing", () => {
    card({ run: { ...ASHA, employeeName: null } });
    expect(text(must("payroll-record-1").querySelector("p.font-bold"))).toBe("E2E001");
    unmount();
    card({ run: { ...ASHA, employeeName: null, employeeCode: null } });
    expect(text(must("payroll-record-1").querySelector("p.font-bold"))).toBe("#100");
  });

  it("shows the pay figures: net, gross, deductions and the attendance line", () => {
    card({
      run: { ...ASHA, grossSalary: 27230, deductions: 1000, finalSalary: 26230, presentDays: 22, totalWorkingDays: 26 },
    });
    const el = must("payroll-record-1");
    expect(text(must("payroll-record-net-1"))).toBe("₹26,230");
    expect(text(el)).toContain("22 / 26 days");
    expect(text(el)).toContain("₹27,230");
    expect(text(el)).toContain("₹1,000");
    expect(text(el)).toContain("Attendance");
    expect(text(el)).toContain("Gross");
    expect(text(el)).toContain("Deductions");
  });

  it("a production row shows its shifts, its pay cycle and its dates", () => {
    card({
      kind: "production",
      accent: "amber",
      run: run(7, "Bala Worker", "PC-W2", {
        salaryMode: "shift",
        presentDays: 6.5,
        payCycle: "weekly",
        periodStart: "2026-02-02",
        periodEnd: "2026-02-08",
      }),
    });
    const el = must("payroll-record-7");
    expect(text(el)).toContain("6.5 shifts");
    expect(text(el)).toContain("Shifts");
    expect(text(el)).toContain("Weekly");
    expect(text(el)).toContain("2 Feb - 8 Feb 2026");
    expect(el.dataset.kind).toBe("production");
  });

  it("mentions overtime and bonus when there are some", () => {
    card({ run: { ...ASHA, otAmount: 1200, bonus: 500 } });
    expect(text(must("payroll-record-1"))).toContain("OT ₹1,200 · Bonus ₹500");
    unmount();
    card();
    expect(text(must("payroll-record-1"))).not.toContain("OT ₹");
  });

  it("a paid row is marked as paid and offers no Mark Paid", () => {
    card({ run: { ...ASHA, status: "paid" } });
    const el = must("payroll-record-1");
    expect(text(el)).toContain("Paid");
    expect(el.dataset.status).toBe("paid");
    expect(buttonNamed(el, "Mark Paid")).toBeUndefined();
    expect(buttonNamed(el, "Details")).toBeDefined();
  });
});

describe("the card's issues", () => {
  it("counts the severities and names the two most frequent issue types", () => {
    card({ issueSummary: SUMMARY });
    const block = must("payroll-record-issues-1");
    expect(text(block)).toContain("1 Critical");
    expect(text(block)).toContain("4 Needs a look");
    expect(text(block)).toContain("1 For information");
    expect(text(block)).toContain("Late arrival ×3");
    expect(text(block)).toContain("Absent ×1");
    expect(text(block)).not.toContain("Overtime pay");
    expect(text(block)).toContain("+2 more");
  });

  it("a click opens the issues of that payroll", () => {
    const fns = card({ issueSummary: SUMMARY });
    const block = must("payroll-record-issues-1");
    expect(block.tagName).toBe("BUTTON");
    expect(block.getAttribute("aria-label")).toBe("Open the issues of Asha Kumar");
    click(block);
    expect(fns.onOpenIssues).toHaveBeenCalledWith(ASHA);
    expect(fns.onOpenDetails).not.toHaveBeenCalled();
  });

  it("the badges are plain text when the page cannot open them", () => {
    card({ issueSummary: SUMMARY, onOpenIssues: undefined });
    expect(q("payroll-record-issues-1")).toBeNull();
    expect(text(must("payroll-record-1"))).toContain("4 Needs a look");
  });

  it("says 'No issues' for a clean payroll", () => {
    card({ issueSummary: { total: 0, bySeverity: { critical: 0, warning: 0, info: 0 }, codes: [] } });
    expect(text(must("payroll-record-1"))).toContain("No issues");
    expect(q("payroll-record-issues-1")).toBeNull();
  });

  it("shows a placeholder while the issues load, and nothing when there are none to show", () => {
    card({ issuesLoading: true });
    expect(q("payroll-record-issues-loading")).not.toBeNull();
    unmount();
    card();
    expect(q("payroll-record-issues-loading")).toBeNull();
    expect(text(must("payroll-record-1"))).not.toContain("No issues");
  });

  it("works from counts alone: the names and severities come from the kit", () => {
    card({
      issueSummary: {
        total: 2,
        bySeverity: { critical: 0, warning: 2, info: 0 },
        codes: [{ code: "late_in", count: 2 }],
      },
    });
    expect(text(must("payroll-record-issues-1"))).toContain("Late arrival ×2");
  });
});

describe("the card's rule chips", () => {
  it("lists the rules assigned to the employee", () => {
    card({ chips: CHIPS });
    const list = must("payroll-record-1").querySelector("ul")!;
    expect([...list.querySelectorAll("li")].map(text)).toEqual([
      "General 09:00-18:00",
      "Strict (4-punch)",
      "3 free lates",
    ]);
    expect(list.getAttribute("aria-label")).toBe("Rules assigned to this employee");
    expect(list.querySelector('[data-tone="warning"]')).not.toBeNull();
  });

  it("shows placeholders while the rules load", () => {
    card({ chipsLoading: true });
    expect(q("payroll-record-rules-loading")).not.toBeNull();
    unmount();
    card({ chipsLoading: true, chips: CHIPS });
    expect(q("payroll-record-rules-loading")).toBeNull();
  });

  it("leaves a gap out when there are no rules", () => {
    card({ chips: [] });
    expect(must("payroll-record-1").querySelector("ul")).toBeNull();
  });
});

describe("the card's actions", () => {
  it("Details opens the payroll, Mark Paid pays it", () => {
    const fns = card();
    const el = must("payroll-record-1");
    click(buttonNamed(el, "Details")!);
    expect(fns.onOpenDetails).toHaveBeenCalledWith(ASHA);
    click(buttonNamed(el, "Mark Paid")!);
    expect(fns.onMarkPaid).toHaveBeenCalledWith(ASHA);
  });

  it("Details is an outline button with an arrow; Mark Paid is a normal button", () => {
    card();
    const details = must("payroll-record-details-1");
    expect(details.dataset.variant).toBe("outline");
    expect(details.querySelector("svg")).not.toBeNull();
    expect(text(details)).toBe("Details");
    const pay = must("payroll-record-markpaid-1");
    expect(text(pay)).toBe("Mark Paid");
    expect(pay.closest("[data-view-safe]")).toBeNull();
  });

  it("while it is marking, Mark Paid spins and cannot be pressed again", () => {
    const fns = card({ marking: true });
    const pay = must("payroll-record-markpaid-1") as HTMLButtonElement;
    expect(pay.disabled).toBe(true);
    expect(pay.querySelector("svg.animate-spin")).not.toBeNull();
    click(pay);
    expect(fns.onMarkPaid).not.toHaveBeenCalled();
    expect((must("payroll-record-details-1") as HTMLButtonElement).disabled).toBe(false);
  });

  it("without a handler a pending row has no Mark Paid", () => {
    card({ onMarkPaid: undefined });
    expect(q("payroll-record-markpaid-1")).toBeNull();
  });

  it("for a View Only role: Mark Paid is locked, Details and the issues stay open", () => {
    card({ issueSummary: SUMMARY });
    lockMutatingControls(document.body);
    expect((must("payroll-record-markpaid-1") as HTMLButtonElement).disabled).toBe(true);
    expect((must("payroll-record-details-1") as HTMLButtonElement).disabled).toBe(false);
    expect((must("payroll-record-issues-1") as HTMLButtonElement).disabled).toBe(false);
  });
});

// The e2e suite finds a payroll entry as "the innermost div that holds the employee's name and Mark Paid"
// (page.locator("div").filter({ hasText: name }).filter({ hasText: "Mark Paid" }).last()) and reads the figures from it.
describe("finding a card the way the e2e suite does", () => {
  const innermost = (name: string) =>
    [...host!.querySelectorAll("div")]
      .filter((d) => text(d).toLowerCase().includes(name.toLowerCase()) && text(d).toLowerCase().includes("mark paid"))
      .at(-1);

  const asList = () =>
    render(
      createElement(PayrollRecordList, {
        runs: [ASHA, RAVI],
        kind: "staff",
        accent: "indigo",
        issuesByPayroll: new Map([[1, SUMMARY]]),
        rulesByEmployee: new Map([[100, { chips: CHIPS, designation: "Weaver" }]]),
        onOpenDetails: vi.fn(),
        onOpenIssues: vi.fn(),
        onMarkPaid: vi.fn(),
        empty: "nothing",
      }),
    );

  it("holds the employee's days and rupees, and nobody else's", () => {
    asList();
    const asha = innermost("Asha Kumar")!;
    expect(text(asha)).toContain("24 / 24 days");
    expect(text(asha)).toContain("₹24,000");
    expect(text(asha)).not.toContain("Ravi Nair");
    expect(text(asha)).not.toContain("12 / 24 days");
    const ravi = innermost("Ravi Nair")!;
    expect(text(ravi)).toContain("12 / 24 days");
    expect(text(ravi)).toContain("₹15,000");
    expect(text(ravi)).not.toContain("Asha Kumar");
  });

  it("has its Mark Paid button inside, found by its name", () => {
    asList();
    const button = buttonNamed(innermost("Ravi Nair")!, "Mark Paid");
    expect(button).toBeDefined();
    expect(buttons(innermost("Ravi Nair")!).filter((b) => /mark paid/i.test(text(b)))).toHaveLength(1);
  });

  it("keeps the name out of the actions, so no smaller div holds the name and the button but not the figures", () => {
    asList();
    const actions = buttonNamed(must("payroll-record-1"), "Mark Paid")!.parentElement!;
    expect(text(actions)).not.toContain("Asha Kumar");
  });
});

// ── the list ──────────────────────────────────────────────────────────────────

const many = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    run(i + 1, `Worker ${String(i + 1).padStart(2, "0")}`, `W${i + 1}`, {
      finalSalary: 1000 * (i + 1),
      grossSalary: 1000 * (i + 1),
    }),
  );

function list(over: Partial<PayrollRecordListProps> = {}) {
  const fns = { onOpenDetails: vi.fn(), onOpenIssues: vi.fn(), onMarkPaid: vi.fn() };
  render(
    createElement(PayrollRecordList, {
      runs: many(5),
      kind: "staff",
      accent: "indigo",
      empty: createElement("p", { "data-testid": "nothing" }, "No payroll"),
      ...fns,
      ...over,
    }),
  );
  return fns;
}
const cards = () => [...host!.querySelectorAll('[data-testid^="payroll-record-"][data-status]')];
const names = () => cards().map((c) => text(c.querySelector("p.font-bold")));

describe("a payroll record list", () => {
  it("shows skeleton rows while the first load runs", () => {
    list({ loading: true });
    expect(q("skeleton-rows")).not.toBeNull();
    expect(cards()).toHaveLength(0);
    expect(must("payroll-record-list").getAttribute("aria-busy")).toBe("true");
  });

  it("shows what the page says when there is nothing to list", () => {
    list({ runs: [] });
    expect(text(must("nothing"))).toBe("No payroll");
    expect(q("payroll-record-layout-cards")).toBeNull();
  });

  it("lists a card for every row, with how many are shown", () => {
    list();
    expect(cards()).toHaveLength(5);
    expect(text(must("payroll-record-showing"))).toBe("Showing 1-5 of 5");
    expect(must("payroll-record-list").dataset.layout).toBe("cards");
  });

  it("passes each card its own issues, and its employee's rules and designation", () => {
    list({
      runs: [ASHA, RAVI],
      issuesByPayroll: new Map([[1, SUMMARY]]),
      rulesByEmployee: new Map([[100, { chips: CHIPS, designation: "Weaver" }]]),
    });
    expect(q("payroll-record-issues-1")).not.toBeNull();
    expect(q("payroll-record-issues-2")).toBeNull(); // Ravi has no entry: nothing to open
    const asha = must("payroll-record-1");
    expect(text(asha)).toContain("Weaver");
    expect(text(asha)).toContain("General 09:00-18:00");
    expect(text(must("payroll-record-2"))).not.toContain("General 09:00-18:00");
  });

  it("tells the cards the issues and the rules are still loading", () => {
    list({ runs: [ASHA, RAVI], issuesLoading: true, rulesLoading: true });
    expect(host!.querySelectorAll('[data-testid="payroll-record-issues-loading"]')).toHaveLength(2);
    expect(host!.querySelectorAll('[data-testid="payroll-record-rules-loading"]')).toHaveLength(2);
  });

  it("once the issues are loaded a payroll the map does not list has none", () => {
    list({ runs: [ASHA, RAVI], issuesByPayroll: new Map([[1, SUMMARY]]) });
    expect(text(must("payroll-record-1"))).not.toContain("No issues");
    expect(text(must("payroll-record-2"))).toContain("No issues");
  });

  it("never says 'No issues' while they are still loading, even with an empty map", () => {
    list({ runs: [ASHA, RAVI], issuesByPayroll: new Map(), issuesLoading: true });
    expect(text(host)).not.toContain("No issues");
    expect(host!.querySelectorAll('[data-testid="payroll-record-issues-loading"]')).toHaveLength(2);
  });

  it("without the issues at all, a card says nothing of them", () => {
    list({ runs: [ASHA, RAVI] });
    expect(text(host)).not.toContain("No issues");
    expect(q("payroll-record-issues-loading")).toBeNull();
  });

  it("hands the row to the page's handlers", () => {
    const fns = list({ runs: [ASHA, RAVI], issuesByPayroll: new Map([[2, SUMMARY]]) });
    click(must("payroll-record-details-2"));
    expect(fns.onOpenDetails).toHaveBeenCalledWith(RAVI);
    click(must("payroll-record-markpaid-1"));
    expect(fns.onMarkPaid).toHaveBeenCalledWith(ASHA);
    click(must("payroll-record-issues-2"));
    expect(fns.onOpenIssues).toHaveBeenCalledWith(RAVI);
  });

  it("only the row being marked spins", () => {
    list({ runs: [ASHA, RAVI], markingId: 2 });
    expect((must("payroll-record-markpaid-2") as HTMLButtonElement).disabled).toBe(true);
    expect((must("payroll-record-markpaid-1") as HTMLButtonElement).disabled).toBe(false);
    expect(must("payroll-record-markpaid-2").querySelector("svg.animate-spin")).not.toBeNull();
  });
});

describe("paging", () => {
  it("shows a page at a time, 20 by default", () => {
    list({ runs: many(45) });
    expect(cards()).toHaveLength(20);
    expect(text(must("payroll-record-showing"))).toBe("Showing 1-20 of 45");
    click(host!.ownerDocument.body.querySelector('[aria-label="Page 3"]'));
    expect(cards()).toHaveLength(5);
    expect(text(must("payroll-record-showing"))).toBe("Showing 41-45 of 45");
    expect(names()[0]).toBe("Worker 41");
  });

  it("takes the page size from the page", () => {
    list({ runs: many(7), pageSize: 3 });
    expect(names()).toEqual(["Worker 01", "Worker 02", "Worker 03"]);
    click(host!.ownerDocument.body.querySelector('[aria-label="Next page"]'));
    expect(names()).toEqual(["Worker 04", "Worker 05", "Worker 06"]);
  });

  it("has no pager for a short list", () => {
    list({ runs: many(5) });
    expect(host!.ownerDocument.body.querySelector('[aria-label="Page 1"]')).toBeNull();
    expect(host!.ownerDocument.body.querySelector('[aria-label="Next page"]')).toBeNull();
  });

  it("goes back to the first page when the rows listed change, but not when only a row's status does", () => {
    function Page() {
      const [runs, setRuns] = useState(many(45));
      return createElement(
        "div",
        null,
        createElement("button", { "data-testid": "narrow", onClick: () => setRuns(many(45).slice(10, 40)) }, "narrow"),
        createElement(
          "button",
          {
            "data-testid": "pay",
            onClick: () => setRuns((r) => r.map((x) => (x.id === 30 ? { ...x, status: "paid" } : x))),
          },
          "pay",
        ),
        createElement(PayrollRecordList, {
          runs,
          kind: "staff",
          accent: "indigo",
          empty: null,
          onOpenDetails: vi.fn(),
          onMarkPaid: vi.fn(),
        }),
      );
    }
    render(createElement(Page));
    click(host!.ownerDocument.body.querySelector('[aria-label="Page 2"]'));
    expect(text(must("payroll-record-showing"))).toBe("Showing 21-40 of 45");
    click(must("pay")); // one row is paid: same rows, same page
    expect(text(must("payroll-record-showing"))).toBe("Showing 21-40 of 45");
    expect(must("payroll-record-30").dataset.status).toBe("paid");
    click(must("narrow")); // another set of rows: page 1
    expect(text(must("payroll-record-showing"))).toBe("Showing 1-20 of 30");
  });

  it("starts again from the top when the list gets shorter, never on a page that no longer exists", () => {
    function Page() {
      const [n, setN] = useState(45);
      return createElement(
        "div",
        null,
        createElement("button", { "data-testid": "shrink", onClick: () => setN(25) }, "shrink"),
        createElement(PayrollRecordList, {
          runs: many(n),
          kind: "staff",
          accent: "indigo",
          empty: null,
          onOpenDetails: vi.fn(),
          onMarkPaid: vi.fn(),
        }),
      );
    }
    render(createElement(Page));
    click(host!.ownerDocument.body.querySelector('[aria-label="Page 3"]'));
    click(must("shrink"));
    expect(text(must("payroll-record-showing"))).toBe("Showing 1-20 of 25");
  });
});

describe("the Cards | Table toggle", () => {
  it("starts on Cards, and the toggle says which is on", () => {
    list();
    expect(must("payroll-record-layout-cards").getAttribute("aria-pressed")).toBe("true");
    expect(must("payroll-record-layout-table").getAttribute("aria-pressed")).toBe("false");
    expect(q("payroll-record-table")).toBeNull();
  });

  it("switches to a compact register with the same rows, and back", () => {
    list({ runs: many(3) });
    click(must("payroll-record-layout-table"));
    expect(must("payroll-record-list").dataset.layout).toBe("table");
    expect(q("payroll-record-cards")).toBeNull();
    expect(host!.querySelectorAll('[data-testid^="payroll-record-row-"]')).toHaveLength(3);
    expect(must("payroll-record-layout-table").getAttribute("aria-pressed")).toBe("true");
    click(must("payroll-record-layout-cards"));
    expect(q("payroll-record-table")).toBeNull();
    expect(cards()).toHaveLength(3);
  });

  it("the table has the same data on one line, and a Details link and Mark Paid per row", () => {
    const fns = list({
      runs: [
        ASHA,
        { ...RAVI, deductions: 500, grossSalary: 15500 },
        run(3, "Meena Das", "PC-W3", { status: "paid", departmentName: null, finalSalary: 9000, grossSalary: 9000 }),
      ],
      issuesByPayroll: new Map([[1, SUMMARY]]),
    });
    click(must("payroll-record-layout-table"));
    const row = must("payroll-record-row-1");
    expect(text(row)).toContain("Asha Kumar");
    expect(text(row)).toContain("E2E001");
    expect(text(row)).toContain("Weaving");
    expect(text(row)).toContain("February 2026");
    expect(text(row)).toContain("24 / 24 days");
    expect(text(row)).toContain("₹24,000");
    expect(text(row)).toContain("Pending");
    expect(text(must("payroll-record-row-2"))).toContain("₹500");
    expect(text(must("payroll-record-row-3"))).toContain("Paid");
    expect(text(must("payroll-record-row-3"))).toContain("—"); // no department
    // the actions
    click(must("payroll-record-details-2"));
    expect(fns.onOpenDetails).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    click(must("payroll-record-markpaid-1"));
    expect(fns.onMarkPaid).toHaveBeenCalledWith(ASHA);
    expect(q("payroll-record-markpaid-3")).toBeNull(); // already paid
    // the issues, in words for assistive technology
    const issues = must("payroll-record-issues-1");
    expect(issues.getAttribute("aria-label")).toBe(
      "Open the issues of Asha Kumar: 1 critical, 4 needs a look, 1 for information",
    );
    click(issues);
    expect(fns.onOpenIssues).toHaveBeenCalledWith(ASHA);
    expect(text(must("payroll-record-row-2"))).toContain("None"); // loaded, and Ravi has no entry: no issues
  });

  it("adds up every row in the footer, not only the page shown", () => {
    list({ runs: many(45), pageSize: 20 });
    click(must("payroll-record-layout-table"));
    expect(host!.querySelectorAll('[data-testid^="payroll-record-row-"]')).toHaveLength(20);
    const totals = text(must("payroll-record-totals"));
    expect(totals).toContain("Total of all 45 records");
    expect(totals).toContain("₹10,35,000"); // 1000 + 2000 + ... + 45000
  });

  it("the register names the cycle of a production row", () => {
    list({
      kind: "production",
      accent: "amber",
      runs: [
        run(7, "Bala Worker", "PC-W2", {
          salaryMode: "shift",
          presentDays: 6.5,
          payCycle: "weekly",
          periodStart: "2026-02-02",
          periodEnd: "2026-02-08",
        }),
      ],
    });
    click(must("payroll-record-layout-table"));
    const row = text(must("payroll-record-row-7"));
    expect(row).toContain("Weekly");
    expect(row).toContain("2 Feb - 8 Feb 2026");
    expect(row).toContain("6.5 shifts");
    expect(text(must("payroll-record-table"))).toContain("Cycle / period");
  });

  it("the register shows a placeholder where the issues are still loading", () => {
    list({ runs: [ASHA], issuesLoading: true });
    click(must("payroll-record-layout-table"));
    expect(must("payroll-record-row-1").querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it("in the register Mark Paid is locked for a View Only role, Details is not", () => {
    list({ runs: [ASHA] });
    click(must("payroll-record-layout-table"));
    lockMutatingControls(document.body);
    expect((must("payroll-record-markpaid-1") as HTMLButtonElement).disabled).toBe(true);
    expect((must("payroll-record-details-1") as HTMLButtonElement).disabled).toBe(false);
  });

  it("lets the page keep the layout (in the address): the page's value wins and it is told of a change", () => {
    const onLayoutChange = vi.fn();
    list({ layout: "table", onLayoutChange });
    expect(must("payroll-record-list").dataset.layout).toBe("table");
    click(must("payroll-record-layout-cards"));
    expect(onLayoutChange).toHaveBeenCalledWith("cards");
    // controlled: nothing changes until the page passes the new value
    expect(must("payroll-record-list").dataset.layout).toBe("table");
  });

  it("tells the page of a change even when it keeps the layout itself", () => {
    const onLayoutChange = vi.fn();
    list({ onLayoutChange });
    click(must("payroll-record-layout-table"));
    expect(onLayoutChange).toHaveBeenCalledWith("table");
    expect(must("payroll-record-list").dataset.layout).toBe("table");
  });
});

// ── TDS: shown only where there is some ───────────────────────────────────────

// An employee on the TDS list has TDS (a percentage of the earned gross) inside Deductions. Nobody else ever shows a TDS
// cell, and the register has a TDS column only while some row of the list has TDS: PF and ESI sit inside Deductions as
// they always did.
const KARTHIK = run(9, "Karthik Rajan", "E2E009", {
  grossSalary: 24000,
  deductions: 2400,
  tdsDeduction: 2400,
  tdsPercent: 10,
  finalSalary: 21600,
});

describe("TDS on a payroll record card", () => {
  it("is a fourth figure on the card of a TDS employee, named with its percentage", () => {
    card({ run: KARTHIK });
    const tds = must("payroll-record-tds-9");
    expect(text(tds)).toBe("TDS (10%)₹2,400");
    expect(must("payroll-record-9").querySelector("dl")!.className).toContain("grid-cols-4");
    // Deductions stays the whole deduction (it already includes the TDS)
    expect(text(must("payroll-record-9"))).toContain("Deductions₹2,400");
  });

  it("is not on the card of anyone else: three figures, exactly as before", () => {
    card({ run: { ...ASHA, deductions: 1000, finalSalary: 23000 } });
    expect(q("payroll-record-tds-1")).toBeNull();
    expect(must("payroll-record-1").querySelector("dl")!.className).toBe("grid grid-cols-3 gap-2 text-center");
  });

  it("is there for a TDS employee whose TDS came to nothing (the percentage is what marks them)", () => {
    card({ run: { ...KARTHIK, tdsDeduction: 0, tdsPercent: 7.5, deductions: 0, finalSalary: 24000 } });
    expect(text(must("payroll-record-tds-9"))).toBe("TDS (7.5%)₹0");
  });
});

describe("TDS in the register", () => {
  it("has no TDS column while no row has TDS", () => {
    list({ runs: [ASHA, RAVI] });
    click(must("payroll-record-layout-table"));
    expect(text(must("payroll-record-table").querySelector("thead"))).not.toContain("TDS");
    expect(q("payroll-record-totals-tds")).toBeNull();
    expect(must("payroll-record-table").querySelector("table")!.className).toBe("w-full min-w-[900px] text-sm");
    // 10 columns, as before
    expect(must("payroll-record-table").querySelectorAll("thead th")).toHaveLength(10);
  });

  it("gets a TDS column when a row has TDS: the amount and percentage on that row, a dash on the others, a total", () => {
    list({ runs: [ASHA, KARTHIK, RAVI] });
    click(must("payroll-record-layout-table"));
    const heads = [...must("payroll-record-table").querySelectorAll("thead th")].map(text);
    expect(heads).toEqual([
      "Employee",
      "Department",
      "Period",
      "Attendance",
      "Gross",
      "TDS",
      "Deductions",
      "Net",
      "Status",
      "Issues",
      "Actions",
    ]);
    const cell = must("payroll-record-tds-9");
    expect(text(cell)).toMatch(/^₹2,400/);
    expect(text(cell.querySelector("span"))).toBe("10%");
    expect(text(must("payroll-record-tds-1"))).toBe("—");
    expect(text(must("payroll-record-tds-2"))).toBe("—");
    expect(text(must("payroll-record-totals-tds"))).toBe("₹2,400");
    // the footer still lines up with the header: one cell per column
    const footer = must("payroll-record-totals");
    const span = [...footer.children].reduce((n, td) => n + Number(td.getAttribute("colspan") ?? 1), 0);
    expect(span).toBe(11);
    // Deductions is the whole deduction, including the TDS
    expect(text(must("payroll-record-row-9"))).toContain("₹2,400");
    expect(text(footer)).toContain("₹60,600"); // net: 24,000 + 21,600 + 15,000
  });

  it("follows the whole list, not the page: a TDS row on page 2 still gives page 1 the column", () => {
    const rows = [...many(25), { ...KARTHIK, id: 99, employeeId: 9900 }];
    list({ runs: rows, pageSize: 20 });
    click(must("payroll-record-layout-table"));
    expect(q("payroll-record-tds-99")).toBeNull(); // that row is on page 2
    expect(text(must("payroll-record-tds-1"))).toBe("—");
    expect([...must("payroll-record-table").querySelectorAll("thead th")].map(text)).toContain("TDS");
    expect(text(must("payroll-record-totals-tds"))).toBe("₹2,400");
  });
});
