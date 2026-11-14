import { describe, expect, it } from "vitest";
import {
  EXCEPTION_CAP,
  LATEST,
  bandRows,
  bandTick,
  bandTickLines,
  bridgeQuestion,
  buildWaterfall,
  deltaView,
  describeStatus,
  groupRows,
  hasTds,
  monthOptions,
  nextLimit,
  previousMonth,
  reconciles,
  signedInr,
  signedInrCompact,
  statusDates,
  statusFacts,
  stepIsDrawn,
  stripLines,
  tdsSub,
  tickMonth,
  trendChartRows,
  waterfallDomain,
  whenText,
} from "./logic";
import { finalizedStatus, openStatus, paidStatus } from "./fixtures";
import { cardNotes, emptyReason } from "./parts";
import type { BridgeStep, MonthStatus, NetBand, PayrollDepartments, PayrollStatus, TrendRow } from "./types";

const status = (over: Partial<MonthStatus>): MonthStatus => ({
  month: "2026-09",
  label: "Sep 2026",
  state: "paid",
  stateLabel: "Paid",
  monthEnded: true,
  slips: 8,
  headcount: 7,
  paidSlips: 8,
  unpaidSlips: 0,
  unpaidNet: 0,
  provisionalSlips: 0,
  final: true,
  productionPeriods: 2,
  generatedAt: null,
  paidAt: null,
  ...over,
});

// the backend's hand-computed September 2026 scenario (tests_md_payroll.py)
const step = (id: BridgeStep["id"], amount: number, people: number): BridgeStep => ({
  id,
  label: id,
  amount,
  people,
  detail: `${id} detail`,
});
const SCENARIO: BridgeStep[] = [
  step("joined", 15000, 1),
  step("left", -40000, 1),
  step("rate", 2480, 2),
  step("overtime", 1000, 1),
  step("attendance", -1392.31, 3),
  step("oneoffs", 0, 0),
  step("other", -1000, 1),
];
const START = { label: "Aug 2026 gross pay", amount: 134500 };
const END = { label: "Sep 2026 gross pay", amount: 110587.69 };

describe("money with a sign", () => {
  it("shows exact rupees with the change's sign", () => {
    expect(signedInr(15000)).toBe("+₹15,000.00");
    expect(signedInr(-1392.31)).toBe("-₹1,392.31");
    expect(signedInr(0)).toBe("₹0.00");
    expect(signedInr(null)).toBe("—");
    expect(signedInr(-0.001)).toBe("₹0.00"); // rounds to nothing: no minus sign on a zero
  });

  it("shortens big amounts the way the cards do", () => {
    expect(signedInrCompact(123456)).toBe("+₹1.2 L");
    expect(signedInrCompact(-45000)).toBe("-₹45,000");
    expect(signedInrCompact(undefined)).toBe("—");
  });
});

describe("the change chip", () => {
  it("colours cost going down as good news", () => {
    expect(deltaView({ abs: -23912.31, pct: -17.8 }, "money", "down")).toEqual({
      text: "-17.8%",
      tone: "good",
      direction: "down",
    });
    expect(deltaView({ abs: 500, pct: 2.2 }, "money", "down")?.tone).toBe("bad");
  });

  it("falls back to rupees when there is nothing to divide by", () => {
    expect(deltaView({ abs: 12000, pct: null }, "money", "down")?.text).toBe("+₹12,000");
  });

  it("keeps headcount neutral and says percentage points for a share", () => {
    expect(deltaView({ abs: 3, pct: 4.1 }, "count", "neutral")?.tone).toBe("neutral");
    expect(deltaView({ abs: 2, pct: null }, "count", "neutral")?.text).toBe("+2");
    expect(deltaView({ abs: 0.9, pct: null }, "points", "down")).toEqual({
      text: "+0.9 pts",
      tone: "bad",
      direction: "up",
    });
  });

  it("is absent without a comparison, flat for no change", () => {
    expect(deltaView(null, "money")).toBeNull();
    expect(deltaView(undefined, "money")).toBeNull();
    expect(deltaView({ abs: 0, pct: 0 }, "money")).toEqual({ text: "0%", tone: "neutral", direction: "flat" });
  });
});

