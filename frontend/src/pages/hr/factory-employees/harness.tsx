import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Mock } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { FactoryEmployee, FactoryHistoryItem, FactoryLabel } from "@/lib/api-client/custom-hooks";
import FactoryEmployees from "../FactoryEmployees";

// Shared by the render tests of Factory Employees: a fake server behind `customFetch` that answers the way
// backend/api/factory_employee_views.py does (2026-11-20: the list with its labels and counts, create, add / remove /
// label, the labels with the 409 of one in use, the history, the shifts with plan / apply / remove, and the payroll
// category and frequency with its 400 and 409), plus the employee record, its PATCH and status. The `vi.mock` calls stay
// in the test file: vitest only hoists them there.

export type Call = { method: string; url: string; body: Record<string, unknown> };

/** A refusal the way the server sends one: HTTP `status` and a JSON body. */
export const refusal = (status: number, body: Record<string, unknown>, method = "POST", url = "/api/x") =>
  new ApiError(new Response(JSON.stringify(body), { status }), body, { method, url });

type Cycle = "weekly" | "biweekly" | "monthly";

type Emp = {
  id: number;
  code: string;
  firstName: string;
  lastName: string;
  phone: string;
  employmentType: "staff" | "production";
  status: "active" | "inactive";
  isFactory: boolean;
  labelId: number | null;
  departmentId: number | null;
  branchId: number;
  joinDate: string | null;
  salaryAmount: number | null;
  salaryPerShift: number | null;
  productionPayCycle: Cycle | null;
  shiftId: number | null;
  /** The last day on the shift, once taken off. */
  shiftTo: string | null;
};

export const LABELS: FactoryLabel[] = [
  { id: 3, name: "Driver", color: "#2563eb", description: "Company vehicles", sortOrder: 1 },
  { id: 4, name: "Housekeeping", color: "#0d9488", description: "", sortOrder: 2 },
  { id: 5, name: "Chef", color: "#d97706", description: "", sortOrder: 3 },
];

export const SHIFTS = [
  {
    id: 2,
    name: "General",
    shiftType: "staff",
    startTime: "09:00",
    endTime: "18:00",
    graceMinutes: 10,
    genderRule: "all",
  },
  {
    id: 6,
    name: "Early",
    shiftType: "staff",
    startTime: "06:00",
    endTime: "14:00",
    graceMinutes: 10,
    genderRule: "all",
  },
  {
    id: 7,
    name: "Production Day",
    shiftType: "production",
    startTime: "08:00",
    endTime: "20:00",
    graceMinutes: 15,
    genderRule: "all",
  },
] as const;

const emp = (over: Partial<Emp> & Pick<Emp, "id" | "code" | "firstName">): Emp => ({
  lastName: "K",
  phone: "9876543210",
  employmentType: "staff",
  status: "active",
  isFactory: true,
  labelId: null,
  departmentId: null,
  branchId: 1,
  joinDate: "2025-04-01",
  salaryAmount: 18000,
  salaryPerShift: null,
  productionPayCycle: null,
  shiftId: null,
  shiftTo: null,
  ...over,
});

const EMPLOYEES: Emp[] = [
  // MURUGAN has a staff department (TRANSPORT, id 4): moving him to Production Payroll clears it
  emp({ id: 1, code: "F001", firstName: "MURUGAN", labelId: 3, departmentId: 4, shiftId: 2 }),
  emp({ id: 2, code: "F002", firstName: "LAKSHMI", lastName: "S", labelId: 4, salaryAmount: null }),
  emp({
    id: 3,
    code: "F003",
    firstName: "RAJA",
    lastName: "P",
    employmentType: "production",
    salaryAmount: null,
    salaryPerShift: 650,
  }),
  emp({ id: 4, code: "F004", firstName: "SELVI", lastName: "R", labelId: 3, status: "inactive", shiftId: 2 }),
  // an ordinary employee, not in Factory Employees: a candidate
  emp({ id: 20, code: "E020", firstName: "ANAND", lastName: "V", isFactory: false }),
];

export type World = {
  employees: Emp[];
  labels: FactoryLabel[];
  canEdit: boolean;
  history: Record<number, FactoryHistoryItem[]>;
  /** The next request whose "METHOD /path" is a key here is answered with that error (once). */
  failNext: Record<string, Error>;
  /** Every request that changes anything, in order. */
  calls: Call[];
  /** Every GET, by path with its query string. */
  gets: string[];
  unexpected: string[];
};

