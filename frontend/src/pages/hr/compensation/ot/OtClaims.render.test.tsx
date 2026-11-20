import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OvertimeClaim, OvertimeRow } from "@/lib/api-client/custom-hooks";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { ot } from "../fixtures";
import {
  apiError,
  bodiesOf,
  click,
  freezeClock,
  installBrowserStubs,
  installWorld,
  mountPage,
  must,
  nestedTab,
  params,
  pickOption,
  q,
  settle,
  text,
  typeInto,
  unmountPage,
  waitFor,
  type Call,
  type World,
} from "../harness";

// OT Detection under the claim workflow (2026-11-19), in jsdom with a fake server: from the claims date (5 Oct 2026 here)
// a Type 1 allowance and a Type 2 credit are given only after a claim is approved by the employee's Department Head; HR
// claims for an employee here ("Claim for employee"), may still pay a Type 2 record, and a record is paid or credited,
// never both. Records before the claims date keep the old rules side by side.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  // the signed-in login (null: not an HR role, so every right): a test sets an HR role with its permissions
  user: { current: null as { role: "hr"; employeeId: null; permissions: Record<string, string> } | null },
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

const FROM = "2026-10-05";
const OT_PAGE = "/hr/compensation/ot-detection";
const T1 = `${OT_PAGE}/type-1/allowance`;
const T1_HOW = `${OT_PAGE}/type-1/how`;
const T2 = `${OT_PAGE}/type-2/waiting`;
const T2_HOW = `${OT_PAGE}/type-2/how`;
const CLAIMS = "/api/compensation/claims";
const ASSIGN = "/api/compensation/ot/assign";

const claim = (over: Partial<OvertimeClaim>): OvertimeClaim => ({
  id: 700,
  kind: "ot_allowance",
  status: "pending",
  shifts: null,
  minutes: 30,
  raisedByRole: "hr",
  ...over,
});

const person = (id: number, name: string, over: Partial<OvertimeRow>): OvertimeRow =>
  ot(id, { employeeId: id, employeeCode: `E${id}`, employeeName: name, ...over });

/** October 2026, claims from 5 Oct: a Type 1 and a Type 2 record before that date, and claim-workflow records after it. */
function claimMonth(): OvertimeRow[] {
  return [
    // Type 1 before the claims date: automatic
    person(21, "Ravi Kumar", { date: "2026-10-01", allowanceStatus: "used", usedOn: "2026-10-02", usedMinutes: 15 }),
    // Type 1 under the claim workflow
    person(22, "Sita Devi", { date: "2026-10-06", allowanceStatus: "not_used", claimable: true, claim: null }),
    person(23, "Tara Singh", {
      date: "2026-10-08",
      allowanceStatus: "not_used",
      claimable: false,
      claim: claim({ id: 701, raisedByRole: "employee" }),
    }),
    person(24, "Uma Nair", {
      date: "2026-10-13",
      allowanceMinutes: 60,
      allowanceStatus: "pending",
      appliesOn: "2026-10-15",
      claimable: false,
      claim: claim({ id: 702, status: "approved", minutes: 60 }),
    }),
    person(25, "Vel Murugan", { date: "2026-10-09", allowanceStatus: "not_used", claimable: true, claim: null }),
    // Type 2 before the claims date: HR decides, the ladder's suggestion
    person(31, "Kavya Iyer", {
      date: "2026-10-02",
      otType: "shift",
      lastPunchOut: "21:30",
      otMinutes: 240,
      allowanceMinutes: 0,
      suggestedShifts: 0.5,
      status: "detected",
      statusLabel: "Detected",
      allowanceUsed: null,
      canAssign: true,
    }),
    // Type 2 under the claim workflow: a punch at 02:10 the next morning, a whole shift by the quarters rule
    person(32, "Lokesh Rao", {
      date: "2026-10-09",
      otType: "shift",
      lastPunchOut: "02:10",
      lastPunchNextDay: true,
      otMinutes: 520,
      allowanceMinutes: 0,
      suggestedShifts: 0.75,
      creditShifts: 1,
      shiftMinutes: 480,
      status: "detected",
      statusLabel: "Detected",
      allowanceUsed: null,
      canAssign: true,
      claimable: true,
      claim: null,
    }),
    person(33, "Meera Pillai", {
      date: "2026-10-10",
      otType: "shift",
      lastPunchOut: "21:30",
      otMinutes: 240,
      allowanceMinutes: 0,
      suggestedShifts: 0.5,
      creditShifts: 0.5,
      shiftMinutes: 480,
      status: "detected",
      statusLabel: "Detected",
      allowanceUsed: null,
      canAssign: true,
      claimable: false,
      claim: claim({ id: 703, kind: "ot_shift", shifts: 0.5, minutes: null, raisedByRole: "employee" }),
    }),
    person(34, "Nikhil Das", {
      date: "2026-10-07",
      otType: "shift",
      lastPunchOut: "23:00",
      otMinutes: 330,
      allowanceMinutes: 0,
      suggestedShifts: 0.5,
      creditShifts: 0.5,
      status: "detected",
      statusLabel: "Detected",
      allowanceUsed: null,
      canAssign: false,
      claimable: false,
      claim: claim({ id: 704, kind: "ot_shift", status: "approved", shifts: 0.5, minutes: null }),
    }),
  ];
}

