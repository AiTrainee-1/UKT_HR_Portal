import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotIncludedEmployee, PayrollNotIncluded } from "@/lib/api-client/custom-hooks";
import { NotIncludedView } from "./NotIncludedView";

// The "Not included" view of Staff Payroll's Payroll tab in jsdom (owner 2026-11-20), with a fake server behind
// customFetch: Staff first, the reason chips (the Production one moves the category), a month not generated yet, the
// "generate again" banner and a row that opens its own payroll. The production scope is on the cycle page's render tests.

const h = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: null }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

const person = (id: number, over: Partial<NotIncludedEmployee> = {}): NotIncludedEmployee => ({
  id,
  code: `E${id}`,
  name: `Name ${id}`,
  category: "staff",
  status: "active",
  departmentId: 3,
  department: "ACCOUNTS",
  designationId: 5,
  designation: "ACCOUNTANT",
  branchId: 1,
  unit: "HO",
  joinDate: "2025-04-21",
  reasonCode: "on_hold",
  reason: "Salary on hold for November 2026.",
  detail: null,
  payrollId: null,
  ...over,
});

let answer: PayrollNotIncluded;

const of = (employees: NotIncludedEmployee[], generated = true): PayrollNotIncluded => {
  const byReason: Record<string, number> = {};
  for (const e of employees) byReason[e.reasonCode] = (byReason[e.reasonCode] ?? 0) + 1;
  return {
    month: 11,
    year: 2026,
    periodLabel: "November 2026",
    generated,
    notGeneratedCount: generated ? 0 : employees.filter((e) => e.reasonCode === "not_generated").length,
    summary: {
      total: employees.length,
      staff: employees.filter((e) => e.category === "staff").length,
      production: employees.filter((e) => e.category === "production").length,
      byReason,
    },
    employees,
    departments: [{ id: 3, name: "ACCOUNTS" }],
    designations: [{ id: 5, title: "ACCOUNTANT" }],
  };
};

const opened: number[] = [];
const generate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  opened.length = 0;
  answer = of([
    person(1, { payrollId: 881, name: "Hari Held" }),
    person(2, { reasonCode: "not_generated", reason: "Would be paid: generate the payroll again." }),
    person(3, { category: "production", reasonCode: "production", reason: "Paid on Production Payroll." }),
  ]);
  h.fetch.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/payroll/not-included?")) return JSON.parse(JSON.stringify(answer));
    if (url === "/api/payroll-settings") return { companyName: "UK Textiles" };
    throw new Error(`unexpected ${url}`);
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
});

function Harness() {
  const [url, setUrl] = useState<Record<string, string>>({});
  return createElement(
    "div",
    { "data-testid": "url", "data-url": JSON.stringify(url) },
    createElement(NotIncludedView, {
      scope: { kind: "staff", month: 11, year: 2026 },
      periodLabel: "November 2026",
      url,
      setUrl: (patch: Record<string, string>) => setUrl((u) => ({ ...u, ...patch })),
      onOpenPayroll: (id: number) => opened.push(id),
      onGenerate: generate,
    }),
  );
}

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(Harness))));
  await waitFor(() => !!q("ni-list") || !!q("ni-empty"), "the list");
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]`);
  return el;
};
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null | undefined) =>
  act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
async function waitFor(check: () => boolean, what: string, timeoutMs = 3000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs)
      throw new Error(`timed out waiting for ${what}: ${text(document.body).slice(0, 300)}`);
    await settle(5);
  }
}
const urlState = () => JSON.parse(must("url").dataset.url!) as Record<string, string>;

describe("the staff Not included view", () => {
  it("asks for the month and lists the staff left out, with the reason; production is not listed at first", async () => {
    await mount();
    expect(h.fetch).toHaveBeenCalledWith("/api/payroll/not-included?month=11&year=2026");
    expect(q("not-included-view")!.dataset.kind).toBe("staff");
    expect(text(q("ni-category"))).toBe("Staff");
    expect(text(q("ni-row-1-reason"))).toBe("Salary on hold for November 2026.");
    expect(q("ni-row-3")).toBeNull();
    expect(text(q("ni-count"))).toBe("2 staff employees not in the payroll");
  });

  it("the Production chip shows the production employees and moves the category with it", async () => {
    await mount();
    click(must("ni-reason-chip-production"));
    await waitFor(() => !!q("ni-row-3"), "the production employee");
    expect(urlState()).toMatchObject({ nireason: "production", nicat: "production" });
    expect(q("ni-row-1")).toBeNull();
    click(must("ni-reason-chip-production"));
    await waitFor(() => urlState().nireason === "all", "every reason again");
  });

  it("says who would be paid but is not in the payroll, and generates again from the banner", async () => {
    await mount();
    expect(text(q("ni-generate-again"))).toContain("1 staff employee would be paid but is not in the payroll.");
    click(must("ni-generate-again-button"));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("opens the payroll of a row that has one", async () => {
    await mount();
    click(must("ni-row-1-open"));
    expect(opened).toEqual([881]);
    expect(q("ni-row-2-open")).toBeNull();
  });

  it("keeps the ones only waiting out of a month not generated yet, and counts them in the banner", async () => {
    answer = of([person(1), person(2, { reasonCode: "not_generated", reason: "Waiting for the payroll." })], false);
    await mount();
    expect(text(q("ni-not-generated"))).toContain("The payroll of November 2026 is not generated yet.");
    expect(text(q("ni-not-generated"))).toContain("1 active staff employee with a salary is waiting for it.");
    expect(q("ni-row-2")).toBeNull();
    expect(q("ni-generate-again")).toBeNull();
    click(must("ni-generate"));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("says everyone is in the payroll when nobody is left out", async () => {
    answer = of([person(3, { category: "production", reasonCode: "production" })]);
    await mount();
    expect(text(q("ni-empty"))).toContain("Every staff employee is in the payroll of November 2026");
  });
});
