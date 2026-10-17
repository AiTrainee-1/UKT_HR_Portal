import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Mock } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";

// Shared by the render tests of Endpoint Sharing: a small copy of the server behind `customFetch` (the real shapes of
// backend/api/shared_endpoint_admin_views.py), the tab mounted at a real address, and the DOM helpers the other render tests of
// the repo use. (The `vi.mock` calls stay in each test file: vitest only hoists them there.)

export type Call = { method: string; url: string; body: Record<string, unknown> };

export const apiError = (status: number, body: unknown = null): ApiError =>
  new ApiError(new Response(null, { status, statusText: String(status) }), body, { method: "GET", url: "/x" });

const field = (key: string, label: string, type: string, sensitivity: string, description: string) => ({
  key,
  label,
  type,
  sensitivity,
  description,
});

export const CATALOG = {
  datasets: [
    {
      key: "employees",
      label: "Employees",
      description: "The employee master list.",
      fields: [
        field("employeeCode", "Employee code", "string", "basic", "The employee's code."),
        field("firstName", "First name", "string", "basic", "First name."),
        field("department", "Department", "string", "basic", "Department name."),
        field("phone", "Phone", "string", "personal", "Personal phone number."),
        field("email", "Email", "string", "personal", "Email address."),
        field("salaryAmount", "Salary amount", "number", "financial", "Monthly salary in rupees."),
      ],
      filters: [
        {
          key: "status",
          label: "Status",
          type: "enum",
          required: false,
          description: "Which employees: active, inactive or all.",
          values: ["active", "inactive", "all"],
          default: "active",
        },
        {
          key: "departmentId",
          label: "Department id",
          type: "integer",
          required: false,
          description: "Only employees of this department.",
          values: [],
          default: null,
        },
        {
          key: "visibleToExternal",
          label: "Visible to external apps",
          type: "boolean",
          required: false,
          description:
            "true: only employees HR marked as visible to external applications. Not sent (or false): every employee that matches the other filters.",
          values: ["true", "false"],
          default: null,
        },
      ],
      defaultOrdering: ["employeeCode"],
      maxPageSize: 200,
      dateRange: null,
    },
    {
      key: "departments",
      label: "Departments",
      description: "The departments of the company.",
      fields: [
        field("id", "Id", "integer", "basic", "Department id."),
        field("name", "Name", "string", "basic", "Department name."),
        field("branch", "Branch", "string", "basic", "Branch name."),
      ],
      filters: [],
      defaultOrdering: ["name", "id"],
      maxPageSize: 500,
      dateRange: null,
    },
    {
      key: "payroll-summary",
      label: "Payroll summary",
      description: "Payroll totals of one month.",
      fields: [
        field("employeeCode", "Employee code", "string", "basic", "The employee's code."),
        field("netPay", "Net pay", "number", "financial", "Net pay in rupees."),
      ],
      filters: [
        {
          key: "month",
          label: "Month",
          type: "month",
          required: true,
          description: "The payroll month as YYYY-MM.",
          values: [],
          default: null,
        },
      ],
      defaultOrdering: ["employeeCode"],
      maxPageSize: 200,
      dateRange: null,
    },
  ],
  hardExcluded: [
    "Password hashes, login tokens, one-time passwords (OTPs), device secrets and API keys.",
    "Aadhaar and PAN numbers and any other government ID number.",
    "Bank names, account numbers and IFSC codes.",
    "PF, ESI and UAN numbers.",
    "Photographs and any other image data.",
    "Every column that is not listed in this catalog.",
  ],
  sensitivityLevels: { basic: "Organisation data", personal: "Personal data", financial: "Salary and payroll amounts" },
  limits: {
    maxEndpoints: 100,
    maxLiveKeysPerEndpoint: 10,
    maxOriginsPerEndpoint: 20,
    maxRateLimitPerMinute: 6000,
    logRetentionDays: 90,
  },
};

export type ServerEndpoint = {
  id: number;
  slug: string;
  name: string;
  description: string;
  dataset: string;
  datasetLabel: string;
  fields: string[];
  lockedFilters: Record<string, string>;
  origins: string[];
  allowNoOrigin: boolean;
  pageSizeDefault: number;
  pageSizeMax: number;
  rateLimitPerMinute: number;
  enabled: boolean;
  url: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: string;
  liveKeys: number;
  calls24h: number;
  lastCallAt: string | null;
  sensitiveFields: string[];
};

