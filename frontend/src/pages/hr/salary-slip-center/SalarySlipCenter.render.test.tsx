import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BankCheck,
  SavedSlipSummary,
  SlipCenterEmployee,
  SlipResult,
} from "@/lib/api-client/custom-hooks/salary-slip-center";
import SalarySlipCenter from "../SalarySlipCenter";

// The Salary Slip page in jsdom against a fake /api/salary-slip-center server (the real hooks and fetch layer): the list,
// its tabs and badges, Generate in batches of 20 with progress, downloads that generate the missing slips first (and again
// on a 409), the bank check shown in the page before the bank file, Hold with a reason, the preview sheet, and a
// view-only login.

const h = vi.hoisted(() => ({
  toast: vi.fn(),
  saved: vi.fn(),
  user: { role: "hr", employeeId: null, isSuperAdmin: true } as Record<string, unknown>,
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/PageRefreshBar", () => ({ RefreshButton: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/lib/exportUtils", async (original) => ({
  ...(await original<typeof import("@/lib/exportUtils")>()),
  downloadBlob: (blob: Blob, name: string) => h.saved(blob, name),
}));
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

const slip = (net: number): SavedSlipSummary => ({
  slipNumber: "SSL/X/2026/11",
  generatedAt: "2026-11-20T10:42:11+05:30",
  generatedBy: "Admin",
  gross: net + 900,
  deductions: 900,
  net,
  paidDays: 25,
  options: { statutory: true, lateDeductions: true, advances: true },
  countedTo: "2026-11-20",
});

const emp = (id: number, over: Partial<SlipCenterEmployee> = {}): SlipCenterEmployee => ({
  id,
  code: String(30000 + id),
  name: `EMPLOYEE ${id}`,
  category: "staff",
  status: "active",
  departmentId: 3,
  department: "ACCOUNTS",
  designationId: 5,
  designation: "ACCOUNTANT",
  branchId: 1,
  unit: "Head Office",
  joinDate: "2024-01-10",
  isNewJoiner: false,
  onHold: false,
  holdReason: "",
  heldAt: null,
  heldBy: null,
  monthlySalary: 25000,
  salaryPerShift: null,
  payIssue: null,
  bankAccountMasked: "XXXXXX1234",
  bankIssue: null,
  slip: null,
  ...over,
});

const baseEmployees = (): SlipCenterEmployee[] => [
  emp(1, { name: "SURYA M", slip: slip(23100) }),
  emp(2, { name: "ARUN K" }),
  emp(3, { name: "MEENA R", onHold: true, holdReason: "Pending documents", slip: slip(18000) }),
  emp(4, { name: "NEW PERSON", isNewJoiner: true, joinDate: "2026-11-04" }),
  emp(5, { name: "OLD HAND", status: "inactive" }),
  emp(6, {
    name: "NO RATE",
    category: "production",
    departmentId: 9,
    department: "STITCHING",
    monthlySalary: null,
    payIssue: "No salary per shift on the profile",
  }),
  // 40 more active staff: 45 in Active
  ...Array.from({ length: 40 }, (_, i) => emp(100 + i)),
];

type Call = { method: string; path: string; params: URLSearchParams; body: Record<string, unknown> | undefined };

const server = {
  employees: [] as SlipCenterEmployee[],
  canEdit: true,
  calls: [] as Call[],
  /** Holds every Generate answer until released (to see the progress panel mid-run). */
  gate: null as Promise<void> | null,
  /** Answers the next slips download with a 409 for these ids. */
  conflictOnce: null as number[] | null,
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const file = (type: string, name: string) =>
  new Response(new Blob(["%PDF"], { type }), {
    status: 200,
    headers: { "content-type": type, "content-disposition": `attachment; filename="${name}"` },
  });

const result = (e: SlipCenterEmployee): SlipResult => ({
  employeeId: e.id,
  kind: e.category,
  slipNumber: e.slip?.slipNumber ?? null,
  employee: {
    code: e.code,
    name: e.name,
    department: e.department,
    designation: e.designation,
    unit: e.unit,
    joinDate: e.joinDate,
    status: e.status,
    category: e.category,
    bankName: "HDFC",
    bankAccountMasked: e.bankAccountMasked,
    ifsc: "HDFC0001234",
    pfNumber: null,
    esiNumber: null,
    uanNumber: null,
  },
  period: {
    month: 11,
    year: 2026,
    label: "November 2026",
    from: "2026-11-01",
    to: "2026-11-30",
    countedTo: "2026-11-20",
    inProgress: true,
  },
  rate: { monthlySalary: 25000, dailyRate: 925.93, companyDays: 27, salaryPerShift: null },
  days: [{ key: "paidDays", label: "Paid days", value: 25.5 }],
  earnings: [{ key: "basic", label: "Basic", amount: 12000 }],
  grossTotal: e.slip ? e.slip.gross : 24000,
  deductions: [{ key: "pf", label: "PF (12%)", amount: 600, note: "" }],
  deductionsTotal: 900,
  net: e.slip ? e.slip.net : 23100,
  netInWords: "TWENTY THREE THOUSAND ONE HUNDRED",
  calendar: [
    {
      date: "2026-11-02",
      day: "Mon",
      status: "present",
      shifts: 1,
      firstIn: "08:58",
      lastOut: "18:02",
      late: true,
      note: "",
    },
  ],
  notes: ["Counted up to 20 November 2026: the month is not over yet."],
  options: { statutory: true, lateDeductions: true, advances: true },
});

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw, "http://localhost");
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
  server.calls.push({ method, path: url.pathname, params: url.searchParams, body });
  const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).map(Number);
  const byId = (id: number) => server.employees.find((e) => e.id === id)!;

  switch (url.pathname) {
    case "/api/salary-slip-center/employees":
      return json({
        month: 11,
        year: 2026,
        periodLabel: "November 2026",
        monthStart: "2026-11-01",
        monthEnd: "2026-11-30",
        inProgress: true,
        canEdit: server.canEdit,
        defaultOptions: { statutory: true, lateDeductions: true, advances: true },
        employees: server.employees,
        departments: [
          { id: 3, name: "ACCOUNTS", category: "staff" },
          { id: 9, name: "STITCHING", category: "production" },
        ],
        designations: [{ id: 5, title: "ACCOUNTANT", category: "staff" }],
        units: [{ id: 1, name: "Head Office" }],
      });
    case "/api/salary-slip-center/generate": {
      if (server.gate) await server.gate;
      const generated: unknown[] = [];
      const skipped: unknown[] = [];
      for (const id of body!.employeeIds as number[]) {
        const e = byId(id);
        if (e.payIssue) {
          skipped.push({ employeeId: id, code: e.code, name: e.name, reason: e.payIssue });
        } else {
          e.slip = slip(20000);
          generated.push({ employeeId: id, slip: e.slip });
        }
      }
      return json({ generated, skipped });
    }
    case "/api/salary-slip-center/download/slips": {
      if (server.conflictOnce) {
        const missing = server.conflictOnce;
        server.conflictOnce = null;
        return json({ error: "Some employees have no saved slip yet.", missing }, 409);
      }
      const missing = ids.filter((id) => !byId(id).slip);
      if (missing.length > 0) return json({ error: "Some employees have no saved slip yet.", missing }, 409);
      return file("application/pdf", ids.length === 1 ? `Salary-Slip-${byId(ids[0]).code}.pdf` : "Salary-Slips.pdf");
    }
    case "/api/salary-slip-center/download/statement":
      return file(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Salary-Statement-November-2026.xlsx",
      );
    case "/api/salary-slip-center/bank-check": {
      const check: BankCheck = { included: [], total: 0, leftOut: [] };
      for (const id of ids) {
        const e = byId(id);
        if (e.onHold) check.leftOut.push({ employeeId: id, code: e.code, name: e.name, reason: "On hold" });
        else if (!e.slip)
          check.leftOut.push({ employeeId: id, code: e.code, name: e.name, reason: "Not generated yet" });
        else {
          check.included.push({ employeeId: id, code: e.code, name: e.name, amount: e.slip.net });
          check.total += e.slip.net;
        }
      }
      return json(check);
    }
    case "/api/salary-slip-center/download/bank-file":
      return file("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Bank-File-November-2026.xlsx");
    case "/api/salary-slip-center/hold": {
      const list = (body!.employeeIds as number[]).map(byId);
      for (const e of list) {
        e.onHold = body!.hold as boolean;
        e.holdReason = (body!.reason as string) ?? "";
      }
      return json({ updated: list.length, employees: [] });
    }
    case "/api/salary-slip-center/preview":
      return json({ result: result(byId(Number(url.searchParams.get("employeeId")))) });
    case "/api/salary-slip-center/slip": {
      const e = byId(Number(url.searchParams.get("employeeId")));
      return e.slip ? json({ result: result(e), slip: e.slip }) : json({ error: "Not generated" }, 404);
    }
    default:
      return json({ error: `no fake for ${url.pathname}` }, 500);
  }
}

