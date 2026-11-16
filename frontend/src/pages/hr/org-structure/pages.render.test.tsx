import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Departments from "../Departments";
import Designations from "../Designations";
import type { DepartmentRow, DesignationRow, DesignationsTree } from "./api";

// The two pages in jsdom with their data mocked: the Staff | Production switch (in the address as ?category=) decides
// what every part of the page shows - cards, list / tree, filters, Find & assign, and what a new one starts as.

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { branchId: null } }),
  permissionLevel: () => "edit",
  isRouteViewOnly: () => false,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }), toast: vi.fn() }));
// Find & assign: a stand-in that shows what the page hands it.
vi.mock("@/components/EmployeeAssignmentLookup", () => ({
  EmployeeAssignmentLookup: (props: { kind: string; employmentType?: string; options: { id: number }[] }) =>
    createElement("div", {
      "data-testid": "mock-lookup",
      "data-kind": props.kind,
      "data-type": props.employmentType,
      "data-options": props.options.map((o) => o.id).join(","),
    }),
}));

const hc = (staff: number, production: number, inactive = 0) => ({
  activeStaff: staff,
  activeProduction: production,
  activeOther: 0,
  active: staff + production,
  inactive,
});
const dept = (id: number, name: string, category: "staff" | "production", h = hc(0, 0), extra = {}): DepartmentRow => ({
  id,
  name,
  description: null,
  category,
  branchId: 4,
  branchName: "Unit1",
  designationCount: 0,
  hodCount: 0,
  createdAt: null,
  ...h,
  ...extra,
});
// The dev database after the split: CUTTING for staff AND for production in Unit1.
const DEPTS: DepartmentRow[] = [
  dept(24, "CUTTING", "staff", hc(2, 0, 2), { designationCount: 1 }),
  dept(68, "CUTTING", "production", hc(0, 9)),
  dept(5, "ACCOUNTS", "staff", hc(3, 0)),
  dept(7, "SEWING", "production", hc(0, 12, 1)),
  dept(8, "STORE", "staff"),
];
const desig = (id: number, title: string, d: DepartmentRow, h = hc(0, 0)): DesignationRow => ({
  id,
  title,
  level: "",
  category: d.category,
  departmentId: d.id,
  departmentName: d.name,
  branchId: 4,
  branchName: "Unit1",
  createdAt: null,
  ...h,
});
const TREE: DesignationsTree = {
  branches: [{ id: 4, name: "Unit1" }],
  departments: DEPTS.map((d) => ({
    id: d.id,
    name: d.name,
    category: d.category,
    branchId: 4,
    branchName: "Unit1",
    active: d.active,
  })),
  designations: [
    desig(1, "Cutting Master", DEPTS[0], hc(1, 0)),
    desig(2, "Accountant", DEPTS[2], hc(2, 0)),
    desig(3, "Tailor", DEPTS[3], hc(0, 10)),
  ],
  unassigned: { active: 6, staff: 4, production: 2 },
};

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  useDepartmentsOverview: () => ({
    data: {
      departments: DEPTS,
      branches: [{ id: 4, name: "Unit1" }],
      unassigned: { active: 6, staff: 4, production: 2 },
    },
    isLoading: false,
    isError: false,
  }),
  useDesignationsTree: () => ({ data: TREE, isLoading: false, isError: false }),
  useDepartmentPeople: () => ({ data: undefined, isLoading: false, isError: false }),
  useDesignationPeople: () => ({ data: undefined, isLoading: false, isError: false }),
  useRefreshOrg: () => () => Promise.resolve(),
  useUpdateDepartment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateDesignation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
const create = vi.hoisted(() => ({ department: vi.fn(), designation: vi.fn() }));
vi.mock("@/lib/api-client/custom-hooks", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks")>()),
  useCreateDepartmentWithBranch: () => ({ mutateAsync: create.department, isPending: false }),
  useCreateDesignation: () => ({ mutateAsync: create.designation, isPending: false }),
  useDeleteDesignation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/lib/api-client", async (original) => ({
  ...(await original<typeof import("@/lib/api-client")>()),
  useAssignOrg: () => ({ mutateAsync: vi.fn() }),
  useDeleteDepartment: () => ({ mutateAsync: vi.fn() }),
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
  create.department.mockReset();
  create.designation.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
});

function mount(page: typeof Departments, address: string) {
  window.history.replaceState(null, "", address);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(page))));
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the page shows: ${text(document.body).slice(0, 400)}`);
  return el;
};
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const rowIds = (prefix: string) =>
  [...document.body.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`)].map((r) => r.dataset.testid);

