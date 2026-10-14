import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { lockMutatingControls } from "@/lib/view-only-lock";
import {
  apiError,
  bodiesOf,
  click,
  freezeClock,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  params,
  pickOption,
  q,
  settle,
  text,
  typeInto,
  unmountPage,
  waitFor,
  type World,
} from "../harness";

// OT Detection in jsdom with a fake server behind customFetch: the tiles, the two separate lists (Type 1 read-only, Type 2
// with its candidates and its history), the filters, the notices for what is switched off, and the Assign dialog: its modes,
// its shifts, the granted date limited to the OT month, its summary, its payload and the server's refusals.

const h = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn() }));

vi.mock("@/components/HrLayout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: h.toast }), toast: h.toast }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ token: "t", user: null }) }));
vi.mock("@/lib/api-client/custom-fetch", async (original) => ({
  ...(await original<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: h.fetch,
}));

let world: World;

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  freezeClock();
  world = installWorld(h.fetch);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
  vi.useRealTimers();
});

const OT = "/hr/compensation?tab=ot";
const ASSIGN = "/api/compensation/ot/assign";
const REJECT = "/api/compensation/ot/reject";

async function openOt(url = OT) {
  mountPage(url);
  await waitFor(() => !!q("ot-kpis"), "the OT tiles");
}

const ids = (testId: string) =>
  [...document.body.querySelectorAll(`[data-testid^="${testId}"]`)].map((e) =>
    e.getAttribute("data-testid")!.slice(testId.length),
  );
const button = (id: string) => must(id) as HTMLButtonElement;
const input = (id: string) => must(id) as HTMLInputElement;

/** Ticks the two candidates and opens the dialog. */
async function openAssign() {
  await openOt();
  click(must("ot2-select-E13-2026-10-05"));
  click(must("ot2-select-E11-2026-10-09"));
  click(must("ot2-assign"));
  await waitFor(() => !!q("assign-dialog"), "the Assign dialog");
}

describe("the tiles", () => {
  it("count Type 1 earned and used, Type 2 waiting, assigned and rejected", async () => {
    await openOt();
    expect(text(q("ot-kpi-earned-value"))).toBe("2");
    expect(text(q("ot-kpi-earned"))).toContain("1 h 30 min allowed in all");
    expect(text(q("ot-kpi-used-value"))).toBe("1");
    expect(text(q("ot-kpi-used"))).toContain("18 min used · 1 not used · 0 pending");
    expect(text(q("ot-kpi-waiting-value"))).toBe("2");
    expect(text(q("ot-kpi-waiting"))).toContain("1.25 shifts suggested");
    expect(text(q("ot-kpi-assigned-value"))).toBe("2");
    expect(text(q("ot-kpi-assigned"))).toContain("1.50 shifts · 1 relaxation, 1 payment");
    expect(text(q("ot-kpi-rejected-value"))).toBe("1");
  });

  it("shows the shape of the tiles while the month is on its way, then the figures", async () => {
    const release = world.hold("/api/compensation/ot");
    mountPage(OT);
    await waitFor(() => !!q("ot-tab"), "the tab");
    expect(q("skeleton-kpis")).not.toBeNull();
    expect(q("ot-kpis")).toBeNull();
    expect(text(q("ot-type2-loading"))).toContain("Loading");
    release();
    await waitFor(() => !!q("ot-kpis"), "the tiles");
    expect(q("skeleton-kpis")).toBeNull();
  });
});

