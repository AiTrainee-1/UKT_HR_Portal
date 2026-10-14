import { describe, expect, it } from "vitest";
import {
  COMPENSATION_KINDS,
  KIND_META,
  compensationMark,
  countMarks,
  isPunchlessRelaxation,
  kindLabel,
  markKinds,
  markShort,
  markTitle,
} from "./kinds";

describe("the compensation marker of a day", () => {
  it("is nothing for an ordinary day, whatever the backend sent", () => {
    expect(compensationMark(null)).toBeNull();
    expect(compensationMark(undefined)).toBeNull();
    expect(compensationMark({})).toBeNull(); // an older backend sends none of the keys
    expect(compensationMark({ compensationKind: null, compensationMinutes: 0, compensationNote: null })).toBeNull();
    expect(compensationMark({ compensationKind: "  " })).toBeNull();
  });

  it("says the words the owner asked for, one per kind", () => {
    expect(compensationMark({ compensationKind: "ot_allowance", compensationMinutes: 30 })?.label).toBe(
      "OT allowance used (30 min)",
    );
    expect(compensationMark({ compensationKind: "window_late_in" })?.label).toBe("Announced late-in");
    expect(compensationMark({ compensationKind: "window_early_out" })?.label).toBe("Announced early-out");
    expect(compensationMark({ compensationKind: "birthday" })?.label).toBe("Birthday leave");
    expect(compensationMark({ compensationKind: "relaxation" })?.label).toBe("Relaxation (compensation day)");
  });

  it("names the minutes only for an OT allowance, and only when it used some", () => {
    expect(compensationMark({ compensationKind: "ot_allowance", compensationMinutes: 0 })?.label).toBe(
      "OT allowance used",
    );
    expect(compensationMark({ compensationKind: "ot_allowance" })?.label).toBe("OT allowance used");
    expect(compensationMark({ compensationKind: "birthday", compensationMinutes: 45 })?.label).toBe("Birthday leave");
    expect(kindLabel("ot_allowance", 60)).toBe("OT allowance used (60 min)");
    expect(kindLabel("ot_allowance")).toBe("OT allowance used");
  });

  it("carries the minutes (never negative, whole) and the engine's note, trimmed", () => {
    const mark = compensationMark({
      compensationKind: "ot_allowance",
      compensationMinutes: 17.6,
      compensationNote: "  Arrived 09:47, inside the 30 min allowance earned on 12 Oct.  ",
    })!;
    expect(mark.minutes).toBe(18);
    expect(mark.note).toBe("Arrived 09:47, inside the 30 min allowance earned on 12 Oct.");
    expect(mark.title).toBe("OT allowance used (18 min): Arrived 09:47, inside the 30 min allowance earned on 12 Oct.");
    expect(compensationMark({ compensationKind: "ot_allowance", compensationMinutes: -5 })?.minutes).toBe(0);
  });

  it("has no note line when the engine sent none", () => {
    const mark = compensationMark({ compensationKind: "birthday", compensationNote: "   " })!;
    expect(mark.note).toBeNull();
    expect(mark.title).toBe("Birthday leave");
  });

  it("draws a kind this build does not know as a plain Compensation marker instead of dropping it", () => {
    const mark = compensationMark({ compensationKind: "festival_pay", compensationNote: "New kind." })!;
    expect(mark.kind).toBe("other");
    expect(mark.label).toBe("Compensation");
    expect(mark.short).toBe("CP");
    expect(mark.title).toBe("Compensation: New kind.");
  });

  it("gives every kind its own icon, colours and two-letter code, so colour is never the only signal", () => {
    const kinds = [...COMPENSATION_KINDS, "other" as const];
    expect(new Set(kinds.map((k) => KIND_META[k].short)).size).toBe(kinds.length);
    expect(new Set(kinds.map((k) => KIND_META[k].icon)).size).toBe(kinds.length);
    expect(new Set(kinds.map((k) => KIND_META[k].chip)).size).toBe(kinds.length);
    expect(new Set(kinds.map((k) => KIND_META[k].solid)).size).toBe(kinds.length);
    for (const k of kinds) {
      expect(KIND_META[k].short).toMatch(/^[A-Z]{2}$/);
      expect(KIND_META[k].meaning.length).toBeGreaterThan(20);
    }
  });
});

describe("a day made up by a relaxation", () => {
  it("is a relaxation with no first punch (so the sheet's default 'afternoon' half is not believed)", () => {
    expect(isPunchlessRelaxation({ compensationKind: "relaxation", firstPunch: null })).toBe(true);
    expect(isPunchlessRelaxation({ compensationKind: "relaxation" })).toBe(true);
    expect(isPunchlessRelaxation({ compensationKind: "relaxation", firstPunch: "09:05" })).toBe(false);
    expect(isPunchlessRelaxation({ compensationKind: "birthday", firstPunch: null })).toBe(false);
    expect(isPunchlessRelaxation({ firstPunch: null })).toBe(false);
  });
});

describe("counting markers in a set of days", () => {
  const days = [
    { compensationKind: "relaxation" },
    { compensationKind: null },
    { compensationKind: "birthday" },
    {},
    { compensationKind: "relaxation" },
    { compensationKind: "ot_allowance", compensationMinutes: 30 },
    { compensationKind: "something_new" },
  ];

  it("counts each kind and lists them in the legend's order, leaving out the ones with none", () => {
    const counts = countMarks(days);
    expect(counts).toEqual({ ot_allowance: 1, birthday: 1, relaxation: 2, other: 1 });
    expect(Object.keys(counts)).toEqual(["ot_allowance", "birthday", "relaxation", "other"]);
    expect(markKinds(days)).toEqual(["ot_allowance", "birthday", "relaxation", "other"]);
  });

  it("is empty when no day used a compensation", () => {
    expect(countMarks([])).toEqual({});
    expect(countMarks([{}, { compensationKind: null }])).toEqual({});
    expect(markKinds([{}])).toEqual([]);
  });
});

describe("what a spreadsheet cell holds", () => {
  it("is the short code and a sentence, or nothing for an ordinary day", () => {
    const day = { compensationKind: "window_late_in", compensationNote: "Announced late-in of 10:30 for 3 Oct." };
    expect(markShort(day)).toBe("LI");
    expect(markTitle(day)).toBe("Announced late-in: Announced late-in of 10:30 for 3 Oct.");
    expect(markShort({})).toBe("");
    expect(markTitle(null)).toBe("");
  });
});
