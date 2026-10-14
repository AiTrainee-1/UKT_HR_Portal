import { describe, expect, it } from "vitest";
import type { PayrollSettingsItem } from "@/lib/api-client/custom-hooks";
import {
  bandErrors,
  bonusPayload,
  bonusPercentWarning,
  describeChanges,
  hasErrors,
  pfEfPayload,
  RATES_LABELS,
  ratesErrors,
  ratesPayload,
  savedPayroll,
} from "./sections";

const SETTINGS = {
  pfRate: 12,
  esiRate: 0.75,
  esiApplicableBelow: 21000,
  prodPfRate: 12,
  prodEsiRate: 0.75,
  prodEsiApplicableBelow: 21000,
  staffPayrollRulesEnabled: true,
  prodPayrollRulesEnabled: false,
  payDay: 5,
  bonusFyStartMonth: 4,
  defaultSalaryPerShift: 300,
  bonusPercent: 8.33,
  bonusWageCeiling: 7000,
  bonusEligibilityCeiling: 21000,
  otDetectionEnabled: true,
  otThresholdMinutes: 0,
  otCompensationType: "relaxation",
  prodPfEfEnabled: true,
  prodPfEfRules: [{ label: "Low", minSalary: 0, maxSalary: "20000" as unknown as number, pfRate: 12, efRate: 0.75 }],
  // keys of other tabs, which no Payroll save may send
  smtpHost: "smtp.example.test",
  companyName: "Acme",
} as unknown as PayrollSettingsItem;

describe("saved values", () => {
  it("become text boxes and switches, with the backend defaults before anything loads", () => {
    const loaded = savedPayroll(SETTINGS);
    expect(loaded.rates).toMatchObject({ pfRate: "12", esiRate: "0.75", staffRulesEnabled: true, payDay: "5" });
    expect(loaded.pfEf.prodPfEfRules[0]).toEqual({
      label: "Low",
      minSalary: "0",
      maxSalary: "20000",
      pfRate: "12",
      efRate: "0.75",
    });
    const empty = savedPayroll(undefined);
    expect(empty.rates).toMatchObject({
      staffRulesEnabled: false,
      pfRate: "0",
      esiApplicableBelow: "21000",
      payDay: "5",
    });
    expect(empty.bonus).toEqual({ bonusPercent: "8.33", bonusWageCeiling: "7000", bonusEligibilityCeiling: "21000" });
    // the OT rules moved to the Compensation tab: nothing of them is left in the Payroll forms
    expect(Object.keys(empty).sort()).toEqual(["bonus", "pfEf", "rates"]);
  });
});

describe("each save sends only its own keys", () => {
  const forms = savedPayroll(SETTINGS);

  it("Save Payroll Settings: rates, switches, pay day, financial year, per-shift suggestion", () => {
    expect(Object.keys(ratesPayload(forms.rates)).sort()).toEqual(
      [
        "bonusFyStartMonth",
        "defaultSalaryPerShift",
        "esiApplicableBelow",
        "esiRate",
        "payDay",
        "pfRate",
        "prodEsiApplicableBelow",
        "prodEsiRate",
        "prodPayrollRulesEnabled",
        "prodPfRate",
        "staffPayrollRulesEnabled",
      ].sort(),
    );
    expect(ratesPayload({ ...forms.rates, pfRate: " 10.5 " }).pfRate).toBe(10.5);
  });

  it("Save Bonus Settings: the three bonus values", () => {
    expect(bonusPayload(forms.bonus)).toEqual({
      bonusPercent: 8.33,
      bonusWageCeiling: 7000,
      bonusEligibilityCeiling: 21000,
    });
  });

  it("no Payroll save sends the old OT keys any more (their rules are saved from the Compensation tab)", () => {
    const sent = [
      ...Object.keys(ratesPayload(forms.rates)),
      ...Object.keys(bonusPayload(forms.bonus)),
      ...Object.keys(pfEfPayload(forms.pfEf, forms.pfEf, SETTINGS)),
    ];
    for (const old of ["otDetectionEnabled", "otThresholdMinutes", "otCompensationType"]) {
      expect(sent).not.toContain(old);
    }
  });

  it("Save PF/EF Rules: an untouched table goes back exactly as stored, an edited one as numbers", () => {
    expect(pfEfPayload(forms.pfEf, forms.pfEf, SETTINGS)).toEqual({
      prodPfEfEnabled: true,
      prodPfEfRules: SETTINGS.prodPfEfRules,
    });
    const edited = {
      prodPfEfEnabled: false,
      prodPfEfRules: [{ label: " High ", minSalary: "20001", maxSalary: "0", pfRate: "12", efRate: "0" }],
    };
    expect(pfEfPayload(edited, forms.pfEf, SETTINGS)).toEqual({
      prodPfEfEnabled: false,
      prodPfEfRules: [{ label: "High", minSalary: 20001, maxSalary: 0, pfRate: 12, efRate: 0 }],
    });
  });
});

