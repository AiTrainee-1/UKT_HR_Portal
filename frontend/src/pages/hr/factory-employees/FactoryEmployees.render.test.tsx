import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  button,
  click,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  press,
  q,
  refusal,
  settle,
  text,
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "./harness";

// Factory Employees in jsdom, with a fake server behind customFetch that answers like factory_employee_views.py
// (2026-11-20, after the owner's corrections): the list organised by label, the figures and their quick filters, search,
// the bulk actions (label, payroll, shift, status, remove), a create with its follow-up steps (the Production Payroll
// frequency, which is required, and an existing shift), adding existing employees, the payroll quick fixes, the edit sheet
// (personal details to the employee endpoint, payroll to the payroll endpoint), the profile with its history, the labels,
// the Shifts tab (existing shifts only: assign and take off, no create / edit / delete), the phone layout and a view-only
// login. No departments or designations anywhere.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  user: {
    current: null as Record<string, unknown> | null,
  },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", async (original) => ({
  ...(await original<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ token: "t", user: h.user.current }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

vi.setConfig({ testTimeout: 20_000 });

const ADMIN = { role: "hr", isSuperAdmin: true, branchId: 1, permissions: {} };
// edit on the page only: no shifts, production employees or departments rights at all
const PAGE_EDITOR = {
  role: "hr",
  isSuperAdmin: false,
  branchId: 1,
  permissions: { "employees.factory": "edit", employees: "view", "employees.edit": "view" },
};
const VIEWER = {
  role: "hr",
  isSuperAdmin: false,
  branchId: 1,
  permissions: { "employees.factory": "view", employees: "view" },
};
const FREQUENCY = "Choose the Production Payroll frequency: Weekly, BiWeekly or Monthly.";
const LABEL_NOTE = "The label is also the employee's department and designation (e.g. DRIVER) across the HRMS.";

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  h.user.current = ADMIN;
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
});

const calls = (method: string, path: string) =>
  world.calls.filter((c) => c.method === method && c.url.split("?")[0] === path);
const toastTitles = () => h.toast.mock.calls.map((c) => (c[0] as { title?: string }).title);
const lastToast = () => h.toast.mock.calls.at(-1)?.[0] as { title?: string; variant?: string } | undefined;
const checkbox = (id: string) => must(id).closest("button") ?? must(id);
const PAYROLL = "/api/employees/factory/payroll";

async function open(url?: string) {
  mountPage(url);
  await waitFor(() => !!q("fe-stat-total-value") && text(q("fe-stat-total-value")) !== "—", "the list");
}

