import { describe, expect, it } from "vitest";
import { graceExample, roundShifts } from "./examples";
import { SEEDED } from "./fixtures";
import {
  addBreak,
  addRule,
  autoRuleLabel,
  dateNote,
  draftChanges,
  draftFrom,
  isUnverifiedRow,
  ladderCap,
  legacyText,
  newAdvice,
  newGroup,
  sameDraft,
  setBreakStart,
  setRuleTime,
  sortBreaks,
  sortRules,
  toInput,
  unverifiedRows,
  validateDraft,
  warningsFor,
  type ShiftRulesDraft,
} from "./form";

const seeded = () => draftFrom(SEEDED);
/** A copy of the seeded form with `edit` applied (the form is plain data, so a deep copy is a structuredClone). */
function edited(edit: (d: ShiftRulesDraft) => void): ShiftRulesDraft {
  const d = structuredClone(seeded());
  edit(d);
  return d;
}

describe("production shifts form: from the saved rules to the boxes", () => {
  it("shows every box as text, the times as HH:MM, and keeps the ids", () => {
    const d = seeded();
    expect(d).toMatchObject({
      enabled: true,
      effectiveFrom: "2026-10-14",
      graceMinutes: "5",
      minCredit: "0",
      roundingStep: "0.01",
      roundingMode: "nearest",
      fullDayValue: "1",
      nightSessionHours: "12",
    });
    expect(d.groups.map((g) => [g.id, g.label, g.kind, g.appliesOn, g.startTime])).toEqual([
      [1, "Day shift", "day", "mon_sat", "08:30"],
      [2, "Night shift", "night", "all", "21:00"],
      [3, "Sunday shift", "sunday", "sunday", "08:30"],
    ]);
    expect(d.groups[0].rules.map((r) => [r.outTime, r.outNextDay, r.shiftValue])).toEqual([
      ["10:30", false, "0.25"],
      ["12:45", false, "0.50"],
      ["15:30", false, "0.75"],
      ["17:45", false, "1.00"],
      ["20:00", false, "1.50"],
      ["22:30", false, "2.00"],
      ["00:30", true, "2.50"],
      ["05:30", true, "3.00"],
    ]);
    expect(d.groups[1]).toMatchObject({ mainOutTime: "05:30", mainOutNextDay: true });
    expect(d.breaks.map((b) => [b.startTime, b.endTime])).toEqual([
      ["10:30", "10:45"],
      ["12:45", "13:30"],
      ["15:30", "15:45"],
      ["17:45", "18:00"],
      ["20:00", "21:00"],
    ]);
  });

  it("trims seconds off a time and reads a number the server sent as text", () => {
    const d = draftFrom({
      ...SEEDED,
      graceMinutes: "5" as unknown as number,
      groups: [
        {
          ...SEEDED.groups[0],
          firstPunchTo: "16:59:59",
          rules: [{ ...SEEDED.groups[0].rules[0], shiftValue: "0.25" as unknown as number }],
        },
      ],
    });
    expect(d.groups[0].firstPunchTo).toBe("16:59");
    expect(d.groups[0].rules[0].shiftValue).toBe("0.25");
    expect(d.graceMinutes).toBe("5");
  });

  it("is a group with no standard departure when the server sent none", () => {
    const d = draftFrom({ ...SEEDED, groups: [{ ...SEEDED.groups[2], mainOutTime: null }] });
    expect(d.groups[0].mainOutTime).toBe("");
    expect(toInput(d).groups[0]).toMatchObject({ mainOutTime: null, mainOutNextDay: false });
  });

  it("is the same as itself, and '1' is '1.00'", () => {
    expect(sameDraft(seeded(), seeded())).toBe(true);
    expect(
      sameDraft(
        seeded(),
        edited((d) => (d.groups[0].rules[3].shiftValue = "1.00")),
      ),
    ).toBe(true);
    expect(
      sameDraft(
        seeded(),
        edited((d) => (d.groups[0].rules[3].shiftValue = "1.25")),
      ),
    ).toBe(false);
    expect(
      sameDraft(
        seeded(),
        edited((d) => (d.graceMinutes = "6")),
      ),
    ).toBe(false);
    expect(
      sameDraft(
        seeded(),
        edited((d) => (d.breaks[0].enabled = false)),
      ),
    ).toBe(false);
    expect(
      sameDraft(
        seeded(),
        edited((d) => d.groups.pop()),
      ),
    ).toBe(false);
  });

  it("treats a blank standard departure's next-day tick as nothing", () => {
    const a = edited((d) => {
      d.groups[2].mainOutTime = "";
      d.groups[2].mainOutNextDay = true;
    });
    const b = edited((d) => {
      d.groups[2].mainOutTime = "";
      d.groups[2].mainOutNextDay = false;
    });
    expect(sameDraft(a, b)).toBe(true);
  });
});

