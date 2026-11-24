import { describe, expect, it } from "vitest";
import type { AttendanceEditType } from "@/lib/api-client/custom-hooks";
import {
  buildProposal,
  choiceLabel,
  clBalanceDetail,
  clBalanceText,
  clUseText,
  compensationText,
  editGroups,
  findTile,
  GROUP_LOOK,
  groupNote,
  groupTiles,
  isClassicGroup,
  isPunchTime,
  lockMessage,
  OPTION_GROUPS,
  otText,
  penaltyText,
  pickOf,
  portionFor,
  proposalTitle,
  sendBlocker,
  serverSentence,
  shiftQuestion,
  shiftRange,
  showsPunches,
  startShifts,
  tileTitle,
  type EditTile,
} from "./edit-options";
import {
  clBalance,
  FULL_DAY_REFUSAL,
  LOCK_MESSAGE,
  lockedOptions,
  productionOptions,
  staffOptions,
} from "./edit-fixtures";

// The Edit Attendance form's option catalogue: the groups in the server's order, a tile per sub-choice, what is greyed
// out and why, and exactly what each choice sends to POST /api/attendance/override.

const groupOf = (key: string) => staffOptions().find((g) => g.key === key)!;
const tileOf = (key: string, id: string): EditTile => groupTiles(groupOf(key)).find((t) => t.id === id)!;

describe("the groups", () => {
  it("draws the server's twelve groups in its order", () => {
    expect(editGroups({ types: [], options: staffOptions() }).map((g) => g.key)).toEqual([
      "worked",
      "compensation",
      "not_worked",
      "permission",
      "late",
      "early_out",
      "casual_leave",
      "leave",
      "on_duty",
      "missing_punch",
      "penalty_waiver",
      "ot_pay",
    ]);
  });

  it("knows the look of every newer group, each its own colour", () => {
    expect(OPTION_GROUPS).toEqual([
      "permission",
      "late",
      "early_out",
      "casual_leave",
      "leave",
      "on_duty",
      "missing_punch",
      "penalty_waiver",
      "ot_pay",
    ]);
    const solids = Object.values(GROUP_LOOK).map((l) => l.solid);
    expect(new Set(solids).size).toBe(solids.length);
    expect(GROUP_LOOK.leave.title).toBe("Leave");
    expect(GROUP_LOOK.not_worked.hint).toBe("Absent or a holiday");
  });

  it("no longer offers On Leave under Not worked: the Leave group records the leave", () => {
    expect(groupTiles(groupOf("not_worked")).map((t) => t.id)).toEqual(["absent", "holiday"]);
  });

  it("builds the first three groups from the old types when an older server sends no catalogue", () => {
    const types: AttendanceEditType[] = [
      {
        key: "half_day",
        label: "Half Day",
        group: "Attendance",
        status: "half_shift",
        shifts: "0.50",
        description: "Half a day",
        worked: true,
        shiftChoices: [],
        compensation: false,
      },
      {
        key: "holiday",
        label: "Holiday",
        group: "Other",
        status: "holiday",
        shifts: "0.00",
        description: "A holiday",
        worked: false,
        shiftChoices: [],
        compensation: false,
      },
    ];
    const groups = editGroups({ types });
    expect(groups.map((g) => g.key)).toEqual(["worked", "not_worked"]);
    expect(groups[0].items[0]).toMatchObject({ key: "half_day", group: "worked", available: true, choices: [] });
    expect(isClassicGroup("worked")).toBe(true);
    expect(isClassicGroup("permission")).toBe(false);
  });
});