export const DEPARTMENTS_ENDPOINT: ServerEndpoint = {
  id: 3,
  slug: "hr-departments",
  name: "Departments for the intranet",
  description: "Read by the intranet.",
  dataset: "departments",
  datasetLabel: "Departments",
  fields: ["id", "name"],
  lockedFilters: {},
  origins: ["https://intranet.example.com"],
  allowNoOrigin: true,
  pageSizeDefault: 50,
  pageSizeMax: 200,
  rateLimitPerMinute: 60,
  enabled: true,
  url: "/api/shared/hr-departments",
  createdBy: "Asha",
  createdAt: "2026-10-10T10:00:00+05:30",
  updatedAt: "2026-10-12T10:00:00+05:30",
  version: "ver1",
  liveKeys: 1,
  calls24h: 12,
  lastCallAt: "2026-10-16T09:00:00+05:30",
  sensitiveFields: [],
};

export const EMPLOYEES_ENDPOINT: ServerEndpoint = {
  id: 4,
  slug: "hr-employees",
  name: "Employees for payroll tool",
  description: "",
  dataset: "employees",
  datasetLabel: "Employees",
  fields: ["employeeCode", "phone"],
  lockedFilters: { status: "active" },
  origins: [],
  allowNoOrigin: true,
  pageSizeDefault: 50,
  pageSizeMax: 200,
  rateLimitPerMinute: 60,
  enabled: false,
  url: "/api/shared/hr-employees",
  createdBy: "Asha",
  createdAt: "2026-10-11T10:00:00+05:30",
  updatedAt: "2026-10-11T10:00:00+05:30",
  version: "ver1",
  liveKeys: 0,
  calls24h: 0,
  lastCallAt: null,
  sensitiveFields: ["phone"],
};

export type ServerKey = {
  id: number;
  label: string;
  prefix: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  status: "active" | "revoked" | "expired";
};

export const KEY_ROW: ServerKey = {
  id: 11,
  label: "Intranet server",
  prefix: "abcd1234",
  createdBy: "Asha",
  createdAt: "2026-10-12T10:00:00+05:30",
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: "2026-10-16T09:00:00+05:30",
  lastUsedIp: "10.0.0.5",
  status: "active",
};

/** The one-time secret the fake server hands out. */
export const SECRET_KEY = "uks_wxyz9876_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-aBcDeFg";

export type World = {
  endpoints: Record<number, ServerEndpoint>;
  keys: Record<number, ServerKey[]>;
  nextId: number;
  nextKeyId: number;
  /** Every change sent (POST / PUT / DELETE). */
  writes: Call[];
  /** Every request, as asked. */
  requests: string[];
  /** Requests nobody planned for. */
  unexpected: string[];
  /** Paths (without the query) that fail with this status and body. */
  failing: Map<string, { status: number; body?: unknown }>;
  /** Activity rows to show. */
  activity: Record<string, unknown>[];
  /** The previews and activity queries asked, to check the request. */
  previews: Record<string, unknown>[];
};

export const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const SENSITIVE = new Map(
  CATALOG.datasets.flatMap((d) =>
    d.fields.filter((f) => f.sensitivity !== "basic").map((f) => [`${d.key}:${f.key}`, f.label] as const),
  ),
);

function guideOf(ep: ServerEndpoint) {
  const dataset = CATALOG.datasets.find((d) => d.key === ep.dataset)!;
  const url = `https://hr.example.com/api/shared/${ep.slug}`;
  const examples = Object.fromEntries(
    ["curl", "javascript", "python", "php", "csharp", "node"].map((l) => [
      l,
      `# ${l} example for ${url}\nYOUR_API_KEY`,
    ]),
  );
  examples.python = `import requests\nrequests.get("${url}")  # YOUR_API_KEY`;
  return {
    baseUrl: "https://hr.example.com",
    url,
    method: "GET",
    headers: [
      {
        name: "Authorization",
        value: "Bearer YOUR_API_KEY",
        required: true,
        description: "The API key of this endpoint.",
      },
      { name: "X-API-Key", value: "YOUR_API_KEY", required: false, description: "The same key, as an alternative." },
    ],
    parameters: [
      ...dataset.filters
        .filter((f) => !(f.key in ep.lockedFilters))
        .map((f) => ({
          name: f.key,
          type: f.type,
          required: f.required,
          default: f.default,
          values: f.values,
          description: f.description,
          example: f.values[0] ?? "1",
        })),
      {
        name: "page",
        type: "integer",
        required: false,
        default: "1",
        values: [],
        description: "Page number.",
        example: "1",
      },
      {
        name: "pageSize",
        type: "integer",
        required: false,
        default: "50",
        values: [],
        description: "Rows per page.",
        example: "50",
      },
    ],
    lockedFilters: Object.entries(ep.lockedFilters).map(([name, value]) => ({ name, value })),
    pagination: { defaultPageSize: 50, maxPageSize: 200, rateLimitPerMinute: 60 },
    response: {
      fields: ep.fields.map((key) => {
        const f = dataset.fields.find((x) => x.key === key)!;
        return { ...f, name: key, sample: key === "id" ? 4 : "Stitching" };
      }),
      sample: { data: [{ id: 4, name: "Stitching" }], meta: { endpoint: ep.slug, total: 1, hasMore: false } },
    },
    errors: [
      { status: 401, code: "invalid_key", meaning: "The API key is missing, wrong, revoked or expired." },
      { status: 403, code: "origin_not_allowed", meaning: "A browser call came from an origin that is not allowed." },
    ],
    examples,
    access: {
      origins: ep.origins,
      allowNoOrigin: ep.allowNoOrigin,
      notes: ["Origins protect browsers only: the API key is what protects the data."],
    },
  };
}

