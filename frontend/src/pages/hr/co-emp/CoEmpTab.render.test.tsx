import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee } from "@/lib/api-client";
import type {
  CoverageCounts,
  CoverageParams,
  CoverageResponse,
  CoverageRow,
  PaginatedEmployeesParams,
} from "@/lib/api-client/custom-hooks";
import { CoEmpTab } from "./CoEmpTab";
import type { CoEmpFilters } from "./logic";

// The Co Emp tab in jsdom with the hooks faked: Staff and Production kept apart, the columns (and the actions that are NOT
// there), the PF/ESI hint, the switch with its TDS confirmation, the coverage strip and its two downloads.

const h = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
  coverage: vi.fn(),
  mutateAsync: vi.fn(),
  download: vi.fn(),
  toast: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/lib/api-client/custom-hooks", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks")>()),
  useListEmployeesPaginated: (params: PaginatedEmployeesParams) => h.list(params),
  useEmployeeCount: (params: Omit<PaginatedEmployeesParams, "page" | "pageSize">) => h.count(params),
  usePfEsiCoverage: (params: CoverageParams) => h.coverage(params),
  useUpdateEmployeeCoEmp: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
  downloadCoverageFile: (opts: unknown) => h.download(opts),
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

const emp = (id: number, code: string, first: string, over: Partial<Employee> = {}): Employee =>
  ({
    id,
    employeeCode: code,
    firstName: first,
    lastName: "Kumar",
    phone: `90000000${id}`,
    employmentType: "staff",
    departmentName: "Stitching",
    branchName: "Unit 1",
    unitCode: `U1-${id}`,
    status: "active",
    salaryType: "monthly",
    coEmpEnabled: false,
    tdsEnabled: false,
    tdsPercent: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  }) as Employee;

const EMPLOYEES: Employee[] = [
  emp(1, "S001", "Asha", { coEmpEnabled: true }),
  emp(2, "S002", "Bala"),
  emp(3, "S003", "Chitra", { tdsEnabled: true, tdsPercent: 10 }),
  emp(4, "P001", "Deepa", { employmentType: "production", coEmpEnabled: true }),
  emp(5, "P002", "Esha", { employmentType: "production" }),
];

const counts = (over: Partial<CoverageCounts> = {}): CoverageCounts => ({
  total: 3,
  coEmp: 1,
  tds: 1,
  notCoEmp: 1,
  withPf: 1,
  withEsi: 0,
  withBoth: 0,
  withAny: 1,
  withNeither: 0,
  notEvaluated: 0,
  ...over,
});

const SUMMARY: CoverageResponse = {
  asOf: "2026-10-24T10:00:00Z",
  filters: { type: "all", branchId: null },
  staff: counts({ total: 3, coEmp: 1, withPf: 1, withEsi: 1, withBoth: 1, withAny: 1, tds: 1, notCoEmp: 1 }),
  production: counts({ total: 2, coEmp: 1, tds: 0, notCoEmp: 1, withPf: 0, withAny: 0, notEvaluated: 1 }),
};

const verdict = (over: Partial<CoverageRow>): CoverageRow => ({
  id: 1,
  employeeCode: "S001",
  name: "Asha Kumar",
  employmentType: "staff",
  departmentName: "Stitching",
  branchId: 1,
  branchName: "Unit 1",
  category: "co_emp",
  pf: true,
  esi: true,
  pfRatePercent: 12,
  esiRatePercent: 0.75,
  status: "pf_esi",
  tdsPercent: null,
  ...over,
});