describe("Type 1: the automatic next-day late-in allowance", () => {
  it("lists who worked past the shift end, the allowance and whether it was used", async () => {
    await openOt();
    const table = must("ot-type1-table");
    const asha = text(must("ot-type1-row-E11-2026-10-06"));
    expect(asha).toContain("Asha Kumar");
    expect(asha).toContain("6 Oct 2026");
    expect(asha).toContain("17:30");
    expect(asha).toContain("19:00");
    expect(asha).toContain("1 hour 30 minutes");
    expect(asha).toContain("30 min");
    expect(asha).toContain("Used on 7 Oct 2026 (18 min)");
    const bala = text(must("ot-type1-row-E12-2026-10-07"));
    expect(bala).toContain("2 hours"); // 120 minutes of extra work
    expect(bala).toContain("1 h"); // 60 minutes allowed
    expect(bala).toContain("Not used");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
  });

  it("says Pending, never Not used, while the next working day has not come, and counts it apart", async () => {
    world.ot.push({
      ...world.ot[1],
      id: 30,
      employeeId: 16,
      employeeCode: "E16",
      employeeName: "Farid Ali",
      date: "2026-10-13",
      allowanceStatus: "pending",
      allowanceUsed: false,
    });
    // a window won the day marker, but the allowance's minutes were used: the server says used although allowanceUsed is false
    world.ot.push({
      ...world.ot[1],
      id: 31,
      employeeId: 17,
      employeeCode: "E17",
      employeeName: "Gita Rao",
      date: "2026-10-08",
      allowanceStatus: "used",
      allowanceUsed: false,
      usedOn: "2026-10-09",
      usedMinutes: 12,
    });
    await openOt();
    const pending = must("ot-type1-use-E16-2026-10-13");
    expect(pending.getAttribute("data-status")).toBe("pending");
    expect(text(pending)).toBe("Pending");
    expect(text(pending)).not.toContain("Not used");
    expect(must("ot-type1-use-E12-2026-10-07").getAttribute("data-status")).toBe("not_used");
    expect(text(must("ot-type1-use-E17-2026-10-08"))).toBe("Used on 9 Oct 2026 (12 min)");
    expect(text(q("ot-kpi-earned-value"))).toBe("4");
    expect(text(q("ot-kpi-used-value"))).toBe("2");
    expect(text(q("ot-kpi-used"))).toContain("30 min used · 1 not used · 1 pending");
  });

  it("is read-only: no checkbox, no button, nothing to assign", async () => {
    await openOt();
    const card = must("ot-type1");
    expect(card.querySelectorAll('button[role="checkbox"], input[type="checkbox"]')).toHaveLength(0);
    const buttons = [...card.querySelectorAll("button")].map(text);
    expect(buttons.filter((b) => /assign|reject|announce/i.test(b))).toEqual([]);
    expect(text(card)).toContain("Automatic and unpaid");
    expect(text(card)).toContain("marks it as Compensation instead");
  });

  it("explains the rules in use, read from Settings", async () => {
    await openOt();
    await waitFor(() => text(q("rules-type1")).includes("Worked 1 hour"), "the rules");
    const rules = text(q("rules-type1"));
    expect(rules).toContain(
      "Worked 1 hour past the shift end: 30 minutes later on the next working day's first punch.",
    );
    expect(rules).toContain("Worked 2 hours past the shift end: 1 hour later");
    expect(rules).toContain("only up to 2 hours 30 minutes");
  });

  it("does not claim there are no rules when the rules cannot be read", async () => {
    world.failing.set("/api/compensation/config", { status: 500 });
    await openOt();
    await waitFor(() => !!q("rules-type1-error"), "the message");
    expect(text(q("rules-type1-error"))).toContain("The rules could not be loaded");
    expect(text(q("rules-type1"))).not.toContain("No Type 1 rule is switched on");
    expect(text(q("rules-type2-error"))).toContain("The rules could not be loaded");
  });

  it("says there is none, and why, for a month without an allowance", async () => {
    world.ot = world.ot.filter((r) => r.otType !== "allowance");
    await openOt();
    expect(text(q("ot-type1-empty"))).toContain("No allowance earned in this month");
    expect(q("ot-type1-table")).toBeNull();
  });
});

