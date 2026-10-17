import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { CalendarCheck, ClipboardCheck, Loader2, SearchX, Sun, UserCheck } from "lucide-react";
import { ApprovalTrail } from "@/components/ApprovalTrail";
import { EmptyNote, KpiTile, SectionCard, SkeletonKpis, SkeletonRows } from "@/components/payroll/kit/parts";
import { FilterSelect, LoadError } from "@/components/payroll/panels/issues/panel-kit";
import { errorDetail } from "@/components/payroll/panels/issues/lists";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  useCompensationCredits,
  useHolidayWorkClaims,
  useHolidayWorkEligible,
  useRaiseHolidayWork,
  useWithdrawHolidayWork,
  type HolidayWorkClaim,
  type ShiftsValue,
} from "@/lib/api-client/custom-hooks";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { NestedTabs } from "@/components/ui/nested-tabs";
import { LEAVE_NESTED, subPath } from "../routes";
import { BalancePart, LegacyCredits } from "./BalancePart";
import {
  MONTH_NAMES,
  countOf,
  dateLong,
  dateShort,
  errorMessage,
  fmtShifts,
  monthYearFromUrl,
  parseIso,
  problemsOf,
  shiftsText,
  todayIst,
  yearChoices,
  type CompensationUrl,
} from "../logic";
import {
  CELL,
  ErrorNotice,
  Field,
  Notice,
  PersonCell,
  ShiftsPicker,
  StatusChip,
  SwitchOffNotice,
  TABLE_HEAD,
  Pager,
  usePaged,
  useSingleFlight,
} from "../ui";
import {
  WHOLE_YEAR,
  CLAIM_REASON_MAX,
  CLAIM_STATUS_OPTIONS,
  checkClaim,
  claimPayload,
  claimStatusInfo,
  dayKindText,
  decisionText,
  lastSunday,
  punchSummary,
  type ClaimSelection,
} from "./leave-logic";

type SetUrl = (patch: Partial<CompensationUrl>) => void;

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
 * Compensation Leave B: work on Sundays and company holidays. ONLY HR raises it; it counts only after the Department Head
 * approves it in Approvals, and then the shifts go to the employee's compensation balance. The page raises (pick a date,
 * tick who worked, choose shifts, give a reason) and follows each claim: waiting for the HOD, approved or rejected.
 * One nested subtab per section: Raise a claim, Claims, Compensation balance, Earlier Alternative-Day credits. The claims
 * query and the half-filled claim live here, so a switch is instant and a form that was being filled is still filled.
 */
