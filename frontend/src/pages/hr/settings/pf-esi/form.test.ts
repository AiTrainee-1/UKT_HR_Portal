import { describe, expect, it } from "vitest";
import type { PfEsiRule, PfEsiSettings } from "@/lib/api-client/custom-hooks";
import {
  changedLists,
  changeLines,
  checkList,
  describeRow,
  draftFrom,
  LIST_KEYS,
  newRow,
  previewRules,
  problemClasses,
  rangeWords,
  readAmount,
  readRate,
  sameDraft,
  sameRow,
  toInput,
  validateDraft,
  withServerProblem,
  type RuleRow,
} from "./form";

const rule = (over: Partial<PfEsiRule> = {}): PfEsiRule => ({
  id: "a1",
  label: "PF below 25,000",
  basis: "basic",
  minAmount: 0,
  maxAmount: 25_000,
  ratePercent: 12,
  ...over,
});

const settings = (over: Partial<PfEsiSettings> = {}): PfEsiSettings => ({
  scope: { branchId: null, branchName: null, isOverride: false },
  canEdit: true,
  version: "v1",
  staff: {
    pfRules: [rule(), rule({ id: "a2", label: "Over 25,000", minAmount: 25_000.01, maxAmount: 0, ratePercent: 0 })],
    esiRules: [],
  },
  production: {
    pfRules: [],
    esiRules: [rule({ id: "b1", label: "ESI below 30,000", maxAmount: 30_000, ratePercent: 0.75 })],
  },
  branches: [],
  basisOptions: [],
  ...over,
});

const row = (over: Partial<RuleRow> = {}): RuleRow => ({
  key: "k",
  id: "",
  label: "",
  basis: "basic",
  minAmount: "0",
  maxAmount: "0",
  ratePercent: "12",
  ...over,
});

describe("the form from the saved rules", () => {
  it("holds every number as text, keeps the rule ids, and has one list for each of the four", () => {
    const draft = draftFrom(settings());
    expect(Object.keys(draft)).toEqual(LIST_KEYS);
    expect(draft["staff.pfRules"][0]).toMatchObject({
      id: "a1",
      label: "PF below 25,000",
      basis: "basic",
      minAmount: "0",
      maxAmount: "25000",
      ratePercent: "12",
    });
    expect(draft["staff.pfRules"][1].minAmount).toBe("25000.01");
    expect(draft["production.esiRules"][0].ratePercent).toBe("0.75");
    expect(draft["production.pfRules"]).toEqual([]);
  });

  it("sees no change in a number typed another way, and a change in anything else", () => {
    const saved = draftFrom(settings());
    const same = draftFrom(settings());
    same["staff.pfRules"][0] = { ...same["staff.pfRules"][0], ratePercent: "12.00", maxAmount: "25000.0" };
    expect(sameDraft(same, saved)).toBe(true);
    expect(changedLists(same, saved)).toEqual([]);

    const renamed = draftFrom(settings());
    renamed["staff.pfRules"][0] = { ...renamed["staff.pfRules"][0], label: "Renamed" };
    expect(changedLists(renamed, saved)).toEqual(["staff.pfRules"]);

    const added = draftFrom(settings());
    added["production.pfRules"] = [row({ key: "n1" })];
    expect(changedLists(added, saved)).toEqual(["production.pfRules"]);
    expect(sameRow(row({ id: "x" }), row({ id: "y" }))).toBe(false);
    // a blank From or To is 0, as the server reads it
    expect(sameRow(row({ minAmount: "" }), row({ minAmount: "0" }))).toBe(true);
  });
});