const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function issue(e: Emp): string | null {
  if (e.employmentType === "production") {
    if (!e.salaryPerShift) return "No salary per shift";
    if (!e.productionPayCycle) return "No pay cycle (in no Production Payroll yet)";
    return null;
  }
  return e.salaryAmount ? null : "No monthly salary";
}

const nameOf = (e: Emp) => `${e.firstName} ${e.lastName}`.trim();

function rowOf(world: World, e: Emp): FactoryEmployee {
  const label = world.labels.find((l) => l.id === e.labelId) ?? null;
  const shift = SHIFTS.find((s) => s.id === e.shiftId) ?? null;
  const problem = issue(e);
  return {
    id: e.id,
    code: e.code,
    name: nameOf(e),
    firstName: e.firstName,
    lastName: e.lastName,
    phone: e.phone,
    employmentType: e.employmentType,
    status: e.status,
    isFactory: e.isFactory,
    labelId: e.labelId,
    label: label?.name ?? null,
    labelColor: label?.color ?? null,
    departmentId: e.departmentId,
    department: e.departmentId ? "TRANSPORT" : "",
    designationId: null,
    designation: "",
    branchId: e.branchId,
    unit: "HO",
    joinDate: e.joinDate,
    salaryAmount: e.salaryAmount,
    salaryPerShift: e.salaryPerShift,
    productionPayCycle: e.productionPayCycle,
    shift: shift
      ? {
          assignmentId: 100 + e.id,
          shiftId: shift.id,
          name: shift.name,
          startTime: shift.startTime,
          endTime: shift.endTime,
          effectiveFrom: "2026-01-01",
          saturdayOff: false,
        }
      : null,
    payrollReady: problem === null,
    payrollIssue: problem,
  };
}

function recordOf(e: Emp) {
  const a = e.salaryAmount ? e.salaryAmount / 2 / 3 : 0;
  const b = e.salaryAmount ? e.salaryAmount / 2 / 5 : 0;
  return {
    id: e.id,
    employeeCode: e.code,
    firstName: e.firstName,
    lastName: e.lastName,
    phone: e.phone,
    employmentType: e.employmentType,
    departmentId: e.departmentId,
    branchId: e.branchId,
    salaryType: "monthly",
    salaryAmount: e.salaryAmount,
    salaryBreakup: e.salaryAmount
      ? {
          basic: a,
          da: a,
          retainingAllowance: a,
          otherAllowance: b,
          petrolAllowance: b,
          hra: b,
          specialAllowance: b,
          ca: b,
        }
      : null,
    salaryPerShift: e.salaryPerShift,
    status: e.status,
    joinDate: e.joinDate,
  };
}

/** What the shift planner would do (the real rules, shortened): new, unchanged, reassign or skipped. */
function planOf(world: World, body: Record<string, unknown>, applying: boolean) {
  const shift = SHIFTS.find((s) => s.id === body.shiftId);
  const ids = (body.employeeIds ?? []) as number[];
  const rows = ids.map((id) => {
    const e = world.employees.find((x) => x.id === id)!;
    const base = { employeeId: id, employeeCode: e.code, name: nameOf(e), current: null };
    if (!shift || e.employmentType !== shift.shiftType)
      return { ...base, status: "skipped", reason: `${shift?.shiftType} shifts are for ${shift?.shiftType} employees` };
    if (e.shiftId === shift.id && !e.shiftTo) return { ...base, status: "unchanged", reason: null };
    if (e.shiftId) return { ...base, status: "conflict", reason: null, decision: "reassign" };
    return { ...base, status: "new", reason: null };
  });
  const n = (s: string) => rows.filter((r) => r.status === s).length;
  const counts = {
    matched: rows.length,
    selected: rows.length,
    new: n("new"),
    alreadyAssigned: n("unchanged") + n("conflict"),
    alreadyOnThisShift: n("unchanged"),
    conflicts: n("conflict"),
    willReassign: n("conflict"),
    kept: 0,
    skipped: n("skipped"),
    excluded: 0,
    blocked: 0,
    willChange: n("new") + n("conflict"),
  };
  const out: Record<string, unknown> = {
    ok: !!shift,
    errors: shift ? [] : ["Choose a shift"],
    warnings: [],
    shift: shift
      ? {
          id: shift.id,
          name: shift.name,
          shiftType: shift.shiftType,
          startTime: shift.startTime,
          endTime: shift.endTime,
          genderRule: "all",
        }
      : null,
    effectiveFrom: body.effectiveFrom,
    counts,
    rows,
  };
  if (applying) {
    for (const r of rows)
      if (r.status === "new" || r.status === "conflict") {
        const e = world.employees.find((x) => x.id === r.employeeId)!;
        e.shiftId = shift!.id;
        e.shiftTo = null;
      }
    out.applied = {
      created: n("new"),
      reassigned: n("conflict"),
      updated: 0,
      kept: 0,
      unchanged: n("unchanged"),
      skipped: n("skipped"),
      blocked: 0,
      excluded: 0,
      assigned: n("new") + n("conflict"),
    };
  }
  return out;
}

