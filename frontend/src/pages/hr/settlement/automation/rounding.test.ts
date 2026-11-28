import { describe, expect, it } from "vitest";
import { hrProposalText, mdDiffers, requestFigures, standingOf, trailOf } from "./focus";
import {
  baseOf,
  nearest500,
  roundedTotalOf,
  roundingChanged,
  roundingNote,
  roundingSteps,
  roundsToZero,
} from "./rounding";
import { batchAt, item, roundingFor } from "./test-fixtures";

// The Salary Advance rounding (owner 2026-11-27): capped at the eligible limit, rounded to the nearest ₹500 (₹250 and up
// rounds up), never above the limit. The server works it out (service.rounded_for); the screens say it.

const earnings = batchAt("hr_review").items[0].advance.earnings!;
const asked = (id: number, amount: number, limit: number | null, over: Parameters<typeof item>[1] = {}) =>
  item(id, {
    rounding: true,
    ...over,
    advance: { amount, requestedAmount: amount, earnings: limit == null ? null : { ...earnings, limit } },
  });

describe("the rounding rule", () => {
  it("rounds to the nearest ₹500: ₹0-249 -> ₹0, ₹250-749 -> ₹500, ₹750-1,249 -> ₹1,000", () => {
    expect([0, 249, 250, 749, 750, 1249, 1250, 1749].map(nearest500)).toEqual([0, 0, 500, 500, 1000, 1000, 1500, 1500]);
    expect(nearest500(4800)).toBe(5000);
  });

  it("the fixtures work it out as the server does (capped first, never above the limit)", () => {
    expect(roundingFor(4800, 8000)).toMatchObject({ rounded: 5000, direction: "up", capped: false, zero: false });
    expect(roundingFor(15000, 11560)).toMatchObject({ rounded: 11500, direction: "down", capped: true });
    // the round-up past the limit goes to the ₹500 below
    expect(roundingFor(20000, 11760)).toMatchObject({ rounded: 11500, capped: true });
    expect(roundingFor(7900, 7950)).toMatchObject({ rounded: 7500, capped: false });
    expect(roundingFor(200, 8000)).toMatchObject({ rounded: 0, zero: true });
    expect(roundingFor(8000, 8000)).toMatchObject({ rounded: 8000, direction: "same" });
  });
});

