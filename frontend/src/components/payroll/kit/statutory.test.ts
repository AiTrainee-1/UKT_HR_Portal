import { describe, expect, it } from "vitest";
import type { PayrollStatutory, StatutoryRuleMatch } from "@/lib/api-client/custom-hooks";
import type { TableColumn } from "./export-table";
import {
  anyTds,
  basisLabel,
  explainStatutory,
  hasTds,
  percentText,
  rangeText,
  statutoryRateLabel,
  sumTds,
  tdsAmount,
  tdsLabel,
  tdsRate,
  withTdsColumns,
} from "./statutory";
import { summarizeRules } from "./statutory-rules";

// How the payroll screens decide "is there TDS here?" and what they say about PF, ESI and TDS. PF and ESI only ever apply to
// Co Emp employees and TDS only to employees on the TDS list, so every figure here is optional and a row without TDS must
// look exactly like it did before TDS existed.

describe("reading TDS off a row", () => {
  it("has TDS when it carries an amount or a percentage, and not otherwise", () => {
    expect(hasTds({ tdsDeduction: 2500, tdsPercent: 10 })).toBe(true);
    expect(hasTds({ tdsDeduction: 2500 })).toBe(true);
    // an employee on the TDS list whose TDS came to nothing is still a TDS row: the percentage says so
    expect(hasTds({ tdsDeduction: 0, tdsPercent: 7.5 })).toBe(true);
    expect(hasTds({ tdsDeduction: 0, tdsPercent: null })).toBe(false);
    expect(hasTds({ tdsDeduction: 0 })).toBe(false);
    expect(hasTds({})).toBe(false);
    expect(hasTds(null)).toBe(false);
    expect(hasTds(undefined)).toBe(false);
  });

  it("reads decimals sent as text, and ignores what is not a number", () => {
    expect(tdsAmount({ tdsDeduction: "2500.50" })).toBe(2500.5);
    expect(tdsAmount({ tdsDeduction: "n/a" })).toBe(0);
    expect(tdsAmount({ tdsDeduction: null })).toBe(0);
    expect(tdsRate({ tdsPercent: "10.00" })).toBe(10);
    expect(tdsRate({ tdsPercent: "" })).toBeNull();
    expect(tdsRate({})).toBeNull();
    expect(hasTds({ tdsDeduction: "0.00", tdsPercent: "10.00" })).toBe(true);
  });

  it("anyTds looks at every row: one TDS row is enough, none (or an empty list) is not", () => {
    expect(anyTds([{}, { tdsDeduction: 0 }, { tdsDeduction: 10 }])).toBe(true);
    expect(anyTds([{}, { tdsDeduction: 0, tdsPercent: null }])).toBe(false);
    expect(anyTds([])).toBe(false);
    expect(anyTds(undefined)).toBe(false);
  });

  it("adds the TDS of a list without floating-point dust", () => {
    expect(sumTds([{ tdsDeduction: 0.1 }, { tdsDeduction: 0.2 }, {}])).toBe(0.3);
    expect(sumTds([])).toBe(0);
    expect(sumTds(undefined)).toBe(0);
  });

  it("writes percentages without trailing zeros, and the label with the percentage when it is known", () => {
    expect(percentText(10)).toBe("10%");
    expect(percentText("10.00")).toBe("10%");
    expect(percentText(7.5)).toBe("7.5%");
    expect(percentText(12.25)).toBe("12.25%");
    expect(percentText(null)).toBe("");
    expect(tdsLabel({ tdsPercent: 10 })).toBe("TDS (10%)");
    expect(tdsLabel({ tdsPercent: null })).toBe("TDS");
    expect(tdsLabel({})).toBe("TDS");
  });
});

