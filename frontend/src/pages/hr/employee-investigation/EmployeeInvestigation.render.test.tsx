import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InvestigationDecision,
  InvestigationHistoryItem,
  InvestigationRow,
} from "@/lib/api-client/custom-hooks/employee-investigation";
import EmployeeInvestigation from "../EmployeeInvestigation";

// The Investigation page in jsdom against a fake /api/employee-investigation server (the real hooks and fetch layer): the
// tabs with their counts and the address, the kind and search filters, the rows' words (never attended, no-data days,
// approved leave, Auto tonight, why not), Mark inactive / Keep active behind a required reason with the server's refusals
// and errors on the page, the Auto Trigger's switch (confirmed; locked for a unit login), Tonight, History with Make active
// again, the Leave details sheet, and a view-only login.

const h = vi.hoisted(() => ({
  toast: vi.fn(),
  user: { role: "hr", employeeId: null, isSuperAdmin: true } as Record<string, unknown>,
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ user: h.user }),
}));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

// ── the fake server ──────────────────────────────────────────────────────────

const kept = (spellStart: string): InvestigationDecision => ({
  id: 70,
  action: "kept_active",
  actionLabel: "Kept active",
  reason: "Medical leave, papers on the way",
  by: "Priya",
  at: "2026-11-20T10:00:00+05:30",
  bucket: "30",
  spellStart,
  lastAttended: "2026-10-09",
  absentDays: 40,
});

const emp = (id: number, over: Partial<InvestigationRow> = {}): InvestigationRow => ({
  id,
  code: String(30000 + id),
  name: `EMPLOYEE ${id}`,
  kind: "staff",
  status: "active",
  departmentId: 3,
  department: "ACCOUNTS",
  designation: "ACCOUNTANT",
  branchId: 1,
  unit: "Head Office",
  phone: "98765000" + String(id).padStart(2, "0"),
  joinDate: "2024-01-10",
  lastAttended: "2026-10-09",
  awayFrom: "2026-10-10",
  calendarDays: 44,
  absentDays: 42,
  noDataDays: 0,
  workingDays: 33,
  leaveDays: 0,
  coveredByLeave: false,
  neverAttended: false,
  bucket: "30",
  decision: null,
  keptActive: false,
  autoTonight: false,
  autoWhyNot: null,
  ...over,
});

const startRows = (): InvestigationRow[] => [
  emp(11, {
    name: "ARUN K",
    bucket: "15",
    absentDays: 20,
    calendarDays: 22,
    noDataDays: 2,
    awayFrom: "2026-11-01",
    lastAttended: "2026-10-31",
    workingDays: 17,
    leaveDays: 1.5,
    autoWhyNot: "Away 20 days: the Auto Trigger acts after more than 30.",
  }),
  emp(12, {
    name: "NEVER CAME",
    kind: "production",
    department: "STITCHING",
    unit: "Unit 2",
    branchId: 2,
    bucket: "15",
    absentDays: 17,
    calendarDays: 17,
    neverAttended: true,
    lastAttended: null,
    joinDate: "2026-11-06",
    awayFrom: "2026-11-06",
    autoWhyNot: "Away 17 days: the Auto Trigger acts after more than 30.",
  }),
  emp(21, { name: "MEENA R", autoTonight: true }),
  emp(22, {
    name: "ON LEAVE",
    coveredByLeave: true,
    leaveDays: 33,
    workingDays: 33,
    autoWhyNot: "Every working day away is approved leave: listed, never inactivated automatically.",
  }),
  emp(23, {
    name: "KEPT ONE",
    keptActive: true,
    decision: kept("2026-10-10"),
    autoWhyNot: "Kept active by Priya: Medical leave, papers on the way",
  }),
];

