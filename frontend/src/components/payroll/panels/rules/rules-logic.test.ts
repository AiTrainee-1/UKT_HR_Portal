import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RuleItem } from "@/lib/api-client/custom-hooks";
import { EMPLOYEE_RULES, SETTINGS_GROUPS, manyEmployees } from "./fixtures";
import {
  FLAG_LABELS,
  NO_RULE_FILTERS,
  RULE_SOURCE_LABEL,
  chipKindLabel,
  countRuleProblems,
  countRules,
  filterEmployeeRules,
  flagLabel,
  flagTone,
  hasRuleProblem,
  humanizeKey,
  ruleChipKinds,
  ruleEditLink,
  ruleFiltersActive,
  ruleGroupKind,
  rulesExportColumns,
} from "./rules-logic";

const [ASHA, BALA, CHITRA, DIVYA] = EMPLOYEE_RULES;
const names = (q: Partial<typeof NO_RULE_FILTERS>) =>
  filterEmployeeRules(EMPLOYEE_RULES, { ...NO_RULE_FILTERS, ...q }).map((e) => e.employeeName);

describe("the names of the flags", () => {
  it("are the owner's words for the four problems", () => {
    expect(flagLabel("no_shift")).toBe("No shift assigned");
    expect(flagLabel("no_rate")).toBe("No rate per shift");
    expect(flagLabel("no_cycle")).toBe("Not on a cycle");
    expect(flagLabel("no_bank")).toBe("Bank details missing");
  });

  it("accept the other spellings a bank problem may arrive as", () => {
    expect(flagLabel("bank_missing")).toBe("Bank details missing");
    expect(flagLabel("no_bank_details")).toBe("Bank details missing");
    expect(flagLabel("no_salary")).toBe("No salary amount");
  });

  it("put a flag nobody has named into words rather than showing the key", () => {
    expect(flagLabel("no_pf_number")).toBe("No pf number");
    expect(flagLabel("weird-key.here")).toBe("Weird key here");
    expect(flagLabel("")).toBe("Problem");
    expect(flagLabel("   ")).toBe("Problem");
  });

  it("every named flag has words, and none is shown as its key", () => {
    for (const [key, label] of Object.entries(FLAG_LABELS)) {
      expect(label).not.toBe(key);
      expect(label).toMatch(/^[A-Z]/);
    }
  });

  it("are red when payroll cannot be generated for the person, amber otherwise", () => {
    expect(flagTone("no_rate")).toBe("danger");
    expect(flagTone("no_salary")).toBe("danger");
    expect(flagTone("no_cycle")).toBe("danger");
    expect(flagTone("no_shift")).toBe("warning");
    expect(flagTone("no_bank")).toBe("warning");
    expect(flagTone("anything_else")).toBe("warning");
  });

  it("humanize a key", () => {
    expect(humanizeKey("pay_cycle")).toBe("Pay cycle");
    expect(humanizeKey("shift")).toBe("Shift");
    expect(humanizeKey("__x__")).toBe("X");
    expect(humanizeKey("")).toBe("");
  });

  it("call the missing rate what it is: a salary for staff, a rate per shift for production", () => {
    // the server raises no_rate for a staff member with no monthly salary and a production worker with no rate per shift
    expect(flagLabel("no_rate", "staff")).toBe("No salary amount");
    expect(flagLabel("no_rate", "production")).toBe("No rate per shift");
    expect(flagLabel("no_rate")).toBe("No rate per shift");
    // nothing else depends on the payroll
    for (const key of ["no_shift", "no_cycle", "no_bank", "no_pf_number"]) {
      expect(flagLabel(key, "staff")).toBe(flagLabel(key, "production"));
    }
  });

  it("the search finds an employee by the words their flag is shown with", () => {
    const search = (q: string, kind?: "staff" | "production") =>
      filterEmployeeRules(EMPLOYEE_RULES, { ...NO_RULE_FILTERS, q }, kind).map((e) => e.employeeName);
    expect(search("salary amount", "staff")).toEqual(["Chitra Devi"]);
    expect(search("salary amount", "production")).toEqual([]);
    expect(search("rate per shift", "production")).toEqual(["Chitra Devi"]);
    expect(search("rate per shift", "staff")).toEqual([]);
  });
});