/** Wires a fake server into the mocked `customFetch`: the routes of the management API, answering as the real one does. */
export function installWorld(fetchMock: Mock): World {
  const world: World = {
    endpoints: { 3: copy(DEPARTMENTS_ENDPOINT), 4: copy(EMPLOYEES_ENDPOINT) },
    keys: { 3: [copy(KEY_ROW)], 4: [] },
    nextId: 5,
    nextKeyId: 20,
    writes: [],
    requests: [],
    unexpected: [],
    failing: new Map(),
    activity: [
      {
        id: 1,
        at: "2026-10-16T09:00:00+05:30",
        endpointId: 3,
        endpointSlug: "hr-departments",
        keyLabel: "Intranet server",
        keyPrefix: "abcd1234",
        status: 200,
        rows: 12,
        origin: "https://intranet.example.com",
        ip: "10.0.0.5",
        durationMs: 18,
        error: null,
      },
      {
        id: 2,
        at: "2026-10-16T09:01:00+05:30",
        endpointId: 3,
        endpointSlug: "hr-departments",
        keyLabel: null,
        keyPrefix: null,
        status: 401,
        rows: null,
        origin: null,
        ip: "10.0.0.9",
        durationMs: 3,
        error: "invalid_key",
      },
    ],
    previews: [],
  };
  const live = (id: number) => world.keys[id]?.filter((k) => k.status === "active").length ?? 0;
  const out = (ep: ServerEndpoint) => ({ ...copy(ep), liveKeys: live(ep.id) });

  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const method = (options?.method ?? "GET").toUpperCase();
    const [path] = url.split("?");
    const body = options?.body ? (JSON.parse(String(options.body)) as Record<string, unknown>) : {};
    world.requests.push(`${method} ${url}`);
    if (method !== "GET") world.writes.push({ method, url, body });
    const failing = world.failing.get(path);
    if (failing) throw apiError(failing.status, failing.body ?? { error: "failed" });

    const detail = /^\/api\/shared-endpoints\/(\d+)(\/[a-z]+)?(?:\/(\d+))?$/.exec(path);
    const id = detail ? Number(detail[1]) : null;
    const sub = detail?.[2] ?? "";
    const ep = id !== null ? world.endpoints[id] : undefined;

    if (method === "GET" && path === "/api/shared-endpoints/catalog") return copy(CATALOG);
    if (method === "GET" && path === "/api/shared-endpoints") {
      return { endpoints: Object.values(world.endpoints).map(out), limits: CATALOG.limits };
    }
    if (method === "POST" && path === "/api/shared-endpoints") {
      const fields = body.fields as string[];
      const added = fields.filter((f) => SENSITIVE.has(`${String(body.dataset)}:${f}`));
      if (added.length > 0 && body.acknowledgeSensitive !== true) {
        throw apiError(400, {
          error: `This selects personal or financial fields (${added.join(", ")}): confirm.`,
          code: "sensitive_confirmation_required",
          fields: added,
        });
      }
      const dataset = CATALOG.datasets.find((d) => d.key === body.dataset)!;
      const made: ServerEndpoint = {
        ...copy(DEPARTMENTS_ENDPOINT),
        ...(body as Partial<ServerEndpoint>),
        id: world.nextId++,
        datasetLabel: dataset.label,
        version: "ver1",
        liveKeys: 0,
        calls24h: 0,
        lastCallAt: null,
        url: `/api/shared/${String(body.slug)}`,
        sensitiveFields: added,
      };
      world.endpoints[made.id] = made;
      world.keys[made.id] = [];
      return out(made);
    }
    if (!ep || id === null) {
      if (method === "GET" && path === "/api/shared-endpoints/activity") {
        return { items: copy(world.activity), page: 1, pageSize: 50, total: world.activity.length, hasMore: false };
      }
      world.unexpected.push(`${method} ${url}`);
      throw apiError(404, { error: "That endpoint does not exist." });
    }
    if (sub === "" && method === "GET") return out(ep);
    if (sub === "" && method === "PUT") {
      if (body.expectedVersion !== undefined && body.expectedVersion !== ep.version) {
        throw apiError(400, { error: "This endpoint was changed by somebody else.", code: "stale_settings" });
      }
      const added = (body.fields as string[]).filter(
        (f) => !ep.fields.includes(f) && SENSITIVE.has(`${ep.dataset}:${f}`),
      );
      if (added.length > 0 && body.acknowledgeSensitive !== true) {
        throw apiError(400, { error: "Confirm the sensitive fields.", code: "sensitive_confirmation_required" });
      }
      const { expectedVersion: _e, acknowledgeSensitive: _a, ...rest } = body;
      Object.assign(ep, rest, { version: `ver${Number(ep.version.slice(3)) + 1}` });
      return out(ep);
    }
    if (sub === "" && method === "DELETE") {
      delete world.endpoints[id];
      return { deleted: true, id };
    }
    if (sub === "/keys" && method === "GET") return { keys: copy(world.keys[id] ?? []), maxLiveKeys: 10 };
    if (sub === "/keys" && method === "POST") {
      const made: ServerKey = {
        ...copy(KEY_ROW),
        id: world.nextKeyId++,
        label: String(body.label),
        prefix: "wxyz9876",
        expiresAt: typeof body.expiresAt === "string" ? `${body.expiresAt}T23:59:59+05:30` : null,
        lastUsedAt: null,
        lastUsedIp: null,
      };
      world.keys[id] = [made, ...(world.keys[id] ?? [])];
      return { ...copy(made), key: SECRET_KEY };
    }
    if (sub === "/keys" && method === "DELETE") {
      const key = world.keys[id].find((k) => k.id === Number(detail![3]))!;
      key.status = "revoked";
      key.revokedAt = "2026-10-16T10:00:00+05:30";
      return copy(key);
    }
    if (sub === "/preview" && method === "POST") {
      world.previews.push(body);
      return {
        data: [
          { id: 4, name: "Stitching" },
          { id: 5, name: "Cutting" },
        ],
        meta: { fields: ep.fields, total: 2, filters: (body.filters as Record<string, string>) ?? {}, preview: true },
      };
    }
    if (sub === "/guide" && method === "GET") return guideOf(ep);
    if (sub === "/activity" && method === "GET") {
      const rows = world.activity.filter((r) => r.endpointId === id);
      return { items: copy(rows), page: 1, pageSize: 50, total: rows.length, hasMore: false };
    }
    world.unexpected.push(`${method} ${url}`);
    throw new Error(`unexpected request ${method} ${url}`);
  });
  return world;
}

