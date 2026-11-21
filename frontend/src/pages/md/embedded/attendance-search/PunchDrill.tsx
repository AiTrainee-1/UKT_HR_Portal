import { describeMdError, useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { dayShort, num, pct } from "@/lib/md/format";
import DetailSheet, { DetailList, DetailRow } from "../shared/DetailSheet";
import { employeeAddress, useOpenInPage } from "../shared/jump";
import type { EmployeePunchDay, EmployeePunches, PunchDevices, PunchDrill, PunchManual, PunchMissing } from "./types";

const WHEN_KEYS = ["period", "month", "from", "to"];
const whenOf = (params: MdQueryParams) =>
  Object.fromEntries(Object.entries(params).filter(([k]) => WHEN_KEYS.includes(k)));

type Props = { params: MdQueryParams; where: string; onClose: () => void };
type PersonClick = (employeeId: number, name: string) => void;

/** "09:00 IN Biometric (Line 2) · 18:02 OUT HR Entry". */
export function punchLine(day: EmployeePunchDay): string {
  const punches = day.punches.map((p) => `${p.time.slice(0, 5)} ${p.type} ${p.device ?? p.label}`);
  const held = day.held.map(
    (h) => `${h.time.slice(0, 5)} ${h.type} On-Duty ${h.status === "pending" ? "(waiting for HR)" : "(turned down)"}`,
  );
  return [...punches, ...held].join(" · ") || "No punch";
}

function MissingSheet({ params, where, onClose, onPerson }: Props & { onPerson: PersonClick }) {
  const query = useMdQuery<PunchMissing>("punches/missing", { ...params, limit: 25 });
  const data = query.data;
  return (
    <DetailSheet
      open
      onClose={onClose}
      testId="md-punch-drill"
      title="Who keeps missing a punch"
      subtitle={
        data
          ? `${num(data.days)} days with a punch missing · ${num(data.total)} people missed one on several days`
          : undefined
      }
      loading={query.isPending}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      empty={data && data.rows.length === 0 ? "Nobody has missed punches on several days." : null}
      ask={`Who keeps missing a punch (${where}), and do they ask for a correction?`}
    >
      {data && (
        <DetailList testId="md-punch-drill-missing">
          {data.rows.map((r) => (
            <DetailRow
              key={r.employeeId}
              testId={`md-punch-drill-person-${r.employeeId}`}
              primary={r.employeeName}
              secondary={[r.employeeCode, r.department, r.unit].filter(Boolean).join(" · ")}
              value={`${num(r.missingDays)} days · ${num(r.requestsRaised)} asked`}
              onClick={() => onPerson(r.employeeId, r.employeeName)}
            />
          ))}
        </DetailList>
      )}
    </DetailSheet>
  );
}

function ManualSheet({ params, where, onClose, onPerson }: Props & { onPerson: PersonClick }) {
  const query = useMdQuery<PunchManual>("punches/manual", { ...params, limit: 25 });
  const data = query.data;
  return (
    <DetailSheet
      open
      onClose={onClose}
      testId="md-punch-drill"
      title="Punches entered by hand"
      subtitle="Who has the most punches typed in by HR or corrected afterwards"
      loading={query.isPending}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      empty={data && data.byEmployee.length === 0 ? "No punch was entered by hand." : null}
      ask={`Why are punches entered by hand (${where}), and for whom?`}
    >
      {data && (
        <div className="space-y-3">
          <DetailList testId="md-punch-drill-manual">
            {data.byEmployee.map((r) => (
              <DetailRow
                key={r.employeeId}
                testId={`md-punch-drill-person-${r.employeeId}`}
                primary={r.employeeName}
                secondary={[r.employeeCode, r.department].filter(Boolean).join(" · ")}
                value={`${num(r.manualPunches)} on ${num(r.days)} days`}
                onClick={() => onPerson(r.employeeId, r.employeeName)}
              />
            ))}
          </DetailList>
          {data.byDepartment.length > 0 && (
            <>
              <h4 className="md-analytics-subhead">By department</h4>
              <DetailList>
                {data.byDepartment.map((d) => (
                  <DetailRow
                    key={d.label}
                    primary={d.label}
                    secondary={`${num(d.punches)} punches`}
                    value={d.sharePct != null ? pct(d.sharePct) : num(d.handEntered)}
                  />
                ))}
              </DetailList>
            </>
          )}
        </div>
      )}
    </DetailSheet>
  );
}

function DevicesSheet({ params, where, onClose }: Props) {
  const query = useMdQuery<PunchDevices>("punches/devices", { ...params, limit: 25 });
  const data = query.data;
  return (
    <DetailSheet
      open
      onClose={onClose}
      testId="md-punch-drill"
      title="Biometric devices"
      subtitle={data ? `${num(data.reporting)} of ${num(data.listed)} sending · silent first` : undefined}
      loading={query.isPending}
      error={query.isError ? describeMdError(query.error) : null}
      onRetry={() => void query.refetch()}
      empty={data && data.rows.length === 0 ? "No device sent punches for this selection." : null}
      ask={`Are all the biometric devices sending (${where})? Which one needs attention?`}
    >
      {data && (
        <DetailList testId="md-punch-drill-devices">
          {data.rows.map((d) => (
            <DetailRow
              key={d.key}
              testId={`md-punch-drill-device-${d.key}`}
              primary={d.label}
              secondary={d.statusText}
              value={`${num(d.punches)} punches`}
              tone={d.silent ? "md-analytics-tone-bad" : undefined}
            />
          ))}
        </DetailList>
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
}: Props & { drill: Extract<PunchDrill, { kind: "employee" }>; onBack?: () => void }) {
  const open = useOpenInPage();
  const query = useMdQuery<EmployeePunches>(`punches/employee/${drill.employeeId}`, whenOf(params));
  const data = query.data;
  const t = data?.totals;
  return (
    <DetailSheet
      open
      onClose={onClose}
      testId="md-punch-drill"
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
      empty={data && data.days.length === 0 ? "No punch in this period." : null}
      ask={`How do ${drill.name}'s punches arrive (${where})? Any missing or hand-entered ones?`}
      openLabel="Open their record"
      onOpen={() => open(employeeAddress(drill.employeeId))}
    >
      {onBack && (
        <button
          type="button"
          className="mb-3 text-xs font-semibold text-md-wine underline-offset-2 hover:underline"
          onClick={onBack}
          data-testid="md-punch-drill-back"
        >
          Back to the list
        </button>
      )}
      {data && t && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2" data-testid="md-punch-drill-totals">
            {(
              [
                ["Punches", num(t.punches)],
                ["Days", num(t.days)],
                ["Odd days", num(t.oddDays)],
                ["By hand", t.handEnteredPct != null ? pct(t.handEnteredPct) : num(t.handEntered)],
                ["On-Duty waiting", num(t.heldPending)],
                ["Requests", num(t.requests)],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="md-analytics-stat">
                <p className="md-analytics-stat-value">{value}</p>
                <p className="md-analytics-stat-label">{label}</p>
              </div>
            ))}
          </div>
          <DetailList testId="md-punch-drill-days">
            {data.days.map((day) => (
              <DetailRow
                key={day.date}
                testId={`md-punch-drill-day-${day.date}`}
                primary={`${dayShort(day.date)}${day.odd ? " · a punch is missing" : ""}${day.request ? ` · request ${day.request.replace("_", " ")}` : ""}`}
                secondary={punchLine(day)}
                value={num(day.count)}
                tone={day.odd ? "md-analytics-tone-watch" : undefined}
              />
            ))}
          </DetailList>
        </div>
      )}
    </DetailSheet>
  );
}

/** The drill-down of the Attendance Search Insights, in a side sheet over the tab. */
export default function PunchDrillSheet({
  drill,
  onDrill,
  ...rest
}: Props & { drill: PunchDrill | null; onDrill: (next: PunchDrill) => void }) {
  if (!drill) return null;
  const toPerson = (back: PunchDrill) => (employeeId: number, name: string) =>
    onDrill({ kind: "employee", employeeId, name, back });
  if (drill.kind === "missing") return <MissingSheet key="missing" onPerson={toPerson(drill)} {...rest} />;
  if (drill.kind === "manual") return <ManualSheet key="manual" onPerson={toPerson(drill)} {...rest} />;
  if (drill.kind === "devices") return <DevicesSheet key="devices" {...rest} />;
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
