import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// A change on Manage Gates (add, edit, switch off, delete, sign out everywhere) also refreshes the gate choices the other
// pages hold: the In/Out page's Gate filter and the Tea Break page's Gate filter list the gates by name.

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../custom-fetch", async (original) => ({
  ...(await original<typeof import("../custom-fetch")>()),
  customFetch: h.fetch,
}));

import {
  GATE_ADMIN_KEYS,
  useCreateManagedGate,
  useDeleteManagedGate,
  useSignOutGate,
  useUpdateManagedGate,
} from "./gate-admin";
import { getInOutOptionsQueryKey, getInOutQueryKey } from "./gate-inout";
import { getTeaBreakAdminRecordsQueryKey, getTeaBreakOptionsQueryKey } from "./tea-break-admin";

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  h.fetch.mockReset();
});

type Mutations = {
  create: ReturnType<typeof useCreateManagedGate>;
  update: ReturnType<typeof useUpdateManagedGate>;
  remove: ReturnType<typeof useDeleteManagedGate>;
  signOut: ReturnType<typeof useSignOutGate>;
};

function mount(client: QueryClient) {
  const out: { current: Mutations | null } = { current: null };
  function Probe() {
    out.current = {
      create: useCreateManagedGate(),
      update: useUpdateManagedGate(),
      remove: useDeleteManagedGate(),
      signOut: useSignOutGate(),
    };
    return null;
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(Probe))));
  return () => out.current!;
}

/** A client holding the cached answers the other pages would have. */
function seeded() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(GATE_ADMIN_KEYS.all, []);
  client.setQueryData(getInOutOptionsQueryKey(), { gates: [{ id: 1, name: "Main Gate" }], departments: [] });
  client.setQueryData(getTeaBreakOptionsQueryKey(""), { gates: [{ id: 1, name: "Main Gate" }], departments: [] });
  client.setQueryData(getTeaBreakOptionsQueryKey("3"), { gates: [], departments: [] });
  client.setQueryData(getInOutQueryKey("page=1"), { items: [], total: 0, page: 1, pageSize: 25 });
  client.setQueryData(getTeaBreakAdminRecordsQueryKey("page=1"), { items: [], total: 0, page: 1, pageSize: 20 });
  return client;
}

const stale = (client: QueryClient, key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated ?? false;

describe("useRefreshGates (every Manage Gates change)", () => {
  it.each(["create", "update", "remove", "signOut"] as const)(
    "%s refreshes the gate list and the In/Out and Tea Break gate choices, not their records",
    async (which) => {
      h.fetch.mockResolvedValue({ id: 1, name: "Main Gate" });
      const client = seeded();
      const m = mount(client);
      await act(async () => {
        if (which === "create") await m().create.mutateAsync({ name: "Main Gate", username: "main", password: "x" });
        if (which === "update") await m().update.mutateAsync({ id: 1, data: { name: "Front Gate" } });
        if (which === "remove") await m().remove.mutateAsync(1);
        if (which === "signOut") await m().signOut.mutateAsync(1);
      });
      expect(stale(client, GATE_ADMIN_KEYS.all)).toBe(true);
      expect(stale(client, getInOutOptionsQueryKey())).toBe(true);
      expect(stale(client, getTeaBreakOptionsQueryKey(""))).toBe(true);
      expect(stale(client, getTeaBreakOptionsQueryKey("3"))).toBe(true);
      // the lists themselves are not asked again for a gate change
      expect(stale(client, getInOutQueryKey("page=1"))).toBe(false);
      expect(stale(client, getTeaBreakAdminRecordsQueryKey("page=1"))).toBe(false);
    },
  );
});
