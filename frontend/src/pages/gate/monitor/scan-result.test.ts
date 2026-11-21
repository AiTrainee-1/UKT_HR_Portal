import { describe, expect, it } from "vitest";
import type { GateScanResult } from "@/lib/api-client/custom-hooks/gate-monitor";
import {
  cooldownDeadline,
  cooldownLine,
  describeScan,
  fmtCountdown,
  formatApprover,
  kindLabel,
  OFFLINE_RESULT,
  recordTypeShort,
  teaOverMinutes,
} from "./scan-result";
import { DUPLICATE_GUARD_MS, makeDuplicateGuard } from "./scanner";

// 10:05 and 10:10 in India (+05:30), as the server writes them
const LAST_SCAN = "2026-11-21T04:35:00Z";
const RETRY_AT = "2026-11-21T04:40:00Z";
const COOLDOWN: GateScanResult = {
  result: "cooldown",
  kind: "tea_break",
  lastAction: "out",
  lastScanAt: LAST_SCAN,
  retryAt: RETRY_AT,
  waitSeconds: 212,
  cooldownMinutes: 5,
  message: "Already scanned at 10:05 (tea break started). Scan again after 10:10.",
  employee: { id: 1, name: "Priya S", employeeCode: "30111", department: "Weaving", photoUrl: null },
};

describe("describeScan: what the page turns and says for each answer", () => {
  it("lets a gate pass exit and return through in green, with a check", () => {
    expect(describeScan({ result: "success", message: "", scanType: "exit" })).toMatchObject({
      tone: "green",
      glyph: "check",
      title: "Allowed - exit recorded",
      kindLabel: "Exit",
      voice: "Approved. You may go.",
      note: null,
      allowed: true,
    });
    expect(describeScan({ result: "success", message: "", scanType: "entry" })).toMatchObject({
      tone: "green",
      glyph: "check",
      title: "Welcome back - return recorded",
      kindLabel: "Return",
      voice: "Welcome back.",
      allowed: true,
    });
  });

  it("starts a tea break in green and ends one in the return colour, never the same", () => {
    const out = describeScan({ result: "success", message: "", action: "out" });
    expect(out).toMatchObject({
      tone: "green",
      glyph: "check",
      title: "Tea break started",
      kindLabel: "Tea break out",
      voice: "Tea break started.",
      allowed: true,
    });
    const back = describeScan({ result: "success", message: "", action: "in", takenMinutes: 12 });
    expect(back).toMatchObject({
      tone: "return",
      glyph: "return",
      title: "Back from tea break - 12 min",
      kindLabel: "Tea break in",
      voice: "Tea break ended. Welcome back.",
      note: null,
      allowed: true,
    });
    expect(back.tone).not.toBe(out.tone);
    // the minutes are left out when the server did not send them
    expect(describeScan({ result: "success", message: "", action: "in" }).title).toBe("Back from tea break");
  });

  it("warns when a tea break went over the allowed time (still the return colour)", () => {
    const view = describeScan({ result: "success", message: "", action: "in", takenMinutes: 18, allowedMinutes: 15 });
    expect(view).toMatchObject({
      tone: "return",
      title: "Back from tea break - 18 min",
      note: { text: "Over the allowed 15 min by 3 min", warn: true },
      voice: "Tea break ended. Over the allowed time.",
    });
    // on time, or exactly at the limit: no warning
    expect(
      describeScan({ result: "success", message: "", action: "in", takenMinutes: 15, allowedMinutes: 15 }).note,
    ).toBe(null);
  });

  it.each([
    ["already_scanned", "Denied - pass already used", "orange", "warn"],
    ["expired", "Denied - pass expired", "orange", "warn"],
    ["not_exited", "Denied - has not gone out yet", "orange", "warn"],
    ["not_approved", "Denied - not approved", "red", "cross"],
    ["not_allowed_here", "Denied - not taken at this gate", "red", "cross"],
    ["invalid_qr", "Code not recognised", "red", "cross"],
  ])("%s is stopped: %s (%s)", (result, title, tone, glyph) => {
    const view = describeScan({ result, message: "m" });
    expect(view).toMatchObject({ title, tone, glyph, allowed: false });
    expect(view.voice.length).toBeGreaterThan(5);
  });

  it("answers a repeat tea-break scan inside the cooldown in orange, with when to scan again", () => {
    expect(describeScan(COOLDOWN)).toEqual({
      tone: "orange",
      glyph: "wait",
      title: "Already scanned - please wait",
      kindLabel: "Tea break",
      note: { text: "Already scanned at 10:05 - tea break started. Scan again after 10:10.", warn: false },
      voice: "Already scanned. Please wait.",
      allowed: false,
    });
    // a scan just after coming back: the line says so
    expect(describeScan({ ...COOLDOWN, lastAction: "in" }).note?.text).toBe(
      "Already scanned at 10:05 - back from tea break. Scan again after 10:10.",
    );
    // without the times the server's own words are shown; without anything, no line
    expect(describeScan({ result: "cooldown", message: "Wait a little." }).note?.text).toBe("Wait a little.");
    expect(describeScan({ result: "cooldown", message: "" }).note).toBeNull();
  });

  it("never crashes on an answer it does not know (the old console did), and shows it grey", () => {
    expect(describeScan({ result: "something_new", message: "?" })).toMatchObject({
      title: "Check with HR",
      tone: "neutral",
      glyph: "unknown",
    });
    // an error body with no result at all (an expired session's {"error": ...})
    expect(describeScan({ error: "Invalid or expired token" } as never)).toMatchObject({ title: "Check with HR" });
    expect(describeScan(null)).toMatchObject({ title: "Check with HR", kindLabel: null });
  });

  it("shows no connection in grey: it is not an answer to the scan", () => {
    expect(describeScan(OFFLINE_RESULT)).toMatchObject({
      title: "No connection",
      tone: "neutral",
      glyph: "offline",
      voice: "No connection. Please try again.",
    });
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
      tone: "red",
      title: "Denied - no tea breaks at this gate",
      voice: "This gate does not take tea-break scans.",
      kindLabel: "Tea break",
      allowed: false,
    });
    const pass = describeScan({ result: "not_allowed_here", kind: "outpass", scanType: "exit", message: "x" });
    expect(pass).toMatchObject({ title: "Denied - not taken at this gate", kindLabel: "Exit", tone: "red" });
  });
});

