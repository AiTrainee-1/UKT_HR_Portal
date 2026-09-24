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
