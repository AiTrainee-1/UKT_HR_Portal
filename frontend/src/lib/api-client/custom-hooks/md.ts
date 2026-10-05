// md: the Managing Director portal's data hooks. Every call goes to /api/md/* (backend api/md_portal/), which only the
// account flagged MD can use. Page-specific response types live next to each page (pages/md/<page>/api.ts), built on
// useMdQuery below.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ApiError, customFetch } from "../custom-fetch";
import type { MdMe, MdOrg } from "@/lib/md/types";

export type MdQueryParams = Record<string, string | number | boolean | null | undefined>;

/** `/api/md/<path>?a=1&b=2`, leaving out empty values. */
export function mdUrl(path: string, params?: MdQueryParams): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const query = qs.toString();
  return `/api/md/${path.replace(/^\//, "")}${query ? `?${query}` : ""}`;
}

/** The query key: the API path first (the codebase invalidates by prefix), then the parameters. */
export const mdQueryKey = (path: string, params?: MdQueryParams) => ["/api/md", path, params ?? {}] as const;

/** A 4xx is the server saying no (a bad parameter, not the MD): retrying cannot help. */
const retryUnlessClientError = (failures: number, error: unknown) =>
  !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 1;

type MdQueryOptions = {
  enabled?: boolean;
  /** ms; live widgets use 30-60 s, analysis pages leave it off. */
  refetchInterval?: number | false;
  staleTime?: number;
};

/**
 * One GET against the MD API. Keeps the previous result on screen while new parameters load (a changed filter does
 * not blank the page) and never retries a 4xx. A 401 (the session ended) is handled once, centrally, by MdLayout.
 */
export function useMdQuery<T>(path: string, params?: MdQueryParams, options: MdQueryOptions = {}) {
  return useQuery<T>({
    queryKey: mdQueryKey(path, params),
    queryFn: ({ signal }) => customFetch<T>(mdUrl(path, params), { signal }),
    placeholderData: keepPreviousData,
    retry: retryUnlessClientError,
    staleTime: options.staleTime ?? 30_000,
    refetchInterval: options.refetchInterval ?? false,
    enabled: options.enabled ?? true,
  });
}

/** Who the MD is, the portal's pages and the server's clock. */
export const useMdMe = () => useMdQuery<MdMe>("me", undefined, { staleTime: 60_000 });

/** Units and departments, for the filters. */
export const useMdOrg = () => useMdQuery<MdOrg>("org", undefined, { staleTime: 5 * 60_000 });

/** A readable reason for a failed query (the server's message when it gave one). */
export function describeMdError(error: unknown): string {
  if (error instanceof ApiError) {
    const data = error.data as { error?: string; message?: string } | null;
    return data?.error || data?.message || error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}
