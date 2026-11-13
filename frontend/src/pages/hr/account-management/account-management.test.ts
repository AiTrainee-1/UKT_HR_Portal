import { describe, expect, it } from "vitest";
import { PERMISSION_GROUPS, allModuleKeys, displayNodes, resolvePermission } from "@/lib/permission-modules";
import type { HrUserItem, Role } from "@/lib/api-client/custom-hooks";
import {
  NONE,
  NO_FILTERS,
  accountsOf,
  applyLevel,
  clearOverride,
  commonLevel,
  countsText,
  defaultRoleFor,
  displayCategoryOf,
  emptyPermissions,
  filterAccounts,
  filterTree,
  filtersActive,
  foldableKeys,
  followText,
  groupCounts,
  initials,
  levelCounts,
  matchedCount,
  overrideCount,
  partsOf,
  permissionsEqual,
  relativeTime,
  roleUsage,
  rolesFor,
  sectionCounts,
  setAll,
  setGroup,
  setLevel,
  setSection,
  sortAccounts,
  summarizeAccounts,
  typeWord,
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
  const node = (key: string) => displayNodes().find((d) => d.node.key === key)!.node;

  it("starts with nothing granted, with as few settings as possible", () => {
    const empty = emptyPermissions();
    // the pages at the top of each heading, plus the parts that follow another key (Salary, ID Card settings ...)
    expect(Object.keys(empty)).toContain("dashboard");
    expect(Object.keys(empty)).not.toContain("payroll.issues"); // it follows Staff Payroll
    expect(resolvePermission(empty, "settings.idcard")).toBe("hidden"); // it follows the ID Cards page, also Hidden
    expect(levelCounts(empty)).toEqual({ edit: 0, view: 0, hidden: total, total });
  });

  it("counts a part with no setting of its own as the level it follows", () => {
    const settings = node("settings");
    const parts = partsOf(settings).length;
    const p = setSection(emptyPermissions(), settings, "view");
    expect(sectionCounts(p, settings)).toEqual({ edit: 0, view: 1 + parts, hidden: 0, total: 1 + parts });
    expect(overrideCount(p, settings)).toBe(0);
    const q = setLevel(p, "settings.smtp", "edit");
    expect(sectionCounts(q, settings).edit).toBe(1);
    expect(sectionCounts(q, settings).view).toBe(parts);
    expect(overrideCount(q, settings)).toBe(1);
  });

  it("a page's control takes its tabs and its own-setting tabs with it, but keeps a tab set on its own", () => {
    const payroll = node("payroll");
    const p = setLevel(emptyPermissions(), "payroll.issues", "view");
    const done = applyLevel(p, payroll, "edit");
    expect(resolvePermission(done, "payroll.records")).toBe("edit"); // follows
    expect(done["salary"]).toBe("edit"); // its own setting, shown under Staff Payroll: given the level too
    expect(done["payroll.issues"]).toBe("view"); // custom: kept
    expect(p["payroll"]).toBe("hidden"); // the input is never changed
  });

  it("sets a whole branch at once and drops the parts' own settings", () => {
    const settings = node("settings");
    const messy = setLevel(setLevel(emptyPermissions(), "settings", "hidden"), "settings.smtp", "edit");
    const done = setSection(messy, settings, "view");
    expect(done["settings"]).toBe("view");
    expect(done["settings.smtp"]).toBeUndefined();
    expect(done["settings.idcard"]).toBe("view"); // follows the ID Cards page unless set: set to match
    expect(messy["settings.smtp"]).toBe("edit");
  });

  it("sets everything under one sidebar heading", () => {
    const payroll = PERMISSION_GROUPS.find((g) => g.id === "payroll")!;
    const p = setGroup(emptyPermissions(), payroll, "view");
    const c = groupCounts(p, payroll);
    expect(c.view).toBe(c.total);
    expect(commonLevel(c)).toBe("view");
    expect(resolvePermission(p, "dashboard")).toBe("hidden");
  });

  it("clears one part's setting so it follows again", () => {
    const p = setLevel(setLevel(emptyPermissions(), "settings", "view"), "settings.smtp", "edit");
    expect(clearOverride(p, "settings.smtp")["settings.smtp"]).toBeUndefined();
    expect(clearOverride(p, "settings.smtp")["settings"]).toBe("view");
  });

  it("sets everything at once but leaves keys it does not know about", () => {
    const p = setAll({ legacy_module: "edit", "settings.smtp": "edit" }, "view");
    expect(levelCounts(p)).toEqual({ edit: 0, view: total, hidden: 0, total });
    expect(p["legacy_module"]).toBe("edit");
    expect(p["settings.smtp"]).toBeUndefined();
  });

  it("says where an unset key takes its level from", () => {
    const p = { attendance: "edit" } as const;
    expect(followText({ ...p }, node("biometric_connectors"))).toBe("follows Attendance");
    expect(followText({ ...p }, node("payroll.issues"))).toBe("nothing set");
    expect(followText({ payroll: "view" }, node("payroll.issues"))).toBe("follows Staff Payroll");
  });

  it("compares two sets of permissions, whatever the order of the keys", () => {
    expect(permissionsEqual({ a: "view", b: "edit" }, { b: "edit", a: "view" })).toBe(true);
    expect(permissionsEqual({ a: "view" }, { a: "edit" })).toBe(false);
    expect(permissionsEqual({ a: "view" }, { a: "view", b: "hidden" })).toBe(false);
    expect(permissionsEqual(undefined, {})).toBe(true);
  });
});

