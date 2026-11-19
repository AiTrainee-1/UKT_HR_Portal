import { useMemo, useState } from "react";
import { Link } from "wouter";
import { CheckCheck, History, Hourglass, Loader2, Send, XCircle } from "lucide-react";
import { EmptyNote, SectionCard } from "@/components/payroll/kit/parts";
import { FilterSelect } from "@/components/payroll/panels/issues/panel-kit";
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
import { canApprove, useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  useRejectOvertime,
  type OvertimeAssignResult,
  type OvertimeMode,
  type OvertimeRow,
} from "@/lib/api-client/custom-hooks";
import { formatDuration } from "@/pages/hr/settings/compensation/time";
import { compensationSettingsHref, dateShort, errorMessage, shiftsText } from "../logic";
import { CELL, PersonCell, Pager, StatusChip, TABLE_HEAD, usePaged } from "../ui";
import { AssignDialog } from "./AssignDialog";
import { ClaimDialog } from "./ClaimDialog";
import { ClaimCell, LastPunch } from "./parts";
import {
  HISTORY_STATUSES,
  assignModesFor,
  assignedText,
  canClaim,
  creditBasis,
  creditText,
  filterHistory,
  inClaimFlow,
  isCredited,
  isHistoryStatus,
  rowKey,
  shiftsOf,
  type2ClaimState,
  type2Lock,
  type HistoryStatus,
  type Pause,
} from "./ot-logic";
import { ShiftRules } from "./RulesExplain";

/**
 * Type 2: shift-based compensation (0.25 / 0.50 / 0.75 / 1 shift) for staff who worked well past their shift end. It is NOT
 * automatic. From the claims date the credit is worked out in quarters of the employee's own working shift (rounded down, at
 * most 1.00); the employee (in the apps) or HR (here, "Claim for employee") claims it, the employee's Department Head
 * approves, and the shifts go to the compensation balance. HR may instead pay a record while Payment is on; a record is
 * either paid or credited, never both, so a claimed record cannot be ticked. Records before the claims date keep the old
 * way: HR assigns them (Relaxation or Payment) or rejects them. Three nested subtabs show one thing each: the records
 * waiting, what was already decided, and how the credit is worked out. The ticked rows live here, so they stay ticked
 * while HR looks at another one.
 */
export type Type2View = "waiting" | "assigned" | "how";

