import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Mock } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { SmsMessage, SmsMessageStatus, SmsTestResult } from "@/lib/api-client/custom-hooks";
import SmsControl from "../SmsControl";
import { shiftMonth, thisMonth } from "./logic";

// Shared by the render tests of SMS Control: a fake server behind `customFetch` that answers the way
// backend/api/sms_control_views.py does since 2026-11-20 (the overview with its status block, month, cost and alerts; the
// usage of a month; the settings with the stale guard, PATCH, the refused `otpChannel` and the refused switch-on while 2Factor
// is not set up; the messages with their filters; the test by employee code or by number), the page mounted at a real
// address, and the small DOM helpers the other render tests of the repo use. (The `vi.mock` calls stay in the test file:
// vitest only hoists them there.)

export type Call = { method: string; url: string; body: Record<string, unknown> };

/** A refusal the way the server sends one: HTTP `status` and a JSON body. */
export const refusal = (status: number, body: Record<string, unknown>, method = "PATCH", url = "/api/sms-control/x") =>
  new ApiError(new Response(JSON.stringify(body), { status }), body, { method, url });

const iso = (day: string, time = "05:30:00") => `2026-11-${day}T${time}Z`;

/** This month and the one before it, as the page sees them when the tests run. */
export const CURRENT = thisMonth();
export const PREVIOUS = shiftMonth(CURRENT, -1);

type Loose = Record<string, unknown>;

/** The overview of a server where SMS codes are on and working, with a budget most of the way used. */
export const OVERVIEW = {
  provider: "twofactor",
  configured: true,
  sendingAllowed: true,
  sendingNote: "This server is set up to send SMS.",
  otpEnabled: true,
  status: {
    configured: true,
    sendingAllowed: true,
    sendingAllowedNow: true,
    otpEnabled: true,
    available: true,
    purposes: { login: true, reset: true, activate: false },
    paused: false,
    pauseReason: null as string | null,
    devLock: { active: false, onlyToEmployees: [] as string[] },
  },
  env: { authKey: true, senderId: "UKTHRM", templateName: "UKT_HRMS_OTP", apiBase: "https://2factor.in/API/V1" },
  balance: { credits: 820, available: 820, checkedAt: iso("20"), error: null as string | null },
  today: { sent: 12, failed: 1, blocked: 0 },
  last7Days: [],
  lastSentAt: iso("20"),
  limits: { hourlyCap: 100, dailyCap: 500, hourUsed: 12, dayUsed: 40 },
  circuit: { paused: false, until: null as string | null },
  month: {
    month: "2026-11",
    requested: 260,
    sent: 240,
    failed: 12,
    blocked: 8,
    verified: 180,
    deliveryRate: 95.2,
    verifiedRate: 78.3,
  },
  cost: {
    perSms: 0.2,
    soFar: 48,
    projected: 72,
    budget: 60,
    budgetUsedPct: 80,
    projectedBudgetPct: 120,
    currency: "INR",
    isCurrentMonth: true,
  },
  alerts: [
    {
      level: "warning",
      code: "budget_projected",
      message: "At this pace the month ends at about ₹72.00, over the budget of ₹60.00.",
    },
  ] as Loose[] | undefined,
};

export type ServerOverview = typeof OVERVIEW;

/** The settings document as the server sends it. */
export const SETTINGS = {
  otpEnabled: true,
  otpLoginEnabled: true,
  otpResetEnabled: true,
  otpActivateEnabled: false,
  otpExpiryMinutes: 5,
  resendCooldownSeconds: 60,
  maxRequestsPerHour: 5,
  maxAttemptsPerCode: 5,
  maxPerPhonePerHour: 5,
  hourlyCap: 100,
  dailyCap: 500,
  pricePerSms: 0.2 as number,
  monthlyBudget: 60 as number | null,
  pricePerSmsDefault: 0.2,
  version: "v1",
  updatedAt: iso("13", "09:00:00") as string | null,
  updatedBy: "Asha HR" as string | null,
  warnings: [] as string[],
};

export type ServerSettings = typeof SETTINGS;

const day = (date: string, sent: number, failed = 0, blocked = 0, verified = 0) => ({
  date,
  sent,
  failed,
  blocked,
  verified,
});