describe("the list", () => {
  it("shows a skeleton first, then the active factory employees with their labels, shifts and payroll", async () => {
    mountPage();
    expect(q("fe-loading")).not.toBeNull();
    expect(text(must("fe-stat-total-value"))).toBe("—");
    await waitFor(() => !!q("fe-row-F001"), "the rows");
    expect(world.gets).toContain("/api/employees/factory?status=active");
    expect(text(must("fe-tab-all"))).toBe("All 3");
    expect(text(must("fe-tab-3"))).toBe("Driver 1");
    expect(text(must("fe-tab-4"))).toBe("Housekeeping 1");
    expect(text(must("fe-tab-5"))).toBe("Chef 0");
    expect(text(must("fe-tab-none"))).toBe("No label 1");
    expect(text(must("fe-stat-total-value"))).toBe("3");
    expect(text(must("fe-stat-payroll-value"))).toBe("2");
    expect(text(must("fe-stat-noshift-value"))).toBe("2");
    expect(q("fe-row-F004")).toBeNull();
    expect(text(must("fe-label-F001"))).toBe("Driver");
    expect(text(must("fe-shift-F001"))).toContain("General");
    expect(q("fe-noshift-F002")).not.toBeNull();
    expect(text(must("fe-issue-F003"))).toContain("No pay cycle");
    expect(text(must("fe-payroll-F001"))).toContain("Staff Payroll");
    expect(text(must("fe-payroll-F001"))).toContain("₹18,000 a month · Monthly");
    expect(text(must("fe-payroll-F003"))).toContain("₹650 a shift · No frequency");
    // no departments or designations on this page
    expect(text(must("fe-table"))).not.toMatch(/Department|Designation|TRANSPORT/);
    expect(q("fe-department-filter")).toBeNull();
    expect(q("fe-section-org")).toBeNull();
    expect(world.gets.some((u) => /\/api\/(departments|designations|shifts)\b/.test(u))).toBe(false);
  });

  it("filters by label on the page, without asking the server again", async () => {
    await open();
    const asked = world.gets.length;
    click(must("fe-tab-3"));
    expect(must("fe-tab-3").getAttribute("aria-selected")).toBe("true");
    expect(q("fe-row-F001")).not.toBeNull();
    expect(q("fe-row-F002")).toBeNull();
    click(must("fe-tab-none"));
    expect(q("fe-row-F003")).not.toBeNull();
    click(must("fe-tab-5"));
    expect(text(must("fe-empty"))).toContain("Nobody has the label Chef");
    click(button("Show all labels"));
    expect(q("fe-row-F001")).not.toBeNull();
    expect(world.gets.slice(asked).filter((u) => u.includes("labelId"))).toEqual([]);
  });

  it("sends the search after a pause, and the figures open their quick filters", async () => {
    await open();
    typeInto(must("fe-search"), "raja");
    await settle(320);
    await waitFor(() => world.gets.some((u) => u.includes("search=raja")), "the search");
    await waitFor(() => !q("fe-row-F001"), "the narrowed list");
    click(must("fe-clear-filters"));
    await waitFor(() => !!q("fe-row-F001"), "everyone back");
    click(must("fe-stat-payroll").querySelector("button"));
    expect(text(must("fe-attention-note"))).toContain("only those payroll skips");
    expect(q("fe-row-F001")).toBeNull();
    expect(q("fe-row-F003")).not.toBeNull();
    click(button("Show everyone"));
    expect(q("fe-row-F001")).not.toBeNull();
  });

  it("shows cards on a phone, one per employee", async () => {
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    try {
      await open();
      expect(q("fe-cards")).not.toBeNull();
      expect(q("fe-table")).toBeNull();
      expect(document.body.querySelectorAll('[data-testid="fe-row-F001"]').length).toBe(1);
      expect(q("fe-fix-F003")).not.toBeNull();
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, writable: true, value: original });
    }
  });
});