describe("Type 2: shift-based compensation", () => {
  it("lists the candidates with the suggested shifts, and a punch after midnight as the next day", async () => {
    await openOt();
    expect(ids("ot-type2-row-")).toEqual(["E13-2026-10-05", "E11-2026-10-09"]);
    const chitra = text(must("ot-type2-row-E13-2026-10-05"));
    expect(chitra).toContain("Chitra Devi");
    expect(chitra).toContain("21:30");
    expect(chitra).toContain("4 hours");
    expect(chitra).toContain("0.50 shifts");
    const asha = text(must("ot-type2-row-E11-2026-10-09"));
    expect(asha).toContain("01:00 (next day)");
    expect(asha).toContain("7 hours 30 minutes");
    expect(asha).toContain("0.75 shifts");
  });

  it("lists what was assigned or rejected, with how it was given", async () => {
    await openOt();
    expect(ids("ot-type2-history-row-")).toEqual(["E14-2026-10-02", "E12-2026-10-03"]);
    const assigned = text(must("ot-type2-history-row-E14-2026-10-02"));
    expect(assigned).toContain("Dev Anand");
    expect(assigned).toContain("0.50 shifts");
    expect(assigned).toContain("Relaxation on 12 Oct 2026");
    expect(assigned).toContain("Assigned");
    expect(assigned).toContain("by Meena");
    const rejected = text(must("ot-type2-history-row-E12-2026-10-03"));
    expect(rejected).toContain("Rejected");
  });

  it("filters the history by status", async () => {
    await openOt();
    pickOption(must("ot2-history-status"), "Rejected");
    expect(ids("ot-type2-history-row-")).toEqual(["E12-2026-10-03"]);
    expect(params().otstatus).toBe("rejected");
    pickOption(must("ot2-history-status"), "Assigned");
    expect(ids("ot-type2-history-row-")).toEqual(["E14-2026-10-02"]);
    pickOption(must("ot2-history-status"), "Assigned and rejected");
    expect(ids("ot-type2-history-row-")).toHaveLength(2);
    expect(params().otstatus).toBeUndefined();
  });

  it("explains how the suggested shifts are worked out, from the rules in Settings", async () => {
    await openOt();
    await waitFor(() => text(q("rules-type2")).includes("Last punch-out up to"), "the rules");
    const rules = text(q("rules-type2"));
    expect(rules).toContain("more than 2 hours 30 minutes past the shift end");
    expect(rules).toContain("Last punch-out up to 9:00 PM: 0.25 shift");
    expect(rules).toContain("Last punch-out up to 12:00 AM: 0.50 shifts");
    expect(rules).toContain("Any later punch-out: 1 shift");
  });

  it("has nothing to assign until a row is ticked, and counts the ticked rows", async () => {
    await openOt();
    expect(button("ot2-assign").disabled).toBe(true);
    expect(button("ot2-reject").disabled).toBe(true);
    expect(text(q("ot2-selected"))).toBe("0 selected");
    click(must("ot2-select-E13-2026-10-05"));
    expect(text(q("ot2-selected"))).toBe("1 selected");
    expect(button("ot2-assign").disabled).toBe(false);
    expect(text(button("ot2-assign"))).toBe("Assign (1)");
    click(must("ot2-select-all"));
    expect(text(q("ot2-selected"))).toBe("2 selected");
    click(must("ot2-select-all"));
    expect(text(q("ot2-selected"))).toBe("0 selected");
  });
});

