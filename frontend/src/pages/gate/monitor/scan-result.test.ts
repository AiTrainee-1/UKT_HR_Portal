import { describe, expect, it } from "vitest";
import { describeScan, formatApprover, kindLabel, OFFLINE_RESULT, recordTypeShort } from "./scan-result";
import { DUPLICATE_GUARD_MS, makeDuplicateGuard } from "./scanner";

describe("describeScan", () => {
  it("lets an exit, a return and a tea break through in their own colour and words", () => {
    expect(describeScan({ result: "success", message: "", scanType: "exit" })).toMatchObject({
      tone: "teal",
      title: "Allowed - exit recorded",
      kindLabel: "Exit",
      allowed: true,
    });
    expect(describeScan({ result: "success", message: "", scanType: "entry" })).toMatchObject({
      tone: "teal",
      title: "Welcome back - return recorded",
      kindLabel: "Return",
      voice: "Welcome back.",
    });
    expect(describeScan({ result: "success", message: "", action: "out" })).toMatchObject({
      tone: "amber",
      title: "Tea break started",
      kindLabel: "Tea break out",
    });
    expect(describeScan({ result: "success", message: "", action: "in", takenMinutes: 18 })).toMatchObject({
      tone: "amber",
      title: "Tea break ended - 18 min",
    });
  });

  it.each([
    ["already_scanned", "Denied - pass already used", "rose"],
    ["expired", "Denied - pass expired", "rose"],
    ["not_approved", "Denied - not approved", "rose"],
    ["not_exited", "Denied - has not gone out yet", "rose"],
    ["not_allowed_here", "Denied - not taken at this gate", "rose"],
    ["invalid_qr", "Code not recognised", "slate"],
  ])("%s is stopped: %s", (result, title, tone) => {
    const view = describeScan({ result, message: "m" });
    expect(view).toMatchObject({ title, tone, allowed: false });
    expect(view.voice.length).toBeGreaterThan(5);
  });

  it("never crashes on an answer it does not know (the old console did)", () => {
    expect(describeScan({ result: "something_new", message: "?" })).toMatchObject({
      title: "Check with HR",
      tone: "slate",
    });
    // an error body with no result at all (an expired session's {"error": ...})
    expect(describeScan({ error: "Invalid or expired token" } as never)).toMatchObject({ title: "Check with HR" });
    expect(describeScan(null)).toMatchObject({ title: "Check with HR", kindLabel: null });
    expect(describeScan(OFFLINE_RESULT)).toMatchObject({ title: "No connection", tone: "slate" });
  });

  it("names a refused tea-break scan as a tea break", () => {
    expect(kindLabel({ kind: "tea_break" })).toBe("Tea break");
    expect(kindLabel({})).toBeNull();
  });

  it("says a gate does not take tea-break scans for a refused tea-break code, and passes stay as they were", () => {
    const tea = describeScan({
      result: "not_allowed_here",
      kind: "tea_break",
      message: "This gate does not take tea-break scans.",
    });
    expect(tea).toMatchObject({
      tone: "rose",
      title: "Denied - no tea breaks at this gate",
      voice: "This gate does not take tea-break scans.",
      kindLabel: "Tea break",
      allowed: false,
    });
    const pass = describeScan({ result: "not_allowed_here", kind: "outpass", scanType: "exit", message: "x" });
    expect(pass).toMatchObject({ title: "Denied - not taken at this gate", kindLabel: "Exit" });
  });
});

describe("recordTypeShort", () => {
  it("reads a refused tea-break code (a denied tea_out record) as a tea break, never as an exit", () => {
    expect(recordTypeShort({ type: "tea_out", result: "denied" })).toBe("Tea break");
    expect(recordTypeShort({ type: "tea_out", result: "allowed" })).toBe("Tea out");
    expect(recordTypeShort({ type: "exit", result: "denied" })).toBe("Exit");
    expect(recordTypeShort({ type: "something_new" })).toBe("something_new");
  });
});

describe("formatApprover", () => {
  it("says who approved a pass the way the gate says it", () => {
    expect(formatApprover("hr", "Priya")).toBe("HR");
    expect(formatApprover("dept_head", "Joshy G")).toBe("HOD - Joshy G");
    expect(formatApprover("dept_head", null)).toBe("HOD");
    expect(formatApprover("system", null)).toBe("On-Duty approval");
    expect(formatApprover(null, "Someone")).toBe("Someone");
    expect(formatApprover(null, null)).toBeNull();
  });
});

describe("the duplicate guard", () => {
  it("drops the same code read again within 2 seconds, not a new code or a later read", () => {
    let now = 1_000;
    const accept = makeDuplicateGuard(DUPLICATE_GUARD_MS, () => now);
    expect(accept("P.A.B.C")).toBe(true);
    now += 500;
    expect(accept("P.A.B.C")).toBe(false);
    expect(accept("T.X.Y")).toBe(true);
    now += 100;
    expect(accept("P.A.B.C")).toBe(true); // another code came in between
    now += DUPLICATE_GUARD_MS;
    expect(accept("P.A.B.C")).toBe(true);
  });
});
