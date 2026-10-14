import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { useIsRefreshingPayroll, useRefreshPayroll, type RefreshOptions } from "./use-payroll-actions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEYS = {
  records: ["/api/payroll", { month: 2, year: 2026 }],
  issues: ["/api/payroll/issues", { kind: "staff", month: 2, year: 2026 }],
  statement: ["/api/payroll/insights/statement", { kind: "staff" }],
  production: ["/api/payroll/production", { cycle: "weekly" }],
  slips: ["/api/salary-slips", { month: 2 }],
  skipCheck: ["/api/payroll/skip-check", { month: 2, year: 2026, runType: "monthly" }],
  productionSkipCheck: ["/api/payroll/production/skip-check", { cycle: "weekly" }],
  employees: ["/api/employees", {}],
  settings: ["/api/payroll-settings"],
} as const;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const key of Object.values(KEYS)) client.setQueryData([...key], { loaded: true });
  let refresh!: (options?: RefreshOptions) => Promise<void>;
  let refreshing = false;
  function Probe() {
    refresh = useRefreshPayroll();
    refreshing = useIsRefreshingPayroll();
    return null;
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(Probe))));
  const invalidated = () =>
    Object.entries(KEYS)
      .filter(([, key]) => client.getQueryState([...key])?.isInvalidated)
      .map(([name]) => name)
      .sort();
  return {
    client,
    refresh: (options?: RefreshOptions) => act(() => refresh(options)),
    invalidated,
    refreshing: () => refreshing,
  };
}

describe("useRefreshPayroll", () => {
  it("reloads every payroll figure (the payroll settings and the skipped-employees checks too) and nothing else", async () => {
    const { refresh, invalidated } = setup();
    await refresh();
    expect(invalidated()).toEqual(
      ["issues", "production", "productionSkipCheck", "records", "settings", "skipCheck", "slips", "statement"].sort(),
    );
    // an employees list is not a payroll figure
    expect(invalidated()).not.toContain("employees");
  });

  it("leaves the skipped-employees checks out after a change to one payslip", async () => {
    const { refresh, invalidated } = setup();
    await refresh({ skipCheck: false });
    expect(invalidated()).toEqual(["issues", "production", "records", "settings", "slips", "statement"].sort());
  });
});

describe("useIsRefreshingPayroll", () => {
  it("is false while no payroll query is fetching", () => {
    const { refreshing } = setup();
    expect(refreshing()).toBe(false);
  });
});