describe("the cooldown's helpers", () => {
  it("writes the line in India time from the answer's times", () => {
    expect(cooldownLine(COOLDOWN)).toBe("Already scanned at 10:05 - tea break started. Scan again after 10:10.");
    expect(cooldownLine({ message: "  " })).toBeNull();
  });

  it("counts down from waitSeconds on this kiosk's clock, else from retryAt", () => {
    const answeredAt = new Date("2026-11-21T09:00:00Z");
    expect(cooldownDeadline({ waitSeconds: 212, retryAt: RETRY_AT }, answeredAt)).toBe(answeredAt.getTime() + 212_000);
    expect(cooldownDeadline({ retryAt: RETRY_AT }, answeredAt)).toBe(Date.parse(RETRY_AT));
    expect(cooldownDeadline({ waitSeconds: 30 }, null)).toBeNull();
    expect(cooldownDeadline({ retryAt: "not a time" }, answeredAt)).toBeNull();
  });

  it("writes the countdown as minutes and seconds, never below zero", () => {
    expect(fmtCountdown(212)).toBe("3:32");
    expect(fmtCountdown(59.2)).toBe("1:00");
    expect(fmtCountdown(9)).toBe("0:09");
    expect(fmtCountdown(0)).toBe("0:00");
    expect(fmtCountdown(-4)).toBe("0:00");
  });

  it("tells how far a tea break went over the allowed minutes", () => {
    expect(teaOverMinutes({ takenMinutes: 18, allowedMinutes: 15 })).toBe(3);
    expect(teaOverMinutes({ takenMinutes: 12, allowedMinutes: 15 })).toBeNull();
    expect(teaOverMinutes({ takenMinutes: 18 })).toBeNull();
    expect(teaOverMinutes({})).toBeNull();
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
