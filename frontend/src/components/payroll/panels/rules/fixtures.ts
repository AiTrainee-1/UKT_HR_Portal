import type { EmployeeRules, PayrollRulesResponse, RuleGroup } from "@/lib/api-client/custom-hooks";

// Staff Payroll's rules for October 2026: three groups of rules configured on the Settings page, and four employees (one
// with nothing wrong, one with a missing shift and bank details, one with a night shift and no cycle rate, one with a
// flag the panel has no name for).

export const SETTINGS_GROUPS: RuleGroup[] = [
  {
    group: "Attendance",
    items: [
      {
        key: "attendance_mode",
        label: "Attendance mode",
        value: "Strict (4-punch)",
        detail: "Four punches a day: in, lunch out, lunch in, out.",
        source: "settings",
        settingsPath: "/hr/settings?tab=attendance#attendance-mode",
      },
      {
        key: "late_window",
        label: "Late window",
        value: "10 min grace",
        detail: null,
        source: "settings",
        settingsPath: "/hr/settings?tab=attendance#late-window",
      },
    ],
  },
  {
    group: "Late deductions",
    items: [
      {
        key: "late_free_allowance",
        label: "Free late arrivals a month",
        value: "3 free, then slabs",
        detail: "From the 4th late arrival a slab of salary is deducted.",
        source: "settings",
        settingsPath: "/hr/settings?tab=late_detection#free-allowance",
      },
    ],
  },
  {
    group: "PF and ESI",
    items: [
      {
        key: "pf_rules",
        label: "PF rules (Staff)",
        value: "12% when Basic is up to ₹25,000",
        detail: "Co Emp employees only: 12% of Basic + DA + Retaining Allowance.",
        source: "settings",
        settingsPath: "/hr/settings?tab=pf_esi#staff-pf-rules",
      },
      {
        key: "esi_rules",
        label: "ESI rules (Staff)",
        value: "0.75% when Basic is up to ₹21,000",
        source: "settings",
        settingsPath: "/hr/settings?tab=pf_esi#staff-esi-rules",
      },
    ],
  },
];

export const EMPLOYEE_RULES: EmployeeRules[] = [
  {
    employeeId: 11,
    employeeCode: "PC-S1",
    employeeName: "Asha Worker",
    department: "Weaving",
    designation: "Weaver",
    payrollId: 101,
    chips: [
      { key: "shift", label: "General 09:00-18:00", tone: "info" },
      { key: "late", label: "3 free lates", tone: "neutral" },
    ],
    groups: [
      {
        group: "Shift",
        items: [
          {
            key: "shift",
            label: "Assigned shift",
            value: "General 09:00-18:00",
            detail: "Grace 10 min, Saturday working",
            source: "shift",
            settingsPath: null,
          },
        ],
      },
      {
        group: "Salary",
        items: [
          { key: "salary", label: "Monthly salary", value: "₹29,500", source: "employee", settingsPath: null },
          {
            key: "pf",
            label: "PF",
            value: "12% of Basic + DA + Retaining (Co Emp)",
            source: "settings",
            settingsPath: "/hr/settings?tab=pf_esi#staff-pf-rules",
            applied: "10% of Basic + DA + Retaining (Co Emp)",
            changed: true,
          },
        ],
      },
    ],
    flags: [],
  },
  {
    employeeId: 12,
    employeeCode: "PC-S2",
    employeeName: "Bala Kumar",
    department: "Stitching",
    designation: "Tailor",
    payrollId: 102,
    chips: [{ key: "shift", label: "No shift", tone: "warning" }],
    groups: [
      {
        group: "Shift",
        items: [{ key: "shift", label: "Assigned shift", value: "None", source: "shift", settingsPath: null }],
      },
    ],
    flags: ["no_shift", "no_bank"],
  },
  {
    employeeId: 13,
    employeeCode: "PC-S3",
    employeeName: "Chitra Devi",
    department: "Weaving",
    designation: "Weaver",
    payrollId: 103,
    chips: [
      { key: "shift", label: "Night 21:00-06:00", tone: "info" },
      { key: "cycle", label: "Weekly", tone: "accent" },
      { key: "cycle", label: "Biweekly before", tone: "neutral" },
    ],
    groups: [],
    flags: ["no_rate"],
  },
  {
    employeeId: 14,
    employeeCode: "PC-S4",
    employeeName: "Divya Nair",
    department: null,
    designation: null,
    payrollId: null,
    chips: [],
    groups: [],
    flags: ["no_pf_number"],
  },
];

export function makeRules(over: Partial<PayrollRulesResponse> = {}): PayrollRulesResponse {
  return {
    scope: {
      label: "October 2026",
      start: "2026-10-01",
      end: "2026-10-31",
      month: 10,
      year: 2026,
      days: 31,
      cycle: null,
      cycleLabel: null,
    },
    settings: SETTINGS_GROUPS,
    employees: EMPLOYEE_RULES,
    ...over,
  };
}

/** `n` employees on a general shift, every fifth with a missing shift, for the pagination test. */
export function manyEmployees(n: number): EmployeeRules[] {
  return Array.from({ length: n }, (_, i) => ({
    employeeId: 2000 + i,
    employeeCode: `R${String(i + 1).padStart(3, "0")}`,
    employeeName: `Rule Worker ${String(i + 1).padStart(3, "0")}`,
    department: i % 2 === 0 ? "Weaving" : "Stitching",
    designation: "Operator",
    payrollId: 6000 + i,
    chips: [{ key: "shift", label: i % 5 === 0 ? "No shift" : "General", tone: i % 5 === 0 ? "warning" : "info" }],
    groups: [],
    flags: i % 5 === 0 ? ["no_shift"] : [],
  }));
}
