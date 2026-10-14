import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { ESHA, payroll, person } from "./fixtures";
import {
  click,
  here,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  params,
  q,
  text,
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "./harness";

// The Employees tab of a Production Payroll cycle page in jsdom, with a fake server behind customFetch: who is on the
// roster and in which state, what each employee has for the period (figures, the issues payroll found, the rules they are
// paid under), and the way to generate one of them, a few of them, or one of them again.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  trigger: vi.fn(),
  toast: vi.fn(),
  generating: { current: false },
}));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "t", user: null }) }));
vi.mock("@/contexts/PayrollGenerationContext", () => ({
  usePayrollGeneration: () => ({
    isGenerating: h.generating.current,
    showPipeline: false,
    progress: undefined,
    lastResult: null,
    triggerGenerate: vi.fn(),
    triggerGenerateProduction: h.trigger,
    dismiss: vi.fn(),
  }),
}));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  h.generating.current = false;
  h.trigger.mockResolvedValue(null);
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
});

const EMPLOYEES = "/hr/production-payroll/weekly?tab=employees";
const WEEK_PARAM = "2026-02-02_2026-02-08";

/** Opens the Employees tab and waits until the roster, the issues and the rules are all in. */
async function openRoster(url = EMPLOYEES) {
  mountPage(url);
  await waitFor(() => !!q("pcp-roster-list") || !!q("pcp-roster-empty") || !!q("pcp-roster-no-match"), "the roster");
  await waitFor(
    () => !document.body.querySelector('[data-testid^="pcp-roster-issues-loading"]'),
    "the issues of the roster",
  );
}

const rowIds = () =>
  [...document.body.querySelectorAll('[data-testid^="pcp-roster-row-"]')].map((r) =>
    r.getAttribute("data-testid")!.replace("pcp-roster-row-", ""),
  );