const startHistory = (): InvestigationHistoryItem[] => [
  {
    id: 91,
    action: "auto_inactivated",
    actionLabel: "Inactivated by the Auto Trigger",
    reason:
      "Away 45 days in a row (last attended 01 Oct 2026): more than 30 days, not kept active, not approved leave.",
    by: "Auto Trigger",
    at: "2026-11-15T01:00:00+05:30",
    bucket: "auto",
    spellStart: "2026-10-02",
    lastAttended: "2026-10-01",
    absentDays: 45,
    employee: {
      id: 31,
      code: "30031",
      name: "GONE AWAY",
      kind: "staff",
      department: "ACCOUNTS",
      unit: "Head Office",
      status: "inactive",
    },
    calendarDays: 46,
    since: null,
  },
  {
    id: 92,
    action: "auto_inactivated",
    actionLabel: "Inactivated by the Auto Trigger",
    reason: "Away 33 days in a row.",
    by: "Auto Trigger",
    at: "2026-11-10T01:00:00+05:30",
    bucket: "auto",
    spellStart: "2026-10-05",
    lastAttended: "2026-10-04",
    absentDays: 33,
    employee: {
      id: 32,
      code: "30032",
      name: "BACK AGAIN",
      kind: "production",
      department: "STITCHING",
      unit: "Unit 2",
      status: "active",
    },
    calendarDays: 34,
    since: {
      id: 95,
      action: "reactivated",
      actionLabel: "Made active again",
      reason: "Came back with a medical note",
      by: "Priya",
      at: "2026-11-11T09:30:00+05:30",
      bucket: "auto",
      spellStart: "2026-10-05",
      lastAttended: "2026-10-04",
      absentDays: 34,
    },
  },
];

type Call = { method: string; path: string; params: URLSearchParams; body: Record<string, unknown> | undefined };

