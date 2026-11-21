import { describe, expect, it } from "vitest";
import { channelText, nothingScheduled, scheduledFigures, tileMark } from "./scheduled-logic";
import { emptyScheduled, scheduled } from "./scheduled-fixtures";

describe("scheduled attendance reports", () => {
  it("makes the four figures from the hand-counted runs", () => {
    const f = Object.fromEntries(scheduledFigures(scheduled).map((x) => [x.id, x]));
    expect(f.runs.value).toBe("8");
    expect(f.runs.sub).toBe("6 on schedule · 1 by hand · 1 retried");
    expect(f.delivered.value).toBe("13");
    expect(f.delivered.sub).toBe("2 different recipients");
    expect(f.everyone.value).toBe("75%");
    expect(f.everyone.tone).toBeUndefined();
    expect(f.failed.value).toBe("2");
    expect(f.failed.sub).toBe("1 failed · 1 partly sent");
    expect(f.failed.tone).toBe("bad");
  });

  it("says each channel in words", () => {
    expect(channelText(scheduled.byChannel[1])).toBe("7 sent, 4 queued, 3 failed");
    expect(channelText(scheduled.byChannel[0])).toBe("2 sent");
  });

  it("knows when nothing is scheduled", () => {
    expect(nothingScheduled(scheduled)).toBe(false);
    expect(nothingScheduled(emptyScheduled)).toBe(true);
  });

  it("maps the headline tiles to the absences they open", () => {
    expect(tileMark("absences")).toBe("all");
    expect(tileMark("followed")).toBe("informed");
    expect(tileMark("notInformed")).toBe("not_informed");
    expect(tileMark("unmarked")).toBe("unmarked");
    expect(tileMark("exports")).toBeNull();
  });
});
