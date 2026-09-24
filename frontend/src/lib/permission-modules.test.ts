import { describe, expect, it } from "vitest";
import {
  MODULE_LABELS,
  MODULE_TREE,
  ROUTE_MODULE_MAP,
  allModuleKeys,
  moduleForPath,
  resolvePermission,
  resolvePermissionOrChildren,
} from "./permission-modules";

describe("resolvePermission", () => {
  it("fails closed when there are no permissions or no entry", () => {
    expect(resolvePermission(undefined, "payroll")).toBe("hidden");
    expect(resolvePermission({}, "payroll")).toBe("hidden");
  });

  it("returns an explicit entry", () => {
    expect(resolvePermission({ payroll: "edit" }, "payroll")).toBe("edit");
    expect(resolvePermission({ payroll: "view" }, "payroll")).toBe("view");
  });

  it("lets a submodule inherit its parent level", () => {
    expect(resolvePermission({ employees: "view" }, "employees.departments")).toBe("view");
  });

  it("prefers the most specific entry over the parent", () => {
    const perms = { employees: "edit", "employees.departments": "hidden" } as const;
    expect(resolvePermission({ ...perms }, "employees.departments")).toBe("hidden");
    expect(resolvePermission({ ...perms }, "employees.designations")).toBe("edit");
  });

  it("does not let a child grant leak upward to its parent", () => {
    expect(resolvePermission({ "settings.payroll": "edit" }, "settings")).toBe("hidden");
  });
});

describe("resolvePermissionOrChildren", () => {
  it("keeps a single-route parent reachable when only a child is granted", () => {
    expect(resolvePermissionOrChildren({ "settings.payroll": "edit" }, "settings")).toBe("edit");
  });

  it("uses the parent own level when it has one", () => {
    expect(resolvePermissionOrChildren({ settings: "view", "settings.payroll": "edit" }, "settings")).toBe("view");
  });

  it("is hidden when neither the parent nor any child is granted", () => {
    expect(resolvePermissionOrChildren({ payroll: "edit" }, "settings")).toBe("hidden");
  });

  it("behaves like resolvePermission for a key without children", () => {
    expect(resolvePermissionOrChildren({ payroll: "view" }, "payroll")).toBe("view");
    expect(resolvePermissionOrChildren({}, "payroll")).toBe("hidden");
  });
});

describe("module tree", () => {
  it("has no duplicate keys", () => {
    const keys = allModuleKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("lists every parent and child in allModuleKeys and MODULE_LABELS", () => {
    const expected = MODULE_TREE.flatMap((n) => [n.key, ...(n.children ?? []).map((c) => c.key)]);
    expect(allModuleKeys()).toEqual(expected);
    expect(MODULE_LABELS.map((m) => m.key)).toEqual(expected);
  });

  it("namespaces every child under its parent", () => {
    for (const node of MODULE_TREE) {
      for (const child of node.children ?? []) expect(child.key.startsWith(`${node.key}.`)).toBe(true);
    }
  });

  it("maps every route to a real module (activity_logs is admin-only and absent from the tree)", () => {
    const known = new Set(allModuleKeys());
    for (const [route, key] of Object.entries(ROUTE_MODULE_MAP)) {
      if (key === "activity_logs") continue;
      expect(known.has(key), `${route} -> ${key}`).toBe(true);
    }
  });
});

describe("moduleForPath", () => {
  it("matches a route exactly and by nested path", () => {
    expect(moduleForPath("/hr/payroll")).toBe("payroll");
    expect(moduleForPath("/hr/payroll/123/breakdown")).toBe("payroll");
  });

  it("picks the longest matching prefix", () => {
    expect(moduleForPath("/hr/recruitment/resignations")).toBe("recruitment.resignations");
    expect(moduleForPath("/hr/recruitment")).toBe("recruitment");
    expect(moduleForPath("/hr/departments")).toBe("employees.departments");
  });

  it("does not match a route that merely shares a string prefix", () => {
    expect(moduleForPath("/hr/payroll-extra")).toBeNull();
    expect(moduleForPath("/hr/salary-slip")).toBe("salary_slip");
  });

  it("returns null outside the HR portal", () => {
    expect(moduleForPath("/login")).toBeNull();
    expect(moduleForPath("/")).toBeNull();
  });
});