let world: World;
let nextClaim = 900;

/** The server's claim endpoint: every item becomes a pending claim on its OT record. */
function acceptClaims(call: Call) {
  const body = call.body as {
    kind: string;
    items: { employeeId: number; overtimeRecordId: number; shifts?: number }[];
  };
  const claims = body.items.map((item) => {
    const row = world.ot.find((r) => r.id === item.overtimeRecordId)!;
    const made = claim({
      id: nextClaim++,
      kind: body.kind,
      shifts: item.shifts ?? null,
      minutes: body.kind === "ot_allowance" ? row.allowanceMinutes : null,
    });
    row.claim = made;
    row.claimable = false;
    return { ...made, employeeId: item.employeeId, overtimeRecordId: item.overtimeRecordId };
  });
  return { created: claims.length, claims, warnings: [] };
}

beforeAll(installBrowserStubs);

beforeEach(() => {
  vi.clearAllMocks();
  freezeClock();
  h.user.current = null;
  nextClaim = 900;
  world = installWorld(h.fetch);
  world.ot = claimMonth();
  world.config.claims = { from: FROM };
  world.on.set(`POST ${CLAIMS}`, acceptClaims);
});

afterEach(() => {
  expect(world.unexpected).toEqual([]);
  unmountPage();
  vi.useRealTimers();
});

async function open(url: string) {
  mountPage(url);
  await waitFor(() => !!q("ot-kpis"), "the OT tiles");
  // the claims date comes from the Compensation settings
  await waitFor(() => text(q("ot-footnote")).includes("Claims apply from 5 Oct 2026"), "the claims date");
}

const button = (id: string) => must(id) as HTMLButtonElement;
const reason = () => must("claim-reason") as HTMLTextAreaElement;
const status = (id: string) => must(`ot-type1-use-${id}`);

