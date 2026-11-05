import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import PageRefreshBar, { clock } from "./PageRefreshBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

// The bar recomputes on the next frame after the query cache changes.
const frame = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 40)));
const lastUpdated = () => host!.querySelector('[data-testid="page-last-updated"]')?.textContent ?? null;

function mount(client: QueryClient, load: () => Promise<number>) {
  let rerenderPage: () => void = () => {};
  function Page() {
    const [, setTick] = useState(0);
    rerenderPage = () => setTick((t) => t + 1);
    useQuery({ queryKey: ["figure"], queryFn: load });
    return createElement(PageRefreshBar);
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(Page))));
  return { rerenderPage: () => act(() => rerenderPage()) };
}

describe("PageRefreshBar", () => {
  it("says when the data on screen arrived, and follows a refetch", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolve: (n: number) => void = () => {};
    mount(client, () => new Promise<number>((r) => (resolve = r)));
    expect(lastUpdated()).toBeNull();

    await act(async () => resolve(1));
    await frame();
    const first = client.getQueryState(["figure"])!.dataUpdatedAt;
    expect(lastUpdated()).toBe(`Updated ${clock(first)}`);

    vi.spyOn(Date, "now").mockReturnValue(first + 65_000);
    act(() => void client.refetchQueries({ queryKey: ["figure"] }));
    await act(async () => resolve(2));
    await frame();
    const second = client.getQueryState(["figure"])!.dataUpdatedAt;
    expect(second).toBe(first + 65_000);
    expect(lastUpdated()).toBe(`Updated ${clock(second)}`);
  });

  it("watches the cache once, however often the page re-renders, and stops when it unmounts", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const subscribe = vi.spyOn(client.getQueryCache(), "subscribe");
    const page = mount(client, async () => 1);
    await frame();
    for (let i = 0; i < 5; i++) page.rerenderPage();
    expect(subscribe).toHaveBeenCalledTimes(1);

    act(() => root!.unmount());
    root = null;
    expect(client.getQueryCache().hasListeners()).toBe(false);
  });
});
