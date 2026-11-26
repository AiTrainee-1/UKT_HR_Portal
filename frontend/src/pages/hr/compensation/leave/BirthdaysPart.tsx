import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Cake, CalendarCheck2, CalendarClock, CalendarX2, Gift, SearchX } from "lucide-react";
import { SectionCard } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { NestedTabs } from "@/components/ui/nested-tabs";
import { useCompensationBirthdays, type BirthdayOutcome, type BirthdayRow } from "@/lib/api-client/custom-hooks";
import { ATTENDANCE_STATUS_TONE } from "@/lib/statusTones";
import {
  ClearFilters,
  DataTable,
  FilterBar,
  PersonCell,
  SearchFilter,
  SelectFilter,
  StatRow,
  StatTile,
  StatusChip as KitChip,
  type DataColumn,
} from "@/pages/hr/outpass-visitors/kit";
import { dateShort, errorMessage, rangeLabel, shiftsText, todayIst } from "../logic";
import { PeriodBar, isPeriod } from "../period";
import { LEAVE_NESTED, subPath } from "../routes";
import { keepOpenNested, useCanOpen, usePlaceRight } from "../visible";
import { Notice, StatusChip, SwitchOffNotice } from "../ui";
import { BirthdayCompDialog, type BirthdayCompMode } from "./BirthdayCompDialog";
import {
  placementStatusText,
  placementSummary,
  placementTone,
  placementWhenText,
  showsPlacement,
} from "./birthday-comp-logic";
import { OUTCOME_META, OUTCOME_OPTIONS, canPlaceBirthday, outcomeOf, outcomeText } from "./claims-logic";
import { OrgFilters } from "./LeaveFilters";
import { claimLink, idOf, useLeaveUrl } from "./leave-url";

const PAGE_SIZE = 25;

const ATTENDANCE_TEXT: Record<string, string> = {
  present: "Present",
  half_shift: "Half shift",
  absent: "Absent",
  on_leave: "On leave",
  holiday: "Holiday",
};

/** "9:30 - 16:00", or "No punches". */
const punchesText = (row: Pick<BirthdayRow, "firstPunch" | "lastPunch">): string =>
  row.firstPunch ? `${row.firstPunch} - ${row.lastPunch ?? "?"}` : "No punches";

/** "From 19 Nov 2026" for the claims date when it is a date, else the server's own text. */
const fromText = (value: string | null | undefined): string | null =>
  !value ? null : /^\d{4}-\d{2}-\d{2}/.test(value) ? dateShort(value) : value;

/**
 * Compensation Leave C: birthdays, by attendance. From the claims date a birthday is a normal working day: a staff member
 * who is ABSENT (no punch) or ON APPROVED LEAVE that day gets an automatic paid birthday leave (1 shift, no leave used); one
 * who WORKS it (present, or even half a day) gets 1.00 day of Birthday Compensation to place on working days of the
 * birthday month (owner 2026-11-25): a full day, or a first and a second half on two dates, each going to the Department
 * Head and then HR; HR's approval pays that day like Casual Leave and what is not placed lapses when the month ends. A
 * Sunday, a declared holiday or an off Saturday gives nothing. The list shows what each birthday gave (the outcome) and where
 * the compensation was placed, filtered by period, department, branch, name and outcome; HR can choose the date for an
 * employee here. Birthday credit claims raised before stay readable. The year of birth is never shown.
 */
