// pf-esi-settings: Settings -> PF & ESI. Backend: api/pf_esi.py (the rules and their validation) and the /api/pf-esi-settings
// view (API contract: scratchpad pf_esi_final_contract.md, section 3).
//
// Four independent lists of rules: Staff PF, Staff ESI, Production PF, Production ESI. A rule is a salary range measured on
// a basis (Basic / Basic + DA + Retaining Allowance / the whole monthly salary) and a percentage; the first rule whose range
// holds the employee's amount applies, no match means no deduction. The rules are company-wide ("global") unless the
// Super Admin gives a branch (unit) a rule set of its own. Reading is open to every HR login (a branch login gets ITS branch's
// rules), writing is the Super Admin's alone.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, customFetch } from "../custom-fetch";

/** What a rule's range is measured on: the Basic component, Basic + DA + Retaining Allowance, or the whole monthly salary. */
export type PfEsiBasis = "basic" | "first_portion" | "total";

/** One rule as the server stores and returns it. `maxAmount` 0 means "no upper limit". */
export type PfEsiRule = {
  id: string;
  label: string;
  basis: PfEsiBasis;
  minAmount: number;
  maxAmount: number;
  ratePercent: number;
};

/** One rule as a save sends it: a blank `id` is given one by the server, a blank `label` becomes "Rule N". */
export type PfEsiRuleInput = {
  id?: string;
  label?: string;
  basis?: PfEsiBasis;
  minAmount: number | string;
  maxAmount: number | string;
  ratePercent: number | string;
};

export type PfEsiClassRules = { pfRules: PfEsiRule[]; esiRules: PfEsiRule[] };
export type PfEsiClassRulesInput = { pfRules?: PfEsiRuleInput[]; esiRules?: PfEsiRuleInput[] };

/** The four lists, as the API names them (`list` in a 400 answer). */
export type PfEsiListKey = "staff.pfRules" | "staff.esiRules" | "production.pfRules" | "production.esiRules";

export type PfEsiBasisOption = { value: PfEsiBasis; label: string; description: string };
export type PfEsiBranchRef = { id: number; name: string; hasOverride: boolean };

export type PfEsiLimits = { maxRulesPerList: number; maxAmount: number; maxRatePercent: number };

export type PfEsiSettings = {
  /** Whose rules these are: the global ones (`branchId` null) or a branch's (its own set when `isOverride`, else the global ones it follows). */
  scope: { branchId: number | null; branchName: string | null; isOverride: boolean };
  /** True for the Super Admin only. */
  canEdit: boolean;
  /** A fingerprint of the four lists of this scope: a save sends it back as `expectedVersion`. */
  version: string;
  staff: PfEsiClassRules;
  production: PfEsiClassRules;
  /** Every active branch with whether it has its own rules (Super Admin only; empty for everybody else). */
  branches: PfEsiBranchRef[];
  basisOptions: PfEsiBasisOption[];
  limits?: PfEsiLimits;
};

export const PF_ESI_DEFAULT_LIMITS: PfEsiLimits = {
  maxRulesPerList: 50,
  maxAmount: 99_999_999.99,
  maxRatePercent: 100,
};

export type PfEsiSaveInput = {
  /** null / absent = the global rules; N = that branch's own rule set. */
  branchId?: number | null;
  /** The `version` of the answer this edit started from (required). */
  expectedVersion: string;
  /** A list that is sent REPLACES that list entirely; a list that is left out is kept as it is. */
  staff?: PfEsiClassRulesInput;
  production?: PfEsiClassRulesInput;
};

const PATH = "/api/pf-esi-settings";

export const getPfEsiSettingsQueryKey = (branchId: number | null = null) => [PATH, branchId] as const;

const pathFor = (branchId: number | null) => (branchId === null ? PATH : `${PATH}?branchId=${branchId}`);

/**
 * The rules of one scope: `branchId` null = the global rules (for a branch login: its own scope, whatever it asks for).
 * The previous scope's answer stays on screen while another loads (`isPlaceholderData`), so the scope picker does not
 * flicker; a screen must not let anybody edit it then.
 */
export const usePfEsiSettings = (branchId: number | null = null) =>
  useQuery<PfEsiSettings>({
    queryKey: getPfEsiSettingsQueryKey(branchId),
    queryFn: () => customFetch<PfEsiSettings>(pathFor(branchId)),
    placeholderData: keepPreviousData,
  });

/**
 * Saves the rules of one scope and returns them as they now are (new ids, new `version`). The answer is kept as the scope's
 * data, and every other scope's answer is refreshed (the picker's "own rules" badges and a branch that follows the global
 * rules both change).
 */
export const useUpdatePfEsiSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PfEsiSaveInput) =>
      customFetch<PfEsiSettings>(PATH, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: (saved, body) => {
      queryClient.setQueryData(getPfEsiSettingsQueryKey(body.branchId ?? null), saved);
      void queryClient.invalidateQueries({ queryKey: [PATH] });
    },
  });
};

/** Makes a branch follow the global rules again (drops its own rule set). Answers with the branch's rules as they now are. */
export const useResetPfEsiBranch = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (branchId: number) => customFetch<PfEsiSettings>(`${PATH}?branchId=${branchId}`, { method: "DELETE" }),
    onSuccess: (fresh, branchId) => {
      queryClient.setQueryData(getPfEsiSettingsQueryKey(branchId), fresh);
      void queryClient.invalidateQueries({ queryKey: [PATH] });
    },
  });
};

// ── what a refused save says ───────────────────────────────────────────────────

/** A 400 about one rule: which list, which rule (0-based), which field, and the sentence to show. */
export type PfEsiRuleProblem = {
  message: string;
  list: PfEsiListKey | null;
  ruleIndex: number | null;
  field: string | null;
  /** For an overlap: the other rule of the pair (0-based). */
  otherRuleIndex: number | null;
};

const LISTS: readonly string[] = ["staff.pfRules", "staff.esiRules", "production.pfRules", "production.esiRules"];

const dataOf = (err: unknown): Record<string, unknown> | null =>
  err instanceof ApiError && err.data && typeof err.data === "object" ? (err.data as Record<string, unknown>) : null;

/** The problem a 400 names (list / ruleIndex / field), or null when the refusal is about something else. */
export function pfEsiRuleProblem(err: unknown): PfEsiRuleProblem | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null;
  const data = dataOf(err);
  if (!data || typeof data.error !== "string" || data.error.trim() === "") return null;
  const list = typeof data.list === "string" && LISTS.includes(data.list) ? (data.list as PfEsiListKey) : null;
  const whole = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);
  return {
    message: data.error,
    list,
    ruleIndex: whole(data.ruleIndex),
    field: typeof data.field === "string" ? data.field : null,
    otherRuleIndex: whole(data.otherRuleIndex),
  };
}

/** True when somebody else saved these rules after this page loaded them (409 `stale_version`). */
export const isStalePfEsiError = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 409 && dataOf(err)?.error === "stale_version";

/** True when the server refused the save because the login is not the Super Admin (403). */
export const isPfEsiForbidden = (err: unknown): boolean => err instanceof ApiError && err.status === 403;

/** The server's own sentence for a refused save or reset, when it sent one. */
export function pfEsiErrorMessage(err: unknown): string | null {
  const data = dataOf(err);
  if (!data) return null;
  if (typeof data.message === "string" && data.message.trim()) return data.message;
  if (typeof data.error === "string" && data.error.trim() && data.error !== "permission_denied") return data.error;
  return null;
}
