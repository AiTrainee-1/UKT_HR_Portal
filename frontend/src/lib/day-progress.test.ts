import { describe, expect, it } from "vitest";
import {
  countedAfterLabel,
  countedShifts,
  inProgressPunchText,
  isInProgress,
  provisionalTime,
  settledShifts,
} from "./day-progress";

describe("a day still running (In progress)", () => {
  it("only inProgress decides: provisionalUntil alone (its moment passed, the refresh not run yet) is a settled day", () => {
    expect(isInProgress({ inProgress: true, provisionalUntil: "2026-11-26T18:11:00+05:30" })).toBe(true);
    expect(isInProgress({ inProgress: false, provisionalUntil: "2026-11-26T18:11:00+05:30" })).toBe(false);
    expect(isInProgress({})).toBe(false); // an older backend
    expect(isInProgress(null)).toBe(false);
    expect(isInProgress(undefined)).toBe(false);
  });

  it("says when the day is counted, in factory time whatever offset the moment is written in", () => {
    expect(provisionalTime("2026-11-26T18:11:00+05:30")).toBe("18:11");
    expect(provisionalTime("2026-11-26T12:41:00Z")).toBe("18:11");
    expect(provisionalTime("2026-11-26T18:11:00.123456+05:30")).toBe("18:11");
    expect(provisionalTime(null)).toBeNull();
    expect(provisionalTime("not a date")).toBeNull();
    expect(countedAfterLabel("2026-11-26T18:11:00+05:30")).toBe("Counted after the shift ends at 18:11");
    expect(countedAfterLabel(null)).toBe("Counted after the shift ends");
  });

  it("shows the first punch as 'at work', or that the day is not over without one", () => {
    expect(inProgressPunchText("09:06")).toBe("In 09:06 · at work");
    expect(inProgressPunchText("09:06:41")).toBe("In 09:06 · at work");
    expect(inProgressPunchText(null)).toBe("Day not over yet");
    expect(inProgressPunchText("")).toBe("Day not over yet");
  });

  it("has no shift count yet and adds nothing to a total", () => {
    const running = { inProgress: true };
    expect(settledShifts(running, 1)).toBeNull();
    expect(settledShifts({}, 1)).toBe(1);
    expect(settledShifts({ inProgress: false }, "0.50")).toBe("0.50");
    expect(countedShifts(running, 1)).toBe(0);
    expect(countedShifts({}, "0.75")).toBe(0.75);
    expect(countedShifts({}, null)).toBe(0);
    expect(countedShifts({}, "x")).toBe(0);
    const days = [{ shifts: 1 }, { shifts: 0.5 }, { shifts: 1, inProgress: true }];
    expect(days.reduce((n, d) => n + countedShifts(d, d.shifts), 0)).toBe(1.5);
  });
});