describe("the roster", () => {
  it("lists only the people on the cycle, each with what they have for the period", async () => {
    await openRoster();
    expect(rowIds()).toEqual(["PC-W1", "PC-W2", "PC-N1"]);
    expect(text(q("pcp-roster-counts"))).toBe("3 on the Weekly cycle · 1 generated · 1 ready · 1 cannot be generated");
    expect(text(q("pcp-roster-state-PC-W1"))).toBe("Generated - pending");
    expect(text(q("pcp-roster-state-PC-W2"))).toBe("Not generated");
    expect(text(q("pcp-roster-state-PC-N1"))).toBe("Cannot be generated");
    expect(text(q("pcp-roster-row-PC-N1"))).toContain("No Salary Per Shift");
    expect(text(q("pcp-roster-row-PC-N1"))).toContain("Not set");
    expect(text(q("pcp-roster-row-PC-W2"))).toContain("₹500 / shift");
    expect(q("pcp-roster-row-PC-U1")).toBeNull();
    expect(world.requests()).toContain(
      "/api/payroll/production/period-status?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08",
    );
  });

  it("shows a generated employee's figures, what payroll found and the rules they are paid under", async () => {
    await openRoster();
    await waitFor(() => text(q("pcp-roster-row-PC-W1")).includes("₹500 per shift"), "the rule chips");
    const row = text(q("pcp-roster-row-PC-W1"));
    expect(row).toContain("Asha Worker");
    expect(row).toContain("PC-W1 · Weaving");
    expect(text(q("pcp-roster-figures-PC-W1"))).toBe("Shifts7 shiftsGross₹3,500Net₹3,000");
    expect(row).toContain("3 issues · Needs a look");
    expect(row).toContain("Weekly cycle");
    // somebody with nothing generated has no figures and no issues yet, but is paid under the same rules
    expect(q("pcp-roster-figures-PC-W2")).toBeNull();
    expect(q("pcp-roster-issues-PC-W2")).toBeNull();
    expect(text(q("pcp-roster-row-PC-W2"))).toContain("₹500 per shift");
  });

  it("says there are no issues for a payslip payroll found nothing in", async () => {
    world.issues = [];
    await openRoster();
    expect(text(q("pcp-roster-issues-PC-W1"))).toBe("No issues");
  });

  it("shows where the issues and the rules are still on their way, and then fills them in", async () => {
    const releaseIssues = world.hold("/api/payroll/production/issues");
    const releaseRules = world.hold("/api/payroll/production/rules");
    mountPage(EMPLOYEES);
    await waitFor(() => !!q("pcp-roster-list"), "the roster");
    expect(q("pcp-roster-issues-loading-PC-W1")).not.toBeNull();
    expect(q("pcp-roster-rules-loading-PC-W1")).not.toBeNull();
    releaseIssues();
    releaseRules();
    await waitFor(() => !!q("pcp-roster-issues-PC-W1"), "the issues");
    await waitFor(() => !q("pcp-roster-rules-loading-PC-W1"), "the rules");
    expect(q("pcp-roster-issues-loading-PC-W1")).toBeNull();
  });

  it("leaves the issues and the rules out, quietly, when they could not be loaded", async () => {
    world.failing.set("/api/payroll/production/issues", 500);
    world.failing.set("/api/payroll/production/rules", 500);
    await openRoster();
    expect(rowIds()).toEqual(["PC-W1", "PC-W2", "PC-N1"]);
    expect(q("pcp-roster-issues-PC-W1")).toBeNull();
    expect(text(q("pcp-roster-row-PC-W1"))).not.toContain("No issues");
  });

  it("opens a generated payslip's details on its own page, and the issues from the issue badge", async () => {
    await openRoster();
    expect(q("pcp-roster-details-PC-W2")).toBeNull(); // nothing generated: nothing to open
    expect(q("pcp-roster-details-PC-N1")).toBeNull();
    click(must("pcp-roster-details-PC-W1"));
    expect(here()).toBe("/hr/production-payroll/details/11");
    expect(window.history.state).toEqual({ fromPayroll: true });
    unmountPage();
    await openRoster();
    click(must("pcp-roster-issues-PC-W1"));
    expect(here()).toBe("/hr/production-payroll/details/11?section=issues");
  });

  it("says why somebody cannot be generated, and links to where it is fixed", async () => {
    await openRoster();
    const fix = must("pcp-roster-fix-PC-N1") as HTMLAnchorElement;
    expect(fix.getAttribute("href")).toBe("/hr/employees/3/edit");
    expect(text(fix)).toBe("Open profile");
  });

  it("shows skeleton rows while the roster loads, then the people", async () => {
    const release = world.hold("/api/payroll/production/period-status");
    mountPage(EMPLOYEES);
    await waitFor(() => !!q("pcp-roster-loading"), "the loader");
    expect(q("skeleton-rows")).not.toBeNull();
    expect(q("pcp-roster-row-PC-W1")).toBeNull();
    release();
    await waitFor(() => !!q("pcp-roster-row-PC-W1"), "the roster");
    expect(q("pcp-roster-loading")).toBeNull();
  });

  it("says so, with the way out, when the pay period cannot be worked out", async () => {
    world.failing.set("/api/payroll/production/period-status", 400);
    mountPage(EMPLOYEES);
    await waitFor(() => !!q("pcp-period-error"), "the error");
    expect(text(q("pcp-period-error"))).toContain("Pick another pay period above");
    expect(q("pcp-period")).not.toBeNull();
  });

  it("an empty roster says so and points to Production Employees", async () => {
    world.people = [];
    await openRoster();
    expect(text(q("pcp-roster-empty"))).toContain("No employees are assigned to the Weekly cycle yet");
    expect(must("pcp-roster-empty").querySelector('a[href="/hr/employees/productionEmployee"]')).not.toBeNull();
  });
});