describe("bulk actions", () => {
  it("gives the ticked employees a label", async () => {
    await open();
    click(checkbox("fe-select-F002"));
    click(checkbox("fe-select-F003"));
    expect(text(must("fe-selected-count"))).toBe("2 selected");
    expect(q("fe-bulk-org")).toBeNull();
    press(must("fe-bulk-label"), "Enter");
    click(must("fe-bulk-label-5"));
    // the label is also their department and designation: said before anything changes
    const confirm = must("fe-label-confirm-dialog");
    expect(text(confirm)).toContain("Give 2 employees the label Chef?");
    expect(text(confirm)).toContain("they move to the department CHEF and the designation CHEF");
    expect(text(confirm)).toContain("Department Head becomes the head of CHEF");
    expect(text(confirm)).toContain("go to HR");
    expect(calls("POST", "/api/employees/factory/label")).toEqual([]);
    click(must("fe-label-confirm"));
    await waitFor(() => calls("POST", "/api/employees/factory/label").length === 1, "the label request");
    expect(calls("POST", "/api/employees/factory/label")[0].body).toEqual({ employeeIds: [2, 3], labelId: 5 });
    await waitFor(() => text(q("fe-tab-5")) === "Chef 2", "the new counts");
    const done = h.toast.mock.calls.at(-1)?.[0] as { title: string; description: unknown };
    expect(done.title).toBe("2 employees labelled Chef");
    // who moved department / designation, briefly
    expect(JSON.stringify(done.description)).toContain("F002: department none -> CHEF, designation none -> CHEF");
  });

  it("says that removing the label keeps the department, and a row's own label change needs no question", async () => {
    await open();
    click(checkbox("fe-select-F001"));
    press(must("fe-bulk-label"), "Enter");
    click(must("fe-bulk-label-none"));
    expect(text(must("fe-label-confirm-dialog"))).toContain("Remove the label from 1 employee?");
    expect(text(must("fe-label-confirm-dialog"))).toContain("They keep the department and designation they have now");
    click(must("fe-label-confirm"));
    await waitFor(() => calls("POST", "/api/employees/factory/label").length === 1, "the request");
    expect(calls("POST", "/api/employees/factory/label")[0].body).toEqual({ employeeIds: [1], labelId: null });
    press(must("fe-menu-F003"), "Enter");
    click(must("fe-menu-F003-label-3"));
    await waitFor(() => calls("POST", "/api/employees/factory/label").length === 2, "the row's request");
    expect(calls("POST", "/api/employees/factory/label")[1].body).toEqual({ employeeIds: [3], labelId: 3 });
    expect(q("fe-label-confirm-dialog")).toBeNull();
  });

  it("sets the payroll of the ticked employees: Production Payroll needs its frequency", async () => {
    await open();
    click(checkbox("fe-select-F001"));
    click(checkbox("fe-select-F003"));
    click(must("fe-bulk-payroll"));
    // a mixed selection starts on Staff Payroll, which is Monthly
    expect(text(must("fe-p-cycle-fixed"))).toContain("Monthly");
    click(must("fe-p-category-production"));
    expect(q("fe-p-cycle-fixed")).toBeNull();
    click(must("fe-payroll-save"));
    expect(text(must("fe-payroll-dialog"))).toContain(FREQUENCY);
    expect(calls("POST", PAYROLL)).toEqual([]);
    click(must("fe-p-cycle-biweekly"));
    click(must("fe-payroll-save"));
    await waitFor(() => calls("POST", PAYROLL).length === 1, "the payroll request");
    expect(calls("POST", PAYROLL)[0].body).toEqual({
      employeeIds: [1, 3],
      category: "production",
      payCycle: "biweekly",
    });
    await waitFor(() => !q("fe-payroll-dialog"), "closed");
    // MURUGAN has no salary per shift: refused; his staff department would have been cleared otherwise
    const t = h.toast.mock.calls.at(-1)?.[0] as { title: string; variant?: string };
    expect(t.title).toBe("RAJA P now on Production Payroll (BiWeekly)");
    expect(t.variant).toBe("destructive");
    await waitFor(() => !!q("fe-ready-F003"), "RAJA ready");
  });

  it("asks for a reason when someone already paid changes frequency", async () => {
    world.failNext[`POST ${PAYROLL}`] = refusal(409, {
      code: "confirm_cycle_change",
      needsReason: true,
      employees: [{ employeeId: 3, name: "RAJA P", message: "RAJA P has already received salary up to 15 Nov." }],
    });
    await open();
    click(checkbox("fe-select-F003"));
    click(must("fe-bulk-payroll"));
    click(must("fe-p-cycle-monthly"));
    click(must("fe-payroll-save"));
    await waitFor(() => !!q("fe-payroll-reason"), "the reason");
    expect(text(must("fe-payroll-reason"))).toContain("already received salary up to 15 Nov");
    expect((must("fe-payroll-save") as HTMLButtonElement).disabled).toBe(true);
    typeInto(must("fe-payroll-reason-text"), "Canteen roster is monthly");
    click(must("fe-payroll-save"));
    await waitFor(() => calls("POST", PAYROLL).length === 2, "the confirmed request");
    expect(calls("POST", PAYROLL)[1].body).toEqual({
      employeeIds: [3],
      category: "production",
      payCycle: "monthly",
      confirm: true,
      reason: "Canteen roster is monthly",
    });
  });

  it("takes the ticked employees off their shift from a last day", async () => {
    await open();
    click(checkbox("fe-select-F001"));
    press(must("fe-bulk-shift"), "Enter");
    click(must("fe-bulk-shift-remove"));
    expect(text(must("fe-shift-remove-dialog"))).toContain("Take 1 employee off their shift?");
    typeInto(must("fe-shift-last-day"), "2026-11-30");
    expect(text(must("fe-shift-remove-dialog"))).toContain("30 Nov 2026 is their last day on it.");
    click(must("fe-shift-remove-confirm"));
    await waitFor(() => calls("POST", "/api/employees/factory/shifts/remove").length === 1, "the request");
    expect(calls("POST", "/api/employees/factory/shifts/remove")[0].body).toEqual({
      employeeIds: [1],
      lastDay: "2026-11-30",
    });
    expect(toastTitles()).toContain("1 employee taken off their shift after 30 Nov 2026");
  });

  it("removes them from the page after saying they stay employees", async () => {
    await open();
    click(checkbox("fe-select-F001"));
    click(must("fe-bulk-remove"));
    expect(text(must("fe-remove-dialog"))).toContain("They stay employees");
    click(must("fe-remove-confirm"));
    await waitFor(() => !q("fe-row-F001"), "the row gone");
    expect(calls("POST", "/api/employees/factory/remove")[0].body).toEqual({ employeeIds: [1] });
  });

  it("marks them inactive through the status endpoint", async () => {
    await open();
    click(checkbox("fe-select-F001"));
    press(must("fe-bulk-status"), "Enter");
    click(must("fe-bulk-status-inactive"));
    click(must("fe-status-confirm"));
    await waitFor(() => calls("PATCH", "/api/employees/1/status").length === 1, "the status request");
    expect(calls("PATCH", "/api/employees/1/status")[0].body).toEqual({ status: "inactive" });
  });
});