export function Type2Section({
  view,
  waiting,
  waitingTotal,
  history,
  historyTotal,
  loading,
  pause,
  modes,
  historyStatus,
  onHistoryStatus,
  claimsFrom,
  claimPause,
}: {
  /** The nested subtab shown. */
  view: Type2View;
  /** The candidates the filters leave, and how many the month has in all. */
  waiting: OvertimeRow[];
  waitingTotal: number;
  /** The assigned / rejected records the search and department leave, and how many the month has in all. */
  history: OvertimeRow[];
  historyTotal: number;
  loading: boolean;
  /** Why changing is paused (the master switch, Type 2, or both modes off), or null. */
  pause: Pause;
  modes: OvertimeMode[];
  historyStatus: string;
  onHistoryStatus: (value: string) => void;
  /** The claim workflow's start date (null: not known, an older server). */
  claimsFrom: string | null;
  /** Why claiming is paused right now, or null. */
  claimPause: Pause;
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  // assigning / rejecting Type 2 is an approval of its own (compensation_ot)
  const mayDecide = canApprove(user, "compensation_ot");
  const reject = useRejectOvertime();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [claiming, setClaiming] = useState<OvertimeRow[] | null>(null);

  // a claimed record (waiting for the HOD, or credited) cannot be paid, assigned or rejected, so it cannot be ticked
  const selectable = useMemo(() => waiting.filter((r) => !type2Lock(r)), [waiting]);
  const chosen = useMemo(() => selectable.filter((r) => selected.has(rowKey(r))), [selectable, selected]);
  const chosenClaimable = useMemo(() => chosen.filter(canClaim), [chosen]);
  const anyClaimable = useMemo(() => waiting.some(canClaim), [waiting]);
  const anyClaimFlow = useMemo(() => waiting.some((r) => inClaimFlow(r, claimsFrom)), [waiting, claimsFrom]);
  // Payment only for a record under the claim workflow (it is credited by a claim instead of Relaxation)
  const chosenModes = useMemo(() => assignModesFor(modes, chosen, claimsFrom), [modes, chosen, claimsFrom]);
  const payOnly =
    chosen.length > 0
      ? chosenModes.length === 1 && chosenModes[0] === "pay"
      : anyClaimFlow && waiting.every((r) => inClaimFlow(r, claimsFrom));
  const paged = usePaged(waiting, `t2w|${waiting.length}`);
  const status: HistoryStatus = isHistoryStatus(historyStatus) ? historyStatus : "all";
  const shownHistory = useMemo(() => filterHistory(history, status), [history, status]);
  const historyPaged = usePaged(shownHistory, `t2h|${status}|${shownHistory.length}`);

  const allOn = selectable.length > 0 && chosen.length === selectable.length;
  const toggle = (key: string) =>
    setSelected((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(selectable.map(rowKey)));
  const afterClaim = (keys: string[]) =>
    setSelected((set) => {
      const next = new Set(set);
      for (const key of keys) next.delete(key);
      return next;
    });

  const afterAssign = (result: OvertimeAssignResult) =>
    setSelected((set) => {
      const next = new Set(set);
      for (const r of result.results) next.delete(rowKey(r));
      return next;
    });

  const doReject = async () => {
    try {
      const res = await reject.mutateAsync({
        records: chosen.map((r) => ({ employeeId: r.employeeId, date: r.date })),
      });
      toast({ title: `Rejected ${res.rejected} ${res.rejected === 1 ? "record" : "records"}` });
      setSelected(new Set());
      setRejecting(false);
    } catch (err) {
      toast({
        title: "Could not reject",
        description: errorMessage(err, "The records could not be rejected. Check the connection and try again."),
        variant: "destructive",
      });
    }
  };

  const disabled = !!pause || chosen.length === 0;
  // why Assign / Pay cannot be used for the ticked records (beyond the general pause)
  const assignBlock =
    pause?.reason ??
    (chosen.length > 0 && chosenModes.length === 0
      ? "Payment is switched off in Settings → Compensation: a record under the claim workflow is credited by a claim instead"
      : null);
  const assignTitle =
    assignBlock ??
    (payOnly
      ? "Assign the selected records as Payment (OT pay in that month's payroll)"
      : "Assign the selected records as Relaxation or Payment");
  const claimTitle =
    claimPause?.reason ??
    (chosen.length > 0 && chosenClaimable.length === 0
      ? "None of the ticked records can be claimed"
      : "Send claims for the ticked records to the employees' Department Heads");
  return (
    <>
      {view === "waiting" && (
        <SectionCard
          testId="ot-type2"
          icon={Hourglass}
          title="Type 2 · Waiting for a claim or HR"
          description={
            claimsFrom
              ? `For staff who worked past their shift end. From ${dateShort(claimsFrom)}, with the quarters rule on, a day is Type 2 once its overtime reaches a quarter of the employee's own shift and the credit is counted in quarters (less is Type 1's allowance); the employee or HR claims it and the Department Head approves it into the balance, or HR pays it. Earlier days, and days with the quarters rule off, need more than the Type 2 threshold and are assigned by HR as before.`
              : "For staff who worked past their shift end: a quarter of the employee's own shift with the quarters rule on, more than the Type 2 threshold with it off. The employee or HR claims it and the Department Head approves it into the balance, or HR assigns it (Relaxation or Payment), or rejects it."
          }
          actions={<StatusChip tone="info">{anyClaimFlow ? "Claim · HOD approves" : "HR assigns"}</StatusChip>}
          bodyClassName="space-y-4 px-0 pb-0"
        >
          {/* the candidates */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 px-5">
              <p className="text-xs text-muted-foreground">
                {waitingTotal === 1 ? "1 candidate" : `${waitingTotal} candidates`} this month. Tick the ones to decide,
                then {anyClaimable ? "Claim for employee, " : ""}
                {payOnly ? "Pay" : "Assign"} or Reject.
                {anyClaimFlow ? " A claimed record waits for its Department Head." : ""}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground" data-testid="ot2-selected">
                  {chosen.length} selected
                </span>
                {anyClaimable && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!!claimPause || chosenClaimable.length === 0}
                    title={claimTitle}
                    onClick={() => setClaiming(chosenClaimable)}
                    data-testid="ot2-claim"
                  >
                    <Send size={13} className="mr-1.5" />
                    Claim for employee{chosenClaimable.length > 0 ? ` (${chosenClaimable.length})` : ""}
                  </Button>
                )}
                {mayDecide && (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      disabled={disabled || !!assignBlock}
                      title={assignTitle}
                      onClick={() => setAssigning(true)}
                      data-testid="ot2-assign"
                    >
                      {payOnly ? "Pay" : "Assign"}
                      {chosen.length > 0 ? ` (${chosen.length})` : ""}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-rose-600"
                      disabled={disabled}
                      title={pause?.reason ?? "Reject the selected records: no compensation for them"}
                      onClick={() => setRejecting(true)}
                      data-testid="ot2-reject"
                    >
                      Reject
                    </Button>
                  </>
                )}
              </div>
            </div>

            {loading ? (
              <div className="px-5 pb-4 text-sm text-muted-foreground" data-testid="ot-type2-loading">
                Loading the month&apos;s records…
              </div>
            ) : waiting.length === 0 ? (
              <div className="px-5">
                <EmptyNote
                  icon={CheckCheck}
                  title={waitingTotal > 0 ? "No candidate matches these filters" : "Nothing is waiting for HR"}
                  hint={
                    waitingTotal > 0
                      ? "Change the search or the department to see the others."
                      : "Staff who work well past their shift end are listed here with the suggested shifts."
                  }
                  testId="ot-type2-empty"
                />
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1040px] text-sm" data-testid="ot-type2-table">
                    <thead className={TABLE_HEAD}>
                      <tr>
                        <th className="w-10 px-3 py-2.5 pl-5">
                          <Checkbox
                            checked={allOn}
                            onCheckedChange={toggleAll}
                            disabled={selectable.length === 0}
                            aria-label="Select every candidate in the list"
                            data-testid="ot2-select-all"
                          />
                        </th>
                        <th className="px-3 py-2.5">Employee</th>
                        <th className="px-3 py-2.5">OT date</th>
                        <th className="px-3 py-2.5">Shift end</th>
                        <th className="px-3 py-2.5">Last punch</th>
                        <th className="px-3 py-2.5">Extra time</th>
                        <th className="px-3 py-2.5">{anyClaimFlow ? "Credit" : "Suggested"}</th>
                        <th className="px-3 py-2.5">Claim</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {paged.rows.map((row) => {
                        const id = `${row.employeeCode}-${row.date}`;
                        const lock = type2Lock(row);
                        const state = type2ClaimState(row, claimsFrom);
                        const basis = creditBasis(row);
                        const can = canClaim(row);
                        return (
                          <tr
                            key={row.id}
                            className={selected.has(rowKey(row)) && !lock ? "bg-indigo-50/50" : undefined}
                            data-testid={`ot-type2-row-${id}`}
                          >
                            <td className={`${CELL} pl-5`}>
                              <Checkbox
                                checked={!lock && selected.has(rowKey(row))}
                                onCheckedChange={() => toggle(rowKey(row))}
                                disabled={!!lock}
                                title={lock ?? undefined}
                                aria-label={`Select ${row.employeeName}, ${dateShort(row.date)}${lock ? ` (${lock})` : ""}`}
                                data-testid={`ot2-select-${id}`}
                              />
                            </td>
                            <td className={CELL}>
                              <PersonCell name={row.employeeName} code={row.employeeCode} department={row.department} />
                            </td>
                            <td className={`${CELL} whitespace-nowrap`}>{dateShort(row.date)}</td>
                            <td className={`${CELL} text-gray-600`}>{row.shiftEndTime ?? "—"}</td>
                            <td className={`${CELL} whitespace-nowrap text-gray-600`}>
                              <LastPunch row={row} />
                            </td>
                            <td className={`${CELL} whitespace-nowrap font-semibold text-amber-700`}>
                              {formatDuration(row.otMinutes)}
                            </td>
                            <td className={CELL} data-testid={`ot2-credit-${id}`}>
                              <StatusChip tone="info">{creditText(row)}</StatusChip>
                              {basis && <p className="mt-1 text-[11px] text-muted-foreground">{basis}</p>}
                            </td>
                            <td className={CELL}>
                              {row.claim ? (
                                <ClaimCell
                                  claim={row.claim}
                                  employeeId={row.employeeId}
                                  testId={`ot-type2-claim-${id}`}
                                />
                              ) : (
                                <span data-testid={`ot2-claim-state-${id}`} data-status={state.status}>
                                  <StatusChip tone={state.tone} title={state.title}>
                                    {state.text}
                                  </StatusChip>
                                </span>
                              )}
                              {can && (
                                <div>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="mt-1.5 h-8"
                                    disabled={!!claimPause}
                                    title={
                                      claimPause?.reason ??
                                      `Send a claim for this OT of ${row.employeeName} to the Department Head`
                                    }
                                    onClick={() => setClaiming([row])}
                                    data-testid={`ot2-claim-${id}`}
                                  >
                                    Claim
                                  </Button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Pager paged={paged} />
              </>
            )}
          </div>

          {pause?.setting && (
            <p className="px-5 pb-4 text-xs text-muted-foreground">
              <Link
                href={compensationSettingsHref(pause.setting)}
                className="font-semibold text-blue-700 hover:underline"
              >
                Open the setting
              </Link>
            </p>
          )}
        </SectionCard>
      )}

      {/* what HR already dealt with */}
      {view === "assigned" && (
        <SectionCard
          testId="ot-type2-assigned"
          icon={History}
          title="Type 2 · Assigned and rejected"
          description="What is already decided this month: paid or given as Relaxation by HR, credited to the balance by an approved claim, or rejected."
          bodyClassName="space-y-2 px-0 pb-0"
          actions={
            <FilterSelect
              value={status === "all" ? "" : status}
              onChange={(v) => onHistoryStatus(v === "" ? "all" : v)}
              options={HISTORY_STATUSES.map((s) => ({ value: s.value, label: s.label }))}
              allLabel="Assigned and rejected"
              label="Filter by status"
              testId="ot2-history-status"
              className="h-9 w-52"
            />
          }
        >
          <div className="space-y-2">
            {loading ? null : shownHistory.length === 0 ? (
              <div className="px-5 pb-5">
                <EmptyNote
                  icon={History}
                  title={historyTotal > 0 ? "No record matches these filters" : "Nothing assigned or rejected yet"}
                  hint={
                    historyTotal > 0
                      ? "Change the status, search or department."
                      : "Records HR assigns or rejects appear here."
                  }
                  testId="ot-type2-history-empty"
                />
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] text-sm" data-testid="ot-type2-history-table">
                    <thead className={TABLE_HEAD}>
                      <tr>
                        <th className="px-3 py-2.5 pl-5">Employee</th>
                        <th className="px-3 py-2.5">OT date</th>
                        <th className="px-3 py-2.5">Extra time</th>
                        <th className="px-3 py-2.5">Shifts</th>
                        <th className="px-3 py-2.5">Given as</th>
                        <th className="px-3 py-2.5">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {historyPaged.rows.map((row) => (
                        <tr key={row.id} data-testid={`ot-type2-history-row-${row.employeeCode}-${row.date}`}>
                          <td className={`${CELL} pl-5`}>
                            <PersonCell name={row.employeeName} code={row.employeeCode} department={row.department} />
                          </td>
                          <td className={`${CELL} whitespace-nowrap`}>{dateShort(row.date)}</td>
                          <td className={`${CELL} whitespace-nowrap text-amber-700`}>
                            {formatDuration(row.otMinutes)}
                          </td>
                          <td className={`${CELL} whitespace-nowrap font-semibold`}>
                            {row.status === "rejected" && !isCredited(row) ? "—" : shiftsText(shiftsOf(row))}
                          </td>
                          <td className={`${CELL} text-gray-700`}>
                            {row.status === "rejected" && !isCredited(row) ? "—" : assignedText(row)}
                          </td>
                          <td className={CELL}>
                            {isCredited(row) && row.claim ? (
                              <ClaimCell
                                claim={row.claim}
                                employeeId={row.employeeId}
                                testId={`ot-type2-history-claim-${row.employeeCode}-${row.date}`}
                              />
                            ) : (
                              <>
                                <StatusChip tone={row.status === "rejected" ? "danger" : "success"}>
                                  {row.statusLabel}
                                </StatusChip>
                                {row.status === "announced" && row.announcedBy && (
                                  <p className="mt-1 text-[11px] text-muted-foreground">by {row.announcedBy}</p>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager paged={historyPaged} />
              </>
            )}
          </div>
        </SectionCard>
      )}

      {view === "how" && (
        <SectionCard
          testId="ot-type2-how"
          icon={Hourglass}
          title="How the suggested shifts are worked out"
          description="Read-only: the rules are set in Settings → Compensation."
          bodyClassName="space-y-3"
        >
          <ol
            className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-gray-600"
            data-testid="ot2-how-steps"
          >
            <li>
              <strong>Detected.</strong> With the quarters rule on, the overtime reaches a quarter of the
              employee&apos;s own working shift (less is the Type 1 allowance); with it off, and before the claims date,
              the last punch is more than the Type 2 threshold past the shift end. A punch on the next morning before
              the next-morning cut-off (Settings → Attendance, staff) ends the OT day, so it is that day&apos;s
              overtime, shown as &quot;02:10 next day&quot;.
            </li>
            <li>
              <strong>Credit in quarters.</strong> The OT time is divided by the employee&apos;s own working shift
              (shift end - start - lunch) and rounded down to a quarter, at most 1.00. Below a quarter there is no Type
              2 credit.
            </li>
            <li>
              <strong>Claimed and approved.</strong> The employee (in the app) or HR (Claim for employee) claims it; the
              Department Head approves; the shifts are added to the compensation balance, to use on another day.
            </li>
            <li>
              <strong>Or paid.</strong> While Payment is on, HR may pay a record instead (shifts × the daily rate in
              that month&apos;s payroll). One record is paid or credited, never both.
            </li>
          </ol>
          <p className="text-xs text-gray-600" data-testid="ot2-how-before">
            {claimsFrom
              ? `This applies from ${dateShort(claimsFrom)}. Earlier records keep the old way: the shifts come from the last-punch table below and HR assigns them.`
              : "Earlier records keep the old way: the shifts come from the last-punch table below and HR assigns them."}
          </p>
          <ShiftRules defaultOpen />
        </SectionCard>
      )}

      <AssignDialog
        open={assigning}
        onOpenChange={setAssigning}
        selected={chosen}
        modes={chosenModes}
        onAssigned={afterAssign}
      />

      <ClaimDialog
        open={claiming !== null}
        onOpenChange={(open) => !open && setClaiming(null)}
        kind="ot_shift"
        rows={claiming ?? []}
        onClaimed={afterClaim}
      />

      <AlertDialog open={rejecting} onOpenChange={(open) => !reject.isPending && setRejecting(open)}>
        <AlertDialogContent data-testid="reject-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Reject {chosen.length} {chosen.length === 1 ? "record" : "records"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Rejected records get no compensation and leave this waiting list. Use it when the late stay was authorised
              work that is not real overtime. A rejected record cannot be put back from here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reject.isPending}>Keep them waiting</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void doReject();
              }}
              disabled={reject.isPending}
              data-testid="reject-confirm"
            >
              {reject.isPending ? (
                <Loader2 size={14} className="mr-2 animate-spin" />
              ) : (
                <XCircle size={14} className="mr-2" />
              )}
              Reject {chosen.length === 1 ? "this record" : `${chosen.length} records`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
