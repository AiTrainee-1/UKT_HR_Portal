import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { OvertimeClaim, OvertimeConfig, OvertimeRow } from "@/lib/api-client/custom-hooks";
import { OT_CONFIG, OT_ROWS } from "../fixtures";
import {
  assignModesFor,
  assignedText,
  canClaim,
  checkOtClaim,
  claimChip,
  claimFailure,
  claimHref,
  claimPause,
  claimRequests,
  claimsFromOf,
  creditBasis,
  creditText,
  filterHistory,
  filterType1,
  groupOt,
  inClaimFlow,
  initialClaimRows,
  otKpis,
  shiftsOf,
  type1State,
  type2ClaimState,
  type2Lock,
} from "./ot-logic";

// The claim workflow on OT Detection (2026-11-19) as pure functions: which records are under it (from the claims date),
// where a Type 1 allowance and a Type 2 record stand, the tiles and groups with claims, what can be ticked, paid or
// claimed, and what the Claim dialog checks and sends. Records before the claims date keep the old rules.

const FROM = "2026-10-07";
const row = (id: number) => OT_ROWS.find((r) => r.id === id)!;
const config = (over: Partial<OvertimeConfig> = {}): OvertimeConfig => ({ ...OT_CONFIG, ...over });
const claim = (over: Partial<OvertimeClaim> = {}): OvertimeClaim => ({
  id: 501,
  kind: "ot_allowance",
  status: "pending",
  shifts: null,
  minutes: 30,
  raisedByRole: "hr",
  ...over,
});
/** A Type 1 allowance on or after the claims date. */
const t1 = (over: Partial<OvertimeRow> = {}): OvertimeRow => ({
  ...row(2),
  id: 40,
  date: "2026-10-07",
  allowanceStatus: "pending",
  claimable: true,
  claim: null,
  ...over,
});
/** A Type 2 record on or after the claims date, credit 0.50 by the quarters rule. */
const t2 = (over: Partial<OvertimeRow> = {}): OvertimeRow => ({
  ...row(3),
  id: 41,
  date: "2026-10-09",
  claimable: true,
  claim: null,
  creditShifts: 0.5,
  ...over,
});

describe("the claims date", () => {
  it("is read from the first source that names a day", () => {
    expect(claimsFromOf(undefined, null, "2026-11-19")).toBe("2026-11-19");
    expect(claimsFromOf("2026-11-19T00:00:00+05:30")).toBe("2026-11-19");
    expect(claimsFromOf("", "not a date")).toBeNull();
    expect(claimsFromOf()).toBeNull();
  });

  it("puts a record under the claim workflow from that day, or when it is already claimed", () => {
    expect(inClaimFlow({ date: "2026-10-07", claim: null }, FROM)).toBe(true);
    expect(inClaimFlow({ date: "2026-10-06", claim: null }, FROM)).toBe(false);
    expect(inClaimFlow({ date: "2026-10-06", claim: claim() }, FROM)).toBe(true);
    // the date is not known (an older settings answer): the row's own flag decides
    expect(inClaimFlow({ date: "2026-10-04", claimable: true }, null)).toBe(true);
    expect(inClaimFlow({ date: "2026-10-04" }, null)).toBe(false);
  });

  it("links a claim to the Claims list, opened on it", () => {
    expect(claimHref({ id: 77 }, 12)).toBe(
      "/hr/compensation/compensation-leave/holiday-work/claims?hmonth=all&hemp=12&hclaim=77",
    );
  });
});

