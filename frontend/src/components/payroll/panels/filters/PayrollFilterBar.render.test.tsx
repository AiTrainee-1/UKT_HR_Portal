import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IssueCodeCount } from "@/lib/api-client/custom-hooks";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { PayrollFilterBar, type PayrollFilterBarProps } from "./PayrollFilterBar";
import { DEFAULT_FILTERS, type PayrollFilterState } from "./filter-logic";

// The filter bar in jsdom, inside a small stateful page (the bar is controlled): what it asks for as the controls are
// used, the search that waits for a pause, the chips and the count, Reset, and what the view-only lock may touch.

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

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const DEPARTMENTS = [
  { id: 1, name: "Weaving" },
  { id: 2, name: "Stitching" },
  { id: 3, name: "New Products" },
  { id: "none", name: "No department" },
];

const ISSUE_OPTIONS: IssueCodeCount[] = [
  { code: "late_in", label: "Late arrival", severity: "warning", category: "attendance", count: 12 },
  { code: "absent", label: "Absent", severity: "critical", category: "attendance", count: 3 },
  { code: "ot_pay", label: "Overtime pay", severity: "info", category: "pay", count: 7 },
];

type Harness = {
  spy: ReturnType<typeof vi.fn>;
  set: (v: PayrollFilterState) => void;
  current: () => PayrollFilterState;
};