describe("reading the boxes", () => {
  it("reads an amount: blank is 0, at most two decimals, within the limit", () => {
    expect(readAmount("")).toEqual({ value: 0, error: null });
    expect(readAmount(" 25000.5 ")).toEqual({ value: 25_000.5, error: null });
    expect(readAmount("25000.555").error).toBe("Use at most 2 decimals.");
    expect(readAmount("-1").error).toBe("Must be 0 or more.");
    expect(readAmount("abc").error).toContain("Enter a number");
    expect(readAmount("100000000").error).toContain("Must be from 0 to");
  });

  it("reads a percentage: required, 0 to 100, at most two decimals", () => {
    expect(readRate("")).toEqual({ value: null, error: "Enter the percentage." });
    expect(readRate("0.75").value).toBe(0.75);
    expect(readRate("100").value).toBe(100);
    expect(readRate("100.01").error).toBe("Must be from 0 to 100.");
    expect(readRate("12.345").error).toBe("Use at most 2 decimals.");
  });

  it("says a range in words", () => {
    expect(rangeWords(0, 25_000)).toBe("up to ₹25,000");
    expect(rangeWords(25_000, 0)).toBe("₹25,000 and above");
    expect(rangeWords(20_000, 30_000)).toBe("₹20,000 to ₹30,000");
    expect(rangeWords(0, 0)).toBe("any amount");
    expect(describeRow(row({ label: "PF below 25,000", maxAmount: "25000" }))).toBe(
      '"PF below 25,000": Basic salary up to ₹25,000 → 12%',
    );
  });
});

describe("checks that mirror the server's", () => {
  it("accepts good lists, including an empty one", () => {
    expect(validateDraft(draftFrom(settings())).ok).toBe(true);
    expect(validateDraft(draftFrom(settings())).first).toBeNull();
    expect(checkList([], "staff.pfRules")).toEqual({ rows: [], list: null });
  });

  it("checks every box of a row and names the list and the rule in the first problem", () => {
    const draft = draftFrom(settings());
    draft["staff.pfRules"] = [
      row({ label: "x".repeat(81), minAmount: "5", maxAmount: "1", ratePercent: "101" }),
      row({ key: "k2", label: "Second", minAmount: "-3", ratePercent: "" }),
      row({ key: "k3", minAmount: "1.234", maxAmount: "abc", ratePercent: "1.234" }),
    ];
    const v = validateDraft(draft);
    expect(v.ok).toBe(false);
    expect(v.lists["staff.pfRules"].rows[0]).toEqual({
      label: "Keep the name to 80 characters.",
      maxAmount: "Must be 0 (no upper limit) or at least the From amount.",
      ratePercent: "Must be from 0 to 100.",
    });
    expect(v.lists["staff.pfRules"].rows[1]).toMatchObject({
      minAmount: "Must be 0 or more.",
      ratePercent: "Enter the percentage.",
    });
    expect(v.lists["staff.pfRules"].rows[2]).toMatchObject({
      minAmount: "Use at most 2 decimals.",
      ratePercent: "Use at most 2 decimals.",
    });
    expect(v.first).toBe(`Staff PF rule 1 ("${"x".repeat(81)}"): Keep the name to 80 characters.`);
    expect(v.problems).toEqual(["staff.pfRules"]);
    expect(problemClasses(v)).toEqual(["staff"]);
  });

  it("refuses ranges of the same basis that overlap, on the later rule's From box, naming the other rule", () => {
    const rows = [
      row({ key: "1", label: "A", minAmount: "0", maxAmount: "25000" }),
      row({ key: "2", label: "B", minAmount: "20000", maxAmount: "30000" }),
    ];
    const check = checkList(rows, "staff.pfRules");
    expect(check.rows[0]).toEqual({});
    expect(check.rows[1].minAmount).toBe(
      'Overlaps rule 1 ("A"): it covers up to ₹25,000 and this rule covers ₹20,000 to ₹30,000. Ranges in one list must not overlap.',
    );
  });

  it("counts both ends as inside: a range that starts where another ends overlaps, one paisa above does not", () => {
    const touching = [row({ key: "1", maxAmount: "25000" }), row({ key: "2", minAmount: "25000", maxAmount: "0" })];
    expect(checkList(touching, "staff.pfRules").rows[1].minAmount).toContain("Overlaps rule 1");
    const apart = [row({ key: "1", maxAmount: "25000" }), row({ key: "2", minAmount: "25000.01", maxAmount: "0" })];
    expect(checkList(apart, "staff.pfRules").rows).toEqual([{}, {}]);
  });

  it("treats a Maximum of 0 as no upper limit when looking for overlaps, in either order", () => {
    const open = [
      row({ key: "1", minAmount: "10000", maxAmount: "0" }),
      row({ key: "2", minAmount: "50000", maxAmount: "60000" }),
    ];
    expect(checkList(open, "staff.pfRules").rows[1].minAmount).toContain("Overlaps rule 1");
    const reversed = [
      row({ key: "1", minAmount: "50000", maxAmount: "60000" }),
      row({ key: "2", minAmount: "10000", maxAmount: "0" }),
    ];
    expect(checkList(reversed, "staff.pfRules").rows[1].minAmount).toContain("Overlaps rule 1");
  });

  it("only compares rules that measure the same thing", () => {
    const rows = [
      row({ key: "1", basis: "basic", maxAmount: "25000" }),
      row({ key: "2", basis: "total", maxAmount: "25000" }),
      row({ key: "3", basis: "first_portion", maxAmount: "25000" }),
    ];
    expect(checkList(rows, "staff.pfRules").rows).toEqual([{}, {}, {}]);
  });

  it("limits a list to the server's number of rules, and leaves the other lists alone", () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      row({ key: `r${i}`, minAmount: String(i * 10), maxAmount: String(i * 10 + 5) }),
    );
    expect(checkList(rows, "staff.pfRules", 3).list).toBe("Staff PF can have at most 3 rules.");
    expect(checkList(rows, "staff.pfRules", 4).list).toBeNull();
  });

  it("does not report an overlap for a rule whose own boxes are already wrong", () => {
    const rows = [row({ key: "1", maxAmount: "25000" }), row({ key: "2", minAmount: "abc", maxAmount: "30000" })];
    const check = checkList(rows, "staff.pfRules");
    expect(check.rows[1].minAmount).toContain("Enter a number");
  });
});

