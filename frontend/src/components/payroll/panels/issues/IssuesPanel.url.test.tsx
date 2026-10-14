import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { STAFF_SCOPE, makeResponse } from "./fixtures";
import { IssuesPanel } from "./IssuesPanel";
import { DEFAULT_ISSUE_FILTERS } from "./issues-logic";

// How a page uses the panel: its filters live in the address (the kit's useUrlParams), so a reload or Back from a
// payroll's details page lands on the same view. The panel is controlled by the page and reports every change as a
// patch; a value equal to its default stays out of the address.

const h = vi.hoisted(() => ({ issues: vi.fn(), settings: vi.fn(), open: vi.fn() }));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }), toast: vi.fn() }));
vi.mock("@/lib/api-client/custom-hooks", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-hooks")>()),
  usePayrollIssues: (...args: unknown[]) => h.issues(...args),
  usePayrollSettings: () => h.settings(),
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
  h.issues.mockReturnValue({ data: makeResponse(), isLoading: false, isError: false, refetch: vi.fn() });
  h.settings.mockReturnValue({ data: { companyName: "UK Textiles Test" } });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
});

/** A page: the issues tab of Staff Payroll, with the panel's filters in the address. */
function IssuesTab() {
  const [values, set] = useUrlParams(DEFAULT_ISSUE_FILTERS);
  return createElement(IssuesPanel, {
    scope: STAFF_SCOPE,
    accent: "indigo",
    value: values,
    onChange: set,
    onOpenDetails: h.open,
  });
}

function mount(address: string) {
  window.history.replaceState(null, "", address);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(IssuesTab)));
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]`);
  return el;
};
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const typeInto = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const rows = () => document.body.querySelectorAll('[data-testid^="issue-row-"]').length;
const tab = (name: string) =>
  [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => text(t).startsWith(name))!;
const params = () => Object.fromEntries(new URLSearchParams(window.location.search));

describe("the panel's filters in the page's address", () => {
  it("a filter goes into the address beside what the page already keeps there", () => {
    mount("/hr/payroll?tab=issues&month=10");
    expect(rows()).toBe(11);
    typeInto(must("issues-search") as HTMLInputElement, "asha");
    expect(params()).toEqual({ tab: "issues", month: "10", q: "asha" });
    expect(rows()).toBe(4);
    click(must("issues-kpi-critical"));
    expect(params()).toEqual({ tab: "issues", month: "10", q: "asha", severity: "critical" });
    expect(rows()).toBe(1);
  });

  it("the grouping goes into the address too, and the default grouping stays out of it", () => {
    mount("/hr/payroll?tab=issues");
    click(tab("Employee"));
    expect(params()).toEqual({ tab: "issues", groupBy: "employee" });
    expect(must("issues-list").dataset.groupBy).toBe("employee");
    click(tab("Date"));
    expect(params()).toEqual({ tab: "issues" }); // "date" is the default: nothing to remember
  });

  it("Reset clears the filters from the address and keeps the grouping", () => {
    mount("/hr/payroll?tab=issues");
    click(tab("Type"));
    typeInto(must("issues-search") as HTMLInputElement, "asha");
    click(must("issues-type-absent"));
    expect(params()).toEqual({ tab: "issues", groupBy: "type", q: "asha", code: "absent" });
    click(must("issues-reset"));
    expect(params()).toEqual({ tab: "issues", groupBy: "type" });
    expect(rows()).toBe(11);
  });

  it("a date range is kept as two parameters", () => {
    mount("/hr/payroll?tab=issues");
    typeInto(must("issues-from") as HTMLInputElement, "2026-10-14");
    typeInto(must("issues-to") as HTMLInputElement, "2026-10-15");
    expect(params()).toEqual({ tab: "issues", from: "2026-10-14", to: "2026-10-15" });
    expect(rows()).toBe(2);
  });

  it("opens on the view the address describes, as after Back from a payroll's details page", () => {
    mount("/hr/payroll?tab=issues&severity=critical&groupBy=type&q=bala");
    expect(must("issues-list").dataset.groupBy).toBe("type");
    expect(rows()).toBe(1);
    expect((must("issues-search") as HTMLInputElement).value).toBe("bala");
    expect(must("issues-kpi-critical").getAttribute("aria-pressed")).toBe("true");
    expect(text(must("issues-reset"))).toBe("Reset2");
  });

  it("is not thrown by an address someone edited by hand", () => {
    mount("/hr/payroll?tab=issues&severity=bogus&groupBy=zzz&from=yesterday&to=tomorrow");
    expect(rows()).toBe(11);
    expect(must("issues-list").dataset.groupBy).toBe("date");
    expect(q("issues-reset")).toBeNull(); // nothing valid was asked for
  });

  it("Open details is the page's to handle", () => {
    mount("/hr/payroll?tab=issues");
    click(must("issue-row-101:late_in:2026-10-13").querySelector('[data-testid="issue-open-details"]'));
    expect(h.open).toHaveBeenCalledWith(expect.objectContaining({ id: "101:late_in:2026-10-13", payrollId: 101 }));
    // and the address was not touched
    expect(window.location.search).toBe("?tab=issues");
  });
});
