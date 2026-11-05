// shared: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { hashKey, type QueryKey } from "@tanstack/react-query";
import { getApiOrigin } from "../custom-fetch";

// ── Biometric Sync ────────────────────────────────────────────────────────────

export type SyncResult = {
  ok: boolean;
  created?: number;
  output?: string;
  syncedAt?: string;
  error?: string;
  unmatchedDeviceIds?: string[];
  deviceErrors?: string[];
};

// ── Report Download Utility ───────────────────────────────────────────────────

export async function downloadReportCsv(reportId: string, params: Record<string, string>): Promise<void> {
  const endpointMap: Record<string, string> = {
    attendance: "/api/reports/attendance",
    leave: "/api/reports/leave",
    payroll: "/api/reports/payroll",
    employees: "/api/reports/employees",
  };

  const endpoint = endpointMap[reportId];
  if (!endpoint) throw new Error("Unsupported report type");

  const qs = new URLSearchParams({ ...params, format: "csv" });
  const url = `${getApiOrigin()}${endpoint}?${qs.toString()}`;

  const token = typeof localStorage !== "undefined" ? localStorage.getItem("uk_textile_token") : null;

  const response = await fetch(url, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = `${reportId}_report.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

// ── Search Lists ──────────────────────────────────────────────────────────────

/** The query key with the search text taken out of its params object(s), hashed the way TanStack compares keys. */
const keyWithoutSearch = (queryKey: QueryKey, searchParam: string) =>
  hashKey(
    queryKey.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return part;
      const rest: Record<string, unknown> = { ...(part as Record<string, unknown>) };
      delete rest[searchParam];
      return rest;
    }),
  );

/**
 * placeholderData for a list whose params carry a search box's text. While only the search changed, the last results
 * stay on screen until the new ones arrive, instead of the list dropping to its loader at every pause in typing. Any
 * other change (a date, a range, a page, a department) shows the loader as before, so rows of one filter are never
 * shown under another. `queryKey` is the key of the query being built.
 */
export function keepPreviousWhileSearching(queryKey: QueryKey, searchParam = "search") {
  const rest = keyWithoutSearch(queryKey, searchParam);
  return <T>(previousData: T | undefined, previousQuery: { queryKey: QueryKey } | undefined): T | undefined =>
    previousQuery && keyWithoutSearch(previousQuery.queryKey, searchParam) === rest ? previousData : undefined;
}
