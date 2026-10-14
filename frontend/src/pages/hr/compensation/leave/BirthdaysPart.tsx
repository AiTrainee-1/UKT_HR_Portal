import { useMemo } from "react";
import { Cake, CheckCircle2, Gift, SearchX } from "lucide-react";
import { EmptyNote, KpiTile, SectionCard, SkeletonKpis, SkeletonRows } from "@/components/payroll/kit/parts";
import { LoadError } from "@/components/payroll/panels/issues/panel-kit";
import { errorDetail } from "@/components/payroll/panels/issues/lists";
import { useCompensationBirthdays, type BirthdayRow } from "@/lib/api-client/custom-hooks";
import { ATTENDANCE_STATUS_TONE } from "@/lib/statusTones";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { dateShort, rangeLabel, shiftsText, todayIst, type CompensationUrl } from "../logic";
import { PeriodBar, isPeriod } from "../period";
import { CELL, PersonCell, Pager, StatusChip, SwitchOffNotice, TABLE_HEAD, Notice, usePaged } from "../ui";

type SetUrl = (patch: Partial<CompensationUrl>) => void;

const ATTENDANCE_TEXT: Record<string, string> = {
  present: "Present",
  half_shift: "Half shift",
  absent: "Absent",
  on_leave: "On leave",
  holiday: "Holiday",
};

/** "9:30 - 16:00", or "No punches" (an employee on birthday leave may not come in at all). */
const punchesText = (row: Pick<BirthdayRow, "firstPunch" | "lastPunch">): string =>
  row.firstPunch ? `${row.firstPunch} - ${row.lastPunch ?? "?"}` : "No punches";

/**
 * Compensation Leave C: birthdays. On an employee's birthday they automatically get paid leave for the whole day: present
 * and paid whether they come in, stay absent, work half a day, arrive late or leave early, with no attendance detection.
 * HR does nothing; this lists who has a birthday (Today / Week / Month), who benefits, and what their attendance shows.
 * The year of birth is never shown.
 */
