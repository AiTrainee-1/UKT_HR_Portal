import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PfEsiClass } from "@/lib/api-client/custom-hooks";
import Employees from "../Employees";

// The Employees page header in jsdom: which buttons each tab has (Co Emp swaps Inactive / Bulk Upload / Add Employee for ONE
// TDS button), what the address says, and that the roster is not fetched while Co Emp is showing. The Co Emp tab and the TDS
// panel have their own tests; here they are stand-ins that show what the page hands them.

const h = vi.hoisted(() => ({
  paginated: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { branchId: null } }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }), toast: vi.fn() }));
vi.mock("../co-emp/CoEmpTab", () => ({
  CoEmpTab: (props: { cls: PfEsiClass; filters: unknown; onClassChange: (c: PfEsiClass) => void }) =>
    createElement(
      "div",
      { "data-testid": "mock-coemp", "data-cls": props.cls, "data-filters": JSON.stringify(props.filters) },
      createElement(
        "button",
        { "data-testid": "mock-pick-production", onClick: () => props.onClassChange("production") },
        "pick",
      ),
    ),
}));
vi.mock("../co-emp/TdsPanel", () => ({
  TdsPanel: (props: { cls: PfEsiClass; onBack: () => void; onClassChange: (c: PfEsiClass) => void }) =>
    createElement(
      "div",
      { "data-testid": "mock-tds", "data-cls": props.cls },
      createElement("button", { "data-testid": "mock-tds-back", onClick: props.onBack }, "back"),
      createElement(
        "button",
        { "data-testid": "mock-tds-production", onClick: () => props.onClassChange("production") },
        "prod",
      ),
    ),
}));
vi.mock("@/lib/api-client", async (original) => ({
  ...(await original<typeof import("@/lib/api-client")>()),
  useListDepartments: () => ({ data: [{ id: 1, name: "Stitching" }] }),
  useDeleteEmployee: () => ({ mutate: vi.fn() }),
  useUpdateEmployeeStatus: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/lib/api-client/custom-hooks", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks")>()),
  useListBranches: () => ({ data: [{ id: 1, name: "Unit 1" }] }),
  useListEmployeesPaginated: (params: unknown, options?: { enabled?: boolean }) => h.paginated(params, options),
  useEmployeeCount: (params: unknown, options?: { enabled?: boolean }) => h.count(params, options),
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

beforeEach(() => {
  vi.clearAllMocks();
  h.paginated.mockReturnValue({
    data: {
      results: [
        {
          id: 1,
          employeeCode: "S001",
          firstName: "Asha",
          lastName: "Kumar",
          status: "active",
          employmentType: "staff",
          salaryAmount: 24000,
          salaryType: "monthly",
        },
      ],
      count: 1,
      staffCount: 1,
      productionCount: 0,
    },
    isLoading: false,
    isPlaceholderData: false,
  });
  h.count.mockReturnValue({ data: 4 });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
});

function mount(address: string) {
  window.history.replaceState(null, "", address);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient();
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(Employees))));
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
const headerTab = (index: number) => must("employees-tabs").querySelectorAll('[role="tab"]')[index];
const headerButtons = () =>
  [
    ...(must("employees-tabs")
      .closest(".flex.items-center.justify-between")
      ?.querySelectorAll(":scope > div:last-child button") ?? []),
  ].map((b) => text(b));
const lastFilters = () => JSON.parse(must("mock-coemp").dataset.filters!) as Record<string, unknown>;

describe("the header buttons", () => {
  it("keeps Inactive, Bulk Upload and Add Employee on the Staff tab, and no TDS button", () => {
    mount("/hr/employees");
    expect(q("button-toggle-inactive")).not.toBeNull();
    expect(q("button-bulk-upload")).not.toBeNull();
    expect(q("button-add-employee")).not.toBeNull();
    expect(q("button-tds")).toBeNull();
    expect(q("mock-coemp")).toBeNull();
    // the roster still has its actions
    expect(q("button-view-1")).not.toBeNull();
    expect(q("button-edit-1")).not.toBeNull();
    expect(q("button-delete-1")).not.toBeNull();
  });

  it("keeps them on the Production tab", () => {
    mount("/hr/employees?tab=production");
    expect(q("button-toggle-inactive")).not.toBeNull();
    expect(q("button-bulk-upload")).not.toBeNull();
    expect(q("button-add-employee")).not.toBeNull();
    expect(q("button-tds")).toBeNull();
  });

  it("replaces all three with ONE TDS – Tax Deducted at Source button on the Co Emp tab", () => {
    mount("/hr/employees?tab=coemp");
    expect(q("button-toggle-inactive")).toBeNull();
    expect(q("button-bulk-upload")).toBeNull();
    expect(q("button-add-employee")).toBeNull();
    expect(text(must("button-tds"))).toBe("TDS – Tax Deducted at Source");
    expect(headerButtons()).toEqual(["TDS – Tax Deducted at Source"]);
  });
});

