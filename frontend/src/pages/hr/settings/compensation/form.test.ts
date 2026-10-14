import { describe, expect, it } from "vitest";
import type { CompensationSettings } from "@/lib/api-client/custom-hooks";
import {
  addAllowanceRow,
  addShiftRow,
  dateAfterSwitch,
  dateNote,
  draftFrom,
  extraMinutesOf,
  isIsoDate,
  LAST_ROW_OPEN,
  prettyDate,
  sameDraft,
  setAllowanceExtra,
  setShiftLimit,
  sortAllowanceRows,
  sortShiftRows,
  suggestLimit,
  todayIst,
  toInput,
  validateDraft,
  warningsFor,
  type CompensationDraft,
} from "./form";

/** The defaults the server seeds, as the contract shows them. */
const SETTINGS: CompensationSettings = {
  masterEnabled: true,
  allowance: { enabled: true, effectiveFrom: "2026-10-14" },
  shift: { enabled: true, minExtraMinutes: 150, relaxationEnabled: true, payEnabled: false },
  windows: { enabled: false },
  holidayWork: { enabled: false },
  birthday: { enabled: false, effectiveFrom: null },
  allowanceRules: [
    { id: 1, label: "1 hour", enabled: true, minExtraMinutes: 60, allowanceMinutes: 30, sortOrder: 1 },
    { id: 2, label: "1 hour 30 minutes", enabled: true, minExtraMinutes: 90, allowanceMinutes: 30, sortOrder: 2 },
    { id: 3, label: "2 hours", enabled: true, minExtraMinutes: 120, allowanceMinutes: 60, sortOrder: 3 },
    { id: 4, label: "2 hours 30 minutes", enabled: true, minExtraMinutes: 150, allowanceMinutes: 60, sortOrder: 4 },
  ],
  shiftRules: [
    { id: 5, label: "Up to 9:00 PM", enabled: true, untilMinutes: 1260, shifts: 0.25, sortOrder: 1 },
    { id: 6, label: "Up to 12:00 AM", enabled: true, untilMinutes: 1440, shifts: 0.5, sortOrder: 2 },
    { id: 7, label: "Up to 2:00 AM next day", enabled: true, untilMinutes: 1560, shifts: 0.75, sortOrder: 3 },
    { id: 8, label: "No time limit", enabled: true, untilMinutes: null, shifts: 1, sortOrder: 4 },
  ],
  updatedBy: "Asha",
  updatedAt: "2026-10-14T10:00:00+05:30",
};

const SAVED = { allowanceFrom: "2026-10-14", birthdayFrom: "" };
const fresh = (): CompensationDraft => draftFrom(SETTINGS);
const check = (draft: CompensationDraft, saved = SAVED) => validateDraft(draft, saved);

/** A draft with one change, for the validation cases. */
function withShiftRow(index: number, change: Partial<CompensationDraft["shiftRules"][number]>) {
  const draft = fresh();
  draft.shiftRules = draft.shiftRules.map((r, i) => (i === index ? { ...r, ...change } : r));
  return draft;
}
function withAllowanceRow(index: number, change: Partial<CompensationDraft["allowanceRules"][number]>) {
  const draft = fresh();
  draft.allowanceRules = draft.allowanceRules.map((r, i) => (i === index ? { ...r, ...change } : r));
  return draft;
}

