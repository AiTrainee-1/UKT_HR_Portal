import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";

/** One department of a branch, with the people working in it now. */
export type BranchDepartment = { id: number; name: string; activeCount: number };

/** The figures shown beside a branch (GET /api/branches/summary). */
export type BranchSummaryRow = {
  branchId: number;
  staffActive: number;
  productionActive: number;
  inactive: number;
  /** How many employees were ever given a unit code in this branch (the counter behind HO-1, HO-2 ...). */
  nextEmployeeSeq: number;
  departments: BranchDepartment[];
};

export type BranchSummary = {
  branches: BranchSummaryRow[];
  /** Active employees who belong to no branch. */
  unassignedActive: number;
};

// Under the same "/api/branches" key as the branch list, so every invalidation of the list refreshes these figures too.
export const getBranchSummaryQueryKey = () => ["/api/branches", "summary"] as const;

export const useBranchSummary = () =>
  useQuery<BranchSummary>({
    queryKey: getBranchSummaryQueryKey(),
    queryFn: () => customFetch<BranchSummary>("/api/branches/summary"),
    // an old server without the endpoint (or a hiccup) leaves the page working, just without the figures
    retry: false,
  });
