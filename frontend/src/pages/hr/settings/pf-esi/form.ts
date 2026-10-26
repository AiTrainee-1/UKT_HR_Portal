import type {
  PfEsiBasis,
  PfEsiListKey,
  PfEsiRule,
  PfEsiRuleInput,
  PfEsiRuleProblem,
  PfEsiSaveInput,
  PfEsiSettings,
} from "@/lib/api-client/custom-hooks";
import { parseNumber, RANGES, sameValue } from "../payroll/form";
import { formatRupees, toPaise } from "../payroll/preview";
import type { PreviewRule } from "./preview";

/**
 * The PF & ESI tab's form, in plain functions: the four rule lists as the screen holds them (text in the boxes, so a half-typed
 * number is never rewritten under the cursor), the checks that mirror the server's (backend/api/pf_esi.py clean_rule_list:
 * the same ranges, the same overlap rule), what a save sends (only the lists that changed), and what a save changes in words.
 */

export type RuleClass = "staff" | "production";
export type RuleKind = "pf" | "esi";

export const RULE_CLASSES: RuleClass[] = ["staff", "production"];

export const listKey = (cls: RuleClass, kind: RuleKind): PfEsiListKey =>
  `${cls}.${kind === "pf" ? "pfRules" : "esiRules"}` as PfEsiListKey;

/** The four lists in the order the server checks them (and the screen shows them). */
export const LIST_KEYS: PfEsiListKey[] = [
  listKey("staff", "pf"),
  listKey("staff", "esi"),
  listKey("production", "pf"),
  listKey("production", "esi"),
];

export const LIST_TITLE: Record<PfEsiListKey, string> = {
  "staff.pfRules": "Staff PF",
  "staff.esiRules": "Staff ESI",
  "production.pfRules": "Production PF",
  "production.esiRules": "Production ESI",
};

export const classOf = (key: PfEsiListKey): RuleClass => (key.startsWith("staff") ? "staff" : "production");

export const CLASS_LABEL: Record<RuleClass, string> = { staff: "Staff", production: "Production" };

export const BASIS_VALUES: PfEsiBasis[] = ["basic", "first_portion", "total"];

/** Short names of the bases, for sentences ("Basic from ₹0 to ₹25,000"). The API's `basisOptions` carry the full labels. */
export const BASIS_SHORT: Record<PfEsiBasis, string> = {
  basic: "Basic salary",
  first_portion: "Basic + DA + Retaining Allowance",
  total: "Full monthly salary",
};

export const MAX_LABEL_LENGTH = 80;
export const DEFAULT_MAX_RULES = 50;

// ── the form ──

/** One rule as the screen holds it. `id` is "" for a rule added here and not saved yet. */
export type RuleRow = {
  /** The React key: the rule's id, or a counter for a rule that has none yet. */
  key: string;
  id: string;
  label: string;
  basis: PfEsiBasis;
  minAmount: string;
  maxAmount: string;
  ratePercent: string;
};

export type RuleDraft = Record<PfEsiListKey, RuleRow[]>;

export type RuleField = "label" | "basis" | "minAmount" | "maxAmount" | "ratePercent";
export const RULE_FIELDS: RuleField[] = ["label", "basis", "minAmount", "maxAmount", "ratePercent"];

let counter = 0;
/** A key for a row that has no id yet. */
export const freshKey = (): string => `new-${++counter}`;

/** A saved number as it goes into a box: 25000 -> "25000", 0.75 -> "0.75". */
export const boxNumber = (n: number): string => (Number.isFinite(n) ? String(n) : "");

export function rowFrom(rule: PfEsiRule): RuleRow {
  return {
    key: rule.id ? `rule-${rule.id}` : freshKey(),
    id: rule.id ?? "",
    label: rule.label ?? "",
    basis: BASIS_VALUES.includes(rule.basis) ? rule.basis : "basic",
    minAmount: boxNumber(rule.minAmount),
    maxAmount: boxNumber(rule.maxAmount),
    ratePercent: boxNumber(rule.ratePercent),
  };
}

export function draftFrom(settings: PfEsiSettings): RuleDraft {
  return {
    "staff.pfRules": settings.staff.pfRules.map(rowFrom),
    "staff.esiRules": settings.staff.esiRules.map(rowFrom),
    "production.pfRules": settings.production.pfRules.map(rowFrom),
    "production.esiRules": settings.production.esiRules.map(rowFrom),
  };
}

