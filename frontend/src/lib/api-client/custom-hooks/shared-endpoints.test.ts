import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { customFetch } from "../custom-fetch";
import {
  getSharedEndpointQueryKey,
  getSharedEndpointsQueryKey,
  getSharedGuideQueryKey,
  getSharedKeysQueryKey,
  keyStatus,
  readActivity,
  readCatalog,
  readEndpoint,
  readGuide,
  readKey,
  readPreview,
  useCreateSharedKey,
  useRevokeSharedKey,
} from "./shared-endpoints";

vi.mock("../custom-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../custom-fetch")>()),
  customFetch: vi.fn(),
}));

// The readers of the Endpoint Sharing API: the real shapes of backend/api/shared_endpoint_admin_views.py, and tolerance for a
// bare array or another wrapper (a small difference in the envelope must not blank the page).

describe("readCatalog", () => {
  it("reads datasets, fields with their sensitivity, filters (enum values, defaults), the excluded list and the limits", () => {
    const catalog = readCatalog({
      datasets: [
        {
          key: "employees",
          label: "Employees",
          description: "d",
          fields: [
            { key: "phone", label: "Phone", type: "string", sensitivity: "personal", description: "p" },
            { key: "weird", label: "W", type: "blob", sensitivity: "???", description: "" },
          ],
          filters: [
            {
              key: "status",
              label: "Status",
              type: "enum",
              required: false,
              description: "s",
              values: ["active", "all"],
              default: "active",
            },
            {
              key: "month",
              label: "Month",
              type: "mystery",
              required: true,
              description: "",
              values: [],
              default: null,
            },
          ],
          defaultOrdering: ["name", "id"],
          maxPageSize: 500,
          dateRange: null,
        },
      ],
      hardExcluded: ["Passwords.", "Aadhaar."],
      limits: { maxEndpoints: 5, maxLiveKeysPerEndpoint: 2, maxOriginsPerEndpoint: 3 },
    });
    const ds = catalog.datasets[0];
    expect(ds.fields[0]).toMatchObject({ key: "phone", sensitivity: "personal", type: "string" });
    // an unknown type or level is read as the safe, plain one
    expect(ds.fields[1]).toMatchObject({ type: "string", sensitivity: "basic" });
    expect(ds.filters[0]).toMatchObject({ type: "enum", values: ["active", "all"], default: "active" });
    expect(ds.filters[1]).toMatchObject({ type: "string", required: true, default: null });
    expect(ds.maxPageSize).toBe(500);
    expect(catalog.hardExcluded).toEqual(["Passwords.", "Aadhaar."]);
    expect(catalog.limits).toEqual({ maxEndpoints: 5, maxLiveKeysPerEndpoint: 2, maxOriginsPerEndpoint: 3 });
  });

  it("survives nonsense", () => {
    expect(readCatalog(null)).toMatchObject({ datasets: [], hardExcluded: [] });
    expect(readCatalog("x").limits.maxOriginsPerEndpoint).toBe(20);
  });
});

describe("readEndpoint", () => {
  it("reads one endpoint as the server sends it", () => {
    const e = readEndpoint({
      id: 3,
      slug: "hr-departments",
      name: "N",
      description: "D",
      dataset: "departments",
      datasetLabel: "Departments",
      fields: ["id", "name"],
      lockedFilters: { status: "active", departmentId: 4 },
      origins: ["https://a.example.com"],
      allowNoOrigin: false,
      pageSizeDefault: 25,
      pageSizeMax: 100,
      rateLimitPerMinute: 30,
      enabled: false,
      version: "abc",
      liveKeys: 2,
    });
    expect(e).toMatchObject({
      id: 3,
      fields: ["id", "name"],
      lockedFilters: { status: "active", departmentId: "4" },
      allowNoOrigin: false,
      pageSizeMax: 100,
      enabled: false,
      version: "abc",
      liveKeyCount: 2,
    });
  });
});

describe("keys", () => {
  it("never carry more than the prefix, and their status is read from the dates when the server did not say", () => {
    const k = readKey({ id: 1, label: "L", prefix: "abcd1234", expiresAt: "2020-01-01T00:00:00+05:30" });
    expect(k.status).toBe("expired");
    expect(k).not.toHaveProperty("key");
    expect(readKey({ id: 2, revokedAt: "2026-01-01T00:00:00+05:30" }).status).toBe("revoked");
    expect(readKey({ id: 3 }).status).toBe("active");
    expect(keyStatus({ revokedAt: null, expiresAt: "2999-01-01T00:00:00Z" })).toBe("active");
  });
});

describe("readPreview, readActivity", () => {
  it("reads the rows, the shown fields, the total and the filters the server filled in", () => {
    const p = readPreview({
      data: [{ id: 1, name: "A" }],
      meta: { fields: ["id", "name"], total: 9, filters: { dateFrom: "2026-10-10" } },
    });
    expect(p).toEqual({
      rows: [{ id: 1, name: "A" }],
      fields: ["id", "name"],
      total: 9,
      filters: { dateFrom: "2026-10-10" },
    });
    expect(readPreview({ data: [{ a: 1 }] }).fields).toEqual(["a"]);
  });

  it("reads a page of the access log (items) with the endpoint each call reached", () => {
    const a = readActivity({
      items: [
        {
          id: 5,
          at: "2026-10-16T09:00:00+05:30",
          endpointId: 3,
          endpointSlug: "hr-departments",
          keyLabel: "K",
          keyPrefix: "abcd1234",
          status: 401,
          rows: null,
          origin: null,
          ip: "10.0.0.1",
          durationMs: 4,
          error: "invalid_key",
        },
      ],
      page: 2,
      pageSize: 50,
      total: 120,
      hasMore: true,
    });
    expect(a.rows[0]).toMatchObject({ endpointSlug: "hr-departments", status: 401, error: "invalid_key", rows: null });
    expect(a).toMatchObject({ page: 2, pageSize: 50, total: 120, hasMore: true });
  });
});

