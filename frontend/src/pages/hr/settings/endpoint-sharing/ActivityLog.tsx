import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSharedActivity, useSharedEndpoints } from "@/lib/api-client/custom-hooks";
import { stamp } from "./form";
import { AnchorSection, Pill, SELECT_CLASS, ScrollTable, TD, TH, WRAP } from "./ui";

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Every result" },
  { value: "ok", label: "Answered (200)" },
  { value: "error", label: "Refused or failed (400 and above)" },
  { value: "400", label: "400 - a parameter was wrong" },
  { value: "401", label: "401 - the key was refused" },
  { value: "403", label: "403 - the website was refused" },
  { value: "404", label: "404 - not found or switched off" },
  { value: "429", label: "429 - too many calls" },
];

const tone = (status: number): "good" | "warn" | "bad" => (status < 300 ? "good" : status === 429 ? "warn" : "bad");

/**
 * The access log: every call that reached an endpoint, answered or refused, newest first, for one endpoint or for all of
 * them. Kept 90 days (and kept after an endpoint is deleted).
 */
export function ActivityLog({
  endpointId,
  onEndpoint,
}: {
  endpointId: number | null;
  /** null = every endpoint. */
  onEndpoint: (id: number | null) => void;
}) {
  const endpoints = useSharedEndpoints();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const items = endpoints.data ?? [];
  const chosen: number | "all" = endpointId ?? "all";
  const activity = useSharedActivity(chosen, { page, status });
  const data = activity.data;
  const lastPage = data ? Math.max(1, Math.ceil(data.total / Math.max(1, data.pageSize))) : 1;

  return (
    <AnchorSection
      id="activity-log"
      title="Activity"
      purpose="Every call that reached an endpoint, newest first: when, what the answer was, which key, which website and which address it came from. The log is kept for 90 days. Use it to see who uses an endpoint and to spot refused calls."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="es-activity-endpoint" className="text-xs font-semibold text-gray-700">
            Endpoint
          </label>
          <select
            id="es-activity-endpoint"
            className={SELECT_CLASS}
            value={chosen}
            onChange={(e) => {
              setPage(1);
              onEndpoint(e.target.value === "all" ? null : Number(e.target.value));
            }}
          >
            <option value="all">All endpoints</option>
            {items.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} (/api/shared/{e.slug})
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="es-activity-status" className="text-xs font-semibold text-gray-700">
            Result
          </label>
          <select
            id="es-activity-status"
            className={SELECT_CLASS}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {activity.isLoading ? (
        <Skeleton className="h-40 w-full rounded-xl" data-testid="activity-loading" />
      ) : activity.isError || !data ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-xl bg-red-50 p-4 text-sm text-red-800"
          data-testid="activity-error"
        >
          The activity could not be loaded.
          <Button size="sm" variant="outline" onClick={() => void activity.refetch()}>
            Try again
          </Button>
        </div>
      ) : data.rows.length === 0 ? (
        <p className="text-sm text-slate-500" data-testid="activity-empty">
          {status
            ? "No call with that result in the last 90 days."
            : items.length === 0
              ? "There is no endpoint yet, so there is no activity."
              : "No call has reached " +
                (chosen === "all" ? "any endpoint" : "this endpoint") +
                " in the last 90 days."}
        </p>
      ) : (
        <div className="space-y-2" data-testid="activity-table">
          <ScrollTable label="Calls to the endpoints" fit>
            <thead>
              <tr>
                {["When", "Endpoint", "Result", "Key", "Website and address"].map((h) => (
                  <th key={h} className={TH}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id} data-testid="activity-row" data-status={r.status}>
                  <td data-label="When" className={TD}>
                    {stamp(r.at, "-")}
                  </td>
                  <td data-label="Endpoint" className={`${TD} font-mono ${WRAP}`}>
                    {r.endpointSlug ?? "-"}
                  </td>
                  <td data-label="Result" className={TD}>
                    <span className="inline-flex flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 sm:justify-start">
                      <Pill tone={tone(r.status)}>{r.status}</Pill>
                      {r.error && <span className={`font-mono text-[11px] text-slate-500 ${WRAP}`}>{r.error}</span>}
                    </span>
                    <span className="block text-[11px] text-slate-500">
                      {r.rows ?? "-"} {r.rows === 1 ? "row" : "rows"},{" "}
                      {r.durationMs !== null ? `${r.durationMs} ms` : "-"}
                    </span>
                  </td>
                  <td data-label="Key" className={`${TD} ${WRAP}`}>
                    {r.keyLabel ? (
                      <>
                        {r.keyLabel}{" "}
                        {r.keyPrefix && <span className="font-mono text-slate-500">uks_{r.keyPrefix}...</span>}
                      </>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td data-label="Website and address" className={TD}>
                    <span className={`block font-mono ${WRAP}`}>{r.origin ?? "none"}</span>
                    <span className={`block font-mono text-[11px] text-slate-500 ${WRAP}`}>from {r.ip ?? "-"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-500" data-testid="activity-page">
              Page {data.page} of {lastPage}: {data.total} {data.total === 1 ? "call" : "calls"} in all
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1"
                disabled={data.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft size={13} /> Newer
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-1"
                disabled={!data.hasMore}
                onClick={() => setPage((p) => p + 1)}
              >
                Older <ChevronRight size={13} />
              </Button>
            </div>
          </div>
        </div>
      )}
    </AnchorSection>
  );
}