describe("production shifts form: what a save sends", () => {
  it("sends the whole document, with ids for rows that exist and numbers for the figures", () => {
    const input = toInput(seeded());
    expect(input).toMatchObject({
      enabled: true,
      effectiveFrom: "2026-10-14",
      graceMinutes: 5,
      minCredit: 0,
      roundingStep: 0.01,
      roundingMode: "nearest",
      fullDayValue: 1,
      nightSessionHours: 12,
    });
    expect(input.groups).toHaveLength(3);
    expect(input.groups[0]).toMatchObject({
      id: 1,
      label: "Day shift",
      kind: "day",
      appliesOn: "mon_sat",
      startTime: "08:30",
      firstPunchFrom: "04:00",
      firstPunchTo: "16:59",
      mainOutTime: "20:00",
      mainOutNextDay: false,
      enabled: true,
    });
    expect(input.groups[0].rules[6]).toEqual({
      id: 7,
      label: "Past midnight",
      outTime: "00:30",
      outNextDay: true,
      shiftValue: 2.5,
      enabled: true,
    });
    expect(input.breaks[4]).toEqual({
      id: 5,
      label: "Night dinner",
      startTime: "20:00",
      endTime: "21:00",
      enabled: true,
    });
    // never sent: the read-only keys
    expect(Object.keys(input)).not.toContain("updatedAt");
    expect(Object.keys(input)).not.toContain("legacy");
    expect(Object.keys(input)).not.toContain("warnings");
  });

  it("leaves the id off a row added on screen, and names a blank row by its time", () => {
    const d = edited((g) => {
      g.groups[0].rules = addRule(g.groups[0]).map((r, i) => (i === 8 ? { ...r, label: "" } : r));
      g.breaks = addBreak(g.breaks).map((b, i) => (i === 5 ? { ...b, label: "" } : b));
    });
    const input = toInput(d);
    const added = input.groups[0].rules[8];
    expect("id" in added).toBe(false);
    expect(added).toMatchObject({ outTime: "06:30", outNextDay: true, label: "Leaves 6:30 AM next day" });
    expect("id" in input.breaks[5]).toBe(false);
    expect(input.breaks[5].label).toBe("Break 10:00 PM");
  });
});