describe("Type 1: where an allowance stands", () => {
  it("keeps the automatic meaning before the claims date", () => {
    expect(type1State(row(1), FROM)).toMatchObject({ status: "used", text: "Used on 7 Oct 2026 (18 min)" });
    expect(type1State({ ...row(2), date: "2026-10-04" }, FROM)).toMatchObject({ status: "not_used", text: "Not used" });
    expect(type1State({ ...row(2), date: "2026-10-04", allowanceStatus: "pending" }, FROM).status).toBe("pending");
  });

  it("is claimable, then pending with the HOD, then approved for its day, then used or not used", () => {
    expect(type1State(t1(), FROM)).toMatchObject({ status: "claimable", text: "Claimable" });
    expect(type1State(t1({ claim: claim() }), FROM)).toMatchObject({ status: "claim_pending", text: "Claim pending" });
    expect(type1State(t1({ claim: claim({ status: "approved" }), appliesOn: "2026-10-08" }), FROM)).toMatchObject({
      status: "approved",
      text: "Approved · applies on 8 Oct 2026",
    });
    expect(type1State(t1({ claim: claim({ status: "approved" }) }), FROM).text).toBe(
      "Approved · applies on the next working day",
    );
    const used = t1({
      claim: claim({ status: "approved" }),
      allowanceStatus: "used",
      usedOn: "2026-10-08",
      usedMinutes: 20,
    });
    expect(type1State(used, FROM)).toMatchObject({ status: "used", text: "Used on 8 Oct 2026 (20 min)" });
    expect(type1State(t1({ claim: claim({ status: "approved" }), allowanceStatus: "not_used" }), FROM)).toMatchObject({
      status: "not_used",
      text: "Approved · not used",
    });
  });

  it("says a rejected claim, a rejected claim that can be claimed again, and one nobody claimed in time", () => {
    expect(type1State(t1({ claim: claim({ status: "rejected" }), claimable: false }), FROM)).toMatchObject({
      status: "rejected",
      text: "Claim rejected",
    });
    expect(type1State(t1({ claim: claim({ status: "rejected" }) }), FROM)).toMatchObject({
      status: "claimable",
      text: "Claim rejected · claimable",
    });
    // never "Not used" for an allowance that was never given
    expect(type1State(t1({ claimable: false, allowanceStatus: "not_used" }), FROM)).toMatchObject({
      status: "unclaimed",
      text: "Not claimed",
    });
  });

  it("filters by status; Approved also holds an automatic allowance whose day has not come", () => {
    const rows = [
      row(1),
      t1({ id: 50 }),
      t1({ id: 51, claim: claim() }),
      t1({ id: 52, claim: claim({ status: "approved" }) }),
      { ...row(2), id: 53, date: "2026-10-04", allowanceStatus: "pending" as const },
    ];
    expect(filterType1(rows, "claimable", FROM).map((r) => r.id)).toEqual([50]);
    expect(filterType1(rows, "claim_pending", FROM).map((r) => r.id)).toEqual([51]);
    expect(filterType1(rows, "approved", FROM).map((r) => r.id)).toEqual([52, 53]);
    expect(filterType1(rows, "used", FROM).map((r) => r.id)).toEqual([1]);
    expect(filterType1(rows, "all", FROM)).toHaveLength(5);
    expect(filterType1(rows, "nonsense", FROM)).toHaveLength(5);
  });
});

describe("Type 2: claims, credits and pay", () => {
  it("keeps a claimed record waiting until it is approved, then lists it as decided (credited)", () => {
    const pending = t2({ claim: claim({ kind: "ot_shift", shifts: 0.5 }) });
    const approved = t2({ id: 42, claim: claim({ kind: "ot_shift", status: "approved", shifts: 0.5 }) });
    const rejectedClaim = t2({ id: 43, claim: claim({ kind: "ot_shift", status: "rejected", shifts: 0.5 }) });
    const groups = groupOt([pending, approved, rejectedClaim]);
    expect(groups.waiting.map((r) => r.id)).toEqual([41, 43]);
    expect(groups.history.map((r) => r.id)).toEqual([42]);
    expect(filterHistory(groups.history, "credited").map((r) => r.id)).toEqual([42]);
    expect(filterHistory(groups.history, "assigned")).toEqual([]);
    expect(assignedText(approved)).toBe("Credited to the balance (claim by HR)");
    expect(shiftsOf(approved)).toBe(0.5);
  });

  it("cannot tick a claimed record: it is paid or credited, never both", () => {
    expect(type2Lock(t2())).toBeNull();
    expect(type2Lock(t2({ claim: claim({ status: "pending" }) }))).toMatch(/cannot be paid or rejected/);
    expect(type2Lock(t2({ claim: claim({ status: "approved" }) }))).toMatch(/cannot be paid as well/);
    expect(type2Lock(t2({ claim: claim({ status: "rejected" }) }))).toBeNull();
    expect(canClaim(t2({ claim: claim({ status: "pending" }) }))).toBe(false);
    expect(canClaim(t2({ claim: claim({ status: "rejected" }) }))).toBe(true);
    expect(canClaim(t2({ claimable: false }))).toBe(false);
  });

  it("offers only Payment for a record under the claim workflow, both modes for an earlier one", () => {
    const modes = ["relaxation", "pay"] as const;
    expect(assignModesFor([...modes], [row(3)], "2026-10-06")).toEqual(["relaxation", "pay"]);
    expect(assignModesFor([...modes], [t2()], FROM)).toEqual(["pay"]);
    expect(assignModesFor([...modes], [row(3), t2()], FROM)).toEqual(["pay"]);
    expect(assignModesFor(["relaxation"], [t2()], FROM)).toEqual([]);
    // no claims date known and no claim fields: the old way
    expect(assignModesFor([...modes], [row(3)], null)).toEqual(["relaxation", "pay"]);
  });

  it("says where a waiting record stands in the claim workflow", () => {
    expect(type2ClaimState(row(3), "2026-10-06")).toMatchObject({ status: "hr", text: "HR decides" });
    expect(type2ClaimState(t2(), FROM)).toMatchObject({ status: "claimable", text: "Claimable" });
    expect(type2ClaimState(t2({ claim: claim() }), FROM).status).toBe("claim_pending");
    expect(type2ClaimState(t2({ claimable: false }), FROM)).toMatchObject({ text: "Not claimable" });
  });

  it("shows the quarters-rule credit, how it was worked out, and the ladder's suggestion for an older record", () => {
    expect(creditText(t2())).toBe("0.50 shifts");
    expect(creditText(t2({ creditShifts: null }))).toBe("Below a quarter");
    expect(creditText(row(3))).toBe("0.50 shifts"); // the older suggestion
    expect(creditBasis(t2({ otMinutes: 240, shiftMinutes: 480 }))).toBe("4 hours over a shift of 8 hours, in quarters");
    expect(creditBasis(t2())).toBe("Quarters of the employee's shift, rounded down");
    expect(creditBasis(row(3))).toBeNull();
  });

  it("never reads a record before the claims date (creditShifts null, ladder rule) as below a quarter", () => {
    // what the server sends for a Type 2 record before the claims date, or with the quarters rule switched off
    const old = { ...row(3), creditShifts: null, creditRule: "ladder" as const, claimRules: false };
    expect(creditText(old)).toBe("0.50 shifts");
    expect(creditBasis(old)).toBeNull();
    expect(initialClaimRows([old])[0]).toMatchObject({ credit: 0.5, shifts: 0.5 });
    // no creditRule (this build's first answers): claimRules false says the same
    expect(creditText({ ...row(3), creditShifts: null, claimRules: false })).toBe("0.50 shifts");
    // the quarters rule with nothing to give is still "Below a quarter"
    expect(creditText(t2({ creditShifts: null, creditRule: "quarters" }))).toBe("Below a quarter");
  });

  it("says why a record cannot be claimed when the server names the reason", () => {
    const why = "No Department Head may approve this employee's claims.";
    expect(type2ClaimState(t2({ claimable: false, claimProblem: why }), FROM).title).toBe(
      `${why} HR can still pay or reject it.`,
    );
  });
});