describe("the tiles", () => {
  it("gives an old type one tile with its shift value, as before", () => {
    const [present, half] = groupTiles(groupOf("worked"));
    expect(present).toMatchObject({
      id: "present",
      testId: "pd-edit-type-present",
      label: "Present",
      chip: "1.00 shift",
    });
    expect(half.chip).toBe("0.50 shift");
    // a compensation type lists only the amounts that fit the balance and the day
    expect(groupTiles(groupOf("compensation"))[0].chip).toBe("0.25 to 0.50 shift");
    expect(shiftRange(["0.25", "0.50", "0.75", "1.00"])).toBe("0.25 to 1.00 shift");
    expect(shiftRange(["0.25"])).toBe("0.25 shift");
    expect(shiftRange([])).toBe("");
  });

  it("gives the 2026-11-24 options their tiles: Early-Out marks, leave reasons, punch slots, waiver, OT", () => {
    expect(groupTiles(groupOf("early_out")).map((t) => [t.label, t.chip, t.available])).toEqual([
      ["Mark as Early-Out", "Counts as an Early-Out", true],
      ["Unmark Early-Out", "Early-Out mark removed", false],
    ]);
    expect(groupTiles(groupOf("leave")).map((t) => [t.testId, t.label, t.chip])).toEqual([
      ["pd-edit-type-leave-sick", "Sick Leave", ""],
      ["pd-edit-type-leave-emergency", "Emergency", ""],
      ["pd-edit-type-leave-personal", "Personal", ""],
      ["pd-edit-type-leave-other", "Other Reasons", ""],
    ]);
    expect(groupTiles(groupOf("missing_punch")).map((t) => [t.label, t.chip, t.available])).toEqual([
      ["Morning Check-In", "IN punch", true],
      ["Lunch Check-Out", "OUT punch", true],
      ["Lunch Check-In", "IN punch", false],
      ["Evening Check-Out", "OUT punch", true],
    ]);
    expect(groupTiles(groupOf("penalty_waiver"))[0]).toMatchObject({
      testId: "pd-edit-type-penalty_waiver",
      chip: "0.25 shift back",
      available: true,
    });
    expect(groupTiles(groupOf("ot_pay"))[0]).toMatchObject({ testId: "pd-edit-type-ot_pay", chip: "95 min overtime" });
  });

  it("does not repeat the Payroll Done lock on every group and tile: the form says it once", () => {
    const groups = lockedOptions();
    for (const g of groups) {
      expect(groupNote(g)).toBe(LOCK_MESSAGE);
      expect(groupNote(g, LOCK_MESSAGE)).toBeNull();
      const tiles = groupTiles(g, LOCK_MESSAGE);
      expect(tiles.every((t) => !t.available && t.reason === null)).toBe(true);
    }
    // another reason is still said
    const production = productionOptions().find((g) => g.key === "compensation")!;
    expect(groupNote(production, LOCK_MESSAGE)).toBe(
      "Compensation applies to staff employees only: production attendance has no compensation balance.",
    );
  });

  it("gives Permission a tile per type, each an hour, the taken one greyed out with the server's reason", () => {
    const tiles = groupTiles(groupOf("permission"));
    expect(tiles.map((t) => t.label)).toEqual(["Morning Late-In", "Evening Early-Out", "Middle One-Hour"]);
    expect(tiles.map((t) => t.chip)).toEqual(["60 min", "60 min", "60 min"]);
    expect(tiles[0]).toMatchObject({
      testId: "pd-edit-type-permission-morning_late_in",
      available: false,
      reason: "02 Nov 2026 already has an approved Morning Late-In permission.",
    });
    expect(tiles[1].available).toBe(true);
    expect(choiceLabel({ group: "late" }, { label: "Mark as Late" })).toBe("Mark as Late");
  });

  it("gives Late its two marks and Casual Leave its three portions with the days they use", () => {
    expect(groupTiles(groupOf("late")).map((t) => [t.label, t.chip, t.available])).toEqual([
      ["Mark as Late", "Counts as a Late", false],
      ["Unmark Late", "Late mark removed", true],
    ]);
    expect(groupTiles(groupOf("casual_leave")).map((t) => [t.label, t.chip, t.available])).toEqual([
      ["Full day", "1 day", false],
      ["First half", "0.5 day", true],
      ["Second half", "0.5 day", true],
    ]);
    expect(groupTiles(groupOf("on_duty"))[0]).toMatchObject({ label: "On-Duty", chip: "Present · 1.00 shift" });
  });

  it("says a reason shared by the whole group once, not on every tile (a production employee has no Permission)", () => {
    const permission = productionOptions().find((g) => g.key === "permission")!;
    expect(groupNote(permission)).toBe("Permission applies to staff only: production attendance has no permissions.");
    const tiles = groupTiles(permission);
    expect(tiles.every((t) => !t.available)).toBe(true);
    expect(tiles.every((t) => t.reason === null)).toBe(true);
    // a group where only some choices are refused has no group note
    expect(groupNote(groupOf("late"))).toBeNull();
    expect(groupNote(groupOf("permission"))).toBeNull();
  });

  it("names the chosen tile the way the calendar's ! will", () => {
    expect(tileTitle(tileOf("permission", "permission:evening_early_out"))).toBe("Permission · Evening Early-Out");
    expect(tileTitle(tileOf("late", "late:unmark"))).toBe("Unmark Late");
    expect(tileTitle(tileOf("casual_leave", "casual_leave:first_half"))).toBe("Casual Leave · First half");
    expect(tileTitle(tileOf("worked", "half_day"))).toBe("Half Day");
    expect(tileTitle(tileOf("on_duty", "on_duty"))).toBe("On-Duty");
    expect(tileTitle(tileOf("early_out", "early_out:mark"))).toBe("Mark as Early-Out");
    expect(tileTitle(tileOf("leave", "leave:sick"))).toBe("Leave · Sick Leave");
    expect(tileTitle(tileOf("missing_punch", "missing_punch:morning_in"))).toBe("Missing Punch · Morning Check-In");
    expect(tileTitle(tileOf("penalty_waiver", "penalty_waiver"))).toBe("Penalty Waiver");
  });

  it("names the change with its details the way the request will", () => {
    expect(proposalTitle(tileOf("leave", "leave:sick"), { portion: "first_half" })).toBe(
      "Leave · Sick Leave · First half",
    );
    expect(proposalTitle(tileOf("leave", "leave:other"), { portion: "full" })).toBe("Leave · Other Reasons");
    expect(proposalTitle(tileOf("missing_punch", "missing_punch:morning_in"), { punchTime: "09:05:00" })).toBe(
      "Missing Punch · Morning Check-In 09:05",
    );
    expect(proposalTitle(tileOf("ot_pay", "ot_pay"), { shifts: "0.50" })).toBe("OT Pay · 0.50 shift");
    expect(proposalTitle(tileOf("late", "late:unmark"))).toBe("Unmark Late");
  });

  it("finds a pick again in a fresh catalogue, and forgets it when it is no longer offered", () => {
    const groups = staffOptions();
    const tile = tileOf("late", "late:unmark");
    expect(findTile(groups, pickOf(tile))?.id).toBe("late:unmark");
    expect(findTile(groups, { itemKey: "late", choice: "sideways" })).toBeNull();
    expect(findTile(groups, null)).toBeNull();
  });

  it("shows the punch times and the Late / Early Out switches only for the old worked types", () => {
    expect(showsPunches(tileOf("worked", "half_day").item)).toBe(true);
    expect(showsPunches(tileOf("not_worked", "absent").item)).toBe(false);
    // the server marks these "worked", but they send no punch times
    expect(showsPunches(tileOf("late", "late:unmark").item)).toBe(false);
    expect(showsPunches(tileOf("on_duty", "on_duty").item)).toBe(false);
    expect(showsPunches(tileOf("permission", "permission:middle_permission").item)).toBe(false);
    // a compensation type is topped up from the balance: no punch times since 2026-11-24
    expect(showsPunches(tileOf("compensation", "sunday_compensation").item)).toBe(false);
    expect(showsPunches(tileOf("missing_punch", "missing_punch:lunch_out").item)).toBe(false);
  });
});

