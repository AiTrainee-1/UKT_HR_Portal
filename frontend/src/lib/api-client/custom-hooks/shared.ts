// shared: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
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
