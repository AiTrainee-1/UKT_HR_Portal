import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
import type { IncrementRecord } from "./logic";

export type IncrementHistoryResult = {
  results: IncrementRecord[];
  /** How many increments there are in all: more than `results.length` when the server cut the list. */
  total: number;
};

/**
 * Every salary increment in the HR user's branch, newest first, with each employee's department, designation, branch
 * and type. Read-only. After applying an increment the page invalidates this key by hand (useAddIncrement only knows
 * about the per-employee summary).
 */
export const INCREMENT_HISTORY_KEY = ["/api/increments/history"] as const;

export const useIncrementHistory = () =>
  useQuery<IncrementHistoryResult>({
    queryKey: INCREMENT_HISTORY_KEY,
    queryFn: () => customFetch<IncrementHistoryResult>("/api/increments/history"),
  });