describe("the Assign dialog", () => {
  it("offers Relaxation and Payment, starts on the suggested shifts, and needs a date for Relaxation", async () => {
    await openAssign();
    expect(must("assign-mode-relaxation").getAttribute("aria-checked")).toBe("true");
    expect(must("assign-mode-pay").getAttribute("aria-checked")).toBe("false");
    expect(text(must("assign-mode-pay"))).toContain("Payment is for Type 2 only");
    expect(must("assign-shifts-E13-2026-10-05-0.5").getAttribute("aria-checked")).toBe("true");
    expect(must("assign-shifts-E11-2026-10-09-0.75").getAttribute("aria-checked")).toBe("true");
    // the suggestion is named, not only coloured
    expect(must("assign-shifts-E13-2026-10-05-0.5").getAttribute("aria-label")).toBe("0.50 shifts, suggested");
    expect(text(q("assign-row-E13-2026-10-05"))).toContain("Suggested: 0.50 shifts");
    expect(button("assign-submit").disabled).toBe(true);
    expect(text(q("assign-problem-E13-2026-10-05"))).toBe("Choose the date the day off is granted.");
    expect(text(button("assign-submit"))).toBe("Assign 2 records");
  });

  it("limits every date to the month of the overtime", async () => {
    await openAssign();
    for (const id of ["assign-date-all", "assign-claim-E13-2026-10-05", "assign-claim-E11-2026-10-09"]) {
      expect(input(id).min).toBe("2026-10-01");
      expect(input(id).max).toBe("2026-10-31");
    }
    // a date typed outside the month is refused with the month named
    typeInto(input("assign-claim-E13-2026-10-05"), "2026-11-02");
    expect(text(q("assign-problem-E13-2026-10-05"))).toContain("must be in October 2026");
    expect(button("assign-submit").disabled).toBe(true);
    typeInto(input("assign-claim-E13-2026-10-05"), "2026-09-30");
    expect(text(q("assign-problem-E13-2026-10-05"))).toContain("must be in October 2026");
    typeInto(input("assign-claim-E13-2026-10-05"), "2026-10-31");
    expect(q("assign-problem-E13-2026-10-05")).toBeNull();
  });

  it("takes one date for everyone, then a different one for a single row", async () => {
    await openAssign();
    typeInto(input("assign-date-all"), "2026-10-12");
    expect(input("assign-claim-E13-2026-10-05").value).toBe("2026-10-12");
    expect(input("assign-claim-E11-2026-10-09").value).toBe("2026-10-12");
    typeInto(input("assign-claim-E11-2026-10-09"), "2026-10-20");
    expect(input("assign-claim-E13-2026-10-05").value).toBe("2026-10-12");
    expect(button("assign-submit").disabled).toBe(false);
  });

  it("says what will happen: a relaxation tops the day up, a payment adds shifts × the daily rate to that month's payslip", async () => {
    await openAssign();
    typeInto(input("assign-date-all"), "2026-10-12");
    expect(text(q("assign-row-E13-2026-10-05"))).toContain(
      "12 Oct 2026 is topped up by 0.50 shifts (a day never goes above 1 shift).",
    );
    expect(text(q("assign-summary"))).toContain("2 records for 2 employees, 1.25 shifts in all.");
    expect(text(q("assign-summary"))).toContain("Relaxation: each granted day's attendance is topped up");
    click(must("assign-mode-pay"));
    expect(must("assign-mode-pay").getAttribute("aria-checked")).toBe("true");
    expect(text(q("assign-row-E13-2026-10-05"))).toContain(
      "0.50 shifts × the daily rate is added to the October 2026 payslip as OT pay.",
    );
    expect(text(q("assign-summary"))).toContain("Payment: each record adds its shifts × the employee's daily rate");
  });

  it("does not need a date for Payment", async () => {
    await openAssign();
    click(must("assign-mode-pay"));
    expect(button("assign-submit").disabled).toBe(false);
    click(must("assign-submit"));
    await waitFor(() => bodiesOf(world, "POST", ASSIGN).length === 1, "the request");
    expect(bodiesOf(world, "POST", ASSIGN)[0]).toEqual({
      mode: "pay",
      records: [
        { employeeId: 13, date: "2026-10-05", shifts: 0.5 },
        { employeeId: 11, date: "2026-10-09", shifts: 0.75 },
      ],
    });
  });

  it("sends the mode, every record's own shifts and date, then closes and moves the rows into the history", async () => {
    await openAssign();
    typeInto(input("assign-date-all"), "2026-10-12");
    click(must("assign-shifts-E11-2026-10-09-0.5")); // HR changes the suggestion
    click(must("assign-submit"));
    await waitFor(() => bodiesOf(world, "POST", ASSIGN).length === 1, "the request");
    expect(bodiesOf(world, "POST", ASSIGN)[0]).toEqual({
      mode: "relaxation",
      records: [
        { employeeId: 13, date: "2026-10-05", shifts: 0.5, claimDate: "2026-10-12" },
        { employeeId: 11, date: "2026-10-09", shifts: 0.5, claimDate: "2026-10-12" },
      ],
    });
    await waitFor(() => !q("assign-dialog"), "the dialog to close");
    await waitFor(() => !!q("ot-type2-history-row-E13-2026-10-05"), "the rows in the history");
    expect(q("ot-type2-row-E13-2026-10-05")).toBeNull();
    expect(text(q("ot-type2-history-row-E11-2026-10-09"))).toContain("Relaxation on 12 Oct 2026");
    expect(text(q("ot-kpi-waiting-value"))).toBe("0");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Assigned 2 records" }));
    expect(text(q("ot2-selected"))).toBe("0 selected");
  });

  it("offers only the modes switched on in Settings", async () => {
    world.otConfig.payEnabled = false;
    await openAssign();
    expect(q("assign-mode-relaxation")).not.toBeNull();
    expect(q("assign-mode-pay")).toBeNull();
    unmountPage();

    world.otConfig = { ...world.otConfig, payEnabled: true, relaxationEnabled: false };
    await openAssign();
    expect(q("assign-mode-relaxation")).toBeNull();
    expect(q("assign-mode-pay")).not.toBeNull();
    expect(must("assign-mode-pay").getAttribute("aria-checked")).toBe("true");
  });

  it("keeps a record the server refuses, with the reason under it, and assigns the others", async () => {
    world.on.set(`POST ${ASSIGN}`, () => ({
      assigned: 1,
      results: [{ ...world.ot.find((r) => r.id === 3)!, status: "announced", statusLabel: "Assigned" }],
      skipped: [
        { employeeId: 11, date: "2026-10-09", reason: "E11 on 09 Oct 2026: the date is a Sunday, already a day off." },
      ],
    }));
    await openAssign();
    typeInto(input("assign-date-all"), "2026-10-12");
    click(must("assign-submit"));
    await waitFor(() => !!q("assign-problem-E11-2026-10-09"), "the refusal");
    expect(text(q("assign-problem-E11-2026-10-09"))).toBe(
      "E11 on 09 Oct 2026: the date is a Sunday, already a day off.",
    );
    // the dialog stays, with the refused row only
    expect(q("assign-dialog")).not.toBeNull();
    expect(q("assign-row-E13-2026-10-05")).toBeNull();
    expect(text(button("assign-submit"))).toBe("Assign 1 record");
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Assigned 1; 1 could not be assigned", variant: "destructive" }),
    );
    // changing the refused row clears its reason
    typeInto(input("assign-claim-E11-2026-10-09"), "2026-10-13");
    expect(q("assign-problem-E11-2026-10-09")).toBeNull();
  });

  it("shows the server's sentence and every refusal when nothing could be assigned", async () => {
    world.on.set(`POST ${ASSIGN}`, () =>
      apiError(400, {
        error: "E13 on 05 Oct 2026: it is already assigned.",
        assigned: 0,
        skipped: [
          { employeeId: 13, date: "2026-10-05", reason: "E13 on 05 Oct 2026: it is already assigned." },
          { employeeId: 11, date: "2026-10-09", reason: "E11 on 09 Oct 2026: at most 0.25 can be added to that day." },
        ],
      }),
    );
    await openAssign();
    typeInto(input("assign-date-all"), "2026-10-12");
    click(must("assign-submit"));
    await waitFor(() => !!q("assign-error"), "the error");
    expect(text(q("assign-error"))).toBe("E13 on 05 Oct 2026: it is already assigned.");
    expect(text(q("assign-problem-E13-2026-10-05"))).toContain("already assigned");
    expect(text(q("assign-problem-E11-2026-10-09"))).toContain("at most 0.25");
    expect(q("assign-dialog")).not.toBeNull();
  });

  it("closes without sending anything on Cancel", async () => {
    await openAssign();
    const cancel = [...must("assign-dialog").querySelectorAll("button")].find((b) => text(b) === "Cancel")!;
    click(cancel);
    await waitFor(() => !q("assign-dialog"), "the dialog to close");
    expect(bodiesOf(world, "POST", ASSIGN)).toEqual([]);
    // the ticks are still there
    expect(text(q("ot2-selected"))).toBe("2 selected");
  });
});