describe("production shifts form: what is wrong before anything is sent", () => {
  it("accepts the owner's table as seeded", () => {
    const v = validateDraft(seeded());
    expect(v.ok).toBe(true);
    expect(v.first).toBeNull();
  });

  it("wants a start date, a grace of 0 to 30 minutes and the advanced numbers in range", () => {
    expect(validateDraft(edited((d) => (d.effectiveFrom = ""))).effectiveFrom).toBe(
      "Pick the date the rules apply from.",
    );
    expect(validateDraft(edited((d) => (d.effectiveFrom = "2026-02-31"))).ok).toBe(false);
    expect(validateDraft(edited((d) => (d.graceMinutes = "31"))).grace).toBe("Must be from 0 to 30.");
    expect(validateDraft(edited((d) => (d.graceMinutes = ""))).grace).toBe("Enter a number.");
    expect(validateDraft(edited((d) => (d.graceMinutes = "2.5"))).grace).toBe("Use a whole number.");
    expect(validateDraft(edited((d) => (d.graceMinutes = "0"))).ok).toBe(true);
    expect(validateDraft(edited((d) => (d.minCredit = "-1"))).minCredit).toBe("Must be 0 or more.");
    expect(validateDraft(edited((d) => (d.minCredit = "10"))).minCredit).toBe("Must be from 0 to 9.99.");
    expect(validateDraft(edited((d) => (d.fullDayValue = "0"))).fullDay).toBe("Must be from 0.01 to 9.99.");
    expect(validateDraft(edited((d) => (d.nightSessionHours = "0"))).nightHours).toBe("Must be from 1 to 24.");
    expect(validateDraft(edited((d) => (d.nightSessionHours = "13.5"))).nightHours).toBe("Use a whole number.");
  });

  it("wants the rows of a ladder in time order, the next-day tick counting after the same day", () => {
    const v = validateDraft(
      edited((d) => {
        d.groups[0].rules[3].outTime = "12:45"; // the same time as row 2
      }),
    );
    expect(v.groups[0].rules[3].order).toBe(
      'Must be later than row 3 (3:30 PM). For a time after midnight tick "Next day".',
    );
    expect(v.ok).toBe(false);
    expect(v.first).toBe(
      'Day shift, row 4: Must be later than row 3 (3:30 PM). For a time after midnight tick "Next day".',
    );

    // 00:30 next day is after 22:30, but 00:30 on the same day is not
    const same = validateDraft(edited((d) => (d.groups[0].rules[6].outNextDay = false)));
    expect(same.groups[0].rules[6].time).toBe(
      'Must be later than the start (8:30 AM). For a time after midnight tick "Next day".',
    );
    expect(same.ok).toBe(false);

    // equal times (twice the same point) are refused too
    const twice = validateDraft(
      edited((d) => {
        d.groups[0].rules[5].outTime = "20:00";
      }),
    );
    expect(twice.groups[0].rules[5].order).toContain("Must be later than row 5 (8:00 PM)");
  });

  it("wants a leaving time later than the group's start", () => {
    const v = validateDraft(
      edited((d) => {
        d.groups[1].rules[0].outTime = "00:00";
        d.groups[1].rules[0].outNextDay = false; // midnight at the start of the day, before 21:00
      }),
    );
    expect(v.groups[1].rules[0].time).toBe(
      'Must be later than the start (9:00 PM). For a time after midnight tick "Next day".',
    );
  });

  it("wants shifts that never go down as the time goes up, and in range", () => {
    const down = validateDraft(edited((d) => (d.groups[0].rules[4].shiftValue = "0.5")));
    expect(down.groups[0].rules[4].value).toBe("Must be at least row 4's 1.00: leaving later never earns less.");
    expect(validateDraft(edited((d) => (d.groups[0].rules[0].shiftValue = "0"))).groups[0].rules[0].value).toBe(
      "Must be from 0.01 to 9.99.",
    );
    expect(validateDraft(edited((d) => (d.groups[0].rules[7].shiftValue = "10"))).groups[0].rules[7].value).toBe(
      "Must be from 0.01 to 9.99.",
    );
    expect(validateDraft(edited((d) => (d.groups[0].rules[0].shiftValue = "0.125"))).groups[0].rules[0].value).toBe(
      "Use at most 2 decimals.",
    );
    expect(validateDraft(edited((d) => (d.groups[0].rules[0].shiftValue = ""))).groups[0].rules[0].value).toBe(
      "Enter a number.",
    );
    // equal values are fine
    expect(validateDraft(edited((d) => (d.groups[0].rules[4].shiftValue = "1"))).ok).toBe(true);
  });

  it("does not hold a row that is switched off to the order or the rising values, but it must still be readable", () => {
    const off = validateDraft(
      edited((d) => {
        d.groups[0].rules[3].enabled = false;
        d.groups[0].rules[3].outTime = "09:00";
        d.groups[0].rules[3].shiftValue = "0.1";
      }),
    );
    expect(off.ok).toBe(true);
    const unreadable = validateDraft(
      edited((d) => {
        d.groups[0].rules[3].enabled = false;
        d.groups[0].rules[3].outTime = "";
      }),
    );
    expect(unreadable.groups[0].rules[3].time).toBe("Enter the leaving time.");
    expect(unreadable.ok).toBe(false);
  });

  it("wants a group to have a name, a start time, a window that ends after it starts, and a readable departure", () => {
    expect(validateDraft(edited((d) => (d.groups[0].label = " "))).groups[0].errors.label).toBe(
      "Give the group a name.",
    );
    expect(validateDraft(edited((d) => (d.groups[0].label = "x".repeat(81)))).groups[0].errors.label).toContain("80");
    expect(validateDraft(edited((d) => (d.groups[0].startTime = ""))).groups[0].errors.start).toBe(
      "Enter the start time.",
    );
    expect(validateDraft(edited((d) => (d.groups[0].firstPunchFrom = "17:00"))).groups[0].errors.window).toBe(
      "The window must start before it ends.",
    );
    expect(validateDraft(edited((d) => (d.groups[0].firstPunchTo = ""))).groups[0].errors.window).toBe(
      "Enter both times of the first-punch window.",
    );
    expect(validateDraft(edited((d) => (d.groups[0].mainOutTime = "soon"))).groups[0].errors.mainOut).toBe(
      "Enter the departure time.",
    );
    // no departure at all is fine
    expect(validateDraft(edited((d) => (d.groups[0].mainOutTime = ""))).ok).toBe(true);
  });

  it("wants one group for a day: windows of groups that can be used on the same day must not overlap", () => {
    const overlap = validateDraft(edited((d) => (d.groups[1].firstPunchFrom = "16:00")));
    expect(overlap.groups[1].errors.overlap).toContain("overlaps Day shift (4:00 AM to 4:59 PM)");
    expect(overlap.ok).toBe(false);
    // Sunday and Monday to Saturday never share a day, so the same window is fine
    expect(validateDraft(seeded()).groups[2].errors.overlap).toBeUndefined();
    // a group used every day shares a day with both
    const all = validateDraft(edited((d) => (d.groups[2].appliesOn = "all")));
    expect(all.groups[2].errors.overlap).toContain("overlaps Day shift");
    // a group that is off takes no part
    expect(
      validateDraft(
        edited((d) => {
          d.groups[2].appliesOn = "all";
          d.groups[2].enabled = false;
        }),
      ).ok,
    ).toBe(true);
  });

  it("wants a group that is on to have a row that is on", () => {
    const none = validateDraft(
      edited((d) => {
        d.groups[2].rules[0].enabled = false;
      }),
    );
    expect(none.groups[2].errors.table).toContain("Sunday shift is in use but none of its rows is switched on");
    expect(none.ok).toBe(false);
    // off group, no rows on: fine
    expect(
      validateDraft(
        edited((d) => {
          d.groups[2].enabled = false;
          d.groups[2].rules[0].enabled = false;
        }),
      ).ok,
    ).toBe(true);
  });

  it("wants a break to end after it starts and not to overlap another that is on", () => {
    const back = validateDraft(edited((d) => (d.breaks[0].endTime = "10:30")));
    expect(back.breaks[0].end).toBe("The break must end after it starts.");
    expect(validateDraft(edited((d) => (d.breaks[0].startTime = ""))).breaks[0].start).toBe("Enter the start time.");
    const overlap = validateDraft(edited((d) => (d.breaks[1].startTime = "10:40")));
    expect(overlap.breaks[1].overlap).toContain("Overlaps Morning tea (10:30 AM to 10:45 AM)");
    expect(overlap.ok).toBe(false);
    // touching is not overlapping (what the move does to the 12:45 row is the paid-time check's business, below), and a
    // break that is off takes no part
    expect(validateDraft(edited((d) => (d.breaks[1].startTime = "10:45"))).breaks[1].overlap).toBeUndefined();
    expect(
      validateDraft(
        edited((d) => {
          d.breaks[1].startTime = "10:40";
          d.breaks[1].enabled = false;
        }),
      ).ok,
    ).toBe(true);
  });

  it("names the first problem in reading order for the Save bar", () => {
    const v = validateDraft(
      edited((d) => {
        d.graceMinutes = "99";
        d.groups[0].rules[0].shiftValue = "";
        d.breaks[0].endTime = "09:00";
      }),
    );
    expect(v.first).toBe("Grace: Must be from 0 to 30.");
  });

  it("warns, without blocking, about a row inside a break", () => {
    expect(warningsFor(seeded())).toEqual([]);
    const advice = warningsFor(edited((d) => (d.groups[0].rules[1].outTime = "13:00")));
    expect(advice).toEqual([
      "Day shift: leaving at 1:00 PM is inside the break Lunch (12:45 PM to 1:30 PM). A break is never paid, so that row earns what leaving when the break starts earns.",
    ]);
    expect(validateDraft(edited((d) => (d.groups[0].rules[1].outTime = "13:00"))).ok).toBe(true);
    // a switched-off row or break says nothing
    expect(
      warningsFor(
        edited((d) => {
          d.groups[0].rules[1].outTime = "13:00";
          d.groups[0].rules[1].enabled = false;
        }),
      ),
    ).toEqual([]);
    // the daily break repeats the next morning
    expect(
      warningsFor(
        edited((d) => {
          d.groups[1].rules[0].outTime = "20:30";
          d.groups[1].rules[0].outNextDay = true;
        }),
      ),
    ).toHaveLength(1);
  });
});