export function HolidayWorkPart({
  featuresOff,
  url,
  setUrl,
  nested,
}: {
  featuresOff: boolean;
  url: CompensationUrl;
  setUrl: SetUrl;
  /** The nested subtab: `raise`, `claims`, `balance` or `credits`. */
  nested: string;
}) {
  const today = useMemo(() => todayIst(), []);
  const { month, year } = monthYearFromUrl(url.hmonth, url.hyear, today);
  // "All months" lists the claims of every month: a claim for a Sunday of last month is still waiting for its Department
  // Head, and HR should be able to find it without knowing which month (or year) it was filed under.
  const wholeYear = url.hmonth === WHOLE_YEAR;
  const claims = useHolidayWorkClaims({
    status: url.hstatus === "all" ? undefined : url.hstatus,
    ...(wholeYear ? { anyMonth: true } : { month, year }),
  });
  const credits = useCompensationCredits();
  const draft = useRaiseDraft();
  const enabled = claims.data?.enabled;
  const master = enabled?.master ?? !featuresOff;
  const canRaise = !featuresOff && (enabled?.canRaise ?? false);
  const pausedReason =
    featuresOff || enabled?.master === false
      ? "Paused: the OT / Compensation features are switched off in Settings → Payroll"
      : enabled && !enabled.holidayWork
        ? "Paused: work on Sundays and holidays is switched off in Settings → Compensation"
        : "Paused: the Holiday / Sunday work approval is switched off in User Management";

  return (
    <div className="space-y-4" data-testid="holiday-part">
      {master && enabled && !enabled.holidayWork && (
        <SwitchOffNotice
          testId="holiday-off"
          title="Work on Sundays and company holidays is switched off."
          setting="holiday-work-enabled"
        >
          Raising and withdrawing claims are paused. Every claim, and the balance, stay readable below.
        </SwitchOffNotice>
      )}
      {master && enabled && enabled.holidayWork && !enabled.workflow && (
        <Notice accent="amber" testId="holiday-workflow-off">
          <p>
            <strong>The approval for Sunday / holiday work is switched off.</strong> New claims are refused until it is
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
        items={[
          { value: "raise", label: LEAVE_NESTED["holiday-work"][0].label },
          { value: "claims", label: LEAVE_NESTED["holiday-work"][1].label, count: claims.data?.results.length },
          { value: "balance", label: LEAVE_NESTED["holiday-work"][2].label },
          { value: "credits", label: LEAVE_NESTED["holiday-work"][3].label, count: credits.data?.results.length },
        ]}
      >
        {nested === "raise" && (
          <>
            <Notice accent="blue" testId="holiday-how">
              <p>
                <strong>How it works:</strong> only HR raises a claim here. The Department Head approves it in{" "}
                <strong>Approvals</strong>; HR cannot approve it. Once approved, the shifts are added to the
                employee&apos;s compensation balance (see Compensation balance), and HR redeems them as a day off. A
                rejected claim credits nothing.
              </p>
            </Notice>
            <RaiseClaim
              canRaise={canRaise}
              pausedReason={pausedReason}
              today={today}
              url={url}
              setUrl={setUrl}
              draft={draft}
            />
          </>
        )}
        {nested === "claims" && (
          <ClaimList
            query={claims}
            canWithdraw={!featuresOff && !!enabled?.holidayWork}
            pausedReason={pausedReason}
            url={url}
            setUrl={setUrl}
            month={month}
            wholeYear={wholeYear}
            year={year}
            today={today}
            warnings={draft.warnings}
            onDismissWarnings={() => draft.setWarnings([])}
          />
        )}
        {nested === "balance" && <BalancePart paused={featuresOff} pausedReason={PAUSED_MASTER} />}
        {nested === "credits" && <LegacyCredits />}
      </NestedTabs>
    </div>
  );
}

// ── Raise ─────────────────────────────────────────────────────────────────────

function RaiseClaim({
  canRaise,
  pausedReason,
  today,
  url,
  setUrl,
  draft,
}: {
  canRaise: boolean;
  pausedReason: string;
  today: string;
  url: CompensationUrl;
  setUrl: SetUrl;
  draft: RaiseDraft;
}) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const search = useSearch();
  const raise = useRaiseHolidayWork();
  const date = url.hdate;
  const eligible = useHolidayWorkEligible(date);
  const { selection, setSelection, reason, setReason, bulk, setBulk, setWarnings } = draft;
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<number, string>>({});
  const [touched, setTouched] = useState(false);

  const data = eligible.data;
  const people = data?.employees ?? [];
  const eligibleIds = people.filter((p) => p.eligible).map((p) => p.employeeId);
  const check = checkClaim(selection, reason, canRaise);
  const ticked = Object.keys(selection).length;

  const reset = () => {
    setSelection({});
    setBulk(null);
    setProblems({});
    setError(null);
  };
  const chooseDate = (next: string) => {
    setUrl({ hdate: next });
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
  const toggleAll = () =>
    setSelection(
      ticked === eligibleIds.length ? {} : Object.fromEntries(eligibleIds.map((id) => [id, selection[id] ?? bulk])),
    );
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
        // Claims files a claim under the month of the WORK, so open it on the month of the new claims (every status): a
        // Sunday of last month would otherwise be raised and then not be on screen.
        const worked = parseIso(date);
        if (worked && here.current) {
          const params = new URLSearchParams(search);
          params.set("hmonth", String(worked.month));
          params.set("hyear", String(worked.year));
          params.delete("hstatus");
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
      description="Pick the Sunday or company holiday, then the staff who worked. Claims go to each employee's Department Head; nothing is credited until they approve."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Date of the work"
            htmlFor="claim-date"
            hint="A Sunday or a declared holiday, up to 45 days ago."
          >
            <Input
              id="claim-date"
              type="date"
              value={date}
              max={today}
              onChange={(e) => chooseDate(e.target.value)}
              className="w-44"
              data-testid="claim-date"
            />
          </Field>
          <div {...{ [VIEW_SAFE_ATTR]: "" }}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mb-6 h-9"
              onClick={() => chooseDate(lastSunday(today))}
              data-testid="claim-last-sunday"
            >
              Last Sunday
            </Button>
          </div>
        </div>

        {date === "" ? (
          <EmptyNote
            icon={CalendarCheck}
            title="Choose the date of the work"
            hint="The staff who punched in on that Sunday or holiday are listed so you can pick them."
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
        ) : data && people.length === 0 ? (
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
              {data.dayKind === "sunday" ? "Sunday" : (data.holidayName ?? "Company holiday")} · {data.counts.worked}{" "}
              worked, {data.counts.eligible} can be claimed for
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
            <div className="overflow-x-auto rounded-xl border border-slate-100">
              <table className="w-full min-w-[820px] text-sm" data-testid="claim-table">
                <thead className={TABLE_HEAD}>
                  <tr>
                    <th className="w-10 px-3 py-2.5">
                      <Checkbox
                        checked={eligibleIds.length > 0 && ticked === eligibleIds.length}
                        disabled={eligibleIds.length === 0}
                        onCheckedChange={toggleAll}
                        aria-label="Tick every employee who can be claimed for"
                        data-testid="claim-select-all"
                      />
                    </th>
                    <th className="px-3 py-2.5">Employee</th>
                    <th className="px-3 py-2.5">Punches that day</th>
                    <th className="px-3 py-2.5">Shifts to claim</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {people.map((p) => {
                    const on = p.employeeId in selection;
                    const problem = problems[p.employeeId];
                    return (
                      <tr
                        key={p.employeeId}
                        className={on ? "bg-indigo-50/50" : undefined}
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
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

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
    </SectionCard>
  );
}

// ── The claims ────────────────────────────────────────────────────────────────

function ClaimList({
  query,
  canWithdraw,
  pausedReason,
  url,
  setUrl,
  month,
  wholeYear,
  year,
  today,
  warnings,
  onDismissWarnings,
}: {
  warnings: string[];
  onDismissWarnings: () => void;
  query: ReturnType<typeof useHolidayWorkClaims>;
  canWithdraw: boolean;
  pausedReason: string;
  url: CompensationUrl;
  setUrl: SetUrl;
  month: number;
  wholeYear: boolean;
  year: number;
  today: string;
}) {
  const { toast } = useToast();
  const withdraw = useWithdrawHolidayWork();
  const [withdrawing, setWithdrawing] = useState<HolidayWorkClaim | null>(null);
  const rows = useMemo(() => query.data?.results ?? [], [query.data]);
  const paged = usePaged(rows, `claims|${url.hstatus}|${wholeYear ? "all" : month}|${year}|${rows.length}`, 15);
  const summary = query.data?.summary;
  const years = yearChoices(today);

  const confirmWithdraw = async () => {
    if (!withdrawing) return;
    try {
      await withdraw.mutateAsync(withdrawing.id);
      toast({
        title: "Claim withdrawn",
        description: `${withdrawing.employeeName}, ${dateShort(withdrawing.workDate)}.`,
      });
    } catch (err) {
      toast({
        title: "Could not withdraw it",
        description: errorMessage(err, "Try again."),
        variant: "destructive",
      });
    } finally {
      setWithdrawing(null);
    }
  };

  return (
    <SectionCard
      testId="claim-list"
      icon={ClipboardCheck}
      title="Claims"
      description="Each claim with where it stands in the approval: waiting for the Department Head, approved or rejected, and who decided."
      bodyClassName="space-y-4 px-0 pb-0"
    >
      <div className="space-y-3 px-5">
        {warnings.length > 0 && (
          <Notice accent="amber" testId="claim-warnings">
            <p className="font-semibold">Raised, but nobody can decide these yet:</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            <button
              type="button"
              className="font-semibold underline"
              onClick={onDismissWarnings}
              data-testid="claim-warnings-dismiss"
            >
              Dismiss
            </button>
          </Notice>
        )}
        {query.isLoading ? (
          <SkeletonKpis count={3} className="md:grid-cols-3 xl:grid-cols-3" />
        ) : summary ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="claim-kpis">
            <KpiTile
              testId="claim-kpi-pending"
              label="Waiting for HOD"
              value={summary.pending}
              sub={`${fmtShifts(summary.pendingShifts)} shifts`}
              icon={UserCheck}
              tone="bg-amber-50 text-amber-800"
            />
            <KpiTile
              testId="claim-kpi-approved"
              label="Approved"
              value={summary.approved}
              sub={`${fmtShifts(summary.approvedShifts)} shifts added to balances`}
              icon={ClipboardCheck}
              tone="bg-emerald-50 text-emerald-800"
            />
            <KpiTile
              testId="claim-kpi-rejected"
              label="Rejected"
              value={summary.rejected}
              sub="nothing credited"
              icon={SearchX}
              tone="bg-rose-50 text-rose-800"
            />
          </div>
        ) : null}

        <div
          className="flex flex-wrap items-center gap-2"
          role="search"
          aria-label="Claim filters"
          {...{ [VIEW_SAFE_ATTR]: "" }}
        >
          <Select value={wholeYear ? WHOLE_YEAR : String(month)} onValueChange={(v) => setUrl({ hmonth: v })}>
            <SelectTrigger className="h-10 w-40" aria-label="Month of the work" data-testid="claim-month">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={WHOLE_YEAR}>All months</SelectItem>
              {MONTH_NAMES.map((name, i) => (
                <SelectItem key={name} value={String(i + 1)}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(year)} onValueChange={(v) => setUrl({ hyear: v })} disabled={wholeYear}>
            <SelectTrigger className="h-10 w-28" aria-label="Year of the work" data-testid="claim-year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FilterSelect
            value={url.hstatus === "all" ? "" : url.hstatus}
            onChange={(v) => setUrl({ hstatus: v === "" ? "all" : v })}
            options={CLAIM_STATUS_OPTIONS}
            allLabel="Every status"
            label="Filter claims by status"
            testId="claim-status"
            className="w-full sm:w-52"
          />
        </div>
      </div>

      {query.isLoading ? (
        <div className="px-5 pb-5">
          <SkeletonRows rows={3} />
        </div>
      ) : query.isError && !query.data ? (
        <div className="px-5 pb-5">
          <LoadError
            what="the claims"
            detail={errorDetail(query.error)}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
            testId="claims-error"
          />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-5 pb-5">
          <EmptyNote
            icon={ClipboardCheck}
            title={wholeYear ? "No claim with this status" : "No claim for this month and status"}
            hint="Claims are filed under the date of the work. Change the month or the status, or raise one in the Raise a claim tab."
            testId="claims-empty"
          />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm" data-testid="claims-table">
              <thead className={TABLE_HEAD}>
                <tr>
                  <th className="px-3 py-2.5 pl-5">Employee</th>
                  <th className="px-3 py-2.5">Work date</th>
                  <th className="px-3 py-2.5">Shifts</th>
                  <th className="px-3 py-2.5">Reason</th>
                  <th className="px-3 py-2.5">Approval</th>
                  <th className="px-3 py-2.5 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {paged.rows.map((claim) => {
                  const info = claimStatusInfo(claim);
                  const decided = decisionText(claim);
                  return (
                    <tr key={claim.id} data-testid={`claim-row-${claim.id}`} data-status={claim.status}>
                      <td className={`${CELL} pl-5`}>
                        <PersonCell name={claim.employeeName} code={claim.employeeCode} department={claim.department} />
                      </td>
                      <td className={CELL}>
                        <p className="whitespace-nowrap font-semibold">{dateShort(claim.workDate)}</p>
                        <p className="text-[11px] text-muted-foreground">{dayKindText(claim)}</p>
                      </td>
                      <td className={`${CELL} whitespace-nowrap font-semibold`}>{shiftsText(claim.shifts)}</td>
                      <td className={`${CELL} max-w-xs break-words text-gray-700`}>{claim.reason}</td>
                      <td className={CELL}>
                        <StatusChip tone={info.tone}>{info.label}</StatusChip>
                        {claim.status === "pending" && (
                          <p className="mt-1 text-[11px] text-muted-foreground" data-testid={`claim-hod-${claim.id}`}>
                            {claim.hodName ? `HOD: ${claim.hodName}` : "No Department Head assigned"}
                          </p>
                        )}
                        {decided && (
                          <p
                            className="mt-1 text-[11px] text-muted-foreground"
                            data-testid={`claim-decision-${claim.id}`}
                          >
                            {decided}
                          </p>
                        )}
                        {claim.status === "rejected" && claim.reviewComment && (
                          <p className="mt-0.5 text-[11px] italic text-muted-foreground">“{claim.reviewComment}”</p>
                        )}
                        {claim.status === "approved" && claim.credited && (
                          <p className="mt-0.5 text-[11px] text-emerald-700">Added to the balance</p>
                        )}
                        {claim.approval && (
                          <div className="mt-2 hidden sm:block">
                            <ApprovalTrail approval={claim.approval} submittedBy="HR" />
                          </div>
                        )}
                      </td>
                      <td className={`${CELL} pr-5 text-right`}>
                        {claim.status === "pending" && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={!canWithdraw}
                            aria-label={`Withdraw the claim of ${claim.employeeName} for ${dateShort(claim.workDate)}`}
                            title={
                              canWithdraw
                                ? "Withdraw and remove this claim from the Department Head's queue"
                                : pausedReason
                            }
                            onClick={() => setWithdrawing(claim)}
                            data-testid={`claim-withdraw-${claim.id}`}
                          >
                            Withdraw
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager paged={paged} size={15} />
          {query.data?.truncated && (
            <p className="px-5 pb-4 text-xs text-muted-foreground">
              Only the newest {rows.length} claims are shown: narrow the month or status.
            </p>
          )}
        </>
      )}

      <AlertDialog
        open={withdrawing !== null}
        onOpenChange={(open) => !open && !withdraw.isPending && setWithdrawing(null)}
      >
        <AlertDialogContent data-testid="claim-withdraw-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw this claim?</AlertDialogTitle>
            <AlertDialogDescription>
              {withdrawing
                ? `${withdrawing.employeeName}, ${dateShort(withdrawing.workDate)}, ${shiftsText(withdrawing.shifts)}. The claim leaves the Department Head's queue and nothing is credited. You can raise it again later.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={withdraw.isPending}>Keep the claim</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmWithdraw();
              }}
              disabled={withdraw.isPending}
              data-testid="claim-withdraw-confirm"
            >
              Withdraw claim
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