describe("checks before sending", () => {
  const saved = savedPayroll(SETTINGS);

  it("judges changed boxes against the server's ranges", () => {
    const errors = ratesErrors(
      {
        ...saved.rates,
        pfRate: "120",
        esiRate: "",
        payDay: "31",
        esiApplicableBelow: "21000.505",
        bonusFyStartMonth: "13",
      },
      saved.rates,
    );
    expect(errors).toEqual({
      pfRate: "Must be from 0 to 100.",
      esiRate: "Enter a number.",
      payDay: "Must be from 1 to 28.",
      esiApplicableBelow: "Use at most 2 decimals.",
      bonusFyStartMonth: "Must be from 1 to 12.",
    });
    expect(hasErrors(errors)).toBe(true);
    expect(hasErrors(ratesErrors({ ...saved.rates, pfRate: "12.00" }, saved.rates))).toBe(false);
  });

  it("never judges a value left as it was saved (here a stored pay day of 0), only one that was changed", () => {
    const odd = { ...saved.rates, payDay: "0" };
    expect(ratesErrors(odd, odd)).toEqual({});
    expect(ratesErrors(odd, saved.rates)).toEqual({ payDay: "Must be from 1 to 28." });
  });

  it("warns, without refusing, about a bonus rate outside the Act's 8.33-20", () => {
    expect(bonusPercentWarning("8.33")).toBeNull();
    expect(bonusPercentWarning("20")).toBeNull();
    expect(bonusPercentWarning("5")).toContain("outside the Payment of Bonus Act's 8.33% to 20%");
    expect(bonusPercentWarning("abc")).toBeNull();
  });

  it("checks every cell of an edited band table, and Max against Min", () => {
    const rows = [
      { label: "Low", minSalary: "0", maxSalary: "20000", pfRate: "12", efRate: "0.75" },
      { label: "x".repeat(81), minSalary: "500", maxSalary: "100", pfRate: "101", efRate: "-1" },
    ];
    expect(bandErrors(rows, saved.pfEf.prodPfEfRules)).toEqual([
      {},
      {
        label: "Keep the name to 80 characters.",
        maxSalary: "Must be 0 (no upper limit) or at least the Min.",
        pfRate: "Must be from 0 to 100.",
        efRate: "Must be 0 or more.",
      },
    ]);
    expect(bandErrors(saved.pfEf.prodPfEfRules, saved.pfEf.prodPfEfRules)).toEqual([{}]);
  });
});

describe("change summary", () => {
  it("lists each changed value from -> to, in words", () => {
    const saved = savedPayroll(SETTINGS).rates;
    const form = {
      ...saved,
      pfRate: "10",
      staffRulesEnabled: false,
      esiApplicableBelow: "25000",
      bonusFyStartMonth: "1",
    };
    expect(
      describeChanges(
        ["pfRate", "staffRulesEnabled", "esiApplicableBelow", "bonusFyStartMonth"],
        saved,
        form,
        RATES_LABELS,
      ),
    ).toEqual([
      { label: "Staff PF rate", from: "12%", to: "10%" },
      { label: "Staff PF and ESI deductions", from: "On", to: "Off" },
      { label: "Staff ESI ceiling", from: "₹21,000.00", to: "₹25,000.00" },
      { label: "Financial year start month", from: "April", to: "January" },
    ]);
  });
});
