import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DepartmentRow, DesignationRow, DesignationsTree } from "./api";
import DepartmentList from "./DepartmentList";
import DesignationList from "./DesignationList";
import DesignationTree from "./DesignationTree";
import { NO_DESIG_FILTERS, buildTree, filterDesignations } from "./logic";
import { SplitBar } from "./parts";

// jsdom render checks of the pieces that draw the structure: the bar's numbers, the rows' data attributes, the tree's
// open / closed state and the buttons' wiring. (The pages themselves are covered by e2e/org-structure.spec.ts.)

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(node: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const hc = (staff: number, production: number, inactive = 0) => ({
  activeStaff: staff,
  activeProduction: production,
  activeOther: 0,
  active: staff + production,
  inactive,
});

const DEPT: DepartmentRow = {
  id: 1,
  name: "Cutting",
  description: "Cut room",
  branchId: 1,
  branchName: "Head Office",
  designationCount: 2,
  hodCount: 0,
  createdAt: null,
  ...hc(2, 3, 1),
};

const DESIG = (id: number, title: string, level: string, deptId: number | null, h = hc(0, 0)): DesignationRow => ({
  id,
  title,
  level,
  departmentId: deptId,
  departmentName: deptId ? "Cutting" : null,
  branchId: deptId ? 1 : null,
  branchName: deptId ? "Head Office" : null,
  createdAt: null,
  ...h,
});

const TREE: DesignationsTree = {
  branches: [{ id: 1, name: "Head Office" }],
  departments: [
    { id: 1, name: "Cutting", branchId: 1, branchName: "Head Office", active: 7 },
    { id: 2, name: "Admin", branchId: 1, branchName: "Head Office", active: 0 },
  ],
  designations: [
    DESIG(1, "Master", "senior", 1, hc(2, 0)),
    DESIG(2, "Helper", "junior", 1, hc(0, 3, 1)),
    DESIG(3, "Floating", "", null),
  ],
  unassigned: { active: 0, staff: 0, production: 0 },
};

const noop = () => {};
const q = (root: ParentNode, id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe("SplitBar", () => {
  it("names both numbers for assistive tech and in the legend", () => {
    const el = render(createElement(SplitBar, { staff: 2, production: 3 }));
    expect(el.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("2 staff, 3 production");
    expect(el.textContent).toContain("2 staff");
    expect(el.textContent).toContain("3 production");
  });
  it("draws an empty grey bar for an empty department", () => {
    const el = render(createElement(SplitBar, { staff: 0, production: 0 }));
    expect(el.querySelectorAll('[role="img"] > span')).toHaveLength(0);
  });
});

describe("DepartmentList", () => {
  it("shows a row and a card per department with the staff / production figures", () => {
    const el = render(createElement(DepartmentList, { rows: [DEPT], onOpen: noop, onEdit: noop, onDelete: noop }));
    const row = q(el, "dept-row-Cutting")!;
    expect(row.dataset.staff).toBe("2");
    expect(row.dataset.production).toBe("3");
    expect(row.dataset.active).toBe("5");
    expect(row.textContent).toContain("+1 inactive");
    expect(q(el, "dept-card-Cutting")).not.toBeNull();
  });
  it("opens on the name and on the row, and edit / delete do not open it", () => {
    const onOpen = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const el = render(createElement(DepartmentList, { rows: [DEPT], onOpen, onEdit, onDelete }));
    act(() => q(el, "dept-open-Cutting")!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    act(() => q(el, "dept-edit-Cutting")!.click());
    act(() => q(el, "dept-delete-Cutting")!.click());
    expect(onEdit).toHaveBeenCalledWith(DEPT);
    expect(onDelete).toHaveBeenCalledWith(DEPT);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("DesignationList", () => {
  it("shows Unassigned for a designation with no department", () => {
    const el = render(
      createElement(DesignationList, { rows: TREE.designations, onOpen: noop, onEdit: noop, onDelete: noop }),
    );
    expect(q(el, "desig-row-Floating")!.textContent).toContain("Unassigned");
    expect(q(el, "desig-row-Helper")!.dataset.production).toBe("3");
  });
});

describe("DesignationTree", () => {
  const nodes = buildTree(TREE, filterDesignations(TREE.designations, NO_DESIG_FILTERS), NO_DESIG_FILTERS);
  const draw = (over: Partial<Parameters<typeof DesignationTree>[0]> = {}) =>
    render(
      createElement(DesignationTree, {
        nodes,
        collapsed: new Set<string>(),
        forceOpen: false,
        onToggle: noop,
        onOpen: noop,
        onEdit: noop,
        onDelete: noop,
        onAdd: noop,
        ...over,
      }),
    );

  it("draws branch, department and designation levels, with counts", () => {
    const el = draw();
    const branch = q(el, "branch-node-Head Office")!;
    expect(branch.textContent).toContain("2 departments");
    expect(branch.textContent).toContain("2 designations");
    expect(q(el, "dept-node-Cutting")!.textContent).toContain("Master");
    expect(q(el, "desig-row-Helper")!.dataset.active).toBe("3");
    // a department with no designation and the designations that have no department are both visible
    expect(q(el, "dept-empty-Admin")).not.toBeNull();
    expect(q(el, "branch-node-Unassigned")!.textContent).toContain("Floating");
    expect(q(el, "desig-row-Master")!.textContent).toContain("Senior");
  });
  it("hides what is closed, and shows it again when a filter forces the groups open", () => {
    expect(q(draw({ collapsed: new Set(["d:1"]) }), "desig-row-Master")).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    expect(q(draw({ collapsed: new Set(["d:1"]), forceOpen: true }), "desig-row-Master")).not.toBeNull();
  });
  it("closing a branch hides its departments", () => {
    const el = draw({ collapsed: new Set(["b:1"]) });
    expect(q(el, "dept-node-Cutting")).toBeNull();
    expect(q(el, "branch-node-Head Office")!.dataset.open).toBe("false");
  });
  it("wires the toggles and the Add button (with the department of its group)", () => {
    const onToggle = vi.fn();
    const onAdd = vi.fn();
    const el = draw({ onToggle, onAdd });
    act(() => q(el, "toggle-branch-Head Office")!.click());
    act(() => q(el, "toggle-dept-Cutting")!.click());
    expect(onToggle.mock.calls).toEqual([["b:1"], ["d:1"]]);
    act(() => q(el, "add-desig-Cutting")!.click());
    expect(onAdd).toHaveBeenCalledWith(1);
  });
  it("opens, edits and deletes a designation without one click triggering the other", () => {
    const onOpen = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const el = draw({ onOpen, onEdit, onDelete });
    act(() => q(el, "desig-edit-Master")!.click());
    act(() => q(el, "desig-delete-Master")!.click());
    expect(onOpen).not.toHaveBeenCalled();
    expect(onEdit.mock.calls[0][0].title).toBe("Master");
    expect(onDelete.mock.calls[0][0].title).toBe("Master");
    act(() => q(el, "desig-open-Master")!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("notes people of a department who hold none of its designations, but not while filtering", () => {
    expect(q(draw(), "dept-without-Cutting")!.textContent).toContain("2 active employees");
    act(() => root?.unmount());
    host?.remove();
    expect(q(draw({ forceOpen: true }), "dept-without-Cutting")).toBeNull();
  });
});