describe("the server's answer shown where it belongs", () => {
  const draft = draftFrom(settings());
  const base = validateDraft(draft);

  it("puts a message about one box on that rule's box, and keeps the form from being saved", () => {
    const shown = withServerProblem(base, {
      message:
        'Staff PF rule 2 ("Over 25,000"): Maximum amount must be 0 (no upper limit) or at least the minimum amount.',
      list: "staff.pfRules",
      ruleIndex: 1,
      field: "maxAmount",
      otherRuleIndex: null,
    });
    expect(shown.lists["staff.pfRules"].rows[1].maxAmount).toContain("Maximum amount must be 0");
    expect(shown.lists["staff.pfRules"].rows[0]).toEqual({});
    expect(shown.ok).toBe(false);
    expect(shown.problems).toEqual(["staff.pfRules"]);
    expect(base.ok).toBe(true);
  });

  it("puts a message about a whole rule on the rule, and one about no rule on the list", () => {
    const onRow = withServerProblem(base, {
      message: "another rule in this list has the same id.",
      list: "production.esiRules",
      ruleIndex: 0,
      field: "id",
      otherRuleIndex: null,
    });
    expect(onRow.lists["production.esiRules"].rows[0].row).toBe("another rule in this list has the same id.");
    const onList = withServerProblem(base, {
      message: "Staff ESI rules must be a list.",
      list: "staff.esiRules",
      ruleIndex: null,
      field: "list",
      otherRuleIndex: null,
    });
    expect(onList.lists["staff.esiRules"].list).toBe("Staff ESI rules must be a list.");
  });

  it("keeps a message that names no list as the first problem", () => {
    const shown = withServerProblem(base, {
      message: "Something else went wrong.",
      list: null,
      ruleIndex: null,
      field: null,
      otherRuleIndex: null,
    });
    expect(shown.first).toBe("Something else went wrong.");
    expect(shown.ok).toBe(false);
  });
});