describe("production shifts form: the handwriting the owner has not confirmed", () => {
  it("marks exactly the two rows that follow the table as written, and no others", () => {
    const rows = unverifiedRows(seeded());
    expect(rows.map((r) => [r.group, r.row.outTime, r.row.outNextDay, r.row.shiftValue])).toEqual([
      ["Day shift", "00:30", true, "2.50"],
      ["Night shift", "00:00", true, "0.50"],
    ]);
    expect(rows[0].hint).toContain("12:30 PM");
    expect(rows[1].hint).toContain("noon");
  });

  it("stops marking a row once its time or its value is changed", () => {
    const changedTime = edited((d) => (d.groups[0].rules[6].outTime = "00:45"));
    expect(unverifiedRows(changedTime).map((r) => r.group)).toEqual(["Night shift"]);
    const changedValue = edited((d) => (d.groups[1].rules[0].shiftValue = "0.6"));
    expect(unverifiedRows(changedValue).map((r) => r.group)).toEqual(["Day shift"]);
    const day = seeded().groups[0];
    expect(isUnverifiedRow(day, day.rules[6])).toBe(true);
    expect(isUnverifiedRow(day, day.rules[7])).toBe(false);
    // the same figures in a group of another kind are not marked
    expect(isUnverifiedRow({ kind: "sunday" }, day.rules[6])).toBe(false);
  });
});

