import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TdsEmployeeRow, TdsListParams, TdsListResponse } from "@/lib/api-client/custom-hooks";
import { TdsPanel } from "./TdsPanel";

// The TDS panel in jsdom with the hooks faked: Staff and Production kept apart with their counts, the search, a row's two
// actions (edit the percentage, remove with a confirmation) and the Add Employee dialog with the server's messages.

const h = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  toast: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/lib/api-client/custom-hooks", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks")>()),
  useTdsEmployees: (params: TdsListParams) => h.list(params),
  useAddTdsEmployee: () => ({ mutateAsync: h.add, isPending: false }),
  useUpdateTdsPercent: () => ({ mutateAsync: h.update, isPending: false }),
  useRemoveTdsEmployee: () => ({ mutateAsync: h.remove, isPending: false }),
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

const row = (id: number, code: string, name: string, over: Partial<TdsEmployeeRow> = {}): TdsEmployeeRow => ({
  id,
  employeeCode: code,
  name,
  departmentName: "Stitching",
  designationTitle: "Operator",
  branchId: 1,
  branchName: "Unit 1",
  employmentType: "staff",
  status: "active",
  tdsPercent: 10,
  ...over,
});

const ROWS: TdsEmployeeRow[] = [
  row(1, "S001", "Asha Kumar"),
  row(2, "S002", "Bala Nair", { tdsPercent: 12.5, departmentName: null }),
  row(3, "P001", "Deepa Rao", { employmentType: "production", tdsPercent: 5 }),
];

const countsOf = (rows: TdsEmployeeRow[]) => ({
  all: rows.length,
  staff: rows.filter((r) => r.employmentType === "staff").length,
  production: rows.filter((r) => r.employmentType === "production").length,
});

