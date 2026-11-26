import { describe, expect, it } from "vitest";
import { compBlock, octoberDays } from "../fixtures";
import {
  canPick,
  dayProblem,
  daysWord,
  defaultPortion,
  leftToPlace,
  monthWeeks,
  placedMark,
  placementStatusText,
  placementSummary,
  placementTone,
  placementWhenText,
  portionProblem,
  portionsFor,
  requestsLink,
  showsPlacement,
  waitsForHr,
} from "./birthday-comp-logic";

// Birthday Compensation on a chosen date (owner 2026-11-25): what is left of the 1.00 day, which parts a day takes within
// it, why a day or a part cannot be chosen, the month Monday first, and a row's placement in words.

const halfDay = { portions: ["second_half", "full"] as const, suggested: "second_half" as const, reason: null };

describe("what is left to place", () => {
  it("is the 1.00 day less what waits and what was approved, never below nothing", () => {
    expect(leftToPlace({ total: 1, held: 0, used: 0 })).toBe(1);
    expect(leftToPlace({ total: 1, held: 0.5, used: 0 })).toBe(0.5);
    expect(leftToPlace({ total: 1, held: 0.5, used: 0.5 })).toBe(0);
    expect(leftToPlace({ total: 0, held: 0.5, used: 0 })).toBe(0);
    expect(leftToPlace(null)).toBe(0);
    expect(daysWord(1)).toBe("1.00 day");
    expect(daysWord(0.5)).toBe("0.50 day");
  });

  it("keeps a day's parts inside it: with half a day left, only halves", () => {
    const any = { portions: ["full", "first_half", "second_half"] as const, suggested: "full" as const, reason: null };
    expect(portionsFor({ portions: [...any.portions] }, 1)).toEqual(["full", "first_half", "second_half"]);
    expect(portionsFor({ portions: [...any.portions] }, 0.5)).toEqual(["first_half", "second_half"]);
    expect(defaultPortion({ ...any, portions: [...any.portions] }, 1)).toBe("full");
    expect(defaultPortion({ ...any, portions: [...any.portions] }, 0.5)).toBe("first_half");
    expect(defaultPortion({ ...halfDay, portions: [...halfDay.portions] }, 1)).toBe("second_half");
    expect(canPick({ portions: ["full"] }, 0.5)).toBe(false);
    expect(canPick({ portions: [] }, 1)).toBe(false);
  });

  it("says why a part or a day cannot be chosen", () => {
    const day = { ...halfDay, portions: [...halfDay.portions] };
    expect(portionProblem(day, "first_half", 1)).toBe("Only full day or second half can be placed on this day.");
    expect(portionProblem(day, "second_half", 1)).toBeNull();
    expect(portionProblem(day, "full", 0.5)).toBe("Only 0.50 day is left to place: choose a first or second half.");
    expect(
      dayProblem({ portions: [], reason: "A Sunday is already a day off: choose a working day.", label: "Sunday" }, 1),
    ).toBe("A Sunday is already a day off: choose a working day.");
    expect(dayProblem({ portions: ["full"], reason: null, label: "Still to come" }, 0.5)).toBe(
      "Only 0.50 day is left to place, and this day takes a full day only.",
    );
    expect(dayProblem({ portions: ["full"], reason: null, label: "Still to come" }, 1)).toBeNull();
  });
});

describe("the month", () => {
  it("is laid out Monday first, in whole weeks", () => {
    const weeks = monthWeeks(octoberDays());
    expect(weeks).toHaveLength(5);
    // 1 Oct 2026 is a Thursday: Monday to Wednesday are blank
    expect(weeks[0].slice(0, 3)).toEqual([null, null, null]);
    expect(weeks[0][3]?.date).toBe("2026-10-01");
    expect(weeks[0][6]?.date).toBe("2026-10-04"); // the first Sunday
    expect(weeks[4][5]?.date).toBe("2026-10-31");
    expect(weeks[4][6]).toBeNull();
    expect(monthWeeks([])).toEqual([]);
  });

  it("marks a day that already holds a placement (a withdrawn or rejected one does not count)", () => {
    expect(placedMark({ placed: [] })).toBeNull();
    expect(placedMark({ placed: [{ id: 1, portion: "full", status: "pending" }] })).toBe("BC");
    expect(placedMark({ placed: [{ id: 1, portion: "first_half", status: "approved" }] })).toBe("½ BC");
    expect(placedMark({ placed: [{ id: 1, portion: "second_half", status: "pending" }] })).toBe("BC ½");
    expect(placedMark({ placed: [{ id: 1, portion: "second_half", status: "rejected" }] })).toBeNull();
  });
});

describe("a row's placement", () => {
  it("says how much of the 1.00 day is placed, and what is left or what lapsed", () => {
    expect(showsPlacement(compBlock())).toBe(true);
    expect(showsPlacement(compBlock({ state: "credit_claim" }))).toBe(false);
    expect(showsPlacement(null)).toBe(false);
    expect(placementSummary(compBlock())).toBe("0.00 of 1.00 day placed · 1.00 day to place by 31 Oct");
    expect(placementSummary(compBlock({ held: 0.5, available: 0.5 }))).toBe(
      "0.50 of 1.00 day placed · 0.50 day to place by 31 Oct",
    );
    expect(placementSummary(compBlock({ state: "placed", held: 0.5, used: 0.5, available: 0 }))).toBe(
      "1.00 of 1.00 day placed",
    );
    expect(placementSummary(compBlock({ state: "lapsed", used: 0.5, available: 0, lapsed: 0.5 }))).toBe(
      "0.50 of 1.00 day placed · 0.50 day lapsed on 31 Oct",
    );
  });

  it("puts each use in words, with its tone, and knows when it waits for HR", () => {
    const use = {
      id: 42,
      useDate: "2026-10-20",
      portion: "second_half" as const,
      portionLabel: "Second half",
      days: 0.5,
      status: "pending" as const,
      statusKey: "pending_hr" as const,
      statusLabel: "",
    };
    expect(placementWhenText(use)).toBe("20 Oct · second half");
    expect(placementStatusText(use)).toBe("Approved by the Department Head, waiting for HR");
    expect(placementTone(use)).toBe("amber");
    expect(placementTone({ status: "approved", statusKey: "approved" })).toBe("teal");
    expect(placementTone({ status: "rejected", statusKey: "rejected" })).toBe("rose");
    expect(waitsForHr({ ...use, approval: null })).toBe(true);
    expect(waitsForHr({ ...use, statusKey: "pending", approval: null })).toBe(false);
    expect(requestsLink(42)).toBe("/hr/requests?kind=birthday_compensation&focus=42");
  });
});
