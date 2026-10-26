import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayrollRulesResponse } from "@/lib/api-client/custom-hooks";
import { isMutatingControl, lockMutatingControls } from "@/lib/view-only-lock";
import { EMPLOYEE_RULES, makeRules, manyEmployees } from "./fixtures";
import { RulesPanel, type RulesPanelProps } from "./RulesPanel";
import { STAFF_SCOPE, PRODUCTION_SCOPE } from "../issues/fixtures";

// The Rules panel in jsdom with the data hook faked: the rules configured on the Settings page (grouped, each with the
// link to change it) and the rules assigned to each employee (a table with chips and warning flags, filters, a row that
// opens to the employee's full rules), loading / error / empty states, the export and the view-only lock.

const h = vi.hoisted(() => ({
  rules: vi.fn(),
  settings: vi.fn(),
  pfEsi: vi.fn(),
  refetch: vi.fn(),
  excel: vi.fn(),
  csv: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/components/payroll/kit/export-table", () => ({ exportTableToExcel: h.excel, exportTableToCsv: h.csv }));
vi.mock("@/lib/api-client/custom-hooks", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks")>()),
  usePayrollRules: (...args: unknown[]) => h.rules(...args),
  usePayrollSettings: () => h.settings(),
}));

// the PF / ESI rule counts the note at the top reads (GET /api/pf-esi-settings)
vi.mock("@/components/payroll/kit/statutory-rules", async (original) => ({
  ...(await original<typeof import("@/components/payroll/kit/statutory-rules")>()),
  usePfEsiRulesSlice: () => h.pfEsi(),
}));

const RULE = { id: "r1", label: "Below 25,000", basis: "basic", minAmount: 0, maxAmount: 25000, ratePercent: 12 };
const pfEsiSlice = (over: Record<string, unknown> = {}) => ({
  data: {
    scope: { branchId: null, branchName: null, isOverride: false },
    canEdit: true,
    staff: { pfRules: [RULE], esiRules: [{ ...RULE, id: "r2", ratePercent: 0.75 }] },
    production: { pfRules: [], esiRules: [] },
    branches: [],
    ...over,
  },
  isLoading: false,
  isError: false,
});

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

const serve = (data: PayrollRulesResponse | undefined, over: Record<string, unknown> = {}) =>
  h.rules.mockReturnValue({ data, isLoading: false, isError: false, refetch: h.refetch, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  serve(makeRules());
  h.settings.mockReturnValue({ data: { companyName: "UK Textiles Test" } });
  h.pfEsi.mockReturnValue(pfEsiSlice());
  h.excel.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
});

const props = (over: Partial<RulesPanelProps> = {}): RulesPanelProps => ({
  scope: STAFF_SCOPE,
  accent: "indigo",
  ...over,
});

function mount(over: Partial<RulesPanelProps> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(RulesPanel, props(over))));
  return host;
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
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
const pickOption = (trigger: HTMLElement, label: string) => {
  press(trigger, "ArrowDown");
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => text(o) === label);
  if (!option) throw new Error(`no option ${label}`);
  click(option);
};
const employeeRows = () => [...document.body.querySelectorAll<HTMLElement>('[data-testid^="rules-row-"]')];
const names = () => employeeRows().map((r) => text(r.querySelector("td button span span")));
const openExport = () => press(must("rules-export"), "Enter");