function mount(initial: Partial<PayrollFilterState> = {}, props: Partial<PayrollFilterBarProps> = {}): Harness {
  const spy = vi.fn();
  const api = {} as Harness;
  api.spy = spy;
  function Page() {
    const [value, setValue] = useState<PayrollFilterState>({ ...DEFAULT_FILTERS, ...initial });
    api.set = setValue;
    api.current = () => value;
    return createElement(PayrollFilterBar, {
      value,
      onChange: (next: PayrollFilterState) => {
        spy(next);
        setValue(next);
      },
      departments: DEPARTMENTS,
      issueOptions: ISSUE_OPTIONS,
      ...props,
    });
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(Page)));
  return api;
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the bar shows: ${text(host)}`);
  return el;
};
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const press = (el: Element, key: string) =>
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
const typeInto = (input: HTMLElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
/** Opens a select by keyboard and picks the option with this text. */
const choose = (testId: string, optionText: string) => {
  press(must(testId), "ArrowDown");
  const option = [...document.body.querySelectorAll('[role="option"]')].find((o) => text(o) === optionText);
  if (!option)
    throw new Error(
      `no option "${optionText}"; the options are: ${[...document.body.querySelectorAll('[role="option"]')].map(text).join(" | ")}`,
    );
  click(option);
};
const lastChange = (h: Harness) => h.spy.mock.calls.at(-1)?.[0] as PayrollFilterState;

describe("what the bar shows", () => {
  it("has every control, the severity chips and the switch", () => {
    mount();
    for (const id of [
      "search",
      "dept",
      "status",
      "issue",
      "sort",
      "sev-critical",
      "sev-warning",
      "sev-info",
      "only-issues",
      "reset",
    ]) {
      expect(q(`pf-${id}`), id).not.toBeNull();
    }
    expect(text(must("pf-sev-critical"))).toBe("Critical");
    expect(text(must("pf-sev-warning"))).toBe("Needs a look");
    expect(text(must("pf-sev-info"))).toBe("For information");
    expect(text(must("pf-bar"))).toContain("Only with issues");
    expect(text(must("pf-dept"))).toBe("All departments");
    expect(text(must("pf-status"))).toBe("All payments");
    expect(text(must("pf-issue"))).toBe("All issue types");
    expect(text(must("pf-sort"))).toBe("Name (A to Z)");
  });

  it("lists the departments and the issue types, with the counts, worst severity first", () => {
    mount();
    press(must("pf-dept"), "ArrowDown");
    expect([...document.body.querySelectorAll('[role="option"]')].map(text)).toEqual([
      "All departments",
      "Weaving",
      "Stitching",
      "New Products",
      "No department",
    ]);
    act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  });

  it("the issue select shows the types with issues and their counts", () => {
    mount();
    press(must("pf-issue"), "ArrowDown");
    expect([...document.body.querySelectorAll('[role="option"]')].map(text)).toEqual([
      "All issue types",
      "Absent (3)",
      "Late arrival (12)",
      "Overtime pay (7)",
    ]);
  });

  it("puts the page's own buttons in the right slot", () => {
    mount({}, { rightSlot: createElement("button", { type: "button", "data-testid": "page-action" }, "Export") });
    expect(must("pf-right").contains(must("page-action"))).toBe(true);
  });

  it("says how many rows pass the filters", () => {
    mount({}, { shown: 2, total: 4 });
    expect(text(must("pf-count"))).toBe("Showing 2 of 4");
    act(() => root!.unmount());
    host!.remove();
    mount({}, { shown: 4, total: 4 });
    expect(text(must("pf-count"))).toBe("4 payroll records");
    act(() => root!.unmount());
    host!.remove();
    mount({}, { shown: 1, total: 1 });
    expect(text(must("pf-count"))).toBe("1 payroll record");
    act(() => root!.unmount());
    host!.remove();
    mount();
    expect(q("pf-count")).toBeNull();
  });

  it("names a department or an issue type the lists do not have, instead of a blank box", () => {
    mount({ dept: "99", issue: "bank_missing" });
    expect(text(must("pf-dept"))).toBe("Department 99");
    expect(text(must("pf-issue"))).toBe("Bank details missing");
  });
});

describe("the search box", () => {
  it("waits for a pause before it asks, then asks once", async () => {
    const h = mount();
    typeInto(must("pf-search"), "rav");
    expect(h.spy).not.toHaveBeenCalled();
    await settle(320);
    expect(h.spy).toHaveBeenCalledTimes(1);
    expect(lastChange(h)).toEqual({ ...DEFAULT_FILTERS, q: "rav" });
  });

  it("starts the wait again at every keystroke", async () => {
    const h = mount();
    typeInto(must("pf-search"), "r");
    await settle(150);
    typeInto(must("pf-search"), "ra");
    await settle(150);
    expect(h.spy).not.toHaveBeenCalled();
    await settle(200);
    expect(h.spy).toHaveBeenCalledTimes(1);
    expect(lastChange(h).q).toBe("ra");
  });

  it("the wait is the caller's to set", async () => {
    const h = mount({}, { searchDelayMs: 30 });
    typeInto(must("pf-search"), "x");
    await settle(80);
    expect(lastChange(h).q).toBe("x");
  });

  it("Enter asks at once", () => {
    const h = mount();
    typeInto(must("pf-search"), "ravi");
    press(must("pf-search"), "Enter");
    expect(lastChange(h).q).toBe("ravi");
  });

  it("the clear button empties the box and asks at once", async () => {
    const h = mount({ q: "ravi" });
    expect((must("pf-search") as HTMLInputElement).value).toBe("ravi");
    click(must("pf-search-clear"));
    expect(lastChange(h).q).toBe("");
    expect((must("pf-search") as HTMLInputElement).value).toBe("");
    expect(q("pf-search-clear")).toBeNull();
    await settle(320);
    expect(h.spy).toHaveBeenCalledTimes(1); // nothing more arrives later
  });

  it("follows the page when it changes the search (the address, a chip, Reset)", () => {
    const h = mount({ q: "ravi" });
    act(() => h.set({ ...DEFAULT_FILTERS, q: "meena" }));
    expect((must("pf-search") as HTMLInputElement).value).toBe("meena");
    act(() => h.set({ ...DEFAULT_FILTERS }));
    expect((must("pf-search") as HTMLInputElement).value).toBe("");
  });

  it("a Reset pressed during the wait is not undone by the text that was still waiting", async () => {
    const h = mount({ status: "paid" });
    typeInto(must("pf-search"), "ravi");
    click(must("pf-reset"));
    await settle(320);
    expect(h.spy).toHaveBeenCalledTimes(1);
    expect(lastChange(h)).toEqual(DEFAULT_FILTERS);
    expect((must("pf-search") as HTMLInputElement).value).toBe("");
  });

  it("a text still waiting joins a filter changed meanwhile instead of overwriting it", async () => {
    const h = mount();
    typeInto(must("pf-search"), "ravi");
    choose("pf-status", "Cleared");
    expect(lastChange(h)).toEqual({ ...DEFAULT_FILTERS, status: "paid" });
    await settle(320);
    expect(lastChange(h)).toEqual({ ...DEFAULT_FILTERS, status: "paid", q: "ravi" });
  });
});

describe("the other controls", () => {
  it("department", () => {
    const h = mount();
    choose("pf-dept", "Stitching");
    expect(lastChange(h).dept).toBe("2");
    expect(text(must("pf-dept"))).toBe("Stitching");
    choose("pf-dept", "No department");
    expect(lastChange(h).dept).toBe("none");
    choose("pf-dept", "All departments");
    expect(lastChange(h).dept).toBe("all");
  });

  it("payment status", () => {
    const h = mount();
    choose("pf-status", "Pending");
    expect(lastChange(h).status).toBe("pending");
    choose("pf-status", "Cleared");
    expect(lastChange(h).status).toBe("paid");
    choose("pf-status", "All payments");
    expect(lastChange(h).status).toBe("all");
  });

  it("issue type", () => {
    const h = mount();
    choose("pf-issue", "Late arrival (12)");
    expect(lastChange(h).issue).toBe("late_in");
  });

  it("sort", () => {
    const h = mount();
    choose("pf-sort", "Net salary, high to low");
    expect(lastChange(h).sort).toBe("net");
    choose("pf-sort", "Most issues");
    expect(lastChange(h).sort).toBe("issues");
    choose("pf-sort", "Name (A to Z)");
    expect(lastChange(h).sort).toBe("name");
  });

  it("severity chips toggle one by one, and say which are on", () => {
    const h = mount();
    expect(must("pf-sev-critical").getAttribute("aria-pressed")).toBe("false");
    click(must("pf-sev-critical"));
    expect(lastChange(h).severity).toBe("critical");
    expect(must("pf-sev-critical").getAttribute("aria-pressed")).toBe("true");
    click(must("pf-sev-info"));
    expect(lastChange(h).severity).toBe("critical,info");
    click(must("pf-sev-critical"));
    expect(lastChange(h).severity).toBe("info");
    click(must("pf-sev-info"));
    expect(lastChange(h).severity).toBe("all");
  });

  it("the 'Only with issues' switch", () => {
    const h = mount();
    click(must("pf-only-issues"));
    expect(lastChange(h).onlyIssues).toBe(true);
    expect(must("pf-only-issues").getAttribute("aria-checked")).toBe("true");
    click(must("pf-only-issues"));
    expect(lastChange(h).onlyIssues).toBe(false);
  });

  it("clicking the switch's words flips it too", () => {
    const h = mount();
    click(must("pf-only-issues").closest("label"));
    expect(lastChange(h).onlyIssues).toBe(true);
  });

  it("each change keeps the filters already on", () => {
    const h = mount({ status: "pending" });
    choose("pf-dept", "Weaving");
    click(must("pf-sev-warning"));
    expect(lastChange(h)).toEqual({ ...DEFAULT_FILTERS, status: "pending", dept: "1", severity: "warning" });
  });
});

describe("the chips, the count and Reset", () => {
  const ALL_ON: Partial<PayrollFilterState> = {
    q: "ravi",
    dept: "2",
    status: "pending",
    issue: "late_in",
    severity: "critical,warning",
    onlyIssues: true,
    sort: "net",
  };

  it("shows nothing when no filter is on, and Reset waits", () => {
    mount();
    expect(q("pf-chips")).toBeNull();
    expect(q("pf-active")).toBeNull();
    expect((must("pf-reset") as HTMLButtonElement).disabled).toBe(true);
  });

  it("counts the filters that are on and draws a chip for each", () => {
    mount(ALL_ON);
    expect(text(must("pf-active"))).toBe("7 filters on");
    expect(text(must("pf-chips"))).toBe(
      'Search: "ravi"Department: StitchingPayment: PendingIssue: Late arrivalSeverity: CriticalSeverity: Needs a lookOnly with issues',
    );
    expect(text(must("pf-chip-dept"))).toBe("Department: Stitching");
  });

  it("one filter is '1 filter on', and the sort alone is not a filter but still can be reset", () => {
    mount({ status: "paid" });
    expect(text(must("pf-active"))).toBe("1 filter on");
    act(() => root!.unmount());
    host!.remove();
    mount({ sort: "net" });
    expect(q("pf-active")).toBeNull();
    expect((must("pf-reset") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a chip's cross takes off that filter only", () => {
    const h = mount(ALL_ON);
    click(must("pf-chip-dept-clear"));
    expect(lastChange(h)).toEqual({ ...DEFAULT_FILTERS, ...ALL_ON, dept: "all" });
    expect(q("pf-chip-dept")).toBeNull();
    expect(text(must("pf-active"))).toBe("6 filters on");
  });

  it("clearing one severity keeps the other", () => {
    const h = mount(ALL_ON);
    click(must("pf-chip-severity-critical-clear"));
    expect(lastChange(h).severity).toBe("warning");
    expect(q("pf-chip-severity-critical")).toBeNull();
    expect(q("pf-chip-severity-warning")).not.toBeNull();
  });

  it("clearing the search chip empties the box", () => {
    const h = mount(ALL_ON);
    click(must("pf-chip-q-clear"));
    expect(lastChange(h).q).toBe("");
    expect((must("pf-search") as HTMLInputElement).value).toBe("");
  });

  it("clearing the switch's chip turns the switch off", () => {
    mount(ALL_ON);
    expect(must("pf-only-issues").getAttribute("aria-checked")).toBe("true");
    click(must("pf-chip-onlyIssues-clear"));
    expect(must("pf-only-issues").getAttribute("aria-checked")).toBe("false");
  });

  it("each cross has a fixed label, never the free text of its chip", () => {
    mount({ dept: "3", q: "Send New", severity: "critical" });
    expect(must("pf-chip-dept-clear").getAttribute("aria-label")).toBe("Clear the department filter");
    expect(must("pf-chip-q-clear").getAttribute("aria-label")).toBe("Clear the search");
    expect(must("pf-chip-severity-critical-clear").getAttribute("aria-label")).toBe(
      "Clear the Critical severity filter",
    );
  });

  it("Reset puts every filter and the sort back", () => {
    const h = mount(ALL_ON);
    click(must("pf-reset"));
    expect(lastChange(h)).toEqual(DEFAULT_FILTERS);
    expect(q("pf-chips")).toBeNull();
    expect((must("pf-search") as HTMLInputElement).value).toBe("");
    expect(text(must("pf-sort"))).toBe("Name (A to Z)");
    expect((must("pf-reset") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("when the issues are not there (yet)", () => {
  it("the issue controls wait while the issues load, and keep their place", () => {
    mount({}, { issueOptions: undefined, issuesLoading: true });
    expect((must("pf-issue") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pf-sev-critical") as HTMLButtonElement).disabled).toBe(true);
    expect(must("pf-only-issues").hasAttribute("disabled")).toBe(true);
    expect((must("pf-dept") as HTMLButtonElement).disabled).toBe(false); // the rest still works
  });

  it("they are left out when the page has no issue data at all", () => {
    mount({}, { issueOptions: undefined });
    expect(q("pf-issue")).toBeNull();
    expect(q("pf-severity")).toBeNull();
    expect(q("pf-only-issues")).toBeNull();
    expect(q("pf-dept")).not.toBeNull();
  });

  it("'Most issues' cannot be chosen without issue data", () => {
    mount({}, { issueOptions: undefined });
    press(must("pf-sort"), "ArrowDown");
    const option = [...document.body.querySelectorAll('[role="option"]')].find((o) => text(o) === "Most issues")!;
    expect(option.getAttribute("aria-disabled")).toBe("true");
  });

  it("a filter that came from the address still shows, so it can be cleared", () => {
    mount({ issue: "late_in", severity: "critical", onlyIssues: true }, { issueOptions: undefined });
    expect(q("pf-chip-issue")).not.toBeNull();
    expect(q("pf-chip-severity-critical")).not.toBeNull();
    expect(q("pf-chip-onlyIssues")).not.toBeNull();
  });

  it("an issue select with no types still opens, with just 'All issue types'", () => {
    mount({}, { issueOptions: [] });
    press(must("pf-issue"), "ArrowDown");
    expect([...document.body.querySelectorAll('[role="option"]')].map(text)).toEqual(["All issue types"]);
  });
});

describe("while the rows load", () => {
  it("everything waits", () => {
    mount({ status: "paid" }, { disabled: true });
    for (const id of ["search", "dept", "status", "issue", "sort", "sev-critical", "reset", "chip-status-clear"]) {
      expect((must(`pf-${id}`) as HTMLButtonElement).disabled, id).toBe(true);
    }
  });
});

describe("view only", () => {
  it("filtering stays usable for a View Only role, whatever a department is called", () => {
    mount(
      { dept: "3", status: "paid", severity: "critical", q: "send new" },
      { rightSlot: createElement("button", { type: "button", "data-testid": "page-generate" }, "Generate payroll") },
    );
    // "New Products" and "Send New" are on the lock's word list ("new", "send")
    expect(text(must("pf-dept"))).toBe("New Products");
    lockMutatingControls(document.body);
    for (const id of [
      "pf-dept",
      "pf-status",
      "pf-sort",
      "pf-issue",
      "pf-sev-critical",
      "pf-sev-warning",
      "pf-only-issues",
      "pf-reset",
      "pf-search-clear",
      "pf-chip-dept-clear",
      "pf-chip-q-clear",
    ]) {
      expect((must(id) as HTMLButtonElement).disabled, id).toBe(false);
    }
  });

  it("the page's own buttons in the right slot are still locked", () => {
    mount(
      {},
      { rightSlot: createElement("button", { type: "button", "data-testid": "page-generate" }, "Generate payroll") },
    );
    lockMutatingControls(document.body);
    expect((must("page-generate") as HTMLButtonElement).disabled).toBe(true);
  });
});