function serve(rows: Employee[] = EMPLOYEES, detail: CoverageRow[] = [verdict({})]) {
  h.list.mockImplementation((params: PaginatedEmployeesParams) => {
    const results = rows.filter((e) => e.employmentType === params.employmentType);
    return {
      data: { results, count: results.length, staffCount: 0, productionCount: 0, page: 1, pageSize: params.pageSize },
      isLoading: false,
      isError: false,
      isPlaceholderData: false,
      refetch: h.refetch,
    };
  });
  h.count.mockImplementation((params: { employmentType?: string }) => ({
    data: rows.filter((e) => e.employmentType === params.employmentType).length,
  }));
  h.coverage.mockImplementation((params: CoverageParams) => ({
    data: params.detail ? { ...SUMMARY, employees: detail } : SUMMARY,
    isLoading: false,
    isError: false,
    refetch: h.refetch,
  }));
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const onClassChange = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  serve();
  h.mutateAsync.mockResolvedValue({});
  h.download.mockResolvedValue("pf_esi_coverage_all.xlsx");
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(cls: "staff" | "production" = "staff", filters: CoEmpFilters = { status: "active" }) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(CoEmpTab, { cls, onClassChange, filters })));
  return host;
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the page shows: ${text(document.body)}`);
  return el;
};
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const lastList = () => h.list.mock.calls.at(-1)?.[0] as PaginatedEmployeesParams;
const rowIds = () =>
  [...document.body.querySelectorAll('[data-testid^="row-employee-"]')].map((r) =>
    (r as HTMLElement).dataset.testid!.replace("row-employee-", ""),
  );

describe("Staff and Production kept apart", () => {
  it("lists only the staff when the Staff pill is picked, and asks the server for staff", () => {
    mount("staff");
    expect(lastList().employmentType).toBe("staff");
    expect(rowIds()).toEqual(["1", "2", "3"]);
  });

  it("lists only the production employees on the Production pill", () => {
    mount("production");
    expect(lastList().employmentType).toBe("production");
    expect(rowIds()).toEqual(["4", "5"]);
  });

  it("shows how many of each class the filters leave, on the pills", () => {
    mount("staff");
    const pills = must("coemp-class-tabs");
    const tabs = [...pills.querySelectorAll('[role="tab"]')];
    // the pill draws each label twice (its animation): the first copy is the readable one
    const label = (tab: Element) => text(tab.querySelector(".ptab-label"));
    expect(tabs.map(label)).toEqual(["Staff(3)", "Production(2)"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    // the counts are asked for per class, with the same filters
    expect(h.count).toHaveBeenCalledWith({ status: "active", employmentType: "staff" });
    expect(h.count).toHaveBeenCalledWith({ status: "active", employmentType: "production" });
  });

  it("tells the page when the other pill is clicked", () => {
    mount("staff");
    click(must("coemp-class-tabs").querySelectorAll('[role="tab"]')[1]);
    expect(onClassChange).toHaveBeenCalledWith("production");
  });

  it("passes the page's filters on to the list request", () => {
    mount("staff", { departmentId: 3, branchId: 2, status: "inactive", search: "asha" });
    expect(lastList()).toMatchObject({
      departmentId: 3,
      branchId: 2,
      status: "inactive",
      search: "asha",
      employmentType: "staff",
      page: 1,
      pageSize: 10,
    });
    expect(h.coverage).toHaveBeenCalledWith({ type: "all", branchId: 2 });
    expect(h.coverage).toHaveBeenCalledWith({ type: "staff", branchId: 2, detail: true });
  });

  it("never lists the previous class's rows while a new pill loads", () => {
    h.list.mockReturnValue({
      data: { results: [EMPLOYEES[0]], count: 1, staffCount: 1, productionCount: 0, page: 1, pageSize: 10 },
      isLoading: false,
      isError: false,
      isPlaceholderData: true,
      refetch: h.refetch,
    });
    mount("production");
    expect(rowIds()).toEqual([]);
    expect(text(must("coemp-table"))).not.toContain("No production employees found");
  });
});

describe("the table", () => {
  it("has only what decides the switch, and no actions column", () => {
    mount("staff");
    const table = must("coemp-table");
    const headers = [...table.querySelectorAll("th")].map((th) => text(th));
    expect(headers).toEqual([
      "Code",
      "Unit Code",
      "Name",
      "Department",
      "Branch",
      "Phone",
      "Status",
      "PF/ESI status",
      "Co Emp",
    ]);
    expect(headers).not.toContain("Actions");
    expect(headers).not.toContain("Salary");
    // none of the roster's per-row actions
    for (const prefix of ["button-view-", "button-edit-", "button-delete-", "button-toggle-"]) {
      expect(document.body.querySelector(`[data-testid^="${prefix}"]`), prefix).toBeNull();
    }
    const names = [...table.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? text(b));
    expect(names.filter((n) => /view|edit|delete|deactivate|activate|inactive/i.test(n))).toEqual([]);
  });

  it("shows each employee's code, unit code, name, department, branch, phone and status", () => {
    mount("staff");
    const row = text(must("row-employee-2"));
    for (const part of ["S002", "U1-2", "Bala Kumar", "Stitching", "Unit 1", "900000002", "active"]) {
      expect(row, part).toContain(part);
    }
  });

  it("has one switch per row, on where Co Emp is on", () => {
    mount("staff");
    expect(must("switch-coemp-1").getAttribute("aria-checked")).toBe("true");
    expect(must("switch-coemp-2").getAttribute("aria-checked")).toBe("false");
    expect(must("switch-coemp-3").getAttribute("aria-checked")).toBe("false");
    expect(must("switch-coemp-1").getAttribute("aria-label")).toBe("Toggle Co Emp for Asha Kumar");
  });

  it("shows the PF/ESI status of each category", () => {
    mount("staff");
    expect(text(must("coemp-hint-1"))).toContain("PF + ESI");
    expect(text(must("coemp-hint-1"))).toContain("PF 12% · ESI 0.75%");
    expect(text(must("coemp-hint-2"))).toContain("No PF/ESI");
    expect(text(must("coemp-hint-3"))).toContain("TDS 10%");
  });

  it("falls back to the category while the verdicts have not arrived", () => {
    h.coverage.mockImplementation((params: CoverageParams) => ({
      data: params.detail ? undefined : SUMMARY,
      isLoading: !!params.detail,
      isError: false,
      refetch: h.refetch,
    }));
    mount("staff");
    expect(text(must("coemp-hint-1"))).toContain("PF/ESI rules apply");
  });

  it("says so when the class has nobody", () => {
    serve([]);
    mount("production");
    expect(text(must("coemp-table"))).toContain("No production employees found");
  });

  it("says when the list could not load, and Retry asks again", () => {
    h.list.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      isPlaceholderData: false,
      refetch: h.refetch,
    });
    mount("staff");
    const error = must("load-error");
    expect(text(error)).toContain("Could not load the employees");
    click([...error.querySelectorAll("button")].find((b) => text(b) === "Retry")!);
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });
});

describe("the Co Emp switch", () => {
  it("turns Co Emp ON straight away for an employee who is not in TDS", async () => {
    mount("staff");
    click(must("switch-coemp-2"));
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    await settle();
    expect(h.mutateAsync).toHaveBeenCalledWith({ employeeId: 2, enabled: true });
    expect(h.toast).toHaveBeenCalledWith({
      title: "S002 is now Co Emp",
      description: "PF/ESI rules apply from the next payroll.",
    });
  });

  it("turns Co Emp OFF straight away", async () => {
    mount("staff");
    click(must("switch-coemp-1"));
    await settle();
    expect(h.mutateAsync).toHaveBeenCalledWith({ employeeId: 1, enabled: false });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "S001 is no longer Co Emp" }));
  });

  it("asks first when turning ON for an employee in TDS, and does nothing on Cancel", async () => {
    mount("staff");
    click(must("switch-coemp-3"));
    const dialog = must("coemp-confirm-dialog");
    expect(text(dialog)).toContain(
      "This employee is in TDS. Turning Co Emp on moves them out of TDS and applies PF/ESI rules.",
    );
    expect(text(dialog)).toContain("S003");
    expect(h.mutateAsync).not.toHaveBeenCalled();
    click(must("coemp-confirm-cancel"));
    await settle();
    expect(h.mutateAsync).not.toHaveBeenCalled();
    expect(q("coemp-confirm-dialog")).toBeNull();
  });

  it("moves an employee out of TDS when the question is confirmed", async () => {
    mount("staff");
    click(must("switch-coemp-3"));
    click(must("coemp-confirm"));
    await settle();
    expect(h.mutateAsync).toHaveBeenCalledTimes(1);
    expect(h.mutateAsync).toHaveBeenCalledWith({ employeeId: 3, enabled: true });
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "S003 is now Co Emp",
        description: "Moved out of TDS (10%). PF/ESI rules apply from the next payroll.",
      }),
    );
  });

  it("shows the server's message when the change is refused", async () => {
    h.mutateAsync.mockRejectedValue(
      Object.assign(new Error("HTTP 403"), {
        status: 403,
        data: { error: "permission_denied", message: "Not allowed." },
      }),
    );
    mount("staff");
    click(must("switch-coemp-2"));
    await settle();
    expect(h.toast).toHaveBeenCalledWith({
      title: "Could not update Co Emp",
      description: "Not allowed.",
      variant: "destructive",
    });
    // the switch is usable again
    expect(must("switch-coemp-2").hasAttribute("disabled")).toBe(false);
  });

  it("keeps the row's switch disabled while its change is being saved", async () => {
    let finish!: () => void;
    h.mutateAsync.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    mount("staff");
    click(must("switch-coemp-2"));
    expect(must("switch-coemp-2").hasAttribute("disabled")).toBe(true);
    expect(must("switch-coemp-1").hasAttribute("disabled")).toBe(false);
    finish();
    await settle();
    expect(must("switch-coemp-2").hasAttribute("disabled")).toBe(false);
  });
});

describe("the coverage strip", () => {
  it("shows both classes' numbers in the owner's columns", () => {
    mount("staff");
    const headers = [...must("coverage-table").querySelectorAll("th")].map((th) => text(th));
    expect(headers).toEqual([
      "Class",
      "Co Emp",
      "With PF",
      "With ESI",
      "With PF + ESI",
      "Co Emp, no deduction",
      "TDS",
      "Not Co Emp",
    ]);
    expect(text(must("coverage-row-staff"))).toContain("3 active");
    for (const [cell, value] of [
      ["coverage-staff-coEmp", "1"],
      ["coverage-staff-withPf", "1"],
      ["coverage-staff-withEsi", "1"],
      ["coverage-staff-withBoth", "1"],
      ["coverage-staff-withNeither", "0"],
      ["coverage-staff-tds", "1"],
      ["coverage-staff-notCoEmp", "1"],
      ["coverage-production-coEmp", "1"],
      ["coverage-production-tds", "0"],
    ] as const) {
      expect(text(must(cell)), cell).toBe(value);
    }
  });

  it("marks the class on screen, and a class row picks its pill", () => {
    mount("production");
    expect(must("coverage-row-production").dataset.selected).toBe("true");
    expect(must("coverage-row-staff").dataset.selected).toBeUndefined();
    click(must("coverage-select-staff"));
    expect(onClassChange).toHaveBeenCalledWith("staff");
  });

  it("says how many production Co Emp employees have no payroll yet", () => {
    mount("staff");
    expect(text(must("coverage-note"))).toBe(
      "1 Co Emp employee has no payroll generated yet, so their PF/ESI is not counted above.",
    );
  });

  it("says when the numbers could not load, without hiding the employees", () => {
    h.coverage.mockImplementation(() => ({ data: undefined, isLoading: false, isError: true, refetch: h.refetch }));
    mount("staff");
    expect(text(must("coverage-error"))).toContain("Could not load the coverage numbers");
    expect(q("coverage-table")).toBeNull();
    expect(rowIds()).toEqual(["1", "2", "3"]);
    click([...must("coverage-error").querySelectorAll("button")].find((b) => text(b) === "Retry")!);
    expect(h.refetch).toHaveBeenCalled();
  });

  it("downloads Excel and PDF for both classes, for the branch filter in force", async () => {
    mount("staff", { status: "active", branchId: 2 });
    expect(text(must("coverage-download-xlsx"))).toBe("Download Excel");
    expect(text(must("coverage-download-pdf"))).toBe("Download PDF");
    click(must("coverage-download-xlsx"));
    await settle();
    expect(h.download).toHaveBeenLastCalledWith({ format: "xlsx", type: "all", branchId: 2 });
    expect(h.toast).toHaveBeenCalledWith({ title: "Excel downloaded", description: "pf_esi_coverage_all.xlsx" });
    click(must("coverage-download-pdf"));
    await settle();
    expect(h.download).toHaveBeenLastCalledWith({ format: "pdf", type: "all", branchId: 2 });
  });

  it("shows why a download failed", async () => {
    h.download.mockRejectedValue(new Error("The PDF file could not be created (HTTP 500)."));
    mount("staff");
    click(must("coverage-download-pdf"));
    await settle();
    expect(h.toast).toHaveBeenCalledWith({
      title: "Could not download the PDF file",
      description: "The PDF file could not be created (HTTP 500).",
      variant: "destructive",
    });
    expect(must("coverage-download-pdf").hasAttribute("disabled")).toBe(false);
  });

  it("disables both buttons while one file is being prepared", async () => {
    let finish!: (name: string) => void;
    h.download.mockReturnValue(new Promise<string>((resolve) => (finish = resolve)));
    mount("staff");
    click(must("coverage-download-xlsx"));
    expect(must("coverage-download-xlsx").hasAttribute("disabled")).toBe(true);
    expect(must("coverage-download-pdf").hasAttribute("disabled")).toBe(true);
    finish("x.xlsx");
    await settle();
    expect(must("coverage-download-xlsx").hasAttribute("disabled")).toBe(false);
  });
});
