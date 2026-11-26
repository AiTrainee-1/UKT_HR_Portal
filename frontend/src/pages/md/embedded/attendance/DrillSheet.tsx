import { useState } from "react";
import { describeMdError, useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { dayShort, num, pct } from "@/lib/md/format";
import { countedAfterLabel, inProgressPunchText, isInProgress } from "@/lib/day-progress";
import DetailSheet, { DetailList, DetailRow } from "../shared/DetailSheet";
import { employeeAddress, useOpenInPage } from "../shared/jump";
import { boardLabel, PAGE_OF, PEOPLE_TITLE, personLine, type AttendanceKind } from "./logic";
import type { Drill, EmployeeDay, EmployeeDaysResponse, PeopleResponse, TodayPeopleResponse } from "./types";

const PAGE_SIZE = 25;
const WHEN_KEYS = ["period", "month", "from", "to"];
const SCOPE_KEYS = ["branch", "department", "type"];

const pick = (params: MdQueryParams, keys: string[]) =>
  Object.fromEntries(Object.entries(params).filter(([k]) => keys.includes(k)));

const peopleText = (n: number) => `${num(n)} ${n === 1 ? "person" : "people"}`;
const daysText = (n: number) => `${num(n)} ${n === 1 ? "day" : "days"}`;

/** The tone a day reads in: crimson absent, ochre a deduction or late, sage worked, plain the rest. */
export function dayTone(day: EmployeeDay): string {
  if (isInProgress(day)) return "md-analytics-tone-neutral";
  if (day.label === "Absent" || day.label === "No record") return "md-analytics-tone-bad";
  if (day.quarterOff || day.penaltyEarlyOut || day.late) return "md-analytics-tone-watch";
  if (day.label === "Present" || day.label === "Half day") return "md-analytics-tone-good";
  return "md-analytics-tone-neutral";
}

/** "09:40–18:02 · late 40 min · 0.25 off (after the Late window) · Biometric". */
export function dayDetail(day: EmployeeDay): string {
  // today, while the shift is still running: only the first punch counts so far (owner 2026-11-26)
  if (isInProgress(day)) return `${inProgressPunchText(day.firstPunch)} · ${countedAfterLabel(day.provisionalUntil)}`;
  const span = day.firstPunch
    ? `${day.firstPunch}${day.lastPunch && day.lastPunch !== day.firstPunch ? `–${day.lastPunch}` : ""}`
    : null;
  return [
    span,
    day.late ? (day.lateMinutes != null ? `late ${day.lateMinutes} min` : "late") : null,
    day.quarterOff ? "0.25 off (after the Late window)" : null,
    day.penaltyEarlyOut ? `Penalty Early Out (${day.earlyOutMinutes ?? 0} min early)` : null,
    day.source ?? null,
    day.manual ? "set by HR" : null,
    day.dataGap ? "no punches arrived that day" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

type SheetProps = { params: MdQueryParams; kind: AttendanceKind; where: string; onClose: () => void };

function PeopleSheet({
  drill,
  params,
  kind,
  where,
  onClose,
  onPerson,
}: SheetProps & { drill: Extract<Drill, { kind: "people" }>; onPerson: (id: number, name: string) => void }) {
  const [page, setPage] = useState(1);
  const query = useMdQuery<PeopleResponse>("attendance/people", {
    ...params,
    ...(drill.branch ? { branch: drill.branch } : {}),
    ...(drill.department ? { department: drill.department } : {}),
    ...(drill.day ? { day: drill.day } : {}),
    metric: drill.metric,
    page,
    pageSize: PAGE_SIZE,
  });
  const data = query.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const span = data?.window ? ` · ${dayShort(data.window.start)} to ${dayShort(data.window.end)}` : "";
  return (
    <DetailSheet
      open
      onClose={onClose}
      testId="md-att-drill"
      title={drill.title ?? PEOPLE_TITLE[drill.metric]}
      subtitle={data ? `${peopleText(data.total)}, ${daysText(data.totalDays)}${span}` : undefined}
      loading={query.isPending}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      empty={data && data.total === 0 ? "Nobody in this selection." : null}
      ask={`Who are behind "${PEOPLE_TITLE[drill.metric].toLowerCase()}" among ${PAGE_OF[kind].noun}${drill.department ? ` in ${drill.department}` : ""} (${where}), and what should I do about it?`}
    >
      {data && (
        <div className="space-y-3">
          <DetailList testId="md-att-drill-people">
            {data.rows.map((r) => (
              <DetailRow
                key={r.employeeId}
                testId={`md-att-drill-person-${r.employeeId}`}
                primary={r.name}
                secondary={[r.code, r.department, r.unit].filter(Boolean).join(" · ")}
                value={personLine(r.days, r.attendancePct, r.avgLateMinutes)}
                onClick={() => onPerson(r.employeeId, r.name)}
              />
            ))}
          </DetailList>
          {pages > 1 && (
            <div className="flex items-center justify-between gap-2 text-xs font-semibold text-md-ink-soft">
              <button
                type="button"
                className="md-btn h-9 rounded-lg px-3 disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </button>
              <span>
                Page {page} of {pages}
              </span>
              <button
                type="button"
                className="md-btn h-9 rounded-lg px-3 disabled:opacity-40"
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
                data-testid="md-att-drill-next"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </DetailSheet>
  );
}

function EmployeeSheet({
  drill,
  params,
  where,
  onClose,
  onBack,
}: SheetProps & { drill: Extract<Drill, { kind: "employee" }>; onBack?: () => void }) {
  const open = useOpenInPage();
  const query = useMdQuery<EmployeeDaysResponse>(`attendance/employee/${drill.employeeId}`, pick(params, WHEN_KEYS));
  const data = query.data;
  const t = data?.totals;
  return (
    <DetailSheet
      open
      onClose={onClose}
      testId="md-att-drill"
      wide
      title={drill.name}
      subtitle={
        data
          ? [data.employee.code, data.employee.department, data.employee.unit].filter(Boolean).join(" · ")
          : undefined
      }
      loading={query.isPending}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      empty={data && data.days.length === 0 ? "No completed day with a record in this period." : null}
      ask={`How has ${drill.name}'s attendance been (${where})? Anything unusual?`}
      openLabel="Open their record"
      onOpen={() => open(employeeAddress(drill.employeeId))}
    >
      {onBack && (
        <button
          type="button"
          className="mb-3 text-xs font-semibold text-md-wine underline-offset-2 hover:underline"
          onClick={onBack}
          data-testid="md-att-drill-back"
        >
          Back to the list
        </button>
      )}
      {data && t && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2" data-testid="md-att-drill-totals">
            {(
              [
                ["Attendance", t.attendancePct != null ? pct(t.attendancePct) : "—"],
                ["Absent", num(t.absent)],
                ["Late", num(t.late)],
                ["Half days", num(t.half)],
                ["0.25 off / Penalty", `${num(t.quarterDays)} / ${num(t.penaltyEarlyOuts)}`],
                ["Shifts earned", num(t.shiftsEarned, 2)],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="md-analytics-stat">
                <p className="md-analytics-stat-value">{value}</p>
                <p className="md-analytics-stat-label">{label}</p>
              </div>
            ))}
          </div>
          <DetailList testId="md-att-drill-days">
            {data.days.map((day) => (
              <DetailRow
                key={day.date}
                testId={`md-att-drill-day-${day.date}`}
                primary={`${dayShort(day.date)} · ${isInProgress(day) ? "In progress" : day.label}`}
                secondary={dayDetail(day) || undefined}
                value={isInProgress(day) ? "—" : day.shiftsEarned != null ? num(day.shiftsEarned, 2) : undefined}
                tone={dayTone(day)}
              />
            ))}
          </DetailList>
        </div>
      )}
    </DetailSheet>
  );
}

function TodaySheet({ drill, params, kind, onClose }: SheetProps & { drill: Extract<Drill, { kind: "today" }> }) {
  const open = useOpenInPage();
  const query = useMdQuery<TodayPeopleResponse>("attendance/today-people", {
    ...pick(params, SCOPE_KEYS),
    state: drill.state,
    limit: 200,
  });
  const data = query.data;
  return (
    <DetailSheet
      open
      onClose={onClose}
      testId="md-att-drill"
      title={`Today: ${boardLabel(drill.state)}`}
      subtitle={data ? `${peopleText(data.total)} so far today (provisional)` : undefined}
      loading={query.isPending}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      empty={data && data.total === 0 ? "Nobody on this card right now." : null}
      ask={`Who is on "${boardLabel(drill.state)}" today among ${PAGE_OF[kind].noun}, and is anything unusual?`}
      openLabel={`Open ${PAGE_OF[kind].title}`}
      onOpen={() => open(kind === "staff" ? "/md/attendance/staff" : "/md/attendance/production")}
    >
      {data && (
        <DetailList testId="md-att-drill-today">
          {data.rows.map((r) => (
            <DetailRow
              key={r.employeeId}
              testId={`md-att-drill-today-${r.employeeId}`}
              primary={r.name}
              secondary={[r.code, r.department, r.unit].filter(Boolean).join(" · ")}
              value={r.firstPunch ?? undefined}
            />
          ))}
        </DetailList>
      )}
    </DetailSheet>
  );
}

/** The drill-down of the Attendance Insights: whatever was clicked, in a side sheet over the tab (the tab stays). */
export default function DrillSheet({
  drill,
  onDrill,
  ...rest
}: SheetProps & { drill: Drill | null; onDrill: (next: Drill) => void }) {
  if (!drill) return null;
  if (drill.kind === "people") {
    return (
      <PeopleSheet
        key={`p-${drill.metric}-${drill.department ?? ""}-${drill.branch ?? ""}-${drill.day ?? ""}`}
        drill={drill}
        onPerson={(employeeId, name) => onDrill({ kind: "employee", employeeId, name, back: drill })}
        {...rest}
      />
    );
  }
  if (drill.kind === "employee") {
    const back = drill.back;
    return (
      <EmployeeSheet
        key={`e-${drill.employeeId}`}
        drill={drill}
        onBack={back ? () => onDrill(back) : undefined}
        {...rest}
      />
    );
  }
  return <TodaySheet key={`t-${drill.state}`} drill={drill} {...rest} />;
}
