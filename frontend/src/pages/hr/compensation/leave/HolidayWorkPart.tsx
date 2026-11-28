import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { CalendarCheck, CalendarDays, ChevronLeft, ChevronRight, Loader2, SearchX, Sun } from "lucide-react";
import { EmptyNote, SectionCard, SkeletonRows } from "@/components/payroll/kit/parts";
import { LoadError } from "@/components/payroll/panels/issues/panel-kit";
import { errorDetail } from "@/components/payroll/panels/issues/lists";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { NestedTabs } from "@/components/ui/nested-tabs";
import { useToast } from "@/hooks/use-toast";
import {
  useCompensationClaims,
  useHolidayWorkEligible,
  useHolidayWorkMonth,
  useRaiseHolidayWork,
  type HolidayWorkEnabled,
  type HolidayWorkMonthDay,
  type ShiftsValue,
} from "@/lib/api-client/custom-hooks";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { cn } from "@/lib/utils";
import { FilterBar, SearchFilter } from "@/pages/hr/outpass-visitors/kit";
import { LEAVE_NESTED, subPath } from "../routes";
import { keepOpenNested, useCanOpen, useClaimRight } from "../visible";
import {
  countOf,
  dateLong,
  errorMessage,
  matchesText,
  monthYear,
  monthYearFromUrl,
  parseIso,
  problemsOf,
  todayIst,
} from "../logic";
import {
  CELL,
  ErrorNotice,
  Field,
  Notice,
  PersonCell,
  ShiftsPicker,
  SwitchOffNotice,
  TABLE_HEAD,
  useSingleFlight,
} from "../ui";
import { BalancePart } from "./BalancePart";
import { ClaimsPart, claimsParamsOf } from "./ClaimsPart";
import { CreditsPart } from "./CreditsPart";
import { OrgFilters } from "./LeaveFilters";
import {
  dayCounts,
  groupWeeks,
  inMonth,
  monthOf,
  previousSunday,
  stepMonth,
  stripDayText,
  stripKindsText,
} from "./claims-logic";
import { idOf, useLeaveUrl, type LeaveUrl, type SetLeaveUrl } from "./leave-url";
import { CLAIM_REASON_MAX, checkClaim, claimPayload, punchSummary, type ClaimSelection } from "./leave-logic";
import { holidayWorkSource } from "./place-comp-logic";
import { PlaceCompDialog, type PlaceCompTarget } from "./PlaceCompDialog";

const PAUSED_MASTER = "Paused: the OT / Compensation features are switched off in Settings → Payroll";

/** The claim being filled in: kept above the nested subtabs so it survives a look at the Claims or the balance. */
function useRaiseDraft() {
  const [selection, setSelection] = useState<ClaimSelection>({});
  const [reason, setReason] = useState("");
  const [bulk, setBulk] = useState<ShiftsValue | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  return { selection, setSelection, reason, setReason, bulk, setBulk, warnings, setWarnings };
}
type RaiseDraft = ReturnType<typeof useRaiseDraft>;

/**
 * Why raising is paused: the master switch first, then the server's own reason (`raiseProblem`: a switch, or the Edit on
 * Leave > Holiday work > Claims the login lacks), else what the switches it reported say.
 */
function pausedReasonOf(featuresOff: boolean, enabled: HolidayWorkEnabled | null | undefined): string {
  if (featuresOff || enabled?.master === false) return PAUSED_MASTER;
  if (enabled?.raiseProblem) return enabled.raiseProblem;
  if (enabled && !enabled.holidayWork)
    return "Paused: work on Sundays and holidays is switched off in Settings → Compensation";
  return "Paused: the compensation claims approval is switched off in User Management";
}