const FREQUENCY = "Choose the Production Payroll frequency: Weekly, BiWeekly or Monthly.";

/** A label is also the department and designation (owner 2026-11-20): who moved, as the server reports it. */
function moveToLabel(world: World, e: Emp, labelId: number | null) {
  const label = world.labels.find((l) => l.id === labelId);
  if (!label) return null;
  const name = label.name.toUpperCase();
  const before = e.departmentId ? "TRANSPORT" : "none";
  e.departmentId = 900 + label.id;
  return { employeeId: e.id, code: e.code, what: `department ${before} -> ${name}, designation none -> ${name}` };
}

/** POST employees/factory/payroll, as the server answers it. */
function payrollOf(world: World, body: Record<string, unknown>) {
  const ids = (body.employeeIds ?? []) as number[];
  const category = body.category as "staff" | "production";
  const production = category === "production";
  if (production && !["weekly", "biweekly", "monthly"].includes(String(body.payCycle)))
    throw refusal(400, { error: FREQUENCY });
  const people = world.employees.filter((e) => ids.includes(e.id) && e.isFactory);
  const refused: Record<string, unknown>[] = [];
  const ok: Emp[] = [];
  for (const e of people) {
    if (production && !(body.salaryPerShift || e.salaryPerShift))
      refused.push({ employeeId: e.id, code: e.code, name: nameOf(e), reason: "Enter the salary per shift." });
    else if (!production && !(body.salaryAmount || e.salaryAmount))
      refused.push({ employeeId: e.id, code: e.code, name: nameOf(e), reason: "Enter the monthly salary." });
    else ok.push(e);
  }
  if (!ok.length) throw refusal(400, { error: String(refused[0].reason), refused });
  const cleared: Record<string, unknown>[] = [];
  for (const e of ok) {
    e.employmentType = category;
    e.productionPayCycle = production ? (body.payCycle as Cycle) : null;
    if (production && body.salaryPerShift) e.salaryPerShift = body.salaryPerShift as number;
    if (!production && body.salaryAmount) e.salaryAmount = body.salaryAmount as number;
    if (production && e.departmentId) {
      cleared.push({ employeeId: e.id, code: e.code, what: "department TRANSPORT" });
      e.departmentId = null;
    }
  }
  // a switch of payroll moves a labelled employee to their label's department of the new kind
  const moved = ok
    .filter((e) => e.labelId)
    .map((e) => ({
      employeeId: e.id,
      code: e.code,
      what: `department moved to the ${category} ${world.labels.find((l) => l.id === e.labelId)?.name.toUpperCase()}`,
    }));
  return { updated: ok.map((e) => rowOf(world, e)), refused, cleared, moved };
}

