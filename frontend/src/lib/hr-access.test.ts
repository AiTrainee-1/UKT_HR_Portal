import { describe, expect, it } from "vitest";
import {
  APPROVAL_KINDS,
  ASSISTANT_LOCKED,
  applyModuleOverrides,
  approvalCount,
  canApprove,
  cleanOverrides,
  clearOverride,
  effectiveApprovals,
  isLocked,
  legacyApprovals,
  overrideCount,
  setAllApprovals,
} from "./hr-access";

describe("the catalogue", () => {
  it("lists the eleven kinds HR decides, the same as backend hr_access.APPROVAL_KEYS", () => {
    expect(APPROVAL_KINDS.map((k) => k.key)).toEqual([
      "leave",
      "permission",
      "casual_leave",
      "missing_punch",
      "attendance_correction",
      "on_duty",
      "on_duty_punch",
      "outpass",
      "request",
      "resignation",
      "advance",
    ]);
  });

  it("locks missing punches and attendance edits for HR Assistants only", () => {
    expect(Object.keys(ASSISTANT_LOCKED).sort()).toEqual(["attendance_correction", "missing_punch"]);
    expect(isLocked("hr_assistant", "missing_punch")).toBe(true);
    expect(isLocked("hr_manager", "missing_punch")).toBe(false);
    expect(isLocked("hr_assistant", "leave")).toBe(false);
  });
});

describe("module overrides", () => {
  it("puts the account's own levels on top of the role", () => {
    expect(applyModuleOverrides({ payroll: "edit", leave: "view" }, { payroll: "hidden" })).toEqual({
      payroll: "hidden",
      leave: "view",
    });
  });

  it("takes the sub-modules of a section with it unless they have a change of their own", () => {
    const role = { employees: "edit", "employees.branches": "view", "employees.departments": "edit" } as const;
    expect(applyModuleOverrides({ ...role }, { employees: "hidden" })).toEqual({ employees: "hidden" });
    expect(applyModuleOverrides({ ...role }, { employees: "hidden", "employees.branches": "view" })).toEqual({
      employees: "hidden",
      "employees.branches": "view",
    });
  });
});

describe("effective approvals", () => {
  const permissions = { leave: "edit", missing_punch: "edit", requests: "view", settlement: "hidden" } as const;

  it("follows edit = approve for a role with no approvals of its own", () => {
    const a = effectiveApprovals({ rolePermissions: { ...permissions }, roleApprovals: null, category: "admin" });
    expect(a.leave).toBe(true);
    expect(a.missing_punch).toBe(true);
    expect(a.permission).toBe(false); // view only
    expect(a.advance).toBe(false);
  });

  it("follows the role's switches, then the account's own changes", () => {
    const a = effectiveApprovals({
      rolePermissions: { ...permissions },
      roleApprovals: { leave: false, permission: true },
      overrides: { approvals: { leave: true } },
      category: "hr_manager",
    });
    expect(a.leave).toBe(true);
    expect(a.permission).toBe(true); // view + approve is allowed
    expect(a.missing_punch).toBe(false);
  });

  it("never approves what the account cannot open, nor what an HR Assistant is locked out of", () => {
    const a = effectiveApprovals({
      rolePermissions: { ...permissions },
      roleApprovals: { advance: true, missing_punch: true, attendance_correction: true },
      overrides: { approvals: { missing_punch: true } },
      category: "hr_assistant",
    });
    expect(a.advance).toBe(false); // settlement hidden
    expect(a.missing_punch).toBe(false);
    expect(a.attendance_correction).toBe(false);
  });

  it("a hidden-module override switches its approvals off too", () => {
    const a = effectiveApprovals({
      rolePermissions: { ...permissions },
      roleApprovals: { leave: true },
      overrides: { modules: { leave: "hidden" } },
      category: "hr_manager",
    });
    expect(a.leave).toBe(false);
  });
});

describe("helpers for the editors", () => {
  it("starts explicit approvals from what the old rule gives, locks kept off", () => {
    const a = legacyApprovals({ missing_punch: "edit", leave: "edit" }, "hr_assistant");
    expect(a.leave).toBe(true);
    expect(a.missing_punch).toBe(false);
    expect(approvalCount(a)).toBe(1);
  });

  it("switches every approval at once, never a locked one", () => {
    const a = setAllApprovals(true, "hr_assistant");
    expect(approvalCount(a)).toBe(APPROVAL_KINDS.length - 2);
    expect(approvalCount(setAllApprovals(true))).toBe(APPROVAL_KINDS.length);
    expect(approvalCount(setAllApprovals(false))).toBe(0);
  });

  it("cleans overrides for the API and counts them", () => {
    const o = { modules: { payroll: "hidden" as const }, approvals: { missing_punch: true, leave: false } };
    expect(cleanOverrides(o, "hr_assistant")).toEqual({ modules: { payroll: "hidden" }, approvals: { leave: false } });
    expect(cleanOverrides({ modules: {}, approvals: {} }, "hr_manager")).toEqual({});
    expect(overrideCount(o)).toBe(3);
    expect(clearOverride(o, "approvals", "leave")).toEqual({
      modules: { payroll: "hidden" },
      approvals: { missing_punch: true },
    });
  });
});

describe("canApprove", () => {
  it("is always true for the Super Admin, the old rule and non-HR users", () => {
    expect(canApprove({ role: "hr", isSuperAdmin: true, approvalMode: "explicit", approvals: {} }, "leave")).toBe(true);
    expect(canApprove({ role: "hr", approvalMode: "legacy", approvals: { leave: false } }, "leave")).toBe(true);
    expect(canApprove({ role: "hr" }, "leave")).toBe(true); // an older backend
    expect(canApprove({ role: "employee" }, "leave")).toBe(true);
    expect(canApprove(null, "leave")).toBe(true);
  });

  it("follows the approvals of an account on explicit approvals", () => {
    const user = { role: "hr", approvalMode: "explicit" as const, approvals: { leave: true, missing_punch: false } };
    expect(canApprove(user, "leave")).toBe(true);
    expect(canApprove(user, "missing_punch")).toBe(false);
    expect(canApprove(user, "advance")).toBe(false);
  });
});