describe("the status of a month, in plain words", () => {
  it("paid and final", () => {
    expect(describeStatus(status({}))).toEqual({
      headline: "Paid",
      detail: "All 8 slips are marked paid.",
      tone: "good",
    });
  });

  it("paid but with provisional slips is not good news", () => {
    const s = describeStatus(status({ provisionalSlips: 2 }));
    expect(s.tone).toBe("warn");
    expect(s.detail).toContain("2 staff slip(s) were generated before the month ended");
  });

  it("part paid says how many and how much", () => {
    const s = describeStatus(status({ state: "part_paid", paidSlips: 2, unpaidSlips: 6, unpaidNet: 63145 }));
    expect(s).toEqual({
      headline: "Part paid",
      detail: "6 of 8 slips are not marked paid (₹63,145 net pay).",
      tone: "warn",
    });
  });

  it("a running month is provisional, a missing month is bad, no payroll is neutral", () => {
    expect(describeStatus(status({ state: "in_progress" })).headline).toBe("Month in progress");
    expect(describeStatus(status({ state: "not_generated", slips: 0 })).tone).toBe("bad");
    expect(describeStatus(status({ state: "no_data", slips: 0 })).tone).toBe("info");
  });

  it("a staff month HR has not finalized is still open, and Cleared is verified, not paid", () => {
    expect(describeStatus(openStatus)).toEqual({
      headline: "Generated, still open",
      detail:
        "HR can still change it: Payroll Done has not been pressed. 2 of 8 verified (Cleared); nothing is paid yet (₹1,08,393 net pay).",
      tone: "warn",
    });
  });

  it("Payroll Done says since when the payment is pending, and what is held", () => {
    expect(describeStatus(finalizedStatus)).toEqual({
      headline: "Payroll Done · payment pending",
      detail:
        "Locked on 07 Oct 2026: HR can no longer change it. Payment pending for 5 days (₹1,08,393 net pay not marked as paid yet). 1 salary on hold (₹17,865) is not paid yet.",
      tone: "warn",
    });
    expect(describeStatus({ ...finalizedStatus, paymentPendingDays: 1, onHold: 0 }).detail).toContain(
      "pending for 1 day (",
    );
  });

  it("paid by Mark as Paid gives the day and how long it took", () => {
    expect(describeStatus(paidStatus)).toEqual({
      headline: "Paid",
      detail: "HR marked it as paid on 09 Oct 2026, 2 days after Payroll Done.",
      tone: "good",
    });
    expect(describeStatus({ ...paidStatus, onHold: 2, onHoldNet: 30000 }).detail).toBe(
      "HR marked it as paid on 09 Oct 2026, 2 days after Payroll Done. 2 salaries on hold (₹30,000) are not paid yet.",
    );
  });

  it("an answer from before the workflow keeps its old wording", () => {
    expect(describeStatus(status({ state: "generated", paidSlips: 0, unpaidSlips: 8, unpaidNet: 100 })).headline).toBe(
      "Generated, not marked paid",
    );
    expect(statusFacts(status({}))).toEqual([]);
  });

  it("lists only the counts that are not nil", () => {
    expect(statusFacts(openStatus).map((f) => f.text)).toEqual(["2 of 8 verified"]);
    expect(statusFacts(finalizedStatus).map((f) => f.text)).toEqual([
      "2 of 8 verified",
      "1 on hold · ₹17,865",
      "1 new joiner waiting",
    ]);
    expect(statusFacts(paidStatus).map((f) => f.id)).toEqual(["cleared", "separately"]);
    expect(statusFacts({ ...openStatus, newJoinersWaiting: 3 }).find((f) => f.id === "joiners")?.text).toBe(
      "3 new joiners waiting",
    );
    // a production-only month has no staff workflow: no "verified" count
    expect(statusFacts({ ...openStatus, staffSlips: 0 }).map((f) => f.id)).toEqual([]);
  });

  it("dates: generated, Payroll Done and Mark as Paid; a production month's last clearing", () => {
    expect(statusDates(paidStatus).map((d) => [d.label, d.value])).toEqual([
      ["Generated", "01 Oct 2026, 9:00 am"],
      ["Payroll Done", "07 Oct 2026, 3:00 pm"],
      ["Marked paid", "09 Oct 2026, 11:00 am"],
    ]);
    expect(statusDates({ ...openStatus, staffSlips: 0, paidAt: "2026-10-08T12:00:00" }).map((d) => d.label)).toEqual([
      "Generated",
      "Last cleared",
    ]);
  });

  it("the strip says how long a payment has been pending, and keeps to three short lines", () => {
    expect(stripLines(finalizedStatus).map((l) => l.text)).toEqual([
      "Pending 5 days",
      "₹1.1 L unpaid",
      "1 provisional",
    ]);
    expect(stripLines(paidStatus)).toEqual([]);
    expect(stripLines({ ...openStatus, provisionalSlips: 0, onHold: 2 }).map((l) => l.text)).toEqual([
      "₹1.1 L unpaid",
      "2 on hold",
    ]);
  });

  it("formats when it was generated", () => {
    expect(whenText("2026-10-01T09:00:00")).toBe("01 Oct 2026, 9:00 am");
    expect(whenText(null)).toBe("—");
  });
});