describe("Type 1 under the claim workflow", () => {
  it("shows each allowance's status: automatic before the claims date, then claimable, pending, approved for its day", async () => {
    await open(T1);
    expect(status("E21-2026-10-01").getAttribute("data-status")).toBe("used");
    expect(text(must("ot-type1-row-E21-2026-10-01"))).toContain("Automatic");
    expect(text(status("E22-2026-10-06"))).toBe("Claimable");
    expect(text(status("E23-2026-10-08"))).toBe("Claim pending");
    expect(text(status("E24-2026-10-13"))).toBe("Approved · applies on 15 Oct 2026");
    // the claim of a record, who raised it, and a link to it in the Claims list
    const pending = must("ot-type1-claim-E23-2026-10-08");
    expect(text(pending)).toContain("Raised by the employee");
    expect(pending.querySelector("a")!.getAttribute("href")).toBe(
      "/hr/compensation/compensation-leave/holiday-work/claims?hmonth=all&hemp=23&hclaim=701",
    );
    // only a claimable row has a Claim button and a tick box
    expect(q("ot1-claim-E22-2026-10-06")).not.toBeNull();
    expect(q("ot1-claim-E23-2026-10-08")).toBeNull();
    expect(q("ot1-select-E23-2026-10-08")).toBeNull();
    expect(q("ot1-select-E21-2026-10-01")).toBeNull();
    // the description says it is no longer automatic, and from when
    expect(text(q("ot-type1"))).toContain("From 5 Oct 2026 an allowance is given only after a claim");
    // the tile counts what can be claimed and what is with the HOD
    expect(text(q("ot-kpi-earned"))).toContain("2 claimable · 1 with the HOD");
  });

  it("filters by status, keeps it in the address, and Reset clears it", async () => {
    await open(T1);
    pickOption(must("ot1-status"), "Claimable");
    expect(params().ot1status).toBe("claimable");
    expect(
      [...document.body.querySelectorAll('[data-testid^="ot-type1-row-"]')].map((r) => r.getAttribute("data-testid")),
    ).toEqual(["ot-type1-row-E22-2026-10-06", "ot-type1-row-E25-2026-10-09"]);
    pickOption(must("ot1-status"), "Approved");
    expect(q("ot-type1-row-E24-2026-10-13")).not.toBeNull();
    expect(q("ot-type1-row-E22-2026-10-06")).toBeNull();
    click(must("ot-reset"));
    expect(params().ot1status).toBeUndefined();
    expect(document.body.querySelectorAll('[data-testid^="ot-type1-row-"]')).toHaveLength(5);
  });

  it("claims one allowance for the employee: a reason first, then the request, then it waits for the HOD", async () => {
    await open(T1);
    click(must("ot1-claim-E22-2026-10-06"));
    await waitFor(() => !!q("claim-dialog"), "the Claim dialog");
    expect(text(q("claim-dialog"))).toContain("next working day after the OT date");
    expect(text(q("claim-row-E22-2026-10-06"))).toContain("30 min");
    // no reason: nothing is sent, and the dialog says why
    click(must("claim-submit"));
    await settle();
    expect(bodiesOf(world, "POST", CLAIMS)).toEqual([]);
    expect(text(q("claim-dialog"))).toContain("Give a reason");
    typeInto(reason(), "Stock count after the shift");
    click(must("claim-submit"));
    await waitFor(() => bodiesOf(world, "POST", CLAIMS).length === 1, "the request");
    expect(bodiesOf(world, "POST", CLAIMS)[0]).toEqual({
      kind: "ot_allowance",
      date: "2026-10-06",
      reason: "Stock count after the shift",
      items: [{ employeeId: 22, overtimeRecordId: 22 }],
    });
    await waitFor(() => !q("claim-dialog"), "the dialog to close");
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Sent 1 claim to the Department Head" }));
    await waitFor(() => text(status("E22-2026-10-06")) === "Claim pending", "the row to read Claim pending");
    expect(must("ot-type1-claim-E22-2026-10-06").querySelector("a")!.getAttribute("href")).toContain("hclaim=900");
    expect(q("ot1-claim-E22-2026-10-06")).toBeNull();
  });

  it("claims several at once, one request per OT date, and keeps a date the server refuses with its reason", async () => {
    world.on.set(`POST ${CLAIMS}`, (call) => {
      const body = call.body as { date: string };
      if (body.date === "2026-10-09") {
        return apiError(409, { error: "Vel Murugan has no Department Head to approve it.", code: "no_hod" });
      }
      return acceptClaims(call);
    });
    await open(T1);
    click(must("ot1-select-all"));
    expect(text(q("ot1-selected"))).toBe("2 selected");
    click(must("ot1-claim"));
    await waitFor(() => !!q("claim-dialog"), "the Claim dialog");
    typeInto(reason(), "Month-end audit");
    click(must("claim-submit"));
    await waitFor(() => !!q("claim-problem-E25-2026-10-09"), "the refusal");
    expect(bodiesOf(world, "POST", CLAIMS).map((b) => b.date)).toEqual(["2026-10-06", "2026-10-09"]);
    expect(text(q("claim-problem-E25-2026-10-09"))).toBe("Vel Murugan has no Department Head to approve it.");
    expect(text(q("claim-error"))).toContain("no Department Head");
    // the claimed one left the dialog; the refused one stays
    expect(q("claim-row-E22-2026-10-06")).toBeNull();
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Sent 1; 1 could not be claimed", variant: "destructive" }),
    );
  });

  it("pauses claiming while Type 1 is switched off, with the reason on the buttons", async () => {
    world.otConfig.allowanceEnabled = false;
    await open(T1);
    expect(button("ot1-claim-E22-2026-10-06").disabled).toBe(true);
    expect(button("ot1-claim-E22-2026-10-06").title).toMatch(/Type 1 .* switched off in Settings → Compensation/);
    expect(must("ot1-pause").querySelector("a")!.getAttribute("href")).toBe(
      "/hr/settings?tab=compensation#allowance-enabled",
    );
  });

  it("locks claiming for a View Only role and leaves the filters alone", async () => {
    await open(T1);
    click(must("ot1-select-E22-2026-10-06"));
    lockMutatingControls(document.body);
    await settle();
    expect(button("ot1-claim").disabled).toBe(true);
    expect(button("ot1-claim-E22-2026-10-06").disabled).toBe(true);
    expect((must("ot1-status") as HTMLButtonElement).disabled).toBe(false);
  });

  it("explains the workflow and the date it started under How it is worked out", async () => {
    await open(T1_HOW);
    const how = text(q("ot-type1-how"));
    expect(how).toContain("Claimed.");
    expect(how).toContain("Approved by the Department Head.");
    expect(how).toContain("Applied to the next working day after the OT date.");
    expect(text(q("ot1-how-before"))).toContain("This applies from 5 Oct 2026");
  });
});

