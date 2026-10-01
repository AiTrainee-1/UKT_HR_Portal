import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Clock, UserPlus } from "lucide-react";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useListDepartments, useListEmployees } from "@/lib/api-client";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  useApplyShiftAssignment,
  useListDesignations,
  useListShiftAssignments,
  usePlanShiftAssignment,
  type AssignRequest,
  type ConflictDecision,
  type PlanResult,
  type ShiftItem,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import PlanPreview from "./PlanPreview";
import SelectionBuilder from "./SelectionBuilder";
import {
  addDaysIso,
  applyBlocker,
  buildRequest,
  canPreview,
  confirmLabel,
  prettyDate,
  summaryLine,
  todayIso,
  type AssignState,
  type Rule,
} from "./shift-logic";

export type AssignDialogStart = {
  /** Open with this shift chosen. */
  shiftId?: number;
  /** The shift cannot be changed (assigning from a shift's own card). */
  lockShift?: boolean;
  /** Open with these employees already included. */
  employees?: { id: number; label: string; sub?: string }[];
  /** Open with "everyone of the shift's type" on. */
  includeAll?: boolean;
  /** Open with this answer for people already on a shift (moving people from one shift to another says reassign). */
  onConflict?: ConflictDecision;
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-black text-primary-foreground">
          {n}
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-bold leading-6 text-gray-900">{title}</h3>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      </div>
      <div className="sm:pl-8">{children}</div>
    </section>
  );
}

/**
 * Assign a shift to many people at once. Pick the shift and the date, build the selection (any number of employees,
 * departments and designations, each included or excluded), and the preview on the right shows what would happen to
 * every person before anything is saved: new, already on a shift (keep or reassign, for all or one by one), skipped, or
 * needing attention. The button writes exactly the plan that the server makes again at that moment.
 */