describe("Reject", () => {
  it("asks first, then rejects the ticked rows and moves them to the history", async () => {
    await openOt();
    click(must("ot2-select-E13-2026-10-05"));
    click(must("ot2-reject"));
    await waitFor(() => !!q("reject-dialog"), "the confirmation");
    expect(text(q("reject-dialog"))).toContain("Reject 1 record?");
    expect(text(q("reject-dialog"))).toContain("cannot be put back");
    expect(bodiesOf(world, "POST", REJECT)).toEqual([]);
    click(must("reject-confirm"));
    await waitFor(() => bodiesOf(world, "POST", REJECT).length === 1, "the request");
    expect(bodiesOf(world, "POST", REJECT)[0]).toEqual({ records: [{ employeeId: 13, date: "2026-10-05" }] });
    await waitFor(() => !!q("ot-type2-history-row-E13-2026-10-05"), "the row in the history");
    expect(text(q("ot-type2-history-row-E13-2026-10-05"))).toContain("Rejected");
    expect(text(q("ot-kpi-rejected-value"))).toBe("2");
  });

  it("changes nothing when the question is answered No", async () => {
    await openOt();
    click(must("ot2-select-E13-2026-10-05"));
    click(must("ot2-reject"));
    await waitFor(() => !!q("reject-dialog"), "the confirmation");
    click([...must("reject-dialog").querySelectorAll("button")].find((b) => text(b) === "Keep them waiting"));
    await waitFor(() => !q("reject-dialog"), "the dialog to close");
    expect(bodiesOf(world, "POST", REJECT)).toEqual([]);
    expect(q("ot-type2-row-E13-2026-10-05")).not.toBeNull();
  });
});