describe("the saved settings as a form", () => {
  it("reads every switch, date and rule, rows in their saved order", () => {
    const draft = fresh();
    expect(draft).toMatchObject({
      allowanceEnabled: true,
      allowanceFrom: "2026-10-14",
      shiftEnabled: true,
      shiftMinExtra: "150",
      relaxationEnabled: true,
      payEnabled: false,
      windowsEnabled: false,
      holidayWorkEnabled: false,
      birthdayEnabled: false,
      birthdayFrom: "",
    });
    expect(draft.allowanceRules.map((r) => [r.label, r.hours, r.minutes, r.allowanceMinutes])).toEqual([
      ["1 hour", "1", "0", "30"],
      ["1 hour 30 minutes", "1", "30", "30"],
      ["2 hours", "2", "0", "60"],
      ["2 hours 30 minutes", "2", "30", "60"],
    ]);
    expect(draft.shiftRules.map((r) => [r.until, r.noLimit, r.shifts])).toEqual([
      ["9:00 PM", false, "0.25"],
      ["12:00 AM", false, "0.5"],
      ["2:00 AM next day", false, "0.75"],
      ["", true, "1"],
    ]);
    const shuffled = { ...SETTINGS, shiftRules: [...SETTINGS.shiftRules].reverse() };
    expect(draftFrom(shuffled).shiftRules.map((r) => r.key)).toEqual(["s-5", "s-6", "s-7", "s-8"]);
  });

  it("starts a group an older server does not report at its defaults", () => {
    const bare = { masterEnabled: true, allowanceRules: [], shiftRules: [] } as unknown as CompensationSettings;
    expect(draftFrom(bare)).toMatchObject({
      allowanceEnabled: false,
      allowanceFrom: "",
      shiftEnabled: false,
      shiftMinExtra: "150",
      relaxationEnabled: true,
      payEnabled: false,
      birthdayEnabled: false,
    });
  });

  it("counts the same value written another way as no change, and ignores ids and keys", () => {
    const a = fresh();
    expect(sameDraft(a, fresh())).toBe(true);

    const b = fresh();
    b.shiftRules = b.shiftRules.map((r, i) => ({
      ...r,
      id: null,
      key: `x${i}`,
      shifts: r.shifts === "0.5" ? "0.50" : r.shifts === "1" ? "1.00" : r.shifts,
      until: r.until === "9:00 PM" ? "21:00" : r.until,
    }));
    b.shiftMinExtra = "150.0";
    expect(sameDraft(a, b)).toBe(true);
  });

  it("notices every kind of change", () => {
    const a = fresh();
    const change = (edit: (d: CompensationDraft) => void) => {
      const d = fresh();
      edit(d);
      return sameDraft(a, d);
    };
    expect(change((d) => (d.allowanceEnabled = false))).toBe(false);
    expect(change((d) => (d.allowanceFrom = "2026-10-01"))).toBe(false);
    expect(change((d) => (d.shiftMinExtra = "120"))).toBe(false);
    expect(change((d) => (d.payEnabled = true))).toBe(false);
    expect(change((d) => (d.windowsEnabled = true))).toBe(false);
    expect(change((d) => (d.birthdayFrom = "2026-11-01"))).toBe(false);
    expect(change((d) => (d.allowanceRules[0].allowanceMinutes = "45"))).toBe(false);
    expect(change((d) => (d.allowanceRules[1].minutes = "35"))).toBe(false);
    expect(change((d) => (d.allowanceRules[2].enabled = false))).toBe(false);
    expect(change((d) => (d.allowanceRules[3].label = "Long"))).toBe(false);
    expect(change((d) => (d.shiftRules[0].until = "9:30 PM"))).toBe(false);
    expect(change((d) => (d.shiftRules[3].noLimit = false))).toBe(false);
    expect(change((d) => (d.shiftRules[1].shifts = "0.75"))).toBe(false);
    expect(change((d) => (d.shiftRules = d.shiftRules.slice(1)))).toBe(false);
    expect(change((d) => (d.allowanceRules = addAllowanceRow(d.allowanceRules)))).toBe(false);
    // a limit that cannot be read yet is compared as typed
    expect(change((d) => (d.shiftRules[0].until = "9:0"))).toBe(false);
  });
});