describe("the rounding in words", () => {
  it("one short line when it matters: rounds to ₹0, capped at the limit, rounded up", () => {
    expect(roundingNote(roundingFor(200, 8000))).toEqual({ text: "rounds to ₹0 — reject", tone: "red" });
    expect(roundingNote(roundingFor(15000, 11560))).toEqual({ text: "capped at limit", tone: "muted" });
    expect(roundingNote(roundingFor(4800, 8000))).toEqual({ text: "rounded up", tone: "muted" });
    expect(roundingNote(roundingFor(8200, 9000))).toBeNull(); // rounded down a little
    expect(roundingNote(roundingFor(8000, 8000))).toBeNull();
    expect(roundingNote(null)).toBeNull();
  });

  it("how it was worked out, step by step (the hover text)", () => {
    expect(roundingSteps(roundingFor(15000, 11560))).toBe(
      "₹15,000 asked → brought down to the ₹11,560 limit → rounded to the nearest ₹500 = ₹11,500",
    );
    expect(roundingSteps(roundingFor(4800, 8000))).toBe(
      "₹4,800 asked → rounded to the nearest ₹500 = ₹5,000 (within the ₹8,000 limit)",
    );
    expect(roundingSteps(roundingFor(20000, 11760))).toBe(
      "₹20,000 asked → brought down to the ₹11,760 limit → rounded to ₹11,500 (the nearest ₹500, ₹12,000, is above the ₹11,760 limit)",
    );
    expect(roundingSteps(roundingFor(200, 8000))).toBe(
      "₹200 asked → rounded to the nearest ₹500 = ₹0 (less than ₹250): reject it",
    );
    expect(roundingSteps(roundingFor(4800, null))).toBe(
      "₹4,800 asked → rounded to the nearest ₹500 = ₹5,000 (no eligible limit known)",
    );
    // a limit under ₹500 forces ₹0 although ₹250 or more is left: the limit is the reason, not "less than ₹250"
    expect(roundingSteps(roundingFor(5000, 450))).toBe(
      "₹5,000 asked → brought down to the ₹450 limit → rounded to ₹0 (the nearest ₹500, ₹500, is above the ₹450 limit): reject it",
    );
  });

  it("changed / zero / the base amount, with an older server's fallbacks", () => {
    expect(roundingChanged(roundingFor(15000, 11560))).toBe(true);
    expect(roundingChanged(roundingFor(8000, 8000))).toBe(false);
    expect(roundingChanged(null)).toBe(false);
    expect(roundsToZero(asked(6, 200, 8000))).toBe(true);
    expect(roundsToZero(asked(5, 4800, 8000))).toBe(false);
    expect(baseOf({ requestedAmount: 15000, baseAmount: 11500 })).toBe(11500);
    expect(baseOf({ requestedAmount: 15000, rounding: { rounded: 11500 } })).toBe(11500);
    expect(baseOf({ requestedAmount: 15000 })).toBe(15000);
  });

  it("the rounded total: a Salary Advance batch with the rounding; a summary shows it when it differs", () => {
    const b = batchAt("hr_review");
    expect(roundedTotalOf(b)).toBe(43000);
    expect(roundedTotalOf({ ...b, advanceType: "term" })).toBeNull();
    expect(roundedTotalOf({ ...b, items: b.items.map((i) => ({ ...i, rounding: null })) })).toBeNull();
    expect(roundedTotalOf({ ...b, amounts: { ...b.amounts, rounded: undefined } })).toBeNull();
    // the Overview's summary has no requests
    expect(roundedTotalOf({ advanceType: "general", amounts: { requested: 43000, rounded: 43000 } })).toBeNull();
    expect(roundedTotalOf({ advanceType: "general", amounts: { requested: 43000, rounded: 41500 } })).toBe(41500);
  });
});

describe("the rounded amount is the workflow's 'as asked' (2026-11-27)", () => {
  const capped = asked(4, 15000, 11560, { hr: { action: "approve" } });

  it("Keep as asked keeps the rounded amount, and says so", () => {
    expect(standingOf(capped, "hr_review")).toMatchObject({ decision: null, amount: 11500, source: "asked" });
    expect(standingOf(capped, "md_changes")).toMatchObject({ decision: "approved", amount: 11500 });
    expect(hrProposalText(capped, "hr_review")).toBe("Kept · rounded ₹11,500");
    expect(trailOf(capped, { stage: "hr_review", finalizedVia: null })[0].text).toBe("Kept · rounded");
    // nothing to say when the rounding changed nothing; a request HR has not looked at yet is not reviewed
    expect(hrProposalText(batchAt("hr_review").items[0], "md_review")).toBe("Keep as asked");
    expect(hrProposalText(asked(4, 15000, 11560), "hr_review")).toBe("Not reviewed yet");
  });

  it("the MD's full approval is the rounded amount: no change from HR's proposal", () => {
    const md = (amount: number) => ({
      ...capped,
      mdChanged: undefined,
      md: { ...capped.md, decision: "approved" as const, amount, decidedAt: "x" },
    });
    expect(mdDiffers(md(11500))).toBe(false);
    expect(mdDiffers(md(11000))).toBe(true);
  });

  it("the row's figures carry the rounding of a Salary Advance only", () => {
    expect(requestFigures(capped).rounding).toMatchObject({ rounded: 11500, capped: true });
    expect(requestFigures(batchAt("hr_review").items[1]).rounding).toBeNull(); // the Term Loan
  });
});
