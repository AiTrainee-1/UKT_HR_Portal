import { useMemo, useState } from "react";
import { Link } from "wouter";
import { CheckCheck, History, Hourglass, Loader2, XCircle } from "lucide-react";
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
import {
  HISTORY_STATUSES,
  assignedText,
  filterHistory,
  isHistoryStatus,
  lastPunchText,
  rowKey,
  shiftsOf,
  type HistoryStatus,
  type Pause,
} from "./ot-logic";
import { ShiftRules } from "./RulesExplain";

/**
 * Type 2: shift-based compensation (0.25 / 0.50 / 0.75 / 1 shift) for staff who worked well past their shift end. It is NOT
 * automatic: the candidates wait here with the rules' suggested shifts until HR assigns them (Relaxation or Payment) or
 * rejects them. Three nested subtabs show one thing each: the candidates waiting, what was already assigned or rejected, and
 * how the suggested shifts are worked out. The ticked rows live here, so they stay ticked while HR looks at another one.
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
}) {
  const { toast } = useToast();
  const reject = useRejectOvertime();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const chosen = useMemo(() => waiting.filter((r) => selected.has(rowKey(r))), [waiting, selected]);
  const paged = usePaged(waiting, `t2w|${waiting.length}`);
  const status: HistoryStatus = isHistoryStatus(historyStatus) ? historyStatus : "all";
  const shownHistory = useMemo(() => filterHistory(history, status), [history, status]);
  const historyPaged = usePaged(shownHistory, `t2h|${status}|${shownHistory.length}`);

  const allOn = waiting.length > 0 && chosen.length === waiting.length;
  const toggle = (key: string) =>
    setSelected((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleAll = () => setSelected(allOn ? new Set() : new Set(waiting.map(rowKey)));

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
  return (
    <>
      {view === "waiting" && (
        <SectionCard
          testId="ot-type2"
          icon={Hourglass}
          title="Type 2 · Waiting for HR"
          description="For staff who worked more than the Type 2 threshold past their shift end. HR assigns it as Relaxation or Payment, or rejects it."
          actions={<StatusChip tone="info">HR assigns</StatusChip>}
          bodyClassName="space-y-4 px-0 pb-0"
        >
          {/* the candidates */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 px-5">
              <p className="text-xs text-muted-foreground">
                {waitingTotal === 1 ? "1 candidate" : `${waitingTotal} candidates`} this month. Tick the ones to decide,
                then Assign or Reject.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground" data-testid="ot2-selected">
                  {chosen.length} selected
                </span>
                <Button
                  type="button"
                  size="sm"
                  disabled={disabled}
                  title={pause?.reason ?? "Assign the selected records as Relaxation or Payment"}
                  onClick={() => setAssigning(true)}
                  data-testid="ot2-assign"
                >
                  Assign{chosen.length > 0 ? ` (${chosen.length})` : ""}
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
                  <table className="w-full min-w-[820px] text-sm" data-testid="ot-type2-table">
                    <thead className={TABLE_HEAD}>
                      <tr>
                        <th className="w-10 px-3 py-2.5 pl-5">
                          <Checkbox
                            checked={allOn}
                            onCheckedChange={toggleAll}
                            aria-label="Select every candidate in the list"
                            data-testid="ot2-select-all"
                          />
                        </th>
                        <th className="px-3 py-2.5">Employee</th>
                        <th className="px-3 py-2.5">OT date</th>
                        <th className="px-3 py-2.5">Shift end</th>
                        <th className="px-3 py-2.5">Last punch</th>
                        <th className="px-3 py-2.5">Extra time</th>
                        <th className="px-3 py-2.5">Suggested</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {paged.rows.map((row) => (
                        <tr
                          key={row.id}
                          className={selected.has(rowKey(row)) ? "bg-indigo-50/50" : undefined}
                          data-testid={`ot-type2-row-${row.employeeCode}-${row.date}`}
                        >
                          <td className={`${CELL} pl-5`}>
                            <Checkbox
                              checked={selected.has(rowKey(row))}
                              onCheckedChange={() => toggle(rowKey(row))}
                              aria-label={`Select ${row.employeeName}, ${dateShort(row.date)}`}
                              data-testid={`ot2-select-${row.employeeCode}-${row.date}`}
                            />
                          </td>
                          <td className={CELL}>
                            <PersonCell name={row.employeeName} code={row.employeeCode} department={row.department} />
                          </td>
                          <td className={`${CELL} whitespace-nowrap`}>{dateShort(row.date)}</td>
                          <td className={`${CELL} text-gray-600`}>{row.shiftEndTime ?? "—"}</td>
                          <td className={`${CELL} whitespace-nowrap text-gray-600`}>{lastPunchText(row)}</td>
                          <td className={`${CELL} whitespace-nowrap font-semibold text-amber-700`}>
                            {formatDuration(row.otMinutes)}
                          </td>
                          <td className={CELL}>
                            <StatusChip tone="info">{shiftsText(row.suggestedShifts)}</StatusChip>
                          </td>
                        </tr>
                      ))}
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
          description="What HR already dealt with this month: given as Relaxation or Payment, or rejected."
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
                            {row.status === "rejected" ? "—" : shiftsText(shiftsOf(row))}
                          </td>
                          <td className={`${CELL} text-gray-700`}>
                            {row.status === "rejected" ? "—" : assignedText(row)}
                          </td>
                          <td className={CELL}>
                            <StatusChip tone={row.status === "rejected" ? "danger" : "success"}>
                              {row.statusLabel}
                            </StatusChip>
                            {row.status === "announced" && row.announcedBy && (
                              <p className="mt-1 text-[11px] text-muted-foreground">by {row.announcedBy}</p>
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
        >
          <ShiftRules defaultOpen />
        </SectionCard>
      )}

      <AssignDialog
        open={assigning}
        onOpenChange={setAssigning}
        selected={chosen}
        modes={modes}
        onAssigned={afterAssign}
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