describe("the filters of the employees table", () => {
  it("start with everyone", () => {
    expect(names({})).toHaveLength(4);
    expect(ruleFiltersActive(NO_RULE_FILTERS)).toBe(0);
  });

  it("only employees with rule problems keeps those with a flag", () => {
    expect(names({ problemsOnly: true })).toEqual(["Bala Kumar", "Chitra Devi", "Divya Nair"]);
    expect(hasRuleProblem(ASHA)).toBe(false);
    expect(hasRuleProblem(BALA)).toBe(true);
    expect(countRuleProblems(EMPLOYEE_RULES)).toBe(3);
    expect(countRuleProblems([])).toBe(0);
  });

  it("department keeps that department, and NO_DEPARTMENT the people with none", () => {
    expect(names({ dept: "Weaving" })).toEqual(["Asha Worker", "Chitra Devi"]);
    expect(names({ dept: "Stitching" })).toEqual(["Bala Kumar"]);
    expect(names({ dept: "__none__" })).toEqual(["Divya Nair"]);
    expect(names({ dept: "Nowhere" })).toEqual([]);
  });

  it("the search matches the name, code, department, designation, the chips and the flags", () => {
    expect(names({ q: "asha" })).toEqual(["Asha Worker"]);
    expect(names({ q: "pc-s3" })).toEqual(["Chitra Devi"]);
    expect(names({ q: "stitching" })).toEqual(["Bala Kumar"]);
    expect(names({ q: "tailor" })).toEqual(["Bala Kumar"]);
    expect(names({ q: "night" })).toEqual(["Chitra Devi"]); // her shift chip
    expect(names({ q: "09:00-18:00" })).toEqual(["Asha Worker"]);
    expect(names({ q: "bank" })).toEqual(["Bala Kumar"]); // a flag's words
    expect(names({ q: "no rate" })).toEqual(["Chitra Devi"]);
    expect(names({ q: "pf number" })).toEqual(["Divya Nair"]); // an unnamed flag's words
    expect(names({ q: "  ASHA  weaving " })).toEqual(["Asha Worker"]);
    expect(names({ q: "zzz" })).toEqual([]);
  });

  it("combine", () => {
    expect(names({ dept: "Weaving", problemsOnly: true })).toEqual(["Chitra Devi"]);
    expect(names({ dept: "Weaving", q: "night", problemsOnly: true })).toEqual(["Chitra Devi"]);
    expect(names({ dept: "Stitching", q: "asha" })).toEqual([]);
  });

  it("count how many are on", () => {
    expect(ruleFiltersActive({ q: "a", dept: "", problemsOnly: false })).toBe(1);
    expect(ruleFiltersActive({ q: "   ", dept: "", problemsOnly: false })).toBe(0);
    expect(ruleFiltersActive({ q: "a", dept: "Weaving", problemsOnly: true })).toBe(3);
  });
});

