// production-shift-rules: the Settings -> Production Shifts tab's API (backend/api/production_shift_rules_views.py).
// One document holds everything: the master switch and the date the rules start, the grace, the shift groups (Day, Night,
// Sunday ...) each with its ladder of "leaves at this time = this many shifts", the unpaid breaks, and the advanced
// numbers. A save sends the whole document and is all-or-nothing: a problem is HTTP 400 {"error": "<one sentence>"} and
// nothing is saved. A branch login can read it but gets 403 {"code": "company_wide_settings"} on a save.
//
// Times are "HH:MM" (24-hour). A time after midnight is written as the clock time plus `outNextDay: true`.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

/** The kinds of group. `custom` is one HR added. */
export type ProductionShiftGroupKind = "day" | "night" | "sunday" | "custom";
/** Which days a group can be used on: Monday to Saturday, Sunday only, or every day. */
export type ProductionShiftAppliesOn = "mon_sat" | "sunday" | "all";
/** How a day's total is rounded: to the nearest step, or down to the step below. */
export type ProductionShiftRoundingMode = "nearest" | "down";

/** One point of a ladder: a worker who leaves at `outTime` has earned `shiftValue` shifts. */
export type ProductionShiftRule = {
  id: number;
  label: string;
  outTime: string;
  outNextDay: boolean;
  shiftValue: number;
  enabled: boolean;
};

export type ProductionShiftGroup = {
  id: number;
  label: string;
  kind: ProductionShiftGroupKind;
  appliesOn: ProductionShiftAppliesOn;
  /** The time the group's workers are expected to arrive (a first punch up to this plus the grace is on time). */
  startTime: string;
  /** A day whose FIRST punch is between these two times uses this group. */
  firstPunchFrom: string;
  firstPunchTo: string;
  /** The standard departure, used only to flag leaving early. */
  mainOutTime: string | null;
  mainOutNextDay: boolean;
  enabled: boolean;
  rules: ProductionShiftRule[];
};

/** An unpaid break (tea, lunch, dinner): time in it earns nothing, and nobody punches for it. */
export type ProductionShiftBreak = {
  id: number;
  label: string;
  startTime: string;
  endTime: string;
  enabled: boolean;
};

/** What the OLD calculation used (read-only): kept for every day before the rules' start date. Every key is optional. */
export type ProductionShiftLegacy = {
  punch1Time?: string;
  punch2Time?: string;
  punch3Time?: string;
  punch4Time?: string;
  graceMinutes?: number;
};

export type ProductionShiftRules = {
  /** While off, every day uses the old calculation. */
  enabled: boolean;
  /** The first day the rules are used; every earlier day keeps the old calculation. YYYY-MM-DD. */
  effectiveFrom: string | null;
  graceMinutes: number;
  minCredit: number;
  roundingStep: number;
  roundingMode: ProductionShiftRoundingMode;
  fullDayValue: number;
  nightSessionHours: number;
  groups: ProductionShiftGroup[];
  breaks: ProductionShiftBreak[];
  updatedAt: string | null;
  updatedBy: string | null;
  /** Advice about what is saved (never blocks a save): plain sentences. */
  warnings?: string[];
  legacy?: ProductionShiftLegacy | null;
};

/**
 * What a save sends: the same document minus the read-only keys. In the two arrays a row with an `id` is updated, a row
 * without one is created and a row whose id is missing is deleted; the order of the array is the order of the rows.
 */
export type ProductionShiftRulesInput = Omit<
  ProductionShiftRules,
  "updatedAt" | "updatedBy" | "warnings" | "legacy" | "groups" | "breaks"
> & {
  groups: (Omit<ProductionShiftGroup, "id" | "rules"> & {
    id?: number;
    rules: (Omit<ProductionShiftRule, "id"> & { id?: number })[];
  })[];
  breaks: (Omit<ProductionShiftBreak, "id"> & { id?: number })[];
};

/** What a day's punches work out to, with the saved rules (nothing is saved by asking). */
export type ProductionShiftPreview = {
  /** The group's name ("Day shift"), or a word for the old calculation. */
  group: string | null;
  shifts: number;
  /** "present" | "half_shift" | "absent" ... as the attendance records say it. */
  status: string;
  isLate: boolean;
  earlyLeave: boolean;
  /** One plain sentence: which rule decided it. */
  note: string;
};

export type ProductionShiftPreviewInput = { punches: string[]; date: string };

const RULES_PATH = "/api/production-shift-rules";
const PREVIEW_PATH = `${RULES_PATH}/preview`;

export const getProductionShiftRulesQueryKey = () => [RULES_PATH] as const;
export const getProductionShiftPreviewQueryKey = (input?: ProductionShiftPreviewInput) =>
  input ? ([PREVIEW_PATH, input] as const) : ([PREVIEW_PATH] as const);

/** The Settings -> Production Shifts read (needs Settings - Attendance; a branch login can read it). */
export const useProductionShiftRules = () =>
  useQuery<ProductionShiftRules>({
    queryKey: getProductionShiftRulesQueryKey(),
    queryFn: () => customFetch<ProductionShiftRules>(RULES_PATH),
  });

/** What a save gives back: the document as it now is, and the server's warnings about it. */
export type ProductionShiftRulesSaveResult = { rules: ProductionShiftRules; warnings: string[] };

/**
 * Saves the whole document and returns it as it now is (the server fills in the ids of new rows and the order of the
 * rows) with its warnings. An answer without the document is followed by a read. Every typed-in example is stale after a
 * save, so the preview answers are dropped.
 */
export const useUpdateProductionShiftRules = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: ProductionShiftRulesInput): Promise<ProductionShiftRulesSaveResult> => {
      const answer = await customFetch<(Partial<ProductionShiftRules> & { warnings?: unknown }) | null>(RULES_PATH, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      const warnings = Array.isArray(answer?.warnings)
        ? answer.warnings.filter((w): w is string => typeof w === "string")
        : [];
      if (answer && Array.isArray(answer.groups) && Array.isArray(answer.breaks)) {
        return { rules: { ...(answer as ProductionShiftRules), warnings }, warnings };
      }
      const fresh = await customFetch<ProductionShiftRules>(RULES_PATH);
      return { rules: { ...fresh, warnings }, warnings };
    },
    onSuccess: ({ rules }) => {
      queryClient.setQueryData(getProductionShiftRulesQueryKey(), rules);
      void queryClient.invalidateQueries({ queryKey: getProductionShiftPreviewQueryKey() });
    },
  });
};

/**
 * The "Try it" calculator: the shifts a made-up day earns with the SAVED rules. A POST that reads and never writes.
 * `enabled` is false while the typed punches cannot be read yet; the previous answer stays on screen while a new one loads.
 */
export const useProductionShiftPreview = (input: ProductionShiftPreviewInput | null) =>
  useQuery<ProductionShiftPreview>({
    queryKey: getProductionShiftPreviewQueryKey(input ?? { punches: [], date: "" }),
    queryFn: () => customFetch<ProductionShiftPreview>(PREVIEW_PATH, { method: "POST", body: JSON.stringify(input) }),
    enabled: input !== null,
    placeholderData: keepPreviousData,
    retry: false,
  });