describe("searching and filtering the roster", () => {
  it("counts the people in each state, and a state shows only them", async () => {
    await openRoster();
    expect(text(q("pcp-roster-filter-all"))).toBe("All 3");
    expect(text(q("pcp-roster-filter-ready"))).toBe("Not generated 1");
    expect(text(q("pcp-roster-filter-pending"))).toBe("Generated - pending 1");
    expect(text(q("pcp-roster-filter-paid"))).toBe("Paid 0");
    expect(text(q("pcp-roster-filter-blocked"))).toBe("Cannot be generated 1");
    click(must("pcp-roster-filter-blocked"));
    expect(params().estate).toBe("blocked");
    expect(rowIds()).toEqual(["PC-N1"]);
    expect(must("pcp-roster-filter-blocked").getAttribute("aria-pressed")).toBe("true");
    expect(text(q("pcp-roster-showing"))).toContain("Showing 1 of 3");
    click(must("pcp-roster-filter-all"));
    expect(params().estate).toBeUndefined();
    expect(rowIds()).toHaveLength(3);
  });

  it("searches by name or code, and keeps the search in the address", async () => {
    await openRoster();
    typeInto(must("pcp-roster-search") as HTMLInputElement, "bala");
    expect(params().eq).toBe("bala");
    expect(rowIds()).toEqual(["PC-W2"]);
    typeInto(must("pcp-roster-search") as HTMLInputElement, "pc-n1");
    expect(rowIds()).toEqual(["PC-N1"]);
    typeInto(must("pcp-roster-search") as HTMLInputElement, "");
    expect(params().eq).toBeUndefined();
    expect(rowIds()).toHaveLength(3);
  });

  it("opens on the search and the state the address describes, as after Back from a details page", async () => {
    await openRoster(`${EMPLOYEES}&eq=worker&estate=ready`);
    expect((must("pcp-roster-search") as HTMLInputElement).value).toBe("worker");
    expect(rowIds()).toEqual(["PC-W2"]);
    expect(must("pcp-roster-filter-ready").getAttribute("aria-pressed")).toBe("true");
  });

  it("is not thrown by a state somebody typed by hand", async () => {
    await openRoster(`${EMPLOYEES}&estate=bogus`);
    expect(rowIds()).toHaveLength(3);
    expect(must("pcp-roster-filter-all").getAttribute("aria-pressed")).toBe("true");
  });

  it("says nobody matches, and clears the filters", async () => {
    await openRoster(`${EMPLOYEES}&eq=zzz&estate=paid`);
    expect(text(q("pcp-roster-no-match"))).toContain("No employee matches the search or status");
    click(must("pcp-roster-no-match").querySelector("button"));
    expect(params().eq).toBeUndefined();
    expect(params().estate).toBeUndefined();
    await waitFor(() => rowIds().length === 3, "the roster");
  });
});

