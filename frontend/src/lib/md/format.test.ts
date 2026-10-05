import { describe, expect, it } from "vitest";
import {
  changeTone,
  clockText,
  dayLong,
  dayShort,
  greeting,
  inr,
  inrCompact,
  minutesText,
  monthText,
  num,
  pct,
  signed,
  weekdayShort,
} from "./format";

describe("numbers", () => {
  it("groups the Indian way and shows a dash for no data", () => {
    expect(num(1234567.5, 1)).toBe("12,34,567.5");
    expect(num(null)).toBe("—");
    expect(num(Number.NaN)).toBe("—");
    expect(inr(1234568)).toBe("₹12,34,568");
    expect(inr(-5000)).toBe("-₹5,000");
    expect(inr(undefined)).toBe("—");
  });

  it("writes compact rupees as thousands, lakh and crore", () => {
    expect(inrCompact(45200)).toBe("₹45,200");
    expect(inrCompact(1240000)).toBe("₹12.4 L");
    expect(inrCompact(12500000)).toBe("₹1.25 Cr");
    expect(inrCompact(-250000)).toBe("-₹2.5 L");
    expect(inrCompact(null)).toBe("—");
  });

  it("formats percentages, signed changes and minutes", () => {
    expect(pct(91.84)).toBe("91.8%");
    expect(pct(100)).toBe("100%");
    expect(pct(null)).toBe("—");
    expect(signed(3.24)).toBe("+3.2");
    expect(signed(-1.4)).toBe("-1.4");
    expect(signed(0)).toBe("0");
    expect(signed(undefined)).toBe("—");
    expect(minutesText(45)).toBe("45m");
    expect(minutesText(125)).toBe("2h 05m");
    expect(minutesText(null)).toBe("—");
  });
});

describe("changeTone", () => {
  it("says whether a change is good news", () => {
    expect(changeTone(2, true)).toBe("good");
    expect(changeTone(2, false)).toBe("bad");
    expect(changeTone(-2, false)).toBe("good");
    expect(changeTone(0, true)).toBe("neutral");
    expect(changeTone(null, true)).toBe("neutral");
    expect(changeTone(0.5, true, 1)).toBe("neutral"); // inside the threshold
  });
});

describe("dates and times", () => {
  it("writes days, weekdays and months", () => {
    expect(dayShort("2026-10-05")).toBe("05 Oct");
    expect(dayLong("2026-10-05")).toBe("05 Oct 2026");
    expect(dayShort(null)).toBe("—");
    expect(dayLong("")).toBe("—");
    expect(weekdayShort("2026-10-05")).toBe("Mon");
    expect(monthText("2026-09")).toBe("Sep 2026");
    expect(monthText("2026-09", true)).toBe("Sep");
  });

  it("reads the server's wall clock", () => {
    expect(clockText("2026-10-05T10:42:10")).toBe("10:42 am");
    expect(clockText("2026-10-05T00:05:00")).toBe("12:05 am");
    expect(clockText("2026-10-05T15:30:00")).toBe("3:30 pm");
    expect(clockText(null)).toBe("—");
  });

  it("greets by the factory's time, not the browser's", () => {
    expect(greeting("2026-10-05T09:00:00")).toBe("Good morning");
    expect(greeting("2026-10-05T13:00:00")).toBe("Good afternoon");
    expect(greeting("2026-10-05T19:00:00")).toBe("Good evening");
    expect(greeting("2026-10-05Txx:00:00")).toBe("Hello");
    expect(greeting("garbage", new Date(2026, 9, 5, 20, 0))).toBe("Good evening"); // no usable server time: the browser's
    expect(greeting(null, new Date(2026, 9, 5, 8, 0))).toBe("Good morning");
  });
});