describe("a new factory employee", () => {
  const fill = (code: string) => {
    typeInto(must("fe-c-code"), code);
    typeInto(must("fe-c-first"), "KANNAN");
    typeInto(must("fe-c-last"), "M");
    typeInto(must("fe-c-phone"), "9000000001");
  };

  it("has no department or designation, and shows Staff Payroll as Monthly", async () => {
    await open();
    click(must("fe-new"));
    const dialog = must("fe-create-dialog");
    expect(text(dialog)).not.toMatch(/Department|Designation/);
    expect(q("fe-c-department")).toBeNull();
    expect(text(must("fe-c-pay-cycle-fixed"))).toContain("Monthly");
    expect(text(must("fe-create-job"))).toContain(LABEL_NOTE);
    click(must("fe-create-save"));
    expect(lastToast()).toMatchObject({ title: "Check the form", variant: "destructive" });
    expect(text(dialog)).toContain("Employee code is required");
    expect(calls("POST", "/api/employees/factory")).toEqual([]);
  });

  it("creates a staff employee with the label, salary split and an existing shift", async () => {
    await open();
    click(must("fe-tab-3"));
    click(must("fe-new"));
    expect((must("fe-c-label") as HTMLSelectElement).value).toBe("3");
    fill("F010");
    typeInto(must("fe-c-pay-salary"), "20000");
    expect(text(must("split-status"))).toContain("The split is valid");
    await waitFor(() => !!document.querySelector('#fe-c-shift option[value="2"]'), "the shifts");
    expect(document.querySelector('#fe-c-shift option[value="7"]')).toBeNull();
    typeInto(must("fe-c-shift"), "2");
    click(must("fe-create-save"));
    await waitFor(() => !q("fe-create-dialog"), "the dialog closed");
    const body = calls("POST", "/api/employees/factory")[0].body;
    expect(body).toMatchObject({
      employeeCode: "F010",
      employmentType: "staff",
      salaryType: "monthly",
      salaryAmount: 20000,
      labelId: 3,
    });
    expect(body).not.toHaveProperty("departmentId");
    expect(body.salaryBreakup).toMatchObject({ basic: "3333.34", ca: "2000.00" });
    expect(calls("POST", "/api/employees/factory/shifts/apply")[0].body).toMatchObject({
      shiftId: 2,
      employeeIds: [50],
      saturdayOff: false,
    });
    // Staff Payroll is monthly: nothing more to set
    expect(calls("POST", PAYROLL)).toEqual([]);
    expect(toastTitles()).toContain("KANNAN M added to Factory Employees");
  });

  it("requires the Production Payroll frequency, then sets it through the payroll endpoint", async () => {
    world.failNext["POST /api/employees/factory/shifts/apply"] = refusal(400, {
      ok: false,
      errors: ["Production Day belongs to another branch"],
    });
    await open();
    click(must("fe-new"));
    fill("F011");
    click(must("fe-c-pay-category-production"));
    await waitFor(() => (must("fe-c-pay-rate") as HTMLInputElement).value === "600", "the default rate");
    expect(q("fe-c-pay-cycle-fixed")).toBeNull();
    expect(q("fe-c-pay-cycle-weekly")).not.toBeNull();
    // not without a frequency
    click(must("fe-create-save"));
    expect(lastToast()).toMatchObject({ title: "Check the form", description: FREQUENCY });
    expect(text(must("fe-c-pay"))).toContain(FREQUENCY);
    expect(calls("POST", "/api/employees/factory")).toEqual([]);
    click(must("fe-c-pay-cycle-weekly"));
    expect(must("fe-c-pay-cycle-weekly").getAttribute("aria-checked")).toBe("true");
    await waitFor(() => !!document.querySelector('#fe-c-shift option[value="7"]'), "the production shifts");
    typeInto(must("fe-c-shift"), "7");
    click(must("fe-create-save"));
    await waitFor(() => !!q("fe-create-result"), "the result");
    expect(must("fe-create-step-create").dataset.ok).toBe("true");
    expect(must("fe-create-step-payroll").dataset.ok).toBe("true");
    expect(text(must("fe-create-step-payroll"))).toContain("Production Payroll (Weekly)");
    expect(must("fe-create-step-shift").dataset.ok).toBe("false");
    expect(text(must("fe-create-step-shift"))).toContain("Production Day belongs to another branch");
    expect(calls("POST", "/api/employees/factory")[0].body).toMatchObject({
      employmentType: "production",
      salaryPerShift: 600,
    });
    expect(calls("POST", PAYROLL)[0].body).toEqual({
      employeeIds: [50],
      category: "production",
      payCycle: "weekly",
      salaryPerShift: 600,
    });
    click(must("fe-create-done"));
    await waitFor(() => !q("fe-create-dialog"), "closed");
  });

  it("keeps the form and shows the server's words when it refuses", async () => {
    await open();
    click(must("fe-new"));
    fill("F001");
    typeInto(must("fe-c-pay-salary"), "15000");
    click(must("fe-create-save"));
    await waitFor(() => !!q("fe-create-error"), "the error");
    expect(text(must("fe-create-error"))).toContain("Employee code 'F001' already exists");
    expect(calls("POST", "/api/employees/factory/shifts/apply")).toEqual([]);
  });

  it("adds people who are already employees, with a label", async () => {
    await open();
    click(must("fe-add-existing"));
    await waitFor(() => !!q("fe-add-E020"), "the candidates");
    expect(text(must("fe-add-E020"))).toContain("Staff Payroll");
    expect(text(must("fe-add-E020"))).not.toContain("ACCOUNTS");
    expect(text(must("fe-add-dialog"))).toContain(LABEL_NOTE);
    click(must("fe-add-E020").querySelector("button"));
    typeInto(must("fe-add-label"), "4");
    click(must("fe-add-confirm"));
    await waitFor(() => !q("fe-add-dialog"), "closed");
    expect(calls("POST", "/api/employees/factory/add")[0].body).toEqual({ employeeIds: [20], labelId: 4 });
    const added = h.toast.mock.calls.at(-1)?.[0] as { title: string; description: unknown };
    expect(added.title).toBe("1 employee added to Factory Employees");
    expect(JSON.stringify(added.description)).toContain("E020: department none -> HOUSEKEEPING");
  });
});