describe("production shifts form: the top of a ladder", () => {
  it("is the highest row that is on", () => {
    const g = seeded().groups;
    expect(ladderCap(g[0])).toEqual({ time: "05:30", nextDay: true, value: "3.00" });
    expect(ladderCap(g[2])).toEqual({ time: "17:00", nextDay: false, value: "1.00" });
    const off = edited((d) => (d.groups[0].rules[7].enabled = false)).groups[0];
    expect(ladderCap(off)).toEqual({ time: "00:30", nextDay: true, value: "2.50" });
    expect(ladderCap({ ...g[0], rules: [] })).toBeNull();
  });
});

describe("production shifts form: editing the rows", () => {
  it("names a row by its time until HR types a name, and the name follows the time", () => {
    const rows = seeded().groups[0].rules;
    // a typed name stays
    expect(setRuleTime(rows, rows[0].key, { outTime: "10:40" })[0].label).toBe("Morning tea");
    const auto = [{ ...rows[0], label: autoRuleLabel("10:30", false) }];
    expect(auto[0].label).toBe("Leaves 10:30 AM");
    expect(setRuleTime(auto, auto[0].key, { outTime: "10:40" })[0].label).toBe("Leaves 10:40 AM");
    expect(setRuleTime(auto, auto[0].key, { outNextDay: true })[0].label).toBe("Leaves 10:30 AM next day");
    const blank = [{ ...rows[0], label: "" }];
    expect(setRuleTime(blank, blank[0].key, { outTime: "11:00" })[0].label).toBe("Leaves 11:00 AM");
  });

  it("puts rows in time order, leaves them while a time cannot be read, and counts next day after the same day", () => {
    const rows = seeded().groups[0].rules;
    const shuffled = [rows[4], rows[0], rows[7], rows[6], rows[1], rows[5], rows[2], rows[3]];
    expect(sortRules(shuffled).map((r) => r.outTime + (r.outNextDay ? "+1" : ""))).toEqual([
      "10:30",
      "12:45",
      "15:30",
      "17:45",
      "20:00",
      "22:30",
      "00:30+1",
      "05:30+1",
    ]);
    const unreadable = [rows[1], { ...rows[0], outTime: "" }];
    expect(sortRules(unreadable)).toBe(unreadable);
    expect(sortRules(rows)).toBe(rows);
  });

  it("puts breaks in order of their start", () => {
    const breaks = seeded().breaks;
    const shuffled = [breaks[4], breaks[0], breaks[2]];
    expect(sortBreaks(shuffled).map((b) => b.startTime)).toEqual(["10:30", "15:30", "20:00"]);
    expect(sortBreaks(breaks)).toBe(breaks);
  });

  it("adds a row an hour after the latest one, earning what that row earns, across midnight", () => {
    const [day, night, sunday] = seeded().groups;
    const sundayRows = addRule(sunday);
    expect(sundayRows).toHaveLength(2);
    expect(sundayRows[1]).toMatchObject({
      id: null,
      outTime: "18:00",
      outNextDay: false,
      shiftValue: "1.00",
      enabled: true,
    });
    expect(sundayRows[1].label).toBe("Leaves 6:00 PM");
    const afterNight = addRule({ ...night, rules: [night.rules[1]] });
    expect(afterNight[1]).toMatchObject({ outTime: "06:30", outNextDay: true, shiftValue: "1.50" });
    // a ladder that has nothing yet starts an hour after the group's start
    expect(addRule({ ...day, rules: [] })[0]).toMatchObject({
      outTime: "09:30",
      outNextDay: false,
      shiftValue: "1.00",
    });
    // the new row keeps the ladder valid when its figure is left alone
    const grown = edited((d) => (d.groups[2].rules = sundayRows));
    expect(validateDraft(grown).ok).toBe(true);
  });

  it("adds a break an hour after the last one ends, 15 minutes long, and follows its start with the name", () => {
    const breaks = addBreak(seeded().breaks);
    expect(breaks).toHaveLength(6);
    expect(breaks[5]).toMatchObject({
      id: null,
      startTime: "22:00",
      endTime: "22:15",
      enabled: true,
      label: "Break 10:00 PM",
    });
    const moved = setBreakStart(breaks, breaks[5].key, "22:30");
    expect(moved[5].label).toBe("Break 10:30 PM");
    const typed = setBreakStart(seeded().breaks, seeded().breaks[0].key, "10:35");
    expect(typed[0].label).toBe("Morning tea");
    expect(addBreak([])[0]).toMatchObject({ startTime: "10:00", endTime: "10:15" });
  });

  it("starts a new group switched off, with one row, so a half-made group never blocks or changes anything", () => {
    const g = newGroup();
    expect(g).toMatchObject({ id: null, kind: "custom", appliesOn: "all", enabled: false, label: "New group" });
    expect(g.rules).toHaveLength(1);
    const d = edited((x) => x.groups.push(g));
    expect(validateDraft(d).ok).toBe(true);
    expect(toInput(d).groups[3].enabled).toBe(false);
    // switched on with the same window as the Day group it is refused, and why
    const on = edited((x) => x.groups.push({ ...g, enabled: true }));
    expect(validateDraft(on).groups[3].errors.overlap).toContain("overlaps Day shift");
  });
});

