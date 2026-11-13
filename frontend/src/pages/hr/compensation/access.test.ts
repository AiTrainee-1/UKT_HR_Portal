import { describe, expect, it } from "vitest";
import { canViewRoute, isRouteViewOnly } from "@/contexts/AuthContext";
import { moduleForPath } from "@/lib/permission-modules";
import {
  COMPENSATION_PAGES,
  HISTORY_SUB_VALUES,
  LEAVE_SUBS,
  OT_SUBS,
  historyPath,
  leavePath,
  nestedOf,
  otPath,
  pagePath,
} from "./routes";
import { openDefaultNested, openSubs, openTarget } from "./visible";

// Splitting Compensation into five pages must not change who may open it: App.tsx gates a route by the module its path
// belongs to (moduleForPath), so every path under /hr/compensation has to stay in the one `compensation` module.

const everyPath = [
  "/hr/compensation",
  ...COMPENSATION_PAGES.map((p) => pagePath(p.key)),
  ...OT_SUBS.flatMap((s) => [otPath(s), ...nestedOf("ot", s).map((n) => otPath(s, n.value))]),
  ...LEAVE_SUBS.flatMap((s) => [leavePath(s), ...nestedOf("leave", s).map((n) => leavePath(s, n.value))]),
  ...HISTORY_SUB_VALUES.flatMap((s) => [historyPath(s), ...nestedOf("history", s).map((n) => historyPath(s, n.value))]),
  "/hr/compensation/history/ot-pay?period=week",
];

type User = Parameters<typeof canViewRoute>[0];
const hr = (permissions: Record<string, "hidden" | "view" | "edit">): User => ({
  role: "hr",
  employeeId: null,
  permissions,
});

describe("who may open Compensation", () => {
  it("keeps every address of the five pages in the compensation module, and no other", () => {
    // Since 2026-11-11 each page, subtab and nested subtab has a key of its own UNDER compensation
    // (compensation.ot.type2.waiting, ...); one with no setting follows compensation, so nothing changes for a role.
    for (const path of everyPath) {
      const key = moduleForPath(path.split("?")[0]);
      expect(key === "compensation" || !!key?.startsWith("compensation."), `${path}: ${key}`).toBe(true);
    }
    // a look-alike is not Compensation
    expect(moduleForPath("/hr/compensation-archive")).toBeNull();
  });

  it("keeps all of them out of reach of a role without the module, and in reach of one with it", () => {
    const without = hr({ payroll: "edit", requests: "edit" });
    const viewer = hr({ compensation: "view" });
    const editor = hr({ compensation: "edit" });
    for (const path of everyPath) {
      const route = path.split("?")[0];
      const key = moduleForPath(route);
      expect(canViewRoute(without, route, key), `${route} without the module`).toBe(false);
      expect(canViewRoute(viewer, route, key), `${route} with view`).toBe(true);
      expect(canViewRoute(editor, route, key), `${route} with edit`).toBe(true);
    }
  });

  it("treats a hidden grant as no grant, and locks a View Only role on every page", () => {
    const hidden = hr({ compensation: "hidden" });
    const viewer = hr({ compensation: "view" });
    for (const path of everyPath) {
      expect(canViewRoute(hidden, path, "compensation"), path).toBe(false);
      expect(isRouteViewOnly(viewer, path, "compensation"), path).toBe(true);
    }
  });

  it("lets an administrator open every page", () => {
    const admin: User = { role: "hr", employeeId: null, isSuperAdmin: true, permissions: {} };
    for (const path of everyPath) expect(canViewRoute(admin, path, "compensation"), path).toBe(true);
  });
});

describe("the parts of Compensation a role may open (visible.ts)", () => {
  const canOpenFor =
    (permissions: Record<string, "hidden" | "view" | "edit">) =>
    (path: string): boolean =>
      canViewRoute(hr(permissions), path, moduleForPath(path));

  it("offers every part to a role that set nothing below compensation", () => {
    const canOpen = canOpenFor({ compensation: "view" });
    expect(openSubs(canOpen, "ot", OT_SUBS)).toEqual([...OT_SUBS]);
    expect(openDefaultNested(canOpen, "ot", "type-2")).toBe("waiting");
    expect(openTarget(canOpen, "/hr/compensation/ot-detection/type-2/assigned?otstatus=pay")).toBe(
      "/hr/compensation/ot-detection/type-2/assigned?otstatus=pay",
    );
  });

  it("leaves out a hidden subtab or section and lands on the next one the role may open", () => {
    const canOpen = canOpenFor({
      compensation: "edit",
      "compensation.ctc": "hidden",
      "compensation.ot.type1": "hidden",
      "compensation.ot.type2.waiting": "hidden",
    });
    expect(openSubs(canOpen, "ot", OT_SUBS)).toEqual(["type-2", "earlier"]);
    expect(openDefaultNested(canOpen, "ot", "type-2")).toBe("assigned");
    // a hidden section falls back to its subtab (which then opens its first open section), a hidden page to the next page
    expect(openTarget(canOpen, "/hr/compensation/ot-detection/type-2/waiting?month=9")).toBe(
      "/hr/compensation/ot-detection/type-2?month=9",
    );
    expect(openTarget(canOpen, "/hr/compensation/ctc-breakdown")).toBe("/hr/compensation/ot-detection");
  });

  it("keeps a subtab whose own key is hidden while one of its sections is open", () => {
    const canOpen = canOpenFor({
      compensation: "edit",
      "compensation.ot.type2": "hidden",
      "compensation.ot.type2.assigned": "view",
    });
    expect(openSubs(canOpen, "ot", OT_SUBS)).toEqual(["type-1", "type-2", "earlier"]);
    expect(openDefaultNested(canOpen, "ot", "type-2")).toBe("assigned");
  });
});