describe("the request a save sends", () => {
  it("is the contract's body: the groups, and both rule tables in full with their ids and order", () => {
    expect(toInput(fresh())).toEqual({
      allowance: { enabled: true, effectiveFrom: "2026-10-14" },
      shift: { enabled: true, minExtraMinutes: 150, relaxationEnabled: true, payEnabled: false },
      windows: { enabled: false },
      holidayWork: { enabled: false },
      birthday: { enabled: false },
      allowanceRules: [
        { id: 1, label: "1 hour", enabled: true, minExtraMinutes: 60, allowanceMinutes: 30, sortOrder: 1 },
        { id: 2, label: "1 hour 30 minutes", enabled: true, minExtraMinutes: 90, allowanceMinutes: 30, sortOrder: 2 },
        { id: 3, label: "2 hours", enabled: true, minExtraMinutes: 120, allowanceMinutes: 60, sortOrder: 3 },
        { id: 4, label: "2 hours 30 minutes", enabled: true, minExtraMinutes: 150, allowanceMinutes: 60, sortOrder: 4 },
      ],
      shiftRules: [
        { id: 5, label: "Up to 9:00 PM", enabled: true, untilMinutes: 1260, shifts: 0.25, sortOrder: 1 },
        { id: 6, label: "Up to 12:00 AM", enabled: true, untilMinutes: 1440, shifts: 0.5, sortOrder: 2 },
        { id: 7, label: "Up to 2:00 AM next day", enabled: true, untilMinutes: 1560, shifts: 0.75, sortOrder: 3 },
        { id: 8, label: "No time limit", enabled: true, untilMinutes: null, shifts: 1, sortOrder: 4 },
      ],
    });
  });

  it("sends a new row without an id, a blank name as the automatic one, and no date that was never set", () => {
    const draft = fresh();
    draft.birthdayFrom = "";
    draft.allowanceRules = addAllowanceRow(draft.allowanceRules);
    draft.allowanceRules[4].label = "   ";
    draft.shiftRules = addShiftRow(draft.shiftRules);
    draft.shiftRules[3].label = "";
    const input = toInput(draft);
    expect(input.birthday).toEqual({ enabled: false });
    expect(input.allowanceRules?.[4]).toEqual({
      label: "3 hours",
      enabled: true,
      minExtraMinutes: 180,
      allowanceMinutes: 60,
      sortOrder: 5,
    });
    expect(input.shiftRules?.[3]).toEqual({
      label: "Up to 3:00 AM next day",
      enabled: true,
      untilMinutes: 1620,
      shifts: 0.75,
      sortOrder: 4,
    });
    expect(input.shiftRules?.[4]).toMatchObject({ id: 8, untilMinutes: null, sortOrder: 5 });
  });

  it("sends the limit as minutes from the day's midnight and the shifts as numbers, whichever way they were typed", () => {
    const draft = withShiftRow(0, { until: "9 pm", shifts: "0.250" });
    draft.shiftRules[2].until = "2am tomorrow";
    const rules = toInput(draft).shiftRules ?? [];
    expect(rules.map((r) => [r.untilMinutes, r.shifts])).toEqual([
      [1260, 0.25],
      [1440, 0.5],
      [1560, 0.75],
      [null, 1],
    ]);
  });
});