describe("the month picker", () => {
  const picker = {
    available: ["2026-09", "2026-08"],
    months: [status({ month: "2026-09", state: "part_paid" }), status({ month: "2026-08", state: "paid" })],
  } as unknown as PayrollStatus;

  it("lists the months that have payroll, newest first, with their state", () => {
    expect(monthOptions(picker, "")).toEqual([
      { value: "2026-09", label: "Sep 2026", state: "part_paid" },
      { value: "2026-08", label: "Aug 2026", state: "paid" },
    ]);
  });

  it("keeps a chosen month that has no payroll visible", () => {
    expect(monthOptions(picker, "2026-06")[0]).toEqual({ value: "2026-06", label: "Jun 2026", state: undefined });
  });

  it("copes with the status not having loaded", () => {
    expect(monthOptions(undefined, "")).toEqual([]);
    expect(LATEST).not.toBe("");
  });
});

describe("the month before", () => {
  it("steps back one calendar month, across a new year", () => {
    expect(previousMonth("2026-09")).toBe("2026-08");
    expect(previousMonth("2026-01")).toBe("2025-12");
  });
});

describe("the trend axis", () => {
  it("labels a month with its year, short", () => {
    expect(tickMonth("2026-09")).toBe("Sep 26");
    expect(tickMonth("2027-01")).toBe("Jan 27");
  });
});

describe("the trend chart rows", () => {
  const row = (over: Partial<TrendRow>): TrendRow => ({
    month: "2026-09",
    label: "Sep 2026",
    hasData: true,
    state: "paid",
    provisionalSlips: 0,
    grossPay: 100,
    netPay: 90,
    headcount: 7,
    costPerHead: 14,
    overtimePay: 0,
    overtimeSharePct: 0,
    ...over,
  });

  it("draws settled months and provisional months as different series", () => {
    const rows = trendChartRows([
      row({ month: "2026-07", hasData: false, grossPay: null, headcount: null }),
      row({ month: "2026-08" }),
      row({ month: "2026-09", state: "part_paid", provisionalSlips: 1, grossPay: 80 }),
      row({ month: "2026-10", state: "in_progress", grossPay: 60 }),
    ]);
    expect(rows.map((r) => [r.gross, r.grossProvisional])).toEqual([
      [null, null], // no payroll: a gap
      [100, null],
      [null, 80],
      [null, 60],
    ]);
    expect(rows[0].headcount).toBeNull();
  });
});