describe("readGuide", () => {
  it("reads the generated guide: parameters with allowed words, locked filters, response fields, errors and examples by language", () => {
    const g = readGuide({
      baseUrl: "https://hr.example.com",
      url: "https://hr.example.com/api/shared/x",
      method: "GET",
      headers: [{ name: "Authorization", value: "Bearer YOUR_API_KEY", required: true, description: "d" }],
      parameters: [
        {
          name: "status",
          type: "enum",
          required: false,
          default: "active",
          values: ["active", "all"],
          description: "s",
          example: "active",
        },
        { name: "page", type: "integer", required: false, default: "1", values: [], description: "p", example: "1" },
      ],
      lockedFilters: [{ name: "employmentType", value: "staff" }],
      pagination: { defaultPageSize: 50, maxPageSize: 200, rateLimitPerMinute: 60 },
      response: {
        fields: [
          { name: "id", type: "integer", label: "Id", description: "Department id.", sensitivity: "basic", sample: 4 },
        ],
        sample: { data: [{ id: 4 }], meta: { total: 1 } },
      },
      errors: [{ status: 401, code: "invalid_key", meaning: "m" }],
      examples: { curl: "curl x", python: "import requests", csharp: "using var client" },
      access: { origins: ["https://a.example.com"], allowNoOrigin: true, notes: ["n1"] },
    });
    expect(g.url).toBe("https://hr.example.com/api/shared/x");
    expect(g.parameters[0]).toMatchObject({ name: "status", values: ["active", "all"], default: "active" });
    expect(g.lockedFilters).toEqual([{ name: "employmentType", value: "staff" }]);
    expect(g.pagination).toEqual({ defaultPageSize: 50, maxPageSize: 200, rateLimitPerMinute: 60 });
    expect(g.responseFields[0]).toMatchObject({ name: "id", sample: 4, sensitivity: "basic" });
    expect(g.sampleResponse).toEqual({ data: [{ id: 4 }], meta: { total: 1 } });
    expect(g.errors).toEqual([{ status: 401, code: "invalid_key", meaning: "m" }]);
    expect(g.examples.map((e) => [e.language, e.label])).toEqual([
      ["curl", "curl"],
      ["python", "Python"],
      ["csharp", "C#"],
    ]);
    expect(g.origins).toEqual(["https://a.example.com"]);
    expect(g.notes).toEqual(["n1"]);
  });

  it("also reads the examples as a list", () => {
    const g = readGuide({ examples: [{ language: "node", label: "Node", code: "fetch()" }] });
    expect(g.examples).toEqual([{ language: "node", label: "Node", code: "fetch()" }]);
    expect(g.method).toBe("GET");
  });
});

describe("creating and revoking a key refreshes everything that shows the number of live keys", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(customFetch).mockReset();
  });

  function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    // what is on screen: the list (key counts), the open endpoint (its status banner), its key table and its guide
    const keys = [
      getSharedEndpointsQueryKey(),
      getSharedEndpointQueryKey(7),
      getSharedKeysQueryKey(7),
      getSharedGuideQueryKey(7),
    ];
    for (const key of keys) client.setQueryData(key, { cached: true });
    const other = getSharedEndpointQueryKey(8);
    client.setQueryData(other, { cached: true });
    const hooks: { create?: ReturnType<typeof useCreateSharedKey>; revoke?: ReturnType<typeof useRevokeSharedKey> } =
      {};
    function Probe() {
      hooks.create = useCreateSharedKey(7);
      hooks.revoke = useRevokeSharedKey(7);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(QueryClientProvider, { client }, createElement(Probe))));
    const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated === true;
    return { client, hooks, keys, other, stale, unmount: () => act(() => root.unmount()) };
  }

  it("a new key invalidates the key table, the endpoint (status banner), the list and the guide, and nothing else", async () => {
    const view = mount();
    vi.mocked(customFetch).mockResolvedValue({
      id: 3,
      label: "Website",
      prefix: "abcd1234",
      key: "uks_abcd1234_secret",
    });
    await act(async () => {
      await view.hooks.create!.mutateAsync({ label: "Website" });
    });
    for (const key of view.keys) expect(view.stale(key), JSON.stringify(key)).toBe(true);
    expect(view.stale(view.other)).toBe(false); // another endpoint is untouched
    // the secret is handed to the caller once and is not written into any cached query
    expect(
      JSON.stringify(
        view.client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain("uks_abcd1234_secret");
    view.unmount();
  });

  it("revoking a key invalidates the same four queries (the banner stops saying the endpoint is live)", async () => {
    const view = mount();
    vi.mocked(customFetch).mockResolvedValue({});
    await act(async () => {
      await view.hooks.revoke!.mutateAsync(3);
    });
    for (const key of view.keys) expect(view.stale(key), JSON.stringify(key)).toBe(true);
    expect(view.stale(view.other)).toBe(false);
    expect(vi.mocked(customFetch)).toHaveBeenCalledWith("/api/shared-endpoints/7/keys/3", { method: "DELETE" });
    view.unmount();
  });

  it("a failed key call invalidates nothing", async () => {
    const view = mount();
    vi.mocked(customFetch).mockRejectedValue(new Error("boom"));
    await act(async () => {
      await view.hooks.create!.mutateAsync({ label: "x" }).catch(() => undefined);
      await view.hooks.revoke!.mutateAsync(3).catch(() => undefined);
    });
    for (const key of view.keys) expect(view.stale(key), JSON.stringify(key)).toBe(false);
    view.unmount();
  });
});