describe("payroll quick fixes", () => {
  it("sets the Production Payroll frequency through the payroll endpoint", async () => {
    await open();
    press(must("fe-fix-F003"), "Enter");
    click(must("fe-fix-F003-weekly"));
    await waitFor(() => calls("POST", PAYROLL).length === 1, "the request");
    expect(calls("POST", PAYROLL)[0].body).toEqual({ employeeIds: [3], category: "production", payCycle: "weekly" });
    expect(calls("POST", "/api/employees/production/assign")).toEqual([]);
    await waitFor(() => !!q("fe-ready-F003"), "ready");
    expect(toastTitles()).toContain("RAJA P is paid Weekly");
  });

  it("asks for a reason when the worker was paid before", async () => {
    world.failNext[`POST ${PAYROLL}`] = refusal(409, {
      code: "confirm_cycle_change",
      needsReason: true,
      employees: [{ employeeId: 3, name: "RAJA P", message: "RAJA P has already received salary up to 15 Nov." }],
    });
    await open();
    press(must("fe-fix-F003"), "Enter");
    click(must("fe-fix-F003-monthly"));
    await waitFor(() => !!q("fe-reason-dialog"), "the reason dialog");
    typeInto(must("fe-reason"), "Moved to the monthly canteen roster");
    click(must("fe-reason-confirm"));
    await waitFor(() => calls("POST", PAYROLL).length === 2, "the confirmed request");
    expect(calls("POST", PAYROLL)[1].body).toEqual({
      employeeIds: [3],
      category: "production",
      payCycle: "monthly",
      confirm: true,
      reason: "Moved to the monthly canteen roster",
    });
  });

  it("opens the edit sheet on the salary, and saves it through the payroll endpoint", async () => {
    await open();
    click(must("fe-fix-F002"));
    await waitFor(() => !!q("fe-e-pay-salary"), "the form");
    expect(text(must("fe-e-pay-cycle-fixed"))).toContain("Monthly");
    typeInto(must("fe-e-pay-salary"), "16000");
    click(must("fe-edit-save"));
    await waitFor(() => calls("POST", PAYROLL).length === 1, "the save");
    expect(calls("POST", PAYROLL)[0].body).toMatchObject({
      employeeIds: [2],
      category: "staff",
      salaryAmount: 16000,
      salaryBreakup: { basic: "2666.67" },
    });
    expect(calls("PATCH", "/api/employees/2")).toEqual([]);
    await waitFor(() => !!q("fe-ready-F002"), "ready");
  });
});

