import { describe, expect, it } from "vitest";
import type { ApprovalProgress } from "@/lib/approval-workflow";
import { claim, placementCalendar, placementDays, placementItem, placementSource } from "../fixtures";
import {
  WORKFLOW_OFF,
  amountProblem,
  amountsFor,
  blockReason,
  canChooseDateFor,
  canPick,
  capOf,
  claimSource,
  dayProblem,
  dayText,
  defaultAmount,
  holidayWorkSource,
  hrMayApprovePlacement,
  hrMayRejectPlacement,
  monthWeeks,
  overtimeSource,
  placedByText,
  placedDayLine,
  placedMark,
  placementChip,
  placementRequestsLink,
  placementStageText,
  placementStatusText,
  placementTone,
  restText,
  shiftNumber,
  shiftWord,
  sourceFiguresText,
  sourceKeyOfCalendar,
  summaryText,
  waitsForHr,
} from "./place-comp-logic";

// Compensation days on a date HR chooses (owner brief 2026-11-28): the words of the dialog, the choice kept inside what is
// left (and inside the credit HR gives a day off worked), and the month laid out Monday first.

const day = (date: string) => placementDays("2026-10", 1).find((d) => d.date === date)!;

describe("words", () => {
  it("writes amounts the way the server does", () => {
    expect(shiftNumber(0.5)).toBe("0.50");
    expect(shiftNumber(1)).toBe("1.00");
    expect(shiftWord(0.5)).toBe("0.50 shift");
    expect(shiftWord(1)).toBe("1.00 shift");
    expect(shiftWord(1.5)).toBe("1.50 shifts");
  });

  it("says the day as 'Wed 2 Dec'", () => {
    expect(dayText("2026-12-02")).toBe("Wed 2 Dec");
    expect(dayText("bad")).toBe("—");
  });

  it("says who takes what off and where it goes", () => {
    expect(summaryText("Asha K", 0.5, "2026-12-02")).toBe(
      "Asha K takes 0.50 shift off on Wed 2 Dec. It goes to the Department Head, then HR.",
    );
  });

  it("names every source in its string form", () => {
    expect(overtimeSource(12)).toBe("overtime:12");
    expect(holidayWorkSource("2026-11-22")).toBe("holiday_work:2026-11-22");
    expect(claimSource(40)).toBe("claim:40");
  });

  it("sends the source the calendar answered for", () => {
    expect(sourceKeyOfCalendar(placementSource())).toEqual({ type: "balance" });
    expect(sourceKeyOfCalendar(placementSource({ type: "claim", id: 40 }))).toEqual({ type: "claim", id: 40 });
    expect(sourceKeyOfCalendar(placementSource({ type: "overtime", id: 12 }))).toEqual({ type: "overtime", id: 12 });
    expect(sourceKeyOfCalendar(placementSource({ type: "holiday_work", date: "2026-11-22" }))).toEqual({
      type: "holiday_work",
      date: "2026-11-22",
    });
  });

  it("puts the figures of a source in a line", () => {
    expect(sourceFiguresText(placementSource({ total: 1, placed: 0.25, left: 0.75 }))).toBe(
      "Total 1.00 · placed 0.25 · left 0.75",
    );
  });
});