export function BirthdaysPart({ nested }: { nested: string }) {
  const canOpen = useCanOpen();
  const today = useMemo(() => todayIst(), []);
  const [lu, setLu] = useLeaveUrl();
  const period = isPeriod(lu.bperiod) ? lu.bperiod : "today";
  const date = lu.bdate || today;
  const query = useCompensationBirthdays({
    period,
    date,
    departmentId: idOf(lu.bdept),
    branchId: idOf(lu.bbranch),
    q: lu.bq.trim() || undefined,
    outcome: lu.boutcome || undefined,
  });
  const data = query.data;
  const rows = useMemo(() => data?.results ?? [], [data]);
  const [page, setPage] = useState({ key: "", page: 1 });
  const viewKey = `${period}|${date}|${lu.bdept}|${lu.bbranch}|${lu.bq}|${lu.boutcome}|${rows.length}`;
  const current = page.key === viewKey ? page.page : 1;
  const shown = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const [opened, setOpened] = useState<{ row: BirthdayRow; mode: BirthdayCompMode } | null>(null);
  const master = data?.enabled.master ?? true;
  const claimsFrom = fromText(data?.enabled.claimsFrom);
  // placing Birthday Compensation for an employee needs Edit on Leave > Birthdays (the server refuses anybody else)
  const { reason: rightProblem } = usePlaceRight();

  // the figures: the server's count per outcome (before the outcome filter) when it sends it, else the rows on screen
  const byOutcome = useMemo(() => {
    const counted: Partial<Record<BirthdayOutcome, number>> = {};
    for (const r of rows) counted[outcomeOf(r)] = (counted[outcomeOf(r)] ?? 0) + 1;
    return { ...counted, ...(data?.summary?.byOutcome ?? {}) };
  }, [rows, data]);
  const n = (...outcomes: BirthdayOutcome[]) => outcomes.reduce((t, o) => t + (byOutcome[o] ?? 0), 0);
  const filtersOn = [lu.bdept, lu.bbranch, lu.bq, lu.boutcome].filter((v) => v !== "").length;
  const outcomeFilter = (outcome: BirthdayOutcome) => setLu({ boutcome: lu.boutcome === outcome ? "" : outcome });

  const columns = useMemo<DataColumn<BirthdayRow>[]>(
    () => [
      {
        key: "employee",
        header: "Employee",
        cell: (r) => (
          <div data-testid={`birthday-row-${r.employeeCode}`} data-outcome={outcomeOf(r)}>
            <PersonCell name={r.employeeName} code={r.employeeCode} sub={r.department} size={28} />
          </div>
        ),
        text: (r) => `${r.employeeName} (${r.employeeCode})`,
        minWidth: 180,
        truncate: false,
      },
      {
        key: "birthday",
        header: "Birthday",
        cell: (r) => (
          <div className="leading-tight">
            <p className="font-semibold text-slate-900">{dateShort(r.birthday)}</p>
            <p className="text-[11px] text-slate-500">{r.weekday}</p>
          </div>
        ),
        minWidth: 110,
      },
      {
        key: "outcome",
        header: "What it gave",
        truncate: false,
        minWidth: 200,
        cell: (r) => {
          const o = outcomeOf(r);
          const meta = OUTCOME_META[o];
          const block = r.birthdayCompensation;
          return (
            <div className="flex max-w-xs flex-col items-start gap-0.5">
              <KitChip tone={meta.tone} testId={`birthday-outcome-${r.employeeCode}`}>
                {outcomeText(r)}
              </KitChip>
              {showsPlacement(block) && (
                <div className="space-y-0.5" data-testid={`birthday-placement-${r.employeeCode}`}>
                  <p className="text-[11px] font-semibold leading-snug text-slate-700">{placementSummary(block)}</p>
                  {block.uses.length > 0 && (
                    <ul className="space-y-0.5">
                      {block.uses.map((u) => (
                        <li
                          key={u.id}
                          className="flex flex-wrap items-center gap-1 text-[11px] text-slate-600"
                          data-testid={`birthday-use-${u.id}`}
                        >
                          <span className="font-medium">{placementWhenText(u)}</span>
                          <KitChip tone={placementTone(u)} className="px-1.5 py-0 text-[10px]">
                            {placementStatusText(u)}
                          </KitChip>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {r.reason && (
                <span
                  className="whitespace-normal text-[11px] leading-snug text-slate-500"
                  data-testid={`birthday-reason-${r.employeeCode}`}
                >
                  {r.reason}
                </span>
              )}
              {r.claim && (
                <Link
                  href={claimLink(r.claim.id, r.employeeId)}
                  className="text-[11px] font-semibold text-indigo-700 underline-offset-2 hover:underline"
                  data-testid={`birthday-claim-${r.employeeCode}`}
                >
                  Open the claim
                </Link>
              )}
            </div>
          );
        },
      },
      {
        key: "attendance",
        header: "Attendance",
        truncate: false,
        cell: (r) => (
          <div className="flex flex-col items-start gap-0.5">
            {r.attendanceStatus ? (
              <StatusChip tone={ATTENDANCE_STATUS_TONE[r.attendanceStatus] ?? "neutral"}>
                {ATTENDANCE_TEXT[r.attendanceStatus] ?? r.attendanceStatus}
              </StatusChip>
            ) : (
              <span className="text-xs text-slate-500">Not computed yet</span>
            )}
            <span className="text-[11px] text-slate-500">
              {punchesText(r)}
              {r.shiftsEarned !== null ? ` · ${shiftsText(r.shiftsEarned)}` : ""}
            </span>
          </div>
        ),
      },
      {
        key: "actions",
        header: <span className="sr-only">Actions</span>,
        align: "right",
        truncate: false,
        cell: (r) =>
          canPlaceBirthday(r) ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-11 sm:h-8"
              disabled={!!rightProblem}
              title={
                rightProblem ??
                `Choose date for employee: place the birthday compensation of ${r.employeeName} on a day of the birthday month and send it to the Department Head`
              }
              onClick={() => setOpened({ row: r, mode: "place" })}
              data-testid={`birthday-place-button-${r.employeeCode}`}
            >
              Choose date for employee
            </Button>
          ) : showsPlacement(r.birthdayCompensation) && r.birthdayCompensation.uses.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-11 sm:h-8"
              title={`See where the birthday compensation of ${r.employeeName} was placed`}
              onClick={() => setOpened({ row: r, mode: "view" })}
              data-view-safe=""
              data-testid={`birthday-view-button-${r.employeeCode}`}
            >
              See placements
            </Button>
          ) : null,
      },
    ],
    [rightProblem],
  );

  return (
    <div className="space-y-4" data-testid="birthdays-part">
      {data && master && !data.enabled.birthday && (
        <SwitchOffNotice testId="birthday-off" title="Birthday leave is switched off." setting="birthday-enabled">
          Nobody gets it right now: no paid birthday leave and no new birthday compensation. The birthdays below stay
          readable.
        </SwitchOffNotice>
      )}

      <NestedTabs
        base={subPath("leave", "birthdays")}
        value={nested}
        testId="birthday-nested"
        label="Sections of Birthdays"
        items={keepOpenNested(canOpen, "leave", "birthdays", [
          { value: "list", label: LEAVE_NESTED.birthdays[0].label, count: data ? rows.length : undefined },
          { value: "how", label: LEAVE_NESTED.birthdays[1].label },
        ])}
      >
        {nested === "list" && (
          <>
            <PeriodBar
              period={period}
              date={date}
              today={today}
              onPeriod={(next) => setLu({ bperiod: next })}
              onDate={(next) => setLu({ bdate: next === today ? "" : next })}
              testId="birthday-period"
            />

            <StatRow columns={6} testId="birthday-kpis">
              <StatTile
                label="Birthdays"
                value={data?.count ?? 0}
                hint={data ? rangeLabel(data.from, data.to) : undefined}
                icon={Cake}
                tone="rose"
                loading={query.isLoading}
                testId="birthday-kpi-count"
              />
              <StatTile
                label="Paid birthday leave"
                value={n("paid_leave", "old_rule")}
                hint="absent or on leave"
                icon={Gift}
                tone="teal"
                loading={query.isLoading}
                onClick={() => outcomeFilter("paid_leave")}
                active={lu.boutcome === "paid_leave"}
                title="Show only the paid birthday leaves"
                testId="birthday-kpi-leave"
              />
              <StatTile
                label="To place"
                value={n("comp_to_place")}
                hint="worked, not placed yet"
                icon={Gift}
                tone="amber"
                emphasis
                loading={query.isLoading}
                onClick={() => outcomeFilter("comp_to_place")}
                active={lu.boutcome === "comp_to_place"}
                title="Show only the birthday compensation still to place"
                testId="birthday-kpi-to-place"
              />
              <StatTile
                label="Placed"
                value={n("comp_placed")}
                hint="waiting or approved"
                icon={CalendarCheck2}
                tone="indigo"
                loading={query.isLoading}
                onClick={() => outcomeFilter("comp_placed")}
                active={lu.boutcome === "comp_placed"}
                title="Show only the birthday compensation placed in full"
                testId="birthday-kpi-placed"
              />
              <StatTile
                label="Lapsed"
                value={n("comp_lapsed")}
                hint="not placed in the month"
                icon={CalendarX2}
                tone="rose"
                loading={query.isLoading}
                onClick={() => outcomeFilter("comp_lapsed")}
                active={lu.boutcome === "comp_lapsed"}
                title="Show only the birthday compensation that lapsed"
                testId="birthday-kpi-lapsed"
              />
              <StatTile
                label="Upcoming"
                value={n("upcoming")}
                hint="not come yet"
                icon={CalendarClock}
                tone="slate"
                loading={query.isLoading}
                onClick={() => outcomeFilter("upcoming")}
                active={lu.boutcome === "upcoming"}
                title="Show only the birthdays still to come"
                testId="birthday-kpi-upcoming"
              />
            </StatRow>

            <SectionCard
              testId="birthday-list"
              icon={Cake}
              title="Who has a birthday"
              description="Staff only. What each birthday gave, from that day's attendance, and where its birthday compensation was placed."
              bodyClassName="space-y-3"
              actions={
                data ? (
                  <span className="text-xs text-muted-foreground">{rangeLabel(data.from, data.to)}</span>
                ) : undefined
              }
            >
              <FilterBar label="Birthday filters" testId="birthday-filters" sticky={false}>
                <OrgFilters
                  dept={lu.bdept}
                  branch={lu.bbranch}
                  onDept={(v) => setLu({ bdept: v })}
                  onBranch={(v) => setLu({ bbranch: v })}
                  testId="birthday"
                />
                <SelectFilter
                  label="What it gave"
                  value={lu.boutcome}
                  onChange={(v) => setLu({ boutcome: v })}
                  options={OUTCOME_OPTIONS}
                  allLabel="Every outcome"
                  testId="birthday-outcome"
                />
                <SearchFilter
                  value={lu.bq}
                  onChange={(v) => setLu({ bq: v })}
                  placeholder="Name or code"
                  label="Search the birthdays by name or code"
                  testId="birthday-search"
                />
                <ClearFilters
                  count={filtersOn}
                  onClear={() => setLu({ bdept: "", bbranch: "", bq: "", boutcome: "" })}
                  testId="birthday-clear"
                />
              </FilterBar>

              <DataTable
                columns={columns}
                rows={shown}
                rowKey={(r) => `${r.employeeId}-${r.birthday}`}
                loading={query.isLoading}
                error={
                  query.isError && !data
                    ? `Could not load the birthdays. ${errorMessage(query.error, "Check the connection and try again.")}`
                    : null
                }
                onRetry={() => void query.refetch()}
                empty={{
                  icon: SearchX,
                  title:
                    filtersOn > 0
                      ? "No birthday matches these filters"
                      : `No birthday ${period === "today" ? "today" : period === "week" ? "this week" : "this month"}`,
                  hint: "Pick another day, week or month with the buttons above.",
                }}
                pagination={{
                  page: current,
                  pageSize: PAGE_SIZE,
                  total: rows.length,
                  onPageChange: (p) => setPage({ key: viewKey, page: p }),
                }}
                caption="Birthdays"
                testId="birthday-table"
              />
            </SectionCard>
          </>
        )}
        {nested === "how" && (
          <Notice accent="blue" testId="birthday-how">
            <p>
              <strong>A birthday is a normal working day.</strong> What it gives depends on that day&apos;s attendance,
              never on the birthday alone:
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <strong>Absent</strong> (no punch) <strong>or on approved leave</strong> (casual leave included): an
                automatic paid birthday leave of 1 shift on the day. No leave or casual-leave balance is used.
              </li>
              <li>
                <strong>Worked</strong> (present, or even half a day): 1.00 day of birthday compensation to place on
                working days of the birthday month, as a full day or a first and a second half (the two halves can go on
                two different dates). A day can be chosen when it is still to come, or when it has passed and was marked
                Absent, On Leave or Half Day (then the missed half or a full day). The birthday itself, Sundays,
                holidays and off Saturdays cannot be chosen.
              </li>
              <li>
                The employee chooses the date in the mobile app or the Employee Web App, or HR chooses it here with{" "}
                <strong>Choose date for employee</strong>. Each choice goes to the Department Head, then HR; on
                HR&apos;s approval that day (or half) is paid like Casual Leave, without using any leave balance.
              </li>
              <li>
                What is not placed by the last day of the birthday month <strong>lapses</strong>. New birthday credit
                claims are no longer possible; credit claims raised before stay here and are decided as before.
              </li>
              <li>
                A Sunday, a declared holiday or an off Saturday gives no birthday benefit (working that day is ordinary
                Sunday / holiday work).
              </li>
            </ul>
            <p>
              {claimsFrom ? (
                <>
                  This applies to birthdays from <strong data-testid="birthday-claims-from">{claimsFrom}</strong>.
                  Earlier birthdays keep the old rule (paid leave whatever the attendance) and are never changed.
                </>
              ) : (
                "Earlier birthdays keep the old rule (paid leave whatever the attendance) and are never changed."
              )}{" "}
              The year of birth is never shown here.
            </p>
          </Notice>
        )}
      </NestedTabs>

      <BirthdayCompDialog row={opened?.row ?? null} mode={opened?.mode ?? "place"} onClose={() => setOpened(null)} />
    </div>
  );
}
