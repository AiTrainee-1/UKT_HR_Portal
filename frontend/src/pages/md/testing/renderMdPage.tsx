// A smoke-render harness for MD pages (vitest + jsdom). It mounts a page inside the real providers, answers every
// request from the fixtures you give it (nothing touches a network), waits for the page to settle and hands back the
// DOM, so a test can assert on what the MD would see and fail on a render crash.
//
//   const page = await renderMdPage(MdAttendance, {
//     "/api/md/attendance/summary": summaryFixture,                       // a path, matched ignoring the query string
//     "/api/md/attendance/trend": (params) => trendFixture(params.get("period")),
//     "/api/md/attendance/exceptions": { status: 500, body: { error: "boom" } },   // an error response
//   });
//   expect(page.text()).toContain("Attendance rate");
//   await page.click('[data-testid="period-last_7_days"]');                // interact, then it settles again
//   page.unmount();
//
// Requests the page makes that have no fixture fail the test with the URL listed (a silent 404 would hide a bug).

import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { vi } from "vitest";
import { AuthProvider } from "@/contexts/AuthContext";

/** What a fixture answers: any JSON value, or `{ status, body }` for a non-200 response. */
type Reply = string | number | boolean | null | object;
/** A fixture can compute its answer from the request (the query string, the init). Typed as a function so that an
 *  arrow function written inline gets its parameters typed (a bare `unknown` would swallow the signature). */
export type FixtureFn = (params: URLSearchParams, init?: RequestInit) => Reply;
export type Fixture = Reply | FixtureFn;
export type Fixtures = Record<string, Fixture>;

const isStatusReply = (value: unknown): value is { status: number; body: unknown } =>
  typeof value === "object" && value !== null && "status" in value && "body" in value;

/** What every MD page's shell asks for (sign-in, branding, who the MD is, the filter options). Override any of it. */
export const SHELL_FIXTURES: Fixtures = {
  "/api/auth/me": { role: "hr", employeeId: null, name: "Test MD", isMd: true, isSuperAdmin: false, permissions: {} },
  "/api/payroll-settings": { companyName: "UKTextiles", companyLogo: null },
  "/api/md/me": {
    id: 1,
    username: "md",
    name: "Test MD",
    assignedAt: null,
    serverTime: "2026-10-05T10:42:10",
    pages: [],
  },
  "/api/md/org": {
    branches: [
      { id: 1, name: "Unit 1", isHeadOffice: false, isActive: true },
      { id: 2, name: "Head Office", isHeadOffice: true, isActive: true },
    ],
    departments: [
      { id: 10, name: "Stitching", branchId: 1, branchName: "Unit 1", employees: 40 },
      { id: 11, name: "Cutting", branchId: 1, branchName: "Unit 1", employees: 25 },
      { id: 12, name: "Accounts", branchId: 2, branchName: "Head Office", employees: 6 },
    ],
  },
};

function installBrowserShims() {
  // jsdom has no layout engine: recharts' ResponsiveContainer and the sidebar's media query need these.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
  window.scrollTo = (() => {}) as typeof window.scrollTo;
}

export type RenderedPage = {
  container: HTMLElement;
  /** The visible text of the page. */
  text: () => string;
  /** Every path the page has requested so far, query string included. */
  requests: () => string[];
  /** Click an element (CSS selector), then wait for the page to settle. */
  click: (selector: string) => Promise<void>;
  /** Type into an input (CSS selector), then wait for the page to settle. */
  type: (selector: string, value: string) => Promise<void>;
  /** Let pending requests and renders finish. */
  settle: () => Promise<void>;
  unmount: () => void;
};

export async function renderMdPage(
  Page: ComponentType,
  fixtures: Fixtures,
  options: { path?: string } = {},
): Promise<RenderedPage> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installBrowserShims();
  try {
    localStorage.setItem("uk_textile_token", "test-token");
  } catch {
    // storage blocked: the sign-in fixture still answers
  }

  const table: Fixtures = { ...SHELL_FIXTURES, ...fixtures };
  const seen: string[] = [];
  const unmatched: string[] = [];

  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "http://localhost");
    seen.push(url.pathname + url.search);
    const fixture = table[url.pathname];
    if (fixture === undefined) {
      unmatched.push(url.pathname + url.search);
      return new Response(JSON.stringify({ error: `no fixture for ${url.pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const reply = typeof fixture === "function" ? fixture(url.searchParams, init) : fixture;
    const status = isStatusReply(reply) ? reply.status : 200;
    const body = isStatusReply(reply) ? reply.body : reply;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchStub);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const { hook } = memoryLocation({ path: options.path ?? "/md/dashboard", static: false });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  const settle = async () => {
    // Several rounds: a response renders, which can start the next request (a dependent query, a changed filter).
    for (let round = 0; round < 6; round++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
      });
    }
    if (unmatched.length > 0) {
      throw new Error(`The page requested paths that have no fixture:\n  ${[...new Set(unmatched)].join("\n  ")}`);
    }
  };

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Router hook={hook}>
            <Page />
          </Router>
        </AuthProvider>
      </QueryClientProvider>,
    );
  });
  await settle();

  const find = (selector: string): HTMLElement => {
    const el = container.querySelector<HTMLElement>(selector) ?? document.body.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`Nothing matches "${selector}". The page shows:\n${container.textContent}`);
    return el;
  };

  return {
    container,
    text: () => container.textContent ?? "",
    requests: () => [...seen],
    click: async (selector) => {
      await act(async () => {
        find(selector).click();
      });
      await settle();
    },
    type: async (selector, value) => {
      await act(async () => {
        const input = find(selector) as HTMLInputElement | HTMLTextAreaElement;
        const prototype =
          input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        // React tracks the value itself: set it through the native setter so the change event is noticed.
        Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
    },
    settle,
    unmount: () => {
      act(() => root.unmount());
      queryClient.clear();
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}