describe("the details of the newer options", () => {
  it("starts each tile from its own shift value: OT Pay the overtime detected, compensation the most that fits", () => {
    expect(startShifts(tileOf("ot_pay", "ot_pay").item)).toBe("0.50");
    expect(startShifts({ ...tileOf("ot_pay", "ot_pay").item, defaultShifts: null })).toBe("");
    // the day counts 0.50, so 1.00 no longer fits: 0.50 is the most
    expect(startShifts(tileOf("compensation", "sunday_compensation").item)).toBe("0.50");
    expect(startShifts({ ...tileOf("compensation", "sunday_compensation").item, shiftChoices: ["0.25", "1.00"] })).toBe(
      "1.00",
    );
    expect(startShifts(tileOf("worked", "half_day").item)).toBe("0.50");
    expect(startShifts(tileOf("late", "late:mark").item)).toBe("");
  });

  it("starts Leave on the first part of the day that can be chosen, and keeps a choice that still can", () => {
    const leave = tileOf("leave", "leave:sick").item;
    expect(portionFor(leave)).toBe("first_half"); // the full day is refused
    expect(portionFor(leave, "second_half")).toBe("second_half");
    expect(portionFor(leave, "full")).toBe("first_half");
    expect(portionFor({ portions: undefined })).toBeNull();
  });

  it("says what the compensation, the waiver and the overtime are", () => {
    expect(compensationText(tileOf("compensation", "sunday_compensation").item)).toBe(
      "The day counts 0.50 shift now · balance available 2.50 shift",
    );
    expect(compensationText({ dayShifts: undefined, balanceAvailable: undefined })).toBeNull();
    expect(penaltyText(tileOf("penalty_waiver", "penalty_waiver").item)).toBe(
      "0.25 shift is added back (left 80 min early)",
    );
    expect(penaltyText({ shifts: "0.00", penaltyMinutes: 0 })).toBeNull();
    expect(penaltyText({ shifts: "0.25", penaltyMinutes: 0 })).toBe("0.25 shift is added back");
    expect(otText(tileOf("ot_pay", "ot_pay").item)).toBe("Overtime detected: 95 min");
    expect(otText({ otMinutes: null })).toBeNull();
    expect(shiftQuestion({ group: "ot_pay" })).toBe("How much overtime to pay?");
    expect(shiftQuestion({ group: "compensation" })).toBe("How much of the balance to use?");
  });

  it("reads a punch time and the Payroll Done lock", () => {
    expect(isPunchTime("09:05")).toBe(true);
    expect(isPunchTime("23:59:30")).toBe(true);
    expect(isPunchTime("24:00")).toBe(false);
    expect(isPunchTime("9:5")).toBe(false);
    expect(isPunchTime("")).toBe(false);
    expect(lockMessage({ locked: { locked: true, message: LOCK_MESSAGE } })).toBe(LOCK_MESSAGE);
    expect(lockMessage({ locked: { locked: true, message: null } })).toContain("Payroll Done");
    expect(lockMessage({ locked: { locked: false, message: null } })).toBeNull();
    expect(lockMessage({})).toBeNull(); // an older server
  });
});