/**
 * Compensation Leave B: the one compensation claim workflow. The system finds what can be claimed (a Sunday or holiday
 * worked, an OT allowance or shift credit, a birthday worked); the employee claims it in the mobile app or the Employee
 * Web App, or HR raises it here on their behalf; the employee's Department Head approves it; the shifts go into the
 * compensation balance; and they are used later as a day off (asked for like a claim, or redeemed by HR). Four nested
 * subtabs that read the same data, so they always agree: Raise (the month's Sundays and holidays week by week, then who
 * worked the day you pick), Claims (every kind), Balance (earned / used / waiting / available per employee) and Credits
 * (every credit and debit, with the earlier Alternative-Day credits).
 */
export function HolidayWorkPart({ featuresOff, nested }: { featuresOff: boolean; nested: string }) {
  const today = useMemo(() => todayIst(), []);
  const [lu, setLu] = useLeaveUrl();
  const canOpen = useCanOpen();
  // the claims of the Claims section (its filters are in the address): asked for above the tabs, so the tab counts them and
  // the notices know the switches whichever section is open
  const claims = useCompensationClaims(claimsParamsOf(lu, today), {
    enabled: canOpen(subPath("leave", "holiday-work", "", "claims")) || nested === "claims",
  });
  const draft = useRaiseDraft();
  const enabled = claims.data?.enabled ?? null;
  const master = enabled?.master ?? !featuresOff;

  return (
    <div className="space-y-4" data-testid="holiday-part">
      {master && enabled && !enabled.holidayWork && (
        <SwitchOffNotice
          testId="holiday-off"
          title="Work on Sundays and company holidays is switched off."
          setting="holiday-work-enabled"
        >
          Raising and withdrawing Sunday / holiday claims are paused. Every claim, the balances and the credits stay
          readable below.
        </SwitchOffNotice>
      )}
      {master && enabled && enabled.holidayWork && !enabled.workflow && (
        <Notice accent="amber" testId="holiday-workflow-off">
          <p>
            <strong>The approval for compensation claims is switched off.</strong> New claims are refused until it is
            switched on in{" "}
            <Link href="/hr/user-management?tab=approvals" className="font-semibold underline">
              User Management → Approval Workflow Control
            </Link>
            . Claims already waiting can still be decided by the Department Head.
          </p>
        </Notice>
      )}

      <NestedTabs
        base={subPath("leave", "holiday-work")}
        value={nested}
        testId="holiday-nested"
        label="Sections of Sunday and holiday work"
        items={keepOpenNested(canOpen, "leave", "holiday-work", [
          { value: "raise", label: LEAVE_NESTED["holiday-work"][0].label },
          { value: "claims", label: LEAVE_NESTED["holiday-work"][1].label, count: claims.data?.total },
          { value: "balance", label: LEAVE_NESTED["holiday-work"][2].label },
          { value: "credits", label: LEAVE_NESTED["holiday-work"][3].label },
        ])}
      >
        {nested === "raise" && (
          <>
            <Notice accent="blue" testId="holiday-how">
              <p>
                <strong>How it works:</strong> employees can now claim a Sunday or holiday they worked themselves, in
                the mobile app or the Employee Web App, and HR can raise it here on their behalf. Every claim goes to
                the employee&apos;s Department Head, who approves it in <strong>Approvals</strong>; HR cannot approve
                it. Once approved, the shifts are added to the employee&apos;s compensation balance (see Balance), to be
                used later as a day off. A rejected claim credits nothing.
              </p>
            </Notice>
            <RaiseClaim
              featuresOff={featuresOff}
              claimsEnabled={enabled}
              today={today}
              lu={lu}
              setLu={setLu}
              draft={draft}
            />
          </>
        )}
        {nested === "claims" && (
          <ClaimsPart
            query={claims}
            canWithdraw={!featuresOff && master}
            pausedReason={PAUSED_MASTER}
            today={today}
            warnings={draft.warnings}
            onDismissWarnings={() => draft.setWarnings([])}
          />
        )}
        {nested === "balance" && <BalancePart paused={featuresOff} pausedReason={PAUSED_MASTER} />}
        {nested === "credits" && <CreditsPart today={today} />}
      </NestedTabs>
    </div>
  );
}