describe("the filters", () => {
  it("search all the lists by name, code or department, and keep the search in the address", async () => {
    await openOt();
    typeInto(input("ot-search"), "asha");
    expect(params().otq).toBe("asha");
    expect(ids("ot-type1-row-")).toEqual(["E11-2026-10-06"]);
    expect(ids("ot-type2-row-")).toEqual(["E11-2026-10-09"]);
    expect(q("ot-type2-history-table")).toBeNull();
    // the tiles still count the whole month
    expect(text(q("ot-kpi-earned-value"))).toBe("2");
    click(must("ot-reset"));
    expect(params().otq).toBeUndefined();
    expect(ids("ot-type1-row-")).toHaveLength(2);
  });

  it("narrow to one department", async () => {
    await openOt();
    pickOption(must("ot-dept"), "Cutting");
    expect(params().otdept).toBe("Cutting");
    expect(ids("ot-type1-row-")).toEqual(["E12-2026-10-07"]);
    expect(q("ot-type2-table")).toBeNull();
    expect(text(q("ot-type2-empty"))).toContain("No candidate matches these filters");
    expect(ids("ot-type2-history-row-")).toEqual(["E14-2026-10-02", "E12-2026-10-03"]);
  });

  it("restores the filters from the address", async () => {
    await openOt(`${OT}&otq=chitra`);
    expect(input("ot-search").value).toBe("chitra");
    expect(ids("ot-type2-row-")).toEqual(["E13-2026-10-05"]);
  });

  it("asks the server for another month and shows its empty state", async () => {
    await openOt();
    pickOption(must("ot-month"), "September");
    expect(params().month).toBe("9");
    await waitFor(() => world.requests().some((r) => r.includes("month=9&year=2026")), "the request");
    await waitFor(() => !!q("ot-type1-empty"), "the empty state");
    expect(text(q("ot-type2-empty"))).toContain("Nothing is waiting for HR");
    expect(text(q("ot-kpi-earned-value"))).toBe("0");
  });
});

