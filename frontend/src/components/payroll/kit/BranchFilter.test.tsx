import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ branches: vi.fn() }));

vi.mock("@/lib/api-client/custom-hooks", () => ({ useListBranches: () => h.branches() }));

import { BranchFilter, branchIdOf } from "./BranchFilter";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Radix Select measures and observes the DOM; jsdom has neither
beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  window.HTMLElement.prototype.releasePointerCapture ??= () => {};
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  h.branches.mockReset();
});

function mount(value: string, onChange = vi.fn()) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(BranchFilter, { value, onChange, testId: "bf" })));
  return { onChange };
}

const BRANCHES = [
  { id: 1, name: "Head Office" },
  { id: 2, name: "Unit 3" },
];

describe("branchIdOf", () => {
  it("reads a branch id, and anything else as every branch", () => {
    expect(branchIdOf("2")).toBe(2);
    expect(branchIdOf("")).toBeUndefined();
    expect(branchIdOf("all")).toBeUndefined();
    expect(branchIdOf(undefined)).toBeUndefined();
    expect(branchIdOf("0")).toBeUndefined();
    expect(branchIdOf("-3")).toBeUndefined();
    expect(branchIdOf("2.5")).toBeUndefined();
    expect(branchIdOf("<script>")).toBeUndefined();
  });
});

describe("BranchFilter", () => {
  it("offers nothing to choose when the login sees one branch (or none yet)", () => {
    h.branches.mockReturnValue({ data: [BRANCHES[0]] });
    mount("");
    expect(host!.querySelector('[data-testid="bf"]')).toBeNull();
    h.branches.mockReturnValue({ data: undefined });
    act(() => root!.render(createElement(BranchFilter, { value: "", onChange: vi.fn(), testId: "bf" })));
    expect(host!.querySelector('[data-testid="bf"]')).toBeNull();
  });

  it("shows the chosen branch, or All branches for no branch and for one the login cannot see", () => {
    h.branches.mockReturnValue({ data: BRANCHES });
    mount("2");
    expect(host!.querySelector('[data-testid="bf"]')?.textContent).toContain("Unit 3");
    act(() => root!.render(createElement(BranchFilter, { value: "", onChange: vi.fn(), testId: "bf" })));
    expect(host!.querySelector('[data-testid="bf"]')?.textContent).toContain("All branches");
    act(() => root!.render(createElement(BranchFilter, { value: "99", onChange: vi.fn(), testId: "bf" })));
    expect(host!.querySelector('[data-testid="bf"]')?.textContent).toContain("All branches");
  });

  it("is labelled for assistive technology", () => {
    h.branches.mockReturnValue({ data: BRANCHES });
    mount("");
    expect(host!.querySelector('[data-testid="bf"]')?.getAttribute("aria-label")).toBe("Branch");
  });
});
