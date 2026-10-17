import { afterEach, describe, expect, it, vi } from "vitest";
import { settingsTabLevel } from "./access";
import { confirmLeaveTab, setUnsavedGuard, UNSAVED_QUESTION } from "./kit/leaveGuard";

// Who sees which Settings tab: a role-permission tab follows the role; Endpoint Sharing is for the super admin alone.

const superAdmin = { role: "hr" as const, employeeId: null, isSuperAdmin: true, permissions: {} };
const fullRole = {
  role: "hr" as const,
  employeeId: null,
  isSuperAdmin: false,
  permissions: { settings: "edit" as const },
};
const employee = { role: "employee" as const, employeeId: 4 };

describe("settingsTabLevel", () => {
  it("shows Endpoint Sharing to the super admin only, however much the role may do", () => {
    expect(settingsTabLevel(superAdmin, "endpoint_sharing")).toBe("edit");
    expect(settingsTabLevel(fullRole, "endpoint_sharing")).toBe("hidden");
    expect(
      settingsTabLevel(
        { ...fullRole, permissions: { settings: "edit", "settings.backup": "edit" } },
        "endpoint_sharing",
      ),
    ).toBe("hidden");
    // a login that is not an HR login, and nobody known yet, never see it either
    expect(settingsTabLevel(employee, "endpoint_sharing")).toBe("hidden");
    expect(settingsTabLevel(null, "endpoint_sharing")).toBe("hidden");
    // "isSuperAdmin" must be exactly true
    expect(settingsTabLevel({ ...superAdmin, isSuperAdmin: undefined }, "endpoint_sharing")).toBe("hidden");
  });

  it("leaves every other tab to the role's permissions", () => {
    expect(settingsTabLevel(superAdmin, "company")).toBe("edit");
    expect(settingsTabLevel(fullRole, "company")).toBe("edit");
    expect(settingsTabLevel({ ...fullRole, permissions: { settings: "hidden" } }, "company")).toBe("hidden");
    expect(
      settingsTabLevel({ ...fullRole, permissions: { settings: "edit", "settings.backup": "view" } }, "backup"),
    ).toBe("view");
  });
});

describe("the leave guard", () => {
  afterEach(() => setUnsavedGuard(null));

  it("lets the tab go when nothing is unsaved, and asks when something is", () => {
    const ask = vi.fn(() => false);
    expect(confirmLeaveTab(ask)).toBe(true);
    setUnsavedGuard(() => false);
    expect(confirmLeaveTab(ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();

    setUnsavedGuard(() => true);
    expect(confirmLeaveTab(ask)).toBe(false);
    expect(ask).toHaveBeenCalledWith(UNSAVED_QUESTION);
    expect(confirmLeaveTab(() => true)).toBe(true);

    setUnsavedGuard(null);
    expect(confirmLeaveTab(ask)).toBe(true);
  });
});
