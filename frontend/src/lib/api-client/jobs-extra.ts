import { useQuery } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";
import type { Job } from "./generated/api.schemas";

export const getJobById = (id: number, options?: RequestInit) =>
  customFetch<Job>(`/api/jobs/${id}`, { ...options, method: "GET" });

export const getJobByIdQueryKey = (id: number) => ["/api/jobs", id] as const;

export function useGetJobById(
  id: number,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: getJobByIdQueryKey(id),
    queryFn: ({ signal }) => getJobById(id, { signal }),
    enabled: options?.enabled ?? id > 0,
  });
}

export function buildJobApplyUrl(jobId: number): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}${base}/apply/job/${jobId}`;
}