describe("what is wrong, in plain words", () => {
  it("accepts the seeded defaults", () => {
    const v = check(fresh());
    expect(v.ok).toBe(true);
    expect(v.first).toBeNull();
  });

  it("checks each Type 1 box against the server's ranges", () => {
    expect(check(withAllowanceRow(2, { allowanceMinutes: "241" })).allowanceRows[2].allowance).toBe(
      "Must be from 0 to 240.",
    );
    expect(check(withAllowanceRow(2, { allowanceMinutes: "" })).allowanceRows[2].allowance).toBe("Enter a number.");
    expect(check(withAllowanceRow(2, { allowanceMinutes: "0" })).ok).toBe(true);
    expect(check(withAllowanceRow(0, { hours: "0", minutes: "0" })).allowanceRows[0].extra).toBe(
      "Extra work must be at least 1 minute.",
    );
    expect(check(withAllowanceRow(0, { hours: "", minutes: "0" })).allowanceRows[0].extra).toBe(
      "Hours: Enter a number.",
    );
    expect(check(withAllowanceRow(0, { minutes: "60" })).allowanceRows[0].extra).toBe("Minutes: Must be from 0 to 59.");
    expect(check(withAllowanceRow(0, { hours: "24", minutes: "30" })).allowanceRows[0].extra).toBe(
      "Extra work can be at most 24 hours.",
    );
    expect(check(withAllowanceRow(0, { label: "x".repeat(81) })).allowanceRows[0].label).toBe(
      "Keep the name to 80 characters.",
    );
  });

  it("refuses two rules that are on for the same amount of extra work, but lets a switched-off one repeat it", () => {
    const duplicate = withAllowanceRow(1, { hours: "1", minutes: "0" });
    expect(check(duplicate).allowanceRows[1].extra).toBe(
      "Row 1 already uses 1 hour: each row needs a different amount of extra work.",
    );
    expect(check(duplicate).ok).toBe(false);
    expect(
      check({
        ...duplicate,
        allowanceRules: duplicate.allowanceRules.map((r, i) => (i === 1 ? { ...r, enabled: false } : r)),
      }).ok,
    ).toBe(true);
  });

  it("wants at least one rule switched on for a feature that is on, and says which", () => {
    const none = fresh();
    none.allowanceRules = none.allowanceRules.map((r) => ({ ...r, enabled: false }));
    expect(check(none).allowanceTable).toContain("Type 1 is switched on but no rule is switched on");
    expect(check(none).first).toContain("Type 1 is switched on");
    // a feature that is off may have any rows
    expect(check({ ...none, allowanceEnabled: false }).ok).toBe(true);

    const noShift = fresh();
    noShift.shiftRules = [];
    expect(check(noShift).shiftTable).toContain("Type 2 is switched on but no rule is switched on");
    expect(check({ ...noShift, shiftEnabled: false }).ok).toBe(true);
  });

  it("checks the Type 2 threshold", () => {
    const draft = (text: string) => ({ ...fresh(), shiftMinExtra: text });
    expect(check(draft("0")).threshold).toBe("Must be from 1 to 1,440.");
    expect(check(draft("")).threshold).toBe("Enter a number.");
    expect(check(draft("2.5")).threshold).toBe("Use a whole number.");
    expect(check(draft("1441")).threshold).toBe("Must be from 1 to 1,440.");
    expect(check(draft("1")).threshold).toBeNull();
    expect(check(draft("180")).ok).toBe(true);
  });

  it("wants the ladder strictly later row by row, and suggests 'next day' for a time after midnight", () => {
    expect(check(fresh()).ok).toBe(true);

    const earlier = check(withShiftRow(1, { until: "8:00 PM" }));
    expect(earlier.shiftRows[1].order).toBe(
      'Must be later than rule 1 (9:00 PM). For a time after midnight write it as "2:00 AM next day".',
    );
    expect(earlier.ok).toBe(false);
    expect(earlier.first).toContain("Type 2, rule 2: Must be later than rule 1");

    // equal is not later
    expect(check(withShiftRow(1, { until: "9:00 PM" })).shiftRows[1].order).toContain(
      "Must be later than rule 1 (9:00 PM)",
    );

    // 2:00 AM typed without "next day" is before 12:00 AM: the message offers the fix
    const forgot = check(withShiftRow(2, { until: "2:00 AM" }));
    expect(forgot.shiftRows[2].order).toContain("Must be later than rule 2 (12:00 AM)");
    expect(forgot.shiftRows[2].order).toContain("2:00 AM next day");
    expect(check(withShiftRow(2, { until: "2:00 AM next day" })).ok).toBe(true);

    // already says next day: no hint
    expect(check(withShiftRow(2, { until: "11:00 PM next day" })).shiftRows[2].order).toBeUndefined();
    expect(check(withShiftRow(2, { until: "11:00 AM next day" })).ok).toBe(true);
  });

  it("looks at the rows that are on only for the order, and skips a row that is off", () => {
    expect(check(withShiftRow(1, { until: "8:00 PM", enabled: false })).ok).toBe(true);
    // with row 2 off, row 3 is compared with row 1
    const draft = withShiftRow(1, { enabled: false });
    draft.shiftRules[2].until = "9:30 PM";
    expect(check(draft).ok).toBe(true);
    draft.shiftRules[2].until = "8:30 PM";
    expect(check(draft).shiftRows[2].order).toContain("Must be later than rule 1");
  });

  it("lets only the last rule that is on have no upper limit", () => {
    const middle = withShiftRow(1, { noLimit: true });
    expect(check(middle).shiftRows[1].order).toBe(
      "Only the last rule can have no upper limit. Move it to the end, or switch the rules after it off.",
    );
    expect(check(middle).ok).toBe(false);
    // the rules after it are off: it is the last one that is on
    const rest = fresh();
    rest.shiftRules = rest.shiftRules.map((r, i) =>
      i === 1 ? { ...r, noLimit: true } : i > 1 ? { ...r, enabled: false } : r,
    );
    expect(check(rest).ok).toBe(true);
  });

  it("wants the last rule that is on to have no limit (the server refuses a ladder where a late punch-out matches nothing)", () => {
    // the open-ended row off: the last rule that is on now has a limit
    const finite = check(withShiftRow(3, { enabled: false }));
    expect(finite.shiftRows[2].order).toBe(LAST_ROW_OPEN);
    expect(finite.ok).toBe(false);
    expect(finite.first).toContain("Type 2, rule 3: The last rule that is on must have no upper limit");
    // ticking it on that row fixes it
    expect(check(withShiftRow(3, { enabled: false })).shiftRows[3].order).toBeUndefined();
    const fixed = withShiftRow(3, { enabled: false });
    fixed.shiftRules[2].noLimit = true;
    expect(check(fixed).ok).toBe(true);
    // the server checks the table whether or not Type 2 is on
    expect(check({ ...withShiftRow(3, { enabled: false }), shiftEnabled: false }).ok).toBe(false);
    // a single rule that is open-ended is a valid ladder: every late punch-out gets its shifts
    const single = fresh();
    single.shiftRules = [{ ...single.shiftRules[3] }];
    expect(check(single).ok).toBe(true);
  });

  it("wants Relaxation or Payment on while Type 2 is on", () => {
    const none = { ...fresh(), relaxationEnabled: false, payEnabled: false };
    expect(check(none).shiftMode).toBe(
      "Type 2 is switched on: switch on Relaxation, Payment or both, or switch Type 2 off.",
    );
    expect(check(none).ok).toBe(false);
    expect(check(none).first).toContain("Type 2 is switched on: switch on Relaxation");
    expect(check({ ...none, payEnabled: true }).ok).toBe(true);
    expect(check({ ...none, relaxationEnabled: true }).ok).toBe(true);
    expect(check({ ...none, shiftEnabled: false }).ok).toBe(true);
  });

  it("allows only 0.25, 0.50, 0.75 and 1.00 shifts", () => {
    expect(check(withShiftRow(0, { shifts: "0.3" })).shiftRows[0].shifts).toBe(
      "Shifts must be 0.25, 0.50, 0.75 or 1.00.",
    );
    expect(check(withShiftRow(0, { shifts: "" })).shiftRows[0].shifts).toBeDefined();
    expect(check(withShiftRow(0, { shifts: "1.5" })).ok).toBe(false);
    expect(check(withShiftRow(0, { shifts: "1.00" })).ok).toBe(true);
    expect(check(withShiftRow(0, { shifts: "0.50" })).ok).toBe(true);
  });

  it("wants every limit readable, even on a row that is switched off (every row is sent)", () => {
    const off = check(withShiftRow(1, { until: "soon", enabled: false }));
    expect(off.shiftRows[1].until).toContain("9:00 PM");
    expect(off.ok).toBe(false);
    // a row with no upper limit needs no time
    expect(check(withShiftRow(3, { until: "garbage" })).ok).toBe(true);
  });

  it("wants a date it can read, and a date back once one has been set", () => {
    expect(check({ ...fresh(), allowanceFrom: "" }).allowanceFrom).toBe("Pick the date it applies from.");
    expect(check({ ...fresh(), allowanceFrom: "" }, { allowanceFrom: "", birthdayFrom: "" }).allowanceFrom).toBeNull();
    expect(check({ ...fresh(), allowanceFrom: "2026-13-40" }).allowanceFrom).toBe("Pick a valid date.");
    expect(check({ ...fresh(), birthdayFrom: "14/10/2026" }).birthdayFrom).toBe("Pick a valid date.");
    expect(
      check({ ...fresh(), birthdayFrom: "" }, { allowanceFrom: "2026-10-14", birthdayFrom: "2026-10-01" }).birthdayFrom,
    ).toBe("Pick the date it applies from.");
    expect(check({ ...fresh(), birthdayFrom: "2026-11-01" }).ok).toBe(true);
  });

  it("reports the first problem in reading order", () => {
    const draft = { ...fresh(), birthdayFrom: "nope", shiftMinExtra: "0" };
    draft.allowanceRules = draft.allowanceRules.map((r, i) => (i === 3 ? { ...r, allowanceMinutes: "999" } : r));
    expect(check(draft).first).toBe("Type 1, rule 4: Must be from 0 to 240.");
  });
});