/** True when two rows are the same rule (the same numbers however they are typed: "12" and "12.00"). */
export function sameRow(a: RuleRow, b: RuleRow): boolean {
  return (
    a.id === b.id &&
    a.label.trim() === b.label.trim() &&
    a.basis === b.basis &&
    sameValue(a.minAmount || "0", b.minAmount || "0") &&
    sameValue(a.maxAmount || "0", b.maxAmount || "0") &&
    sameValue(a.ratePercent, b.ratePercent)
  );
}

export const sameRows = (a: RuleRow[], b: RuleRow[]): boolean =>
  a.length === b.length && a.every((row, i) => sameRow(row, b[i]));

export const sameDraft = (a: RuleDraft, b: RuleDraft): boolean => LIST_KEYS.every((k) => sameRows(a[k], b[k]));

/** The lists whose rules differ from the saved ones. */
export const changedLists = (draft: RuleDraft, saved: RuleDraft): PfEsiListKey[] =>
  LIST_KEYS.filter((k) => !sameRows(draft[k], saved[k]));

// ── reading the boxes ──

/** An amount box: blank means 0 (as the server reads it); otherwise digits with at most two decimals, within the limit. */
export function readAmount(
  text: string,
  max: number = RANGES.amount.max,
): { value: number | null; error: string | null } {
  if (text.trim() === "") return { value: 0, error: null };
  return parseNumber(text, { ...RANGES.amount, max });
}

/** The percentage box: required, 0 to 100, at most two decimals. */
export function readRate(text: string): { value: number | null; error: string | null } {
  if (text.trim() === "") return { value: null, error: "Enter the percentage." };
  return parseNumber(text, RANGES.percent);
}

/** A rule's range in words: "up to ₹25,000", "₹25,000 and above", "₹20,000 to ₹30,000", "any amount". */
export function rangeWords(min: number, max: number): string {
  if (max <= 0) return min <= 0 ? "any amount" : `${formatRupees(min)} and above`;
  return min <= 0 ? `up to ${formatRupees(max)}` : `${formatRupees(min)} to ${formatRupees(max)}`;
}

const readable = (n: number | null): n is number => n !== null && Number.isFinite(n);

/** One rule in a sentence: `"Below 25,000": Basic salary up to ₹25,000 → 12%`. */
export function describeRow(row: RuleRow): string {
  const min = readAmount(row.minAmount).value;
  const max = readAmount(row.maxAmount).value;
  const rate = readRate(row.ratePercent).value;
  const range = readable(min) && readable(max) ? rangeWords(min, max) : "an amount that is not valid yet";
  const name = row.label.trim() ? `"${row.label.trim()}": ` : "";
  return `${name}${BASIS_SHORT[row.basis]} ${range} → ${readable(rate) ? `${rate}%` : "(no percentage)"}`;
}

// ── what is wrong ──

export type RowErrors = Partial<Record<RuleField | "row", string>>;
export type ListCheck = { rows: RowErrors[]; list: string | null };

export type Validation = {
  lists: Record<PfEsiListKey, ListCheck>;
  ok: boolean;
  /** The first problem, with the list and rule it is in ("Staff PF rule 2: ..."), or null. */
  first: string | null;
  /** The lists that have a problem. */
  problems: PfEsiListKey[];
};

const ruleName = (rows: RuleRow[], index: number): string => {
  const label = rows[index]?.label.trim();
  return `rule ${index + 1}${label ? ` ("${label}")` : ""}`;
};