describe("Departments: the Staff | Production switch", () => {
  it("opens on Staff and shows only Staff departments and Staff figures", () => {
    mount(Departments, "/hr/departments");
    expect(must("org-category-switch").dataset.value).toBe("staff");
    expect(text(must("org-category-staff"))).toContain("3");
    expect(text(must("org-category-production"))).toContain("2");
    expect(text(must("stat-departments-value"))).toBe("3");
    expect(text(must("stat-employees-value"))).toBe("5");
    expect(text(must("stat-unassigned-value"))).toBe("4");
    expect(text(must("stat-designations-value"))).toBe("1");
    expect(text(must("stat-empty-value"))).toBe("1");
    expect(rowIds("dept-row-")).toEqual(["dept-row-ACCOUNTS", "dept-row-CUTTING", "dept-row-STORE"]);
    expect(must("dept-row-CUTTING").dataset.active).toBe("2"); // the Staff CUTTING
    expect(text(must("new-department"))).toBe("New Staff Department");
  });

  it("switches to Production, writes it in the address, and lists only Production departments", () => {
    mount(Departments, "/hr/departments");
    click(must("org-category-production"));
    expect(window.location.search).toBe("?category=production");
    expect(must("org-category-switch").dataset.value).toBe("production");
    expect(rowIds("dept-row-")).toEqual(["dept-row-CUTTING", "dept-row-SEWING"]);
    expect(must("dept-row-CUTTING").dataset.active).toBe("9"); // the Production CUTTING
    expect(text(must("stat-departments-value"))).toBe("2");
    expect(text(must("stat-unassigned-value"))).toBe("2");
    click(must("org-category-staff"));
    expect(window.location.search).toBe("");
  });

  it("lands on Production from a link", () => {
    mount(Departments, "/hr/departments?category=production");
    expect(must("org-category-switch").dataset.value).toBe("production");
    expect(rowIds("dept-row-")).toEqual(["dept-row-CUTTING", "dept-row-SEWING"]);
  });

  it("hands Find & assign the page's type and only that type's departments", () => {
    mount(Departments, "/hr/departments?category=production");
    const tabs = [...document.body.querySelectorAll('[role="tab"]')];
    click(tabs.find((t) => text(t).startsWith("Find & assign"))!);
    const lookup = must("mock-lookup");
    expect(lookup.dataset.type).toBe("production");
    expect(lookup.dataset.options?.split(",").sort()).toEqual(["68", "7"]);
  });

  it("starts a new department as the switch's kind, changeable, and sends it", async () => {
    mount(Departments, "/hr/departments?category=production");
    click(must("new-department"));
    expect(must("department-category").dataset.value).toBe("production");
    click(must("department-category-staff"));
    expect(must("department-category").dataset.value).toBe("staff");
    click(must("department-category-production"));
    const name = must("department-name") as HTMLInputElement;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(name, "Packing");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const branch = must("department-branch") as HTMLSelectElement;
    act(() => {
      branch.value = "4";
      branch.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      must("department-save").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(create.department).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Packing", branchId: 4, category: "production" }),
    );
  });

  it("catches a same-named department of the same kind and branch, ignoring case", async () => {
    mount(Departments, "/hr/departments?category=production");
    click(must("new-department"));
    const name = must("department-name") as HTMLInputElement;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(name, "cutting");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const branch = must("department-branch") as HTMLSelectElement;
    act(() => {
      branch.value = "4";
      branch.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      must("department-save").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(text(must("department-error"))).toContain('Production department called "cutting" already exists');
    expect(create.department).not.toHaveBeenCalled();
  });

  it("locks the kind of a department that has people, and says why", () => {
    mount(Departments, "/hr/departments");
    click(must("dept-edit-CUTTING"));
    expect(text(must("department-category-lock"))).toContain("4 employees are in this department");
    expect((must("department-category-production") as HTMLButtonElement).disabled).toBe(true);
  });

  it("leaves the kind of an empty department open to change", () => {
    mount(Departments, "/hr/departments");
    click(must("dept-edit-STORE"));
    expect(q("department-category-lock")).toBeNull();
    expect((must("department-category-production") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Designations: the Staff | Production switch", () => {
  it("shows only Staff designations, under Staff departments, on Staff", () => {
    mount(Designations, "/hr/designations");
    expect(must("org-category-switch").dataset.value).toBe("staff");
    expect(text(must("stat-designations-value"))).toBe("2");
    expect(text(must("stat-unassigned-value"))).toBe("4");
    expect(text(must("stat-departments-value"))).toBe("3");
    expect(q("desig-row-Cutting Master")).not.toBeNull();
    expect(q("desig-row-Accountant")).not.toBeNull();
    expect(q("desig-row-Tailor")).toBeNull();
    expect(q("dept-node-SEWING")).toBeNull();
  });

  it("switches to Production: the tree, the cards and Find & assign follow", () => {
    mount(Designations, "/hr/designations");
    click(must("org-category-production"));
    expect(window.location.search).toBe("?category=production");
    expect(q("desig-row-Tailor")).not.toBeNull();
    expect(q("desig-row-Accountant")).toBeNull();
    expect(q("dept-node-SEWING")).not.toBeNull();
    expect(text(must("stat-designations-value"))).toBe("1");
    expect(text(must("stat-unassigned-value"))).toBe("2");
    const tabs = [...document.body.querySelectorAll('[role="tab"]')];
    click(tabs.find((t) => text(t).startsWith("Find & assign"))!);
    expect(must("mock-lookup").dataset.type).toBe("production");
    expect(must("mock-lookup").dataset.options).toBe("3");
  });

  it("offers only the switch's departments in a new designation, and follows a change of kind", () => {
    mount(Designations, "/hr/designations?category=production");
    click(must("new-designation"));
    expect(must("designation-category").dataset.value).toBe("production");
    const options = () =>
      [...(must("designation-department") as HTMLSelectElement).querySelectorAll("option")].map((o) => o.value);
    expect(options().filter((v) => v !== "none")).toEqual(["68", "7"]);
    click(must("designation-category-staff"));
    expect(
      options()
        .filter((v) => v !== "none")
        .sort(),
    ).toEqual(["24", "5", "8"]);
  });

  it("locks the kind of a designation somebody holds", () => {
    mount(Designations, "/hr/designations?category=production");
    click(must("desig-edit-Tailor"));
    expect(text(must("designation-category-lock"))).toContain("10 employees hold this designation");
    expect((must("designation-category-staff") as HTMLButtonElement).disabled).toBe(true);
  });
});
