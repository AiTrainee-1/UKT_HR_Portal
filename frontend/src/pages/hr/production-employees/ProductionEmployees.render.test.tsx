import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssignProductionCycleResult,
  ProductionEmployeeFilters,
  ProductionEmployeeRow,
} from "@/lib/api-client/custom-hooks";
import ProductionEmployees from "../ProductionEmployees";

// The Production Employees page in jsdom with the hooks faked: the first load opening on Unassigned, the counts on the
// cards and tabs, what the list request carries as the filters change, ticking people and assigning them in bulk, the
// "move between cycles" confirmation, a row's Assign menu, and the chips of someone with no cycle or no rate.

const h = vi.hoisted(() => ({
  list: vi.fn(),
  cycles: vi.fn(),
  departments: vi.fn(),
  mutateAsync: vi.fn(),
  refetch: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/lib/api-client/custom-hooks", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks")>()),
  useProductionEmployees: (filters?: ProductionEmployeeFilters) => h.list(filters),
  useProductionCycles: () => h.cycles(),
  useAssignProductionCycle: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
}));
vi.mock("@/lib/api-client", async (original) => ({
  ...(await original<typeof import("@/lib/api-client")>()),
  useListDepartments: () => h.departments(),
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

const row = (id: number, name: string, over: Partial<ProductionEmployeeRow> = {}): ProductionEmployeeRow => ({
  id,
  employeeCode: `P${String(id).padStart(3, "0")}`,
  name,
  status: "active",
  departmentId: 1,
  departmentName: "Stitching",
  designationTitle: "Tailor",
  branchId: 1,
  branchName: "Unit 1",
  joinDate: "2025-06-01",
  salaryPerShift: 650,
  payCycle: null,
  lastPayroll: null,
  ...over,
});

const ROWS: ProductionEmployeeRow[] = [
  row(1, "Ravi Kumar", { salaryPerShift: null }),
  row(2, "Mani Selvam"),
  row(3, "Selvi Rani", {
    payCycle: "biweekly",
    lastPayroll: { periodStart: "2026-02-02", periodEnd: "2026-02-15", status: "pending", payCycle: "biweekly" },
  }),
  row(4, "Kumar Raj", {
    payCycle: "monthly",
    designationTitle: null,
    lastPayroll: { periodStart: "2026-01-05", periodEnd: "2026-02-01", status: "paid", payCycle: "monthly" },
  }),
];

const countsOf = (rows: ProductionEmployeeRow[]) => ({
  weekly: rows.filter((r) => r.payCycle === "weekly").length,
  biweekly: rows.filter((r) => r.payCycle === "biweekly").length,
  monthly: rows.filter((r) => r.payCycle === "monthly").length,
  unassigned: rows.filter((r) => r.payCycle === null).length,
  total: rows.length,
});

const onCycle = (r: ProductionEmployeeRow, cycle: ProductionEmployeeFilters["cycle"]) =>
  !cycle || cycle === "all" ? true : cycle === "unassigned" ? r.payCycle === null : r.payCycle === cycle;

/** A fake server: the list filtered by the cycle asked for; the counts, like the real ones, ignore the cycle. */
function serve(rows: ProductionEmployeeRow[]) {
  const counts = countsOf(rows);
  h.list.mockImplementation((filters?: ProductionEmployeeFilters) => ({
    data: { counts, employees: rows.filter((r) => onCycle(r, filters?.cycle)) },
    isLoading: false,
    isError: false,
    isPlaceholderData: false,
    refetch: h.refetch,
  }));
}

const assigned = (updated: number, over: Partial<AssignProductionCycleResult> = {}): AssignProductionCycleResult => ({
  updated,
  unchanged: 0,
  skipped: [],
  pendingOnOtherCycle: 0,
  counts: countsOf(ROWS),
  ...over,
});

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  serve(ROWS);
  h.cycles.mockReturnValue({ data: undefined });
  h.departments.mockReturnValue({
    data: [
      { id: 2, name: "Cutting" },
      { id: 1, name: "Stitching" },
    ],
  });
  h.mutateAsync.mockResolvedValue(assigned(1));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(ProductionEmployees)));
  return host;
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string) => document.body.querySelectorAll(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the page shows: ${text(document.body)}`);
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
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const lastFilters = () => h.list.mock.calls.at(-1)?.[0] as ProductionEmployeeFilters;
const tabButton = (tab: string) => must(`pe-tab-${tab}`).closest("button");
const dialog = () => document.body.querySelector('[role="alertdialog"]');

describe("the Production Employees page", () => {
  it("shows a skeleton while the first list loads", () => {
    h.list.mockReturnValue({ data: undefined, isLoading: true, isError: false, isPlaceholderData: false });
    mount();
    expect(q("production-employees-page")).not.toBeNull();
    expect(q("pe-loading")).not.toBeNull();
    expect(text(q("pe-stat-total-value"))).toBe("—");
    expect(q("pe-table")).toBeNull();
  });

  it("says when the list could not load, and Retry asks again", () => {
    h.list.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      isPlaceholderData: false,
      refetch: h.refetch,
    });
    mount();
    const error = document.body.querySelector('[data-testid="load-error"]');
    expect(text(error)).toContain("Could not load the production employees");
    click([...error!.querySelectorAll("button")].find((b) => text(b) === "Retry")!);
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  it("opens on Unassigned when anyone is, with the counts on the cards and the tabs", () => {
    mount();
    expect(tabButton("unassigned")?.getAttribute("aria-selected")).toBe("true");
    expect(lastFilters().cycle).toBe("unassigned");
    expect(q("pe-stat-unassigned")?.dataset.selected).toBe("true");
    expect(text(q("pe-stat-total-value"))).toBe("4");
    expect(text(q("pe-stat-weekly-value"))).toBe("0");
    expect(text(q("pe-stat-biweekly-value"))).toBe("1");
    expect(text(q("pe-stat-monthly-value"))).toBe("1");
    expect(text(q("pe-stat-unassigned-value"))).toBe("2");
    expect(text(q("pe-stat-unassigned"))).toContain("Not in any payroll yet");
    expect(text(q("pe-stat-weekly"))).toContain("One-week calculation · 7-day period");
    expect(text(q("pe-tab-all"))).toBe("All (4)");
    expect(text(q("pe-tab-unassigned"))).toBe("Unassigned (2)");
    expect(text(q("pe-tab-biweekly"))).toBe("BiWeekly (1)");
    // only the unassigned two are listed
    expect(q("pe-row-P001")).not.toBeNull();
    expect(q("pe-row-P002")).not.toBeNull();
    expect(q("pe-row-P003")).toBeNull();
    expect(text(q("pe-showing"))).toBe("Showing 1-2 of 2");
  });

  it("opens on All when everyone is assigned, and a stat card picks its tab", () => {
    serve(ROWS.map((r) => ({ ...r, payCycle: r.payCycle ?? "weekly" })));
    mount();
    expect(tabButton("all")?.getAttribute("aria-selected")).toBe("true");
    expect(lastFilters().cycle).toBe("all");
    expect(text(q("pe-stat-unassigned"))).toContain("Everyone is on a cycle");
    click(must("pe-stat-monthly").querySelector("button"));
    expect(tabButton("monthly")?.getAttribute("aria-selected")).toBe("true");
    expect(lastFilters().cycle).toBe("monthly");
    expect(q("pe-row-P004")).not.toBeNull();
    expect(q("pe-row-P001")).toBeNull();
  });

  it("sends the search (after a pause), the department and the status with the request", async () => {
    mount();
    expect(lastFilters()).toEqual({
      cycle: "unassigned",
      status: "active",
      search: undefined,
      departmentId: undefined,
    });
    typeInto(must("pe-search") as HTMLInputElement, "rav");
    expect(lastFilters().search).toBeUndefined(); // not yet: one request per pause, not per letter
    await settle(320);
    expect(lastFilters().search).toBe("rav");
    expect(q("pe-clear-filters")).not.toBeNull();

    // the status select, by keyboard: open it, choose Inactive
    press(must("pe-status-filter"), "ArrowDown");
    const inactive = [...document.body.querySelectorAll('[role="option"]')].find((o) => text(o) === "Inactive");
    expect(inactive).toBeDefined();
    click(inactive!);
    expect(lastFilters().status).toBe("inactive");

    press(must("pe-department-filter"), "ArrowDown");
    const cutting = [...document.body.querySelectorAll('[role="option"]')].find((o) => text(o) === "Cutting");
    click(cutting!);
    expect(lastFilters().departmentId).toBe(2);

    click(q("pe-clear-filters"));
    await settle(320);
    expect(lastFilters()).toEqual({
      cycle: "unassigned",
      status: "active",
      search: undefined,
      departmentId: undefined,
    });
    expect(q("pe-clear-filters")).toBeNull();
  });

  it("marks who is on no cycle and who has no rate", () => {
    mount();
    click(tabButton("all"));
    const ravi = must("pe-row-P001");
    expect(text(ravi)).toContain("Not assigned");
    expect(ravi.querySelector<HTMLElement>('[data-testid="pe-cycle-chip"]')?.dataset.cycle).toBe("none");
    expect(ravi.querySelector('[data-testid="pe-rate-unset"]')?.getAttribute("title")).toContain("payroll skips");
    expect(text(ravi)).toContain("Not set");
    const mani = must("pe-row-P002");
    expect(text(mani)).toContain("₹650");
    expect(mani.querySelector('[data-testid="pe-rate-unset"]')).toBeNull();
    const selvi = must("pe-row-P003");
    expect(selvi.querySelector<HTMLElement>('[data-testid="pe-cycle-chip"]')?.dataset.cycle).toBe("biweekly");
    expect(text(selvi)).toContain("2 Feb - 15 Feb 2026");
    expect(text(selvi)).toContain("Pending");
    expect(text(must("pe-row-P004"))).toContain("Cleared");
  });

  it("ticks people and assigns them in bulk, then clears the selection", async () => {
    h.mutateAsync.mockResolvedValue(assigned(2));
    mount();
    expect(q("pe-bulk-bar")).toBeNull();
    click(q("pe-select-P001"));
    expect(text(q("pe-selected-count"))).toBe("1 selected");
    click(q("pe-select-P002"));
    expect(text(q("pe-selected-count"))).toBe("All 2 selected");
    click(q("pe-bulk-weekly"));
    expect(dialog()).toBeNull(); // nobody leaves a cycle: no question asked
    await settle();
    expect(h.mutateAsync).toHaveBeenCalledWith({ employeeIds: [1, 2], cycle: "weekly" });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "2 employees assigned to Weekly" }));
    expect(q("pe-bulk-bar")).toBeNull();
  });

  it("the header checkbox ticks the whole list, and Clear selection empties it", () => {
    mount();
    click(q("pe-select-all"));
    expect(text(q("pe-selected-count"))).toBe("All 2 selected");
    expect(q("pe-select-P001")?.getAttribute("aria-checked")).toBe("true");
    click(q("pe-bulk-clear"));
    expect(q("pe-bulk-bar")).toBeNull();
  });

  it("asks before moving someone between cycles, and only then calls the server", async () => {
    h.mutateAsync.mockResolvedValue(assigned(2, { pendingOnOtherCycle: 1 }));
    mount();
    click(tabButton("all"));
    click(q("pe-select-P003")); // BiWeekly
    click(q("pe-select-P001")); // no cycle
    click(q("pe-bulk-weekly"));
    expect(h.mutateAsync).not.toHaveBeenCalled();
    expect(text(dialog())).toContain("Move 1 employee from BiWeekly to Weekly?");
    expect(text(dialog())).toContain("1 employee with no cycle yet will simply join Weekly.");
    click(q("pe-confirm-cancel"));
    await settle();
    expect(dialog()).toBeNull();
    expect(h.mutateAsync).not.toHaveBeenCalled();
    expect(q("pe-bulk-bar")).not.toBeNull(); // still ticked

    click(q("pe-bulk-weekly"));
    click(q("pe-confirm"));
    await settle();
    expect(h.mutateAsync).toHaveBeenCalledTimes(1);
    expect(h.mutateAsync.mock.calls[0][0]).toEqual({ employeeIds: [3, 1], cycle: "weekly" });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "2 employees assigned to Weekly" }));
  });

  it("asks before removing someone from their cycle", async () => {
    mount();
    click(tabButton("monthly"));
    click(q("pe-select-P004"));
    click(q("pe-bulk-none"));
    expect(text(dialog())).toContain("Remove 1 employee from their pay cycle?");
    expect(text(dialog())).toContain("They will not be included in any payroll until they are assigned again.");
    click(q("pe-confirm"));
    await settle();
    expect(h.mutateAsync).toHaveBeenCalledWith({ employeeIds: [4], cycle: null });
  });

  it("a row's Assign menu offers the cycles with the current one ticked, and Remove from cycle", async () => {
    mount();
    click(tabButton("all"));
    press(must("pe-row-assign-P003"), "Enter");
    const current = must("pe-row-assign-P003-biweekly");
    expect(current.getAttribute("aria-disabled")).toBe("true");
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(q("pe-row-assign-P003-none")).not.toBeNull();
    click(q("pe-row-assign-P003-weekly"));
    expect(text(dialog())).toContain("Move 1 employee from BiWeekly to Weekly?");
    click(q("pe-confirm"));
    await settle();
    expect(h.mutateAsync).toHaveBeenCalledWith({ employeeIds: [3], cycle: "weekly" });

    // someone with no cycle has no Remove item and is assigned without a question
    press(must("pe-row-assign-P001"), "Enter");
    expect(q("pe-row-assign-P001-none")).toBeNull();
    click(q("pe-row-assign-P001-monthly"));
    expect(dialog()).toBeNull();
    await settle();
    expect(h.mutateAsync).toHaveBeenLastCalledWith({ employeeIds: [1], cycle: "monthly" });
  });

  it("tells the reader when the server refuses, or skips someone", async () => {
    h.mutateAsync.mockRejectedValueOnce(new Error("HTTP 400 Bad Request: Employee 2 is not a production employee"));
    mount();
    click(q("pe-select-P002"));
    click(q("pe-bulk-monthly"));
    await settle();
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not assign to Monthly",
        description: "Employee 2 is not a production employee",
        variant: "destructive",
      }),
    );
    expect(q("pe-bulk-bar")).not.toBeNull(); // nothing happened, so the tick stays

    h.mutateAsync.mockResolvedValueOnce(assigned(0, { skipped: [{ employeeId: 2, reason: "no salary per shift" }] }));
    click(q("pe-bulk-monthly"));
    await settle();
    expect(h.toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Nobody was assigned to Monthly", variant: "destructive" }),
    );
  });

  it("keeps the selection across pages and ticks every page with the header checkbox", () => {
    const many = Array.from({ length: 60 }, (_, i) => row(100 + i, `Worker ${i + 1}`));
    serve(many);
    mount();
    expect(text(q("pe-showing"))).toBe("Showing 1-25 of 60");
    expect(all("pe-row-P100").length).toBe(1);
    click(q("pe-select-P100"));
    click(document.body.querySelector('[aria-label="Page 2"]'));
    expect(text(q("pe-showing"))).toBe("Showing 26-50 of 60");
    expect(q("pe-row-P100")).toBeNull();
    expect(text(q("pe-selected-count"))).toBe("1 selected");
    click(q("pe-select-all"));
    expect(text(q("pe-selected-count"))).toBe("All 60 selected");
    click(q("pe-select-all"));
    expect(q("pe-bulk-bar")).toBeNull();
  });

  it("explains an empty list: nobody at all, nobody on a cycle yet, or nothing matching", async () => {
    serve([]);
    mount();
    expect(q("pe-empty")?.dataset.kind).toBe("none");
    expect(text(q("pe-empty"))).toContain("Production employees are created on Employees");

    serve(ROWS);
    act(() => root!.render(createElement(ProductionEmployees, { key: "again" })));
    click(tabButton("weekly"));
    expect(q("pe-empty")?.dataset.kind).toBe("tab");
    expect(text(q("pe-empty"))).toContain("Nobody is on the Weekly cycle yet");
    click([...must("pe-empty").querySelectorAll("button")].find((b) => text(b) === "Open Unassigned")!);
    expect(tabButton("unassigned")?.getAttribute("aria-selected")).toBe("true");

    h.list.mockImplementation((filters?: ProductionEmployeeFilters) => ({
      data: { counts: countsOf(ROWS), employees: filters?.search ? [] : ROWS },
      isLoading: false,
      isError: false,
      isPlaceholderData: false,
      refetch: h.refetch,
    }));
    typeInto(must("pe-search") as HTMLInputElement, "zzz");
    await settle(320);
    expect(q("pe-empty")?.dataset.kind).toBe("filtered");
    click([...must("pe-empty").querySelectorAll("button")].find((b) => text(b) === "Clear filters")!);
    await settle(320);
    expect(q("pe-empty")).toBeNull();
  });

  it("points at Settings when BiWeekly or Monthly has no first period start yet", () => {
    h.cycles.mockReturnValue({
      data: {
        cycles: [
          { cycle: "weekly", configured: true },
          { cycle: "biweekly", configured: false },
          { cycle: "monthly", configured: true },
        ],
      },
    });
    mount();
    expect(q("pe-hint-weekly")).toBeNull();
    expect(q("pe-hint-monthly")).toBeNull();
    expect(must("pe-hint-biweekly").getAttribute("href")).toBe("/hr/settings?tab=production_payroll");
    expect(text(q("pe-stat-biweekly"))).toContain("Set its first period start in Settings");
  });

  it("lists cards instead of a table on a narrow screen, each row once", () => {
    const matchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }),
    });
    try {
      mount();
      expect(q("pe-table")).toBeNull();
      expect(q("pe-cards")).not.toBeNull();
      expect(all("pe-row-P001").length).toBe(1);
      expect(text(q("pe-row-P001"))).toContain("Not assigned");
      expect(q("pe-row-assign-P001")).not.toBeNull();
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: matchMedia });
    }
  });
});