describe("edit and profile", () => {
  it("saves personal details to the employee endpoint and the status through its own", async () => {
    await open();
    click(must("fe-edit-F001"));
    await waitFor(() => !!q("fe-e-phone"), "the form");
    expect(q("fe-e-department")).toBeNull();
    typeInto(must("fe-e-phone"), "9123456780");
    typeInto(must("fe-e-status"), "inactive");
    click(must("fe-edit-save"));
    await waitFor(() => calls("PATCH", "/api/employees/1/status").length === 1, "the status");
    expect(calls("PATCH", "/api/employees/1")[0].body).toEqual({ phone: "9123456780" });
    expect(calls("POST", PAYROLL)).toEqual([]);
    expect(toastTitles()).toContain("MURUGAN K saved");
  });

  it("moves someone to Production Payroll with the frequency and rate, saying what was cleared", async () => {
    await open();
    click(must("fe-edit-F001"));
    await waitFor(() => !!q("fe-e-pay"), "the form");
    click(must("fe-e-pay-category-production"));
    expect(text(must("fe-e-pay"))).toContain(FREQUENCY);
    typeInto(must("fe-e-pay-rate"), "700");
    click(must("fe-edit-save"));
    expect(calls("POST", PAYROLL)).toEqual([]);
    click(must("fe-e-pay-cycle-weekly"));
    click(must("fe-edit-save"));
    await waitFor(() => calls("POST", PAYROLL).length === 1, "the payroll save");
    expect(calls("POST", PAYROLL)[0].body).toEqual({
      employeeIds: [1],
      category: "production",
      payCycle: "weekly",
      salaryPerShift: 700,
    });
    expect(calls("PATCH", "/api/employees/1")).toEqual([]);
    await waitFor(() => !q("fe-edit-form"), "closed");
    const saved = h.toast.mock.calls.at(-1)?.[0] as { title: string; description: unknown };
    expect(saved.title).toBe("MURUGAN K saved");
    // the toast's lines: the new payroll, and the staff department that could not stay
    expect(JSON.stringify(saved.description)).toContain("MURUGAN K now on Production Payroll (Weekly)");
    expect(JSON.stringify(saved.description)).toContain("department TRANSPORT");
    await waitFor(() => text(q("fe-payroll-F001")).includes("₹700 a shift · Weekly"), "the new payroll");
  });

  it("asks for the frequency of a production employee who has none before saving", async () => {
    await open();
    click(must("fe-edit-F003"));
    await waitFor(() => !!q("fe-e-pay"), "the form");
    expect(text(must("fe-e-pay"))).toContain(FREQUENCY);
    typeInto(must("fe-e-phone"), "9123456780");
    click(must("fe-edit-save"));
    expect(lastToast()).toMatchObject({ title: "Check the form", description: FREQUENCY });
    expect(world.calls).toEqual([]);
  });

  it("asks for a reason in the sheet when the server needs one", async () => {
    world.failNext[`POST ${PAYROLL}`] = refusal(409, {
      code: "confirm_cycle_change",
      needsReason: true,
      employees: [{ employeeId: 3, name: "RAJA P", message: "RAJA P has already received salary up to 15 Nov." }],
    });
    await open();
    click(must("fe-edit-F003"));
    await waitFor(() => !!q("fe-e-pay"), "the form");
    click(must("fe-e-pay-cycle-monthly"));
    click(must("fe-edit-save"));
    await waitFor(() => !!q("fe-edit-reason"), "the reason");
    typeInto(must("fe-edit-reason-text"), "Monthly roster");
    click(must("fe-edit-save"));
    await waitFor(() => calls("POST", PAYROLL).length === 2, "resent");
    expect(calls("POST", PAYROLL)[1].body).toMatchObject({
      confirm: true,
      reason: "Monthly roster",
      payCycle: "monthly",
    });
  });

  it("lets a page editor change payroll without the employee edit right", async () => {
    h.user.current = PAGE_EDITOR;
    await open();
    click(must("fe-edit-F002"));
    await waitFor(() => !!q("fe-e-pay"), "the form");
    expect(q("fe-e-phone")).toBeNull();
    expect(q("fe-edit-personal-locked")).not.toBeNull();
    typeInto(must("fe-e-pay-salary"), "15000");
    click(must("fe-edit-save"));
    await waitFor(() => calls("POST", PAYROLL).length === 1, "the payroll save");
    expect(calls("PATCH", "/api/employees/2")).toEqual([]);
  });

  it("shows the profile with the payroll and the history", async () => {
    await open();
    click(must("fe-profile-F001"));
    await waitFor(() => document.body.querySelectorAll('[data-testid="fe-history-item"]').length === 2, "history");
    expect(text(must("fe-profile-payroll"))).toBe("PayrollStaff PayrollMonthly");
    expect(text(must("fe-profile-sheet"))).not.toMatch(/Department|Designation/);
    const items = [...document.body.querySelectorAll('[data-testid="fe-history-item"]')].map(text);
    expect(items[0]).toContain("Factory label set to Driver");
    expect(items[0]).toContain("by Priya HR");
  });
});