describe("the TDS columns of an export", () => {
  type Row = { id: number; deductions: number; tdsDeduction?: number; tdsPercent?: number | null };
  const columns: TableColumn<Row>[] = [
    { key: "id", label: "Id" },
    { key: "deductions", label: "Deductions", type: "money" },
    { key: "status", label: "Status" },
  ];

  it("leaves the columns exactly as they were (the same array) when no row has TDS", () => {
    const rows: Row[] = [
      { id: 1, deductions: 100 },
      { id: 2, deductions: 0, tdsDeduction: 0, tdsPercent: null },
    ];
    expect(withTdsColumns(columns, rows)).toBe(columns);
    expect(withTdsColumns(columns, [])).toBe(columns);
  });

  it("puts 'TDS %' and 'TDS' just before the deductions total when a row has TDS", () => {
    const rows: Row[] = [
      { id: 1, deductions: 100 },
      { id: 2, deductions: 2500, tdsDeduction: 2500, tdsPercent: 10 },
    ];
    const out = withTdsColumns(columns, rows);
    expect(out.map((c) => c.label)).toEqual(["Id", "TDS %", "TDS", "Deductions", "Status"]);
    const [, pct, tds] = out;
    expect(rows.map((r) => pct.value!(r))).toEqual([null, 10]);
    expect(rows.map((r) => tds.value!(r))).toEqual([null, 2500]); // a row with no TDS has an empty cell, not a 0
    expect(pct.type).toBe("money");
    expect(tds.type).toBe("money");
    expect(columns).toHaveLength(3); // the originals are not touched
  });

  it("goes before another column when asked, and at the end when that column is not there", () => {
    const rows: Row[] = [{ id: 2, deductions: 1, tdsDeduction: 1 }];
    expect(withTdsColumns(columns, rows, "status").map((c) => c.key)).toEqual([
      "id",
      "deductions",
      "tdsPercent",
      "tdsDeduction",
      "status",
    ]);
    expect(withTdsColumns(columns, rows, "nothing").map((c) => c.key)).toEqual([
      "id",
      "deductions",
      "status",
      "tdsPercent",
      "tdsDeduction",
    ]);
  });
});

describe("words for a salary basis and a range", () => {
  it("names the three bases, and 'Salary' for one it does not know", () => {
    expect(basisLabel("basic")).toBe("Basic salary");
    expect(basisLabel("first_portion")).toBe("Basic + DA + Retaining Allowance");
    expect(basisLabel("total")).toBe("Full monthly salary");
    expect(basisLabel("something_new")).toBe("Salary");
    expect(basisLabel(null)).toBe("Salary");
  });

  it("writes a range, and 'and above' for no upper limit", () => {
    expect(rangeText({ minAmount: 0, maxAmount: 25000 })).toBe("₹0 to ₹25,000");
    expect(rangeText({ minAmount: 25000, maxAmount: 0 })).toBe("₹25,000 and above");
    expect(rangeText({ minAmount: 1000.5, maxAmount: 2000.25 })).toBe("₹1,000.50 to ₹2,000.25");
  });
});

const RULE: StatutoryRuleMatch = {
  id: "pf1",
  label: "PF below 25,000",
  basis: "basic",
  minAmount: 0,
  maxAmount: 25000,
  ratePercent: 12,
  amountTested: 10000,
};

const CO_EMP: PayrollStatutory = {
  category: "co_emp",
  pfWages: 12500,
  firstPortionMonthly: 15000,
  pfRule: RULE,
  esiRule: null,
  eligibility: { basic: 10000, firstPortion: 15000, total: 30000 },
  rulesScope: "global",
  tds: null,
  reason: null,
};