describe("the Type 2 waiting tile", () => {
  it("adds the ladder suggestion of the records before the claims date (their creditShifts is null)", () => {
    const before = { ...row(3), id: 90, creditShifts: null, creditRule: "ladder" as const, claimRules: false };
    const after = t2({ id: 91, creditRule: "quarters" });
    const kpis = otKpis([before, after], FROM);
    expect(kpis.waiting).toBe(2);
    expect(kpis.waitingSuggestedShifts).toBe((before.suggestedShifts ?? 0) + 0.5);
    expect(kpis.waitingSuggestedShifts).toBeGreaterThan(0.5);
  });
});

describe("the tiles with claims", () => {
  it("count claimable and pending allowances apart from used ones, and credited Type 2 with the given ones", () => {
    const rows = [
      row(1), // automatic, used
      t1({ id: 60 }), // claimable
      t1({ id: 61, claim: claim() }), // with the HOD
      t1({ id: 62, claim: claim({ status: "approved" }), allowanceStatus: "pending" }), // approved, day to come
      t2({ id: 63, claim: claim({ kind: "ot_shift" }) }), // waiting, with the HOD
      t2({ id: 64, claim: claim({ kind: "ot_shift", status: "approved", shifts: 0.75 }) }), // credited
      row(5), // assigned relaxation 0.50
    ];
    const k = otKpis(rows, FROM);
    expect([k.allowanceEarned, k.allowanceUsed, k.allowanceClaimable, k.allowanceClaimPending]).toEqual([4, 1, 1, 1]);
    expect([k.allowanceNotUsed, k.allowancePending]).toEqual([0, 1]);
    expect([k.waiting, k.waitingClaimPending, k.waitingSuggestedShifts]).toEqual([1, 1, 0.5]);
    expect([k.assigned, k.assignedShifts, k.credited, k.creditedShifts]).toEqual([1, 0.5, 1, 0.75]);
  });
});

