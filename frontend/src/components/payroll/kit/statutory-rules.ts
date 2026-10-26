import { usePfEsiSettings, type PayrollKind } from "@/lib/api-client/custom-hooks";
import { plural } from "./format";
import { CO_EMP_EMPLOYEES_PATH, PF_ESI_SETTINGS_PATH } from "./statutory";

// The PF / ESI rules as the payroll screens need them: only HOW MANY rules there are for Staff or Production, to say so in
// the Generate dialogs and in the Rules view ("no PF / ESI rules are set: nobody will have PF or ESI"). The rules
// themselves are edited in Settings -> PF & ESI; this reads the same GET /api/pf-esi-settings as that page (one cache), which
// every HR login may read (a branch login gets its own unit's rules).

type RuleLists = { pfRules?: unknown[] | null; esiRules?: unknown[] | null };

/** The part of GET /api/pf-esi-settings the payroll screens read. */
export type PfEsiRulesSlice = {
  scope?: { branchId: number | null; branchName?: string | null; isOverride: boolean } | null;
  canEdit?: boolean;
  staff?: RuleLists | null;
  production?: RuleLists | null;
  branches?: { id: number; name: string; hasOverride: boolean }[] | null;
};

/**
 * The rules of this login's own scope (the global rules for the Super Admin). A screen that cannot read them (no permission,
 * an older server) gets an error and says nothing about them. Kept as a function of its own so a test can stand in for it.
 */
export const usePfEsiRulesSlice = () => usePfEsiSettings(null);

export type StatutoryRulesSummary = {
  pf: number;
  esi: number;
  /** Neither a PF nor an ESI rule is set for this kind of payroll: nobody gets either. */
  none: boolean;
  /** "PF: 2 rules · ESI: 1 rule", or "No PF or ESI rules are set for Staff". */
  text: string;
  /** Whose rules these are, when it is worth saying ("3 units have their own rules", "this unit's own rules"). */
  scope: string | null;
};

const count = (list: unknown[] | null | undefined): number => (Array.isArray(list) ? list.length : 0);

const kindName = (kind: PayrollKind): string => (kind === "production" ? "Production" : "Staff");

/**
 * What the screens say about the PF / ESI rules of one kind of payroll. Null when the rules are not known (not loaded, or
 * the server did not answer), so a screen never states "no rules" about something it could not read.
 */
export function summarizeRules(
  kind: PayrollKind,
  data: PfEsiRulesSlice | null | undefined,
): StatutoryRulesSummary | null {
  const lists = data ? data[kind] : null;
  if (!data || !lists) return null;
  const pf = count(lists.pfRules);
  const esi = count(lists.esiRules);
  const none = pf === 0 && esi === 0;
  const own = (data.branches ?? []).filter((b) => b.hasOverride).length;
  let scope: string | null = null;
  if (data.scope?.isOverride) scope = "this unit's own rules";
  else if (data.canEdit && own > 0)
    scope = own === 1 ? "1 unit has its own rules" : `${own} units have their own rules`;
  return {
    pf,
    esi,
    none,
    text: none
      ? `No PF or ESI rules are set for ${kindName(kind)}`
      : `PF: ${plural(pf, "rule")} · ESI: ${plural(esi, "rule")}`,
    scope,
  };
}

/** The sentence every Generate dialog and the Rules view repeat: who PF / ESI / TDS apply to. */
export const STATUTORY_WHO_TEXT =
  "PF and ESI are deducted only from Co Emp employees, by the rules in Settings → PF & ESI (a percentage of Basic + DA + Retaining Allowance). Employees on the TDS list have TDS deducted at their own percentage instead. Everyone else has neither.";

export { CO_EMP_EMPLOYEES_PATH, PF_ESI_SETTINGS_PATH };
