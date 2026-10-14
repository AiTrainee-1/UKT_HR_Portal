import { describe, expect, it } from "vitest";
import {
  formatClock,
  formatDuration,
  formatShort,
  formatUntil,
  MAX_UNTIL_MINUTES,
  parseUntil,
  saysNextDay,
} from "./time";

describe("clock text", () => {
  it("writes a minute of the day on a 12-hour clock", () => {
    expect(formatClock(0)).toBe("12:00 AM");
    expect(formatClock(5)).toBe("12:05 AM");
    expect(formatClock(9 * 60)).toBe("9:00 AM");
    expect(formatClock(12 * 60)).toBe("12:00 PM");
    expect(formatClock(21 * 60)).toBe("9:00 PM");
    expect(formatClock(23 * 60 + 59)).toBe("11:59 PM");
    expect(formatClock(1440 + 70)).toBe("1:10 AM");
  });

  it("writes a ladder limit the way HR reads it: midnight ends the day, after midnight says 'next day'", () => {
    expect(formatUntil(1260)).toBe("9:00 PM");
    expect(formatUntil(1440)).toBe("12:00 AM");
    expect(formatUntil(1560)).toBe("2:00 AM next day");
    expect(formatUntil(1635)).toBe("3:15 AM next day");
    expect(formatUntil(MAX_UNTIL_MINUTES)).toBe("11:59 PM next day");
    // outside what can be written: shown as a plain number so it is visibly wrong, never as a wrong clock time
    expect(formatUntil(0)).toBe("0 minutes");
    expect(formatUntil(5000)).toBe("5000 minutes");
  });
});

describe("parseUntil", () => {
  const minutes = (text: string) => parseUntil(text).minutes;

  it("reads the times the owner writes (9:00 PM, 12:00 AM, 2:00 AM next day)", () => {
    expect(minutes("9:00 PM")).toBe(1260);
    expect(minutes("12:00 AM")).toBe(1440);
    expect(minutes("2:00 AM next day")).toBe(1560);
  });

  it("reads other ways of writing the same times", () => {
    for (const text of ["9pm", "9 PM", "9:00pm", "09:00 p.m.", "21:00", "21", "  9:00   pm  "]) {
      expect(minutes(text), text).toBe(1260);
    }
    for (const text of ["12 am", "00:00", "0:00", "24:00", "midnight", "12 midnight", "12:00 AM next day"]) {
      expect(minutes(text), text).toBe(1440);
    }
    for (const text of [
      "2:00 AM next day",
      "02:00 next day",
      "2am tomorrow",
      "2:00 AM +1",
      "2 am (next day)",
      "2:00 am nextday",
    ]) {
      expect(minutes(text), text).toBe(1560);
    }
    expect(minutes("12:00 PM")).toBe(720);
    expect(minutes("12:30 AM")).toBe(30);
    expect(minutes("12:30 AM next day")).toBe(1470);
    expect(minutes("11:59 PM next day")).toBe(MAX_UNTIL_MINUTES);
  });

  it("explains what it cannot read, with an example of what to write", () => {
    for (const text of ["", "   ", "abc", "9:5", "9:00 XM", "9:00 PM later"]) {
      const result = parseUntil(text);
      expect(result.error, text).toContain("9:00 PM");
      expect(result.minutes).toBeUndefined();
    }
    expect(parseUntil("13:61").error).toContain("not a minute");
    expect(parseUntil("13 PM").error).toContain("from 1 to 12");
    expect(parseUntil("0 PM").error).toContain("from 1 to 12");
    expect(parseUntil("25:00").error).toContain("not an hour");
  });

  it("is the exact inverse of formatUntil for every limit that can be written", () => {
    for (let m = 1; m <= MAX_UNTIL_MINUTES; m++) {
      expect(parseUntil(formatUntil(m)).minutes, `${m} -> ${formatUntil(m)}`).toBe(m);
    }
  });

  it("knows when a text already says next day", () => {
    expect(saysNextDay("2:00 AM next day")).toBe(true);
    expect(saysNextDay("2am Tomorrow")).toBe(true);
    expect(saysNextDay("2:00 AM +1")).toBe(true);
    expect(saysNextDay("2:00 AM")).toBe(false);
  });
});

describe("durations", () => {
  it("words a number of minutes", () => {
    expect(formatDuration(60)).toBe("1 hour");
    expect(formatDuration(90)).toBe("1 hour 30 minutes");
    expect(formatDuration(120)).toBe("2 hours");
    expect(formatDuration(150)).toBe("2 hours 30 minutes");
    expect(formatDuration(45)).toBe("45 minutes");
    expect(formatDuration(1)).toBe("1 minute");
    expect(formatDuration(0)).toBe("0 minutes");
    expect(formatShort(150)).toBe("2 h 30 min");
    expect(formatShort(120)).toBe("2 h");
    expect(formatShort(45)).toBe("45 min");
  });
});