describe("things that are allowed but probably not meant", () => {
  it("warns about an allowance row that asks for more extra work than Type 2 starts at, in the server's words", () => {
    expect(warningsFor(fresh())).toEqual([]);
    expect(warningsFor({ ...fresh(), shiftMinExtra: "120" })).toEqual([
      "The '2 hours 30 minutes' allowance can never apply: shift-based compensation already starts at 2 hours of extra work.",
    ]);
    const lower = warningsFor({ ...fresh(), shiftMinExtra: "60" });
    expect(lower).toHaveLength(3);
    expect(lower[0]).toContain("'1 hour 30 minutes'");
  });

  it("does not warn about a row that is off, an allowance that is off, or a threshold that is not a number yet", () => {
    const off = fresh();
    off.shiftMinExtra = "120";
    off.allowanceRules = off.allowanceRules.map((r) => (r.key === "a-4" ? { ...r, enabled: false } : r));
    expect(warningsFor(off)).toEqual([]);
    expect(warningsFor({ ...fresh(), shiftMinExtra: "120", allowanceEnabled: false })).toEqual([]);
    expect(warningsFor({ ...fresh(), shiftMinExtra: "" })).toEqual([]);
    // exactly the threshold is still the allowance's (Type 2 needs MORE than it)
    expect(warningsFor({ ...fresh(), shiftMinExtra: "150" })).toEqual([]);
  });
});

