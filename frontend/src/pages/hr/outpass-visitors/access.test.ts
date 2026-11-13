import { describe, expect, it } from "vitest";
import { canViewRoute, isRouteViewOnly } from "@/contexts/AuthContext";
import { moduleForPath } from "@/lib/permission-modules";
import { GATE_BASE, GATE_NESTED, GATE_PAGES, GATE_SUBS, gateKey, gatePagePath, gateTabPath } from "./routes";

// Giving the pages tabs in their path must not change who may open them: App.tsx gates a route by the module its path belongs
// to (moduleForPath), so every path under /hr/outpass-visitors has to stay in the `outpass_visitors` module. Since 2026-11-11
// each page and tab has a key of its own under it (outpass_visitors.outpass.overview.passes), which follows the module while
// a role sets nothing on it.

const everyPath = [
  GATE_BASE,
  ...GATE_PAGES.flatMap((page) => [
    gatePagePath(page),
    ...GATE_SUBS[page].flatMap((sub) => [
      gateTabPath(page, sub.value),
      ...(GATE_NESTED[page][sub.value] ?? []).map((n) => gateTabPath(page, sub.value, n.value)),
    ]),
  ]),
  // a stale, mistyped or deeper address is no way around the gate either
  "/hr/outpass-visitors/outpass/nope",
  "/hr/outpass-visitors/outpass/overview/passes/extra",
  "/hr/outpass-visitors/visitors/anything",
  "/hr/outpass-visitors/Tea-Break/Rule",
];

type User = Parameters<typeof canViewRoute>[0];
const hr = (permissions: Record<string, "hidden" | "view" | "edit">): User => ({
  role: "hr",
  employeeId: null,
  permissions,
});

describe("who may open Outpass / Visitors", () => {
  it("keeps every address of the three pages in the outpass_visitors module, and no other", () => {
    for (const path of everyPath) expect(moduleForPath(path) ?? "", path).toMatch(/^outpass_visitors(\.|$)/);
    // the bare address is the module; each page and tab is the key its strip and its landing use (gateKey)
    expect(moduleForPath(GATE_BASE)).toBe("outpass_visitors");
    for (const page of GATE_PAGES) {
      expect(moduleForPath(gatePagePath(page))).toBe(gateKey(page));
      for (const sub of GATE_SUBS[page]) {
        expect(moduleForPath(gateTabPath(page, sub.value))).toBe(gateKey(page, sub.value));
        for (const n of GATE_NESTED[page][sub.value] ?? []) {
          expect(moduleForPath(gateTabPath(page, sub.value, n.value))).toBe(gateKey(page, sub.value, n.value));
        }
      }
    }
    // a look-alike is not Outpass / Visitors
    expect(moduleForPath("/hr/outpass-visitors-archive")).toBeNull();
  });

  it("keeps all of them out of reach of a role without the module, and in reach of one with it", () => {
    const without = hr({ requests: "edit", geo_attendance: "edit", compensation: "edit" });
    const viewer = hr({ outpass_visitors: "view" });
    const editor = hr({ outpass_visitors: "edit" });
    for (const path of everyPath) {
      const key = moduleForPath(path);
      expect(canViewRoute(without, path, key), `${path} without the module`).toBe(false);
      expect(canViewRoute(viewer, path, key), `${path} with view`).toBe(true);
      expect(canViewRoute(editor, path, key), `${path} with edit`).toBe(true);
    }
  });

  it("treats a hidden grant as no grant, and locks a View Only role on every tab", () => {
    const hidden = hr({ outpass_visitors: "hidden" });
    const viewer = hr({ outpass_visitors: "view" });
    for (const path of everyPath) {
      expect(canViewRoute(hidden, path, "outpass_visitors"), path).toBe(false);
      expect(isRouteViewOnly(viewer, path, "outpass_visitors"), path).toBe(true);
    }
  });

  it("lets an administrator open every tab", () => {
    const admin: User = { role: "hr", employeeId: null, isSuperAdmin: true, permissions: {} };
    for (const path of everyPath) expect(canViewRoute(admin, path, "outpass_visitors"), path).toBe(true);
  });
});
