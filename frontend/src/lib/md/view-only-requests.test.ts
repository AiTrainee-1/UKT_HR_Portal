import { describe, expect, it } from "vitest";
import { viewOnlyWorkflowsFor } from "./view-only-requests";

const hr = (permissions: Record<string, "hidden" | "view" | "edit">, extra = {}) => ({
  role: "hr" as const,
  employeeId: null,
  permissions,
  ...extra,
});

describe("which requests a user only views", () => {
  it("lists all three for the MD, whose leave and requests modules are view", () => {
    expect(viewOnlyWorkflowsFor(hr({ leave: "view", requests: "view", employees: "edit" }, { isMd: true }))).toEqual([
      "leave",
      "permission",
      "outpass",
    ]);
  });

  it("lists nothing for someone who may edit both modules, or for a super administrator", () => {
    expect(viewOnlyWorkflowsFor(hr({ leave: "edit", requests: "edit" }))).toEqual([]);
    expect(viewOnlyWorkflowsFor(hr({}, { isSuperAdmin: true }))).toEqual([]);
  });

  it("follows each module on its own: leave decisions need the leave module, permission and outpass the requests module", () => {
    expect(viewOnlyWorkflowsFor(hr({ leave: "edit", requests: "view" }))).toEqual(["permission", "outpass"]);
    expect(viewOnlyWorkflowsFor(hr({ leave: "view", requests: "edit" }))).toEqual(["leave"]);
  });

  it("treats a module the user has no entry for as not editable (fail closed, as the server does)", () => {
    expect(viewOnlyWorkflowsFor(hr({}))).toEqual(["leave", "permission", "outpass"]);
  });

  it("does not apply to the employee portal, which has no modules", () => {
    expect(viewOnlyWorkflowsFor({ role: "employee", employeeId: 1 })).toEqual([]);
    expect(viewOnlyWorkflowsFor(null)).toEqual([]);
  });
});
