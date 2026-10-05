import { describe, expect, it } from "vitest";
import { MODULE_TREE, allModuleKeys } from "@/lib/permission-modules";
import type { HrUserItem } from "@/lib/api-client/custom-hooks";
import {
  NONE,
  NO_FILTERS,
  clearOverride,
  emptyPermissions,
  filterAccounts,
  filterModules,
  filtersActive,
  initials,
  levelCounts,
  overrideCount,
  permissionsEqual,
  relativeTime,
  roleUsage,
  sectionCounts,
  setAll,
  setLevel,
  setSection,
  sortAccounts,
  summarizeAccounts,
  visibleModuleCount,
} from "./logic";

const user = (over: Partial<HrUserItem> & { username: string }): HrUserItem => ({
  id: Math.abs(over.username.split("").reduce((n, c) => n * 31 + c.charCodeAt(0), 7)) % 100000,
  isActive: true,
  isSuperAdmin: false,
  ...over,
});

const users: HrUserItem[] = [
  user({
    username: "md",
    fullName: "Managing Director",
    roleId: 1,
    roleName: "Director",
    lastLogin: "2026-10-04T10:00:00Z",
  }),
  user({
    username: "hr.asha",
    fullName: "Asha Kumar",
    email: "asha@uktex.net",
    roleId: 2,
    roleName: "HR Executive",
    branchId: 10,
    branchName: "Unit1",
    lastLogin: "2026-09-01T10:00:00Z",
  }),
  user({
    username: "ea.rahul",
    roleId: 2,
    roleName: "HR Executive",
    branchId: 11,
    branchName: "Head Office",
    isActive: false,
  }),
  user({ username: "temp", fullName: "Temp Login" }),
];

describe("the summary above the list", () => {
  it("counts accounts by state, scope and role", () => {
    expect(summarizeAccounts(users)).toEqual({
      total: 4,
      active: 3,
      disabled: 1,
      branchScoped: 2,
      companyWide: 2,
      noRole: 1,
      md: null,
    });
  });

  it("is all zeros for no accounts", () => {
    expect(summarizeAccounts([])).toEqual({
      total: 0,
      active: 0,
      disabled: 0,
      branchScoped: 0,
      companyWide: 0,
      noRole: 0,
      md: null,
    });
  });

  it("does not count an administrator without a role as missing one: administrators have full access", () => {
    const withAdmin = [...users, user({ username: "root", isSuperAdmin: true })];
    expect(summarizeAccounts(withAdmin).noRole).toBe(1); // still just "temp"
    expect(filterAccounts(withAdmin, { ...NO_FILTERS, role: NONE }).map((u) => u.username)).toEqual(["temp"]);
  });

  it("knows who the Managing Director is, and does not count the MD as missing a role: the portal comes from the identity", () => {
    const withMd = [...users, user({ username: "md.sir", fullName: "R. Murugan", isMd: true })];
    const summary = summarizeAccounts(withMd);
    expect(summary.md?.username).toBe("md.sir");
    expect(summary.noRole).toBe(1); // still just "temp"
    expect(filterAccounts(withMd, { ...NO_FILTERS, role: NONE }).map((u) => u.username)).toEqual(["temp"]);
  });

  it("counts how many accounts use each role", () => {
    expect(roleUsage(users)).toEqual({ 1: 1, 2: 2 });
  });
});

