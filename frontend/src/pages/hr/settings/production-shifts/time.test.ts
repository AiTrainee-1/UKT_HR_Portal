import { describe, expect, it } from "vitest";
import {
  absMinutes,
  boxTime,
  clock12,
  nextSunday,
  parsePunches,
  pointText,
  toHHMM,
  toMinutes,
  weekdayOf,
} from "./time";

describe("clock times", () => {
  it("reads HH:MM and HH:MM:SS, and refuses anything else", () => {
    expect(toMinutes("08:30")).toBe(510);
    expect(toMinutes("8:30")).toBe(510);
    expect(toMinutes("16:59:59")).toBe(16 * 60 + 59);
    expect(toMinutes("00:00")).toBe(0);
    expect(toMinutes("24:00")).toBeNull();
    expect(toMinutes("12:60")).toBeNull();
    expect(toMinutes("")).toBeNull();
    expect(toMinutes(null)).toBeNull();
    expect(toMinutes("8pm")).toBeNull();
  });

  it("writes minutes back as HH:MM and wraps a day or more round", () => {
    expect(toHHMM(510)).toBe("08:30");
    expect(toHHMM(1440 + 30)).toBe("00:30");
    expect(toHHMM(-30)).toBe("23:30");
  });

  it("shows a server time as a box holds it, and keeps what it cannot read", () => {
    expect(boxTime("08:30:00")).toBe("08:30");
    expect(boxTime("16:59")).toBe("16:59");
    expect(boxTime("soon")).toBe("soon");
    expect(boxTime(null)).toBe("");
  });

  it("says times the way HR reads them", () => {
    expect(clock12("13:30")).toBe("1:30 PM");
    expect(clock12("00:00")).toBe("12:00 AM");
    expect(pointText("05:30", true)).toBe("5:30 AM next day");
    expect(pointText("20:00", false)).toBe("8:00 PM");
    expect(clock12("nonsense")).toBe("nonsense");
  });

  it("counts a time after midnight a whole day later", () => {
    expect(absMinutes("05:30", true)).toBe(1440 + 330);
    expect(absMinutes("05:30", false)).toBe(330);
    expect(absMinutes("", true)).toBeNull();
  });
});

describe("typed punches", () => {
  const hhmm = (text: string) => {
    const read = parsePunches(text);
    return read.error === null ? read.punches.map((p) => `${p.hhmm}${p.nextDay ? "+1" : ""}`) : read.error;
  };

  it("reads the owner's regular day, with spaces or commas", () => {
    expect(hhmm("08:30 12:45 13:30 20:00")).toEqual(["08:30", "12:45", "13:30", "20:00"]);
    expect(hhmm("08:30, 12:45, 13:30, 20:00")).toEqual(["08:30", "12:45", "13:30", "20:00"]);
    expect(hhmm("8:30\n12:45\n13:30\n20:00")).toEqual(["08:30", "12:45", "13:30", "20:00"]);
  });

  it("reads am and pm, with or without a space and dots", () => {
    expect(hhmm("8:30 am 12:45 pm 1:30pm 8 pm")).toEqual(["08:30", "12:45", "13:30", "20:00"]);
    expect(hhmm("8:30 a.m. 8:00 p.m.")).toEqual(["08:30", "20:00"]);
    expect(hhmm("12:00 am")).toEqual(["00:00"]);
    expect(hhmm("12:15 pm")).toEqual(["12:15"]);
  });

  it("takes a time without am or pm as a 24-hour time, and says it back so a wrong guess shows", () => {
    const read = parsePunches("1:30");
    expect(read.error).toBeNull();
    expect(read.punches[0].text).toBe("1:30 AM");
  });

  it("knows a time earlier than the one before it is the next morning", () => {
    expect(hhmm("08:30 12:45 13:30 20:00 21:00 05:30")).toEqual([
      "08:30",
      "12:45",
      "13:30",
      "20:00",
      "21:00",
      "05:30+1",
    ]);
    expect(hhmm("21:00 05:30")).toEqual(["21:00", "05:30+1"]);
    const read = parsePunches("21:00 05:30");
    expect(read.error === null && read.punches[1].text).toBe("5:30 AM next day");
  });

  it("takes next day and +1 as a confirmation of what the order already says", () => {
    expect(hhmm("20:00 05:30 next day")).toEqual(["20:00", "05:30+1"]);
    expect(hhmm("20:00 5:30 am tomorrow")).toEqual(["20:00", "05:30+1"]);
    expect(hhmm("21:00 05:30+1")).toEqual(["21:00", "05:30+1"]);
  });

  it("refuses next day on a time the server would read as the same day", () => {
    // the server gets plain HH:MM in this order, so it could not know: say what it would do instead of claiming otherwise
    expect(hhmm("00:30+1")).toContain("next day only fits a time that comes after the evening's punches");
    expect(hhmm("08:30 17:00 09:00 next day")).not.toContain("only fits");
  });

  it("reads a time that is not later than the one before it as the next morning, as the server does (equal included)", () => {
    expect(hhmm("08:30 08:30")).toEqual(["08:30", "08:30+1"]);
    expect(hhmm("21:00 21:00")).toEqual(["21:00", "21:00+1"]);
  });

  it("explains what it cannot read", () => {
    expect(hhmm("")).toContain("Enter the punch times");
    expect(hhmm("08:30 soon")).toContain('"soon" is not a time');
    expect(hhmm("25:00")).toContain("25 is not an hour");
    expect(hhmm("8:75")).toContain("is not a minute");
    expect(hhmm("13 pm")).toContain("with am or pm the hour is 1 to 12");
  });

  it("refuses punches that run past two days, and more than twelve", () => {
    expect(hhmm("20:00 10:00 08:00")).toContain("past two days");
    expect(hhmm("08:00 09:00 10:00 11:00 12:00 13:00 14:00 15:00 16:00 17:00 18:00 19:00 20:00")).toContain("twelve");
  });
});

describe("dates", () => {
  it("names the weekday", () => {
    expect(weekdayOf("2026-10-14")).toBe("Wednesday");
    expect(weekdayOf("2026-10-18")).toBe("Sunday");
    expect(weekdayOf("2026-02-30")).toBe("");
    expect(weekdayOf("soon")).toBe("");
  });

  it("finds the coming Sunday (today when it is one)", () => {
    expect(nextSunday("2026-10-14")).toBe("2026-10-18");
    expect(nextSunday("2026-10-18")).toBe("2026-10-18");
    expect(nextSunday("2026-10-19")).toBe("2026-10-25");
    expect(nextSunday("bad")).toBe("bad");
  });
});