function serve(rows: TdsEmployeeRow[] = ROWS) {
  h.list.mockImplementation((params: TdsListParams) => {
    const needle = (params.search ?? "").toLowerCase();
    const employees = rows.filter(
      (r) =>
        (params.type === "all" || r.employmentType === params.type) &&
        (!needle || r.name.toLowerCase().includes(needle) || r.employeeCode.toLowerCase().includes(needle)),
    );
    return {
      data: { employees, counts: countsOf(rows) } satisfies TdsListResponse,
      isLoading: false,
      isError: false,
      isPlaceholderData: false,
      refetch: h.refetch,
    };
  });
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const onClassChange = vi.fn();
const onBack = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  serve();
  h.add.mockResolvedValue({ employee: row(9, "S009", "New Person", { tdsPercent: 10 }), movedFromPfEsi: false });
  h.update.mockResolvedValue({});
  h.remove.mockResolvedValue({});
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(cls: "staff" | "production" = "staff") {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(TdsPanel, { cls, onClassChange, onBack })));
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
const typeInto = (input: HTMLElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = (form: HTMLFormElement) =>
  act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const lastList = () => h.list.mock.calls.at(-1)?.[0] as TdsListParams;
const rowIds = () =>
  [...document.body.querySelectorAll('[data-testid^="row-tds-"]')].map((r) =>
    (r as HTMLElement).dataset.testid!.replace("row-tds-", ""),
  );
const apiError = (status: number, data: unknown) => Object.assign(new Error(`HTTP ${status}`), { status, data });

describe("the TDS list", () => {
  it("is titled TDS – Tax Deducted at Source and lists only the class picked", () => {
    mount("staff");
    expect(text(must("tds-panel"))).toContain("TDS – Tax Deducted at Source");
    expect(lastList().type).toBe("staff");
    expect(rowIds()).toEqual(["1", "2"]);
  });

  it("lists the production TDS employees on the Production pill", () => {
    mount("production");
    expect(lastList().type).toBe("production");
    expect(rowIds()).toEqual(["3"]);
  });

  it("shows the counts of both classes on the pills, and tells the page when the other is picked", () => {
    mount("staff");
    const tabs = [...must("tds-class-tabs").querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => text(t.querySelector(".ptab-label")))).toEqual(["Staff(2)", "Production(1)"]);
    click(tabs[1]);
    expect(onClassChange).toHaveBeenCalledWith("production");
  });

  it("shows code, name, department, branch and TDS % on each row", () => {
    mount("staff");
    const first = text(must("row-tds-1"));
    for (const part of ["S001", "Asha Kumar", "Stitching", "Unit 1", "10%"]) expect(first, part).toContain(part);
    expect(text(must("tds-percent-2"))).toBe("12.5%");
    expect(text(must("row-tds-2"))).toContain("—");
  });

  it("marks an inactive employee", () => {
    serve([row(1, "S001", "Asha Kumar", { status: "inactive" })]);
    mount("staff");
    expect(text(must("row-tds-1"))).toContain("inactive");
  });

  it("sends the search after a pause and says when nothing matches", async () => {
    mount("staff");
    expect(lastList()).toEqual({ type: "staff", search: undefined });
    typeInto(must("tds-search"), "bala");
    await settle(300);
    expect(lastList().search).toBe("bala");
    expect(rowIds()).toEqual(["2"]);
    typeInto(must("tds-search"), "zzz");
    await settle(300);
    expect(text(must("tds-empty"))).toBe("No staff TDS employee matches “zzz”");
  });

  it("invites the first entry when nobody is in TDS", () => {
    serve([]);
    mount("staff");
    expect(text(must("tds-empty"))).toBe("No staff employees are in TDS yet. Use Add Employee.");
  });

  it("goes back to Co Emp", () => {
    mount("staff");
    click(must("tds-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
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
    expect(text(must("load-error"))).toContain("Could not load the TDS employees");
    click([...must("load-error").querySelectorAll("button")].find((b) => text(b) === "Retry")!);
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  it("never shows the previous class's rows (or 'nobody') while a new pill loads", () => {
    h.list.mockReturnValue({
      data: { employees: [ROWS[0]], counts: countsOf(ROWS) },
      isLoading: false,
      isError: false,
      isPlaceholderData: true,
      refetch: h.refetch,
    });
    mount("production");
    expect(rowIds()).toEqual([]);
    expect(q("tds-empty")).toBeNull();
  });
});

describe("Add Employee", () => {
  const open = () => click(must("button-tds-add-employee"));
  const fill = (code: string, percent: string) => {
    typeInto(must("tds-add-code"), code);
    typeInto(must("tds-add-percent"), percent);
  };
  const form = () => must("tds-add-dialog").querySelector("form") as HTMLFormElement;

  it("opens a dialog asking for the employee code and the percentage", () => {
    mount("staff");
    expect(q("tds-add-dialog")).toBeNull();
    open();
    const dialog = must("tds-add-dialog");
    expect(text(dialog)).toContain("Add employee to TDS");
    expect(text(dialog)).toContain("moved out of it and into TDS");
    expect(must("tds-add-code")).toBeTruthy();
    expect(must("tds-add-percent")).toBeTruthy();
  });

  it("checks the entry before asking the server", async () => {
    mount("staff");
    open();
    submit(form());
    expect(text(must("tds-add-code-error"))).toBe("Enter the employee code.");
    expect(text(must("tds-add-percent-error"))).toBe("Enter the TDS percentage.");
    fill("S009", "150");
    submit(form());
    expect(q("tds-add-code-error")).toBeNull();
    expect(text(must("tds-add-percent-error"))).toBe("Percentage must be greater than 0 and at most 100 (2 decimals).");
    await settle();
    expect(h.add).not.toHaveBeenCalled();
  });

  it("adds by code and tells the user the employee was moved out of PF/ESI", async () => {
    h.add.mockResolvedValue({
      employee: row(1, "UK001", "Asha Kumar", { tdsPercent: 10 }),
      movedFromPfEsi: true,
    });
    mount("staff");
    open();
    fill("  UK001 ", "10");
    submit(form());
    await settle();
    expect(h.add).toHaveBeenCalledWith({ employeeCode: "UK001", percent: 10 });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "UK001 moved from PF/ESI to TDS at 10%" }));
    expect(q("tds-add-dialog")).toBeNull();
  });

  it("says plainly when the employee was not in PF/ESI", async () => {
    mount("staff");
    open();
    fill("S009", "7.5");
    submit(form());
    await settle();
    expect(h.add).toHaveBeenCalledWith({ employeeCode: "S009", percent: 7.5 });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "S009 added to TDS at 10%" }));
  });

  it("shows the server's message under the code and keeps the dialog open (unknown code)", async () => {
    h.add.mockRejectedValue(apiError(404, { error: "No employee with code 'NOPE'.", code: "employee_not_found" }));
    mount("staff");
    open();
    fill("NOPE", "10");
    submit(form());
    await settle();
    expect(text(must("tds-add-code-error"))).toBe("No employee with code 'NOPE'.");
    expect(q("tds-add-percent-error")).toBeNull();
    expect(q("tds-add-dialog")).not.toBeNull();
    expect(h.toast).not.toHaveBeenCalled();
    expect(must("tds-add-code").getAttribute("aria-invalid")).toBe("true");
  });

  it("shows an inactive employee's message under the code", async () => {
    h.add.mockRejectedValue(apiError(400, { error: "S005 is inactive.", code: "employee_inactive" }));
    mount("staff");
    open();
    fill("S005", "10");
    submit(form());
    await settle();
    expect(text(must("tds-add-code-error"))).toBe("S005 is inactive.");
  });

  it("shows 'already in TDS' under the code", async () => {
    h.add.mockRejectedValue(
      apiError(409, { error: "S001 is already in TDS (10%). Edit the percentage instead.", code: "already_in_tds" }),
    );
    mount("staff");
    open();
    fill("S001", "10");
    submit(form());
    await settle();
    expect(text(must("tds-add-code-error"))).toBe("S001 is already in TDS (10%). Edit the percentage instead.");
  });

  it("shows a percentage the server refuses under the percentage", async () => {
    h.add.mockRejectedValue(
      apiError(400, { error: "Percentage must be greater than 0 and at most 100 (2 decimals)." }),
    );
    mount("staff");
    open();
    fill("S001", "10");
    submit(form());
    await settle();
    expect(text(must("tds-add-percent-error"))).toContain("Percentage must be greater than 0");
    expect(q("tds-add-code-error")).toBeNull();
  });

  it("starts empty every time it is opened", async () => {
    mount("staff");
    open();
    fill("S009", "10");
    click(must("tds-add-dialog").querySelector("[data-slot='dialog-close']"));
    await settle();
    expect(q("tds-add-dialog")).toBeNull();
    open();
    expect((must("tds-add-code") as HTMLInputElement).value).toBe("");
    expect((must("tds-add-percent") as HTMLInputElement).value).toBe("");
  });
});