describe("explaining how PF, ESI and TDS were worked out", () => {
  it("says nothing when payroll recorded nothing (a payroll from before the redesign)", () => {
    expect(explainStatutory(null, { pf: 100 })).toBeNull();
    expect(explainStatutory(undefined, undefined)).toBeNull();
    expect(explainStatutory("oops" as unknown as PayrollStatutory, {})).toBeNull();
  });

  it("a Co Emp employee: the PF rule that matched with its range, the base and the rupees; no ESI rule matched", () => {
    const view = explainStatutory(CO_EMP, { pf: 1500, esi: 0 })!;
    expect(view.category).toBe("co_emp");
    expect(view.headline).toBe(
      "Co Emp employee: PF and ESI are worked out from the rules for all units in Settings, on Basic + DA + Retaining Allowance (₹12,500.00 for the days paid).",
    );
    const [pf, esi] = view.lines;
    expect(pf).toMatchObject({ key: "pf", title: "PF", applied: true, amount: 1500, summary: "12% of ₹12,500.00" });
    expect(pf.notes).toEqual([
      'Rule "PF below 25,000": Basic salary of ₹10,000.00 is in its range (₹0 to ₹25,000).',
      "PF is deducted at 12%.",
    ]);
    expect(esi).toMatchObject({ key: "esi", title: "ESI", applied: false, amount: 0, summary: "No rule matched" });
    expect(esi.notes[0]).toContain("No ESI rule covers this employee's Basic salary ₹10,000.00");
    expect(esi.notes[0]).toContain("Basic + DA + Retaining Allowance ₹15,000.00");
    expect(esi.notes[0]).toContain("full salary ₹30,000.00");
    expect(view.eligibility).toEqual([
      { label: "Basic salary", amount: 10000 },
      { label: "Basic + DA + Retaining Allowance", amount: 15000 },
      { label: "Full monthly salary", amount: 30000 },
    ]);
  });

  it("names the unit's own rules when payroll used them, and copes with a missing eligibility or base", () => {
    const view = explainStatutory(
      { ...CO_EMP, rulesScope: "branch", eligibility: null, pfWages: null, pfRule: null },
      { pf: 0, esi: 0 },
    )!;
    expect(view.headline).toBe(
      "Co Emp employee: PF and ESI are worked out from this unit's own rules in Settings, on Basic + DA + Retaining Allowance.",
    );
    expect(view.lines.map((l) => [l.key, l.applied, l.summary])).toEqual([
      ["pf", false, "No rule matched"],
      ["esi", false, "No rule matched"],
    ]);
    expect(view.lines[0].notes).toEqual(["No PF rule in Settings covers this employee's salary, so none is deducted."]);
    expect(view.eligibility).toEqual([]);
  });

  it("a Production payroll says the rules were tested on the monthly equivalent of the period's pay", () => {
    const view = explainStatutory(CO_EMP, { pf: 1500, esi: 0 }, true)!;
    expect(view.lines[0].notes[0]).toBe(
      'Rule "PF below 25,000": Basic part of the monthly equivalent pay of ₹10,000.00 is in its range (₹0 to ₹25,000).',
    );
    expect(view.lines[1].notes[0]).toBe(
      "No ESI rule covers this employee's basic part of the monthly equivalent pay ₹10,000.00, first 50% of the monthly equivalent pay ₹15,000.00 or monthly equivalent pay ₹30,000.00.",
    );
    expect(view.eligibility.map((e) => e.label)).toEqual([
      "Basic part of the monthly equivalent pay",
      "First 50% of the monthly equivalent pay",
      "Monthly equivalent pay",
    ]);
    expect(basisLabel("total", true)).toBe("Monthly equivalent pay");
    expect(basisLabel("unknown", true)).toBe("Salary");
  });

  it("both PF and ESI: ESI is worked out on the same base as PF", () => {
    const esiRule = { ...RULE, id: "e1", label: "ESI below 30,000", ratePercent: 0.75, maxAmount: 30000 };
    const view = explainStatutory({ ...CO_EMP, esiRule }, { pf: 1500, esi: 93.75 })!;
    expect(view.lines[1]).toMatchObject({ key: "esi", applied: true, amount: 93.75, summary: "0.75% of ₹12,500.00" });
    expect(view.lines[1].notes[1]).toBe("ESI is deducted at 0.75%.");
  });

  it("a TDS employee: TDS only, with the percentage of the earned gross; PF and ESI never apply", () => {
    const view = explainStatutory(
      { category: "tds", tds: { percent: 10, base: 25000, amount: 2500 } },
      { pf: 0, esi: 0, tds: 2500 },
    )!;
    expect(view.category).toBe("tds");
    expect(view.headline).toBe(
      "TDS employee: TDS is deducted instead of PF and ESI, which never apply to this employee.",
    );
    expect(view.lines).toEqual([
      {
        key: "tds",
        title: "TDS (10%)",
        applied: true,
        summary: "10% of the earned gross ₹25,000.00",
        amount: 2500,
        notes: [],
      },
    ]);
    expect(view.eligibility).toEqual([]);
  });

  it("takes the TDS amount from the statutory block when the breakdown has none", () => {
    const view = explainStatutory({ category: "tds", tds: { percent: 12.5, base: 20000, amount: 2500 } }, {})!;
    expect(view.lines[0]).toMatchObject({ title: "TDS (12.5%)", amount: 2500, applied: true });
  });

  it("anyone else: the server's own reason, or a plain sentence when there is none", () => {
    expect(explainStatutory({ category: "none", reason: "Not a Co Emp employee: no PF/ESI" }, {})!.headline).toBe(
      "Not a Co Emp employee: no PF/ESI",
    );
    expect(explainStatutory({ category: "none", reason: " " }, {})!.headline).toBe(
      "Not a Co Emp employee: no PF or ESI is deducted.",
    );
    expect(explainStatutory({ category: "none" }, {})!.lines).toEqual([]);
  });
});

