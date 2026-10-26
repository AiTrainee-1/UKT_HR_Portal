import { describe, expect, it } from "vitest";
import type { PayrollSettingsItem } from "@/lib/api-client/custom-hooks";
import {
  bonusPayload,
  bonusPercentWarning,
  describeChanges,
  hasErrors,
  RATES_LABELS,
  ratesErrors,
  ratesPayload,
  savedPayroll,
} from "./sections";

const SETTINGS = {
  payDay: 5,
  bonusFyStartMonth: 4,
  defaultSalaryPerShift: 300,
  bonusPercent: 8.33,
  bonusWageCeiling: 7000,
  bonusEligibilityCeiling: 21000,
  otDetectionEnabled: true,
  otThresholdMinutes: 0,
  otCompensationType: "relaxation",
  // keys of other tabs, which no Payroll save may send
  smtpHost: "smtp.example.test",
  companyName: "Acme",
} as unknown as PayrollSettingsItem;

describe("saved values", () => {
  it("become text boxes, with the backend defaults before anything loads", () => {
    const loaded = savedPayroll(SETTINGS);
    // the rate suggested for new production employees moved to Production Payroll -> Pay & Bonus
    expect(loaded.rates).toEqual({ payDay: "5", bonusFyStartMonth: "4" });
    const empty = savedPayroll(undefined);
    expect(empty.rates).toEqual({ payDay: "5", bonusFyStartMonth: "4" });
    expect(empty.bonus).toEqual({ bonusPercent: "8.33", bonusWageCeiling: "7000", bonusEligibilityCeiling: "21000" });
    // the OT rules moved to the Compensation tab and PF / ESI to the PF & ESI tab: nothing of them is left here
    expect(Object.keys(empty).sort()).toEqual(["bonus", "rates"]);
  });
});

describe("each save sends only its own keys", () => {
  const forms = savedPayroll(SETTINGS);

  it("Save Payroll Settings: pay day and financial year only (both company-wide)", () => {
    expect(Object.keys(ratesPayload(forms.rates)).sort()).toEqual(["bonusFyStartMonth", "payDay"].sort());
    expect(ratesPayload({ ...forms.rates, payDay: " 10 " }).payDay).toBe(10);
  });

  it("Save Bonus Settings: the three bonus values", () => {
    expect(bonusPayload(forms.bonus)).toEqual({
      bonusPercent: 8.33,
      bonusWageCeiling: 7000,
      bonusEligibilityCeiling: 21000,
    });
  });

  it("no Payroll save sends the old OT keys or the old PF / ESI keys any more", () => {
    const sent = [...Object.keys(ratesPayload(forms.rates)), ...Object.keys(bonusPayload(forms.bonus))];
    for (const old of [
      "otDetectionEnabled",
      "otThresholdMinutes",
      "otCompensationType",
      "pfRate",
      "esiRate",
      "esiApplicableBelow",
      "prodPfRate",
      "prodEsiRate",
      "prodEsiApplicableBelow",
      "prodPfEfEnabled",
      "prodPfEfRules",
      "staffPayrollRulesEnabled",
      "prodPayrollRulesEnabled",
    ]) {
      expect(sent).not.toContain(old);
    }
  });

  it("no Staff Payroll save sends anything of production: the suggested rate, the production bonus or a cycle", () => {
    const sent = [...Object.keys(ratesPayload(forms.rates)), ...Object.keys(bonusPayload(forms.bonus))];
    for (const production of [
      "defaultSalaryPerShift",
      "prodBonusPercent",
      "prodBonusWageCeiling",
      "prodBonusEligibilityCeiling",
      "prodCycles",
      "prodLateDetectionEnabled",
    ]) {
      expect(sent).not.toContain(production);
    }
  });
});

describe("checks before sending", () => {
  const saved = savedPayroll(SETTINGS);

  it("judges changed boxes against the server's ranges", () => {
    const errors = ratesErrors({ ...saved.rates, payDay: "31", bonusFyStartMonth: "13" }, saved.rates);
    expect(errors).toEqual({
      payDay: "Must be from 1 to 28.",
      bonusFyStartMonth: "Must be from 1 to 12.",
    });
    expect(hasErrors(errors)).toBe(true);
    expect(hasErrors(ratesErrors({ ...saved.rates, payDay: "5.00" }, saved.rates))).toBe(false);
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
});

describe("change summary", () => {
  it("lists each changed value from -> to, in words", () => {
    const saved = savedPayroll(SETTINGS).rates;
    const form = { ...saved, payDay: "10", bonusFyStartMonth: "1" };
    expect(describeChanges(["payDay", "bonusFyStartMonth"], saved, form, RATES_LABELS)).toEqual([
      { label: "Salary pay day", from: "5", to: "10" },
      { label: "Financial year start month", from: "April", to: "January" },
    ]);
  });
});
