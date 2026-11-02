import { describe, expect, it } from "vitest";
import type { AttendanceEditType } from "@/lib/api-client/custom-hooks";
import {
  buildProposal,
  choiceLabel,
  clBalanceDetail,
  clBalanceText,
  clUseText,
  editGroups,
  findTile,
  groupNote,
  groupTiles,
  isClassicGroup,
  pickOf,
  sendBlocker,
  serverSentence,
  showsPunches,
  tileTitle,
  type EditTile,
} from "./edit-options";
import { clBalance, productionOptions, staffOptions } from "./edit-fixtures";

// The Edit Attendance form's option catalogue: the groups in the server's order, a tile per sub-choice, what is greyed
// out and why, and exactly what each choice sends to POST /api/attendance/override.

const groupOf = (key: string) => staffOptions().find((g) => g.key === key)!;
const tileOf = (key: string, id: string): EditTile => groupTiles(groupOf(key)).find((t) => t.id === id)!;

describe("the groups", () => {
  it("draws the server's seven groups in its order", () => {
    expect(editGroups({ types: [], options: staffOptions() }).map((g) => g.key)).toEqual([
      "worked",
      "compensation",
      "not_worked",
      "permission",
      "late",
      "casual_leave",
      "on_duty",
    ]);
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
    expect(groupTiles(groupOf("compensation"))[0].chip).toBe("0.25 to 1.00 shift");
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
    expect(
      buildProposal({ ...base, tile: tileOf("compensation", "sunday_compensation"), shifts: "0.75" }),
    ).toMatchObject({ type: "sunday_compensation", shifts: "0.75", isLate: false });
    expect(buildProposal({ ...base, tile: tileOf("not_worked", "absent"), late: true })).toMatchObject({
      type: "absent",
      firstPunch: null,
      lastPunch: null,
      isLate: false,
      isEarlyOut: false,
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