describe("searching and filtering accounts", () => {
  const names = (list: HrUserItem[]) => list.map((u) => u.username);

  it("shows everyone with no filter", () => {
    expect(filterAccounts(users, NO_FILTERS)).toHaveLength(4);
    expect(filtersActive(NO_FILTERS)).toBe(false);
  });

  it("searches username, name, email, role and branch, ignoring case", () => {
    expect(names(filterAccounts(users, { ...NO_FILTERS, query: "ASHA" }))).toEqual(["hr.asha"]);
    expect(names(filterAccounts(users, { ...NO_FILTERS, query: "uktex.net" }))).toEqual(["hr.asha"]);
    expect(names(filterAccounts(users, { ...NO_FILTERS, query: "director" }))).toEqual(["md"]);
    expect(names(filterAccounts(users, { ...NO_FILTERS, query: "unit1" }))).toEqual(["hr.asha"]);
  });

  it("needs every word to match, in any order", () => {
    expect(names(filterAccounts(users, { ...NO_FILTERS, query: "kumar hr" }))).toEqual(["hr.asha"]);
    expect(filterAccounts(users, { ...NO_FILTERS, query: "kumar director" })).toHaveLength(0);
  });

  it("finds company-wide accounts by typing 'all branches'", () => {
    expect(names(filterAccounts(users, { ...NO_FILTERS, query: "all branches" }))).toEqual(["md", "temp"]);
  });

  it("filters by status", () => {
    expect(names(filterAccounts(users, { ...NO_FILTERS, status: "disabled" }))).toEqual(["ea.rahul"]);
    expect(filterAccounts(users, { ...NO_FILTERS, status: "active" })).toHaveLength(3);
  });

  it("filters by role, including accounts with none", () => {
    expect(names(filterAccounts(users, { ...NO_FILTERS, role: "2" }))).toEqual(["hr.asha", "ea.rahul"]);
    expect(names(filterAccounts(users, { ...NO_FILTERS, role: NONE }))).toEqual(["temp"]);
  });

  it("filters by branch, including company-wide accounts", () => {
    expect(names(filterAccounts(users, { ...NO_FILTERS, branch: "10" }))).toEqual(["hr.asha"]);
    expect(names(filterAccounts(users, { ...NO_FILTERS, branch: NONE }))).toEqual(["md", "temp"]);
  });

  it("combines the filters", () => {
    expect(names(filterAccounts(users, { query: "hr", status: "active", role: "2", branch: "10" }))).toEqual([
      "hr.asha",
    ]);
    expect(filtersActive({ ...NO_FILTERS, status: "active" })).toBe(true);
    expect(filtersActive({ ...NO_FILTERS, query: "  " })).toBe(false);
  });
});

describe("sorting accounts", () => {
  const order = (list: HrUserItem[]) => list.map((u) => u.username);

  it("sorts by username either way, ignoring case", () => {
    expect(order(sortAccounts(users, "username", "asc"))).toEqual(["ea.rahul", "hr.asha", "md", "temp"]);
    expect(order(sortAccounts(users, "username", "desc"))).toEqual(["temp", "md", "hr.asha", "ea.rahul"]);
  });

  it("puts the active ones first, then by username", () => {
    expect(order(sortAccounts(users, "status", "asc"))).toEqual(["hr.asha", "md", "temp", "ea.rahul"]);
  });

  it("treats never signed in as the oldest sign-in", () => {
    expect(order(sortAccounts(users, "lastLogin", "desc"))).toEqual(["md", "hr.asha", "ea.rahul", "temp"]);
    expect(order(sortAccounts(users, "lastLogin", "asc"))).toEqual(["ea.rahul", "temp", "hr.asha", "md"]);
  });

  it("sorts by role and branch with the empty ones first when ascending, and does not change the list it is given", () => {
    const before = order(users);
    expect(order(sortAccounts(users, "role", "asc"))[0]).toBe("temp");
    expect(order(sortAccounts(users, "branch", "asc"))[0]).toBe("md");
    expect(order(users)).toEqual(before);
  });
});

describe("avatars and times", () => {
  it("takes the first and last word of a name, else the start of the username", () => {
    expect(initials({ username: "md", fullName: "Managing Director" })).toBe("MD");
    expect(initials({ username: "x", fullName: "Anna Maria Lopez" })).toBe("AL");
    expect(initials({ username: "ea.rahul", fullName: "Rahul" })).toBe("RA");
    expect(initials({ username: "ea.rahul", fullName: null })).toBe("EA");
  });

  it("says how long ago, then the date, and Never when there is none", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    expect(relativeTime(null, now)).toBe("Never");
    expect(relativeTime("not a date", now)).toBe("Never");
    expect(relativeTime("2026-10-05T11:59:40Z", now)).toBe("Just now");
    expect(relativeTime("2026-10-05T12:05:00Z", now)).toBe("Just now"); // a clock a little ahead
    expect(relativeTime("2026-10-05T11:15:00Z", now)).toBe("45m ago");
    expect(relativeTime("2026-10-05T07:00:00Z", now)).toBe("5h ago");
    expect(relativeTime("2026-10-02T12:00:00Z", now)).toBe("3d ago");
    expect(relativeTime("2026-09-01T12:00:00Z", now)).toMatch(/01 Sep 2026/);
  });
});