/** Makes `fetch` answer like the Factory Employees endpoints and the employee ones the page uses. */
export function installWorld(fetch: Mock, patch: Partial<Pick<World, "canEdit">> = {}): World {
  const world: World = {
    employees: copy(EMPLOYEES),
    labels: copy(LABELS),
    canEdit: patch.canEdit ?? true,
    history: {
      1: [
        {
          at: "2026-11-19T10:05:00",
          by: "Priya HR",
          action: "update",
          module: "employees",
          description: "Factory label set to Driver: F001 - MURUGAN K",
        },
        {
          at: "2026-11-01T09:00:00",
          by: "Priya HR",
          action: "create",
          module: "employees",
          description: "Created factory employee F001 - MURUGAN K",
        },
      ],
    },
    failNext: {},
    calls: [],
    gets: [],
    unexpected: [],
  };
  let nextId = 50;
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
    const factory = () => world.employees.filter((e) => e.isFactory);
    const byIds = (ids: unknown) => world.employees.filter((e) => (ids as number[]).includes(e.id));

    if (method === "GET" && path === "/api/employees/factory") {
      const status = qs.get("status") ?? "all";
      const search = (qs.get("search") ?? "").toLowerCase();
      const all = factory().filter(
        (e) =>
          (status === "all" || e.status === status) &&
          (!search || `${nameOf(e)} ${e.code}`.toLowerCase().includes(search)) &&
          (!qs.get("employmentType") || e.employmentType === qs.get("employmentType")),
      );
      const byLabel: Record<string, number> = {};
      for (const e of all) if (e.labelId) byLabel[String(e.labelId)] = (byLabel[String(e.labelId)] ?? 0) + 1;
      return {
        employees: all.map((e) => rowOf(world, e)),
        labels: world.labels.map((l) => ({ ...l, employees: factory().filter((e) => e.labelId === l.id).length })),
        counts: {
          total: all.length,
          active: all.filter((e) => e.status === "active").length,
          inactive: all.filter((e) => e.status !== "active").length,
          unlabeled: all.filter((e) => !e.labelId).length,
          byLabel,
        },
        canEdit: world.canEdit,
      };
    }
    if (method === "POST" && path === "/api/employees/factory") {
      if (world.employees.some((e) => e.code === body.employeeCode))
        throw refusal(400, { error: `Employee code '${String(body.employeeCode)}' already exists` });
      const e = emp({
        id: nextId++,
        code: String(body.employeeCode),
        firstName: String(body.firstName),
        lastName: String(body.lastName),
        phone: String(body.phone),
        employmentType: body.employmentType as Emp["employmentType"],
        labelId: (body.labelId as number | null) ?? null,
        salaryAmount: (body.salaryAmount as number) ?? null,
        salaryPerShift: (body.salaryPerShift as number) ?? null,
        joinDate: (body.joinDate as string) ?? null,
      });
      world.employees.push(e);
      return rowOf(world, e);
    }
    if (method === "GET" && path === "/api/employees/factory/candidates") {
      const search = (qs.get("search") ?? "").toLowerCase();
      return {
        employees: world.employees
          .filter((e) => !e.isFactory && (!search || `${e.firstName} ${e.code}`.toLowerCase().includes(search)))
          .map((e) => ({
            id: e.id,
            code: e.code,
            name: nameOf(e),
            employmentType: e.employmentType,
            department: "ACCOUNTS",
            designation: "CLERK",
            status: e.status,
          })),
      };
    }
    if (method === "POST" && path === "/api/employees/factory/add") {
      const list = byIds(body.employeeIds);
      const moved = [];
      for (const e of list) {
        e.isFactory = true;
        if (body.labelId) {
          e.labelId = body.labelId as number;
          const m = moveToLabel(world, e, e.labelId);
          if (m) moved.push(m);
        }
      }
      return { updated: list.length, moved };
    }
    if (method === "POST" && path === "/api/employees/factory/remove") {
      const list = byIds(body.employeeIds).filter((e) => e.isFactory);
      for (const e of list) {
        e.isFactory = false;
        e.labelId = null;
      }
      return { updated: list.length };
    }
    if (method === "POST" && path === "/api/employees/factory/label") {
      const list = byIds(body.employeeIds).filter((e) => e.isFactory);
      const moved = [];
      for (const e of list) {
        e.labelId = (body.labelId as number | null) ?? null;
        const m = moveToLabel(world, e, e.labelId);
        if (m) moved.push(m);
      }
      return { updated: list.length, moved };
    }
    if (method === "GET" && path === "/api/employees/factory/labels") return { labels: copy(world.labels) };
    if (method === "POST" && path === "/api/employees/factory/labels") {
      if (world.labels.some((l) => l.name.toLowerCase() === String(body.name).toLowerCase()))
        throw refusal(400, { error: `A label called "${String(body.name)}" already exists.` });
      const label: FactoryLabel = {
        id: nextId++,
        name: String(body.name),
        color: String(body.color ?? "#475569"),
        description: String(body.description ?? ""),
        sortOrder: world.labels.length + 1,
      };
      world.labels.push(label);
      return { ...label, employees: 0 };
    }
    const labelMatch = /^\/api\/employees\/factory\/labels\/(\d+)$/.exec(path);
    if (labelMatch) {
      const id = Number(labelMatch[1]);
      const label = world.labels.find((l) => l.id === id);
      if (!label) throw refusal(404, { error: "Label not found." }, method, path);
      if (method === "DELETE") {
        const carrying = world.employees.filter((e) => e.labelId === id);
        if (carrying.length && qs.get("unassign") !== "1")
          throw refusal(
            409,
            {
              error: `${carrying.length} employee(s) still have the label "${label.name}".`,
              employees: carrying.length,
            },
            method,
            path,
          );
        for (const e of carrying) e.labelId = null;
        world.labels = world.labels.filter((l) => l.id !== id);
        return undefined;
      }
      if (method === "PATCH") {
        Object.assign(label, body);
        return { ...label, employees: 0 };
      }
    }
    const historyMatch = /^\/api\/employees\/factory\/(\d+)\/history$/.exec(path);
    if (method === "GET" && historyMatch) return { items: copy(world.history[Number(historyMatch[1])] ?? []) };

    if (method === "GET" && path === "/api/employees/factory/shifts") {
      const active = factory().filter((e) => e.status === "active");
      return {
        shifts: SHIFTS.map((s) => ({
          ...s,
          employees: active
            .filter((e) => e.shiftId === s.id)
            .map((e) => ({
              id: e.id,
              code: e.code,
              name: nameOf(e),
              employmentType: e.employmentType,
              assignmentId: 100 + e.id,
              effectiveFrom: "2026-01-01",
              effectiveTo: e.shiftTo,
            })),
        })),
        noShift: active
          .filter((e) => !e.shiftId)
          .map((e) => ({ id: e.id, code: e.code, name: nameOf(e), employmentType: e.employmentType })),
        canEdit: world.canEdit,
      };
    }
    if (method === "POST" && path === "/api/employees/factory/shifts/plan") return planOf(world, body, false);
    if (method === "POST" && path === "/api/employees/factory/shifts/apply") return planOf(world, body, true);
    if (method === "POST" && path === "/api/employees/factory/shifts/remove") {
      const list = byIds(body.employeeIds).filter((e) => e.shiftId);
      for (const e of list) e.shiftTo = String(body.lastDay ?? "2026-11-20");
      return { ended: list.length, cancelled: 0 };
    }
    if (method === "POST" && path === "/api/employees/factory/payroll") return payrollOf(world, body);

    const statusMatch = /^\/api\/employees\/(\d+)\/status$/.exec(path);
    if (method === "PATCH" && statusMatch) {
      const e = world.employees.find((x) => x.id === Number(statusMatch[1]))!;
      e.status = body.status as Emp["status"];
      return recordOf(e);
    }
    const recordMatch = /^\/api\/employees\/(\d+)$/.exec(path);
    if (recordMatch) {
      const e = world.employees.find((x) => x.id === Number(recordMatch[1]));
      if (!e) throw refusal(404, { error: "Employee not found" }, method, path);
      if (method === "GET") return recordOf(e);
      if (method === "PATCH") {
        for (const k of ["firstName", "lastName", "phone", "joinDate"] as const)
          if (k in body) (e as Record<string, unknown>)[k] = body[k];
        return recordOf(e);
      }
    }
    if (method === "GET" && path === "/api/branches")
      return [{ id: 1, name: "HO", isHeadOffice: true, isActive: true }];
    if (method === "GET" && path === "/api/payroll-settings") return { defaultSalaryPerShift: 600 };

    world.unexpected.push(`${method} ${url}`);
    throw new Error(`unexpected request ${method} ${url}`);
  });
  return world;
}

// ── mounting ──

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Opens `url` (the address bar) and renders the Factory Employees page. */
export function mountPage(url = "/hr/employees/factory-emp") {
  window.history.replaceState(null, "", url);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0, staleTime: Infinity, gcTime: Infinity } },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(QueryClientProvider, { client }, createElement(FactoryEmployees))));
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

/** Types into a controlled input / picks in a native select the way a user does (React tracks the value itself). */
export function typeInto(el: HTMLElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

/** Keeps the page turning (inside act) until `check` holds. */
export async function waitFor(check: () => boolean, what: string, timeoutMs = 4000) {
  const t0 = performance.now();
  while (!check()) {
    if (performance.now() - t0 > timeoutMs)
      throw new Error(`timed out waiting for ${what}: ${text(document.body).slice(0, 700)}`);
    await settle(8);
  }
}

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