describe("production shifts form: what a save changes (for the question first)", () => {
  it("is empty when nothing changed", () => {
    expect(draftChanges(seeded(), seeded())).toEqual([]);
  });

  it("lists the settings that changed, the money ones marked", () => {
    const changes = draftChanges(
      edited((d) => {
        d.enabled = false;
        d.effectiveFrom = "2026-10-01";
        d.graceMinutes = "3";
        d.minCredit = "0.25";
        d.roundingStep = "0.25";
        d.roundingMode = "down";
        d.fullDayValue = "0.75";
        d.nightSessionHours = "10";
      }),
      seeded(),
    );
    expect(changes.map((c) => [c.label, c.from, c.to, c.money])).toEqual([
      ["Production shift rules", "On", "Off", true],
      ["Applies from", "14 Oct 2026", "1 Oct 2026", true],
      ["Grace", "5 min", "3 min", true],
      ["Minimum shifts", "0", "0.25", true],
      ["Rounding", "0.01 (nearest)", "0.25 (down)", true],
      ["Full-day value", "1", "0.75", true],
      ["Night session", "12 h", "10 h", false],
    ]);
  });

  it("lists rows and breaks that were changed, added and removed, and groups that were added or removed", () => {
    const changes = draftChanges(
      edited((d) => {
        d.groups[0].rules[3].shiftValue = "1.1"; // changed
        d.groups[0].rules.splice(0, 1); // removed
        d.groups[0].rules = addRule(d.groups[0]); // added
        d.breaks[1].endTime = "13:45"; // changed
        d.breaks.splice(4, 1); // removed
        d.groups.splice(2, 1); // a group removed
        d.groups.push(newGroup()); // a group added
      }),
      seeded(),
    );
    const text = changes.map((c) => `${c.label} | ${c.from} | ${c.to}`);
    expect(text).toContain("Sunday shift | in use | removed");
    expect(text).toContain("New group | - | added with 1 row");
    expect(text).toContain("Day shift: row | 10:30 AM = 0.25 shifts | removed");
    expect(text).toContain("Day shift: row | 5:45 PM = 1.00 shifts | 5:45 PM = 1.10 shifts");
    expect(text).toContain("Day shift: row | - | added 6:30 AM next day = 3.00 shifts");
    expect(text).toContain("Break Lunch | 12:45 PM to 1:30 PM | 12:45 PM to 1:45 PM");
    expect(text).toContain("Break Night dinner | 8:00 PM to 9:00 PM | removed");
  });

  it("says a group's own boxes changed", () => {
    const changes = draftChanges(
      edited((d) => (d.groups[1].startTime = "20:30")),
      seeded(),
    );
    expect(changes.map((c) => [c.label, c.from, c.to])).toEqual([["Night shift: settings", "as saved", "changed"]]);
  });
});

describe("production shifts form: the date and the old calculation", () => {
  it("says what the date means, and warns about one in the past", () => {
    expect(dateNote("2026-10-14", "2026-10-14").kind).toBe("today");
    expect(dateNote("2026-10-14", "2026-10-14").text).toContain("Every day before today keeps the old calculation");
    expect(dateNote("2026-11-02", "2026-10-14")).toMatchObject({ kind: "future" });
    const past = dateNote("2026-10-01", "2026-10-14");
    expect(past.kind).toBe("past");
    expect(past.text).toContain("1 Oct 2026 is in the past");
    expect(past.text).toContain("Payslips already generated are never rewritten");
    expect(dateNote("", "2026-10-14").kind).toBe("none");
    expect(dateNote("2026-02-30", "2026-10-14").kind).toBe("none");
  });

  it("describes the old calculation in a line, and says nothing when the server sent nothing", () => {
    expect(legacyText({ punch1Time: "08:30", punch4Time: "20:00", graceMinutes: 10 })).toBe(
      "first punch 8:30 AM, last punch 8:00 PM, grace 10 minutes",
    );
    expect(legacyText(null)).toBe("");
    expect(legacyText({})).toBe("");
    expect(legacyText(undefined)).toBe("");
  });
});

