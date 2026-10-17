import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Mock } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type {
  SmsMessage,
  SmsMessageStatus,
  SmsOverview,
  SmsSettings,
  SmsTestResult,
} from "@/lib/api-client/custom-hooks";
import SmsControl from "../SmsControl";

// Shared by the render tests of SMS Control: a fake server behind `customFetch` (the overview, the settings with their stale
// guard, the messages with their filters, the test endpoint), the page mounted at a real address, and the small DOM helpers
// the other render tests of the repo use. (The `vi.mock` calls stay in the test file: vitest only hoists them there.)

export type Call = { method: string; url: string; body: Record<string, unknown> };

/** A refusal the way the server sends one: HTTP `status` and a JSON body. */
export const refusal = (status: number, body: Record<string, unknown>, method = "PUT", url = "/api/sms-control/x") =>
  new ApiError(new Response(JSON.stringify(body), { status }), body, { method, url });

const iso = (day: string, time = "05:30:00") => `2026-10-${day}T${time}Z`;

/** What the server says about the balance today: 2Factor offers no balance check this system can use. */
export const BALANCE_NOTE =
  "2Factor documents no balance check this system can use safely. Look at the balance in the 2Factor panel.";

export const OVERVIEW: SmsOverview = {
  provider: "twofactor",
  channel: "whatsapp",
  configured: true,
  sendingAllowed: true,
  sendingNote: "",
  env: { authKey: true, senderId: "UKTHRM", templateName: "UKT_HRMS_OTP", apiBase: "https://2factor.in/API/V1" },
  balance: { available: null, checkedAt: null, error: BALANCE_NOTE },
  today: { sent: 12, failed: 1, blocked: 0 },
  last7Days: [
    { date: "2026-10-08", sent: 4, failed: 0 },
    { date: "2026-10-09", sent: 9, failed: 1 },
    { date: "2026-10-10", sent: 0, failed: 0 },
    { date: "2026-10-11", sent: 2, failed: 0 },
    { date: "2026-10-12", sent: 14, failed: 2 },
    { date: "2026-10-13", sent: 7, failed: 0 },
    { date: "2026-10-14", sent: 12, failed: 1 },
  ],
  lastSentAt: iso("14"),
  limits: { hourlyCap: 100, dailyCap: 500, hourUsed: 12, dayUsed: 40 },
  circuit: { paused: false, until: null },
};

export const SETTINGS: SmsSettings = {
  otpChannel: "whatsapp",
  otpLoginEnabled: true,
  otpResetEnabled: true,
  otpActivateEnabled: true,
  otpExpiryMinutes: 5,
  resendCooldownSeconds: 60,
  maxRequestsPerHour: 5,
  maxAttemptsPerCode: 5,
  maxPerPhonePerHour: 5,
  hourlyCap: 100,
  dailyCap: 500,
  version: "v1",
  updatedAt: iso("13", "09:00:00"),
  updatedBy: "Asha HR",
  warnings: [],
};

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
  overview: SmsOverview;
  settings: SmsSettings;
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

/** Makes `fetch` answer like the SMS Control endpoints. The settings PUT enforces `expectedVersion` like the real one. */
export function installWorld(
  fetch: Mock,
  patch: { overview?: Partial<SmsOverview>; settings?: Partial<SmsSettings> } = {},
): World {
  const world: World = {
    overview: { ...copy(OVERVIEW), ...patch.overview },
    settings: { ...copy(SETTINGS), ...patch.settings },
    messages: copy(MESSAGES),
    testReply: { ok: true, message: "The test SMS was accepted by 2Factor." },
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
    if (method === "GET" && path === "/api/sms-control/settings") return copy(world.settings);
    if (method === "PUT" && path === "/api/sms-control/settings") {
      if (body.expectedVersion !== undefined && body.expectedVersion !== world.settings.version) {
        throw refusal(400, {
          error: "These settings were changed by someone else. Reload and try again.",
          code: "stale_settings",
        });
      }
      const { expectedVersion: _expected, ...rest } = body;
      void _expected;
      // the server refuses SMS while 2Factor is not set up
      const channel = rest.otpChannel ?? world.settings.otpChannel;
      if (channel === "sms" && world.settings.otpChannel !== "sms" && !world.overview.configured) {
        throw refusal(400, { error: "SMS cannot be selected while 2Factor is not configured." });
      }
      world.settings = {
        ...world.settings,
        ...(rest as Partial<SmsSettings>),
        version: `v${nextVersion++}`,
        updatedBy: "You",
        updatedAt: iso("14", "07:00:00"),
      };
      world.overview = { ...world.overview, channel: world.settings.otpChannel };
      return copy(world.settings);
    }
    if (method === "GET" && path === "/api/sms-control/messages") {
      const status = qs.get("status");
      const purpose = qs.get("purpose");
      const search = (qs.get("search") ?? "").toLowerCase();
      const from = qs.get("dateFrom");
      const to = qs.get("dateTo");
      const page = Number(qs.get("page") ?? 1);
      const pageSize = Number(qs.get("pageSize") ?? 25);
      const narrowed = world.messages.filter(
        (m) =>
          (!purpose || m.purpose === purpose) &&
          (!search || `${m.employeeName ?? ""} ${m.employeeCode ?? ""}`.toLowerCase().includes(search)) &&
          (!from || m.at.slice(0, 10) >= from) &&
          (!to || m.at.slice(0, 10) <= to),
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