describe("what can be placed", () => {
  it("is what the source has left, and never more than the credit HR gives a day off worked", () => {
    expect(capOf(placementSource({ left: 0.75 }), 1)).toBe(0.75);
    const worked = placementSource({ type: "holiday_work", creditFixed: false, left: 1, placesAtOnce: true });
    expect(capOf(worked, 0.5)).toBe(0.5);
    expect(capOf(worked, 1)).toBe(1);
    expect(capOf(placementSource({ canPlace: false, left: 1 }), 1)).toBe(0);
  });

  it("offers the amounts a day takes within that, the most that fits by default", () => {
    expect(amountsFor(day("2026-10-15"), 1)).toEqual([0.25, 0.5, 0.75, 1]);
    expect(amountsFor(day("2026-10-15"), 0.5)).toEqual([0.25, 0.5]);
    expect(defaultAmount(day("2026-10-15"), 1)).toBe(1);
    expect(defaultAmount(day("2026-10-15"), 0.5)).toBe(0.5);
    // a half day takes at most its other half
    expect(amountsFor(day("2026-10-06"), 1)).toEqual([0.25, 0.5]);
    expect(defaultAmount(day("2026-10-06"), 1)).toBe(0.5);
  });

  it("says why a day cannot be picked: the server's reason", () => {
    expect(canPick(day("2026-10-11"), 1)).toBe(false);
    expect(dayProblem(day("2026-10-11"), 1)).toBe("A Sunday is already a day off: choose a working day.");
    expect(dayProblem(day("2026-10-07"), 1)).toBe("Casual Leave is already asked for or approved on this day.");
    expect(dayProblem(day("2026-10-15"), 1)).toBeNull();
    // nothing left: the server's days carry no amounts, and the day says what it is
    const none = placementDays("2026-10", 0).find((d) => d.date === "2026-10-15")!;
    expect(dayProblem(none, 0)).toBe("Still to come: it cannot be chosen.");
  });

  it("says why an amount cannot be placed on a day", () => {
    expect(amountProblem(day("2026-10-15"), 1, 0.5)).toBe("Only 0.50 shift is left to place.");
    expect(amountProblem(day("2026-10-06"), 0.75, 1)).toBe("This day can take at most 0.50 shift.");
    expect(amountProblem(day("2026-10-06"), 0.5, 1)).toBeNull();
  });

  it("lays the month out Monday first (1 Oct 2026 is a Thursday)", () => {
    const weeks = monthWeeks(placementDays("2026-10", 1));
    expect(weeks).toHaveLength(5);
    expect(weeks[0].slice(0, 3)).toEqual([null, null, null]);
    expect(weeks[0][3]?.date).toBe("2026-10-01");
    expect(weeks[4][5]?.date).toBe("2026-10-31");
    expect(weeks[4][6]).toBeNull();
    expect(monthWeeks([])).toEqual([]);
  });

  it("marks a day with a placement on it", () => {
    const days = placementDays("2026-10", 1, [placementItem(77)]);
    expect(placedMark(days.find((d) => d.date === "2026-10-08")!)).toBe("Comp");
    expect(placedMark(days.find((d) => d.date === "2026-10-15")!)).toBeNull();
  });
});

describe("the rest", () => {
  it("of a credit placed at once stays in the balance", () => {
    const worked = placementSource({ type: "holiday_work", creditFixed: false, placesAtOnce: true });
    expect(restText(worked, 1, 0.5)).toBe("The credit is 1.00 shift: the rest (0.50 shift) stays in the balance.");
    expect(restText(worked, 0.5, 0.5)).toBeNull();
    const shift = placementSource({ type: "overtime", total: 0.75, left: 0.75, placesAtOnce: true });
    expect(restText(shift, 1, 0.25)).toBe("The credit is 0.75 shift: the rest (0.50 shift) stays in the balance.");
  });

  it("of an approved credit or of the balance can be placed later", () => {
    expect(restText(placementSource({ type: "claim", left: 1 }), 1, 0.25)).toBe(
      "0.75 shift of this credit stays in the balance, to place later.",
    );
    expect(restText(placementSource({ left: 1.5 }), 1, 1)).toBe("0.50 shift of the balance stays, to place later.");
    expect(restText(placementSource({ left: 1 }), 1, 1)).toBeNull();
  });
});

describe("what stops Send", () => {
  it("is the switch, then the source's refusal, then the Department Head, then the login's right", () => {
    const cal = placementCalendar();
    expect(blockReason(cal, null)).toBeNull();
    expect(blockReason(cal, "Needs Edit")).toBe("Needs Edit");
    expect(blockReason({ ...cal, hodProblem: "No Department Head." }, "Needs Edit")).toBe("No Department Head.");
    expect(
      blockReason({ ...cal, source: placementSource({ canPlace: false, refusal: "All of it is placed." }) }, null),
    ).toBe("All of it is placed.");
    expect(blockReason({ ...cal, workflowOn: false, hodProblem: "No Department Head." }, null)).toBe(WORKFLOW_OFF);
  });
});