describe("what is sent", () => {
  const base = { employeeId: 7, date: "2026-11-02", note: "  Verified with the supervisor  " };

  it("sends a permission as its type and choice, nothing else", () => {
    expect(buildProposal({ ...base, tile: tileOf("permission", "permission:evening_early_out") })).toEqual({
      employeeId: 7,
      date: "2026-11-02",
      type: "permission",
      note: "Verified with the supervisor",
      choice: "evening_early_out",
    });
  });

  it("sends Mark / Unmark Late and a Casual Leave portion the same way", () => {
    expect(buildProposal({ ...base, tile: tileOf("late", "late:unmark"), late: true })).toEqual({
      employeeId: 7,
      date: "2026-11-02",
      type: "late",
      note: "Verified with the supervisor",
      choice: "unmark",
    });
    expect(buildProposal({ ...base, tile: tileOf("casual_leave", "casual_leave:second_half") })).toMatchObject({
      type: "casual_leave",
      choice: "second_half",
    });
  });

  it("sends On-Duty with the destination when one is written (trimmed, at most 200 characters)", () => {
    const tile = tileOf("on_duty", "on_duty");
    expect(buildProposal({ ...base, tile, destination: "  Erode mill " })).toEqual({
      employeeId: 7,
      date: "2026-11-02",
      type: "on_duty",
      note: "Verified with the supervisor",
      destination: "Erode mill",
    });
    expect(buildProposal({ ...base, tile, destination: "   " })).not.toHaveProperty("destination");
    expect(buildProposal({ ...base, tile, destination: "x".repeat(250) }).destination).toHaveLength(200);
  });

  it("sends an old type exactly as before", () => {
    const half = buildProposal({
      ...base,
      tile: tileOf("worked", "half_day"),
      firstIn: "09:00",
      lastOut: "13:00",
      late: true,
      earlyOut: false,
    });
    expect(half).toEqual({
      employeeId: 7,
      date: "2026-11-02",
      type: "half_day",
      note: "Verified with the supervisor",
      shifts: undefined,
      firstPunch: "09:00",
      lastPunch: "13:00",
      isLate: true,
      isEarlyOut: false,
    });
    // a compensation type: the shift taken from the balance, no punch times (it is not a "worked" type any more)
    expect(buildProposal({ ...base, tile: tileOf("compensation", "sunday_compensation"), shifts: "0.50" })).toEqual({
      employeeId: 7,
      date: "2026-11-02",
      type: "sunday_compensation",
      note: "Verified with the supervisor",
      shifts: "0.50",
      firstPunch: null,
      lastPunch: null,
      isLate: false,
      isEarlyOut: false,
    });
    expect(buildProposal({ ...base, tile: tileOf("not_worked", "absent"), late: true })).toMatchObject({
      type: "absent",
      firstPunch: null,
      lastPunch: null,
      isLate: false,
      isEarlyOut: false,
    });
  });

  it("sends Mark as Early-Out as its type and choice", () => {
    expect(buildProposal({ ...base, tile: tileOf("early_out", "early_out:mark"), earlyOut: false })).toEqual({
      employeeId: 7,
      date: "2026-11-02",
      type: "early_out",
      note: "Verified with the supervisor",
      choice: "mark",
    });
  });

  it("sends a leave with its reason and its part of the day", () => {
    expect(buildProposal({ ...base, tile: tileOf("leave", "leave:sick"), portion: "first_half" })).toEqual({
      employeeId: 7,
      date: "2026-11-02",
      type: "leave",
      note: "Verified with the supervisor",
      choice: "sick",
      portion: "first_half",
    });
    // the part of the day is only sent for a leave
    expect(buildProposal({ ...base, tile: tileOf("late", "late:unmark"), portion: "full" })).not.toHaveProperty(
      "portion",
    );
  });

  it("sends a missing punch with its slot and its time as HH:MM", () => {
    expect(
      buildProposal({ ...base, tile: tileOf("missing_punch", "missing_punch:morning_in"), punchTime: " 09:05:00 " }),
    ).toEqual({
      employeeId: 7,
      date: "2026-11-02",
      type: "missing_punch",
      note: "Verified with the supervisor",
      choice: "morning_in",
      punchTime: "09:05",
    });
    expect(buildProposal({ ...base, tile: tileOf("on_duty", "on_duty"), punchTime: "09:05" })).not.toHaveProperty(
      "punchTime",
    );
  });

  it("sends a penalty waiver with nothing but the reason, and OT Pay with its shifts", () => {
    expect(buildProposal({ ...base, tile: tileOf("penalty_waiver", "penalty_waiver"), shifts: "1.00" })).toEqual({
      employeeId: 7,
      date: "2026-11-02",
      type: "penalty_waiver",
      note: "Verified with the supervisor",
    });
    expect(buildProposal({ ...base, tile: tileOf("ot_pay", "ot_pay"), shifts: "0.75" })).toEqual({
      employeeId: 7,
      date: "2026-11-02",
      type: "ot_pay",
      note: "Verified with the supervisor",
      shifts: "0.75",
    });
  });
});

