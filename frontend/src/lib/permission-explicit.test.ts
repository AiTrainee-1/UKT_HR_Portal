import { describe, expect, it } from "vitest";
import { permissionLevel } from "@/contexts/AuthContext";
import type { PermissionLevel } from "@/lib/api-client/custom-hooks";
import { displayNodes, REQUIRE_EXPLICIT, resolvePermission, resolveSource } from "@/lib/permission-modules";
import { accountSet } from "@/pages/hr/account-management/AccountAccessEditor";
import { applyLevel, followText, setAll, setSection } from "@/pages/hr/account-management/logic";

// The gate and desk password reveals are off unless a role sets them itself (2026-11-19): they never follow their page,
// so a section given Edit (or the Managing Director's section grant) never shows anyone a password.

const GATE_PW = "outpass_visitors.outpass.gate_devices.view_password";
const DESK_PW = "outpass_visitors.visitors.reception_devices.view_password";
const node = (key: string) => displayNodes().find((d) => d.node.key === key)!.node;
type Perms = Record<string, PermissionLevel>;
const hr = (permissions: Perms, extra: object = {}) =>
  ({ role: "hr" as const, employeeId: null, permissions, ...extra }) as Parameters<typeof permissionLevel>[0];

describe("explicit-only keys (the password reveals)", () => {
  it("are the two password keys, marked in the tree", () => {
    expect([...REQUIRE_EXPLICIT].sort()).toEqual([GATE_PW, DESK_PW]);
    expect(node(GATE_PW).explicit).toBe(true);
  });

  it("are Hidden while unset, whatever the page, section or device feature says", () => {
    for (const perms of [
      { outpass_visitors: "edit" },
      { "outpass_visitors.outpass": "edit", "outpass_visitors.outpass.gate_devices": "edit" },
      { "outpass_visitors.visitors.reception_devices": "edit" },
    ] as Perms[]) {
      expect(resolvePermission(perms, GATE_PW)).toBe("hidden");
      expect(resolvePermission(perms, DESK_PW)).toBe("hidden");
      expect(resolveSource(perms, GATE_PW)).toBeNull();
    }
    // a key that is not explicit still follows its page
    expect(resolvePermission({ outpass_visitors: "edit" }, "outpass_visitors.outpass.gate_devices")).toBe("edit");
  });

  it("take their own setting when a role sets them", () => {
    expect(resolvePermission({ outpass_visitors: "edit", [GATE_PW]: "edit" }, GATE_PW)).toBe("edit");
    expect(resolvePermission({ [DESK_PW]: "view" }, DESK_PW)).toBe("view");
  });

  it("drive the View button's level: hidden for an editor of the page, edit when set, edit for a Super Admin", () => {
    expect(permissionLevel(hr({ outpass_visitors: "edit" }), GATE_PW)).toBe("hidden");
    expect(permissionLevel(hr({ outpass_visitors: "edit", [GATE_PW]: "edit" }), GATE_PW)).toBe("edit");
    expect(permissionLevel(hr({}, { isSuperAdmin: true }), GATE_PW)).toBe("edit");
    // the MD's grant is a section grant ("outpass_visitors": "edit" in /auth/me): it does not include them
    expect(permissionLevel(hr({ outpass_visitors: "edit" }, { isMd: true }), DESK_PW)).toBe("hidden");
  });
});

describe("the role editor and explicit-only keys", () => {
  const section = node("outpass_visitors");

  it("a section set to Edit or View never turns a password reveal on", () => {
    for (const level of ["edit", "view"] as PermissionLevel[]) {
      const viaControl = applyLevel({}, section, level);
      expect(GATE_PW in viaControl).toBe(false);
      expect(resolvePermission(viaControl, GATE_PW)).toBe("hidden");
      const viaReset = setSection({}, section, level);
      expect(resolvePermission(viaReset, DESK_PW)).toBe("hidden");
      expect(resolvePermission(setAll({}, level), GATE_PW)).toBe("hidden");
    }
  });

  it("keeps a reveal set on its own row when the section is reset, and hides it with a Hidden section", () => {
    const perms: Perms = { outpass_visitors: "edit", [GATE_PW]: "edit" };
    expect(setSection(perms, section, "view")[GATE_PW]).toBe("edit");
    expect(resolvePermission(setSection(perms, section, "hidden"), GATE_PW)).toBe("hidden");
  });

  it("says where an unset reveal stands", () => {
    expect(followText({ outpass_visitors: "edit" }, node(GATE_PW))).toBe("off unless set here");
    expect(followText({ outpass_visitors: "edit" }, node("outpass_visitors.outpass.gate_devices"))).toBe(
      "follows Outpass / Visitors",
    );
  });

  it("an account's own section change never turns a reveal on either", () => {
    const changes = accountSet({ outpass_visitors: "view" }, {}, section, "edit");
    expect(GATE_PW in changes).toBe(false);
    expect(DESK_PW in changes).toBe(false);
  });
});