// ── mounting ──

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Opens `url` (the address bar) and renders `Component` inside the providers it needs. */
export function mount(url: string, Component: ComponentType) {
  window.history.replaceState(null, "", url);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, staleTime: Infinity, gcTime: Infinity } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(Component))));
  return { client, host };
}

export function unmount() {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
}

export function installBrowserStubs() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// ── DOM helpers ──

export const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
export const all = (id: string) => [...document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
export const css = (selector: string) => document.body.querySelector<HTMLElement>(selector);
export const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
export const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the page shows: ${text(document.body).slice(0, 600)}`);
  return el;
};
export const click = (el: Element | null | undefined) => {
  if (!el) throw new Error("click: no element");
  return act(() => {
    (el as HTMLElement).click();
  });
};
export const clickId = (id: string) => click(must(id));
export const typeInto = (input: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(() => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
export const typeAt = (selector: string, value: string) => typeInto(css(selector) as HTMLInputElement, value);
export const choose = (selector: string, value: string) =>
  act(() => {
    const select = css(selector) as HTMLSelectElement;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
export const press = (el: Element, key: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
export const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** Keeps the page turning (inside act) until `check` holds. */
export async function waitFor(check: () => boolean, what: string, timeoutMs = 4000) {
  const t0 = performance.now();
  while (!check()) {
    if (performance.now() - t0 > timeoutMs)
      throw new Error(`timed out waiting for ${what}: ${text(document.body).slice(0, 500)}`);
    await settle(8);
  }
}

export const buttonNamed = (name: string | RegExp): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    typeof name === "string" ? text(b) === name : name.test(text(b)),
  );

export const here = () => `${window.location.pathname}${window.location.search}`;
export const params = () => Object.fromEntries(new URLSearchParams(window.location.search));