describe("Claim for employee needs Edit on Leave > Holiday work > Claims", () => {
  const NEEDS = "Needs Edit on Compensation > Leave > Holiday work > Claims";
  /** An HR role that may change OT Detection (and Birthdays) but only look at the Claims sub-tab. */
  const viewClaimsOnly = () => {
    h.user.current = {
      role: "hr",
      employeeId: null,
      permissions: { compensation: "edit", "compensation.leave.holiday_work.claims": "view" },
    };
  };

  it("greys out Type 1's Claim buttons, naming the right, for a role that may only view Claims", async () => {
    viewClaimsOnly();
    await open(T1);
    click(must("ot1-select-E22-2026-10-06"));
    expect(button("ot1-claim").disabled).toBe(true);
    expect(button("ot1-claim").title).toBe(NEEDS);
    expect(button("ot1-claim-E22-2026-10-06").disabled).toBe(true);
    expect(button("ot1-claim-E22-2026-10-06").title).toBe(NEEDS);
    click(must("ot1-claim-E22-2026-10-06"));
    await settle();
    expect(q("claim-dialog")).toBeNull();
  });

  it("greys out Type 2's Claim buttons the same way, and leaves Pay to HR's own right", async () => {
    viewClaimsOnly();
    await open(T2);
    click(must("ot2-select-E32-2026-10-09"));
    expect(button("ot2-claim").disabled).toBe(true);
    expect(button("ot2-claim").title).toBe(NEEDS);
    expect(button("ot2-claim-E32-2026-10-09").disabled).toBe(true);
    expect(button("ot2-claim-E32-2026-10-09").title).toBe(NEEDS);
    expect(button("ot2-assign").disabled).toBe(false);
  });

  it("keeps them for a role with Edit on Claims (set on the key itself or inherited)", async () => {
    h.user.current = {
      role: "hr",
      employeeId: null,
      permissions: {
        compensation: "view",
        "compensation.ot": "edit",
        "compensation.leave.holiday_work.claims": "edit",
      },
    };
    await open(T1);
    expect(button("ot1-claim-E22-2026-10-06").disabled).toBe(false);
    unmountPage();
    h.user.current = { role: "hr", employeeId: null, permissions: { compensation: "edit" } };
    await open(T1);
    expect(button("ot1-claim-E22-2026-10-06").disabled).toBe(false);
  });
});

