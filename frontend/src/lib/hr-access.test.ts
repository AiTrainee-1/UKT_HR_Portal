import { describe, expect, it } from "vitest";
import {
  APPROVAL_ALIASES,
  APPROVAL_GROUPS,
  APPROVAL_KINDS,
  ASSISTANT_LOCKED,
  applyModuleOverrides,
  approvalCount,
  canApprove,
  cleanOverrides,
  clearOverride,
  effectiveApprovals,
  isLocked,
  kindFor,
  legacyApprovals,
  normalizeApprovals,
  normalizeOverrideApprovals,
  overrideCount,
  roleSwitch,
  setAllApprovals,
} from "./hr-access";

describe("the catalogue", () => {
  it("lists every kind HR decides, each on its own, the same as backend hr_access.APPROVAL_KEYS", () => {
    expect(APPROVAL_KINDS.map((k) => k.key)).toEqual([
      "leave",
      "permission",
      "casual_leave",
      "missing_punch",
      "attendance_correction",
      "on_duty",
      "on_duty_punch",
      "outpass",
      "request_leave",
      "request_salary_enquiry",
      "request_shift_correction",
      "request_advance",
      "request_permission",
      "request_general",
      "resignation",
      "interview_result",
      "resume_decision",
      "advance_general",
      "advance_term",
      "payroll_hold",
      "payroll_add",
      "payroll_finalize",
      "payroll_mark_paid",
      "payroll_release",
      "payroll_mark_cleared",
      "compensation_ot",
      "bonus_status",
    ]);
    // nothing hides behind a generic label: every kind has a heading of its own page
    for (const k of APPROVAL_KINDS)
      expect(
        APPROVAL_GROUPS.some((g) => g.id === k.group),
        k.key,
      ).toBe(true);
    expect(APPROVAL_ALIASES.request).toHaveLength(6);
    expect(APPROVAL_ALIASES.advance).toEqual(["advance_general", "advance_term"]);
  });

  it("names the kind of one request: by its type, an advance by general / term", () => {
    expect(kindFor("request", { requestType: "salary_enquiry" })).toBe("request_salary_enquiry");
    expect(kindFor("request", { requestType: "unknown" })).toBe("request_general");
    expect(kindFor("advance", { advanceType: "term" })).toBe("advance_term");
    expect(kindFor("advance", {})).toBe("advance_general");
    expect(kindFor("leave")).toBe("leave");
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
    expect(a.advance_general || a.advance_term).toBe(false);
    expect(a.payroll_finalize).toBe(false); // payroll hidden
  });

  it("lets a kind split out of an older one follow the old switch until it has its own", () => {
    const a = effectiveApprovals({
      rolePermissions: { requests: "view", settlement: "edit", payroll: "edit" },
      roleApprovals: { request: true, request_general: false, advance: false },
      category: "hr_manager",
    });
    expect(a.request_salary_enquiry).toBe(true);
    expect(a.request_general).toBe(false);
    expect(a.advance_term).toBe(false);
    expect(a.payroll_finalize).toBe(true); // a "needs Edit" kind never set: edit = may, as before
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
    expect(a.advance_general).toBe(false); // settlement hidden
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

  it("reads an old kind as any of the kinds that replaced it, and an older backend's own old key", () => {
    const user = {
      role: "hr",
      approvalMode: "explicit" as const,
      approvals: { advance_general: false, advance_term: true, request_general: false },
    };
    expect(canApprove(user, "advance")).toBe(true);
    expect(canApprove(user, "request")).toBe(false);
    expect(canApprove({ ...user, approvals: { request: true } }, "request")).toBe(true);
  });
});

describe("the editors' view of a role's switches", () => {
  const perms = { requests: "view", payroll: "edit", bonus: "view" } as const;

  it("spreads an old switch over the kinds that replaced it and keeps needs-Edit kinds following Edit", () => {
    const n = normalizeApprovals({ request: true, advance: false, leave: true }, { ...perms });
    expect(APPROVAL_ALIASES.request.every((k) => n[k])).toBe(true);
    expect(n.advance_general || n.advance_term).toBe(false);
    expect(n.payroll_finalize).toBe(true); // payroll edit, never set
    expect(n.bonus_status).toBe(false); // bonus only view
    expect("request" in n || "advance" in n).toBe(false);
  });

  it("reads a role switch: own, then the old one, then Edit for a needs-Edit kind", () => {
    const kind = (key: string) => APPROVAL_KINDS.find((k) => k.key === key)!;
    expect(roleSwitch({ request: true }, kind("request_general"), "view")).toBe(true);
    expect(roleSwitch({ request: true, request_general: false }, kind("request_general"), "view")).toBe(false);
    expect(roleSwitch({}, kind("payroll_hold"), "edit")).toBe(true);
    expect(roleSwitch({}, kind("leave"), "edit")).toBe(false);
  });

  it("spreads an account's old switch, without overriding the new ones it set", () => {
    expect(normalizeOverrideApprovals({ advance: true, advance_term: false })).toEqual({
      advance_general: true,
      advance_term: false,
    });
    expect(normalizeOverrideApprovals(undefined)).toEqual({});
  });

  it("starts explicit approvals without the needs-Edit kinds, so they keep following Edit", () => {
    const a = legacyApprovals({ ...perms });
    expect("payroll_finalize" in a).toBe(false);
    expect(a.permission).toBe(false);
  });

  it("counts an old switch for every kind it covers", () => {
    expect(approvalCount({ request: true })).toBe(APPROVAL_ALIASES.request.length);
  });
});