const server = {
  rows: [] as InvestigationRow[],
  history: [] as InvestigationHistoryItem[],
  autoEnabled: true,
  canChange: true,
  lastRun: {} as Record<string, unknown>,
  calls: [] as Call[],
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const settingsJson = () => ({
  autoEnabled: server.autoEnabled,
  autoDays: 30,
  runAt: "01:00",
  lastRunAt: server.lastRun.at,
  lastRun: server.lastRun,
  canChange: server.canChange,
  rules: { list15: 15, list30: 30, gapShare: 10 },
});

const ofKind = (kind: string) =>
  server.rows.filter((r) => r.status === "active" && (kind === "all" || r.kind === kind));
const countsOf = (rows: InvestigationRow[]) => ({
  d15: rows.filter((r) => r.bucket === "15").length,
  d30: rows.filter((r) => r.bucket === "30").length,
  tonight: rows.filter((r) => r.autoTonight).length,
});
const who = (r: { id: number; code: string; name: string }) => ({
  employeeId: r.id,
  employeeCode: r.code,
  name: r.name,
});

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw, "http://localhost");
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  server.calls.push({ method, path: url.pathname, params: url.searchParams, body });
  const kind = url.searchParams.get("kind") ?? "all";
  const ids = (body?.employeeIds as number[] | undefined) ?? [];
  const reason = String(body?.reason ?? "").trim();

  switch (url.pathname) {
    case "/api/employee-investigation/list": {
      const rows = ofKind(kind);
      const bucket = url.searchParams.get("bucket");
      return json({
        bucket,
        kind,
        asOf: "2026-11-22",
        counts: countsOf(rows),
        settings: settingsJson(),
        employees: rows.filter((r) => r.bucket === bucket),
      });
    }
    case "/api/employee-investigation/auto":
      return json({
        kind,
        settings: settingsJson(),
        tonight: ofKind(kind).filter((r) => r.autoTonight),
        history: server.history.filter((x) => kind === "all" || x.employee.kind === kind),
      });
    case "/api/employee-investigation/detail": {
      const id = Number(url.searchParams.get("employeeId"));
      const r = server.rows.find((x) => x.id === id)!;
      return json({
        employee: r,
        decisions: r.decision ? [r.decision] : [],
        calendarFrom: "2026-10-30",
        calendar: [
          { date: "2026-10-30", kind: "absent", holiday: null },
          { date: "2026-10-31", kind: "no_data", holiday: null },
          { date: "2026-11-01", kind: "sunday", holiday: null },
          { date: "2026-11-02", kind: "leave_pending", holiday: null },
          { date: "2026-11-03", kind: "holiday", holiday: "Diwali" },
          { date: "2026-11-04", kind: "leave", holiday: null },
        ],
        leaves: [
          {
            id: 1,
            type: "Medical",
            from: "2026-11-02",
            to: "2026-11-02",
            days: 1,
            halfDay: false,
            status: "pending",
            reason: "Fever",
            decidedBy: null,
          },
          {
            id: 2,
            type: "Sick",
            from: "2026-11-04",
            to: "2026-11-04",
            days: 1,
            halfDay: false,
            status: "approved",
            reason: null,
            decidedBy: "Priya",
          },
        ],
        casualLeaves: [{ id: 5, date: "2026-11-04", portion: "full", status: "approved", reason: "Personal work" }],
        punches: [{ date: "2026-10-09", time: "18:02", source: "device" }],
      });
    }
    case "/api/employee-investigation/inactivate": {
      if (reason.length < 3) return json({ error: "Write a reason of 3 to 500 characters." }, 400);
      const done: unknown[] = [];
      const refused: unknown[] = [];
      for (const id of ids) {
        const r = server.rows.find((x) => x.id === id)!;
        if (id === 22) {
          refused.push({ ...who(r), reason: "Changed by someone else just now: refresh." });
          continue;
        }
        r.status = "inactive";
        done.push({ ...who(r), absentDays: r.absentDays });
      }
      return json({ done, refused });
    }
    case "/api/employee-investigation/keep-active": {
      if (reason === "server says no") return json({ error: "You may only view this page." }, 403);
      const done = ids.map((id) => {
        const r = server.rows.find((x) => x.id === id)!;
        r.keptActive = true;
        r.autoTonight = false;
        r.decision = { ...kept(r.awayFrom!), by: "Admin", reason };
        return { ...who(r), absentDays: r.absentDays };
      });
      return json({ done, refused: [] });
    }
    case "/api/employee-investigation/reactivate": {
      const done = ids.map((id) => {
        const item = server.history.find((x) => x.employee.id === id)!;
        item.employee.status = "active";
        item.since = {
          ...kept("2026-10-02"),
          id: 99,
          action: "reactivated",
          actionLabel: "Made active again",
          by: "Admin",
          reason,
        };
        return { ...who(item.employee), absentDays: item.absentDays };
      });
      return json({ done, refused: [] });
    }
    case "/api/employee-investigation/run-now": {
      if (!server.canChange) {
        return json(
          { error: "The Auto Trigger runs for the whole company: only a login for all units can run it." },
          403,
        );
      }
      // the nightly rules, at once, whatever the switch says, for every kind
      const due = server.rows.filter((r) => r.status === "active" && r.autoTonight);
      for (const r of due) {
        r.status = "inactive";
        server.history.unshift({
          id: 100 + r.id,
          action: "auto_inactivated",
          actionLabel: "Inactivated by the Auto Trigger",
          reason: `Away ${r.absentDays} days in a row: more than 30 days, not kept active, not approved leave.`,
          by: "Auto Trigger (Run now by Admin)",
          at: "2026-11-23T15:30:00+05:30",
          bucket: "auto",
          spellStart: r.awayFrom,
          lastAttended: r.lastAttended,
          absentDays: r.absentDays,
          employee: {
            id: r.id,
            code: r.code,
            name: r.name,
            kind: r.kind,
            department: r.department,
            unit: r.unit,
            status: "inactive",
          },
          calendarDays: r.calendarDays,
          since: null,
        });
      }
      server.lastRun = {
        ran: true,
        at: "2026-11-23T15:30:00+05:30",
        day: "2026-11-23",
        inactivated: due.length,
        employeeIds: due.map((r) => r.id),
        runBy: "Admin",
      };
      return json({ summary: server.lastRun, settings: settingsJson() });
    }
    case "/api/employee-investigation/settings":
      if (!server.canChange) {
        return json(
          { error: "The Auto Trigger is one company-wide switch: only a login for all units can change it." },
          403,
        );
      }
      server.autoEnabled = Boolean(body?.autoEnabled);
      return json(settingsJson());
    default:
      return json({ error: `no fake for ${url.pathname}` }, 500);
  }
}

