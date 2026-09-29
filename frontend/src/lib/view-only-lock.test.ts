import { describe, expect, it } from "vitest";
import { isMutatingControl, lockMutatingControls } from "./view-only-lock";

function button(label: string, attrs: Record<string, string> = {}): HTMLButtonElement {
  const el = document.createElement("button");
  el.textContent = label;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

describe("isMutatingControl", () => {
  it("flags buttons whose label is a mutating verb", () => {
    for (const label of ["Add Employee", "Save", "Delete", "Approve", "Generate Payroll", "Export"]) {
      expect(isMutatingControl(button(label)), label).toBe(true);
    }
  });

  it("leaves browsing controls alone", () => {
    for (const label of ["All Departments", "Next", "Search", "Filter", "Close"]) {
      expect(isMutatingControl(button(label)), label).toBe(false);
    }
  });

  it("matches whole words only", () => {
    expect(isMutatingControl(button("Address book"))).toBe(false);
    expect(isMutatingControl(button("Posting history"))).toBe(false);
  });

  it("also reads aria-label and title", () => {
    expect(isMutatingControl(button("", { "aria-label": "Delete row" }))).toBe(true);
    expect(isMutatingControl(button("", { title: "Edit" }))).toBe(true);
  });
});

describe("data-view-safe opt-out", () => {
  it("never locks a button inside a view-safe container, however it is named", () => {
    const root = document.createElement("div");
    root.setAttribute("data-view-safe", "");
    const inner = document.createElement("div");
    root.appendChild(inner);
    const b = button("Export to Excel");
    inner.appendChild(b);
    expect(isMutatingControl(b)).toBe(false);
    lockMutatingControls(root);
    expect(b.disabled).toBe(false);
  });

  it("honours the attribute on the button itself", () => {
    expect(isMutatingControl(button("Generate", { "data-view-safe": "" }))).toBe(false);
  });

  it("still locks the same button outside a view-safe container", () => {
    expect(isMutatingControl(button("Export to Excel"))).toBe(true);
    const other = document.createElement("div");
    const b = button("Delete");
    other.appendChild(b);
    lockMutatingControls(other);
    expect(b.disabled).toBe(true);
  });
});

describe("lockMutatingControls", () => {
  it("disables only the mutating buttons and never touches inputs", () => {
    const root = document.createElement("div");
    root.innerHTML = '<button id="a">Save</button><button id="b">Next</button><input id="c" />';
    lockMutatingControls(root);
    expect((root.querySelector("#a") as HTMLButtonElement).disabled).toBe(true);
    expect((root.querySelector("#b") as HTMLButtonElement).disabled).toBe(false);
    expect((root.querySelector("#c") as HTMLInputElement).disabled).toBe(false);
  });
});
