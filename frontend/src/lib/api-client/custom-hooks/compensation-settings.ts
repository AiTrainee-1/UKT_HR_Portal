// compensation-settings: the Settings -> Compensation tab's API (and the same body, read-only, for the Compensation page).
// Every feature of the Compensation overhaul has its own switch here; the master switch stays Settings -> Payroll ->
// OT / Compensation (PayrollSettings.compensationFeatureEnabled) and is only REPORTED here as `masterEnabled`.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

/** One row of the Type 1 table: this much extra work after the shift end earns this many minutes the next morning. */
export type CompensationAllowanceRule = {
  id: number;
  label: string;
  enabled: boolean;
  /** Minutes of work past the shift end (60 = 1 hour). */
  minExtraMinutes: number;
  /** Minutes added to the next working day's first-punch limit. */
  allowanceMinutes: number;
  sortOrder: number;
};

/** One row of the Type 2 ladder: a last punch-out before `untilMinutes` earns `shifts`. */
export type CompensationShiftRule = {
  id: number;
  label: string;
  enabled: boolean;
  /** Minutes since the OT day's midnight (a punch after midnight is 1440 + its clock minutes); null = no upper limit. */
  untilMinutes: number | null;
  /** 0.25 / 0.5 / 0.75 / 1 */
  shifts: number;
  sortOrder: number;
};

export type CompensationSettings = {
  /** Settings -> Payroll -> OT / Compensation: while it is off none of the features below acts. */
  masterEnabled: boolean;
  allowance: { enabled: boolean; effectiveFrom: string | null };
  shift: { enabled: boolean; minExtraMinutes: number; relaxationEnabled: boolean; payEnabled: boolean };
  windows: { enabled: boolean };
  holidayWork: { enabled: boolean };
  birthday: { enabled: boolean; effectiveFrom: string | null };
  allowanceRules: CompensationAllowanceRule[];
  shiftRules: CompensationShiftRule[];
  updatedBy: string | null;
  updatedAt: string | null;
};

/**
 * What a save sends: the same body minus the three read-only keys. A top-level group that is left out is left alone; the
 * two rule arrays REPLACE the whole set (a row with an `id` is updated, a row without one is created, an id that is
 * missing is deleted).
 */
export type CompensationSettingsInput = {
  allowance?: { enabled?: boolean; effectiveFrom?: string | null };
  shift?: { enabled?: boolean; minExtraMinutes?: number; relaxationEnabled?: boolean; payEnabled?: boolean };
  windows?: { enabled?: boolean };
  holidayWork?: { enabled?: boolean };
  birthday?: { enabled?: boolean; effectiveFrom?: string | null };
  allowanceRules?: (Omit<CompensationAllowanceRule, "id"> & { id?: number })[];
  shiftRules?: (Omit<CompensationShiftRule, "id"> & { id?: number })[];
};

const SETTINGS_PATH = "/api/compensation/settings";
const CONFIG_PATH = "/api/compensation/config";

export const getCompensationSettingsQueryKey = () => [SETTINGS_PATH] as const;
export const getCompensationConfigQueryKey = () => [CONFIG_PATH] as const;

/** The Settings tab's own read (needs the Settings -> Compensation permission). */
export const useCompensationSettings = () =>
  useQuery<CompensationSettings>({
    queryKey: getCompensationSettingsQueryKey(),
    queryFn: () => customFetch<CompensationSettings>(SETTINGS_PATH),
  });

/** The same body for the Compensation page (needs only the Compensation page permission; read-only). */
export const useCompensationConfig = () =>
  useQuery<CompensationSettings>({
    queryKey: getCompensationConfigQueryKey(),
    queryFn: () => customFetch<CompensationSettings>(CONFIG_PATH),
  });

/** What a save gives back: the settings as they now are, and the server's warnings about the result (plain sentences). */
export type CompensationSaveResult = { settings: CompensationSettings; warnings: string[] };

/**
 * Saves the tab and returns the settings as they now are (the server fills in the ids of new rows, today's date for a
 * feature switched on again, and the order of the rows) with its warnings. The server answers a save with the new body plus
 * `warnings`; an answer without the body is followed by a read. Every other Compensation query is marked stale so an open
 * Compensation page re-reads what the new rules suggest.
 */
export const useUpdateCompensationSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CompensationSettingsInput): Promise<CompensationSaveResult> => {
      const answer = await customFetch<(Partial<CompensationSettings> & { warnings?: unknown }) | null>(SETTINGS_PATH, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      const warnings = Array.isArray(answer?.warnings)
        ? answer.warnings.filter((w): w is string => typeof w === "string")
        : [];
      if (answer && Array.isArray(answer.allowanceRules) && Array.isArray(answer.shiftRules)) {
        const { warnings: _warnings, ...settings } = answer as CompensationSettings & { warnings?: unknown };
        return { settings, warnings };
      }
      return { settings: await customFetch<CompensationSettings>(SETTINGS_PATH), warnings };
    },
    onSuccess: ({ settings }) => {
      queryClient.setQueryData(getCompensationSettingsQueryKey(), settings);
      return queryClient.invalidateQueries({
        predicate: (q) => {
          const head = q.queryKey[0];
          return typeof head === "string" && head.startsWith("/api/compensation") && head !== SETTINGS_PATH;
        },
      });
    },
  });
};
