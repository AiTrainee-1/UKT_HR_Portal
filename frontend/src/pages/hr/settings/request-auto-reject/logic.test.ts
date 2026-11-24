import { describe, expect, it } from "vitest";
import {
  addDays,
  countsText,
  dayText,
  indiaDay,
  parseDays,
  plural,
  rejectedOnDay,
  ruleSentence,
  runText,
  stampText,
  validateDays,
} from "./logic";

const KINDS = [
  { key: "leave", label: "Leave" },
  { key: "permission", label: "Permission" },
  { key: "missing_punch", label: "Missing Punch" },
];

describe("Auto-Reject Requests logic", () => {
  it("says the rule in one plain sentence, resignations always excluded", () => {
    expect(ruleSentence(45)).toBe(
      "Requests nobody decided within 45 days of being submitted are rejected automatically every night. Resignations are never rejected automatically.",
    );
    expect(ruleSentence(1)).toContain("within 1 day of");
    expect(ruleSentence(30, false)).toMatch(/^Switched off: nothing is rejected automatically\. When on: .*30 days/);
  });

  it("takes whole numbers of days in range only", () => {
    const limits = { min: 7, max: 365 };
    expect(parseDays(" 45 ")).toBe(45);
    expect(parseDays("4.5")).toBeNull();
    expect(parseDays("")).toBeNull();
    expect(validateDays("45", limits)).toBeUndefined();
    expect(validateDays("7", limits)).toBeUndefined();
    expect(validateDays("365", limits)).toBeUndefined();
    expect(validateDays("6", limits)).toBe("Between 7 and 365 days.");
    expect(validateDays("366", limits)).toBe("Between 7 and 365 days.");
    expect(validateDays("abc", limits)).toBe("Enter a whole number of days (7 to 365).");
  });

  it("works out the night a request is rejected: more than N days after the day it was submitted", () => {
    expect(addDays("2026-10-10", 45)).toBe("2026-11-24");
    // submitted 10 Oct with 45 days: still waits on 24 Nov (exactly 45), rejected in the run of 25 Nov
    expect(rejectedOnDay("2026-10-10", 45)).toBe("2026-11-25");
    expect(rejectedOnDay("2026-12-31", 7)).toBe("2027-01-08");
  });

  it("writes days and instants in India time", () => {
    expect(dayText("2026-10-03")).toBe("3 Oct 2026");
    // 20:30 UTC is the next morning in India
    expect(indiaDay("2026-11-23T20:30:00Z")).toBe("2026-11-24");
    expect(stampText("2026-11-23T20:00:00Z")).toBe("24 Nov 2026, 01:30");
    expect(stampText(null)).toBe("");
    expect(plural(1, "request")).toBe("1 request");
    expect(plural(2, "request")).toBe("2 requests");
  });

  it("counts by kind in the kinds' order and says what a run did", () => {
    expect(countsText({ missing_punch: 13, leave: 0, permission: 2 }, KINDS)).toBe("Permission 2 · Missing Punch 13");
    const run = {
      ran: true,
      at: "2026-11-23T20:00:00Z",
      day: "2026-11-24",
      days: 45,
      trigger: "nightly" as const,
      runBy: "nightly",
      branchId: null,
      rejected: 15,
      byKind: { missing_punch: 13, permission: 2 },
      skipped: 0,
      attendanceSkipped: 0,
      failed: 1,
      failures: [{ kind: "leave", id: 4, error: "boom" }],
    };
    expect(runText(run, KINDS)).toBe(
      "Nightly run, 24 Nov 2026, 01:30: 15 requests rejected (Permission 2 · Missing Punch 13); 1 request could not be rejected and stays waiting.",
    );
    expect(runText({ ...run, trigger: "run_now", runBy: "Meena", rejected: 0, byKind: {}, failed: 0 }, KINDS)).toBe(
      "Run now by Meena, 24 Nov 2026, 01:30: nothing was due.",
    );
  });
});
