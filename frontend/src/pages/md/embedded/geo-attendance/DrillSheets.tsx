import { useState } from "react";
import { describeMdError, useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { clockText, dayShort, minutesText, num } from "@/lib/md/format";
import DetailSheet, { DetailList, DetailRow } from "../shared/DetailSheet";
import { employeeAddress, useOpenInPage } from "../shared/jump";
import type { AlertKind, AlertStatus, GeoAlerts, GeoPersonDetail } from "./types";

export type AlertFilter = { kind?: AlertKind; status?: AlertStatus; title: string };

/** When an alert began and ended, short: "02 Sep 10:00 - 10:12", "15 Sep 15:15, still open". */
function alertWhen(detected: string | null, resolved: string | null, open: boolean): string {
  if (!detected) return "";
  const start = `${dayShort(detected)} ${clockText(detected)}`;
  if (open || !resolved) return `${start}, still open`;
  return `${start} to ${resolved.slice(0, 10) === detected.slice(0, 10) ? clockText(resolved) : `${dayShort(resolved)} ${clockText(resolved)}`}`;
}

/** The alert episodes behind a figure (a kind, the open ones, the escalated ones), newest first, a page at a time; a row
 *  opens that person's on-duty month. */
export function AlertsSheet({
  filter,
  params,
  onClose,
  onPerson,
}: {
  filter: AlertFilter | null;
  params: MdQueryParams;
  onClose: () => void;
  onPerson: (employeeId: number) => void;
}) {
  const [page, setPage] = useState(1);
  const [shown, setShown] = useState(filter);
  if (filter && filter !== shown) {
    setShown(filter);
    setPage(1);
  }
  const query = useMdQuery<GeoAlerts>(
    "geo/alerts",
    { ...params, kind: shown?.kind, status: shown?.status ?? "all", page, pageSize: 25 },
    { enabled: !!shown },
  );
  const openPage = useOpenInPage();
  const data = query.data;
  return (
    <DetailSheet
      open={!!filter}
      onClose={onClose}
      title={shown?.title ?? "Automatic alerts"}
      subtitle={
        data ? `${num(data.total)} ${data.total === 1 ? "alert" : "alerts"} · ${data.period?.label ?? ""}` : undefined
      }
      loading={query.isPending}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      empty={data && data.total === 0 ? "No automatic alert matches this selection." : null}
      openLabel="Open the Live Map"
      onOpen={() => openPage("/md/geo-attendance/live-map")}
      ask={`Explain the automatic On-Duty alerts "${shown?.title ?? ""}" (${data?.period?.label ?? "this period"}): who, why, and was it fixed?`}
      testId="md-geo-alerts-sheet"
      wide
    >
      {data && (
        <>
          <DetailList testId="md-geo-alerts-rows">
            {data.rows.map((a) => (
              <DetailRow
                key={a.id}
                testId={`md-geo-alert-${a.id}`}
                primary={`${a.employeeName} · ${a.kindLabel}`}
                secondary={[
                  alertWhen(a.detectedAt, a.resolvedAt, a.open),
                  a.resolution,
                  a.escalated ? `HOD told${a.departmentHead ? `: ${a.departmentHead}` : ""}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                value={a.open ? "Open" : minutesText(a.minutes)}
                tone={a.open ? "md-analytics-tone-bad" : a.escalated ? "md-analytics-tone-watch" : undefined}
                onClick={() => onPerson(a.employeeId)}
              />
            ))}
          </DetailList>
          {data.pages > 1 && (
            <div className="flex items-center justify-between gap-2 text-xs text-md-ink-soft">
              <button
                type="button"
                className="md-btn h-9 rounded-lg px-3 font-semibold disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span>
                Page {num(data.page)} of {num(data.pages)}
              </span>
              <button
                type="button"
                className="md-btn h-9 rounded-lg px-3 font-semibold disabled:opacity-40"
                disabled={page >= data.pages}
                onClick={() => setPage((p) => p + 1)}
                data-testid="md-geo-alerts-next"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </DetailSheet>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="md-analytics-stat">
      <p className="md-analytics-stat-value">{value}</p>
      <p className="md-analytics-stat-label">{label}</p>
    </div>
  );
}

/** One employee's on-duty month: their sessions with the punches HR decided and the journey the app recorded, and their
 *  automatic alerts. Ways on: the employee's record, and the Journeys tab of the page. */
export function PersonSheet({
  employeeId,
  params,
  onClose,
}: {
  employeeId: number | null;
  params: MdQueryParams;
  onClose: () => void;
}) {
  const [shown, setShown] = useState(employeeId);
  if (employeeId != null && employeeId !== shown) setShown(employeeId);
  const query = useMdQuery<GeoPersonDetail>("geo/person", { ...params, employee: shown }, { enabled: shown != null });
  const openPage = useOpenInPage();
  const data = query.data && query.data.employee.id === shown ? query.data : undefined;
  const t = data?.totals;
  return (
    <DetailSheet
      open={employeeId != null}
      onClose={onClose}
      title={data?.employee.employeeName ?? "Employee"}
      subtitle={
        data
          ? [data.employee.employeeCode, data.employee.department, data.employee.unit, data.period?.label]
              .filter(Boolean)
              .join(" · ")
          : undefined
      }
      loading={!data && !query.isError}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      openLabel="Open the employee's record"
      onOpen={shown != null ? () => openPage(employeeAddress(shown)) : undefined}
      ask={
        data
          ? `Summarise ${data.employee.employeeName}'s on-duty work (${data.period?.label ?? "this period"}): sessions, punches, distance and alerts. Is anything unusual?`
          : undefined
      }
      testId="md-geo-person-sheet"
      wide
    >
      {data && t && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2" data-testid="md-geo-person-totals">
            <Tile label="Sessions" value={num(t.sessions)} />
            <Tile label="Punches verified" value={`${num(t.verified)} / ${num(t.punches)}`} />
            <Tile label="Distance" value={`${num(t.km, 1)} km`} />
            <Tile label="Rejected" value={num(t.rejected)} />
            <Tile label="Waiting" value={num(t.pending)} />
            <Tile label="Alerts" value={num(t.alerts)} />
          </div>
          <div>
            <h4 className="md-analytics-subhead">Sessions</h4>
            {data.sessions.length === 0 ? (
              <p className="md-analytics-note">No on-duty session in this period.</p>
            ) : (
              <DetailList testId="md-geo-person-sessions">
                {data.sessions.map((x, i) => (
                  <DetailRow
                    key={`${x.date}-${i}`}
                    primary={`${dayShort(x.date)} · ${x.destination || "No destination"}`}
                    secondary={[
                      `${num(x.punches)} ${x.punches === 1 ? "punch" : "punches"} (${num(x.verified)} verified${x.rejected ? `, ${num(x.rejected)} rejected` : ""}${x.pending ? `, ${num(x.pending)} waiting` : ""})`,
                      x.tracked
                        ? `${num(x.km, 1)} km, ${num(x.stops)} stops${x.gapHours ? `, ${num(x.gapHours, 1)} h gap` : ""}`
                        : "not tracked",
                      x.ended,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    value={x.mockPoints ? "Simulated GPS" : undefined}
                    tone={x.mockPoints ? "md-analytics-tone-bad" : undefined}
                  />
                ))}
              </DetailList>
            )}
          </div>
          {data.alerts.length > 0 && (
            <div>
              <h4 className="md-analytics-subhead">Automatic alerts</h4>
              <DetailList testId="md-geo-person-alerts">
                {data.alerts.map((a, i) => (
                  <DetailRow
                    key={`${a.detectedAt}-${i}`}
                    primary={a.kindLabel}
                    secondary={[alertWhen(a.detectedAt, a.resolvedAt, !a.resolvedAt), a.resolution]
                      .filter(Boolean)
                      .join(" · ")}
                    value={a.escalated ? "HOD told" : undefined}
                    tone={a.escalated ? "md-analytics-tone-watch" : undefined}
                  />
                ))}
              </DetailList>
            </div>
          )}
          <button
            type="button"
            className="md-btn inline-flex h-9 items-center rounded-lg px-3 text-xs font-semibold"
            onClick={() => openPage("/md/geo-attendance/journeys")}
            data-testid="md-geo-person-journeys"
          >
            Open the Journeys tab
          </button>
        </div>
      )}
    </DetailSheet>
  );
}