describe("the open placements", () => {
  it("say where each stands, in tone and words", () => {
    expect(placementTone(placementItem(1, { stage: "hod" }))).toBe("indigo");
    expect(placementTone(placementItem(1, { stage: "hr" }))).toBe("amber");
    expect(placementTone(placementItem(1, { status: "approved", stage: null }))).toBe("teal");
    expect(placementStatusText(placementItem(1, { statusLabel: "" }))).toBe(
      "Approved by the Department Head, waiting for HR",
    );
    expect(placementStatusText(placementItem(1, { statusLabel: "", stage: "hod" }))).toBe(
      "Waiting for the Department Head",
    );
    expect(placedByText(placementItem(1))).toBe("HR (Meena)");
    expect(placedByText(placementItem(1, { raisedByRole: "employee" }))).toBe("Employee (app)");
  });

  it("send HR to Requests only when it is HR's turn on a date HR chose", () => {
    expect(waitsForHr(placementItem(1))).toBe(true);
    expect(waitsForHr(placementItem(1, { stage: "hod" }))).toBe(false);
    expect(waitsForHr(placementItem(1, { hrStep: false }))).toBe(false);
    expect(placementRequestsLink(77)).toBe("/hr/requests?kind=compensation_placement&focus=77");
  });
});

const hrTurn = (turn: boolean): ApprovalProgress => ({
  workflow: "compensation_placement",
  label: "Compensation days",
  enabled: true,
  steps: [],
  currentStep: turn ? 1 : 0,
  waitingFor: [turn ? "hr" : "hod"],
  canAct: { hod: !turn, hr: turn },
  canReject: { hod: !turn, hr: turn },
  hrTurn: turn,
});

describe("a row of the Claims list", () => {
  it("offers Choose date for an approved credit with some still to place", () => {
    expect(canChooseDateFor(claim(1, { status: "approved", leftToPlace: 0.5 }))).toBe(true);
    expect(canChooseDateFor(claim(1, { status: "approved", kind: "ot_shift", leftToPlace: 1 }))).toBe(true);
    expect(canChooseDateFor(claim(1, { status: "approved", leftToPlace: 0 }))).toBe(false);
    expect(canChooseDateFor(claim(1, { status: "pending", leftToPlace: 1 }))).toBe(false);
    expect(canChooseDateFor(claim(1, { status: "approved", kind: "use_balance", leftToPlace: 1 }))).toBe(false);
    expect(canChooseDateFor(claim(1, { status: "approved" }))).toBe(false);
  });

  it("says the day off and the stage of a date HR chose", () => {
    const placed = claim(1, { hrStep: true, stage: "hr", useDate: "2026-12-02", useShifts: 0.5, statusLabel: null });
    expect(placedDayLine(placed)).toBe("Day off on 2 Dec 2026 · 0.50 shift");
    expect(placementStageText(placed)).toBe("Approved by the Department Head, waiting for HR");
    expect(placementStageText({ ...placed, stage: "hod" })).toBe("Waiting for the Department Head");
    expect(placementStageText({ ...placed, status: "approved" })).toBeNull();
    expect(placementChip(placed)).toEqual({
      text: "Waiting for HR",
      title: "Approved by the Department Head, waiting for HR",
      done: "Approved by the Department Head",
    });
    expect(placementChip({ ...placed, stage: "hod" })).toEqual({
      text: "Waiting for the Department Head",
      title: "Waiting for the Department Head",
      done: null,
    });
    expect(placementChip({ ...placed, hrStep: false })).toBeNull();
    expect(placedDayLine(claim(1, { useDate: "2026-12-02" }))).toBeNull();
  });

  it("lets HR decide only once the Department Head has approved", () => {
    const placed = claim(1, { hrStep: true, stage: "hr", approval: hrTurn(true) });
    expect(hrMayApprovePlacement(placed)).toBe(true);
    expect(hrMayRejectPlacement(placed)).toBe(true);
    expect(hrMayApprovePlacement({ ...placed, approval: hrTurn(false) })).toBe(false);
    expect(hrMayApprovePlacement({ ...placed, hrStep: false })).toBe(false);
    expect(hrMayApprovePlacement({ ...placed, status: "approved" })).toBe(false);
  });
});