describe("the Rules panel while it loads and when it cannot", () => {
  it("shows skeletons while the first load is on its way", () => {
    serve(undefined, { isLoading: true });
    mount();
    expect(q("rules-loading")).not.toBeNull();
    expect(q("skeleton-rows")).not.toBeNull();
    expect(q("rules-settings")).toBeNull();
    expect(q("rules-table")).toBeNull();
  });

  it("says when the rules could not load, and Retry asks again", () => {
    serve(undefined, { isError: true });
    mount();
    const error = must("rules-error");
    expect(text(error)).toContain("Could not load the rules");
    click([...error.querySelectorAll("button")].find((b) => text(b) === "Retry")!);
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  it("gives the server's reason, and shows Retry busy while it retries", () => {
    serve(undefined, { isError: true, error: new Error("HTTP 403 Forbidden"), isFetching: true });
    mount();
    expect(text(must("rules-error"))).toContain("You do not have permission to view this.");
    const retry = [...must("rules-error").querySelectorAll("button")].find((b) => text(b) === "Retry")!;
    expect(retry.disabled).toBe(true);
    expect(retry.querySelector(".animate-spin")).not.toBeNull();
  });

  it("asks the server for the scope and the narrowing it was given", () => {
    mount({ scope: PRODUCTION_SCOPE, filters: { departmentId: 2, branchId: 1 } });
    expect(h.rules).toHaveBeenLastCalledWith(PRODUCTION_SCOPE, { departmentId: 2, branchId: 1 });
  });
});

describe("the rules configured on the Settings page", () => {
  it("are cards, one for each group, each rule with its name, value and detail", () => {
    mount();
    const section = must("rules-settings");
    expect(text(section)).toContain("Rules configured on the Settings page");
    expect(text(section)).toContain("What payroll for October 2026 is calculated with");
    expect(must("rules-settings-groups").children).toHaveLength(3);
    const attendance = must("rules-group-0");
    expect(text(attendance.querySelector("h4"))).toBe("Attendance · 2 rules");
    const mode = attendance.querySelector<HTMLElement>('[data-testid="rule-attendance_mode"]')!;
    expect(text(mode.querySelector('[data-testid="rule-value"]'))).toBe("Strict (4-punch)");
    expect(text(mode.querySelector('[data-testid="rule-detail"]'))).toBe(
      "Four punches a day: in, lunch out, lunch in, out.",
    );
    expect(text(must("rules-group-1").querySelector("h4"))).toBe("Late deductions · 1 rule");
    expect(text(must("rules-group-2").querySelector("h4"))).toBe("PF and ESI · 2 rules");
  });

  it("link each rule to the Settings page where it is changed", () => {
    mount();
    const link = must("rules-group-0").querySelector('[data-testid="rule-attendance_mode"] [data-testid="rule-link"]');
    expect(text(link)).toBe("Edit in Settings");
    expect(link?.getAttribute("href")).toBe("/hr/settings?tab=attendance#attendance-mode");
    expect(must("rules-group-1").querySelector("a")?.getAttribute("href")).toBe(
      "/hr/settings?tab=late_detection#free-allowance",
    );
    expect(must("rules-group-2").querySelector("a")?.getAttribute("href")).toBe(
      "/hr/settings?tab=pf_esi#staff-pf-rules",
    );
    expect(must("rules-settings").querySelectorAll('[data-testid="rule-link"]')).toHaveLength(5);
  });

  it("start with who PF, ESI and TDS apply to, and where that is decided", () => {
    mount();
    const note = must("rules-statutory-note");
    expect(text(note)).toContain("PF and ESI are deducted only from Co Emp employees");
    expect(text(note)).toContain("Employees on the TDS list have TDS deducted at their own percentage instead");
    expect(note.querySelector('a[href="/hr/settings?tab=pf_esi"]')).not.toBeNull();
    expect(note.querySelector('a[href="/hr/employees"]')).not.toBeNull();
    // rules are set for Staff: nothing to warn about
    expect(q("rules-statutory-note-none")).toBeNull();
  });

  it("say so when no PF or ESI rule is set for this kind of payroll (read from Settings, never invented)", () => {
    mount({ scope: PRODUCTION_SCOPE, accent: "amber" }); // the fake answer has no Production rules
    expect(text(must("rules-statutory-note-none"))).toBe(
      "No PF or ESI rules are set for Production: nobody will have PF or ESI deducted until rules are added.",
    );
    expect(must("rules-statutory-note").querySelector("a")?.className).toContain("text-amber-700");
  });

  it("stay silent about the rules when they could not be read", () => {
    h.pfEsi.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    mount();
    expect(q("rules-statutory-note")).not.toBeNull(); // the sentence on who it applies to is static
    expect(q("rules-statutory-note-none")).toBeNull();
  });

  it("leave out a detail that is not there", () => {
    mount();
    expect(
      must("rules-group-0").querySelector('[data-testid="rule-late_window"] [data-testid="rule-detail"]'),
    ).toBeNull();
  });

  it("say so when there are none", () => {
    serve(makeRules({ settings: [] }));
    mount();
    expect(text(must("rules-settings-empty"))).toContain("No rules to show");
    expect(q("rules-table")).not.toBeNull(); // the employees are still listed
  });
});

describe("the rules assigned to each employee", () => {
  it("lists each employee with their department, chips and flags", () => {
    mount();
    expect(names()).toEqual(["Asha Worker", "Bala Kumar", "Chitra Devi", "Divya Nair"]);
    const asha = must("rules-row-PC-S1");
    const cells = [...asha.querySelectorAll("td")].map(text);
    expect(cells[0]).toBe("AWAsha WorkerPC-S1"); // the initials of the avatar, the name, the code
    expect(cells[1]).toBe("WeavingWeaver");
    expect(cells[2]).toBe("General 09:00-18:003 free lates");
    expect(cells[3]).toBe("All set");
    expect(asha.dataset.problem).toBeUndefined();
    // a person with no department or chips shows dashes
    const divya = must("rules-row-PC-S4");
    expect([...divya.querySelectorAll("td")].map(text).slice(1, 3)).toEqual(["—", "—"]);
  });

  it("colours the chips with the tone the server gave them", () => {
    mount();
    const chips = [...must("rules-row-PC-S1").querySelectorAll<HTMLElement>('[data-testid="rules-chips"] [data-tone]')];
    expect(chips.map((c) => [text(c), c.dataset.tone])).toEqual([
      ["General 09:00-18:00", "info"],
      ["3 free lates", "neutral"],
    ]);
    expect(must("rules-row-PC-S3").querySelector('[data-tone="accent"]')?.textContent).toBe("Weekly");
  });

  it("names each flag in words, as a warning chip", () => {
    mount();
    const flags = (code: string) =>
      [...must(`rules-row-${code}`).querySelectorAll<HTMLElement>('[data-testid="rules-flags"] [data-tone]')].map(
        (c) => [text(c), c.dataset.tone],
      );
    expect(flags("PC-S2")).toEqual([
      ["No shift assigned", "warning"],
      ["Bank details missing", "warning"],
    ]);
    // no_rate is a missing monthly salary on Staff Payroll; payroll cannot be generated for them
    expect(flags("PC-S3")).toEqual([["No salary amount", "danger"]]);
    expect(flags("PC-S4")).toEqual([["No pf number", "warning"]]); // a flag nobody has named
    expect(must("rules-row-PC-S2").dataset.problem).toBe("true");
  });

  it("calls the missing rate a rate per shift on Production Payroll, in the table and in the search", () => {
    mount({ scope: PRODUCTION_SCOPE, accent: "amber" });
    const flags = [...must("rules-row-PC-S3").querySelectorAll<HTMLElement>('[data-testid="rules-flags"] [data-tone]')];
    expect(flags.map((c) => [text(c), c.dataset.tone])).toEqual([["No rate per shift", "danger"]]);
    typeInto(must("rules-search") as HTMLInputElement, "rate per shift");
    expect(names()).toEqual(["Chitra Devi"]);
  });

  it("tells a chip's kind in its tooltip", () => {
    mount();
    const chips = [...must("rules-row-PC-S1").querySelectorAll<HTMLElement>('[data-testid="rules-chips"] [data-tone]')];
    expect(chips.map((c) => c.title)).toEqual(["Shift", "Late"]);
  });

  it("says how many employees, and how many have a rule problem", () => {
    mount();
    expect(text(must("rules-showing"))).toBe("Showing 1–4 of 4 employees · 3 with a rule problem");
  });

  it("opens a row to the employee's full rules, grouped, each with where it is changed", () => {
    mount();
    expect(q("rules-detail-PC-S1")).toBeNull();
    const toggle = must("rules-expand-PC-S1");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Show all rules of Asha Worker");
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Hide all rules of Asha Worker");
    const detail = must("rules-detail-PC-S1");
    expect([...detail.querySelectorAll("h4")].map(text)).toEqual(["Shift · 1 rule", "Salary · 2 rules"]);
    const shift = detail.querySelector<HTMLElement>('[data-testid="rule-shift"]')!;
    expect(text(shift.querySelector('[data-testid="rule-value"]'))).toBe("General 09:00-18:00");
    expect(text(shift.querySelector('[data-testid="rule-detail"]'))).toBe("Grace 10 min, Saturday working");
    expect(text(shift)).toContain("Shift"); // its source
    expect(shift.querySelector('[data-testid="rule-link"]')?.getAttribute("href")).toBe("/hr/shifts");
    expect(text(shift.querySelector('[data-testid="rule-link"]'))).toBe("Open Manage Shifts");
    // the salary comes from the profile
    const salary = detail.querySelector<HTMLElement>('[data-testid="rule-salary"]')!;
    expect(text(salary.querySelector('[data-testid="rule-link"]'))).toBe("Edit on profile");
    expect(salary.querySelector('[data-testid="rule-link"]')?.getAttribute("href")).toBe("/hr/employees/11/edit");
    expect(salary.dataset.source).toBe("employee");
    click(toggle);
    expect(q("rules-detail-PC-S1")).toBeNull();
  });

  it("says what a payroll was generated with and that the rule has changed since", () => {
    mount();
    click(must("rules-expand-PC-S1"));
    const pf = must("rules-detail-PC-S1").querySelector<HTMLElement>('[data-testid="rule-pf"]')!;
    expect(text(pf.querySelector('[data-testid="rule-applied"]'))).toBe(
      "Generated with 10% of Basic + DA + Retaining (Co Emp)",
    );
    expect(text(pf)).toContain("Changed since");
    expect(pf.querySelector('[data-testid="rule-link"]')?.getAttribute("href")).toBe(
      "/hr/settings?tab=pf_esi#staff-pf-rules",
    );
    expect(text(pf.querySelector('[data-testid="rule-link"]'))).toBe("Edit in Settings");
  });

  it("opens several rows at once, and says when an employee has no rules of their own", () => {
    mount();
    click(must("rules-expand-PC-S1"));
    click(must("rules-expand-PC-S3"));
    expect(q("rules-detail-PC-S1")).not.toBeNull();
    expect(text(must("rules-detail-PC-S3"))).toContain("No individual rules are recorded for this employee");
  });
});

describe("the filters", () => {
  it("search finds employees by name, code, department, a chip or a flag", () => {
    mount();
    typeInto(must("rules-search") as HTMLInputElement, "night");
    expect(names()).toEqual(["Chitra Devi"]);
    expect(text(must("rules-reset"))).toBe("Reset1");
    expect(text(must("rules-showing"))).toBe("Showing 1 of 1 employee · 4 in this period · 3 with a rule problem");
    typeInto(must("rules-search") as HTMLInputElement, "bank");
    expect(names()).toEqual(["Bala Kumar"]);
    typeInto(must("rules-search") as HTMLInputElement, "pc-s1");
    expect(names()).toEqual(["Asha Worker"]);
  });

  it("the department select keeps one department", () => {
    mount();
    pickOption(must("rules-dept"), "Weaving");
    expect(names()).toEqual(["Asha Worker", "Chitra Devi"]);
    pickOption(must("rules-dept"), "No department");
    expect(names()).toEqual(["Divya Nair"]);
    pickOption(must("rules-dept"), "All departments");
    expect(employeeRows()).toHaveLength(4);
  });

  it("only employees with rule problems keeps those with a flag", () => {
    mount();
    const sw = must("rules-problems-switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(text(document.body.querySelector(`label[for="${sw.id}"]`))).toBe("Only employees with rule problems (3)");
    click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(names()).toEqual(["Bala Kumar", "Chitra Devi", "Divya Nair"]);
    expect(text(must("rules-reset"))).toBe("Reset1");
    click(sw);
    expect(employeeRows()).toHaveLength(4);
    expect(q("rules-reset")).toBeNull();
  });

  it("filters combine, and Reset clears them all", () => {
    mount();
    click(must("rules-problems-switch"));
    pickOption(must("rules-dept"), "Weaving");
    expect(names()).toEqual(["Chitra Devi"]);
    expect(text(must("rules-reset"))).toBe("Reset2");
    typeInto(must("rules-search") as HTMLInputElement, "chitra");
    expect(text(must("rules-reset"))).toBe("Reset3");
    click(must("rules-reset"));
    expect(employeeRows()).toHaveLength(4);
    expect((must("rules-search") as HTMLInputElement).value).toBe("");
    expect(must("rules-problems-switch").getAttribute("aria-checked")).toBe("false");
  });

  it("says nothing matches, with a Reset", () => {
    mount();
    typeInto(must("rules-search") as HTMLInputElement, "zzz");
    expect(text(must("rules-no-match"))).toContain("Nothing matches these filters");
    expect(text(must("rules-showing"))).toBe("No employees match · 4 in this period · 3 with a rule problem");
    expect(q("rules-table")).toBeNull();
    expect(q("rules-settings-groups")).not.toBeNull(); // the Settings rules stay
    click([...must("rules-no-match").querySelectorAll("button")].find((b) => text(b) === "Reset filters")!);
    expect(employeeRows()).toHaveLength(4);
  });

  it("says when there are no employees at all", () => {
    serve(makeRules({ employees: [] }));
    mount();
    expect(text(must("rules-empty"))).toContain("No employees to show");
    expect(text(must("rules-empty"))).toContain("Generate payroll, and they will appear here");
    expect(q("rules-table")).toBeNull();
    expect(text(must("rules-showing"))).toBe("");
    // with nobody listed the export has nothing to write
    openExport();
    expect(must("rules-export-excel").getAttribute("aria-disabled")).toBe("true");
  });
});

describe("pages", () => {
  it("shows 25 employees to a page and keeps the page when a row is opened", () => {
    serve(makeRules({ employees: manyEmployees(60) }));
    mount();
    expect(employeeRows()).toHaveLength(25);
    expect(text(must("rules-showing"))).toContain("Showing 1–25 of 60 employees");
    click(document.body.querySelector('[aria-label="Page 3"]'));
    expect(employeeRows()).toHaveLength(10);
    expect(text(must("rules-showing"))).toContain("Showing 51–60 of 60 employees");
    click(must("rules-expand-R051"));
    expect(q("rules-detail-R051")).not.toBeNull();
    expect(employeeRows()).toHaveLength(10);
  });

  it("goes back to page 1 when a filter changes", () => {
    serve(makeRules({ employees: manyEmployees(60) }));
    mount();
    click(document.body.querySelector('[aria-label="Page 2"]'));
    expect(text(must("rules-showing"))).toContain("Showing 26–50");
    click(must("rules-problems-switch"));
    expect(text(must("rules-showing"))).toContain("Showing 1–12 of 12 employees");
    expect(employeeRows()).toHaveLength(12); // every fifth of 60
  });

  it("has no page bar for a short list", () => {
    mount();
    expect(document.body.querySelector('[data-slot="page-info"]')).toBeNull();
  });
});

describe("the export", () => {
  it("offers Excel and CSV", () => {
    mount();
    openExport();
    expect(text(must("rules-export-excel"))).toContain("Excel (.xlsx)");
    expect(text(must("rules-export-excel"))).toContain("4 employees, a column for each kind of rule");
    expect(text(must("rules-export-csv"))).toContain("4 employees, plain text");
  });

  it("writes every employee with a column for each kind of rule and the flags in words", async () => {
    mount();
    openExport();
    click(must("rules-export-csv"));
    await settle();
    expect(h.csv).toHaveBeenCalledTimes(1);
    const arg = h.csv.mock.calls[0][0];
    expect(arg.filename).toBe("Payroll_Rules_October_2026");
    expect(arg.rows).toEqual(EMPLOYEE_RULES);
    expect(arg.columns.map((c: { label: string }) => c.label)).toEqual([
      "Employee code",
      "Employee",
      "Department",
      "Designation",
      "Shift",
      "Late",
      "Pay cycle",
      "Flags",
    ]);
    const flags = arg.columns.find((c: { label: string }) => c.label === "Flags");
    expect(flags.value(EMPLOYEE_RULES[1])).toBe("No shift assigned; Bank details missing");
  });

  it("writes the Excel sheet with the company, the period and a title", async () => {
    mount();
    openExport();
    click(must("rules-export-excel"));
    await settle();
    expect(h.excel).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "Payroll_Rules_October_2026",
        sheetName: "Employee rules",
        company: "UK Textiles Test",
        subtitle: "Staff Payroll · October 2026",
        title: "Rules assigned to each employee",
      }),
    );
  });

  it("writes only the employees the filters keep, across all pages", async () => {
    serve(makeRules({ employees: manyEmployees(60) }));
    mount();
    click(must("rules-problems-switch"));
    openExport();
    expect(text(must("rules-export-csv"))).toContain("12 employees, filtered");
    click(must("rules-export-csv"));
    await settle();
    expect(h.csv.mock.calls[0][0].rows).toHaveLength(12);
  });

  it("writes the whole list when not filtered, though only a page is shown", async () => {
    serve(makeRules({ employees: manyEmployees(60) }));
    mount();
    openExport();
    click(must("rules-export-excel"));
    await settle();
    expect(h.excel.mock.calls[0][0].rows).toHaveLength(60);
    expect(h.excel.mock.calls[0][0].subtitle).toBe("Staff Payroll · October 2026");
    expect(employeeRows()).toHaveLength(25);
  });

  it("names a production file after the period", async () => {
    serve(
      makeRules({
        scope: {
          label: "5 Oct - 11 Oct 2026",
          start: "2026-10-05",
          end: "2026-10-11",
          month: 10,
          year: 2026,
          days: 7,
          cycle: "weekly",
          cycleLabel: "Weekly",
        },
      }),
    );
    mount({ scope: PRODUCTION_SCOPE, accent: "amber" });
    openExport();
    click(must("rules-export-excel"));
    await settle();
    expect(h.excel).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "Production_Payroll_Rules_5_Oct_11_Oct_2026",
        subtitle: "Production Payroll · 5 Oct - 11 Oct 2026",
      }),
    );
  });

  it("falls back to a company name, and reports a failed write", async () => {
    h.settings.mockReturnValue({ data: undefined });
    h.csv.mockImplementationOnce(() => {
      throw new Error("blocked");
    });
    mount();
    openExport();
    click(must("rules-export-csv"));
    await settle();
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not export CSV", description: "blocked", variant: "destructive" }),
    );
    // the menu closes once the export has settled, failed or not: open it again for the other format
    openExport();
    click(must("rules-export-excel"));
    await settle();
    expect(h.excel.mock.calls[0][0].company).toBe("UK Textiles");
  });
});