describe("Edit percentage", () => {
  const form = () => must("tds-edit-dialog").querySelector("form") as HTMLFormElement;

  it("opens with the current percentage, for the right employee", () => {
    mount("staff");
    click(must("button-tds-edit-2"));
    expect(text(must("tds-edit-dialog"))).toContain("S002 · Bala Nair");
    expect((must("tds-edit-percent") as HTMLInputElement).value).toBe("12.5");
  });

  it("saves a new percentage and says what changed", async () => {
    mount("staff");
    click(must("button-tds-edit-1"));
    typeInto(must("tds-edit-percent"), "15");
    submit(form());
    await settle();
    expect(h.update).toHaveBeenCalledWith({ employeeId: 1, percent: 15 });
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "S001 TDS changed to 15%", description: expect.stringContaining("was at 10%") }),
    );
    expect(q("tds-edit-dialog")).toBeNull();
  });

  it("refuses an out-of-range percentage without asking the server", async () => {
    mount("staff");
    click(must("button-tds-edit-1"));
    typeInto(must("tds-edit-percent"), "0");
    submit(form());
    await settle();
    expect(text(must("tds-edit-percent-error"))).toContain("greater than 0");
    expect(h.update).not.toHaveBeenCalled();
    expect(q("tds-edit-dialog")).not.toBeNull();
  });

  it("shows the server's message and keeps the dialog open", async () => {
    h.update.mockRejectedValue(apiError(404, { error: "S001 is not in TDS", code: "not_in_tds" }));
    mount("staff");
    click(must("button-tds-edit-1"));
    typeInto(must("tds-edit-percent"), "20");
    submit(form());
    await settle();
    expect(text(must("tds-edit-percent-error"))).toBe("S001 is not in TDS");
    expect(q("tds-edit-dialog")).not.toBeNull();
  });
});

describe("Remove from TDS", () => {
  it("asks first, naming the employee and what happens next, and does nothing on Cancel", async () => {
    mount("staff");
    click(must("button-tds-remove-1"));
    const dialog = must("tds-remove-dialog");
    expect(text(dialog)).toContain("Remove S001 from TDS?");
    expect(text(dialog)).toContain("no PF/ESI and no TDS");
    click(must("tds-remove-cancel"));
    await settle();
    expect(h.remove).not.toHaveBeenCalled();
    expect(q("tds-remove-dialog")).toBeNull();
  });

  it("removes the employee when confirmed", async () => {
    mount("staff");
    click(must("button-tds-remove-2"));
    click(must("tds-remove-confirm"));
    await settle();
    expect(h.remove).toHaveBeenCalledWith({ employeeId: 2 });
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "S002 removed from TDS" }));
  });

  it("shows the server's message when the removal fails", async () => {
    h.remove.mockRejectedValue(apiError(404, { error: "S002 is not in TDS", code: "not_in_tds" }));
    mount("staff");
    click(must("button-tds-remove-2"));
    click(must("tds-remove-confirm"));
    await settle();
    expect(h.toast).toHaveBeenCalledWith({
      title: "Could not remove from TDS",
      description: "S002 is not in TDS",
      variant: "destructive",
    });
  });

  it("names its row actions for a screen reader", () => {
    mount("staff");
    expect(must("button-tds-edit-1").getAttribute("aria-label")).toBe("Edit TDS percentage for Asha Kumar");
    expect(must("button-tds-remove-1").getAttribute("aria-label")).toBe("Remove Asha Kumar from TDS");
  });
});