describe("the bridge as a waterfall", () => {
  const bars = buildWaterfall(START, SCENARIO, END);

  it("draws the start, every step that did something, and the end", () => {
    expect(bars.map((b) => b.key)).toEqual([
      "start",
      "joined",
      "left",
      "rate",
      "overtime",
      "attendance",
      "other",
      "end",
    ]);
    expect(stepIsDrawn(step("oneoffs", 0, 0))).toBe(false);
    expect(stepIsDrawn(step("oneoffs", 0, 2))).toBe(true); // changes that cancel out are still something
  });

  it("floats each step from the running total before it to the one after it", () => {
    const joined = bars[1];
    expect([joined.kind, joined.from, joined.to, joined.base, joined.value]).toEqual([
      "up",
      134500,
      149500,
      134500,
      15000,
    ]);
    const left = bars[2];
    expect([left.kind, left.from, left.to, left.base, left.value]).toEqual(["down", 149500, 109500, 109500, 40000]);
    expect(bars[0].kind).toBe("total");
    expect(bars[bars.length - 1].amount).toBe(110587.69);
  });

  it("lands on the end total exactly when the steps add up", () => {
    expect(reconciles(bars)).toBe(true);
    const sum = SCENARIO.reduce((s, x) => s + Math.round(x.amount * 100), 0);
    expect(sum).toBe(Math.round((END.amount - START.amount) * 100)); // the same identity the server proves
    expect(bars[bars.length - 2].to).toBe(110587.69);
  });

  it("notices steps that do not add up", () => {
    const wrong = buildWaterfall(START, SCENARIO.slice(0, 3), END);
    expect(reconciles(wrong)).toBe(false);
  });

  it("keeps the exact amounts and the people behind each step", () => {
    expect(bars[5].amount).toBe(-1392.31);
    expect(bars[5].people).toBe(3);
    expect(bars[5].detail).toBe("attendance detail");
    expect(bars[5].shortLabel).toBe("Attendance");
  });

  it("works with no steps at all (nothing changed)", () => {
    const flat = buildWaterfall(START, [step("joined", 0, 0)], { label: "Sep 2026 gross pay", amount: 134500 });
    expect(flat.map((b) => b.key)).toEqual(["start", "end"]);
    expect(reconciles(flat)).toBe(true);
  });

  it("uses an axis that does not start at zero when the steps are small beside the totals, and says so", () => {
    const domain = waterfallDomain(bars);
    expect(domain.truncated).toBe(true);
    expect(domain.min).toBeGreaterThan(0);
    expect(domain.min).toBeLessThan(109500); // the lowest running total
    expect(domain.max).toBeGreaterThan(149500);
  });

  it("starts at zero when the steps are as big as the totals", () => {
    const big = buildWaterfall({ label: "A gross pay", amount: 100 }, [step("joined", 400, 2)], {
      label: "B gross pay",
      amount: 500,
    });
    const domain = waterfallDomain(big);
    expect(domain.min).toBe(0);
    expect(domain.truncated).toBe(false);
  });

  it("copes with a flat bridge", () => {
    const domain = waterfallDomain(buildWaterfall(START, [], { label: "B", amount: 134500 }));
    expect(domain.max).toBeGreaterThan(domain.min);
  });
});

describe("the department, unit and type rows", () => {
  const line = {
    headcount: 3,
    grossPay: 59787.69,
    netPay: 1,
    overtimePay: 1000,
    overtimeSharePct: 1.7,
    costPerHead: 19929.23,
    lopDays: 2,
    employerCost: 1,
    sharePct: 54,
    previous: null,
    change: null,
  };
  const data = {
    departments: [
      { ...line, id: 10, name: "Stitching", unit: "Unit 1" },
      { ...line, id: null, name: "Unassigned", unit: null },
    ],
    units: [{ ...line, id: 1, name: "Unit 1" }],
    types: [{ ...line, id: "staff" as const, name: "Staff" }],
  } as unknown as PayrollDepartments;

  it("gives every row a stable key and the unit only where there is one", () => {
    expect(groupRows(data, "department").map((r) => [r.key, r.name, r.unit])).toEqual([
      ["dept-10", "Stitching", "Unit 1"],
      ["dept-none", "Unassigned", null],
    ]);
    expect(groupRows(data, "unit")[0].key).toBe("unit-1");
    expect(groupRows(data, "type")[0].key).toBe("type-staff");
  });

  it("is empty until the data arrives", () => {
    expect(groupRows(undefined, "department")).toEqual([]);
  });
});

describe("the distribution histogram", () => {
  const bands: NetBand[] = [
    { id: "b1", label: "Under ₹10k", from: 0, to: 10000, count: 2, staff: 1, production: 1 },
    { id: "b2", label: "₹10k–15k", from: 10000, to: 15000, count: 1, staff: 0, production: 1 },
  ];
  it("picks the people counted for staff, production or everyone", () => {
    expect(bandRows(bands, "all")).toEqual([
      { label: "Under ₹10k", tick: "<10k", count: 2 },
      { label: "₹10k–15k", tick: "10k–15k", count: 1 },
    ]);
    expect(bandRows(bands, "staff").map((r) => r.count)).toEqual([1, 0]);
    expect(bandRows(bands, "production").map((r) => r.count)).toEqual([1, 1]);
  });
});