describe("the threshold under the quarters rule", () => {
  it("says in the footnote that the threshold decides only the days before the claims date or with the rule off", async () => {
    world.config.shift = { ...world.config.shift, quarterRule: true };
    await open(T2);
    await waitFor(() => text(q("ot-footnote")).includes("quarters rule"), "the quarters rule in the footnote");
    expect(text(q("ot-footnote"))).toContain(
      "Type 2 threshold: 2 hours 30 minutes past the shift end, used only for days before 5 Oct 2026 or with the quarters rule off; from then Type 2 starts at a quarter of the employee's shift.",
    );
  });

  it("names the claims date in the server's words when only the settings know it", async () => {
    world.config.shift = { ...world.config.shift, quarterRule: true };
    world.config.claims = { from: FROM, fromText: "5 Oct 2026" };
    await open(T1);
    expect(text(q("ot-footnote"))).toContain("used only for days before 5 Oct 2026 or with the quarters rule off");
  });

  it("leaves the footnote as it was while the quarters rule is off", async () => {
    world.config.shift = { ...world.config.shift, quarterRule: false };
    await open(T2);
    expect(text(q("ot-footnote"))).toContain(
      "Type 2 threshold: 2 hours 30 minutes past the shift end. Claims apply from",
    );
    expect(text(q("ot-footnote"))).not.toContain("quarters rule");
  });
});