describe("searching the tree", () => {
  it("shows everything for a blank search", () => {
    const all = filterTree("  ");
    expect(all.map((g) => g.group.id)).toEqual(PERMISSION_GROUPS.map((g) => g.id));
    expect(visibleModuleCount(all)).toBe(displayNodes().length);
  });

  it("keeps all the parts when a page itself matches", () => {
    const hit = filterTree("staff payroll");
    const payroll = hit.flatMap((g) => g.items).find((i) => i.node.key === "payroll")!;
    expect(payroll.matched).toBe(true);
    expect(payroll.children.map((c) => c.node.key)).toContain("payroll.issues");
  });

  it("finds a tab deep down and keeps the path to it", () => {
    const hit = filterTree("smtp");
    expect(hit.map((g) => g.group.id)).toEqual(["administration"]);
    const settings = hit[0].items.find((i) => i.node.key === "settings")!;
    expect(settings.matched).toBe(false);
    expect(settings.children.map((c) => c.node.key)).toEqual(["settings.smtp"]);
    expect(matchedCount(hit, "smtp")).toBe(1);
    // a sub-tab three levels down
    const deep = filterTree("waiting for hr");
    expect(visibleModuleCount(deep)).toBe(4); // Compensation > OT Detection > Type 2 > Waiting for HR
  });

  it("finds nothing for nonsense", () => {
    expect(filterTree("zzzzzz")).toEqual([]);
    expect(visibleModuleCount(filterTree("zzzzzz"))).toBe(0);
  });

  it("lists the nodes Expand all opens", () => {
    expect(foldableKeys()).toContain("payroll");
    expect(foldableKeys()).toContain("compensation.ot.type2");
    expect(foldableKeys()).not.toContain("payroll.issues");
  });

  it("describes a mixed set in words", () => {
    expect(countsText({ edit: 3, view: 2, hidden: 1, total: 6 })).toBe("3 of 6 edit · 2 view");
    expect(countsText({ edit: 6, view: 0, hidden: 0, total: 6 })).toBe("all 6 edit");
    expect(typeWord("subtab")).toBe("Sub-tab");
  });
});

describe("HR Manager / HR Assistant categories", () => {
  const people: HrUserItem[] = [
    user({ username: "root", isSuperAdmin: true, category: "admin" }),
    user({ username: "md", isMd: true, category: "admin" }),
    user({ username: "clerk", category: "admin" }),
    user({ username: "old" }), // an older backend: no category at all
    user({ username: "mgr", category: "hr_manager", fullName: "Meena" }),
    user({ username: "asst", category: "hr_assistant", displayCategory: "hr_assistant" }),
  ];
  const role = (id: number, category: Role["category"]): Role => ({
    id,
    name: `r${id}`,
    permissions: {},
    isSystem: false,
    category,
  });

  it("names every account's category, the Super Admin and the MD apart", () => {
    expect(people.map(displayCategoryOf)).toEqual([
      "super_admin",
      "md",
      "admin",
      "admin",
      "hr_manager",
      "hr_assistant",
    ]);
    expect(accountsOf(people, "hr_manager").map((u) => u.username)).toEqual(["mgr"]);
  });

  it("filters the Accounts tab by category, and a search finds the category's name", () => {
    expect(filterAccounts(people, { ...NO_FILTERS, category: "hr_assistant" }).map((u) => u.username)).toEqual([
      "asst",
    ]);
    expect(filterAccounts(people, { ...NO_FILTERS, query: "hr manager" }).map((u) => u.username)).toEqual(["mgr"]);
    expect(filtersActive({ ...NO_FILTERS, category: "md" })).toBe(true);
    expect(filtersActive({ ...NO_FILTERS, category: undefined })).toBe(false);
  });

  it("offers each category the roles made for it first, then the ones for any account", () => {
    const roles = [role(1, ""), role(2, "hr_assistant"), role(3, "hr_manager"), role(4, undefined)];
    expect(rolesFor(roles, "hr_assistant").map((r) => r.id)).toEqual([2, 1, 4]);
    expect(rolesFor(roles, "hr_manager").map((r) => r.id)).toEqual([3, 1, 4]);
    expect(defaultRoleFor(roles, "hr_manager")?.id).toBe(3);
    expect(defaultRoleFor(roles, "admin")).toBeUndefined();
  });
});