describe("what is switched off in Settings", () => {
  it("says Type 1 is off, with a link to its switch, and keeps the rows readable", async () => {
    world.otConfig.allowanceEnabled = false;
    await openOt();
    const notice = must("ot-type1-off");
    expect(text(notice)).toContain("Type 1 (next-day late-in allowance) is switched off");
    expect(notice.querySelector("a")!.getAttribute("href")).toBe("/hr/settings?tab=compensation#allowance-enabled");
    expect(ids("ot-type1-row-")).toHaveLength(2);
    // assigning Type 2 is not affected
    click(must("ot2-select-E13-2026-10-05"));
    expect(button("ot2-assign").disabled).toBe(false);
  });

  it("says Type 2 is off and pauses assigning and rejecting, with the reason on the buttons", async () => {
    world.otConfig.shiftEnabled = false;
    await openOt();
    expect(text(q("ot-type2-off"))).toContain("Type 2 (shift-based compensation) is switched off");
    expect(must("ot-type2-off").querySelector("a")!.getAttribute("href")).toBe(
      "/hr/settings?tab=compensation#shift-enabled",
    );
    click(must("ot2-select-E13-2026-10-05"));
    for (const id of ["ot2-assign", "ot2-reject"]) {
      expect(button(id).disabled).toBe(true);
      expect(button(id).title).toMatch(
        /Type 2 \(shift-based compensation\) is switched off in Settings → Compensation/,
      );
    }
    // everything stays readable
    expect(ids("ot-type2-row-")).toHaveLength(2);
    expect(ids("ot-type2-history-row-")).toHaveLength(2);
  });

  it("says neither Relaxation nor Payment is on", async () => {
    world.otConfig.relaxationEnabled = false;
    world.otConfig.payEnabled = false;
    await openOt();
    expect(text(q("ot-modes-off"))).toContain("Neither Relaxation nor Payment is switched on");
    click(must("ot2-select-E13-2026-10-05"));
    expect(button("ot2-assign").disabled).toBe(true);
    expect(button("ot2-assign").title).toMatch(/neither Relaxation nor Payment/);
  });

  it("pauses every change when the master switch is off, and says so on the buttons", async () => {
    world.settings.compensationFeatureEnabled = false;
    world.otConfig.masterEnabled = false;
    await openOt();
    // the master switch has its own notice at the top of the page, so the tab adds none of its own
    expect(q("ot-type1-off")).toBeNull();
    expect(q("ot-type2-off")).toBeNull();
    await waitFor(() => !!q("compensation-features-off"), "the master notice");
    click(must("ot2-select-E13-2026-10-05"));
    for (const id of ["ot2-assign", "ot2-reject", "ot-legacy-pay", "ot-legacy-relaxation", "ot-legacy-reject"]) {
      expect(button(id).disabled).toBe(true);
      expect(button(id).title).toMatch(/switched off in Settings/);
    }
    expect(ids("ot-type2-row-")).toHaveLength(2);
  });
});

describe("earlier records, with their old meaning", () => {
  it("lists them with what they gave", async () => {
    await openOt();
    expect(ids("ot-legacy-row-")).toEqual(["E15-2026-10-01", "E15-2026-10-08"]);
    const announced = text(must("ot-legacy-row-E15-2026-10-01"));
    expect(announced).toContain("Announced");
    expect(announced).toContain("Payment: one day's pay");
    expect(text(must("ot-legacy-row-E15-2026-10-08"))).toContain("Detected");
  });

  it("lets a record still waiting be announced under the old meaning, or rejected", async () => {
    await openOt();
    const row = must("ot-legacy-row-E15-2026-10-08");
    click(row.querySelector('button[role="checkbox"]'));
    click(must("ot-legacy-pay"));
    await waitFor(() => bodiesOf(world, "POST", "/api/compensation/ot/announce").length === 1, "the request");
    expect(bodiesOf(world, "POST", "/api/compensation/ot/announce")[0]).toEqual({
      records: [{ employeeId: 15, date: "2026-10-08" }],
      compensationType: "pay",
    });
  });

  it("is not shown when there are none", async () => {
    world.ot = world.ot.filter((r) => r.otType !== "legacy");
    await openOt();
    expect(q("ot-legacy")).toBeNull();
  });
});

describe("loading, errors and the view-only lock", () => {
  it("shows an error with a Retry when the month cannot be read, then the month", async () => {
    world.failing.set("/api/compensation/ot", { status: 500 });
    mountPage(OT);
    await waitFor(() => !!q("ot-error"), "the error");
    expect(text(q("ot-error"))).toContain("Could not load the overtime records");
    expect(q("ot-kpis")).toBeNull();
    world.failing.clear();
    click([...must("ot-error").querySelectorAll("button")].find((b) => text(b) === "Retry"));
    await waitFor(() => !!q("ot-kpis"), "the tiles");
    expect(q("ot-error")).toBeNull();
  });

  it("locks every changing button for a View Only role, and leaves the filters and the lists alone", async () => {
    await openOt();
    click(must("ot2-select-E13-2026-10-05"));
    lockMutatingControls(document.body);
    await settle();
    expect(button("ot2-assign").disabled).toBe(true);
    expect(button("ot2-reject").disabled).toBe(true);
    expect(button("ot-legacy-pay").disabled).toBe(true);
    // browsing stays open
    expect(input("ot-search").disabled).toBe(false);
    expect((must("ot-month") as HTMLButtonElement).disabled).toBe(false);
    expect((must("ot2-history-status") as HTMLButtonElement).disabled).toBe(false);
    expect((document.body.querySelector('button[role="checkbox"]') as HTMLButtonElement).disabled).toBe(false);
  });
});