describe("the Co Emp tab", () => {
  it("opens from the address, hands the Co Emp tab a class and the filters, and does not fetch the roster", () => {
    mount("/hr/employees?tab=coemp&type=production");
    expect(must("mock-coemp").dataset.cls).toBe("production");
    expect(headerTab(2).getAttribute("aria-selected")).toBe("true");
    // the roster list and the Inactive count are switched off
    expect(h.paginated).toHaveBeenLastCalledWith(expect.anything(), { enabled: false });
    expect(h.count).toHaveBeenLastCalledWith(expect.anything(), { enabled: false });
    // and its table (with Actions) is not on screen
    expect(q("button-view-1")).toBeNull();
    // the filter card is
    expect(q("input-search")).not.toBeNull();
    expect(text(document.body)).toContain("Co Emp decides who PF/ESI applies to");
  });

  it("fetches the roster again on the other tabs", () => {
    mount("/hr/employees");
    expect(h.paginated).toHaveBeenLastCalledWith(expect.anything(), { enabled: true });
    expect(text(document.body)).toContain("1 records");
  });

  it("starts on the Staff class, and a class pick goes into the address", () => {
    mount("/hr/employees?tab=coemp");
    expect(must("mock-coemp").dataset.cls).toBe("staff");
    click(must("mock-pick-production"));
    expect(window.location.search).toBe("?tab=coemp&type=production");
    expect(must("mock-coemp").dataset.cls).toBe("production");
  });

  it("passes the page's filters (active only by default)", async () => {
    mount("/hr/employees?tab=coemp");
    expect(lastFilters()).toEqual({ status: "active" });
    const input = must("input-search") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "asha");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle(350);
    expect(lastFilters()).toEqual({ status: "active", search: "asha" });
  });

  it("the header tabs put the tab in the address, and Staff leaves it clean", () => {
    mount("/hr/employees");
    click(headerTab(2));
    expect(window.location.search).toBe("?tab=coemp");
    expect(q("mock-coemp")).not.toBeNull();
    click(headerTab(1));
    expect(window.location.search).toBe("?tab=production");
    click(headerTab(0));
    expect(window.location.search).toBe("");
  });

  it("leaving Co Emp forgets its class and panel", () => {
    mount("/hr/employees?tab=coemp&type=production&view=tds");
    click(headerTab(0));
    expect(window.location.search).toBe("");
  });

  it("shows no counts on the Staff and Production tabs while Co Emp is showing (the roster is not loaded)", () => {
    mount("/hr/employees?tab=coemp");
    const labels = [...must("employees-tabs").querySelectorAll('[role="tab"]')].map((t) =>
      text(t.querySelector(".ptab-label")),
    );
    expect(labels).toEqual(["Staff", "Production", "Co Emp"]);
  });
});

describe("the TDS panel", () => {
  it("opens from the TDS button, in the address, in place of the Co Emp tab and the filters", () => {
    mount("/hr/employees?tab=coemp");
    click(must("button-tds"));
    expect(window.location.search).toBe("?tab=coemp&view=tds");
    expect(q("mock-tds")).not.toBeNull();
    expect(q("mock-coemp")).toBeNull();
    expect(q("input-search")).toBeNull();
    expect(must("button-tds").getAttribute("aria-pressed")).toBe("true");
  });

  it("opens straight from a pasted address, on the class it names", () => {
    mount("/hr/employees?tab=coemp&type=production&view=tds");
    expect(must("mock-tds").dataset.cls).toBe("production");
    expect(q("mock-coemp")).toBeNull();
  });

  it("closes with the same button and with Back, returning to the Co Emp list", () => {
    mount("/hr/employees?tab=coemp&view=tds");
    click(must("button-tds"));
    expect(window.location.search).toBe("?tab=coemp");
    expect(q("mock-coemp")).not.toBeNull();
    click(must("button-tds"));
    click(must("mock-tds-back"));
    expect(window.location.search).toBe("?tab=coemp");
    expect(q("mock-tds")).toBeNull();
  });

  it("keeps the panel open when its class is switched", () => {
    mount("/hr/employees?tab=coemp&view=tds");
    click(must("mock-tds-production"));
    expect(window.location.search).toBe("?tab=coemp&view=tds&type=production");
    expect(must("mock-tds").dataset.cls).toBe("production");
  });

  it("ignores view=tds outside the Co Emp tab", () => {
    mount("/hr/employees?tab=staff&view=tds");
    expect(q("mock-tds")).toBeNull();
    expect(q("button-add-employee")).not.toBeNull();
  });
});