describe("the PF and ESI lines of the Breakdown drawer", () => {
  it("names the rate and the base payroll stored", () => {
    expect(statutoryRateLabel("pf", { pfRate: 12, statutory: CO_EMP })).toBe("PF (12% of ₹12,500.00)");
    expect(statutoryRateLabel("esi", { esiRate: 0.75, statutory: CO_EMP })).toBe("ESI (0.75% of ₹12,500.00)");
  });

  it("falls back to the rate alone, then to the bare name", () => {
    expect(statutoryRateLabel("pf", { pfRate: 12, statutory: { ...CO_EMP, pfWages: null } })).toBe("PF (12%)");
    expect(statutoryRateLabel("esi", { statutory: CO_EMP })).toBe("ESI");
  });
});

describe("how many PF / ESI rules there are for a kind of payroll", () => {
  const slice = {
    scope: { branchId: null, branchName: null, isOverride: false },
    canEdit: true,
    staff: { pfRules: [RULE], esiRules: [RULE, RULE] },
    production: { pfRules: [], esiRules: [] },
    branches: [
      { id: 1, name: "Unit 1", hasOverride: true },
      { id: 2, name: "Unit 2", hasOverride: false },
      { id: 3, name: "Unit 3", hasOverride: true },
    ],
  };

  it("counts the rules of Staff and of Production separately", () => {
    expect(summarizeRules("staff", slice)).toEqual({
      pf: 1,
      esi: 2,
      none: false,
      text: "PF: 1 rule · ESI: 2 rules",
      scope: "2 units have their own rules",
    });
    expect(summarizeRules("production", slice)).toMatchObject({
      pf: 0,
      esi: 0,
      none: true,
      text: "No PF or ESI rules are set for Production",
    });
  });

  it("says whose rules a branch login is seeing, and stays quiet about units for anyone who cannot edit", () => {
    expect(
      summarizeRules("staff", { ...slice, canEdit: false, branches: [], scope: { ...slice.scope!, isOverride: true } })!
        .scope,
    ).toBe("this unit's own rules");
    expect(summarizeRules("staff", { ...slice, canEdit: false, branches: [] })!.scope).toBeNull();
    expect(summarizeRules("staff", { ...slice, branches: [{ id: 1, name: "Unit 1", hasOverride: true }] })!.scope).toBe(
      "1 unit has its own rules",
    );
  });

  it("knows nothing when the rules could not be read: it never claims there are none", () => {
    expect(summarizeRules("staff", undefined)).toBeNull();
    expect(summarizeRules("staff", null)).toBeNull();
    expect(summarizeRules("staff", {})).toBeNull();
    expect(summarizeRules("staff", { staff: null })).toBeNull();
  });

  it("treats a list that is missing as empty once the kind is there", () => {
    expect(summarizeRules("staff", { staff: {} })).toMatchObject({ pf: 0, esi: 0, none: true });
  });
});