describe("what a save sends", () => {
  const saved = draftFrom(settings());

  it("sends only the lists that changed, each as the whole list, with the version the form started from", () => {
    const draft = draftFrom(settings());
    draft["staff.pfRules"] = [
      ...draft["staff.pfRules"],
      row({ key: "n1", label: "  Extra  ", minAmount: "", maxAmount: "40000.5", ratePercent: " 8 " }),
    ];
    const body = toInput(draft, saved, { branchId: null, expectedVersion: "v1" });
    expect(Object.keys(body).sort()).toEqual(["branchId", "expectedVersion", "staff"]);
    expect(body.staff).toEqual({
      pfRules: [
        { id: "a1", label: "PF below 25,000", basis: "basic", minAmount: 0, maxAmount: 25_000, ratePercent: 12 },
        { id: "a2", label: "Over 25,000", basis: "basic", minAmount: 25_000.01, maxAmount: 0, ratePercent: 0 },
        { label: "Extra", basis: "basic", minAmount: 0, maxAmount: 40_000.5, ratePercent: 8 },
      ],
    });
    expect(body.production).toBeUndefined();
    expect(body.expectedVersion).toBe("v1");
    expect(body.branchId).toBeNull();
  });

  it("sends a list that was emptied (deleting every rule is a change), and names the branch", () => {
    const draft = draftFrom(settings());
    draft["production.esiRules"] = [];
    const body = toInput(draft, saved, { branchId: 3, expectedVersion: "v9" });
    expect(body).toEqual({ branchId: 3, expectedVersion: "v9", production: { esiRules: [] } });
  });

  it("sends nothing but the version when nothing changed", () => {
    expect(toInput(draftFrom(settings()), saved, { branchId: null, expectedVersion: "v1" })).toEqual({
      branchId: null,
      expectedVersion: "v1",
    });
  });
});

describe("what a save changes, in words", () => {
  const saved = draftFrom(settings());

  it("lists each rule added, edited and removed, and a change of order", () => {
    const draft = draftFrom(settings());
    draft["staff.pfRules"] = [
      { ...draft["staff.pfRules"][0], ratePercent: "10" },
      row({ key: "n1", label: "New", minAmount: "30000", maxAmount: "40000", ratePercent: "5" }),
    ];
    draft["production.esiRules"] = [];
    const lines = changeLines(draft, saved);
    expect(lines.map((l) => [l.label, l.from, l.to])).toEqual([
      [
        "Staff PF rule 1",
        '"PF below 25,000": Basic salary up to ₹25,000 → 12%',
        '"PF below 25,000": Basic salary up to ₹25,000 → 10%',
      ],
      ["Staff PF rule 2", "(new rule)", '"New": Basic salary ₹30,000 to ₹40,000 → 5%'],
      ["Staff PF rule removed", '"Over 25,000": Basic salary ₹25,000.01 and above → 0%', "(removed)"],
      ["Production ESI rule removed", '"ESI below 30,000": Basic salary up to ₹30,000 → 0.75%', "(removed)"],
    ]);
    expect(lines.every((l) => l.money)).toBe(true);
    expect(new Set(lines.map((l) => l.key)).size).toBe(lines.length);

    const swapped = draftFrom(settings());
    swapped["staff.pfRules"] = [...swapped["staff.pfRules"]].reverse();
    expect(changeLines(swapped, saved).map((l) => l.label)).toEqual(["Staff PF order"]);
    expect(changeLines(draftFrom(settings()), saved)).toEqual([]);
  });
});

describe("a new rule and the example's rules", () => {
  it("starts in the first box of an empty list at 0, with no limit and no percentage yet", () => {
    const fresh = newRow([]);
    expect(fresh).toMatchObject({ id: "", label: "", basis: "basic", minAmount: "0", maxAmount: "0", ratePercent: "" });
    expect(fresh.key).toMatch(/^new-\d+$/);
    expect(newRow([]).key).not.toBe(fresh.key);
  });

  it("starts a paisa above where the last rule ends, on the same basis", () => {
    const next = newRow([row({ basis: "total", maxAmount: "25000" })]);
    expect(next).toMatchObject({ basis: "total", minAmount: "25000.01", maxAmount: "0" });
    // a last rule with no upper limit leaves nothing above it: the new one starts at 0
    expect(newRow([row({ maxAmount: "0" })]).minAmount).toBe("0");
  });

  it("gives the example only the rules that can be read, named as the server names a blank one", () => {
    const rules = previewRules([
      row({ label: "", maxAmount: "25000" }),
      row({ key: "bad", ratePercent: "" }),
      row({ key: "bad2", minAmount: "5", maxAmount: "1" }),
      row({ key: "ok", label: " Ok ", minAmount: "30000", maxAmount: "0", ratePercent: "5", basis: "total" }),
    ]);
    expect(rules).toEqual([
      { label: "Rule 1", basis: "basic", min: 0, max: 25_000, rate: 12 },
      { label: "Ok", basis: "total", min: 30_000, max: 0, rate: 5 },
    ]);
  });
});