/** The usage of a month: this month (to today) and the one before (whole). */
export function usageOf(month: string): Loose {
  const current = month === CURRENT;
  const days = current
    ? [day(`${month}-01`, 10, 1, 0, 8), day(`${month}-02`, 6, 0, 2, 5)]
    : [day(`${month}-05`, 30, 3, 1, 20), day(`${month}-06`, 20, 0, 0, 15)];
  const sum = (k: "sent" | "failed" | "blocked" | "verified") => days.reduce((n, d) => n + d[k], 0);
  const sent = sum("sent");
  return {
    month,
    days,
    totals: {
      requested: sent + sum("failed") + sum("blocked"),
      sent,
      failed: sum("failed"),
      blocked: sum("blocked"),
      verified: sum("verified"),
      deliveryRate: Math.round((sent / (sent + sum("failed"))) * 1000) / 10,
      verifiedRate: Math.round((sum("verified") / sent) * 1000) / 10,
    },
    byPurpose: {
      login: { sent: sent - 4, failed: sum("failed"), blocked: sum("blocked"), verified: sum("verified") - 2 },
      reset: { sent: 2, failed: 0, blocked: 0, verified: 2 },
      activate: { sent: 1, failed: 0, blocked: 0, verified: 0 },
      test: { sent: 1, failed: 0, blocked: 0, verified: 0 },
    },
    cost: {
      perSms: 0.2,
      soFar: Math.round(sent * 0.2 * 100) / 100,
      projected: current ? 99.5 : Math.round(sent * 0.2 * 100) / 100,
      budget: 60,
      budgetUsedPct: Math.round(((sent * 0.2) / 60) * 1000) / 10,
      currency: "INR",
      isCurrentMonth: current,
    },
    balance: { credits: 820, available: 820, checkedAt: iso("20"), error: null },
  };
}

const message = (id: number, patch: Partial<SmsMessage>): SmsMessage => ({
  id,
  at: iso("14", `0${id}:00:00`),
  employeeId: id,
  employeeName: `Employee ${id}`,
  employeeCode: `E${id}`,
  maskedPhone: `••••••${1000 + id}`,
  purpose: "login",
  status: "sent",
  error: "",
  providerMessageId: `MSG${id}`,
  ip: "10.0.0.1",
  ...patch,
});

/** Seven messages: 4 sent (one of them a test), 2 failed, 1 blocked; login x3, reset x1, activate x2, test x1. */
export const MESSAGES: SmsMessage[] = [
  message(1, { employeeName: "Asha Kumar", employeeCode: "E001" }),
  message(2, { purpose: "reset", employeeName: "Ravi Nair", employeeCode: "E002" }),
  message(3, {
    purpose: "activate",
    status: "failed",
    employeeName: "Meena Devi",
    employeeCode: "E003",
    error: "2Factor did not accept the number.",
    providerMessageId: "",
  }),
  message(4, { purpose: "test", employeeId: null, employeeName: "Test message", employeeCode: "", ip: "10.0.0.9" }),
  message(5, { status: "failed", error: "2Factor did not answer in time.", providerMessageId: "" }),
  message(6, {
    employeeId: null,
    employeeName: "",
    employeeCode: "",
    status: "blocked",
    error: "The hourly SMS limit was reached.",
    providerMessageId: "",
    purpose: "activate",
  }),
  message(7, { employeeName: "Kiran Raj", employeeCode: "E007" }),
];

export type World = {
  overview: ServerOverview;
  settings: ServerSettings;
  messages: SmsMessage[];
  testReply: SmsTestResult;
  /** The next request whose "METHOD /path" is a key here is answered with that error (once). */
  failNext: Record<string, Error>;
  /** Every request that changes anything, in order. */
  calls: Call[];
  /** Every GET, by path with its query string. */
  gets: string[];
  /** Somebody else saves: the stored version moves on, so the page's copy is stale. */
  saveElsewhere: () => void;
  unexpected: string[];
};

const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export type WorldPatch = {
  overview?: Partial<ServerOverview>;
  status?: Partial<ServerOverview["status"]>;
  settings?: Partial<ServerSettings>;
};