describe("what can be claimed right now", () => {
  it("pauses claiming with the master switch first, then the type's own switch; the two modes do not matter", () => {
    expect(claimPause(config(), false, 1)).toBeNull();
    expect(claimPause(config({ relaxationEnabled: false, payEnabled: false }), false, 2)).toBeNull();
    expect(claimPause(config(), true, 2)?.reason).toMatch(/Settings → Payroll/);
    expect(claimPause(config({ allowanceEnabled: false }), false, 1)).toMatchObject({ setting: "allowance-enabled" });
    expect(claimPause(config({ allowanceEnabled: false }), false, 2)).toBeNull();
    expect(claimPause(config({ shiftEnabled: false }), false, 2)).toMatchObject({ setting: "shift-enabled" });
    expect(claimPause(undefined, false, 1)).toBeNull();
  });
});

describe("the Claim dialog", () => {
  it("starts a Type 2 claim on the credit, and Type 1 on the allowance", () => {
    const [a, b] = initialClaimRows([t2(), t2({ id: 44, creditShifts: null, employeeId: 99, employeeCode: "E99" })]);
    expect(a).toMatchObject({ recordId: 41, credit: 0.5, shifts: 0.5, date: "2026-10-09" });
    expect(b).toMatchObject({ credit: null, shifts: null });
    expect(initialClaimRows([t1()])[0]).toMatchObject({ recordId: 40, allowanceMinutes: 60 });
  });

  it("needs the shifts for Type 2 and a reason for both", () => {
    const rows = initialClaimRows([t2(), t2({ id: 44, creditShifts: null, employeeId: 99, employeeCode: "E99" })]);
    const check = checkOtClaim("ot_shift", rows, "");
    expect(check.ok).toBe(false);
    expect(check.first).toBe("Choose the shifts for every record.");
    expect(Object.keys(check.problems)).toEqual(["99|2026-10-09"]);
    const ok = checkOtClaim("ot_shift", [rows[0]], "  Stock count  ");
    expect(ok).toMatchObject({ ok: true, first: null });
    expect(checkOtClaim("ot_allowance", initialClaimRows([t1()]), " ").reasonProblem).toMatch(/Give a reason/);
    expect(checkOtClaim("ot_allowance", initialClaimRows([t1()]), "x".repeat(501)).reasonProblem).toMatch(
      /at most 500/,
    );
    expect(checkOtClaim("ot_allowance", [], "Stock").first).toBe("There is nothing left to claim.");
  });

  it("sends one request per OT date, in date order, with the record of each employee", () => {
    const rows = initialClaimRows([
      t2({ id: 70, date: "2026-10-12", employeeId: 1 }),
      t2({ id: 71, date: "2026-10-09", employeeId: 2 }),
      t2({ id: 72, date: "2026-10-12", employeeId: 3, creditShifts: 1 }),
    ]);
    expect(claimRequests("ot_shift", rows, " Audit ")).toEqual([
      {
        kind: "ot_shift",
        date: "2026-10-09",
        reason: "Audit",
        items: [{ employeeId: 2, overtimeRecordId: 71, shifts: 0.5 }],
      },
      {
        kind: "ot_shift",
        date: "2026-10-12",
        reason: "Audit",
        items: [
          { employeeId: 1, overtimeRecordId: 70, shifts: 0.5 },
          { employeeId: 3, overtimeRecordId: 72, shifts: 1 },
        ],
      },
    ]);
    // Type 1 sends only the record: the server reads the allowance from it
    expect(claimRequests("ot_allowance", initialClaimRows([t1()]), "Late stock")[0].items).toEqual([
      { employeeId: 12, overtimeRecordId: 40 },
    ]);
  });

  it("reads the server's refusal: its sentence and the employees it names", () => {
    const err = (status: number, body: unknown) =>
      new ApiError(new Response(null, { status }), body, { method: "POST", url: "/api/compensation/claims" });
    expect(claimFailure(err(409, { error: "E12 has no Department Head.", code: "no_hod" }))).toEqual({
      message: "E12 has no Department Head.",
      problems: [],
    });
    expect(claimFailure(err(400, { problems: [{ employeeId: 12, error: "Already claimed." }] }))).toEqual({
      message: "Already claimed.",
      problems: [{ employeeId: 12, error: "Already claimed." }],
    });
    expect(claimFailure(err(403, null)).message).toBe("Your login is not allowed to claim for employees.");
    expect(claimFailure(new Error("network")).message).toMatch(/could not be sent/);
  });

  it("names who raised a claim and where it stands", () => {
    expect(claimChip(claim())).toMatchObject({ text: "Claim pending", tone: "warning" });
    expect(claimChip(claim({ status: "approved", raisedByRole: "employee", hodName: "Ravi" }))).toEqual({
      text: "Claim approved",
      tone: "success",
      title: "Raised by the employee; approved by Ravi.",
    });
    expect(claimChip(claim({ status: "rejected" })).tone).toBe("danger");
  });
});
