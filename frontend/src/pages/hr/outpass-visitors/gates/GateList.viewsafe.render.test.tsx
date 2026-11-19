import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { GATES } from "../harness-gates";
import { DESKS } from "../harness-desks";
import { DeskList } from "../visitors/desks/DeskList";
import { GateList } from "./GateList";

// A View only account browses Manage Gates and Manage Reception: choosing a gate or a desk only shows it, so the View only
// lock (which disables any button whose name holds a changing word) must leave the cards alone even when the gate is
// called "Block A Gate" ("block") in a branch called "New Unit" ("new").

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(el: ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(el));
  // what HrLayout does for a View only role
  lockMutatingControls(document.body);
  return host;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const button = (testId: string) => {
  const el = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(el).not.toBeNull();
  return el!;
};
const click = (el: HTMLElement) => act(() => el.click());

const common = {
  loading: false,
  error: false,
  selection: "" as const,
  search: "",
  onSearch: () => {},
  status: "",
  onStatus: () => {},
  canEdit: false,
  onAdd: () => {},
};

describe("View only on the gate and desk lists", () => {
  it("opens a gate called Block A Gate in New Unit, and All gates", () => {
    const onSelect = vi.fn();
    const gate = { ...GATES[0], id: 21, name: "Block A Gate", branchName: "New Unit" };
    mount(createElement(GateList, { ...common, gates: [gate], onSelect }));
    const card = button("gate-card-21");
    expect(card.disabled).toBe(false);
    click(card);
    expect(onSelect).toHaveBeenLastCalledWith(21);
    const all = button("gate-card-all");
    expect(all.disabled).toBe(false);
    click(all);
    expect(onSelect).toHaveBeenLastCalledWith("all");
  });

  it("opens a desk called Block A Reception in New Unit, and All desks", () => {
    const onSelect = vi.fn();
    const desk = { ...DESKS[0], id: 31, name: "Block A Reception", branchName: "New Unit" };
    mount(createElement(DeskList, { ...common, desks: [desk], onSelect }));
    const card = button("desk-card-31");
    expect(card.disabled).toBe(false);
    click(card);
    expect(onSelect).toHaveBeenLastCalledWith(31);
    const all = button("desk-card-all");
    expect(all.disabled).toBe(false);
    click(all);
    expect(onSelect).toHaveBeenLastCalledWith("all");
  });

  it("still locks a real change next to them (Add gate)", () => {
    mount(createElement(GateList, { ...common, gates: [], canEdit: true, onSelect: () => {} }));
    const add = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Add gate"))!;
    expect(add.disabled).toBe(true);
  });
});