/** Checks one list the way the server does: every box, Max against Min, and ranges of one basis never overlapping. */
export function checkList(rows: RuleRow[], key: PfEsiListKey, maxRules: number = DEFAULT_MAX_RULES): ListCheck {
  const title = LIST_TITLE[key];
  const errors: RowErrors[] = rows.map(() => ({}));
  const list = rows.length > maxRules ? `${title} can have at most ${maxRules} rules.` : null;
  const paise: ({ low: number; high: number } | null)[] = rows.map(() => null);

  rows.forEach((row, i) => {
    const e = errors[i];
    if (row.label.trim().length > MAX_LABEL_LENGTH) e.label = `Keep the name to ${MAX_LABEL_LENGTH} characters.`;
    if (!BASIS_VALUES.includes(row.basis)) e.basis = "Choose what the range is based on.";
    const min = readAmount(row.minAmount);
    const max = readAmount(row.maxAmount);
    if (min.error) e.minAmount = min.error;
    if (max.error) e.maxAmount = max.error;
    if (readable(min.value) && readable(max.value)) {
      if (max.value > 0 && max.value < min.value) {
        e.maxAmount = "Must be 0 (no upper limit) or at least the From amount.";
      } else {
        paise[i] = { low: toPaise(min.value), high: max.value <= 0 ? Infinity : toPaise(max.value) };
      }
    }
    const rate = readRate(row.ratePercent);
    if (rate.error) e.ratePercent = rate.error;
  });

  // Ranges of one list must not overlap; only rules on the same basis are comparable (the server says the same).
  for (let later = 0; later < rows.length; later++) {
    const b = paise[later];
    if (!b || errors[later].minAmount) continue;
    for (let earlier = 0; earlier < later; earlier++) {
      const a = paise[earlier];
      if (!a || rows[earlier].basis !== rows[later].basis) continue;
      if (b.low <= a.high && a.low <= b.high) {
        const ra = readAmount(rows[earlier].minAmount).value ?? 0;
        const rb = readAmount(rows[later].minAmount).value ?? 0;
        errors[later].minAmount =
          `Overlaps ${ruleName(rows, earlier)}: it covers ${rangeWords(ra, readAmount(rows[earlier].maxAmount).value ?? 0)} ` +
          `and this rule covers ${rangeWords(rb, readAmount(rows[later].maxAmount).value ?? 0)}. ` +
          "Ranges in one list must not overlap.";
        break;
      }
    }
  }
  return { rows: errors, list };
}

/** Checks all four lists. `maxRules` is the server's limit per list (the API says it). */
export function validateDraft(draft: RuleDraft, maxRules: number = DEFAULT_MAX_RULES): Validation {
  const lists = Object.fromEntries(LIST_KEYS.map((k) => [k, checkList(draft[k], k, maxRules)])) as Record<
    PfEsiListKey,
    ListCheck
  >;
  let first: string | null = null;
  const problems: PfEsiListKey[] = [];
  for (const key of LIST_KEYS) {
    const check = lists[key];
    let bad = false;
    if (check.list) {
      bad = true;
      first ??= check.list;
    }
    check.rows.forEach((e, i) => {
      for (const field of [...RULE_FIELDS, "row" as const]) {
        const message = e[field];
        if (!message) continue;
        bad = true;
        first ??= `${LIST_TITLE[key]} ${ruleName(draft[key], i)}: ${message}`;
        break;
      }
    });
    if (bad) problems.push(key);
  }
  return { lists, ok: problems.length === 0, first, problems };
}

/**
 * The server's 400 about one rule shown where it belongs: on that row's box (`field`), on the row as a whole (`id`, `list`),
 * or on the list when it names no rule. The checks above mirror the server's, so this is the safety net, not the usual way
 * a problem is shown.
 */
export function withServerProblem(validation: Validation, problem: PfEsiRuleProblem): Validation {
  const key = problem.list;
  if (!key) return { ...validation, ok: false, first: validation.first ?? problem.message };
  const lists = {
    ...validation.lists,
    [key]: { rows: [...validation.lists[key].rows], list: validation.lists[key].list },
  };
  const index = problem.ruleIndex;
  if (index === null || index >= lists[key].rows.length) {
    lists[key].list = problem.message;
  } else {
    const field = (RULE_FIELDS as string[]).includes(problem.field ?? "") ? (problem.field as RuleField) : "row";
    lists[key].rows[index] = { ...lists[key].rows[index], [field]: problem.message };
  }
  const problems = LIST_KEYS.filter((k) => k === key || validation.problems.includes(k));
  return { lists, ok: false, first: validation.first ?? problem.message, problems };
}

/** How many of a class's lists have a problem (for the "needs attention" chip). */
export const problemClasses = (validation: Validation): RuleClass[] =>
  RULE_CLASSES.filter((cls) => validation.problems.some((k) => classOf(k) === cls));

// ── what is sent ──

const num = (text: string): number => Number(text.trim() === "" ? "0" : text.trim());