// ── Raise ─────────────────────────────────────────────────────────────────────

/** The month the strip shows: the one chosen with its arrows, else the month of the chosen day, else of the previous Sunday. */
function stripMonthOf(lu: LeaveUrl, today: string): { month: number; year: number } {
  if (lu.rmonth) return monthYearFromUrl(lu.rmonth, lu.ryear, today);
  return monthOf(lu.hdate) ?? monthOf(previousSunday(today)) ?? monthYearFromUrl("", "", today);
}

function RaiseClaim({
  featuresOff,
  claimsEnabled,
  today,
  lu,
  setLu,
  draft,
}: {
  featuresOff: boolean;
  claimsEnabled: HolidayWorkEnabled | null;
  today: string;
  lu: LeaveUrl;
  setLu: SetLeaveUrl;
  draft: RaiseDraft;
}) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const search = useSearch();
  const raise = useRaiseHolidayWork();
  const { month, year } = stripMonthOf(lu, today);
  const monthQuery = useHolidayWorkMonth({
    month,
    year,
    departmentId: idOf(lu.rdept),
    branchId: idOf(lu.rbranch),
  });
  // the day: the one picked, else (in its month) the previous Sunday, which the server confirms as its defaultDate
  const prevSunday = previousSunday(today);
  const serverDefault = monthQuery.data?.defaultDate ?? null;
  const fallback = inMonth(prevSunday, month, year) ? prevSunday : "";
  const date = lu.hdate || (serverDefault && inMonth(serverDefault, month, year) ? serverDefault : fallback);
  const eligible = useHolidayWorkEligible(date);
  const enabled = eligible.data?.enabled ?? claimsEnabled ?? monthQuery.data?.enabled ?? null;
  const canRaise = !featuresOff && (enabled?.canRaise ?? false);
  const pausedReason = pausedReasonOf(featuresOff, enabled);

  const { selection, setSelection, reason, setReason, bulk, setBulk, setWarnings } = draft;
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<number, string>>({});
  const [touched, setTouched] = useState(false);
  // "Choose date": the day off worked placed at once on a date HR picks (the calendar), instead of a claim to the balance
  const [placing, setPlacing] = useState<PlaceCompTarget | null>(null);
  const { reason: rightProblem } = useClaimRight();
  const placePaused = featuresOff || enabled?.master === false ? PAUSED_MASTER : rightProblem;

  const data = eligible.data;
  const deptId = idOf(lu.rdept);
  const branchId = idOf(lu.rbranch);
  const everyone = data?.employees ?? [];
  const people = everyone.filter(
    (p) =>
      (deptId === undefined || p.departmentId === deptId) &&
      (branchId === undefined || p.branchId === branchId) &&
      matchesText(lu.rq, p.employeeName, p.employeeCode, p.department),
  );
  const eligibleIds = people.filter((p) => p.eligible).map((p) => p.employeeId);
  const check = checkClaim(selection, reason, canRaise);
  const ticked = Object.keys(selection).length;
  const filtered = people.length !== everyone.length;

  const reset = () => {
    setSelection({});
    setBulk(null);
    setProblems({});
    setError(null);
  };
  const chooseDate = (next: string) => {
    setLu({ hdate: next });
    reset();
    setWarnings([]);
  };
  const toggle = (id: number) =>
    setSelection((s) => {
      const next = { ...s };
      if (id in next) delete next[id];
      else next[id] = bulk;
      return next;
    });
  const allTicked = eligibleIds.length > 0 && eligibleIds.every((id) => id in selection);
  const toggleAll = () =>
    setSelection((s) => {
      if (allTicked) {
        const next = { ...s };
        for (const id of eligibleIds) delete next[id];
        return next;
      }
      return { ...s, ...Object.fromEntries(eligibleIds.map((id) => [id, s[id] ?? bulk])) };
    });
  const applyBulk = (shifts: ShiftsValue) => {
    setBulk(shifts);
    setSelection((s) => Object.fromEntries(Object.keys(s).map((id) => [Number(id), shifts])));
  };

  const once = useSingleFlight();
  // the claims were raised while this section was open; if HR moved on to another tab meanwhile, the address is left alone
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
  const submit = () =>
    once(async () => {
      setTouched(true);
      if (!check.ok || raise.isPending) return;
      setError(null);
      setProblems({});
      try {
        const res = await raise.mutateAsync(claimPayload(date, selection, reason));
        toast({
          title: `Raised ${countOf(res.created, "claim")} for the Department Head`,
          description: "They appear under Claims and in the Department Head's Approvals.",
        });
        setWarnings(res.warnings);
        setSelection({});
        setReason("");
        setTouched(false);
        // Claims files a claim under the month of the WORK, so open it on that month, every kind and status, everyone: a
        // Sunday of last month would otherwise be raised and then not be on screen.
        const worked = parseIso(date);
        if (worked && here.current) {
          const params = new URLSearchParams(search);
          params.set("hmonth", String(worked.month));
          params.set("hyear", String(worked.year));
          if (!params.get("hdate")) params.set("hdate", date);
          for (const key of ["hstatus", "hkind", "hraised", "hemp", "hclaim", "hpage", "hq"]) params.delete(key);
          const qs = params.toString();
          navigate(`${subPath("leave", "holiday-work", "", "claims")}${qs ? `?${qs}` : ""}`);
        }
      } catch (err) {
        setError(errorMessage(err, "The claims could not be raised. Check the connection and try again."));
        setProblems(Object.fromEntries(problemsOf(err).map((p) => [p.employeeId, p.error])));
      }
    });

  return (
    <SectionCard
      testId="claim-form"
      icon={Sun}
      title="Raise a claim for Sunday / holiday work"
      description="The Sundays, declared holidays and off Saturdays of the month, week by week, with how many worked. Pick a day, then the staff who worked; the claims go to each employee's Department Head and nothing is credited until they approve. Or use Choose date on a row to give the day off on a date you pick (the Department Head, then HR). An off Saturday lists only the staff whose own day off it is."
    >
      <div className="space-y-4">
        <FilterBar label="Raise filters" testId="raise-filters" sticky={false}>
          <OrgFilters
            dept={lu.rdept}
            branch={lu.rbranch}
            onDept={(v) => setLu({ rdept: v })}
            onBranch={(v) => setLu({ rbranch: v })}
            testId="raise"
          />
          <SearchFilter
            value={lu.rq}
            onChange={(v) => setLu({ rq: v })}
            placeholder="Name or code"
            label="Search who worked by name or code"
            testId="raise-search"
          />
        </FilterBar>

        <MonthStrip
          month={month}
          year={year}
          today={today}
          selected={date}
          query={monthQuery}
          onMonth={(m, y) => setLu({ rmonth: String(m), ryear: String(y) })}
          onThisMonth={() => {
            setLu({ rmonth: "", ryear: "", hdate: "" });
            reset();
          }}
          onPick={chooseDate}
          onLastSunday={() => {
            setLu({ rmonth: "", ryear: "", hdate: prevSunday });
            reset();
            setWarnings([]);
          }}
        />

        {date === "" ? (
          <EmptyNote
            icon={CalendarCheck}
            title="Pick a Sunday or a holiday in the strip"
            hint="The staff who punched in on that day are listed so you can pick them."
            testId="claim-no-date"
          />
        ) : eligible.isLoading ? (
          <SkeletonRows rows={3} />
        ) : eligible.isError ? (
          <LoadError
            what="who worked that day"
            detail={errorDetail(eligible.error)}
            onRetry={() => void eligible.refetch()}
            retrying={eligible.isFetching}
            testId="claim-eligible-error"
          />
        ) : data && !data.claimable ? (
          <Notice accent="amber" testId="claim-not-claimable">
            <p>{data.message}</p>
          </Notice>
        ) : data && everyone.length === 0 ? (
          <EmptyNote
            icon={SearchX}
            title={`Nobody has punches on ${dateLong(date)}`}
            hint="Only staff with punches or a present attendance entry on the day can be claimed for."
            testId="claim-nobody"
          />
        ) : data ? (
          <>
            <p className="text-sm text-gray-700" data-testid="claim-day">
              <strong>{dateLong(data.date)}</strong> ·{" "}
              {stripDayText({ kind: data.dayKind ?? "sunday", holidayName: data.holidayName })} · {data.counts.worked}{" "}
              worked, {data.counts.eligible} can be claimed for
              {filtered && <span className="text-muted-foreground"> · {people.length} shown with the filters</span>}
            </p>
            <div className="flex flex-wrap items-center gap-2" {...{ [VIEW_SAFE_ATTR]: "" }}>
              <span className="text-xs font-semibold text-slate-700">Same shifts for every ticked employee:</span>
              <ShiftsPicker
                value={bulk}
                label="Same shifts for every ticked employee"
                onChange={applyBulk}
                testId="claim-bulk"
              />
            </div>
            {people.length === 0 ? (
              <EmptyNote
                icon={SearchX}
                title="Nobody who worked matches the filters"
                hint="Clear the department, branch or search above."
                testId="claim-filtered-out"
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-slate-100">
                <table className="w-full min-w-[720px] text-sm" data-testid="claim-table">
                  <thead className={TABLE_HEAD}>
                    <tr>
                      <th className="w-10 px-3 py-2.5">
                        <Checkbox
                          checked={allTicked}
                          disabled={eligibleIds.length === 0}
                          onCheckedChange={toggleAll}
                          aria-label="Tick every employee who can be claimed for"
                          data-testid="claim-select-all"
                        />
                      </th>
                      <th className="px-3 py-2.5">Employee</th>
                      <th className="px-3 py-2.5">Punches that day</th>
                      <th className="px-3 py-2.5">Shifts to claim</th>
                      <th className="px-3 py-2.5 text-right">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {people.map((p) => {
                      const on = p.employeeId in selection;
                      const problem = problems[p.employeeId];
                      return (
                        <tr
                          key={p.employeeId}
                          className={on ? "bg-indigo-50" : undefined}
                          data-testid={`claim-person-${p.employeeCode}`}
                        >
                          <td className={CELL}>
                            <Checkbox
                              checked={on}
                              disabled={!p.eligible}
                              onCheckedChange={() => toggle(p.employeeId)}
                              aria-label={`Tick ${p.employeeName}`}
                              data-testid={`claim-select-${p.employeeCode}`}
                            />
                          </td>
                          <td className={CELL}>
                            <PersonCell name={p.employeeName} code={p.employeeCode} department={p.department} />
                          </td>
                          <td className={`${CELL} text-gray-700`}>
                            <span data-testid={`claim-punches-${p.employeeCode}`}>{punchSummary(p)}</span>
                          </td>
                          <td className={CELL}>
                            {p.eligible ? (
                              <div className="space-y-1">
                                <ShiftsPicker
                                  value={selection[p.employeeId] ?? null}
                                  disabled={!on}
                                  label={`Shifts to claim for ${p.employeeName}`}
                                  onChange={(shifts) => setSelection((s) => ({ ...s, [p.employeeId]: shifts }))}
                                  testId={`claim-shifts-${p.employeeCode}`}
                                />
                                {on && selection[p.employeeId] === null && touched && (
                                  <p role="alert" className="text-xs font-medium text-red-600">
                                    Choose the shifts.
                                  </p>
                                )}
                              </div>
                            ) : (
                              <p
                                className="text-xs leading-snug text-muted-foreground"
                                data-testid={`claim-reason-${p.employeeCode}`}
                              >
                                {p.reason ?? "Cannot be claimed for."}
                              </p>
                            )}
                            {problem && (
                              <p
                                role="alert"
                                className="mt-1 text-xs font-medium text-red-600"
                                data-testid={`claim-problem-${p.employeeCode}`}
                              >
                                {problem}
                              </p>
                            )}
                          </td>
                          <td className={`${CELL} text-right`}>
                            {p.eligible && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-11 sm:h-8"
                                disabled={!!placePaused}
                                aria-label={`Choose a day off for ${p.employeeName} for this day worked`}
                                title={
                                  placePaused ??
                                  `Choose date: give ${p.employeeName} a day off for this day worked on a date you pick, and send it to the Department Head, then HR`
                                }
                                onClick={() =>
                                  setPlacing({
                                    employeeId: p.employeeId,
                                    employeeName: p.employeeName,
                                    employeeCode: p.employeeCode,
                                    source: holidayWorkSource(date),
                                  })
                                }
                                data-testid={`claim-place-${p.employeeCode}`}
                              >
                                Choose date
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <Field
              label="Reason"
              htmlFor="claim-reason"
              problem={touched ? check.reasonProblem : null}
              hint={`${reason.trim().length} / ${CLAIM_REASON_MAX}. What was the work? The Department Head reads it before deciding.`}
            >
              <Textarea
                id="claim-reason"
                rows={2}
                value={reason}
                maxLength={CLAIM_REASON_MAX + 50}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Dispatch rush: the container had to leave on Monday morning"
                data-testid="claim-reason"
              />
            </Field>

            {error && <ErrorNotice testId="claim-error">{error}</ErrorNotice>}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={!canRaise || raise.isPending || ticked === 0}
                title={canRaise ? (check.ok ? undefined : (check.first ?? undefined)) : pausedReason}
                onClick={() => void submit()}
                data-testid="claim-submit"
              >
                {raise.isPending && <Loader2 size={14} className="mr-2 animate-spin" />}
                Submit {ticked > 0 ? countOf(ticked, "claim") : "claim"} for HOD approval
              </Button>
              {!canRaise && !featuresOff && enabled?.raiseProblem && (
                <p className="text-xs font-medium text-amber-700" data-testid="claim-raise-problem">
                  {enabled.raiseProblem}
                </p>
              )}
              {touched && !check.ok && check.first && (
                <p className="text-xs font-medium text-red-600" role="alert" data-testid="claim-first-problem">
                  {check.first}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                All or nothing: if one employee cannot be claimed for, none is raised.
              </p>
            </div>
          </>
        ) : null}
      </div>
      <PlaceCompDialog target={placing} onClose={() => setPlacing(null)} />
    </SectionCard>
  );
}

// ── The month strip ───────────────────────────────────────────────────────────

const STEP_BUTTON = "size-11 sm:size-9";

/**
 * The Sundays, declared holidays and off Saturdays (a staff member's own Saturday off) of one month, week by week, each
 * with how many worked, how many can still be claimed for and the claims already made. Picking a day lists who worked it
 * (below). A day still to come cannot be picked.
 */
function MonthStrip({
  month,
  year,
  today,
  selected,
  query,
  onMonth,
  onThisMonth,
  onPick,
  onLastSunday,
}: {
  month: number;
  year: number;
  today: string;
  selected: string;
  query: ReturnType<typeof useHolidayWorkMonth>;
  onMonth: (month: number, year: number) => void;
  onThisMonth: () => void;
  onPick: (date: string) => void;
  onLastSunday: () => void;
}) {
  const days = query.data?.days ?? [];
  const weeks = groupWeeks(days);
  const worked = days.reduce((n, d) => n + d.worked, 0);
  const toClaim = days.reduce((n, d) => n + d.eligible, 0);
  const waiting = days.reduce((n, d) => n + d.claimed.pending, 0);
  const now = parseIso(today);
  const isThisMonth = !!now && now.month === month && now.year === year;
  const step = (delta: number) => {
    const next = stepMonth(month, year, delta);
    onMonth(next.month, next.year);
  };

  return (
    <section
      className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3"
      aria-label={`Sundays and holidays of ${monthYear(month, year)}`}
      data-testid="hw-strip"
      {...{ [VIEW_SAFE_ATTR]: "" }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={STEP_BUTTON}
          onClick={() => step(-1)}
          aria-label="Previous month"
          title="Previous month"
          data-testid="hw-strip-prev"
        >
          <ChevronLeft size={15} />
        </Button>
        <h4 className="min-w-[9rem] text-center text-sm font-bold text-slate-900" data-testid="hw-strip-month">
          {monthYear(month, year)}
        </h4>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={STEP_BUTTON}
          onClick={() => step(1)}
          aria-label="Next month"
          title="Next month"
          data-testid="hw-strip-next"
        >
          <ChevronRight size={15} />
        </Button>
        {!isThisMonth && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-11 sm:h-9"
            onClick={onThisMonth}
            data-testid="hw-strip-today"
          >
            This month
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-11 sm:h-9"
          onClick={onLastSunday}
          data-testid="claim-last-sunday"
        >
          Last Sunday
        </Button>
        {query.data && (
          <p className="w-full text-xs text-slate-600 sm:ml-auto sm:w-auto" data-testid="hw-strip-summary">
            {stripKindsText(days)} · {worked} worked · {toClaim} still to claim
            {waiting > 0 ? ` · ${waiting} waiting for HOD` : ""}
          </p>
        )}
      </div>

      {query.isLoading ? (
        <SkeletonRows rows={2} />
      ) : query.isError ? (
        <LoadError
          what="the Sundays and holidays of the month"
          detail={errorDetail(query.error)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
          testId="hw-strip-error"
        />
      ) : days.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="hw-strip-empty">
          No Sunday, declared holiday or off Saturday in {monthYear(month, year)}.
        </p>
      ) : (
        // the weeks side by side (one column each, a holiday in the same week under its Sunday), so the strip reads left to
        // right across the card; two columns on a phone, three on a tablet
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="hw-weeks">
          {weeks.map((week) => (
            <div key={week.label} className="min-w-0 space-y-1.5" data-testid="hw-week">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{week.label}</p>
              <div className="grid grid-cols-1 gap-2">
                {week.days.map((day) => (
                  <DayButton
                    key={day.date}
                    day={day}
                    on={day.date === selected}
                    future={day.date > today}
                    onPick={onPick}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function DayButton({
  day,
  on,
  future,
  onPick,
}: {
  day: HolidayWorkMonthDay;
  on: boolean;
  future: boolean;
  onPick: (date: string) => void;
}) {
  const counts = dayCounts(day);
  const what = stripDayText(day);
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={future}
      onClick={() => onPick(day.date)}
      title={future ? "This day has not come yet" : `See who worked on ${dateLong(day.date)}`}
      className={cn(
        "flex min-h-11 flex-col items-start rounded-xl border px-3 py-2 text-left outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        on ? "border-indigo-500 bg-indigo-50" : "border-slate-200 bg-white hover:bg-slate-50",
      )}
      data-testid={`hw-day-${day.date}`}
    >
      <span className="flex w-full items-center gap-1.5 text-sm font-bold text-slate-900">
        <CalendarDays
          size={14}
          className={
            day.kind === "holiday"
              ? "text-amber-600"
              : day.kind === "off_saturday"
                ? "text-teal-600"
                : "text-indigo-600"
          }
        />
        {dateLong(day.date)}
      </span>
      <span className="text-[11px] text-slate-500">{what}</span>
      <span className="mt-1 text-xs text-slate-700" data-testid={`hw-day-${day.date}-worked`}>
        {future ? "Not come yet" : counts.worked}
      </span>
      {!future && (
        <span className="text-[11px] text-slate-500" data-testid={`hw-day-${day.date}-claims`}>
          {counts.claims}
        </span>
      )}
    </button>
  );
}
