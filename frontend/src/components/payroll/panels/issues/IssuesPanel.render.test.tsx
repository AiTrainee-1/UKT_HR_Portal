import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dateTime } from "@/components/payroll/kit/format";
import type { PayrollIssue, PayrollIssuesResponse } from "@/lib/api-client/custom-hooks";
import { isMutatingControl, lockMutatingControls } from "@/lib/view-only-lock";
import {
  ASHA,
  BALA,
  DETECTED_AT,
  ISSUES,
  PRODUCTION_SCOPE,
  SKIPPED,
  STAFF_PERIOD,
  STAFF_SCOPE,
  makeIssue,
  makeResponse,
  manyIssues,
  summaryOf,
} from "./fixtures";
import { IssuesPanel, type IssuesPanelProps } from "./IssuesPanel";
import { DEFAULT_ISSUE_FILTERS, type IssueFilterState } from "./issues-logic";

// The Issues panel in jsdom with the data hook faked: loading, failing, empty and full; the three groupings; the
// filters and Reset; the page number; the employees payroll skipped merged in; the "Detected on" date on every row; the
// Open details callback; the export (what is handed to the Excel / CSV writers); and the view-only lock.

const h = vi.hoisted(() => ({
  issues: vi.fn(),
  settings: vi.fn(),
  refetch: vi.fn(),
  open: vi.fn(),
  change: vi.fn(),
  excel: vi.fn(),
  csv: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/components/payroll/kit/export-table", () => ({ exportTableToExcel: h.excel, exportTableToCsv: h.csv }));
vi.mock("@/lib/api-client/custom-hooks", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks")>()),
  usePayrollIssues: (...args: unknown[]) => h.issues(...args),
  usePayrollSettings: () => h.settings(),
}));

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

const serve = (data: PayrollIssuesResponse | undefined, over: Record<string, unknown> = {}) =>
  h.issues.mockReturnValue({ data, isLoading: false, isError: false, refetch: h.refetch, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  serve(makeResponse());
  h.settings.mockReturnValue({ data: { companyName: "UK Textiles Test" } });
  h.excel.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
});

const props = (over: Partial<IssuesPanelProps> = {}): IssuesPanelProps => ({
  scope: STAFF_SCOPE,
  accent: "indigo",
  onOpenDetails: h.open,
  ...over,
});

function mount(over: Partial<IssuesPanelProps> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(IssuesPanel, props(over))));
  return host;
}
const rerender = (over: Partial<IssuesPanelProps> = {}) =>
  act(() => root!.render(createElement(IssuesPanel, props(over))));

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the panel shows: ${text(document.body).slice(0, 600)}`);
  return el;
};
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const press = (el: Element, key: string) =>
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
const typeInto = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const rows = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid^="issue-row-"]')];
const rowOf = (id: string) => must(`issue-row-${id}`);
const groupKeys = (kind: string) =>
  [...document.body.querySelectorAll<HTMLElement>(`[data-group="${kind}"]`)].map((el) => el.dataset.testid);
const tab = (name: string) =>
  [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => text(t).startsWith(name))!;
const pickOption = (trigger: HTMLElement, label: string | RegExp) => {
  press(trigger, "ArrowDown");
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
    typeof label === "string" ? text(o) === label : label.test(text(o)),
  );
  if (!option)
    throw new Error(`no option ${label}; options: ${[...document.body.querySelectorAll('[role="option"]')].map(text)}`);
  click(option);
};
const openExport = () => press(must("issues-export"), "Enter");

const LATE = "101:late_in:2026-10-13";
const ABSENT_ASHA = "101:absent:2026-10-14";
const ABSENT_BALA = "102:absent:2026-10-13";
const PENALTY = "101:late_penalty:period";

describe("the Issues panel while it loads and when it cannot", () => {
  it("shows skeletons while the first load is on its way, and nothing else", () => {
    serve(undefined, { isLoading: true });
    mount();
    expect(q("issues-panel")).not.toBeNull();
    expect(q("issues-loading")).not.toBeNull();
    expect(q("skeleton-kpis")).not.toBeNull();
    expect(q("skeleton-rows")).not.toBeNull();
    expect(q("issues-kpis")).toBeNull();
    expect(q("issues-search")).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it("says when the issues could not load, and Retry asks again", () => {
    serve(undefined, { isError: true });
    mount();
    const error = must("issues-error");
    expect(text(error)).toContain("Could not load the issues");
    expect(q("issues-loading")).toBeNull();
    click([...error.querySelectorAll("button")].find((b) => text(b) === "Retry")!);
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  it("gives the server's reason, says a permission error is one, and shows Retry busy while it retries", () => {
    serve(undefined, { isError: true, error: new Error("HTTP 400 Bad Request: month and year are required") });
    mount();
    expect(text(must("issues-error"))).toContain("month and year are required");
    act(() => root!.unmount());
    host!.remove();

    serve(undefined, { isError: true, error: new Error("HTTP 403 Forbidden"), isFetching: true });
    mount();
    expect(text(must("issues-error"))).toContain("You do not have permission to view this.");
    const retry = [...must("issues-error").querySelectorAll("button")].find((b) => text(b) === "Retry")!;
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector(".animate-spin")).not.toBeNull();
  });

  it("asks the server for the scope and the narrowing it was given", () => {
    mount({ scope: PRODUCTION_SCOPE, filters: { departmentId: 4 } });
    expect(h.issues).toHaveBeenLastCalledWith(PRODUCTION_SCOPE, { departmentId: 4 });
  });
});

describe("the Issues panel when payroll found nothing", () => {
  it("says so with a green check, and offers no filters", () => {
    serve(makeResponse([]));
    mount();
    expect(text(must("issues-all-clear"))).toContain("No issues detected for this period");
    expect(text(must("issues-all-clear"))).toContain("October 2026");
    expect(text(must("issues-kpi-critical-value"))).toBe("0");
    expect(q("issues-search")).toBeNull();
    expect(q("issues-no-match")).toBeNull();
  });

  it("is not all clear when employees were skipped", () => {
    serve(makeResponse([]));
    mount({ skipped: SKIPPED });
    expect(q("issues-all-clear")).toBeNull();
    expect(rows()).toHaveLength(2);
    expect(text(must("issues-kpi-critical-value"))).toBe("2");
  });

  it("does not claim all is clear when there is no payroll to check, and says what to do", () => {
    // issues are detected from generated payroll: none yet means nothing was checked
    serve(makeResponse([], { summary: summaryOf([], 0) }));
    mount();
    expect(q("issues-all-clear")).toBeNull();
    expect(text(must("issues-no-payroll"))).toContain("No payroll has been generated for this period yet");
    expect(text(must("issues-no-payroll"))).toContain("Generate payroll first");
    expect(text(must("issues-no-payroll"))).toContain("October 2026");
    expect(q("issues-search")).toBeNull();
  });

  it("lists who was skipped even when there is no payroll at all", () => {
    serve(makeResponse([], { summary: summaryOf([], 0) }));
    mount({ skipped: SKIPPED });
    expect(q("issues-no-payroll")).toBeNull();
    expect(rows()).toHaveLength(2);
  });
});

describe("the Issues panel, by date", () => {
  it("summarises the severities and the people affected", () => {
    mount();
    expect(text(must("issues-kpi-critical"))).toContain("Critical");
    expect(text(must("issues-kpi-critical-value"))).toBe("2");
    expect(text(must("issues-kpi-warning-value"))).toBe("7");
    expect(text(must("issues-kpi-info-value"))).toBe("2");
    expect(text(must("issues-kpi-warning"))).toContain("Needs a look");
    expect(text(must("issues-kpi-info"))).toContain("For information");
    expect(text(must("issues-kpi-employees-value"))).toBe("3");
    expect(text(must("issues-kpi-employees"))).toContain("3 with payroll in this period");
    // each says which kinds of issue it counts
    expect(text(must("issues-kpi-critical"))).toContain("Absent");
    expect(text(must("issues-kpi-info"))).toContain("Overtime pay, PF number missing");
  });

  it("says what payroll flagged and when payroll last computed", () => {
    mount();
    expect(text(must("issues-panel"))).toContain("Detected issues · October 2026");
    expect(text(must("issues-panel"))).toContain(`Payroll last computed ${dateTime(DETECTED_AT)}`);
  });

  it("offers the issue types as quick filters, with how many of each", () => {
    mount();
    const chips = must("issues-types");
    expect(text(must("issues-type-all"))).toBe("All types 11");
    expect(text(must("issues-type-absent"))).toBe("Absent 2");
    expect(text(must("issues-type-late_in"))).toBe("Late arrival 1");
    expect(text(must("issues-type-ot_pay"))).toBe("Overtime pay 1");
    expect(chips.querySelectorAll("button")).toHaveLength(11); // All + ten types
    expect(must("issues-type-all").getAttribute("aria-pressed")).toBe("true");
    expect(must("issues-type-absent").getAttribute("aria-pressed")).toBe("false");
  });

  it("lists a timeline: a header for each day, the whole-period issues last", () => {
    mount();
    expect(groupKeys("date")).toEqual([
      "issues-group-2026-10-13",
      "issues-group-2026-10-14",
      "issues-group-2026-10-15",
      "issues-group-2026-10-20",
      "issues-group-period",
    ]);
    const title = (key: string) => text(must(key).querySelector('[data-testid="issues-group-title"]'));
    expect(title("issues-group-2026-10-13")).toBe("Tue, 13 Oct 2026 · 3 issues");
    expect(title("issues-group-2026-10-14")).toBe("Wed, 14 Oct 2026 · 1 issue");
    expect(title("issues-group-period")).toBe("Whole period · 5 issues");
    expect(text(must("issues-group-period"))).toContain("about the whole period, not one day");
    expect(text(must("issues-showing"))).toBe("Showing 1–11 of 11 issues");
    expect(must("issues-list").dataset.groupBy).toBe("date");
  });

  it("puts the worst issue of a day first", () => {
    mount();
    const day = must("issues-group-2026-10-13");
    expect([...day.querySelectorAll('[data-testid^="issue-row-"]')].map((r) => r.getAttribute("data-testid"))).toEqual([
      `issue-row-${ABSENT_BALA}`,
      `issue-row-${LATE}`,
      "issue-row-103:missing_punch:2026-10-13",
    ]);
  });

  it("shows on every row the title, the detail, who, the date detected, what it cost and the rule", () => {
    mount();
    const row = rowOf(LATE);
    expect(row.dataset.severity).toBe("warning");
    expect(text(row)).toContain("Late arrival");
    expect(text(must(`issue-row-${LATE}`).querySelector('[data-testid="issue-detail"]'))).toBe(
      "First punch 09:42, after General 09:00 + 10 min grace (09:10)",
    );
    expect(text(row.querySelector('[data-testid="issue-employee"]'))).toContain("Asha Worker");
    expect(text(row.querySelector('[data-testid="issue-employee"]'))).toContain("PC-S1 · Weaving");
    expect(text(row.querySelector('[data-testid="issue-detected"]'))).toBe("Detected on Tue, 13 Oct 2026");
    expect(text(row.querySelector('[data-testid="issue-impact"]'))).toBe("Impact 0.25 days");
    expect(text(row.querySelector('[data-testid="issue-rule"]'))).toContain("Rule Late allowance");
    expect(row.querySelector('[data-testid="issue-rule-link"]')?.getAttribute("href")).toBe(
      "/hr/settings?tab=late_detection#free-allowance",
    );
    // a severity is told in words as well as in colour
    expect(text(row)).toContain("Needs a look");
    expect(text(rowOf(ABSENT_ASHA))).toContain("Critical");
    expect(text(rowOf(ABSENT_ASHA).querySelector('[data-testid="issue-impact"]'))).toBe("Impact 1 day · ₹1,134.62");
  });

  it("says when each issue was detected: the day, prominently, on every day issue", () => {
    mount();
    const dayRows = rows().filter((r) => r.querySelector('[data-kind="day"]'));
    expect(dayRows).toHaveLength(6);
    for (const row of dayRows) {
      expect(text(row.querySelector('[data-testid="issue-detected"]'))).toMatch(
        /^Detected on \w{3}, \d{1,2} \w{3} 2026$/,
      );
    }
    // hover tells when payroll flagged it
    expect(rowOf(LATE).querySelector('[data-testid="issue-detected"]')?.getAttribute("title")).toBe(
      `Flagged by payroll ${dateTime(DETECTED_AT)}`,
    );
  });

  it("says a whole-period issue is about the whole period, and when payroll flagged it", () => {
    mount();
    const detected = must(`issue-row-${PENALTY}`).querySelector<HTMLElement>('[data-testid="issue-detected"]')!;
    expect(detected.dataset.kind).toBe("period");
    expect(text(detected)).toContain("Whole period");
    expect(text(detected)).toContain(`Flagged by payroll ${dateTime(DETECTED_AT)}`);
    // an impact's own label is kept
    expect(text(rowOf("101:ot_pay:period").querySelector('[data-testid="issue-impact"]'))).toBe(
      "Impact ₹1,200 · Added to pay",
    );
  });

  it("shows a title of its own when it says more than the type does, and not twice when it does not", () => {
    const long = makeIssue(BALA, "late_in", "2026-10-21", { title: "Late arrival (3rd this month)" });
    serve(makeResponse([...ISSUES, long]));
    mount();
    expect(text(rowOf(long.id).querySelector('[data-testid="issue-title"]'))).toBe("Late arrival (3rd this month)");
    expect(rowOf(LATE).querySelector('[data-testid="issue-title"]')).toBeNull();
  });

  it("hides the rule when there is none, and the link when the rule has no Settings page", () => {
    mount();
    expect(rowOf(ABSENT_ASHA).querySelector('[data-testid="issue-rule"]')).toBeNull();
    const shift = rowOf("102:no_shift:period");
    expect(text(shift.querySelector('[data-testid="issue-rule"]'))).toContain("Shift assignment");
    expect(shift.querySelector('[data-testid="issue-rule-link"]')).toBeNull();
  });

  it("does not link a rule to an address that is not a page of this app", () => {
    const odd = makeIssue(BALA, "late_in", "2026-10-22", {
      rule: { label: "Odd rule", settingsPath: "javascript:alert(1)" },
    });
    serve(makeResponse([...ISSUES, odd]));
    mount();
    const row = rowOf(odd.id);
    expect(text(row.querySelector('[data-testid="issue-rule"]'))).toContain("Odd rule");
    expect(row.querySelector('[data-testid="issue-rule-link"]')).toBeNull();
    expect(document.body.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it("opens the details of the payroll an issue belongs to", () => {
    mount();
    click(rowOf(LATE).querySelector('[data-testid="issue-open-details"]'));
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.open).toHaveBeenCalledWith(ISSUES[0]);
    // every issue of an employee with a payroll has the button, and no employee link
    expect(rows().every((r) => r.querySelector('[data-testid="issue-open-details"]'))).toBe(true);
    expect(rows().some((r) => r.querySelector('[data-testid="issue-open-employee"]'))).toBe(false);
  });
});

describe("the Issues panel, by employee", () => {
  const toEmployee = () => click(tab("Employee"));

  it("lists the employees as collapsed accordions, the worst first, each with their counts", () => {
    mount();
    toEmployee();
    expect(must("issues-list").dataset.groupBy).toBe("employee");
    expect(groupKeys("employee")).toEqual(["issues-employee-PC-S2", "issues-employee-PC-S1", "issues-employee-PC-S3"]);
    expect(rows()).toHaveLength(0); // nothing opened yet
    const asha = must("issues-employee-PC-S1");
    expect(asha.dataset.open).toBe("false");
    expect(text(asha)).toContain("Asha Worker");
    expect(text(asha)).toContain("PC-S1 · Weaving · Weaver");
    expect(text(asha.querySelector('[data-testid="issues-employee-count"]'))).toBe("4 issues");
    expect(text(asha.querySelector('[data-testid="issues-employee-impact"]'))).toBe("Impact 1.25 days · ₹1,434.62");
    expect(text(asha.querySelector('[data-testid="severity-counts"]'))).toContain("Critical");
    expect(text(must("issues-showing"))).toBe("Showing employees 1–3 of 3 (11 issues)");
  });

  it("opens an accordion to its issues, without repeating the employee on each", () => {
    mount();
    toEmployee();
    const toggle = must("issues-employee-toggle-PC-S1");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(must("issues-employee-PC-S1").dataset.open).toBe("true");
    expect(rows().map((r) => r.dataset.code)).toEqual(["late_in", "absent", "late_penalty", "ot_pay"]);
    expect(rows().some((r) => r.querySelector('[data-testid="issue-employee"]'))).toBe(false);
    // the date detected is still on each
    expect(text(rowOf(LATE).querySelector('[data-testid="issue-detected"]'))).toBe("Detected on Tue, 13 Oct 2026");
    click(toggle);
    expect(rows()).toHaveLength(0);
  });

  it("opens and closes all of them", () => {
    mount();
    toEmployee();
    expect(text(must("issues-expand-all"))).toBe("Expand all");
    click(must("issues-expand-all"));
    expect(rows()).toHaveLength(11);
    expect(text(must("issues-expand-all"))).toBe("Collapse all");
    click(must("issues-expand-all"));
    expect(rows()).toHaveLength(0);
  });

  it("opens the details of the employee's payroll from the header", () => {
    mount();
    toEmployee();
    click(must("issues-employee-PC-S1").querySelector('[data-testid="issues-employee-open"]'));
    expect(h.open).toHaveBeenCalledWith(expect.objectContaining({ id: LATE, payrollId: 101 }));
  });

  it("offers the expand all only in this view", () => {
    mount();
    expect(q("issues-expand-all")).toBeNull();
  });
});

describe("the Issues panel, by type", () => {
  it("lists a header for each kind with its count and what it cost in all", () => {
    mount();
    click(tab("Type"));
    expect(must("issues-list").dataset.groupBy).toBe("type");
    expect(groupKeys("type")).toEqual([
      "issues-group-absent",
      "issues-group-bank_missing",
      "issues-group-half_day",
      "issues-group-late_in",
      "issues-group-late_penalty",
      "issues-group-missing_punch",
      "issues-group-no_shift",
      "issues-group-unpaid_leave",
      "issues-group-ot_pay",
      "issues-group-pf_number_missing",
    ]);
    const title = (key: string) => text(must(key).querySelector('[data-testid="issues-group-title"]'));
    expect(title("issues-group-absent")).toBe("· 2 issues · Total impact 2 days · ₹2,034.62");
    expect(title("issues-group-bank_missing")).toBe("· 1 issue");
    expect(title("issues-group-ot_pay")).toBe("· 1 issue · Total impact ₹1,200");
    expect(text(must("issues-group-absent"))).toContain("Absent");
    // the rows of a kind still say whose they are
    expect(must("issues-group-absent").querySelectorAll('[data-testid="issue-employee"]')).toHaveLength(2);
  });
});

describe("the filters", () => {
  it("search narrows the list, shows how many are left, and Reset (with the count) brings everything back", () => {
    mount();
    expect(q("issues-reset")).toBeNull();
    typeInto(must("issues-search") as HTMLInputElement, "asha");
    expect(rows()).toHaveLength(4);
    expect(text(must("issues-showing"))).toBe("Showing 1–4 of 4 issues · 11 issues in this period");
    const reset = must("issues-reset");
    expect(text(reset)).toBe("Reset1");
    expect(reset.getAttribute("aria-label")).toBe("Reset 1 filter");

    click(must("issues-kpi-critical")); // a second filter
    expect(rows()).toHaveLength(1);
    expect(text(must("issues-reset"))).toBe("Reset2");

    click(must("issues-reset"));
    expect(rows()).toHaveLength(11);
    expect((must("issues-search") as HTMLInputElement).value).toBe("");
    expect(q("issues-reset")).toBeNull();
  });

  it("the type quick filter and the severity tile toggle", () => {
    mount();
    click(must("issues-type-absent"));
    expect(rows().map((r) => r.dataset.code)).toEqual(["absent", "absent"]);
    expect(must("issues-type-absent").getAttribute("aria-pressed")).toBe("true");
    expect(must("issues-type-all").getAttribute("aria-pressed")).toBe("false");
    click(must("issues-type-absent"));
    expect(rows()).toHaveLength(11);
    click(must("issues-type-all")); // All types is the way back from any one

    click(must("issues-kpi-info"));
    expect(rows()).toHaveLength(2);
    expect(must("issues-kpi-info").getAttribute("aria-pressed")).toBe("true");
    click(must("issues-kpi-info"));
    expect(rows()).toHaveLength(11);
  });

  it("the selects keep one severity, one type or one department", () => {
    mount();
    pickOption(must("issues-severity"), /^Needs a look \(7\)$/);
    expect(rows()).toHaveLength(7);
    pickOption(must("issues-type"), /^Late arrival \(1\)$/);
    expect(rows().map((r) => r.dataset.code)).toEqual(["late_in"]);
    click(must("issues-reset"));
    pickOption(must("issues-dept"), "Stitching");
    expect(rows()).toHaveLength(4);
    expect(text(must("issues-reset"))).toBe("Reset1");
    // back to everything through the first item of a select
    pickOption(must("issues-dept"), "All departments");
    expect(rows()).toHaveLength(11);
  });

  it("a date range keeps the issues detected on those days, and says what it hides", () => {
    mount();
    expect(must("issues-from").getAttribute("min")).toBe("2026-10-01");
    expect(must("issues-from").getAttribute("max")).toBe("2026-10-31");
    typeInto(must("issues-from") as HTMLInputElement, "2026-10-14");
    expect(rows()).toHaveLength(3 /* 14, 15, 20 Oct */);
    expect(text(must("issues-showing"))).toContain("5 whole-period issues hidden by the date range");
    expect(must("issues-to").getAttribute("min")).toBe("2026-10-14");
    typeInto(must("issues-to") as HTMLInputElement, "2026-10-15");
    expect(rows().map((r) => r.dataset.testid)).toEqual([
      `issue-row-${ABSENT_ASHA}`,
      "issue-row-103:unpaid_leave:2026-10-15",
    ]);
    expect(text(must("issues-reset"))).toBe("Reset1"); // the two ends are one filter
    expect(q("issues-group-period")).toBeNull();
  });

  it("says nothing matches, with a Reset that brings it all back", () => {
    mount();
    typeInto(must("issues-search") as HTMLInputElement, "zzz");
    expect(rows()).toHaveLength(0);
    expect(text(must("issues-no-match"))).toContain("Nothing matches these filters");
    expect(text(must("issues-showing"))).toBe("No issues match · 11 issues in this period");
    expect(q("issues-all-clear")).toBeNull();
    click(must("issues-no-match-reset"));
    expect(rows()).toHaveLength(11);
    expect(q("issues-no-match")).toBeNull();
  });

  it("keeps the grouping when Reset clears the filters", () => {
    mount();
    click(tab("Employee"));
    typeInto(must("issues-search") as HTMLInputElement, "asha");
    click(must("issues-reset"));
    expect(must("issues-list").dataset.groupBy).toBe("employee");
  });

  it("clears the search with its own cross", () => {
    mount();
    typeInto(must("issues-search") as HTMLInputElement, "asha");
    click(document.body.querySelector('[aria-label="Clear search"]'));
    expect(rows()).toHaveLength(11);
  });
});

describe("the filters kept by the page", () => {
  const value = (over: Partial<IssueFilterState> = {}): IssueFilterState => ({ ...DEFAULT_ISSUE_FILTERS, ...over });

  it("shows what the page says, and asks the page to change it", () => {
    mount({ value: value({ severity: "critical" }), onChange: h.change });
    expect(rows()).toHaveLength(2);
    expect(must("issues-kpi-critical").getAttribute("aria-pressed")).toBe("true");
    expect(text(must("issues-reset"))).toBe("Reset1");

    typeInto(must("issues-search") as HTMLInputElement, "asha");
    expect(h.change).toHaveBeenLastCalledWith({ q: "asha" });
    expect(rows()).toHaveLength(2); // the page has not changed its value, so nothing moves
    expect((must("issues-search") as HTMLInputElement).value).toBe("");

    click(must("issues-type-absent"));
    expect(h.change).toHaveBeenLastCalledWith({ code: "absent" });
    click(tab("Type"));
    expect(h.change).toHaveBeenLastCalledWith({ groupBy: "type" });
    typeInto(must("issues-from") as HTMLInputElement, "2026-10-05");
    expect(h.change).toHaveBeenLastCalledWith({ from: "2026-10-05" });
  });

  it("follows the page when its value changes", () => {
    mount({ value: value(), onChange: h.change });
    expect(rows()).toHaveLength(11);
    rerender({ value: value({ q: "chitra", groupBy: "employee" }), onChange: h.change });
    expect(must("issues-list").dataset.groupBy).toBe("employee");
    expect(groupKeys("employee")).toEqual(["issues-employee-PC-S3"]);
    expect((must("issues-search") as HTMLInputElement).value).toBe("chitra");
    rerender({ value: value({ dept: "Stitching", from: "2026-10-14" }), onChange: h.change });
    expect(rows()).toHaveLength(1); // Bala's half day on 20 Oct
  });

  it("Reset asks the page to clear every filter but the grouping", () => {
    mount({ value: value({ q: "asha", severity: "warning", groupBy: "type" }), onChange: h.change });
    click(must("issues-reset"));
    expect(h.change).toHaveBeenLastCalledWith({ q: "", code: "", severity: "", dept: "", from: "", to: "" });
  });

  it("tells a page that is not controlling about every change too", () => {
    mount({ onChange: h.change });
    click(must("issues-kpi-warning"));
    expect(h.change).toHaveBeenLastCalledWith({ severity: "warning" });
    expect(rows()).toHaveLength(7);
  });

  it("is not thrown by anything the address may hold", () => {
    mount({ value: value({ severity: "bogus", groupBy: "zzz", from: "yesterday", code: "not_a_code" }) });
    // an unknown type is a filter that matches nothing; the unknown severity, grouping and date are ignored
    expect(text(must("issues-no-match"))).toContain("Nothing matches these filters");
    expect(text(must("issues-reset"))).toBe("Reset1");
    expect(must("issues-type").textContent).toContain("not_a_code"); // the select still names what it is filtering by
  });
});

describe("pages", () => {
  it("shows 30 issues to a page and moves between pages", () => {
    serve(makeResponse(manyIssues(75)));
    mount();
    expect(rows()).toHaveLength(30);
    expect(text(must("issues-showing"))).toBe("Showing 1–30 of 75 issues");
    expect(document.body.querySelector('[aria-label="Page 3"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="Page 4"]')).toBeNull();

    click(document.body.querySelector('[aria-label="Page 2"]'));
    expect(rows()).toHaveLength(30);
    expect(text(must("issues-showing"))).toBe("Showing 31–60 of 75 issues");
    click(document.body.querySelector('[aria-label="Next page"]'));
    expect(rows()).toHaveLength(15);
    expect(text(must("issues-showing"))).toBe("Showing 61–75 of 75 issues");
  });

  it("does not show a page bar for a short list", () => {
    mount();
    expect(document.body.querySelector('[aria-label="Page 2"]')).toBeNull();
    expect(document.body.querySelector('[data-slot="page-info"]')).toBeNull();
  });

  it("goes back to page 1 when a filter changes", () => {
    serve(makeResponse(manyIssues(75)));
    mount();
    click(document.body.querySelector('[aria-label="Page 3"]'));
    expect(rows()).toHaveLength(15);
    typeInto(must("issues-search") as HTMLInputElement, "worker");
    expect(text(must("issues-showing"))).toContain("Showing 1–30 of 75 issues");
    click(document.body.querySelector('[aria-label="Page 2"]'));
    click(tab("Employee")); // a new grouping too
    expect(text(must("issues-showing"))).toContain("Showing employees 1–30 of 75");
  });

  it("by employee a page holds 30 employees and never cuts one in two", () => {
    serve(makeResponse(manyIssues(75)));
    mount();
    click(tab("Employee"));
    expect(all("issues-employee-count")).toHaveLength(30);
    click(document.body.querySelector('[aria-label="Page 3"]'));
    expect(all("issues-employee-count")).toHaveLength(15);
    expect(text(must("issues-showing"))).toBe("Showing employees 61–75 of 75 (75 issues)");
  });

  it("a day that goes on over the page break is marked continued", () => {
    // 35 issues all on one day: 30 on page 1, 5 on page 2
    const sameDay = manyIssues(35).map((i) => ({ ...i, date: "2026-10-13", id: `${i.id}x` }));
    serve(makeResponse(sameDay));
    mount();
    expect(text(must("issues-group-2026-10-13"))).not.toContain("(continued)");
    click(document.body.querySelector('[aria-label="Page 2"]'));
    expect(rows()).toHaveLength(5);
    expect(text(must("issues-group-2026-10-13"))).toContain("(continued)");
    expect(text(must("issues-group-2026-10-13").querySelector('[data-testid="issues-group-title"]'))).toBe(
      "Tue, 13 Oct 2026 · 35 issues",
    );
  });
});

describe("the employees payroll skipped", () => {
  it("are listed with the issues, critical, in the whole-period group", () => {
    mount({ skipped: SKIPPED });
    expect(text(must("issues-kpi-critical-value"))).toBe("4");
    expect(text(must("issues-kpi-employees-value"))).toBe("5");
    expect(text(must("issues-type-skipped"))).toBe("Skipped at generation 2");
    expect(text(must("issues-showing"))).toBe("Showing 1–13 of 13 issues");
    const skipped = must("issues-group-period").querySelectorAll<HTMLElement>('[data-code="skipped"]');
    expect(skipped).toHaveLength(2);
    expect(skipped[0].dataset.severity).toBe("critical");
  });

  it("show the reason as the detail and say how to fix it", () => {
    mount({ skipped: SKIPPED });
    const row = rowOf("skipped:21");
    expect(text(row.querySelector('[data-testid="issue-detail"]'))).toBe(
      "No Salary Amount set on this employee's profile",
    );
    expect(text(row.querySelector('[data-testid="issue-fix"]'))).toContain(
      "How to fix: Enter the employee's monthly salary",
    );
    expect(text(row.querySelector('[data-testid="issue-employee"]'))).toContain("Divya Nair");
    expect(text(row.querySelector('[data-testid="issue-employee"]'))).toContain("PC-S9 · Accounts");
    expect(text(row.querySelector('[data-testid="issue-impact"]'))).toBe("Impact Not paid until fixed");
    const detected = row.querySelector<HTMLElement>('[data-testid="issue-detected"]')!;
    expect(detected.dataset.kind).toBe("period");
    expect(text(detected)).toContain("Found when payroll was checked");
    // the second one points at the shift and the holidays
    expect(text(rowOf("skipped:22").querySelector('[data-testid="issue-fix"]'))).toContain("October 2026");
    expect(rowOf("skipped:22").querySelector('[data-testid="issue-fix"] a')?.getAttribute("href")).toBe("/hr/shifts");
  });

  it("open the employee instead of a details page they do not have", () => {
    mount({ skipped: SKIPPED });
    const row = rowOf("skipped:21");
    expect(row.querySelector('[data-testid="issue-open-details"]')).toBeNull();
    const link = row.querySelector('[data-testid="issue-open-employee"]');
    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("href")).toBe("/hr/employees/21");
    expect(text(link)).toBe("Open employee");
    expect(h.open).not.toHaveBeenCalled();
  });

  it("can be filtered with the rest", () => {
    mount({ skipped: SKIPPED });
    click(must("issues-type-skipped"));
    expect(rows()).toHaveLength(2);
    typeInto(must("issues-search") as HTMLInputElement, "divya");
    expect(rows()).toHaveLength(1);
    expect(rows()[0].dataset.testid).toBe("issue-row-skipped:21");
  });

  it("by employee, link to the employee rather than a payroll", () => {
    mount({ skipped: SKIPPED });
    click(tab("Employee"));
    const divya = must("issues-employee-PC-S9");
    const link = divya.querySelector('[data-testid="issues-employee-open"]');
    expect(link?.getAttribute("href")).toBe("/hr/employees/21");
    expect(text(link)).toBe("Open employee");
  });

  it("add nobody twice when the page hands over the same list again", () => {
    mount({ skipped: SKIPPED });
    rerender({ skipped: [...SKIPPED, ...SKIPPED] });
    expect(rows()).toHaveLength(13);
  });
});

describe("the export", () => {
  it("offers Excel and CSV", () => {
    mount();
    openExport();
    expect(text(must("issues-export-excel"))).toContain("Excel (.xlsx)");
    expect(text(must("issues-export-excel"))).toContain("11 issues, one sheet");
    expect(text(must("issues-export-csv"))).toContain("CSV");
    expect(text(must("issues-export-csv"))).toContain("11 issues, plain text");
  });

  it("writes every issue, in the order shown, with the columns asked for", async () => {
    mount();
    openExport();
    click(must("issues-export-csv"));
    await settle();
    expect(h.csv).toHaveBeenCalledTimes(1);
    const arg = h.csv.mock.calls[0][0];
    expect(arg.filename).toBe("Payroll_Issues_October_2026");
    expect(arg.rows).toHaveLength(11);
    expect(arg.rows[0].id).toBe(ABSENT_BALA); // the worst issue of the first day
    expect(arg.rows.at(-1).date).toBeNull(); // whole-period issues last
    expect(arg.columns.map((c: { label: string }) => c.label)).toEqual([
      "Date detected",
      "Employee code",
      "Employee",
      "Department",
      "Type",
      "Severity",
      "Title",
      "Details",
      "Impact",
      "Rule",
      "Flagged at",
    ]);
    expect(h.excel).not.toHaveBeenCalled();
  });

  it("writes the Excel sheet with the company, the period and a title", async () => {
    mount();
    openExport();
    click(must("issues-export-excel"));
    await settle();
    expect(h.excel).toHaveBeenCalledTimes(1);
    expect(h.excel).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "Payroll_Issues_October_2026",
        sheetName: "Issues",
        company: "UK Textiles Test",
        subtitle: "Staff Payroll · October 2026",
        title: "Payroll issues",
      }),
    );
    expect(h.excel.mock.calls[0][0].rows).toHaveLength(11);
  });

  it("writes only the issues the filters keep, and says so", async () => {
    mount();
    click(must("issues-kpi-critical"));
    typeInto(must("issues-search") as HTMLInputElement, "bala");
    openExport();
    expect(text(must("issues-export-excel"))).toContain("1 issue, filtered, one sheet");
    click(must("issues-export-excel"));
    await settle();
    const arg = h.excel.mock.calls[0][0];
    expect(arg.rows.map((r: PayrollIssue) => r.id)).toEqual([ABSENT_BALA]);
    expect(arg.subtitle).toBe('Staff Payroll · October 2026 · Filtered: Search "bala", Severity Critical');
  });

  it("writes the other pages' issues too, not only the page shown", async () => {
    serve(makeResponse(manyIssues(75)));
    mount();
    openExport();
    click(must("issues-export-csv"));
    await settle();
    expect(h.csv.mock.calls[0][0].rows).toHaveLength(75);
    expect(rows()).toHaveLength(30);
  });

  it("includes the skipped employees", async () => {
    mount({ skipped: SKIPPED });
    openExport();
    click(must("issues-export-csv"));
    await settle();
    const exported = h.csv.mock.calls[0][0].rows as PayrollIssue[];
    expect(exported).toHaveLength(13);
    expect(exported.filter((i) => i.code === "skipped")).toHaveLength(2);
  });

  it("names a production file and sheet after the period", async () => {
    serve(
      makeResponse(ISSUES, {
        scope: {
          ...STAFF_PERIOD,
          label: "5 Oct - 11 Oct 2026",
          start: "2026-10-05",
          end: "2026-10-11",
          cycle: "weekly",
          cycleLabel: "Weekly",
        },
      }),
    );
    mount({ scope: PRODUCTION_SCOPE, accent: "amber" });
    openExport();
    click(must("issues-export-excel"));
    await settle();
    expect(h.excel).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "Production_Payroll_Issues_5_Oct_11_Oct_2026",
        subtitle: "Production Payroll · 5 Oct - 11 Oct 2026",
        title: "Production payroll issues",
      }),
    );
    expect(must("issues-from").getAttribute("min")).toBe("2026-10-05");
    expect(must("issues-from").getAttribute("max")).toBe("2026-10-11");
  });

  it("falls back to a company name when the settings have not loaded", async () => {
    h.settings.mockReturnValue({ data: undefined });
    mount();
    openExport();
    click(must("issues-export-excel"));
    await settle();
    expect(h.excel.mock.calls[0][0].company).toBe("UK Textiles");
  });

  it("has nothing to export when nothing matches", () => {
    mount();
    typeInto(must("issues-search") as HTMLInputElement, "zzz");
    openExport();
    expect(must("issues-export-excel").getAttribute("aria-disabled")).toBe("true");
    expect(must("issues-export-csv").getAttribute("aria-disabled")).toBe("true");
  });

  it("tells the reader when writing the file fails", async () => {
    h.excel.mockRejectedValueOnce(new Error("disk full"));
    mount();
    openExport();
    click(must("issues-export-excel"));
    await settle();
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not export Excel (.xlsx)",
        description: "disk full",
        variant: "destructive",
      }),
    );
  });
});

describe("a View Only role", () => {
  it("can still export, filter, group and open details: the panel only reads", () => {
    mount();
    // a plain Export button elsewhere on the page is locked ...
    const stray = document.createElement("button");
    stray.textContent = "Export";
    document.body.append(stray);
    lockMutatingControls(document.body);
    expect(stray.disabled).toBe(true);
    // ... the panel's controls are not
    const trigger = must("issues-export") as HTMLButtonElement;
    expect(isMutatingControl(trigger)).toBe(false);
    expect(trigger.disabled).toBe(false);
    for (const button of document.body.querySelectorAll<HTMLButtonElement>('[data-testid="issues-panel"] button')) {
      expect(button.disabled, `${text(button)} is locked`).toBe(false);
    }
    expect(trigger.closest("[data-view-safe]")).not.toBeNull();
  });

  it("keeps working even when a department's name sounds like an action", () => {
    serve(makeResponse([...ISSUES, makeIssue({ ...ASHA, department: "Block Printing" }, "late_in", "2026-10-16")]));
    mount({ value: { ...DEFAULT_ISSUE_FILTERS, dept: "Block Printing" } });
    const select = must("issues-dept") as HTMLButtonElement;
    expect(text(select)).toContain("Block Printing");
    const bare = document.createElement("button");
    bare.textContent = "Block Printing";
    expect(isMutatingControl(bare)).toBe(true); // outside the panel the lock would take it for an action
    lockMutatingControls(document.body);
    expect(select.disabled).toBe(false);
    expect(rows()).toHaveLength(1);
  });

  it("can open an export menu opened after the lock ran", async () => {
    mount();
    lockMutatingControls(document.body);
    openExport();
    click(must("issues-export-csv"));
    await settle();
    expect(h.csv).toHaveBeenCalledTimes(1);
  });
});

describe("the look", () => {
  it("fills the group-by pill with the page's accent", () => {
    mount({ accent: "indigo" });
    const fill = document.body.querySelector<HTMLElement>('[data-slot="pill-tab-fill"]')!;
    expect(fill.style.background).toBe("rgb(79, 70, 229)");
    act(() => root!.unmount());
    host!.remove();
    mount({ accent: "amber" });
    expect(document.body.querySelector<HTMLElement>('[data-slot="pill-tab-fill"]')!.style.background).toBe(
      "rgb(217, 119, 6)",
    );
  });

  it("labels its controls for a screen reader", () => {
    mount();
    expect(document.body.querySelector('[role="search"]')?.getAttribute("aria-label")).toBe("Filter issues");
    expect(must("issues-search").getAttribute("aria-label")).toBe("Search issues");
    expect(must("issues-severity").getAttribute("aria-label")).toBe("Filter by severity");
    expect(text(document.body.querySelector("label"))).toContain("Detected from");
    expect(document.body.querySelector('[role="tablist"]')).not.toBeNull();
    expect(must("issues-types").getAttribute("role")).toBe("group");
    expect(must("issues-showing").getAttribute("aria-live")).toBe("polite");
  });

  it("holds the panel in one element, so a page can place it anywhere", () => {
    const el = mount();
    expect(el.querySelectorAll('[data-testid="issues-panel"]')).toHaveLength(1);
    expect(el.firstElementChild?.getAttribute("data-testid")).toBe("issues-panel");
  });
});