export function ruleInput(row: RuleRow): PfEsiRuleInput {
  return {
    ...(row.id ? { id: row.id } : {}),
    label: row.label.trim(),
    basis: row.basis,
    minAmount: num(row.minAmount),
    maxAmount: num(row.maxAmount),
    ratePercent: num(row.ratePercent),
  };
}

/**
 * The body of a save: the lists that changed, each as the whole list (a list that is sent replaces the saved one), and the
 * version the screen started from. A list nobody touched is not sent, so saving Staff PF never rewrites Production ESI.
 */
export function toInput(
  draft: RuleDraft,
  saved: RuleDraft,
  scope: { branchId: number | null; expectedVersion: string },
): PfEsiSaveInput {
  const body: PfEsiSaveInput = { branchId: scope.branchId, expectedVersion: scope.expectedVersion };
  for (const key of changedLists(draft, saved)) {
    const cls = classOf(key);
    const kind = key.endsWith("pfRules") ? "pfRules" : "esiRules";
    body[cls] = { ...body[cls], [kind]: draft[key].map(ruleInput) };
  }
  return body;
}

// ── what a save changes, in words (for the confirm dialog) ──

export type Change = { key: string; label: string; from: string; to: string; money: boolean };

/** Each rule added, removed or edited, per list, as "before -> after" lines. */
export function changeLines(draft: RuleDraft, saved: RuleDraft): Change[] {
  const lines: Change[] = [];
  for (const list of changedLists(draft, saved)) {
    const was = new Map(saved[list].map((r) => [r.id, r]));
    const kept = new Set<string>();
    draft[list].forEach((row, i) => {
      const before = row.id ? was.get(row.id) : undefined;
      const label = `${LIST_TITLE[list]} rule ${i + 1}`;
      if (!before) {
        lines.push({ key: `${list}:${row.key}`, label, from: "(new rule)", to: describeRow(row), money: true });
        return;
      }
      kept.add(row.id);
      if (!sameRow(before, row)) {
        lines.push({ key: `${list}:${row.key}`, label, from: describeRow(before), to: describeRow(row), money: true });
      }
    });
    for (const row of saved[list]) {
      if (!kept.has(row.id)) {
        lines.push({
          key: `${list}:gone:${row.key}`,
          label: `${LIST_TITLE[list]} rule removed`,
          from: describeRow(row),
          to: "(removed)",
          money: true,
        });
      }
    }
    // the same rules in another order is a change too (the first match wins)
    const ids = draft[list].filter((r) => r.id && was.has(r.id)).map((r) => r.id);
    const keptInOrder = saved[list].filter((r) => ids.includes(r.id)).map((r) => r.id);
    if (ids.join("|") !== keptInOrder.join("|")) {
      lines.push({
        key: `${list}:order`,
        label: `${LIST_TITLE[list]} order`,
        from: "(order as saved)",
        to: "(new order: the first matching rule wins)",
        money: true,
      });
    }
  }
  return lines;
}

// ── the rows as the live example reads them ──

/** The rules that can be read right now (rows with a problem in a box are left out), as numbers. */
export function previewRules(rows: RuleRow[]): PreviewRule[] {
  const out: PreviewRule[] = [];
  rows.forEach((row, i) => {
    const min = readAmount(row.minAmount).value;
    const max = readAmount(row.maxAmount).value;
    const rate = readRate(row.ratePercent).value;
    if (!readable(min) || !readable(max) || !readable(rate)) return;
    if (max > 0 && max < min) return;
    out.push({ label: row.label.trim() || `Rule ${i + 1}`, basis: row.basis, min, max, rate });
  });
  return out;
}

// ── adding a rule ──

/** A new row, ready to be filled in: the basis of the last rule, starting a paisa above where that one ends. */
export function newRow(rows: RuleRow[]): RuleRow {
  const last = rows[rows.length - 1];
  const basis = last?.basis ?? "basic";
  const lastMax = last ? readAmount(last.maxAmount).value : null;
  const start = readable(lastMax) && lastMax > 0 ? (Math.round(lastMax * 100) + 1) / 100 : 0;
  return {
    key: freshKey(),
    id: "",
    label: "",
    basis,
    minAmount: start > 0 ? start.toFixed(2) : "0",
    maxAmount: "0",
    ratePercent: "",
  };
}

/** The name a blank-named rule gets from the server ("Rule 2"). */
export const autoLabel = (index: number): string => `Rule ${index + 1}`;
