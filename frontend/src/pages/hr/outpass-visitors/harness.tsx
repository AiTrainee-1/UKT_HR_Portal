import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi, type Mock } from "vitest";
import type {
  GateSummary,
  OutpassRecordRow,
  OutpassRequestItem,
  PaginatedRecords,
  TeaBreakRecord,
  VisitorRecordRow,
} from "@/lib/api-client/custom-hooks";
import OutpassVisitors from "../OutpassVisitors";

// Shared by the render test of Outpass / Visitors / Tea Break: a fake server behind `customFetch`, the page mounted at a real
// address, and the small DOM helpers the other render tests of the repo use. (The `vi.mock` calls stay in the test file:
// vitest only hoists them there.) The clock is October 14, 2026 (see `freezeClock`), a Wednesday.

export type Call = { method: string; url: string; body: Record<string, unknown> };

const NOW = "2026-10-14T06:00:00Z";
const iso = (day: string, time = "05:00:00") => `2026-10-${day}T${time}Z`;

const approval = (hr: boolean) =>
  ({
    workflow: "outpass",
    label: "Outpass",
    enabled: true,
    steps: [],
    currentStep: 0,
    waitingFor: hr ? ["hr"] : ["hod"],
    canAct: { hr, hod: !hr },
  }) as unknown as OutpassRequestItem["approval"];

const employee = (id: number, name: string, department = "Cutting") => ({
  id,
  employeeCode: `E${id}`,
  name,
  department,
  designation: null,
  photoUrl: null,
});

const request = (id: number, patch: Partial<OutpassRequestItem>): OutpassRequestItem => ({
  id,
  employeeId: id,
  destination: `Destination ${id}`,
  reason: `Reason ${id}`,
  status: "approved",
  source: "manual",
  createdAt: iso("14"),
  scanStatus: "not_applicable",
  employee: employee(id, `Employee ${id}`),
  ...patch,
});

/** Five requests: 1 waits for HR, 2 waits for a HOD (HR cannot act), 3 has exited (still out), 4 exited and returned on the
 *  10th (this month only), 5 was rejected. Today / this week hold 1, 2, 3, 5; this month holds all five. */
export const REQUESTS: OutpassRequestItem[] = [
  request(1, { status: "pending", approval: approval(true) }),
  request(2, { status: "pending", approval: approval(false) }),
  request(3, { scanStatus: "exited", exitedAt: iso("14", "05:30:00"), exitGateName: "Gate 1" }),
  request(4, {
    createdAt: iso("10"),
    scanStatus: "completed",
    exitedAt: iso("10", "05:00:00"),
    enteredAt: iso("10", "05:20:00"),
    exitGateName: "Gate 1",
    entryGateName: "Gate 1",
  }),
  request(5, { status: "rejected" }),
];

const qrRow = (id: number, name: string): OutpassRecordRow => ({
  id,
  employeeName: name,
  employeeCode: `Q${id}`,
  destination: `Bank ${id}`,
  branchName: "Main",
  submittedAt: iso("14"),
});

/** Gate QR submissions: today 2, this week 3, this month 5. */
export const QR_ROWS: Record<string, OutpassRecordRow[]> = {
  today: [qrRow(1, "Asha QR"), qrRow(2, "Babu QR")],
  week: [qrRow(1, "Asha QR"), qrRow(2, "Babu QR"), qrRow(3, "Chitra QR")],
  month: [1, 2, 3, 4, 5].map((n) => qrRow(n, `Person ${n} QR`)),
};

const visitorRow = (id: number, name: string): VisitorRecordRow => ({
  id,
  name,
  phone: `98765${id}`,
  aadhaar: null,
  aadhaarLast4: null,
  whyCame: null,
  whomToMeet: "Accounts",
  purpose: "Invoice",
  branchName: "Main",
  visitedAt: iso("14"),
  meetingEmployee: null,
  notifiedEmailAt: null,
  notifiedWhatsappAt: null,
});

export const VISITOR_ROWS: Record<string, VisitorRecordRow[]> = {
  today: [visitorRow(1, "Visitor One")],
  week: [visitorRow(1, "Visitor One"), visitorRow(2, "Visitor Two")],
  month: [visitorRow(1, "Visitor One"), visitorRow(2, "Visitor Two"), visitorRow(3, "Visitor Three")],
};

const teaRow = (id: number, remark: TeaBreakRecord["remark"], name: string): TeaBreakRecord => ({
  id,
  employee: { id, employeeCode: `T${id}`, name, department: "Sewing", photoUrl: null },
  outGateName: "Gate 1",
  outAt: iso("14", "04:00:00"),
  inGateName: "Gate 1",
  inAt: remark === "not_returned" ? null : iso("14", "04:15:00"),
  takenMinutes: remark === "overtime" ? 25 : 8,
  remark,
});

export const TEA_ROWS: TeaBreakRecord[] = [
  teaRow(1, "on_time", "Tea Ontime"),
  teaRow(2, "overtime", "Tea Overtime"),
  teaRow(3, "not_returned", "Tea Missing"),
];

export type World = {
  requests: OutpassRequestItem[];
  rule: { allowedMinutes: number; updatedAt: string };
  calls: Call[];
  /** Every `GET` of the page's lists, by path with its query string, in order. */
  gets: string[];
  unexpected: string[];
};

