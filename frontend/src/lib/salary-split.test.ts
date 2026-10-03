import { describe, expect, it } from "vitest";
import {
  EMPTY_SPLIT,
  FIRST_PORTION,
  SECOND_PORTION,
  SPLIT_KEYS,
  checkSplit,
  defaultSplit,
  fromPaise,
  halves,
  rupees,
  splitFromBreakup,
  splitPayload,
  toPaise,
  type SplitValues,
} from "./salary-split";

// The same worked examples backend/api/tests_salary_split.py checks against salary_split.py: (salary, first portion
// Basic / DA / Retaining, second portion Other / Petrol / HRA / Special / CA). If either side changes, both fail.
const WORKED_EXAMPLES: [string, string[], string[]][] = [
  ["43000", ["7166.67", "7166.67", "7166.66"], ["4300.00", "4300.00", "4300.00", "4300.00", "4300.00"]],
  ["24000", ["4000.00", "4000.00", "4000.00"], ["2400.00", "2400.00", "2400.00", "2400.00", "2400.00"]],
  ["25000.50", ["4166.75", "4166.75", "4166.75"], ["2500.05", "2500.05", "2500.05", "2500.05", "2500.05"]],
  ["1000.01", ["166.67", "166.67", "166.67"], ["100.00", "100.00", "100.00", "100.00", "100.00"]],
  ["7", ["1.17", "1.17", "1.16"], ["0.70", "0.70", "0.70", "0.70", "0.70"]],
  ["0.01", ["0.01", "0.00", "0.00"], ["0.00", "0.00", "0.00", "0.00", "0.00"]],
];

const split = (first: string[], second: string[]): SplitValues =>
  Object.fromEntries(SPLIT_KEYS.map((k, i) => [k, [...first, ...second][i]])) as SplitValues;

const sum = (values: SplitValues, keys: string[]) =>
  keys.reduce((n, k) => n + (toPaise(values[k as keyof SplitValues]) ?? 0), 0);

describe("the fields", () => {
  it("are the ones asked for, in the two portions", () => {
    expect(FIRST_PORTION.map((f) => f.label)).toEqual(["Basic", "DA", "Retaining Allowance"]);
    expect(SECOND_PORTION.map((f) => f.label)).toEqual([
      "Other Allowance",
      "Petrol Allowance",
      "HRA",
      "Special Allowance",
      "CA",
    ]);
    expect(SPLIT_KEYS).toHaveLength(8);
  });
});

describe("money in whole paise", () => {
  it("reads plain amounts and nothing else", () => {
    expect(toPaise("43000")).toBe(4300000);
    expect(toPaise(" 7166.67 ")).toBe(716667);
    expect(toPaise("0.5")).toBe(50);
    expect(toPaise("4300.")).toBe(430000); // mid-typing
    expect(toPaise(1234.5)).toBe(123450);
    for (const bad of ["", " ", "abc", "-1", "1.234", "1,000", ".5", "1e3", null, undefined, "12 34"]) {
      expect(toPaise(bad as string), String(bad)).toBeNull();
    }
  });

  it("formats back without drift", () => {
    expect(fromPaise(2150000)).toBe("21500.00");
    expect(fromPaise(5)).toBe("0.05");
    expect(fromPaise(716667)).toBe("7166.67");
    expect(rupees(2150000)).toBe("₹21,500.00");
    expect(rupees(12345678)).toBe("₹1,23,456.78");
  });

  it("gives the odd paisa to the first half", () => {
    expect(halves(4300000)).toEqual([2150000, 2150000]);
    expect(halves(100001)).toEqual([50001, 50000]);
    expect(halves(1)).toEqual([1, 0]);
  });
});

describe("defaultSplit", () => {
  it.each(WORKED_EXAMPLES)("splits %s exactly as the server does", (total, first, second) => {
    expect(defaultSplit(total)).toEqual(split(first, second));
    expect(checkSplit(total, defaultSplit(total)!).ok).toBe(true);
  });

  it("always adds up to the salary to the paisa, for odd and even amounts alike", () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    const totals = [
      ...Array.from({ length: 1500 }, (_, i) => i + 1),
      ...Array.from({ length: 1500 }, () => next() % 1_000_000_000 || 1),
    ];
    for (const paise of totals) {
      const values = defaultSplit(fromPaise(paise))!;
      const first = sum(
        values,
        FIRST_PORTION.map((f) => f.key),
      );
      const second = sum(
        values,
        SECOND_PORTION.map((f) => f.key),
      );
      expect(first + second, String(paise)).toBe(paise);
      expect(first, String(paise)).toBe(Math.floor((paise + 1) / 2));
      expect(checkSplit(fromPaise(paise), values).ok, String(paise)).toBe(true);
    }
  });

  it("has nothing to work out for a blank, zero, negative or over-precise amount", () => {
    for (const bad of ["", "0", "0.00", "-5", "abc", "100.123", null, undefined]) {
      expect(defaultSplit(bad as string), String(bad)).toBeNull();
    }
  });
});