// ── the page ─────────────────────────────────────────────────────────────────

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  server.rows = startRows();
  server.history = startHistory();
  server.autoEnabled = true;
  server.canChange = true;
  server.lastRun = {
    ran: true,
    at: "2026-11-23T01:00:00+05:30",
    day: "2026-11-23",
    inactivated: 2,
    employeeIds: [31, 33],
    runBy: "nightly",
  };
  server.calls = [];
  h.user = { role: "hr", employeeId: null, isSuperAdmin: true };
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  window.history.replaceState(null, "", "/hr/employees/investigation");
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the page shows: ${text(document.body).slice(0, 700)}`);
  return el;
};
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
async function waitFor(check: () => boolean, label = "the condition") {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await settle(5);
  }
  throw new Error(`timed out waiting for ${label}; the page shows: ${text(document.body).slice(0, 700)}`);
}
const calls = (path: string, method = "GET") =>
  server.calls.filter((c) => c.path === `/api/employee-investigation/${path}` && c.method === method);
const isDisabled = (id: string) => (must(id) as HTMLButtonElement).disabled;
const tab = (t: string) => click(must(`inv-tab-${t}`).closest("button"));
function type(el: HTMLElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mount(waitForId = "inv-table") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(EmployeeInvestigation))));
  await waitFor(() => q(waitForId) !== null || q("inv-empty") !== null, waitForId);
}

describe("the Investigation page", () => {
  it("opens on 15 Days with the tabs' counts and the rows' words", async () => {
    await mount();
    expect(calls("list")[0].params.get("bucket")).toBe("15");
    expect(calls("list")[0].params.get("kind")).toBe("all");
    expect(text(must("inv-tab-15"))).toBe("15 Days (2)");
    expect(text(must("inv-tab-30"))).toBe("30 Days (3)");
    expect(text(must("inv-tab-auto"))).toBe("Auto Trigger (1)");
    expect(text(must("inv-subtitle"))).toContain("counted in calendar days up to yesterday (22 Nov 2026)");
    expect(must("inv-back").getAttribute("href")).toBe("/hr/employees");

    const arun = must("inv-row-30011");
    expect(text(arun)).toContain("ARUN K");
    expect(text(arun)).toContain("Staff");
    expect(text(arun)).toContain("ACCOUNTS · ACCOUNTANT");
    expect(text(arun)).toContain("9876500011");
    expect(text(arun)).toContain("31 Oct 2026");
    expect(text(must("inv-away-30011"))).toBe("20 days");
    expect(text(must("inv-nodata-30011"))).toBe("2 no-data days left out");
    // the explanation is the accessible name (a tap or hover shows it too)
    expect(must("inv-nodata-30011").getAttribute("aria-label")).toContain("punches did not arrive");
    expect(text(arun)).toContain("1.5 days of 17 working days");
    // the 15 Days list does not repeat "the Auto Trigger acts after more than 30"
    expect(q("inv-whynot-30011")).toBeNull();

    const never = must("inv-row-30012");
    expect(text(never)).toContain("Production");
    expect(text(never)).toContain("Never attended");
    expect(text(never)).toContain("Counted from the join date (6 Nov 2026)");
    expect(q("inv-nodata-30012")).toBeNull();
    // two units listed: the unit filter is offered
    expect(q("inv-unit")).not.toBeNull();
  });

  it("opens 30 Days from the address with Auto tonight, approved leave, kept active and why not", async () => {
    window.history.replaceState(null, "", "/hr/employees/investigation?tab=30");
    await mount();
    expect(calls("list")[0].params.get("bucket")).toBe("30");
    expect(text(must("inv-auto-30021"))).toBe("Auto tonight");
    expect(text(must("inv-banner-tonight"))).toContain(
      "1 employee would be marked inactive by the Auto Trigger tonight at 01:00",
    );
    expect(text(must("inv-row-30022"))).toContain("On approved leave");
    expect(text(must("inv-whynot-30022"))).toContain("Every working day away is approved leave");
    expect(text(must("inv-decision-30023"))).toContain("Kept active by Priya: Medical leave, papers on the way");
    expect(text(must("inv-decision-30023"))).toContain("Kept active");
    expect(q("inv-whynot-30023")).toBeNull();

    tab("15");
    await waitFor(() => q("inv-row-30011") !== null, "the 15 Days list");
    expect(window.location.search).toBe("");
    tab("30");
    expect(window.location.search).toBe("?tab=30");
  });

  it("asks the server for one kind, and searches in the page", async () => {
    await mount();
    click(must("inv-kind-production"));
    await waitFor(() => q("inv-row-30012") !== null && q("inv-row-30011") === null, "the production list");
    expect(calls("list").at(-1)!.params.get("kind")).toBe("production");
    expect(window.location.search).toBe("?kind=production");
    expect(q("inv-row-30012")).not.toBeNull();
    expect(text(must("inv-tab-15"))).toBe("15 Days (1)");

    click(must("inv-kind-all"));
    await waitFor(() => q("inv-row-30011") !== null, "everyone again");
    type(must("inv-search"), "arun");
    await waitFor(() => q("inv-row-30012") === null, "the search");
    expect(text(must("inv-showing"))).toBe("Showing 1-1 of 1");
    type(must("inv-search"), "nobody");
    await waitFor(() => q("inv-empty") !== null, "no match");
    expect(text(must("inv-empty"))).toContain("No employee matches these filters");
    click(must("inv-clear-filters"));
    await waitFor(() => q("inv-row-30012") !== null, "the cleared filters");
  });

  it("marks ticked employees inactive only with a reason, and lists who the server refused", async () => {
    window.history.replaceState(null, "", "/hr/employees/investigation?tab=30");
    await mount();
    click(must("inv-select-30021"));
    click(must("inv-select-30022"));
    expect(text(must("inv-selected-count"))).toBe("2 selected");
    click(must("inv-bulk-inactivate"));
    const dialog = must("inv-decision-dialog");
    expect(text(must("inv-decision-title"))).toBe("Mark 2 employees inactive?");
    expect(text(must("inv-decision-names"))).toBe("MEENA R and ON LEAVE");
    expect(text(dialog)).toContain("same as the Active / Inactive switch");
    expect(text(dialog)).toContain("move to the Inactive list");
    expect(text(dialog)).toContain("Only the employees the Auto Trigger marked inactive can be made active again");

    // no reason: nothing is sent
    click(must("inv-decision-confirm"));
    expect(text(must("inv-decision-help"))).toContain("Write a reason");
    expect(calls("inactivate", "POST")).toHaveLength(0);

    type(must("inv-decision-reason"), "  Not reachable by phone for six weeks  ");
    click(must("inv-decision-confirm"));
    await waitFor(() => calls("inactivate", "POST").length === 1, "the inactivate call");
    expect(calls("inactivate", "POST")[0].body).toEqual({
      employeeIds: [21, 22],
      reason: "Not reachable by phone for six weeks",
      bucket: "30",
    });
    await waitFor(() => q("inv-result") !== null, "the refusals");
    expect(text(must("inv-result-title"))).toBe("1 employee not marked inactive");
    expect(text(must("inv-result"))).toContain("Changed by someone else just now: refresh.");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "1 employee marked inactive" }));
    // the lists are read again: the inactive one drops out, the refused one stays ticked
    await waitFor(() => q("inv-row-30021") === null, "the refreshed list");
    expect(text(must("inv-selected-count"))).toBe("1 selected");
    expect(q("inv-decision-dialog")).toBeNull();
  });

  it("keeps one employee active from the 15 Days list, and shows the server's error in the dialog", async () => {
    await mount();
    click(must("inv-keep-30011"));
    expect(text(must("inv-decision-title"))).toBe("Keep ARUN K active?");
    expect(text(must("inv-decision-dialog"))).toContain("The Auto Trigger leaves them alone for this absence");
    expect(text(must("inv-decision-dialog"))).toContain("a later absence starts fresh");

    type(must("inv-decision-reason"), "server says no");
    click(must("inv-decision-confirm"));
    await waitFor(() => q("inv-decision-error") !== null, "the error");
    expect(text(must("inv-decision-error"))).toBe("You may only view this page.");
    expect(q("inv-decision-dialog")).not.toBeNull();

    type(must("inv-decision-reason"), "On leave for a family wedding");
    click(must("inv-decision-confirm"));
    await waitFor(() => calls("keep-active", "POST").length === 2, "the keep call");
    expect(calls("keep-active", "POST")[1].body).toEqual({
      employeeIds: [11],
      reason: "On leave for a family wedding",
      bucket: "15",
    });
    await waitFor(() => text(q("inv-decision-30011")).includes("Kept active by Admin"), "the refreshed row");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "1 employee kept active" }));
  });

  it("shows the Auto Trigger: its switch, last run, rule, Tonight and History", async () => {
    window.history.replaceState(null, "", "/hr/employees/investigation?tab=auto");
    await mount("inv-auto-status");
    expect(calls("auto")[0].params.get("kind")).toBe("all");
    const status = must("inv-auto-status");
    expect(text(status)).toContain("Runs every night at 01:00.");
    expect(text(must("inv-auto-last-run"))).toContain("2 employees marked inactive");
    expect(text(must("inv-auto-next"))).toContain("Tonight at 01:00: 1 employee would be marked inactive");
    expect(text(must("inv-auto-rule"))).toContain("more than 30 days");
    expect(text(must("inv-auto-exceptions"))).toContain("approved leave");
    expect(text(must("inv-auto-exceptions"))).toContain("no attendance ever recorded");
    expect(must("inv-auto-switch").getAttribute("aria-checked")).toBe("true");
    expect(isDisabled("inv-auto-switch")).toBe(false);

    // Tonight: Keep active and Mark inactive, with the reason dialog; decided on the Auto Trigger tab ("auto")
    expect(q("inv-tonight-row-30021")).not.toBeNull();
    expect(q("inv-tonight-inactivate-30021")).not.toBeNull();
    expect(q("inv-tonight-select-30021")).not.toBeNull();
    click(must("inv-tonight-keep-30021"));
    type(must("inv-decision-reason"), "Joining back on Monday");
    click(must("inv-decision-confirm"));
    await waitFor(() => calls("keep-active", "POST").length === 1, "the keep call");
    expect(calls("keep-active", "POST")[0].body).toEqual({
      employeeIds: [21],
      reason: "Joining back on Monday",
      bucket: "auto",
    });
    await waitFor(() => q("inv-tonight-empty") !== null, "the empty Tonight list");

    // History: Make active again only while still inactive; what happened since
    expect(text(must("inv-history-row-91"))).toContain("GONE AWAY");
    expect(text(must("inv-history-row-91"))).toContain("45 days");
    expect(text(must("inv-history-row-91"))).toContain("Inactive");
    expect(text(must("inv-history-by-91"))).toBe("by Auto Trigger");
    expect(q("inv-history-reactivate-92")).toBeNull();
    expect(text(must("inv-history-since-92"))).toBe(
      "Made active again by Priya on 11 Nov 2026: Came back with a medical note",
    );
    click(must("inv-history-reactivate-91"));
    expect(text(must("inv-decision-title"))).toBe("Make GONE AWAY active again?");
    type(must("inv-decision-reason"), "Came back after surgery");
    click(must("inv-decision-confirm"));
    await waitFor(() => calls("reactivate", "POST").length === 1, "the reactivate call");
    expect(calls("reactivate", "POST")[0].body).toEqual({ employeeIds: [31], reason: "Came back after surgery" });
    await waitFor(() => q("inv-history-since-91") !== null, "the refreshed history");
    expect(text(must("inv-history-since-91"))).toContain("Made active again by Admin");
    expect(q("inv-history-reactivate-91")).toBeNull();
  });

  it("switches the Auto Trigger off only after a confirm", async () => {
    window.history.replaceState(null, "", "/hr/employees/investigation?tab=auto");
    await mount("inv-auto-status");
    click(must("inv-auto-switch"));
    expect(text(must("inv-switch-dialog"))).toContain("Switch the Auto Trigger off?");
    expect(text(must("inv-switch-text"))).toContain("Nobody is marked inactive automatically");
    expect(calls("settings", "PUT")).toHaveLength(0);
    click(must("inv-switch-confirm"));
    await waitFor(() => calls("settings", "PUT").length === 1, "the switch call");
    expect(calls("settings", "PUT")[0].body).toEqual({ autoEnabled: false });
    await waitFor(() => must("inv-auto-switch").getAttribute("aria-checked") === "false", "the switch off");
    expect(text(must("inv-auto-next"))).toContain("Switched off");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Auto Trigger switched off" }));
    // the lists say so, and Auto tonight is no longer a warning
    tab("30");
    await waitFor(() => q("inv-row-30021") !== null, "the 30 Days list");
    expect(text(must("inv-banner-auto-off"))).toContain("switched off");
    expect(text(must("inv-auto-30021"))).toBe("Due for the Auto Trigger");
    expect(q("inv-banner-tonight")).toBeNull();
  });

  it("locks the switch for a login of one unit, and says why", async () => {
    server.canChange = false;
    h.user = { role: "hr", employeeId: null, isSuperAdmin: true, branchId: 2 };
    window.history.replaceState(null, "", "/hr/employees/investigation?tab=auto");
    await mount("inv-auto-status");
    expect(isDisabled("inv-auto-switch")).toBe(true);
    expect(text(must("inv-auto-blocked"))).toBe(
      "The Auto Trigger is one company-wide switch: only a login for all units can change it.",
    );
    click(must("inv-auto-switch"));
    expect(q("inv-switch-dialog")).toBeNull();
    // Run now is company-wide too: locked, with the reason
    expect(isDisabled("inv-run-now")).toBe(true);
    expect(text(must("inv-run-block"))).toBe(
      "The Auto Trigger runs for the whole company: only a login for all units can run it.",
    );
    click(must("inv-run-now"));
    expect(q("inv-run-dialog")).toBeNull();
    // the rest of the page still works for the unit
    expect(isDisabled("inv-tonight-keep-30021")).toBe(false);
  });

  it("runs the Auto Trigger now after a confirm that lists who it marks inactive", async () => {
    window.history.replaceState(null, "", "/hr/employees/investigation?tab=auto");
    await mount("inv-auto-status");
    expect(text(must("inv-auto-last-run"))).not.toContain("Run now");
    expect(isDisabled("inv-run-now")).toBe(false);
    click(must("inv-run-now"));
    expect(text(must("inv-run-title"))).toBe("Mark 1 employee inactive now?");
    expect(text(must("inv-run-text"))).toContain("same as tonight's 01:00 run, done now");
    expect(text(must("inv-run-text"))).toContain("made active again from the History");
    expect(text(must("inv-run-text"))).not.toContain("switched off");
    expect(q("inv-run-scope")).toBeNull();
    const items = [...document.body.querySelectorAll('[data-testid="inv-run-item"]')].map((li) => text(li));
    expect(items).toEqual(["MEENA R 30021 42 days away"]);
    expect(calls("run-now", "POST")).toHaveLength(0);

    click(must("inv-run-confirm"));
    await waitFor(() => calls("run-now", "POST").length === 1, "the run");
    expect(calls("run-now", "POST")[0].body).toBeUndefined();
    await waitFor(() => q("inv-run-dialog") === null, "the closed dialog");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "1 employee marked inactive" }));
    // everything is read again: Tonight is empty, the History has the run (by whom), the last run says who pressed it
    await waitFor(() => q("inv-tonight-empty") !== null, "the empty Tonight list");
    expect(text(must("inv-history-by-121"))).toBe("by Auto Trigger (Run now by Admin)");
    expect(text(must("inv-auto-last-run"))).toContain("(Run now by Admin): 1 employee marked inactive");
    expect(isDisabled("inv-run-now")).toBe(true);
    expect(text(must("inv-run-block"))).toBe("Nobody is due.");
    // the 15 / 30 Days lists and their counts are read again too
    await waitFor(() => text(q("inv-tab-30")) === "30 Days (2)", "the refreshed counts");
  });

  it("runs for everyone, even with one kind picked and the switch off, and says so", async () => {
    server.autoEnabled = false;
    window.history.replaceState(null, "", "/hr/employees/investigation?tab=auto&kind=production");
    await mount("inv-auto-status");
    // this tab's Tonight list (production) is empty, but the run would mark a staff employee inactive
    expect(q("inv-tonight-empty")).not.toBeNull();
    await waitFor(() => !isDisabled("inv-run-now"), "Run now");
    expect(calls("auto").some((c) => c.params.get("kind") === "all")).toBe(true);
    click(must("inv-run-now"));
    expect(text(must("inv-run-text"))).toContain("even though the Auto Trigger is switched off");
    expect(text(must("inv-run-scope"))).toContain("not only the production employees this tab is showing");
    expect(text(must("inv-run-list"))).toContain("MEENA R");
    click(must("inv-run-confirm"));
    await waitFor(() => calls("run-now", "POST").length === 1, "the run");
  });

  it("keeps Run now locked when nobody is due", async () => {
    server.rows.find((r) => r.id === 21)!.autoTonight = false;
    window.history.replaceState(null, "", "/hr/employees/investigation?tab=auto");
    await mount("inv-auto-status");
    expect(isDisabled("inv-run-now")).toBe(true);
    expect(text(must("inv-run-block"))).toBe("Nobody is due.");
  });

  it("marks ticked Tonight employees inactive by hand, decided on the Auto Trigger tab", async () => {
    server.rows.find((r) => r.id === 22)!.autoTonight = true;
    window.history.replaceState(null, "", "/hr/employees/investigation?tab=auto");
    await mount("inv-auto-status");
    click(must("inv-tonight-select-all"));
    expect(text(must("inv-selected-count"))).toBe("2 selected");
    click(must("inv-bulk-inactivate"));
    expect(text(must("inv-decision-title"))).toBe("Mark 2 employees inactive?");
    click(must("inv-decision-confirm"));
    expect(calls("inactivate", "POST")).toHaveLength(0);
    type(must("inv-decision-reason"), "Not reachable for six weeks");
    click(must("inv-decision-confirm"));
    await waitFor(() => calls("inactivate", "POST").length === 1, "the inactivate call");
    expect(calls("inactivate", "POST")[0].body).toEqual({
      employeeIds: [21, 22],
      reason: "Not reachable for six weeks",
      bucket: "auto",
    });
    await waitFor(() => q("inv-result") !== null, "the refusals");
    expect(text(must("inv-result"))).toContain("Changed by someone else just now: refresh.");
    await waitFor(() => q("inv-tonight-row-30021") === null, "the refreshed Tonight list");
    expect(text(must("inv-selected-count"))).toBe("1 selected");

    // one row's own Mark inactive sends "auto" too
    click(must("inv-tonight-inactivate-30022"));
    type(must("inv-decision-reason"), "Left without notice");
    click(must("inv-decision-confirm"));
    await waitFor(() => calls("inactivate", "POST").length === 2, "the second call");
    expect(calls("inactivate", "POST")[1].body).toEqual({
      employeeIds: [22],
      reason: "Left without notice",
      bucket: "auto",
    });
  });

  it("shows one employee's leave details in a sheet", async () => {
    window.history.replaceState(null, "", "/hr/employees/investigation?tab=30");
    await mount();
    click(must("inv-details-30021"));
    await waitFor(() => q("inv-detail-body") !== null, "the leave details");
    expect(calls("detail")[0].params.get("employeeId")).toBe("21");
    expect(text(must("inv-detail-figures"))).toContain("42 days");
    expect(text(must("inv-detail-figures"))).toContain("since 10 Oct 2026");
    expect(text(must("inv-detail-figures"))).toContain("0 days of 33 working days");
    expect(text(must("inv-detail-auto"))).toContain("Auto tonight");
    // the calendar, coloured by kind, the holiday by its name, the weeks Monday to Sunday
    expect(must("inv-day-2026-11-03").dataset.kind).toBe("holiday");
    expect(must("inv-day-2026-11-03").getAttribute("aria-label")).toBe("Tue, 3 Nov 2026: Holiday (Diwali)");
    expect(must("inv-day-2026-10-31").dataset.kind).toBe("no_data");
    expect(must("inv-day-2026-11-02").dataset.kind).toBe("leave_pending");
    expect(text(must("inv-legend-no_data"))).toBe("No data (unit's punches missing)(1)");
    expect(text(must("inv-legend-absent"))).toBe("Away(1)");
    // the requests with their status, the last punches and the decisions
    expect(text(must("inv-detail-leaves"))).toContain("Medical · 2 Nov 2026 (1 day)");
    expect(text(must("inv-detail-leaves"))).toContain("Pending");
    expect(text(must("inv-detail-leaves"))).toContain("Decided by Priya");
    expect(text(must("inv-detail-casual"))).toContain("Personal work");
    expect(text(must("inv-detail-punches"))).toContain("9 Oct 2026 18:02");
    expect(text(must("inv-detail-decisions"))).toContain("No decision about this employee yet");

    // Mark inactive from the sheet opens the same reason dialog, decided in the employee's own list
    click(must("inv-detail-inactivate"));
    type(must("inv-decision-reason"), "Left the company");
    click(must("inv-decision-confirm"));
    await waitFor(() => calls("inactivate", "POST").length === 1, "the inactivate call");
    expect(calls("inactivate", "POST")[0].body).toEqual({
      employeeIds: [21],
      reason: "Left the company",
      bucket: "30",
    });
  });

  it("a view-only login can look at everything but change nothing", async () => {
    h.user = { role: "hr", employeeId: null, permissions: { employees: "view" } };
    window.history.replaceState(null, "", "/hr/employees/investigation?tab=30");
    await mount();
    expect(isDisabled("inv-keep-30021")).toBe(true);
    expect(isDisabled("inv-inactivate-30021")).toBe(true);
    expect(must("inv-keep-30021").getAttribute("aria-label")).toContain("Needs edit rights");
    expect(isDisabled("inv-details-30021")).toBe(false);
    click(must("inv-select-30021"));
    expect(isDisabled("inv-bulk-keep")).toBe(true);
    expect(isDisabled("inv-bulk-inactivate")).toBe(true);

    tab("auto");
    await waitFor(() => q("inv-auto-status") !== null, "the Auto Trigger");
    expect(isDisabled("inv-auto-switch")).toBe(true);
    expect(text(must("inv-auto-blocked"))).toBe("Switching it needs edit rights on this page.");
    expect(isDisabled("inv-run-now")).toBe(true);
    expect(text(must("inv-run-block"))).toBe("Needs edit rights on this page.");
    expect(isDisabled("inv-tonight-inactivate-30021")).toBe(true);
    expect(isDisabled("inv-history-reactivate-91")).toBe(true);
    expect(server.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