describe("production shifts form: the examples under the boxes", () => {
  it("works the grace example from the Day group: the last on-time minute, the first late one, and leaving a grace early", () => {
    const ex = graceExample(seeded());
    expect(ex).toMatchObject({ group: "Day shift", grace: 5, onTime: "8:35 AM", late: "8:36 AM" });
    // the row closest to one whole shift is 5:45 PM = 1.00; five minutes before it is 5:40 PM
    expect(ex?.snap).toEqual({ leaves: "5:40 PM", counts: "5:45 PM", shifts: "1.00" });
  });

  it("follows the grace on screen, has no leaving example with no grace, and says nothing while the grace cannot be read", () => {
    expect(graceExample(edited((d) => (d.graceMinutes = "0")))?.snap).toBeNull();
    expect(graceExample(edited((d) => (d.graceMinutes = "0")))).toMatchObject({ onTime: "8:30 AM", late: "8:31 AM" });
    expect(graceExample(edited((d) => (d.graceMinutes = "10")))?.snap?.leaves).toBe("5:35 PM");
    expect(graceExample(edited((d) => (d.graceMinutes = "abc")))).toBeNull();
    expect(graceExample(edited((d) => (d.groups = [])))).toBeNull();
  });

  it("takes the first group that is on when there is no Day group", () => {
    const ex = graceExample(
      edited((d) => {
        d.groups[0].enabled = false;
      }),
    );
    expect(ex?.group).toBe("Night shift");
    expect(ex?.onTime).toBe("9:05 PM");
  });

  it("rounds a day's shifts to a step, to the nearest or down", () => {
    expect(roundShifts(1.37, 0.01, "nearest")).toBe(1.37);
    expect(roundShifts(1.37, 0.25, "nearest")).toBe(1.25);
    expect(roundShifts(1.4, 0.25, "nearest")).toBe(1.5);
    expect(roundShifts(1.49, 0.25, "down")).toBe(1.25);
    expect(roundShifts(1.5, 0.25, "down")).toBe(1.5);
    expect(roundShifts(0.62, 0.05, "nearest")).toBe(0.6);
    expect(roundShifts(0.62, 0.05, "down")).toBe(0.6);
    expect(roundShifts(0.999, 0.01, "nearest")).toBe(1);
    expect(roundShifts(1.2, 0, "nearest")).toBe(1.2);
  });
});