describe("labels", () => {
  it("opens from the address, and creates a label", async () => {
    await open("/hr/employees/factory-emp?tab=labels");
    await waitFor(() => !!q("fe-label-card-3"), "the label cards");
    expect(text(must("fe-labels-department-note"))).toBe(LABEL_NOTE);
    click(must("fe-label-new"));
    expect(text(must("fe-label-dialog"))).toContain(LABEL_NOTE);
    typeInto(must("fe-label-name"), "  Gardener ");
    click(must("fe-label-color-db2777"));
    click(must("fe-label-save"));
    await waitFor(() => calls("POST", "/api/employees/factory/labels").length === 1, "the create");
    expect(calls("POST", "/api/employees/factory/labels")[0].body).toEqual({
      name: "Gardener",
      color: "#db2777",
      description: "",
    });
    await waitFor(() => !!q("fe-label-card-50"), "the new card");
  });

  it("reorders the labels", async () => {
    await open("/hr/employees/factory-emp?tab=labels");
    await waitFor(() => !!q("fe-label-card-3"), "the label cards");
    click(must("fe-label-down-3"));
    await waitFor(() => calls("PATCH", "/api/employees/factory/labels/3").length === 1, "the reorder");
    expect(calls("PATCH", "/api/employees/factory/labels/3")[0].body).toEqual({ sortOrder: 2 });
    expect(calls("PATCH", "/api/employees/factory/labels/4")[0].body).toEqual({ sortOrder: 1 });
  });

  it("offers to clear a label from its employees when the server says it is in use", async () => {
    await open("/hr/employees/factory-emp?tab=labels");
    await waitFor(() => !!q("fe-label-card-3"), "the label cards");
    click(must("fe-label-delete-3"));
    click(must("fe-label-delete-confirm"));
    await waitFor(() => text(q("fe-label-delete-dialog")).includes("Remove Driver from 2 employees"), "the 409");
    click(must("fe-label-delete-confirm"));
    await waitFor(() => !q("fe-label-card-3"), "the label gone");
    const deletes = world.calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(deletes).toEqual(["/api/employees/factory/labels/3", "/api/employees/factory/labels/3?unassign=1"]);
  });

  it("sends an old Departments address to Employees", async () => {
    await open("/hr/employees/factory-emp?tab=org");
    await waitFor(() => !!q("fe-employees"), "the employees");
    expect(q("fe-section-org")).toBeNull();
  });
});

