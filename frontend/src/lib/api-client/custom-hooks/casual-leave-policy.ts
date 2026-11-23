// casual-leave-policy: Settings -> Casual Leave (owner 2026-11-21). Backend: casual_leave_views.casual_leave_settings
// (GET|PUT /api/casual-leave-policy) and cl_balance.py, which works every balance out from this policy each time it is
// read. Nothing already decided changes when the policy is saved: approved Casual Leave stays approved and paid.
import { useMutation, useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

export type ClEligibilityBasis = "months" | "days";
export type ClAllocation = "monthly" | "yearly";
export type ClYearEnd = "lapse" | "carry";

/** The policy as every Casual Leave screen reads it (also `policy` on the Casual Leave board and the apps' answer). */
export type CasualLeavePolicy = {
  /** The days a full year gives: 12 x the monthly days, or the yearly days. */
  yearlyEntitlement: number;
  halfDayCounts: number;
  /** The day the policy starts counting (YYYY-MM-DD); Casual Leave dated earlier never counts. */
  balanceSince: string;
  /** The months of service asked for; null when the policy counts days. */
  eligibilityMonths: number | null;
  staffOnly: boolean;
  /** The policy in one paragraph. */
  rule: string;
  eligibilityBasis: ClEligibilityBasis;
  eligibilityValue: number;
  /** "6 months of service" */
  serviceText: string;
  allocation: ClAllocation;
  monthlyAllocation: number;
  yearlyAllocation: number;
  /** "1 day a month" / "12 days a year" */
  allocationText: string;
  carryForward: boolean;
  yearEnd: ClYearEnd;
  /** The most days that move into the next year; null = no limit. */
  yearEndCarryMax: number | null;
  halfDayAllowed: boolean;
};

export type CasualLeavePolicySettings = CasualLeavePolicy & {
  updatedBy: string | null;
  updatedAt: string | null;
  /** False for a branch login: the policy is one company-wide rule. */
  canEdit: boolean;
  limits: { monthsMax: number; daysMax: number; monthlyMax: number; yearlyMax: number };
};

/** What a save sends; keys left out keep their saved value. */
export type CasualLeavePolicyInput = Partial<{
  eligibilityBasis: ClEligibilityBasis;
  eligibilityValue: number;
  allocation: ClAllocation;
  monthlyAllocation: number;
  yearlyAllocation: number;
  carryForward: boolean;
  yearEnd: ClYearEnd;
  yearEndCarryMax: number | null;
  halfDayAllowed: boolean;
  balanceSince: string;
}>;

/** A refused save: the first problem, and every problem by the field it is about. */
export type CasualLeavePolicyErrors = {
  error?: string;
  errors?: Partial<Record<keyof CasualLeavePolicyInput, string>>;
};

const PATH = "/api/casual-leave-policy";

export const getCasualLeavePolicyQueryKey = () => [PATH] as const;

export const useCasualLeavePolicy = () =>
  useQuery<CasualLeavePolicySettings>({
    queryKey: getCasualLeavePolicyQueryKey(),
    queryFn: () => customFetch<CasualLeavePolicySettings>(PATH),
  });

/** Every screen that shows a Casual Leave balance or a rule built from the policy. */
const readsCasualLeave = (query: Query) => {
  const head = query.queryKey[0];
  return typeof head === "string" && (head.startsWith("/api/casual-leaves") || head.startsWith("/api/reports"));
};

export const useUpdateCasualLeavePolicy = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CasualLeavePolicyInput) =>
      customFetch<CasualLeavePolicySettings>(PATH, { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: (saved) => {
      queryClient.setQueryData(getCasualLeavePolicyQueryKey(), saved);
      // the balances are worked out from the policy, so every Casual Leave screen reads them again
      void queryClient.invalidateQueries({ predicate: readsCasualLeave });
    },
  });
};