describe("production shifts form: what the server refuses, found before the save", () => {
  it("wants the standard departure to be after the group's start", () => {
    const early = validateDraft(edited((d) => (d.groups[0].mainOutTime = "08:00")));
    expect(early.groups[0].errors.mainOut).toBe(
      'The standard departure (8:00 AM) must be after the start time (8:30 AM). For a time after midnight tick "Next day".',
    );
    expect(early.ok).toBe(false);
    expect(early.first).toBe(`Day shift: ${early.groups[0].errors.mainOut}`);
    // exactly at the start is not after it
    expect(validateDraft(edited((d) => (d.groups[0].mainOutTime = "08:30"))).groups[0].errors.mainOut).toContain(
      "must be after the start time",
    );
    // a night group written without "next day" is the usual slip
    const night = validateDraft(edited((d) => (d.groups[1].mainOutNextDay = false)));
    expect(night.groups[1].errors.mainOut).toContain("The standard departure (5:30 AM) must be after");
    // the same time with the tick, and none at all, are fine
    expect(validateDraft(seeded()).groups[1].errors.mainOut).toBeUndefined();
    expect(validateDraft(edited((d) => (d.groups[0].mainOutTime = ""))).ok).toBe(true);
    // the server checks a group that is switched off too
    expect(
      validateDraft(
        edited((d) => {
          d.groups[2].enabled = false;
          d.groups[2].mainOutTime = "07:00";
        }),
      ).groups[2].errors.mainOut,
    ).toContain("must be after the start time");
  });

  it("does not let the minimum credit be more than the most a group in use can pay", () => {
    expect(validateDraft(edited((d) => (d.minCredit = "1"))).ok).toBe(true);
    const high = validateDraft(edited((d) => (d.minCredit = "1.5")));
    expect(high.minCredit).toBe(
      "1.50 is more than the most Sunday shift can pay (1.00): lower it, or add a higher row.",
    );
    expect(high.ok).toBe(false);
    expect(high.first).toBe(`Minimum shifts: ${high.minCredit}`);
    // a group that is off does not count: the next lowest does
    const off = validateDraft(
      edited((d) => {
        d.minCredit = "1.5";
        d.groups[2].enabled = false;
      }),
    );
    expect(off.ok).toBe(true);
    expect(
      validateDraft(
        edited((d) => {
          d.minCredit = "1.6";
          d.groups[2].enabled = false;
        }),
      ).minCredit,
    ).toContain("most Night shift can pay (1.50)");
    // a box that cannot be read keeps its own sentence
    expect(validateDraft(edited((d) => (d.minCredit = "abc"))).minCredit).not.toContain("is more than the most");
  });

  it("refuses two rows of a group on the same paid time: one at the end of a break, or inside it, and one at its start", () => {
    // 1:30 PM is the end of Lunch (12:45 to 1:30): the same paid time as leaving at 12:45
    const end = validateDraft(edited((d) => (d.groups[0].rules[2].outTime = "13:30")));
    expect(end.groups[0].rules[2].paid).toBe(
      "Row 2 (12:45 PM) and this row are on the same paid time, because the break between them is unpaid. Only one of the two can have a rule: remove one, or move it out of the break.",
    );
    expect(end.ok).toBe(false);
    expect(end.first).toBe(`Day shift, row 3: ${end.groups[0].rules[2].paid}`);
    // inside the break it is the same, and it is still advised about as a row inside a break
    const inside = edited((d) => (d.groups[0].rules[2].outTime = "13:00"));
    expect(validateDraft(inside).groups[0].rules[2].paid).toContain("Row 2 (12:45 PM) and this row");
    expect(warningsFor(inside)).toHaveLength(1);
    // a row alone inside a break is only advice (the server says the same)
    expect(validateDraft(edited((d) => (d.groups[0].rules[1].outTime = "13:00"))).ok).toBe(true);
    // a break that is off, a row that is off, and a group that is off make no collision
    const lateRow = (d: ShiftRulesDraft) => (d.groups[0].rules[2].outTime = "13:30");
    expect(
      validateDraft(
        edited((d) => {
          lateRow(d);
          d.breaks[1].enabled = false;
        }),
      ).ok,
    ).toBe(true);
    expect(
      validateDraft(
        edited((d) => {
          lateRow(d);
          d.groups[0].rules[2].enabled = false;
        }),
      ).ok,
    ).toBe(true);
    expect(
      validateDraft(
        edited((d) => {
          lateRow(d);
          d.groups[0].enabled = false;
        }),
      ).groups[0].rules[2].paid,
    ).toBeUndefined();
    // the seeded table (rows at the start of each break) is fine
    expect(validateDraft(seeded()).ok).toBe(true);
  });

  it("counts the break that repeats the next morning when comparing paid time", () => {
    // Night dinner (8 to 9 PM) repeats at 8 to 9 AM the next day: 8:00 AM and 9:00 AM next day are one paid time
    const same = validateDraft(
      edited((d) => {
        const night = d.groups[1];
        night.rules = [
          { ...night.rules[0], outTime: "08:00", outNextDay: true, shiftValue: "1.00" },
          { ...night.rules[1], outTime: "09:00", outNextDay: true, shiftValue: "1.50" },
        ];
        d.breaks[4].startTime = "08:00";
        d.breaks[4].endTime = "09:00";
      }),
    );
    expect(same.groups[1].rules[1].paid).toContain("same paid time");
  });

  it("says plainly that the rules are on while no group is", () => {
    const none = validateDraft(
      edited((d) => {
        for (const g of d.groups) g.enabled = false;
      }),
    );
    expect(none.noGroup).toBe(
      "The rules are switched on but no shift group is switched on: switch a group on, or switch the rules off.",
    );
    expect(none.ok).toBe(false);
    expect(none.first).toBe(none.noGroup);
    expect(validateDraft(edited((d) => (d.groups = []))).noGroup).not.toBeNull();
    // switched off, the rules need no group; and one group on is enough
    expect(
      validateDraft(
        edited((d) => {
          d.enabled = false;
          for (const g of d.groups) g.enabled = false;
        }),
      ).noGroup,
    ).toBeNull();
    expect(validateDraft(seeded()).noGroup).toBeNull();
  });
});

describe("production shifts form: the version a save is based on, and the advice the server repeats", () => {
  it("sends the version the rules were loaded with as expectedVersion, and nothing when there is none", () => {
    expect(toInput(seeded(), "9f2c41d07a3b5e68").expectedVersion).toBe("9f2c41d07a3b5e68");
    expect("expectedVersion" in toInput(seeded())).toBe(false);
    expect("expectedVersion" in toInput(seeded(), null)).toBe(false);
    expect("expectedVersion" in toInput(seeded(), "")).toBe(false);
  });

  const mine =
    "Day shift: leaving at 1:00 PM is inside the break Lunch (12:45 PM to 1:30 PM). A break is never paid, so that row earns what leaving when the break starts earns.";
  const theirs =
    "Day shift: the 13:00 rule falls inside the Lunch (12:45-13:30), which is unpaid, so it counts as 12:45.";
  const other = "No enabled shift group applies on Sunday, so those days are still judged by the old calculation.";

  it("shows our advice once: left out when it is already saved and the server says the same", () => {
    expect(newAdvice([mine], [mine], [theirs])).toEqual([]);
    // the server said nothing about it: ours stays
    expect(newAdvice([mine], [mine], [])).toEqual([mine]);
    expect(newAdvice([mine], [mine], [other])).toEqual([mine]);
    // advice that came with an edit since the save is new, so it is shown
    const fresh =
      "Day shift: leaving at 3:35 PM is inside the break Afternoon tea (3:30 PM to 3:45 PM). A break is never paid, so that row earns what leaving when the break starts earns.";
    expect(newAdvice([mine, fresh], [mine], [theirs])).toEqual([fresh]);
  });
});