describe("the Shifts tab", () => {
  it("lists every existing shift with its people, with no way to create, edit or delete a shift", async () => {
    await open("/hr/employees/factory-emp?tab=shifts");
    await waitFor(() => !!q("fe-shift-card-2"), "the shift cards");
    expect(world.gets).toContain("/api/employees/factory/shifts");
    expect(q("fe-shift-card-6")).not.toBeNull();
    expect(q("fe-shift-card-7")).not.toBeNull();
    expect(text(must("fe-shift-count-2"))).toBe("1 employee from this page");
    expect(text(must("fe-shift-member-F001"))).toContain("MURUGAN K");
    expect(text(must("fe-shifts-missing"))).toContain("2 employees have no shift");
    expect(text(must("fe-shifts-missing"))).toContain("LAKSHMI S (F002)");
    const tab = must("fe-shifts");
    expect(q("fe-shift-new")).toBeNull();
    expect(tab.querySelector('[data-testid^="fe-shift-edit"]')).toBeNull();
    expect([...tab.querySelectorAll("button")].map(text).filter((t) => /new shift|edit|delete/i.test(t))).toEqual([]);
    expect(must("fe-shifts-manage-link").getAttribute("href")).toBe("/hr/shifts");
    expect(text(must("fe-shifts-manage-link"))).toBe("Create or edit shifts in Manage Shifts");
  });

  it("puts people on an existing shift through the page's planner", async () => {
    await open("/hr/employees/factory-emp?tab=shifts");
    await waitFor(() => !!q("fe-shift-card-2"), "the shift cards");
    click(must("fe-shift-assign-2"));
    await waitFor(() => !!q("fe-pick-F002"), "the picker");
    expect(text(must("fe-shift-locked"))).toContain("General");
    expect(q("fe-pick-F003")).toBeNull();
    click(must("fe-pick-F002").querySelector("button"));
    await waitFor(() => text(q("fe-shift-summary")).includes("1 to assign"), "the preview");
    expect(calls("POST", "/api/employees/factory/shifts/plan").at(-1)?.body).toMatchObject({
      shiftId: 2,
      employeeIds: [2],
    });
    click(must("fe-shift-apply"));
    await waitFor(() => calls("POST", "/api/employees/factory/shifts/apply").length === 1, "the apply");
    expect(calls("POST", "/api/employees/factory/shifts/apply")[0].body).toMatchObject({
      shiftId: 2,
      employeeIds: [2],
    });
    expect(toastTitles()).toContain("General assigned to 1 employee");
    await waitFor(() => !!q("fe-shift-member-F002"), "LAKSHMI on General");
  });

  it("takes someone off a shift, and shows until when", async () => {
    await open("/hr/employees/factory-emp?tab=shifts");
    await waitFor(() => !!q("fe-shift-member-F001"), "the members");
    click(must("fe-shift-remove-F001"));
    typeInto(must("fe-shift-last-day"), "2026-11-25");
    click(must("fe-shift-remove-confirm"));
    await waitFor(() => calls("POST", "/api/employees/factory/shifts/remove").length === 1, "the request");
    expect(calls("POST", "/api/employees/factory/shifts/remove")[0].body).toEqual({
      employeeIds: [1],
      lastDay: "2026-11-25",
    });
    await waitFor(() => text(q("fe-shift-member-F001")).includes("until 25 Nov 2026"), "until");
    expect(q("fe-shift-remove-F001")).toBeNull();
  });
});

describe("a login that may only view", () => {
  it("shows the list without the buttons that change anything", async () => {
    h.user.current = VIEWER;
    world = installWorld(h.fetch, { canEdit: false });
    await open();
    expect(q("fe-new")).toBeNull();
    expect(q("fe-add-existing")).toBeNull();
    expect(q("fe-edit-F001")).toBeNull();
    expect(q("fe-fix-F003")).toBeNull();
    click(checkbox("fe-select-F001"));
    for (const id of ["fe-bulk-label", "fe-bulk-payroll", "fe-bulk-shift", "fe-bulk-status", "fe-bulk-remove"])
      expect(q(id)).toBeNull();
    click(must("fe-profile-F001"));
    await waitFor(() => document.body.querySelectorAll('[data-testid="fe-history-item"]').length === 2, "history");
    expect(q("fe-profile-edit")).toBeNull();
  });

  it("can see the labels and shifts but not change them", async () => {
    h.user.current = VIEWER;
    world = installWorld(h.fetch, { canEdit: false });
    await open("/hr/employees/factory-emp?tab=labels");
    await waitFor(() => !!q("fe-label-card-3"), "the cards");
    expect(q("fe-label-new")).toBeNull();
    expect(q("fe-label-delete-3")).toBeNull();
    click(must("fe-section-shifts"));
    await waitFor(() => !!q("fe-shift-card-2"), "the shifts");
    expect(q("fe-shift-assign-2")).toBeNull();
    expect(q("fe-shift-remove-F001")).toBeNull();
    expect(q("fe-shifts-assign-missing")).toBeNull();
  });
});