export function BirthdaysPart({ url, setUrl }: { url: CompensationUrl; setUrl: SetUrl }) {
  const today = useMemo(() => todayIst(), []);
  const period = isPeriod(url.bperiod) ? url.bperiod : "today";
  const date = url.bdate || today;
  const query = useCompensationBirthdays({ period, date });
  const data = query.data;
  const rows = useMemo(() => data?.results ?? [], [data]);
  const paged = usePaged(rows, `bd|${period}|${date}|${rows.length}`);
  const applied = rows.filter((r) => r.applied).length;
  const master = data?.enabled.master ?? true;

  return (
    <div className="space-y-4" data-testid="birthdays-part">
      {data && master && !data.enabled.birthday && (
        <SwitchOffNotice testId="birthday-off" title="Birthday leave is switched off." setting="birthday-enabled">
          Nobody gets it right now. The birthdays below stay readable, but none is marked as a paid leave.
        </SwitchOffNotice>
      )}

      <Notice accent="blue" testId="birthday-how">
        <p>
          <strong>Automatic: HR does nothing.</strong> On their birthday a staff member gets paid compensation leave for
          the whole day, whether they attend, stay absent, work half a day, arrive late or leave early: no Late, Early
          Out or half-day detection applies. A Sunday, a holiday or an off Saturday is already a day off, so it adds
          nothing. The year of birth is never shown here.
          {data?.enabled.effectiveFrom && (
            <>
              {" "}
              It applies from <strong>{dateShort(data.enabled.effectiveFrom)}</strong>: earlier days are never changed.
            </>
          )}
        </p>
      </Notice>

      <PeriodBar
        period={period}
        date={date}
        today={today}
        onPeriod={(next) => setUrl({ bperiod: next })}
        onDate={(next) => setUrl({ bdate: next === today ? "" : next })}
        testId="birthday-period"
      />

      {query.isLoading ? (
        <SkeletonKpis count={3} className="md:grid-cols-3 xl:grid-cols-3" />
      ) : data ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="birthday-kpis">
          <KpiTile
            testId="birthday-kpi-count"
            label="Birthdays"
            value={data.count}
            sub={rangeLabel(data.from, data.to)}
            icon={Cake}
            tone="bg-pink-50 text-pink-800"
          />
          <KpiTile
            testId="birthday-kpi-benefit"
            label="Get the paid leave"
            value={data.benefitCount}
            sub={
              data.count - data.benefitCount > 0
                ? `${data.count - data.benefitCount} do not (see the reason)`
                : "everyone listed"
            }
            icon={Gift}
            tone="bg-emerald-50 text-emerald-800"
          />
          <KpiTile
            testId="birthday-kpi-applied"
            label="Already marked in attendance"
            value={applied}
            sub="the day carries the birthday marker"
            icon={CheckCircle2}
            tone="bg-indigo-50 text-indigo-800"
          />
        </div>
      ) : null}

      <SectionCard
        testId="birthday-list"
        icon={Cake}
        title="Who has a birthday"
        description="Staff only, as of the period you chose."
        bodyClassName="space-y-3 px-0 pb-0"
        actions={
          data ? <span className="text-xs text-muted-foreground">{rangeLabel(data.from, data.to)}</span> : undefined
        }
      >
        {query.isLoading ? (
          <div className="px-5 pb-5">
            <SkeletonRows rows={3} />
          </div>
        ) : query.isError && !data ? (
          <div className="px-5 pb-5">
            <LoadError
              what="the birthdays"
              detail={errorDetail(query.error)}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
              testId="birthday-error"
            />
          </div>
        ) : rows.length === 0 ? (
          <div className="px-5 pb-5">
            <EmptyNote
              icon={SearchX}
              title={`No birthday ${period === "today" ? "today" : period === "week" ? "this week" : "this month"}`}
              hint="Pick another day, week or month with the buttons above."
              testId="birthday-empty"
            />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto" {...{ [VIEW_SAFE_ATTR]: "" }}>
              <table className="w-full min-w-[860px] text-sm" data-testid="birthday-table">
                <thead className={TABLE_HEAD}>
                  <tr>
                    <th className="px-3 py-2.5 pl-5">Employee</th>
                    <th className="px-3 py-2.5">Birthday</th>
                    <th className="px-3 py-2.5">Benefits?</th>
                    <th className="px-3 py-2.5">Attendance</th>
                    <th className="px-3 py-2.5">Marked</th>
                    <th className="px-3 py-2.5">Punches</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {paged.rows.map((row) => (
                    <tr
                      key={`${row.employeeId}-${row.birthday}`}
                      data-testid={`birthday-row-${row.employeeCode}`}
                      data-benefits={row.benefits}
                    >
                      <td className={`${CELL} pl-5`}>
                        <PersonCell name={row.employeeName} code={row.employeeCode} department={row.department} />
                      </td>
                      <td className={CELL}>
                        <p className="whitespace-nowrap font-semibold">{dateShort(row.birthday)}</p>
                        <p className="text-[11px] text-muted-foreground">{row.weekday}</p>
                      </td>
                      <td className={CELL}>
                        <StatusChip tone={row.benefits ? "success" : "neutral"}>
                          {row.benefits ? "Yes: paid leave" : "No"}
                        </StatusChip>
                        {!row.benefits && row.reason && (
                          <p
                            className="mt-1 max-w-xs text-[11px] leading-snug text-muted-foreground"
                            data-testid={`birthday-reason-${row.employeeCode}`}
                          >
                            {row.reason}
                          </p>
                        )}
                      </td>
                      <td className={CELL}>
                        {row.attendanceStatus ? (
                          <StatusChip tone={ATTENDANCE_STATUS_TONE[row.attendanceStatus] ?? "neutral"}>
                            {ATTENDANCE_TEXT[row.attendanceStatus] ?? row.attendanceStatus}
                          </StatusChip>
                        ) : (
                          <span className="text-xs text-muted-foreground">Not computed yet</span>
                        )}
                        {row.shiftsEarned !== null && (
                          <p className="mt-1 text-[11px] text-muted-foreground">{shiftsText(row.shiftsEarned)}</p>
                        )}
                      </td>
                      <td className={CELL}>
                        {row.applied ? (
                          <StatusChip tone="success">Birthday marked</StatusChip>
                        ) : (
                          <span className="text-xs text-muted-foreground">{row.benefits ? "Not yet" : "—"}</span>
                        )}
                      </td>
                      <td className={`${CELL} whitespace-nowrap text-gray-600`}>{punchesText(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager paged={paged} />
          </>
        )}
      </SectionCard>
    </div>
  );
}