describe("checkSplit", () => {
  const good = split(...(WORKED_EXAMPLES[0].slice(1) as [string[], string[]]));

  it("accepts the automatic split and any edit that keeps both portions at 50%", () => {
    expect(checkSplit("43000", good)).toMatchObject({ ok: true, message: null });
    const edited = split(["21500.00", "0.00", "0.00"], ["1000.00", "1000.00", "10000.00", "9000.00", "500.00"]);
    expect(checkSplit("43000", edited).ok).toBe(true);
  });

  it("names the portion that is wrong, with the same wording as the server", () => {
    const moved = { ...good, basic: "8166.67", otherAllowance: "3300.00" };
    const check = checkSplit("43000", moved);
    expect(check.ok).toBe(false);
    expect(check.message).toBe(
      "First portion (Basic + DA + Retaining Allowance) is ₹22,500.00; it must be 50% of the salary (₹21,500.00).",
    );
    expect(check.first).toMatchObject({ sum: 2250000, ok: false, difference: -100000 });
    expect(check.second).toMatchObject({ sum: 2050000, ok: false, difference: 100000 });

    const short = checkSplit("43000", { ...good, ca: "4200.00" });
    expect(short.message).toBe(
      "Second portion (Other + Petrol + HRA + Special Allowance + CA) is ₹21,400.00; it must be 50% of the salary (₹21,500.00).",
    );
    expect(short.second).toMatchObject({ ok: false, difference: 10000 });
  });

  it("lets an odd paisa sit in either portion but not in both or neither", () => {
    const firstHeavy = split(["166.67", "166.67", "166.67"], ["100.00", "100.00", "100.00", "100.00", "100.00"]);
    const secondHeavy = split(["166.67", "166.67", "166.66"], ["100.00", "100.00", "100.00", "100.00", "100.01"]);
    expect(checkSplit("1000.01", firstHeavy).ok).toBe(true);
    expect(checkSplit("1000.01", secondHeavy).ok).toBe(true);
    const both = checkSplit(
      "1000.01",
      split(["166.67", "166.67", "166.67"], ["100.01", "100.00", "100.00", "100.00", "100.00"]),
    );
    expect(both.message).toContain("must equal the salary exactly");
    const neither = checkSplit(
      "1000.01",
      split(["166.66", "166.66", "166.66"], ["100.00", "100.00", "100.00", "100.00", "100.00"]),
    );
    expect(neither.message).toContain("First portion");
  });

  it("flags each box that is blank, not a number, negative or too precise", () => {
    const check = checkSplit("43000", { ...good, basic: "", da: "abc", retainingAllowance: "-5", hra: "1.234" });
    expect(check.ok).toBe(false);
    expect(check.fieldErrors).toEqual({
      basic: "Enter an amount (0 if none)",
      da: "Use a number with at most 2 decimals",
      retainingAllowance: "Cannot be negative",
      hra: "Use a number with at most 2 decimals",
    });
    expect(check.message).toBe("Basic: Enter an amount (0 if none).");
  });

  it("cannot judge a split without a usable salary", () => {
    for (const total of ["", "0", "abc", "12.345", undefined]) {
      const check = checkSplit(total as string, good);
      expect(check.ok, String(total)).toBe(false);
      expect(check.message).toContain("Enter the salary amount");
      expect(check.first).toBeNull();
    }
    expect(checkSplit("43000", EMPTY_SPLIT).ok).toBe(false);
  });
});

describe("conversion to and from the API", () => {
  it("reads a stored split into form text, or nothing when it is incomplete", () => {
    const stored = {
      basic: 7166.67,
      da: 7166.67,
      retainingAllowance: 7166.66,
      otherAllowance: 4300,
      petrolAllowance: 4300,
      hra: 4300,
      specialAllowance: 4300,
      ca: 4300,
    };
    expect(splitFromBreakup(stored)).toEqual(defaultSplit("43000"));
    expect(splitFromBreakup(null)).toBeNull();
    expect(splitFromBreakup(undefined)).toBeNull();
    expect(splitFromBreakup({ basic: 1 })).toBeNull();
  });

  it("sends exact decimal text, tidied", () => {
    const values = { ...defaultSplit("43000")!, basic: "7166.6", da: "7166.67" };
    expect(splitPayload(values).basic).toBe("7166.60");
    expect(splitPayload(values).ca).toBe("4300.00");
    expect(Object.keys(splitPayload(values))).toEqual(SPLIT_KEYS);
  });
});