describe("a View Only role", () => {
  it("can still export, filter and open rows: the panel only reads", () => {
    mount();
    const stray = document.createElement("button");
    stray.textContent = "Export";
    document.body.append(stray);
    lockMutatingControls(document.body);
    expect(stray.disabled).toBe(true);
    const trigger = must("rules-export") as HTMLButtonElement;
    expect(isMutatingControl(trigger)).toBe(false);
    for (const button of document.body.querySelectorAll<HTMLButtonElement>('[data-testid="rules-panel"] button')) {
      expect(button.disabled, `${button.getAttribute("aria-label") ?? text(button)} is locked`).toBe(false);
    }
    expect(trigger.closest("[data-view-safe]")).not.toBeNull();
  });

  it("is not locked by an employee whose name sounds like an action", () => {
    serve(
      makeRules({ employees: [{ ...EMPLOYEE_RULES[0], employeeName: "Run Block", department: "Block Printing" }] }),
    );
    mount();
    const toggle = must("rules-expand-PC-S1") as HTMLButtonElement;
    expect(isMutatingControl(toggle)).toBe(false); // inside the panel
    lockMutatingControls(document.body);
    expect(toggle.disabled).toBe(false);
    click(toggle);
    expect(q("rules-detail-PC-S1")).not.toBeNull();
    expect((must("rules-problems-switch") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the look", () => {
  it("labels its controls", () => {
    mount();
    expect(document.body.querySelector('[role="search"]')?.getAttribute("aria-label")).toBe("Filter employees");
    expect(must("rules-search").getAttribute("aria-label")).toBe("Search employees");
    expect(must("rules-dept").getAttribute("aria-label")).toBe("Filter by department");
    expect(must("rules-problems-switch").getAttribute("aria-label")).toBe("Only employees with rule problems");
    expect(must("rules-expand-PC-S2").getAttribute("aria-controls")).toBeTruthy();
  });

  it("is one element a page can place anywhere, with its two sections", () => {
    const el = mount();
    expect(el.firstElementChild?.getAttribute("data-testid")).toBe("rules-panel");
    expect(q("rules-settings")).not.toBeNull();
    expect(q("rules-employees")).not.toBeNull();
    expect(must("rules-settings").id).toBe("rules-settings"); // a page's mini navigation can scroll to it
    expect(must("rules-employees").id).toBe("rules-employees");
  });

  it("keeps a wide table inside its own scroll area", () => {
    mount();
    const table = must("rules-table");
    expect(table.parentElement?.className).toContain("overflow-x-auto");
  });
});
