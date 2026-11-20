// A saved custom report changed in the builder and opened again straight away: the Report Center must fetch it afresh
// (its runs count as fresh for a minute), not show the cached run with the old columns. Same for a deleted one.

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRunReport } from "@/lib/api-client/custom-hooks/reports";
import { useDeleteCustomReport, useUpdateCustomReport } from "@/lib/api-client/custom-hooks/report-customise";
import { savedItem } from "./test-fixtures";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function server() {
  const state = { version: 1, runs: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/reports/run/custom-7") {
        state.runs += 1;
        const keys = state.version === 1 ? ["emp.code", "emp.name"] : ["emp.code", "emp.name", "pay.net"];
        return json({ id: "custom-7", columns: keys.map((key) => ({ key, label: key, type: "text" })), rows: [] });
      }
      if (url.pathname === "/api/reports/custom/saved/7" && init?.method === "PUT") {
        state.version = 2;
        return json(savedItem({ fields: ["emp.code", "emp.name", "pay.net"] }));
      }
      if (url.pathname === "/api/reports/custom/saved/7" && init?.method === "DELETE") return new Response(null);
      return json({ items: [], reports: [], categories: [] });
    }),
  );
  return state;
}

let shown: string[][] = [];
function Run() {
  const run = useRunReport("custom-7", "employeeStatus=active");
  useEffect(() => {
    if (run.data) shown.push(run.data.columns.map((c) => c.key));
  }, [run.data]);
  return null;
}

let update: ReturnType<typeof useUpdateCustomReport> | null = null;
let remove: ReturnType<typeof useDeleteCustomReport> | null = null;
function Builder() {
  update = useUpdateCustomReport();
  remove = useDeleteCustomReport();
  return null;
}

async function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem("uk_textile_token", "test-token");
  // the app's own defaults (App.tsx): 30 s fresh, TanStack's 5 minutes in the cache
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const settle = async () => {
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 15)));
  };
  const show = async (node: "run" | "builder") => {
    await act(async () =>
      root.render(<QueryClientProvider client={client}>{node === "run" ? <Run /> : <Builder />}</QueryClientProvider>),
    );
    await settle();
  };
  const done = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { show, settle, done };
}

afterEach(() => {
  shown = [];
  update = remove = null;
  vi.unstubAllGlobals();
});

describe("a saved report opened again after a change", () => {
  it("is fetched afresh with its new columns, not shown from the cache", async () => {
    const state = server();
    const page = await mount();
    await page.show("run"); // opened in the Report Center
    expect(shown.at(-1)).toEqual(["emp.code", "emp.name"]);
    await page.show("builder"); // edited: "Net pay" added, saved
    await act(async () => {
      await update!.mutateAsync({
        id: 7,
        body: { name: "x", description: "", dataset: "employees", fields: [], filters: {}, sort: [] },
      });
    });
    await page.settle();
    await page.show("run"); // "Open report": same filters, within the run's freshness
    expect(state.runs).toBe(2);
    expect(shown.at(-1)).toEqual(["emp.code", "emp.name", "pay.net"]);
    page.done();
  });

  it("is fetched afresh after a delete too (no old table under the id)", async () => {
    const state = server();
    const page = await mount();
    await page.show("run");
    await page.show("builder");
    await act(async () => {
      await remove!.mutateAsync(7);
    });
    await page.settle();
    await page.show("run");
    expect(state.runs).toBe(2);
    page.done();
  });
});