// ── the page ─────────────────────────────────────────────────────────────────

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  server.employees = baseEmployees();
  server.canEdit = true;
  server.calls = [];
  server.gate = null;
  server.conflictOnce = null;
  h.user = { role: "hr", employeeId: null, isSuperAdmin: true };
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  window.history.replaceState(null, "", "/hr/salary-slip?month=11&year=2026");
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(SalarySlipCenter))));
  await waitFor(() => q("ssc-table") !== null || q("ssc-empty") !== null);
}

const q = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const must = (id: string): HTMLElement => {
  const el = q(id);
  if (!el) throw new Error(`no [data-testid="${id}"]; the page shows: ${text(document.body).slice(0, 600)}`);
  return el;
};
const click = (el: Element | null) => act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const press = (el: Element, key: string) =>
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
async function waitFor(check: () => boolean, label = "the condition") {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await settle(5);
  }
  throw new Error(`timed out waiting for ${label}; the page shows: ${text(document.body).slice(0, 600)}`);
}
const calls = (path: string, method = "GET") =>
  server.calls.filter((c) => c.path === `/api/salary-slip-center/${path}` && c.method === method);
const tick = (code: string) => click(must(`ssc-select-${code}`));
const openMenu = (id: string) => press(must(id), "Enter");

describe("the Salary Slip page", () => {
  it("lists the month's employees with overlapping tabs, badges, figures and the in-progress note", async () => {
    await mount();
    expect(text(must("ssc-tab-active"))).toBe("Active (45)");
    expect(text(must("ssc-tab-on_hold"))).toBe("On Hold (1)");
    expect(text(must("ssc-tab-new_joiners"))).toBe("New Joiners (1)");
    expect(text(must("ssc-tab-inactive"))).toBe("Inactive (1)");
    expect(text(must("ssc-tab-all"))).toBe("All (46)");
    // Active opens first: the inactive one is not listed, the held one is (with its badge)
    expect(q("ssc-row-30005")).toBeNull();
    expect(text(must("ssc-row-30003"))).toContain("HOLD");
    expect(text(must("ssc-row-30004"))).toContain("NEW");
    expect(text(must("ssc-row-30001"))).toContain("₹23,100");
    expect(text(must("ssc-row-30002"))).toContain("Not generated");
    expect(text(must("ssc-row-30006"))).toContain("No salary per shift on the profile");
    expect(text(must("ssc-kpi-generated"))).toContain("2 of 46");
    expect(text(must("ssc-in-progress"))).toContain("November 2026 is not over yet");
    expect(calls("employees")[0].params.get("month")).toBe("11");
  });

  it("keeps the tab in the address and shows only that tab's rows", async () => {
    await mount();
    click(must("ssc-tab-inactive").closest("button"));
    await waitFor(() => q("ssc-row-30005") !== null, "the inactive row");
    expect(q("ssc-row-30001")).toBeNull();
    expect(text(must("ssc-row-30005"))).toContain("INACTIVE");
    expect(window.location.search).toContain("tab=inactive");
  });

  it("generates the ticked employees in batches of 20 with progress, then refreshes the list", async () => {
    await mount();
    let release!: () => void;
    server.gate = new Promise<void>((resolve) => (release = resolve));
    click(must("ssc-select-all"));
    expect(text(must("ssc-selected-count"))).toBe("45 selected");
    expect(text(must("ssc-bulk-generate"))).toBe("Generate 45 slips");
    click(must("ssc-bulk-generate"));
    await waitFor(() => q("ssc-progress") !== null, "the progress panel");
    expect(text(must("ssc-progress-count"))).toBe("0 of 45");
    release();
    await waitFor(() => q("ssc-progress") === null, "the run to finish");

    const batches = calls("generate", "POST").map((c) => (c.body!.employeeIds as number[]).length);
    expect(batches).toEqual([20, 20, 5]);
    expect(calls("generate", "POST")[0].body!.options).toEqual({
      statutory: true,
      lateDeductions: true,
      advances: true,
    });
    // the production one with no rate was skipped and is named on the page
    expect(text(must("ssc-skipped"))).toContain("No salary per shift on the profile");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "44 slips generated for November 2026" }));
    expect(calls("employees").length).toBeGreaterThanOrEqual(2);
    await waitFor(() => text(q("ssc-row-30002")).includes("₹20,000"), "the refreshed row");
  });

  it("sends the deduction switches with Generate", async () => {
    await mount();
    click(must("ssc-opt-advances"));
    tick("30002");
    click(must("ssc-bulk-generate"));
    await waitFor(() => calls("generate", "POST").length === 1);
    expect(calls("generate", "POST")[0].body).toMatchObject({
      month: 11,
      year: 2026,
      employeeIds: [2],
      options: { statutory: true, lateDeductions: true, advances: false },
    });
  });

  it("generates the missing slips first, then downloads the saved ones", async () => {
    await mount();
    tick("30001");
    tick("30002");
    openMenu("ssc-bulk-slips");
    click(must("ssc-bulk-slips-double"));
    await waitFor(() => h.saved.mock.calls.length === 1, "the file");
    expect(calls("generate", "POST").map((c) => c.body!.employeeIds)).toEqual([[2]]);
    const download = calls("download/slips")[0];
    expect(download.params.get("ids")).toBe("1,2");
    expect(download.params.get("layout")).toBe("double");
    expect(h.saved.mock.calls[0][1]).toBe("Salary-Slips.pdf");
  });

  it("on a 409 with 'missing', generates those and tries the download once more", async () => {
    await mount();
    server.conflictOnce = [1];
    click(must("ssc-download-30001"));
    await waitFor(() => h.saved.mock.calls.length === 1, "the file");
    expect(calls("download/slips")).toHaveLength(2);
    expect(calls("generate", "POST").map((c) => c.body!.employeeIds)).toEqual([[1]]);
    expect(h.saved.mock.calls[0][1]).toBe("Salary-Slip-30001.pdf");
  });

  it("downloads the salary statement as Excel", async () => {
    await mount();
    tick("30001");
    openMenu("ssc-bulk-statement");
    click(must("ssc-bulk-statement-xlsx"));
    await waitFor(() => h.saved.mock.calls.length === 1, "the file");
    expect(calls("download/statement")[0].params.get("fmt")).toBe("xlsx");
    expect(calls("generate", "POST")).toHaveLength(0);
  });

  it("checks the bank details first and shows who is left out in the page, then downloads only the included", async () => {
    await mount();
    tick("30001");
    tick("30003");
    click(must("ssc-bulk-bank"));
    await waitFor(() => q("ssc-bank-review") !== null, "the bank check");
    expect(text(must("ssc-bank-included"))).toContain("1 employee will be paid by bank transfer");
    expect(text(must("ssc-bank-included"))).toContain("₹23,100.00");
    expect(text(must("ssc-bank-left-out"))).toContain("On hold (1)");
    expect(h.saved).not.toHaveBeenCalled();
    click(must("ssc-bank-confirm"));
    await waitFor(() => h.saved.mock.calls.length === 1, "the bank file");
    expect(calls("download/bank-file")[0].params.get("ids")).toBe("1");
    await waitFor(() => q("ssc-bank-review") === null, "the panel to close");
  });

  it("holds an employee with a reason, from the row", async () => {
    await mount();
    click(must("ssc-hold-30002"));
    const area = must("ssc-hold-reason") as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, "Pending documents");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click(must("ssc-hold-confirm"));
    await waitFor(() => calls("hold", "POST").length === 1);
    expect(calls("hold", "POST")[0].body).toEqual({
      month: 11,
      year: 2026,
      employeeIds: [2],
      hold: true,
      reason: "Pending documents",
    });
    await waitFor(() => text(q("ssc-tab-on_hold")) === "On Hold (2)", "the refreshed counts");
  });

  it("previews a slip that is not generated yet, live and labelled as such", async () => {
    await mount();
    click(must("ssc-preview-30002"));
    await waitFor(() => q("ssc-slip-view") !== null, "the slip");
    const preview = calls("preview")[0];
    expect(preview.params.get("employeeId")).toBe("2");
    expect(preview.params.get("late")).toBe("1");
    expect(text(must("ssc-preview"))).toContain("Live preview, not saved");
    expect(text(must("ssc-net"))).toContain("₹23,100");
    expect(text(must("ssc-counted-to"))).toContain("Counted up to 20 Nov 2026");
    expect(q("ssc-calendar")).not.toBeNull();
  });

  it("shows the saved slip when there is one", async () => {
    await mount();
    click(must("ssc-preview-30001"));
    await waitFor(() => q("ssc-slip-view") !== null, "the slip");
    expect(calls("slip")).toHaveLength(1);
    expect(calls("preview")).toHaveLength(0);
    expect(text(must("ssc-preview"))).toContain("Saved slip SSL/X/2026/11");
  });

  it("a view-only login can download saved slips but cannot generate or hold", async () => {
    h.user = { role: "hr", employeeId: null, permissions: { salary_slip_center: "view" } };
    server.canEdit = false;
    await mount();
    expect(q("ssc-hold-30002")).toBeNull();
    tick("30001");
    tick("30002");
    expect(q("ssc-bulk-generate")).toBeNull();
    openMenu("ssc-bulk-slips");
    click(must("ssc-bulk-slips-single"));
    await waitFor(() => h.saved.mock.calls.length === 1, "the file");
    expect(calls("generate", "POST")).toHaveLength(0);
    expect(calls("download/slips")[0].params.get("ids")).toBe("1");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "1 employee left out" }));
  });
});