describe("dates", () => {
  it("works out today in India, not in the browser's own zone", () => {
    expect(todayIst(new Date("2026-10-14T05:00:00Z"))).toBe("2026-10-14");
    expect(todayIst(new Date("2026-10-14T18:29:00Z"))).toBe("2026-10-14");
    // 18:30 UTC is midnight in India
    expect(todayIst(new Date("2026-10-14T18:30:00Z"))).toBe("2026-10-15");
    expect(todayIst(new Date("2026-12-31T20:00:00Z"))).toBe("2027-01-01");
  });

  it("starts a feature that is switched on again today, shows that date at once, and puts the old one back when it is switched off", () => {
    const base = { savedOn: false, savedFrom: "2026-09-01", currentFrom: "2026-09-01", today: "2026-10-14" };
    // off -> on with the date untouched: the server would use today, so the form says today
    expect(dateAfterSwitch({ ...base, on: true })).toBe("2026-10-14");
    // never saved before: today too
    expect(dateAfterSwitch({ ...base, savedFrom: "", currentFrom: "", on: true })).toBe("2026-10-14");
    // a date HR typed first is kept
    expect(dateAfterSwitch({ ...base, currentFrom: "2026-10-01", on: true })).toBe("2026-10-01");
    // switched back off: the automatic date goes, the saved one returns
    expect(dateAfterSwitch({ ...base, currentFrom: "2026-10-14", on: false })).toBe("2026-09-01");
    expect(dateAfterSwitch({ ...base, savedFrom: "", currentFrom: "2026-10-14", on: false })).toBe("");
    // a feature that is already on keeps its date whatever is done with the switch
    expect(dateAfterSwitch({ ...base, savedOn: true, on: false })).toBe("2026-09-01");
    expect(dateAfterSwitch({ ...base, savedOn: true, on: true })).toBe("2026-09-01");
  });

  it("reads and prints a date", () => {
    expect(isIsoDate("2026-10-14")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("14-10-2026")).toBe(false);
    expect(prettyDate("2026-10-14")).toBe("14 Oct 2026");
  });

  it("says what the chosen date means: never before it, and a warning for a date in the past", () => {
    expect(dateNote("", "2026-10-14").kind).toBe("none");
    const today = dateNote("2026-10-14", "2026-10-14");
    expect(today.kind).toBe("today");
    expect(today.text).toContain("Days before today are never changed");
    expect(dateNote("2026-11-01", "2026-10-14")).toMatchObject({ kind: "future" });
    const past = dateNote("2026-10-01", "2026-10-14");
    expect(past.kind).toBe("past");
    expect(past.text).toContain("1 Oct 2026 is in the past");
    expect(past.text).toContain("Payslips already generated are never rewritten");
  });
});