describe("when it can be sent", () => {
  const ok = { noHod: false, future: false, note: "CCTV checked" };

  it("needs a Department Head, a day that has come, a tile that can be chosen and a reason", () => {
    const tile = tileOf("late", "late:unmark");
    expect(sendBlocker({ ...ok, tile })).toBeNull();
    expect(sendBlocker({ ...ok, tile, noHod: true })).toBe("Assign a Department Head to send this.");
    expect(sendBlocker({ ...ok, tile, future: true })).toBe("This day has not come yet.");
    expect(sendBlocker({ ...ok, tile: null })).toBe("Choose what the day should be.");
    expect(sendBlocker({ ...ok, tile, note: " a " })).toBe("Write the reason to send it.");
  });

  it("refuses a tile the server greyed out, with the server's reason", () => {
    expect(sendBlocker({ ...ok, tile: tileOf("late", "late:mark") })).toBe("02 Nov 2026 is already marked Late.");
  });

  it("insists on a sub-choice where the server requires one", () => {
    const permission = groupOf("permission").items[0];
    const bare: EditTile = { ...tileOf("permission", "permission:evening_early_out"), choice: null, item: permission };
    expect(sendBlocker({ ...ok, tile: bare })).toBe("Choose one of its options.");
  });

  it("refuses everything on a day whose payroll is finalized, before anything else", () => {
    const tile = tileOf("late", "late:unmark");
    expect(sendBlocker({ ...ok, tile, locked: LOCK_MESSAGE })).toBe(LOCK_MESSAGE);
    expect(sendBlocker({ ...ok, tile: null, noHod: true, locked: LOCK_MESSAGE })).toBe(LOCK_MESSAGE);
    expect(sendBlocker({ ...ok, tile, locked: null })).toBeNull();
    // the locked catalogue's own tiles say it too
    const lockedTile = groupTiles(lockedOptions().find((g) => g.key === "leave")!)[0];
    expect(sendBlocker({ ...ok, tile: lockedTile })).toBe(LOCK_MESSAGE);
  });

  it("needs a part of the day that can be chosen for a leave", () => {
    const tile = tileOf("leave", "leave:emergency");
    expect(sendBlocker({ ...ok, tile, portion: "second_half" })).toBeNull();
    expect(sendBlocker({ ...ok, tile, portion: null })).toBe(
      "Choose the part of the day: Full day, First half or Second half.",
    );
    expect(sendBlocker({ ...ok, tile, portion: "full" })).toBe(FULL_DAY_REFUSAL);
  });

  it("needs the time of a missing punch, typed as hours and minutes", () => {
    const tile = tileOf("missing_punch", "missing_punch:evening_out");
    expect(sendBlocker({ ...ok, tile, punchTime: "" })).toBe("Type the time of the missing punch.");
    expect(sendBlocker({ ...ok, tile })).toBe("Type the time of the missing punch.");
    expect(sendBlocker({ ...ok, tile, punchTime: "7 pm" })).toBe(
      "Type the punch time as hours and minutes, like 09:05.",
    );
    expect(sendBlocker({ ...ok, tile, punchTime: "19:02" })).toBeNull();
    // the slot that already has a waiting request cannot be chosen
    expect(sendBlocker({ ...ok, tile: tileOf("missing_punch", "missing_punch:lunch_in"), punchTime: "13:30" })).toBe(
      "A Lunch Check-In request for 02 Nov 2026 is waiting for approval: decide that request instead.",
    );
  });

  it("needs the overtime shifts for OT Pay and an amount that fits for compensation", () => {
    const ot = tileOf("ot_pay", "ot_pay");
    expect(sendBlocker({ ...ok, tile: ot, shifts: "" })).toBe("Choose how much overtime to pay.");
    expect(sendBlocker({ ...ok, tile: ot, shifts: "0.50" })).toBeNull();
    const comp = tileOf("compensation", "sunday_compensation");
    expect(sendBlocker({ ...ok, tile: comp, shifts: "1.00" })).toBe("Choose how much of the balance to use.");
    expect(sendBlocker({ ...ok, tile: comp, shifts: "0.25" })).toBeNull();
    // a penalty waiver needs only the reason
    expect(sendBlocker({ ...ok, tile: tileOf("penalty_waiver", "penalty_waiver") })).toBeNull();
    expect(sendBlocker({ ...ok, tile: tileOf("penalty_waiver", "penalty_waiver"), note: "" })).toBe(
      "Write the reason to send it.",
    );
  });
});

