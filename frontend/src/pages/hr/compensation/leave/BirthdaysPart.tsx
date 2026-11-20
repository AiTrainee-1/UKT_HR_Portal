import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Cake, CalendarClock, Gift, HandCoins, Hourglass, Loader2, SearchX } from "lucide-react";
import { SectionCard } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NestedTabs } from "@/components/ui/nested-tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  useCompensationBirthdays,
  useRaiseCompensationClaims,
  type BirthdayOutcome,
  type BirthdayRow,
} from "@/lib/api-client/custom-hooks";
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
import { dateLong, dateShort, errorMessage, rangeLabel, shiftsText, todayIst } from "../logic";
import { PeriodBar, isPeriod } from "../period";
import { LEAVE_NESTED, subPath } from "../routes";
import { keepOpenNested, useCanOpen, useClaimRight } from "../visible";
import { ErrorNotice, Field, Notice, StatusChip, SwitchOffNotice, useSingleFlight } from "../ui";
import { OUTCOME_META, OUTCOME_OPTIONS, canClaimBirthday, outcomeOf } from "./claims-logic";
import { OrgFilters } from "./LeaveFilters";
import { claimLink, idOf, useLeaveUrl } from "./leave-url";
import { CLAIM_REASON_MAX } from "./leave-logic";

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
 * who is PRESENT (or works half a day) earns ONE 1-shift credit to claim, from the app or here by HR, which the Department
 * Head approves into the compensation balance. A Sunday, a declared holiday or an off Saturday gives nothing. The list shows
 * what each birthday gave (the outcome), filtered by period, department, branch, name and outcome; a credit nobody claimed
 * yet can be claimed here for the employee. The year of birth is never shown.
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
  const [claiming, setClaiming] = useState<BirthdayRow | null>(null);
  const master = data?.enabled.master ?? true;
  const claimsFrom = fromText(data?.enabled.claimsFrom);
  // raising a claim for an employee needs Edit on Leave > Holiday work > Claims (the server refuses anybody else)
  const { reason: rightProblem } = useClaimRight();

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
          return (
            <div className="flex max-w-xs flex-col items-start gap-0.5">
              <KitChip tone={meta.tone} testId={`birthday-outcome-${r.employeeCode}`}>
                {r.outcomeLabel || meta.label}
              </KitChip>
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
          canClaimBirthday(r) ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-11 sm:h-8"
              disabled={!!rightProblem}
              title={
                rightProblem ??
                `Claim for employee: send the birthday credit of ${r.employeeName} to the Department Head`
              }
              onClick={() => setClaiming(r)}
              data-testid={`birthday-claim-button-${r.employeeCode}`}
            >
              Claim for employee
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
          Nobody gets it right now: no paid birthday leave and no birthday credit. The birthdays below stay readable.
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

            <StatRow columns={5} testId="birthday-kpis">
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
                label="Credit to claim"
                value={n("credit_claimable")}
                hint="worked, not claimed yet"
                icon={HandCoins}
                tone="amber"
                emphasis
                loading={query.isLoading}
                onClick={() => outcomeFilter("credit_claimable")}
                active={lu.boutcome === "credit_claimable"}
                title="Show only the credits nobody claimed yet"
                testId="birthday-kpi-claimable"
              />
              <StatTile
                label="Claimed"
                value={n("credit_pending", "credit_approved")}
                hint={`${n("credit_pending")} waiting for HOD`}
                icon={Hourglass}
                tone="indigo"
                loading={query.isLoading}
                onClick={() => outcomeFilter("credit_pending")}
                active={lu.boutcome === "credit_pending"}
                title="Show only the claims waiting for the Department Head"
                testId="birthday-kpi-claimed"
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
              description="Staff only. What each birthday gave, from that day's attendance."
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
                automatic paid birthday leave of 1 shift. No leave or casual-leave balance is used.
              </li>
              <li>
                <strong>Present</strong> (or half a day): one 1-shift credit to claim. The employee claims it in the
                mobile app or the Employee Web App, or HR claims it here for them; the Department Head approves it, and
                then it is in the compensation balance to use as a day off on another day.
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

      <ClaimBirthdayDialog row={claiming} onClose={() => setClaiming(null)} />
    </div>
  );
}

/** HR claims a birthday credit for an employee who worked on their birthday: it goes to their Department Head. */
function ClaimBirthdayDialog({ row, onClose }: { row: BirthdayRow | null; onClose: () => void }) {
  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="birthday-claim-dialog">
        {row && <ClaimBirthdayForm key={`${row.employeeId}-${row.birthday}`} row={row} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function ClaimBirthdayForm({ row, onClose }: { row: BirthdayRow; onClose: () => void }) {
  const { toast } = useToast();
  const raise = useRaiseCompensationClaims();
  const { reason: rightProblem } = useClaimRight();
  const [reason, setReason] = useState("Worked on the birthday");
  const [error, setError] = useState<string | null>(null);
  const text = reason.trim();
  const problem =
    text === ""
      ? "Give a reason: the Department Head reads it before deciding."
      : text.length > CLAIM_REASON_MAX
        ? `The reason can be at most ${CLAIM_REASON_MAX} characters.`
        : null;

  const once = useSingleFlight();
  const submit = () =>
    once(async () => {
      if (problem || rightProblem || raise.isPending) return;
      setError(null);
      try {
        const res = await raise.mutateAsync({
          kind: "birthday",
          date: row.birthday,
          reason: text,
          items: [{ employeeId: row.employeeId }],
        });
        toast({
          title: "Birthday credit claimed",
          description:
            res.warnings.length > 0
              ? res.warnings.join(" ")
              : `${row.employeeName}: 1 shift, waiting for the Department Head.`,
        });
        onClose();
      } catch (err) {
        setError(errorMessage(err, "The claim could not be sent. Check the connection and try again."));
      }
    });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
    >
      <DialogHeader>
        <DialogTitle>Claim the birthday credit of {row.employeeName}</DialogTitle>
        <DialogDescription>
          <span className="font-mono">{row.employeeCode}</span> worked on their birthday, {dateLong(row.birthday)}: one
          1-shift credit. The claim goes to their Department Head; once approved it is in the compensation balance.
        </DialogDescription>
      </DialogHeader>
      <Field
        label="Reason"
        htmlFor="birthday-claim-reason"
        problem={problem}
        hint={`${text.length} / ${CLAIM_REASON_MAX}.`}
      >
        <Textarea
          id="birthday-claim-reason"
          rows={2}
          value={reason}
          maxLength={CLAIM_REASON_MAX + 50}
          onChange={(e) => {
            setReason(e.target.value);
            setError(null);
          }}
          data-testid="birthday-claim-reason"
        />
      </Field>
      {error && <ErrorNotice testId="birthday-claim-error">{error}</ErrorNotice>}
      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!!problem || !!rightProblem || raise.isPending}
          title={rightProblem ?? undefined}
          data-testid="birthday-claim-submit"
        >
          {raise.isPending && <Loader2 size={14} className="mr-2 animate-spin" />}
          Send to the Department Head
        </Button>
      </DialogFooter>
    </form>
  );
}