describe("editing the rows", () => {
  it("lets a row's automatic name follow its extra work, and leaves a name HR typed alone", () => {
    const rows = fresh().allowanceRules;
    const longer = setAllowanceExtra(rows, "a-1", { minutes: "15" });
    expect(longer[0]).toMatchObject({ hours: "1", minutes: "15", label: "1 hour 15 minutes" });
    expect(longer[1]).toBe(rows[1]);

    const custom = rows.map((r) => (r.key === "a-1" ? { ...r, label: "Standard" } : r));
    expect(setAllowanceExtra(custom, "a-1", { hours: "3" })[0].label).toBe("Standard");

    // a blank name is the automatic name too
    const blank = rows.map((r) => (r.key === "a-1" ? { ...r, label: "" } : r));
    expect(setAllowanceExtra(blank, "a-1", { hours: "3" })[0].label).toBe("3 hours");
  });

  it("does the same for a ladder row's limit and its 'no upper limit' tick", () => {
    const rows = fresh().shiftRules;
    expect(setShiftLimit(rows, "s-5", { until: "10:00 PM" })[0].label).toBe("Up to 10:00 PM");
    // the tick: the open-ended row's name ("No time limit") is the automatic one, so it follows the change
    expect(setShiftLimit(rows, "s-8", { noLimit: false, until: "4:00 AM next day" })[3].label).toBe(
      "Up to 4:00 AM next day",
    );
    expect(setShiftLimit(rows, "s-6", { noLimit: true })[1].label).toBe("No time limit");
    const custom = rows.map((r) => (r.key === "s-5" ? { ...r, label: "Evening" } : r));
    expect(setShiftLimit(custom, "s-5", { until: "10:00 PM" })[0].label).toBe("Evening");
  });

  it("keeps the Type 1 rows in order of extra work, and the Type 2 rows in order of time with no limit last", () => {
    const rows = fresh().allowanceRules;
    const shuffled = [rows[2], rows[0], rows[3], rows[1]];
    expect(sortAllowanceRows(shuffled).map((r) => r.key)).toEqual(["a-1", "a-2", "a-3", "a-4"]);
    expect(sortAllowanceRows(rows)).toEqual(rows);
    // a row that cannot be read yet keeps to the end
    const typing = [rows[1], { ...rows[0], hours: "" }, rows[2]];
    expect(sortAllowanceRows(typing).map((r) => r.key)).toEqual(["a-2", "a-3", "a-1"]);

    const ladder = fresh().shiftRules;
    expect(sortShiftRows(ladder)).toBe(ladder);
    const mixed = [ladder[3], ladder[1], ladder[2], ladder[0]];
    expect(sortShiftRows(mixed).map((r) => r.key)).toEqual(["s-5", "s-6", "s-7", "s-8"]);
    // while any limit cannot be read the order is left as it is
    const unreadable = [ladder[1], { ...ladder[0], until: "9:0" }, ladder[2]];
    expect(sortShiftRows(unreadable)).toBe(unreadable);
  });

  it("adds a Type 1 row 30 minutes beyond the largest, with that row's allowance", () => {
    const next = addAllowanceRow(fresh().allowanceRules);
    expect(next).toHaveLength(5);
    expect(next[4]).toMatchObject({
      id: null,
      enabled: true,
      hours: "3",
      minutes: "0",
      allowanceMinutes: "60",
      label: "3 hours",
    });
    expect(extraMinutesOf(next[4])).toBe(180);
    // every added row has its own key
    expect(new Set(addAllowanceRow(next).map((r) => r.key)).size).toBe(6);
    // an empty table starts at 1 hour
    expect(addAllowanceRow([])[0]).toMatchObject({ hours: "1", minutes: "0", allowanceMinutes: "30" });
  });

  it("adds a Type 2 row an hour after the latest limit, before the row that has no limit", () => {
    expect(suggestLimit(fresh().shiftRules)).toEqual({ minutes: 1620, shifts: "0.75" });
    const next = addShiftRow(fresh().shiftRules);
    expect(next.map((r) => r.until)).toEqual(["9:00 PM", "12:00 AM", "2:00 AM next day", "3:00 AM next day", ""]);
    expect(next[3]).toMatchObject({ id: null, noLimit: false, shifts: "0.75", label: "Up to 3:00 AM next day" });
    expect(next[4].noLimit).toBe(true);
    // with no open-ended row that is on the new row goes at the end WITH no limit, so the table is valid again
    const finite = fresh().shiftRules.slice(0, 3);
    const closed = addShiftRow(finite);
    expect(closed.map((r) => r.until)).toEqual(["9:00 PM", "12:00 AM", "2:00 AM next day", ""]);
    expect(closed[3]).toMatchObject({ id: null, noLimit: true, shifts: "1", label: "No time limit", enabled: true });
    const offOpen = fresh().shiftRules.map((r) => (r.noLimit ? { ...r, enabled: false } : r));
    expect(addShiftRow(offOpen)[4]).toMatchObject({ noLimit: true, enabled: true });
    // an empty table starts with the one row that is always valid
    expect(addShiftRow([])).toHaveLength(1);
    expect(addShiftRow([])[0]).toMatchObject({ noLimit: true, shifts: "1" });
  });

  it("an added row passes the checks as it is, in a table with or without a row that has no limit", () => {
    const draft = fresh();
    draft.allowanceRules = addAllowanceRow(draft.allowanceRules);
    draft.shiftRules = addShiftRow(draft.shiftRules);
    expect(check(draft).ok).toBe(true);

    const closed = fresh();
    closed.shiftRules = fresh().shiftRules.slice(0, 3);
    expect(check(closed).ok).toBe(false);
    closed.shiftRules = addShiftRow(closed.shiftRules);
    expect(check(closed).ok).toBe(true);

    const empty = fresh();
    empty.shiftRules = addShiftRow([]);
    expect(check(empty).ok).toBe(true);
  });
});