describe("Type 2 under the claim workflow", () => {
  it("shows the next-morning punch, the credit in quarters of the shift, and where each claim stands", async () => {
    await open(T2);
    const lokesh = text(must("ot-type2-row-E32-2026-10-09"));
    expect(lokesh).toContain("02:10 next day");
    expect(lokesh).toContain("8 hours 40 minutes");
    expect(text(must("ot2-credit-E32-2026-10-09"))).toBe(
      "1 shift8 hours 40 minutes over a shift of 8 hours, in quarters",
    );
    expect(text(must("ot2-claim-state-E32-2026-10-09"))).toBe("Claimable");
    // the record before the claims date: HR decides, on the ladder's suggestion
    expect(text(must("ot2-claim-state-E31-2026-10-02"))).toBe("HR decides");
    expect(text(must("ot2-credit-E31-2026-10-02"))).toBe("0.50 shifts");
    // a claimed record waits for the HOD and cannot be ticked (paid or rejected)
    expect(text(must("ot-type2-claim-E33-2026-10-10"))).toContain("Claim pending");
    const locked = button("ot2-select-E33-2026-10-10");
    expect(locked.disabled).toBe(true);
    expect(locked.title).toMatch(/Claimed: waiting for the Department Head/);
    // the credited record is not waiting any more
    expect(q("ot-type2-row-E34-2026-10-07")).toBeNull();
    expect(text(q("ot-kpi-waiting"))).toContain("1 with the HOD");
    expect(text(q("ot-kpi-assigned"))).toContain("1 credited by claim");
  });

  it("claims the credit for the employee, starting on the quarters-rule credit", async () => {
    await open(T2);
    click(must("ot2-claim-E32-2026-10-09"));
    await waitFor(() => !!q("claim-dialog"), "the Claim dialog");
    expect(must("claim-shifts-E32-2026-10-09-1").getAttribute("aria-checked")).toBe("true");
    expect(must("claim-shifts-E32-2026-10-09-1").getAttribute("aria-label")).toBe("1 shift, suggested");
    expect(text(q("claim-row-E32-2026-10-09"))).toContain("added to the compensation balance");
    click(must("claim-shifts-E32-2026-10-09-0.75")); // HR claims less
    typeInto(reason(), "Night dispatch");
    click(must("claim-submit"));
    await waitFor(() => bodiesOf(world, "POST", CLAIMS).length === 1, "the request");
    expect(bodiesOf(world, "POST", CLAIMS)[0]).toEqual({
      kind: "ot_shift",
      date: "2026-10-09",
      reason: "Night dispatch",
      items: [{ employeeId: 32, overtimeRecordId: 32, shifts: 0.75 }],
    });
    await waitFor(() => !!q("ot-type2-claim-E32-2026-10-09"), "the claim on the row");
    expect(button("ot2-select-E32-2026-10-09").disabled).toBe(true);
  });

  it("keeps HR's Pay for a record under the claim workflow (Payment only), and both modes for an earlier one", async () => {
    await open(T2);
    click(must("ot2-select-E32-2026-10-09"));
    expect(text(button("ot2-assign"))).toBe("Pay (1)");
    click(must("ot2-assign"));
    await waitFor(() => !!q("assign-dialog"), "the dialog");
    expect(q("assign-mode-relaxation")).toBeNull();
    expect(must("assign-mode-pay").getAttribute("aria-checked")).toBe("true");
    click(must("assign-submit"));
    await waitFor(() => bodiesOf(world, "POST", ASSIGN).length === 1, "the request");
    expect(bodiesOf(world, "POST", ASSIGN)[0]).toEqual({
      mode: "pay",
      records: [{ employeeId: 32, date: "2026-10-09", shifts: 0.75 }],
    });
    unmountPage();

    await open(T2);
    click(must("ot2-select-E31-2026-10-02"));
    expect(text(button("ot2-assign"))).toBe("Assign (1)");
    click(must("ot2-assign"));
    await waitFor(() => !!q("assign-dialog"), "the dialog");
    expect(q("assign-mode-relaxation")).not.toBeNull();
    expect(q("assign-mode-pay")).not.toBeNull();
  });

  it("will not pay a record under the claim workflow while Payment is off, and says why", async () => {
    world.otConfig.payEnabled = false;
    await open(T2);
    click(must("ot2-select-E32-2026-10-09"));
    expect(button("ot2-assign").disabled).toBe(true);
    expect(button("ot2-assign").title).toMatch(/Payment is switched off/);
    // claiming still works, and so does Relaxation for the earlier record
    expect(button("ot2-claim").disabled).toBe(false);
    click(must("ot2-select-E32-2026-10-09"));
    click(must("ot2-select-E31-2026-10-02"));
    expect(button("ot2-assign").disabled).toBe(false);
  });

  it("lists a record credited by an approved claim as decided, with its claim", async () => {
    await open(T2);
    click(nestedTab("ot-type2-nested", "assigned"));
    await waitFor(() => !!q("ot-type2-history-table"), "the history");
    const row = text(must("ot-type2-history-row-E34-2026-10-07"));
    expect(row).toContain("Credited to the balance (claim by HR)");
    expect(row).toContain("0.50 shifts");
    expect(row).toContain("Claim approved");
    pickOption(must("ot2-history-status"), "Credited by claim");
    expect(params().otstatus).toBe("credited");
    expect(document.body.querySelectorAll('[data-testid^="ot-type2-history-row-"]')).toHaveLength(1);
  });

  it("explains the quarters rule, the claim and the pay under How it is worked out", async () => {
    await open(T2_HOW);
    const steps = text(q("ot2-how-steps"));
    expect(steps).toContain("02:10 next day");
    expect(steps).toContain("rounded down to a quarter, at most 1.00");
    expect(steps).toContain("One record is paid or credited, never both.");
    expect(text(q("ot2-how-before"))).toContain("This applies from 5 Oct 2026");
  });
});