export default function AssignDialog({
  open,
  onClose,
  shifts,
  start,
}: {
  open: boolean;
  onClose: () => void;
  shifts: ShiftItem[];
  start: AssignDialogStart;
}) {
  const { toast } = useToast();
  const apply = useApplyShiftAssignment();

  const [state, setState] = useState<AssignState>(() => ({
    shiftId: start.shiftId ?? null,
    effectiveFrom: todayIso(),
    rules: (start.employees ?? []).map<Rule>((e) => ({
      kind: "employee",
      id: e.id,
      label: e.label,
      sub: e.sub,
      mode: "include",
    })),
    includeAll: !!start.includeAll,
    customStartTime: "",
    customEndTime: "",
    saturdayOff: false,
    notes: "",
    onConflict: start.onConflict ?? "keep",
    decisions: {},
  }));
  const [confirming, setConfirming] = useState(false);
  const patch = (p: Partial<AssignState>) => setState((s) => ({ ...s, ...p }));

  const { data: employees = [] } = useListEmployees({ status: "active" });
  const { data: departments = [] } = useListDepartments();
  const { data: designations = [] } = useListDesignations();
  const { data: assignments = [] } = useListShiftAssignments({ activeOnly: true });

  const shift = shifts.find((s) => s.id === state.shiftId) ?? null;
  const currentShift = useMemo(() => new Map(assignments.map((a) => [a.employeeId, a.shiftName ?? ""])), [assignments]);

  const request = buildRequest(state);
  const requestKey = JSON.stringify(request);
  const settledKey = useDebounced(requestKey, 350);
  const settled = useMemo(() => JSON.parse(settledKey) as AssignRequest, [settledKey]);
  const ready = canPreview(state);
  const { data: plan, isFetching } = usePlanShiftAssignment(settled, ready);
  const waiting = ready && (isFetching || settledKey !== requestKey);
  const stale: PlanResult | undefined = ready ? plan : undefined;

  const blocker = applyBlocker(stale, waiting);
  const counts = stale?.counts;
  const customHoursWrong =
    !!state.customStartTime && !!state.customEndTime && state.customEndTime <= state.customStartTime;

  const run = async () => {
    try {
      const res = await apply.mutateAsync(request);
      const a = res.applied;
      const bits = [
        a?.created ? `${a.created} assigned` : null,
        a?.reassigned || a?.updated ? `${(a.reassigned ?? 0) + (a.updated ?? 0)} reassigned` : null,
        a?.kept ? `${a.kept} kept their shift` : null,
        a?.unchanged ? `${a.unchanged} already on it` : null,
        a?.skipped || a?.excluded ? `${(a.skipped ?? 0) + (a.excluded ?? 0)} skipped` : null,
        a?.blocked ? `${a.blocked} need attention` : null,
      ].filter(Boolean);
      toast({
        title: `${res.shift?.name ?? "Shift"} updated for ${a?.assigned ?? 0} employee${a?.assigned === 1 ? "" : "s"}`,
        description: bits.join(" · ") || undefined,
      });
      onClose();
    } catch (e) {
      const body = e instanceof ApiError ? (e.data as PlanResult | null) : null;
      toast({
        title: "The shift was not assigned",
        description: body?.errors?.[0] ?? (e instanceof Error ? e.message : undefined),
        variant: "destructive",
      });
    } finally {
      setConfirming(false);
    }
  };

  const press = () => {
    if (blocker) return;
    if ((counts?.willReassign ?? 0) > 0) setConfirming(true);
    else void run();
  };

  const active = shifts.filter((s) => s.isActive);
  const dayChip = (label: string, iso: string) => (
    <button
      type="button"
      onClick={() => patch({ effectiveFrom: iso })}
      aria-pressed={state.effectiveFrom === iso}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-colors",
        state.effectiveFrom === iso
          ? "border-blue-200 bg-blue-50 text-blue-700"
          : "border-gray-200 text-gray-500 hover:border-gray-300",
      )}
    >
      {label}
    </button>
  );

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent
          className="flex h-[92vh] max-h-[92vh] w-[calc(100%-1.5rem)] max-w-6xl flex-col gap-0 overflow-hidden p-0"
          data-testid="assign-dialog"
        >
          <DialogHeader className="border-b bg-gradient-to-br from-sky-50 via-white to-emerald-50/60 px-5 py-4 pr-14 sm:px-6">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                <UserPlus size={19} />
              </span>
              <div className="min-w-0">
                <DialogTitle className="text-lg font-black">Assign a shift</DialogTitle>
                <DialogDescription className="text-xs">
                  Choose who works it. Nothing is saved until you press the button, and anyone already on a shift is
                  never changed without your say.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:overflow-hidden">
            <div className="space-y-6 p-5 sm:p-6 lg:overflow-y-auto lg:border-r">
              <Step n={1} title="Shift and start date">
                <div className="space-y-3">
                  {start.lockShift && shift ? (
                    <div className="rounded-xl border bg-gray-50/70 px-3 py-2.5" data-testid="assign-locked-shift">
                      <p className="text-sm font-bold text-gray-900">{shift.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {shift.startTime}–{shift.endTime} · {shift.shiftType} shift
                      </p>
                    </div>
                  ) : (
                    <Select
                      value={state.shiftId ? String(state.shiftId) : ""}
                      onValueChange={(v) => patch({ shiftId: Number(v), decisions: {} })}
                    >
                      <SelectTrigger className="h-10" data-testid="assign-shift-select">
                        <SelectValue placeholder="Choose a shift…" />
                      </SelectTrigger>
                      <SelectContent>
                        {(["staff", "production"] as const).map((type) => {
                          const list = active.filter((s) => s.shiftType === type);
                          return (
                            list.length > 0 && (
                              <SelectGroup key={type}>
                                <SelectLabel className="capitalize">{type} shifts</SelectLabel>
                                {list.map((s) => (
                                  <SelectItem key={s.id} value={String(s.id)}>
                                    {s.name} ({s.startTime}–{s.endTime})
                                    {s.genderRule !== "all" ? ` · ${s.genderRule} only` : ""}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            )
                          );
                        })}
                      </SelectContent>
                    </Select>
                  )}
                  {shift && !start.lockShift && (
                    <p
                      className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground"
                      data-testid="assign-shift-facts"
                    >
                      <span className="flex items-center gap-1">
                        <Clock size={12} /> {shift.startTime}–{shift.endTime}
                      </span>
                      <span className="capitalize">{shift.shiftType}</span>
                      {shift.genderRule !== "all" && <span className="capitalize">{shift.genderRule} only</span>}
                      <span>{shift.assignedCount ?? 0} on it now</span>
                    </p>
                  )}

                  <div>
                    <label htmlFor="assign-date" className="mb-1 block text-xs font-semibold text-gray-700">
                      Effective from
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <Input
                        id="assign-date"
                        type="date"
                        value={state.effectiveFrom}
                        onChange={(e) => patch({ effectiveFrom: e.target.value })}
                        className="h-9 w-44"
                        data-testid="assign-date"
                      />
                      {dayChip("Today", todayIso())}
                      {dayChip("Tomorrow", addDaysIso(todayIso(), 1))}
                    </div>
                    {state.effectiveFrom && (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Attendance from {prettyDate(state.effectiveFrom)} uses this shift. The shift they are on now
                        ends the day before.
                      </p>
                    )}
                  </div>
                </div>
              </Step>

              <Step n={2} title="Who gets it?" hint="Include or exclude employees, departments and designations.">
                <SelectionBuilder
                  shiftType={shift?.shiftType ?? null}
                  rules={state.rules}
                  onRules={(rules) => patch({ rules, decisions: {} })}
                  includeAll={state.includeAll}
                  onIncludeAll={(includeAll) => patch({ includeAll })}
                  employees={employees}
                  departments={departments}
                  designations={designations}
                  currentShift={currentShift}
                />
              </Step>

              <details className="group rounded-2xl border bg-white" data-testid="assign-options">
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-bold text-gray-900">
                  Custom schedule and note <span className="text-xs font-normal text-muted-foreground">optional</span>
                  <ChevronDown size={15} className="text-gray-400 transition-transform group-open:rotate-180" />
                </summary>
                <div className="space-y-3 border-t px-4 py-4">
                  <p className="text-xs text-muted-foreground">
                    Leave blank to use the shift's own hours. These apply to <b>everyone</b> in this assignment.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="assign-cstart" className="mb-1 block text-xs font-semibold text-gray-700">
                        Custom start
                      </label>
                      <Input
                        id="assign-cstart"
                        type="time"
                        value={state.customStartTime}
                        onChange={(e) => patch({ customStartTime: e.target.value })}
                        className="h-9"
                        data-testid="assign-cstart"
                      />
                    </div>
                    <div>
                      <label htmlFor="assign-cend" className="mb-1 block text-xs font-semibold text-gray-700">
                        Custom end
                      </label>
                      <Input
                        id="assign-cend"
                        type="time"
                        value={state.customEndTime}
                        onChange={(e) => patch({ customEndTime: e.target.value })}
                        className="h-9"
                        aria-invalid={customHoursWrong}
                        data-testid="assign-cend"
                      />
                    </div>
                  </div>
                  {customHoursWrong && (
                    <p className="text-xs font-medium text-red-600" role="alert">
                      A shift cannot end before it starts. Overnight shifts are not supported.
                    </p>
                  )}
                  {shift?.shiftType !== "production" && (
                    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-2.5">
                      <span>
                        <span className="block text-sm font-semibold text-gray-900">Saturday off</span>
                        <span className="block text-xs text-muted-foreground">
                          Monday to Friday only; Saturdays are skipped in payroll.
                        </span>
                      </span>
                      <Switch
                        checked={state.saturdayOff}
                        onCheckedChange={(v) => patch({ saturdayOff: v })}
                        data-testid="assign-saturday"
                        aria-label="Saturday off"
                      />
                    </label>
                  )}
                  <div>
                    <label htmlFor="assign-notes" className="mb-1 block text-xs font-semibold text-gray-700">
                      Note
                    </label>
                    <Input
                      id="assign-notes"
                      value={state.notes}
                      onChange={(e) => patch({ notes: e.target.value })}
                      maxLength={500}
                      placeholder="e.g. Seasonal roster"
                      className="h-9"
                    />
                  </div>
                </div>
              </details>
            </div>

            <div className="bg-gray-50/70 p-5 sm:p-6 lg:overflow-y-auto">
              <PlanPreview
                plan={stale}
                ready={ready}
                loading={waiting}
                shiftName={shift?.name ?? "this shift"}
                onConflict={state.onConflict}
                onOnConflict={(v) => patch({ onConflict: v, decisions: {} })}
                decisions={state.decisions}
                onDecision={(id, v) => patch({ decisions: { ...state.decisions, [String(id)]: v } })}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t bg-white px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p className="min-w-0 text-xs text-muted-foreground" data-testid="assign-summary">
              {blocker
                ? counts && stale?.ok && summaryLine(counts)
                  ? `${blocker}. ${summaryLine(counts)}`
                  : blocker
                : counts
                  ? summaryLine(counts)
                  : ""}
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={press} disabled={!!blocker || apply.isPending} data-testid="assign-confirm">
                {apply.isPending ? "Saving…" : confirmLabel(stale?.counts)}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirming} onOpenChange={(o) => !o && setConfirming(false)}>
        <AlertDialogContent data-testid="reassign-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Reassign {counts?.willReassign ?? 0} employee{counts?.willReassign === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They are on another shift now. Their current shift ends the day before {prettyDate(state.effectiveFrom)}{" "}
              and {shift?.name ?? "the new shift"} starts that day. Days before then keep the old shift, so past
              attendance and payroll do not change.
              {(counts?.new ?? 0) > 0 &&
                ` ${counts?.new} new ${counts?.new === 1 ? "person is" : "people are"} assigned too.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back</AlertDialogCancel>
            <AlertDialogAction onClick={() => void run()} data-testid="reassign-confirm-yes">
              Reassign
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