describe("where a rule is changed", () => {
  const rule = (over: Partial<RuleItem>): RuleItem => ({
    key: "k",
    label: "L",
    value: "V",
    source: "settings",
    settingsPath: null,
    ...over,
  });

  it("is the Settings address the server sent, whatever the source", () => {
    expect(ruleEditLink(rule({ settingsPath: "/hr/settings?tab=payroll#pf-rate" }))).toEqual({
      href: "/hr/settings?tab=payroll#pf-rate",
      label: "Edit in Settings",
    });
    expect(ruleEditLink(rule({ source: "shift", settingsPath: "/hr/settings?tab=attendance" }))?.label).toBe(
      "Edit in Settings",
    );
  });

  it("is where the source is managed when there is no Settings address", () => {
    expect(ruleEditLink(rule({ source: "employee" }), 7)).toEqual({
      href: "/hr/employees/7/edit",
      label: "Edit on profile",
    });
    expect(ruleEditLink(rule({ source: "shift" }))).toEqual({ href: "/hr/shifts", label: "Open Manage Shifts" });
    expect(ruleEditLink(rule({ source: "cycle" }))).toEqual({
      href: "/hr/employees/productionEmployee",
      label: "Open Production Employees",
    });
  });

  it("does not follow a Settings address that is not a page of this app", () => {
    expect(ruleEditLink(rule({ settingsPath: "javascript:alert(1)", source: "shift" }))).toEqual({
      href: "/hr/shifts",
      label: "Open Manage Shifts",
    });
    expect(ruleEditLink(rule({ settingsPath: "https://example.com", source: "settings" }))).toBeNull();
    expect(ruleEditLink(rule({ settingsPath: "//example.com", source: "settings" }))).toBeNull();
  });

  it("is nothing for a rule with no known place", () => {
    expect(ruleEditLink(rule({ source: "settings" }))).toBeNull();
    expect(ruleEditLink(rule({ source: "employee" }))).toBeNull(); // no employee to open
  });

  it("only ever points at pages of the app", () => {
    // (the path is a variable on purpose: Vite turns a literal `new URL("...", import.meta.url)` into an asset address)
    const appPath = "../../../../App.tsx";
    const APP = readFileSync(fileURLToPath(new URL(appPath, import.meta.url)), "utf8");
    const routes = [...APP.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
    const exists = (href: string) =>
      routes.some((p) => new RegExp(`^${p.replace(/:[^/]+\??/g, "[^/]+")}$`).test(href.split(/[?#]/)[0]));
    for (const source of ["employee", "shift", "cycle"] as const) {
      const link = ruleEditLink(rule({ source }), 7)!;
      expect(exists(link.href), link.href).toBe(true);
    }
  });

  it("names where a rule comes from", () => {
    expect(RULE_SOURCE_LABEL).toEqual({
      settings: "Settings",
      employee: "Employee profile",
      shift: "Shift",
      cycle: "Pay cycle",
    });
  });

  it("counts the rules of some groups", () => {
    expect(countRules(SETTINGS_GROUPS)).toBe(5);
    expect(countRules([])).toBe(0);
    expect(countRules(ASHA.groups)).toBe(3);
  });
});

describe("the icon of a group of rules", () => {
  it("is picked from the group's name", () => {
    const kind = ruleGroupKind;
    expect(kind("Late deductions")).toBe("late");
    expect(kind("Late and early out")).toBe("late");
    expect(kind("Permissions")).toBe("late");
    expect(kind("Overtime")).toBe("overtime");
    expect(kind("PF and ESI")).toBe("deductions");
    expect(kind("PF, ESI and TDS")).toBe("deductions");
    expect(kind("TDS")).toBe("deductions");
    expect(kind("Co Emp rules")).toBe("deductions");
    expect(kind("Advance deductions")).toBe("deductions");
    expect(kind("Attendance")).toBe("attendance");
    expect(kind("Shift")).toBe("shift");
    expect(kind("Pay cycle")).toBe("cycle");
    expect(kind("Pay period")).toBe("cycle");
    expect(kind("Salary")).toBe("pay");
    expect(kind("Something new")).toBe("other");
    expect(kind("")).toBe("other");
  });

  it("knows the groups the server names today", () => {
    // backend/api/payroll_insights_rules.py GROUP_*
    expect(ruleGroupKind("Attendance & late detection")).toBe("attendance");
    expect(ruleGroupKind("Attendance mode & late detection")).toBe("attendance");
    expect(ruleGroupKind("Half day & permissions")).toBe("late");
    expect(ruleGroupKind("Statutory (PF / ESI)")).toBe("deductions");
    expect(ruleGroupKind("Statutory (PF / ESI / TDS)")).toBe("deductions");
    expect(ruleGroupKind("Pay basis")).toBe("pay");
    expect(ruleGroupKind("Overtime / Compensation switch")).toBe("overtime");
    expect(ruleGroupKind("Pay cycle")).toBe("cycle");
    expect(ruleGroupKind("  PAY CYCLE ")).toBe("cycle");
  });
});

describe("the export", () => {
  const columns = rulesExportColumns(EMPLOYEE_RULES);
  const row = (e: (typeof EMPLOYEE_RULES)[number]) => Object.fromEntries(columns.map((c) => [c.label, c.value?.(e)]));

  it("has one column for each kind of rule chip that occurs, in the order first met", () => {
    expect(ruleChipKinds(EMPLOYEE_RULES)).toEqual([
      { key: "shift", label: "Shift" },
      { key: "late", label: "Late" },
      { key: "cycle", label: "Pay cycle" },
    ]);
    expect(columns.map((c) => c.label)).toEqual([
      "Employee code",
      "Employee",
      "Department",
      "Designation",
      "Shift",
      "Late",
      "Pay cycle",
      "Flags",
    ]);
    expect(new Set(columns.map((c) => c.key)).size).toBe(columns.length);
  });

  it("has only the fixed columns when nobody has a chip", () => {
    expect(rulesExportColumns([DIVYA]).map((c) => c.label)).toEqual([
      "Employee code",
      "Employee",
      "Department",
      "Designation",
      "Flags",
    ]);
    expect(rulesExportColumns([]).map((c) => c.label)).toEqual([
      "Employee code",
      "Employee",
      "Department",
      "Designation",
      "Flags",
    ]);
  });

  it("writes the chips of each kind, and the flags in words", () => {
    expect(row(ASHA)).toEqual({
      "Employee code": "PC-S1",
      Employee: "Asha Worker",
      Department: "Weaving",
      Designation: "Weaver",
      Shift: "General 09:00-18:00",
      Late: "3 free lates",
      "Pay cycle": "",
      Flags: "",
    });
    expect(row(BALA).Flags).toBe("No shift assigned; Bank details missing");
    expect(row(BALA).Shift).toBe("No shift");
    expect(row(BALA).Late).toBe("");
  });

  it("joins two chips of one kind, and leaves empty what is missing", () => {
    expect(row(CHITRA)["Pay cycle"]).toBe("Weekly; Biweekly before");
    expect(row(CHITRA).Flags).toBe("No rate per shift");
    expect(row(DIVYA)).toMatchObject({ Department: "", Designation: "", Flags: "No pf number" });
  });

  it("is made over every employee, so a kind that only some have still has its column", () => {
    const many = manyEmployees(8);
    expect(rulesExportColumns(many).map((c) => c.label)).toContain("Shift");
    expect(many.filter(hasRuleProblem)).toHaveLength(2); // indexes 0 and 5
  });

  it("heads the columns of the chips the server really sends in proper words", () => {
    // staff: shift, saturday_off, pf, esi, bank. production: cycle, rate, shift, statutory, bank
    const chip = (key: string, label: string) => ({ key, label, tone: "neutral" as const });
    const staff = { ...ASHA, chips: ["shift", "saturday_off", "pf", "esi", "bank"].map((k) => chip(k, k)), flags: [] };
    const production = {
      ...ASHA,
      chips: ["cycle", "rate", "shift", "statutory", "bank"].map((k) => chip(k, k)),
      flags: [],
    };
    const headings = (e: typeof staff) =>
      rulesExportColumns([e])
        .slice(4, -1)
        .map((c) => c.label);
    expect(headings(staff)).toEqual(["Shift", "Saturday off", "PF", "ESI", "Bank details"]);
    expect(headings(production)).toEqual(["Pay cycle", "Rate per shift", "Shift", "PF / ESI", "Bank details"]);
    // a kind nobody has named reads as words
    expect(chipKindLabel("saturday_half")).toBe("Saturday half");
    // the new model's kinds: a TDS employee, a Co Emp employee
    expect(chipKindLabel("tds")).toBe("TDS");
    expect(chipKindLabel("co_emp")).toBe("Co Emp");
    expect(chipKindLabel("")).toBe("");
  });

  it("writes the flags of a staff payroll with the staff wording", () => {
    const flags = (kind?: "staff" | "production") =>
      rulesExportColumns(EMPLOYEE_RULES, kind).find((c) => c.label === "Flags")!.value!(CHITRA);
    expect(flags("staff")).toBe("No salary amount");
    expect(flags("production")).toBe("No rate per shift");
    expect(flags()).toBe("No rate per shift");
  });
});