describe("short labels for the histogram columns", () => {
  it("drops the rupee sign and shortens the open ends", () => {
    expect(bandTick("Under ₹10k")).toBe("<10k");
    expect(bandTick("₹75k–1 L")).toBe("75k–1 L");
    expect(bandTick("₹1 L+")).toBe("1 L+");
    expect(bandTick("Nil or negative")).toBe("Nil");
  });
});

describe("the histogram's band names on a phone", () => {
  it("writes a range on two lines the way it is written by hand, and a one-word band on one", () => {
    expect(bandTickLines("10k–15k")).toEqual(["10–", "15k"]);
    expect(bandTickLines("75k–1 L")).toEqual(["75k–", "1 L"]);
    expect(bandTickLines("<10k")).toEqual(["<10k"]);
    expect(bandTickLines("Nil")).toEqual(["Nil"]);
    expect(bandTickLines("1 L+")).toEqual(["1 L+"]);
  });
});

describe("Show more on the exceptions list", () => {
  it("asks for ten more, never more than exist or than the server allows", () => {
    expect(nextLimit(10, 34)).toBe(20);
    expect(nextLimit(30, 34)).toBe(34);
    expect(nextLimit(10, 4)).toBe(10); // nothing more to show: the limit does not move
    expect(nextLimit(95, 500)).toBe(EXCEPTION_CAP);
  });
});

describe("questions for the assistant", () => {
  it("names the direction of the change", () => {
    expect(bridgeQuestion("Sep 2026", "Aug 2026", { abs: 5, pct: 1 })).toBe(
      "Why did payroll rise in Sep 2026 compared with Aug 2026?",
    );
    expect(bridgeQuestion("Sep 2026", "Aug 2026", { abs: -5, pct: -1 })).toBe(
      "Why did payroll fall in Sep 2026 compared with Aug 2026?",
    );
    expect(bridgeQuestion("Sep 2026", "Aug 2026", null)).toBe(
      "What changed in payroll in Sep 2026 compared with Aug 2026?",
    );
  });
});

describe("TDS", () => {
  it("is shown only when employees on the TDS list had some", () => {
    expect(hasTds(2500)).toBe(true);
    expect(hasTds(0.01)).toBe(true);
    expect(hasTds(0)).toBe(false); // a company with nobody on the TDS list: no "TDS ₹0"
    expect(hasTds(null)).toBe(false);
    expect(hasTds(undefined)).toBe(false); // an answer from before the TDS fields existed
  });

  it("says how many employees it was taken from, and that it is not a PF / ESI due", () => {
    expect(tdsSub(1)).toBe(
      "From 1 employee on the TDS list · paid to the income-tax department, not part of the PF and ESI dues",
    );
    expect(tdsSub(3)).toContain("From 3 employees on the TDS list");
    expect(tdsSub(undefined)).toContain("From employees on the TDS list");
    expect(tdsSub(0)).toContain("From employees on the TDS list");
  });

  it("changes like any other figure, with no percentage when last month had none", () => {
    expect(deltaView({ abs: 5800, pct: null }, "money", "neutral")).toEqual({
      text: "+₹5,800",
      tone: "neutral",
      direction: "up",
    });
  });
});

describe("the server's notes inside a card", () => {
  const notes = [
    "Matched department 'Stiching' to 'Stitching'.",
    "No salary slips exist for Oct 2026 in this selection.",
  ];
  it("leaves out the notes about the filters, which the page shows once at the top", () => {
    expect(cardNotes(notes)).toEqual(["No salary slips exist for Oct 2026 in this selection."]);
    expect(cardNotes(undefined)).toEqual([]);
  });
  it("explains an empty card with the first note that is about the data", () => {
    expect(emptyReason(notes, "fallback")).toBe("No salary slips exist for Oct 2026 in this selection.");
    expect(emptyReason(["Matched unit 'u1' to 'Unit 1'."], "fallback")).toBe("fallback");
  });
});
