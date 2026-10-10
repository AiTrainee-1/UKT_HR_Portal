import { describe, expect, it } from "vitest";
import { hasHrAccess } from "./access";

describe("hasHrAccess", () => {
  it("is false for a role-less Managing Director and for nobody", () => {
    expect(hasHrAccess({ permissions: {} })).toBe(false);
    expect(hasHrAccess({})).toBe(false);
    expect(hasHrAccess(null)).toBe(false);
    expect(hasHrAccess(undefined)).toBe(false);
  });

  it("is true when any module can at least be viewed, or for an administrator", () => {
    expect(hasHrAccess({ permissions: { employees: "view" } })).toBe(true);
    expect(hasHrAccess({ permissions: { payroll: "hidden", reports: "edit" } })).toBe(true);
    expect(hasHrAccess({ isSuperAdmin: true })).toBe(true);
  });

  it("is false when every module is hidden", () => {
    expect(hasHrAccess({ permissions: { employees: "hidden", payroll: "hidden" } })).toBe(false);
  });

  it("goes by the role alone, not by the access the MD portal gives the MD to the pages it copies", () => {
    // what the server sends a role-less MD: effective permissions (with the MD's grants) but no role permissions
    const md = { permissions: { employees: "edit", attendance: "edit" }, rolePermissions: {} } as const;
    expect(hasHrAccess(md)).toBe(false);
    expect(hasHrAccess({ ...md, rolePermissions: { payroll: "view" } })).toBe(true);
  });
});