describe("the server's words", () => {
  it("shows the plain sentence of a refused request", () => {
    expect(
      serverSentence({ data: { error: "02 Nov 2026 is already marked Late." }, message: "HTTP 400 Bad Request: x" }),
    ).toBe("02 Nov 2026 is already marked Late.");
    expect(serverSentence(new Error("HTTP 400 Bad Request: Choose Mark as Late or Unmark Late."))).toBe(
      "Choose Mark as Late or Unmark Late.",
    );
    expect(serverSentence(new Error("Failed to fetch"))).toBe("Failed to fetch");
    expect(serverSentence(null)).toBe("The change could not be sent. Try again.");
  });
});

describe("the Casual Leave balance", () => {
  it("says how much of the year's 12 is left and what one portion would use", () => {
    expect(clBalanceText(clBalance({ used: 1, pending: 0, remaining: 11 }))).toBe("11 of 12 left in 2026");
    expect(clBalanceText(clBalance())).toBe("0.5 of 12 left in 2026");
    expect(clBalanceDetail(clBalance())).toBe("11 used · 0.5 waiting for approval");
    expect(clBalanceText(null)).toBeNull();
    expect(clBalanceText(clBalance({ tracked: false, since: null, year: 2025 }))).toBe(
      "No Casual Leave balance is kept for 2025",
    );
    expect(clUseText(clBalance({ used: 1, pending: 0, remaining: 11 }), 0.5)).toBe(
      "Uses 0.5 day of the balance: 11 of 12 left now, 10.5 once approved.",
    );
    expect(clUseText(null, 1)).toBeNull();
  });
});