/** Makes `fetch` answer like the SMS Control endpoints. The settings save enforces `expectedVersion` like the real one. */
export function installWorld(fetch: Mock, patch: WorldPatch = {}): World {
  const base = copy(OVERVIEW);
  const world: World = {
    overview: { ...base, ...patch.overview, status: { ...base.status, ...patch.overview?.status, ...patch.status } },
    settings: { ...copy(SETTINGS), ...patch.settings },
    messages: copy(MESSAGES),
    testReply: { ok: true, message: "2Factor accepted the test code for ••••••3210." },
    failNext: {},
    calls: [],
    gets: [],
    saveElsewhere: () => {
      world.settings = {
        ...world.settings,
        version: `v${Number(world.settings.version.slice(1)) + 1}`,
        updatedBy: "Someone Else",
      };
    },
    unexpected: [],
  };
  let nextVersion = 100;
  fetch.mockReset();
  fetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const [path, query = ""] = url.split("?");
    const qs = new URLSearchParams(query);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (method === "GET") world.gets.push(url);
    else world.calls.push({ method, url, body });

    const failure = world.failNext[`${method} ${path}`];
    if (failure) {
      delete world.failNext[`${method} ${path}`];
      throw failure;
    }

    if (method === "GET" && path === "/api/sms-control/overview") return copy(world.overview);
    if (method === "GET" && path === "/api/sms-control/usage") return usageOf(qs.get("month") || CURRENT);
    if (method === "GET" && path === "/api/sms-control/settings") return copy(world.settings);
    if ((method === "PATCH" || method === "PUT") && path === "/api/sms-control/settings") {
      if ("otpChannel" in body) {
        throw refusal(400, { error: "SMS and WhatsApp codes are now switched on separately." });
      }
      if (body.expectedVersion !== undefined && body.expectedVersion !== world.settings.version) {
        throw refusal(400, {
          error: "These settings were changed by someone else. Reload and try again.",
          code: "stale_settings",
        });
      }
      const { expectedVersion: _expected, ...rest } = body;
      void _expected;
      // the server refuses switching SMS codes on while 2Factor is not set up
      if (rest.otpEnabled === true && !world.settings.otpEnabled && !world.overview.configured) {
        throw refusal(400, {
          error:
            "SMS codes cannot be switched on until 2Factor is configured on the server: missing: TWOFACTOR_API_KEY.",
        });
      }
      if (rest.pricePerSms === null) rest.pricePerSms = world.settings.pricePerSmsDefault;
      world.settings = {
        ...world.settings,
        ...(rest as Partial<ServerSettings>),
        version: `v${nextVersion++}`,
        updatedBy: "You",
        updatedAt: iso("20", "07:00:00"),
      };
      world.overview = {
        ...world.overview,
        otpEnabled: world.settings.otpEnabled,
        status: { ...world.overview.status, otpEnabled: world.settings.otpEnabled },
      };
      return copy(world.settings);
    }
    if (method === "GET" && path === "/api/sms-control/messages") {
      const status = qs.get("status");
      const purpose = qs.get("purpose");
      const search = (qs.get("search") ?? "").toLowerCase();
      const page = Number(qs.get("page") ?? 1);
      const pageSize = Number(qs.get("pageSize") ?? 25);
      const narrowed = world.messages.filter(
        (m) =>
          (!purpose || m.purpose === purpose) &&
          (!search || `${m.employeeName ?? ""} ${m.employeeCode ?? ""}`.toLowerCase().includes(search)),
      );
      const count = (s: SmsMessageStatus) => narrowed.filter((m) => m.status === s).length;
      const matching = narrowed.filter((m) => !status || m.status === status);
      return {
        items: copy(matching.slice((page - 1) * pageSize, page * pageSize)),
        total: matching.length,
        page,
        pageSize,
        statusCounts: { sent: count("sent"), failed: count("failed"), blocked: count("blocked") },
      };
    }
    if (method === "POST" && path === "/api/sms-control/test") return copy(world.testReply);

    world.unexpected.push(`${method} ${url}`);
    throw new Error(`unexpected request ${method} ${url}`);
  });
  return world;
}

// ── mounting ──

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Opens `url` (the address bar) and renders the SMS Control page. */
export function mountPage(url: string) {
  window.history.replaceState(null, "", url);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, staleTime: Infinity, gcTime: Infinity } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(SmsControl))));
  return { client, host };
}

export function unmountPage() {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
}

// ── DOM helpers ──

export const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
export const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
export const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the page shows: ${text(document.body).slice(0, 600)}`);
  return el;
};
export const click = (el: Element | null | undefined) =>
  act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
export const press = (el: Element, key: string) =>
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
export const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** Types into a controlled input the way a user does (React tracks the value itself: use the native setter). */
export function typeInto(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

/** Keeps the page turning (inside act) until `check` holds. */
export async function waitFor(check: () => boolean, what: string, timeoutMs = 4000) {
  const t0 = performance.now();
  while (!check()) {
    if (performance.now() - t0 > timeoutMs) {
      throw new Error(`timed out waiting for ${what}: ${text(document.body).slice(0, 500)}`);
    }
    await settle(8);
  }
}

/** The tab (role "tab") whose label starts with `name`: a pill of the row, a status pill. */
export const tab = (name: string): HTMLElement =>
  [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => text(t).startsWith(name))!;

/** The labels of the first-level tabs. */
export const pillLabels = (): string[] =>
  [...document.body.querySelectorAll('[data-testid="sms-subtabs"] [role="tab"]')].map((t) =>
    text(t.querySelector(".ptab-label")),
  );

/** The labels of the nested tabs of Settings. */
export const nestedLabels = (): string[] =>
  [...document.body.querySelectorAll('[data-testid="sms-settings-nested-strip"] [role="tab"]')].map((t) => text(t));

export const nestedTab = (value: string): HTMLElement => must(`sms-settings-nested-${value}`);

export const here = () => `${window.location.pathname}${window.location.search}`;
export const pathname = () => window.location.pathname;

export const button = (name: string | RegExp): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    typeof name === "string" ? text(b) === name : name.test(text(b)),
  );

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
}