describe("what a role can do", () => {
  const total = allModuleKeys().length;

  it("starts with nothing granted", () => {
    const empty = emptyPermissions();
    expect(Object.keys(empty).sort()).toEqual(MODULE_TREE.map((n) => n.key).sort()); // sections only, submodules inherit
    expect(levelCounts(empty)).toEqual({ edit: 0, view: 0, hidden: total, total });
  });

  it("counts a submodule with no setting of its own as its parent's level", () => {
    const settings = MODULE_TREE.find((n) => n.key === "settings")!;
    const p = setLevel(emptyPermissions(), "settings", "view");
    expect(sectionCounts(p, settings)).toEqual({
      edit: 0,
      view: 1 + settings.children!.length,
      hidden: 0,
      total: 1 + settings.children!.length,
    });
    expect(overrideCount(p, settings)).toBe(0);
    const q = setLevel(p, "settings.payroll", "edit");
    expect(sectionCounts(q, settings).edit).toBe(1);
    expect(sectionCounts(q, settings).view).toBe(settings.children!.length);
    expect(overrideCount(q, settings)).toBe(1);
  });

  it("sets a whole section at once and drops the submodule settings", () => {
    const settings = MODULE_TREE.find((n) => n.key === "settings")!;
    const messy = setLevel(setLevel(emptyPermissions(), "settings", "hidden"), "settings.smtp", "edit");
    const done = setSection(messy, settings, "view");
    expect(done["settings"]).toBe("view");
    expect(done["settings.smtp"]).toBeUndefined();
    expect(messy["settings.smtp"]).toBe("edit"); // the input is never changed
  });

  it("clears one submodule setting so it follows its parent again", () => {
    const p = setLevel(setLevel(emptyPermissions(), "settings", "view"), "settings.smtp", "edit");
    expect(clearOverride(p, "settings.smtp")["settings.smtp"]).toBeUndefined();
    expect(clearOverride(p, "settings.smtp")["settings"]).toBe("view");
  });

  it("sets every module at once but leaves keys it does not know about", () => {
    const p = setAll({ legacy_module: "edit", "settings.smtp": "edit" }, "view");
    expect(levelCounts(p)).toEqual({ edit: 0, view: total, hidden: 0, total });
    expect(p["legacy_module"]).toBe("edit");
    expect(p["settings.smtp"]).toBeUndefined();
  });

  it("compares two sets of permissions, whatever the order of the keys", () => {
    expect(permissionsEqual({ a: "view", b: "edit" }, { b: "edit", a: "view" })).toBe(true);
    expect(permissionsEqual({ a: "view" }, { a: "edit" })).toBe(false);
    expect(permissionsEqual({ a: "view" }, { a: "view", b: "hidden" })).toBe(false);
    expect(permissionsEqual(undefined, {})).toBe(true);
  });
});

describe("searching the modules", () => {
  it("shows everything for a blank search", () => {
    const all = filterModules("  ");
    expect(all).toHaveLength(MODULE_TREE.length);
    expect(visibleModuleCount(all)).toBe(allModuleKeys().length);
  });

  it("keeps all submodules when the section itself matches", () => {
    const hit = filterModules("settings");
    const settings = hit.find((s) => s.node.key === "settings")!;
    expect(settings.matched).toBe(true);
    expect(settings.children).toHaveLength(MODULE_TREE.find((n) => n.key === "settings")!.children!.length);
  });

  it("keeps just the matching submodules, under their section, when only they match", () => {
    const hit = filterModules("smtp");
    expect(hit.map((s) => s.node.key)).toEqual(["settings"]);
    expect(hit[0].matched).toBe(false);
    expect(hit[0].children.map((c) => c.key)).toEqual(["settings.smtp"]);
  });

  it("finds nothing for nonsense", () => {
    expect(filterModules("zzzzzz")).toEqual([]);
    expect(visibleModuleCount(filterModules("zzzzzz"))).toBe(0);
  });
});