const page = <T,>(items: T[]): PaginatedRecords<T> => ({ items, total: items.length, page: 1, pageSize: 20 });
const summary: GateSummary = { today: 2, thisWeek: 3, thisMonth: 5 };
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Makes `fetch` answer like the server for everything these three pages ask for. */
export function installWorld(fetch: Mock): World {
  const world: World = {
    requests: copy(REQUESTS),
    rule: { allowedMinutes: 10, updatedAt: NOW },
    calls: [],
    gets: [],
    unexpected: [],
  };
  fetch.mockReset();
  fetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const [path, query = ""] = url.split("?");
    const qs = new URLSearchParams(query);
    const range = qs.get("range") ?? "today";
    if (method !== "GET") {
      world.calls.push({ method, url, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} });
    } else {
      world.gets.push(url);
    }
    const hrStatus = /^\/api\/outpass-requests\/(\d+)\/hr-status$/.exec(path);
    if (method === "PUT" && hrStatus) {
      const target = world.requests.find((r) => r.id === Number(hrStatus[1]))!;
      target.status = (JSON.parse(init!.body!) as { status: string }).status;
      target.approval = null;
      return copy(target);
    }
    if (method === "PUT" && path === "/api/tea-break/rule") {
      world.rule = {
        allowedMinutes: (JSON.parse(init!.body!) as { allowedMinutes: number }).allowedMinutes,
        updatedAt: NOW,
      };
      return copy(world.rule);
    }
    if (method !== "GET") {
      world.unexpected.push(`${method} ${url}`);
      throw new Error(`unexpected request ${method} ${url}`);
    }
    switch (path) {
      case "/api/outpass-requests":
        return copy(qs.get("status") ? world.requests.filter((r) => r.status === qs.get("status")) : world.requests);
      case "/api/outpass/qr":
      case "/api/visitor/qr":
        return { token: "tok", branchId: 1, branchName: "Main" };
      case "/api/outpass/summary":
      case "/api/visitor/summary":
      case "/api/tea-break/summary":
        return summary;
      case "/api/outpass/records":
        return page(QR_ROWS[range]);
      case "/api/visitor/records":
        return page(VISITOR_ROWS[range]);
      case "/api/tea-break/records": {
        const filter = qs.get("filter");
        return page(filter ? TEA_ROWS.filter((r) => r.remark === filter) : TEA_ROWS);
      }
      case "/api/tea-break/rule":
        return world.rule;
      case "/api/branches":
        return [{ id: 1, name: "Main" }];
      case "/api/gate-devices":
      case "/api/reception-devices":
        return [];
      case "/api/approval-summary":
        return {};
      default:
        world.unexpected.push(`GET ${url}`);
        throw new Error(`unexpected request GET ${url}`);
    }
  });
  return world;
}

// ── mounting ──

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Opens `url` (the address bar) and renders the Outpass / Visitors / Tea Break page. */
export function mountPage(url: string) {
  window.history.replaceState(null, "", url);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, staleTime: Infinity, gcTime: Infinity } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(OutpassVisitors))));
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

/** The clock: 14 October 2026, 11:30 in India. Only Date is faked; timers stay real. */
export function freezeClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
}

// ── DOM helpers ──

export const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
/** The element is there and has its rows (not the "Loading…" row). */
export const ready = (id: string) => {
  const el = document.body.querySelector(`[data-testid="${id}"]`);
  return !!el && !(el.textContent ?? "").includes("Loading…");
};
export const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
export const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the page shows: ${text(document.body).slice(0, 500)}`);
  return el;
};
export const click = (el: Element | null | undefined) =>
  act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
export const press = (el: Element, key: string) =>
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
export const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** Keeps the page turning (inside act) until `check` holds. */
export async function waitFor(check: () => boolean, what: string, timeoutMs = 4000) {
  // Date is faked: count real time with performance.now
  const t0 = performance.now();
  while (!check()) {
    if (performance.now() - t0 > timeoutMs)
      throw new Error(`timed out waiting for ${what}: ${text(document.body).slice(0, 400)}`);
    await settle(8);
  }
}

/** The tabs (role "tab") whose label starts with `name`: a pill of a strip, a range pill. */
export const tab = (name: string): HTMLElement =>
  [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => text(t).startsWith(name))!;

/** The labels (with their counts) of a strip of pill tabs, `<testId>` being the strip's wrapper (`outpass-subtabs`). */
export const pillLabels = (testId: string): string[] =>
  [...document.body.querySelectorAll(`[data-testid="${testId}"] [role="tab"]`)].map((t) =>
    text(t.querySelector(".ptab-label")),
  );

/** The labels (with their counts) of a strip of nested subtabs, `<testId>` being the strip's wrapper. */
export const nestedLabels = (testId: string): string[] =>
  [...document.body.querySelectorAll(`[data-testid="${testId}-strip"] [role="tab"]`)].map((t) => text(t));

/** One tab of a strip of nested subtabs, by its value. */
export const nestedTab = (testId: string, value: string): HTMLElement =>
  document.body.querySelector<HTMLElement>(`[data-testid="${testId}-${value}"]`)!;

export const here = () => `${window.location.pathname}${window.location.search}`;

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
