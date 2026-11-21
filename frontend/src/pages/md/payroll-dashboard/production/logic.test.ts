import { describe, expect, it } from "vitest";
import { overviewFixture, personFixture } from "./fixtures";
import {
  PROD_DEFAULT,
  applyProdPatch,
  cyclesIn,
  deductionLines,
  monthCycleRows,
  nextProdSort,
  parseProdState,
  paymentWords,
  periodParams,
  periodRows,
  periodTone,
  prodChange,
  prodSearch,
  workerChartRows,
} from "./logic";

describe("the Production side's state in the address", () => {
  it("reads every key and writes it back in a fixed order", () => {
    const search =
      "?kind=production&view=workers&cycle=weekly&period=2026-11-02_2026-11-08&branch=1&department=Cutting&q=mani&sort=netPaid&dir=asc&page=2";
    const state = parseProdState(search);
    expect(state).toEqual({
      view: "workers",
      cycle: "weekly",
      period: "2026-11-02_2026-11-08",
      branch: "1",
      department: "Cutting",
      q: "mani",
      worker: null,
      sort: "netPaid",
      dir: "asc",
      page: 2,
    });
    expect(prodSearch(state)).toBe(search);
  });

  it("falls back to the defaults for anything unknown, and an open worker means the Workers tab", () => {
    expect(parseProdState("?kind=production&view=charts&cycle=daily&period=last&sort=salary&page=0")).toEqual(
      PROD_DEFAULT,
    );
    expect(parseProdState("?worker=501&view=overview").view).toBe("workers");
    expect(prodSearch(PROD_DEFAULT)).toBe("?kind=production");
  });

  it("starts another cycle at its latest period, a new filter at page 1, and closes the worker off the tab", () => {
    const s = { ...PROD_DEFAULT, cycle: "biweekly" as const, period: "2026-10-08_2026-10-21", page: 3 };
    expect(applyProdPatch(s, { cycle: "weekly" })).toMatchObject({ cycle: "weekly", period: "", page: 1 });
    expect(applyProdPatch(s, { period: "2026-10-22_2026-11-04", cycle: "biweekly" }).period).toBe(
      "2026-10-22_2026-11-04",
    );
    expect(applyProdPatch(s, { page: 4 }).page).toBe(4);
    const open = applyProdPatch(s, { worker: 501 });
    expect(open.view).toBe("workers");
    expect(applyProdPatch(open, { view: "overview" }).worker).toBeNull();
  });

  it("turns a column's direction around on a second click", () => {
    expect(nextProdSort({ sort: "name", dir: "asc" }, "netPaid")).toEqual({ sort: "netPaid", dir: "desc" });
    expect(nextProdSort({ sort: "netPaid", dir: "desc" }, "netPaid")).toEqual({ sort: "netPaid", dir: "asc" });
    expect(nextProdSort({ sort: "netPaid", dir: "desc" }, "code")).toEqual({ sort: "code", dir: "asc" });
  });

  it("splits a period key into the server's parameters", () => {
    expect(periodParams("2026-10-22_2026-11-04")).toEqual({ periodStart: "2026-10-22", periodEnd: "2026-11-04" });
    expect(periodParams("")).toEqual({});
  });
});

describe("figures and chart rows", () => {
  const data = overviewFixture();

  it("takes the server's change and works out the rest", () => {
    expect(prodChange(data, "companyCost")).toEqual(data.change!.companyCost);
    const att = prodChange(data, "attendancePct");
    expect(att?.abs).toBeCloseTo(data.current!.attendancePct! - data.previous!.attendancePct!, 1);
    expect(prodChange(undefined, "netPaid")).toBeNull();
  });

  it("draws the cycle's periods oldest first, the chosen one marked", () => {
    const rows = periodRows(data.trend, data.period!.key);
    expect(rows.map((r) => r.tick)).toEqual(["10 Sep", "24 Sep", "8 Oct", "22 Oct"]);
    expect(rows.filter((r) => r.selected).map((r) => r.key)).toEqual(["2026-10-22_2026-11-04"]);
    expect(rows[3].deductions).toBe(data.current!.deductions.total);
  });

  it("stacks each cycle's company cost per month", () => {
    const rows = monthCycleRows(data.months);
    const nov = rows.find((r) => r.key === "2026-11")!;
    expect((nov.weekly ?? 0) + (nov.biweekly ?? 0)).toBeCloseTo(nov.companyCost, 2);
    expect(cyclesIn(data.months)).toEqual(["weekly", "biweekly"]);
  });

  it("lists the deductions biggest first without the nil lines", () => {
    const lines = deductionLines(data.current!);
    expect(lines.map((l) => l.key)).not.toContain("pf");
    expect(lines.reduce((a, l) => a + l.share, 0)).toBeCloseTo(100, 5);
    expect(lines[0].amount).toBeGreaterThanOrEqual(lines[lines.length - 1].amount);
  });

  it("draws a worker's periods oldest first", () => {
    const periods = personFixture(501).periods;
    expect(workerChartRows(periods).map((r) => r.key)).toEqual(periods.map((p) => p.key).reverse());
  });

  it("says where a period stands and whether a payslip is paid", () => {
    expect(periodTone("paid")).toBe("success");
    expect(periodTone("finalized")).toBe("warning");
    expect(periodTone("generated")).toBe("info");
    expect(paymentWords("paid", true).label).toBe("Paid");
    expect(paymentWords("not_paid", true).label).toBe("Cleared, not paid");
    expect(paymentWords("not_paid", false).label).toBe("Not paid");
  });
});