describe("generating from the roster", () => {
  it("generates one employee on their own, and only people with nothing yet are offered it", async () => {
    await openRoster();
    expect(q("pcp-generate-PC-W1")).toBeNull(); // already has a payslip
    expect(q("pcp-generate-PC-N1")).toBeNull(); // blocked
    click(must("pcp-generate-PC-W2"));
    expect(h.trigger).toHaveBeenCalledTimes(1);
    expect(h.trigger).toHaveBeenCalledWith({
      cycle: "weekly",
      periodStart: "2026-02-02",
      periodEnd: "2026-02-08",
      employeeIds: [2],
      regenerate: false,
    });
    // the page keeps showing the period it was started for
    expect(params().period).toBe(WEEK_PARAM);
  });

  it("a pending payslip is generated again only after a confirmation that says what it replaces", async () => {
    await openRoster();
    click(must("pcp-regenerate-PC-W1"));
    const dialog = must("pcp-regenerate-dialog");
    expect(text(dialog)).toContain("Generate again for Asha Worker?");
    expect(text(dialog)).toContain("Anything you adjusted on it");
    expect(text(dialog)).toContain("2 Feb - 8 Feb 2026");
    expect(h.trigger).not.toHaveBeenCalled();
    click(must("pcp-regenerate-confirm"));
    expect(h.trigger).toHaveBeenCalledWith({
      cycle: "weekly",
      periodStart: "2026-02-02",
      periodEnd: "2026-02-08",
      employeeIds: [1],
      regenerate: true,
    });
  });

  it("cancelling the confirmation generates nothing", async () => {
    await openRoster();
    click(must("pcp-regenerate-PC-W1"));
    const cancel = [...must("pcp-regenerate-dialog").querySelectorAll("button")].find((b) => text(b) === "Cancel");
    click(cancel);
    await waitFor(() => !q("pcp-regenerate-dialog"), "the dialog to close");
    expect(h.trigger).not.toHaveBeenCalled();
  });

  it("a paid payslip offers no way to generate again", async () => {
    world.people = [
      person(1, "Asha Worker", "PC-W1", { payroll: payroll(11, 1, "Asha Worker", "PC-W1", { status: "paid" }) }),
    ];
    await openRoster();
    expect(text(q("pcp-roster-state-PC-W1"))).toBe("Paid");
    expect(q("pcp-regenerate-PC-W1")).toBeNull();
    expect(q("pcp-generate-PC-W1")).toBeNull();
    expect(q("pcp-roster-details-PC-W1")).not.toBeNull();
  });

  it("several ready employees can be generated together, and only the ready ones can be selected", async () => {
    world.people = [person(1, "Asha Worker", "PC-W1"), person(2, "Bala Worker", "PC-W2"), ESHA];
    await openRoster();
    expect(q("pcp-roster-select-PC-N1")).toBeNull();
    click(must("pcp-roster-select-PC-W1"));
    click(must("pcp-roster-select-PC-W2"));
    expect(text(q("pcp-roster-bulk"))).toContain("2 selected");
    click(must("pcp-generate-selected"));
    expect(h.trigger).toHaveBeenCalledWith({
      cycle: "weekly",
      periodStart: "2026-02-02",
      periodEnd: "2026-02-08",
      employeeIds: [1, 2],
      regenerate: false,
    });
    // the selection is cleared once the run starts
    expect(q("pcp-roster-bulk")).toBeNull();
  });

  it("selects every employee that can be generated at once, and clears the selection", async () => {
    world.people = [person(1, "Asha Worker", "PC-W1"), person(2, "Bala Worker", "PC-W2"), ESHA];
    await openRoster();
    click(must("pcp-roster-select-all"));
    expect(text(q("pcp-roster-bulk"))).toContain("2 selected");
    expect(text(q("pcp-roster-showing"))).toContain("2 can be generated");
    const clear = [...must("pcp-roster-bulk").querySelectorAll("button")].find((b) => text(b) === "Clear selection");
    click(clear);
    expect(q("pcp-roster-bulk")).toBeNull();
  });

  it("offers selection only for people who can be generated: nobody to select means no select-all", async () => {
    await openRoster(`${EMPLOYEES}&estate=blocked`);
    expect((must("pcp-roster-select-all") as HTMLButtonElement).disabled).toBe(true);
  });

  it("cannot generate for a period that has not ended yet", async () => {
    await openRoster(`${EMPLOYEES}&period=2099-01-05_2099-01-11`);
    expect(text(q("pcp-not-ended"))).toContain("5 Jan - 11 Jan 2099 has not ended yet");
    expect((must("pcp-generate-PC-W1") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pcp-roster-select-PC-W1") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pcp-roster-select-all") as HTMLButtonElement).disabled).toBe(true);
    click(must("pcp-generate-PC-W1"));
    expect(h.trigger).not.toHaveBeenCalled();
  });

  it("starts nothing more while a run is in progress", async () => {
    h.generating.current = true;
    await openRoster();
    expect((must("pcp-generate-PC-W2") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pcp-regenerate-PC-W1") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a View Only role can open the details but not generate", async () => {
    await openRoster();
    lockMutatingControls(document.body);
    expect((must("pcp-generate-PC-W2") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pcp-regenerate-PC-W1") as HTMLButtonElement).disabled).toBe(true);
    expect((must("pcp-roster-details-PC-W1") as HTMLButtonElement).disabled).toBe(false);
    expect((must("pcp-roster-filter-blocked") as HTMLButtonElement).disabled).toBe(false);
    expect((must("pcp-roster-search") as HTMLInputElement).disabled).toBe(false);
  });
});

describe("the roster of another period", () => {
  it("shows the people as ready again when nothing was generated for that period", async () => {
    await openRoster(`${EMPLOYEES}&period=2026-01-26_2026-02-01`);
    expect(text(q("pcp-roster-state-PC-W1"))).toBe("Not generated");
    expect(text(q("pcp-roster-state-PC-W2"))).toBe("Not generated");
    expect(text(q("pcp-roster-state-PC-N1"))).toBe("Cannot be generated");
    expect(text(q("pcp-roster-counts"))).toBe("3 on the Weekly cycle · 0 generated · 2 ready · 1 cannot be generated");
  });
});
