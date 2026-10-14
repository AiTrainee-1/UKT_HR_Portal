import { useMemo, useState } from "react";
import { CalendarClock, Banknote, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  useAssignOvertime,
  type OvertimeAssignResult,
  type OvertimeMode,
  type OvertimeRow,
  type ShiftsValue,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { dateShort, shiftsText } from "../logic";
import { ErrorNotice, Field, Notice, PersonCell, ShiftsPicker, useSingleFlight } from "../ui";
import {
  applySkipped,
  assignFailure,
  assignPayload,
  assignSummary,
  checkAssign,
  commonBounds,
  effectText,
  grantBounds,
  initialAssignRows,
  remainingAfter,
  type AssignRow,
} from "./ot-logic";

// "Assign": HR gives Type 2 (shift-based) compensation to the selected records. The dialog asks how (Relaxation or Payment,
// only those switched on in Settings), how many shifts for each record (starting at the rules' suggestion), the date it is
// granted (the same month as the OT day), and says what will happen before anything is sent. A record the server refuses
// stays in the dialog with the reason under it; the others are assigned.

const MODE_INFO: Record<OvertimeMode, { title: string; text: string; icon: typeof CalendarClock }> = {
  relaxation: {
    title: "Relaxation",
    text: "An alternative day off: the day you choose is topped up by the shifts, and attendance marks it as Compensation.",
    icon: CalendarClock,
  },
  pay: {
    title: "Payment",
    text: "Paid in that month's payroll as OT pay: shifts × the employee's daily rate. Payment is for Type 2 only.",
    icon: Banknote,
  },
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Type 2 records selected in the list. */
  selected: OvertimeRow[];
  /** The modes switched on in Settings -> Compensation (never empty while this can be opened). */
  modes: OvertimeMode[];
  /** Called with what the server assigned (a partial result closes nothing: the refused ones stay in the dialog). */
  onAssigned: (result: OvertimeAssignResult) => void;
};

export function AssignDialog({ open, onOpenChange, selected, modes, onAssigned }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto" data-testid="assign-dialog">
        {open && <AssignForm selected={selected} modes={modes} onOpenChange={onOpenChange} onAssigned={onAssigned} />}
      </DialogContent>
    </Dialog>
  );
}

function AssignForm({
  selected,
  modes,
  onOpenChange,
  onAssigned,
}: Pick<Props, "selected" | "modes" | "onOpenChange" | "onAssigned">) {
  const { toast } = useToast();
  const assign = useAssignOvertime();
  const [mode, setMode] = useState<OvertimeMode | null>(modes[0] ?? null);
  const [rows, setRows] = useState<AssignRow[]>(() => initialAssignRows(selected));
  const [allDate, setAllDate] = useState("");
  const [error, setError] = useState<string | null>(null);

  const check = useMemo(() => checkAssign(mode, modes, rows), [mode, modes, rows]);
  const shared = useMemo(() => commonBounds(rows), [rows]);

  const change = (key: string, patch: Partial<AssignRow>) =>
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch, problem: null } : r)));

  const setAll = (date: string) => {
    setAllDate(date);
    setRows((list) => list.map((r) => ({ ...r, claimDate: date, problem: null })));
  };

  const once = useSingleFlight();
  const submit = () =>
    once(async () => {
      if (!mode || !check.ok || assign.isPending) return;
      setError(null);
      try {
        const result = await assign.mutateAsync(assignPayload(mode, rows));
        onAssigned(result);
        if (result.skipped.length === 0) {
          toast({ title: `Assigned ${result.assigned} ${result.assigned === 1 ? "record" : "records"}` });
          onOpenChange(false);
          return;
        }
        toast({
          title: `Assigned ${result.assigned}; ${result.skipped.length} could not be assigned`,
          description: "The records that could not be assigned stay open here with the reason.",
          variant: "destructive",
        });
        setRows(remainingAfter(rows, result.skipped));
      } catch (err) {
        const failure = assignFailure(err);
        setRows(applySkipped(rows, failure.skipped));
        setError(failure.message);
      }
    });

  const total = rows.length;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Assign shift compensation</DialogTitle>
        <DialogDescription>
          Type 2: staff who worked well past their shift end. HR chooses how it is given, how many shifts, and the date
          (any day of the same month as the overtime). {total} {total === 1 ? "record" : "records"} selected.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div
          role="radiogroup"
          aria-label="How to give it"
          className="grid gap-2 sm:grid-cols-2"
          data-testid="assign-modes"
        >
          {modes.map((m) => {
            const info = MODE_INFO[m];
            const Icon = info.icon;
            const on = mode === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                data-testid={`assign-mode-${m}`}
                className={cn(
                  "flex items-start gap-3 rounded-xl border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  on ? "border-indigo-500 bg-indigo-50" : "border-slate-200 bg-white hover:bg-slate-50",
                )}
              >
                <span className="mt-0.5 rounded-lg bg-white p-2 text-indigo-700 ring-1 ring-slate-200">
                  <Icon size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-gray-900">
                    {info.title}
                    {on && <span className="ml-2 text-[11px] font-semibold text-indigo-700">Chosen</span>}
                  </span>
                  <span className="block text-xs leading-snug text-muted-foreground">{info.text}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Same date for everyone (optional shortcut)"
            htmlFor="assign-date-all"
            hint={
              shared
                ? `Between ${dateShort(shared.min)} and ${dateShort(shared.max)}: the month of the overtime.`
                : "The records are in different months: choose each date below."
            }
          >
            <Input
              id="assign-date-all"
              type="date"
              value={allDate}
              min={shared?.min}
              max={shared?.max}
              disabled={!shared}
              onChange={(e) => setAll(e.target.value)}
              className="w-44"
              data-testid="assign-date-all"
            />
          </Field>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[820px] text-sm" data-testid="assign-table">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2.5">Employee</th>
                <th className="px-3 py-2.5">OT day</th>
                <th className="px-3 py-2.5">Shifts</th>
                <th className="px-3 py-2.5">{mode === "pay" ? "Granted date (optional)" : "Granted date"}</th>
                <th className="px-3 py-2.5">What will happen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => {
                const bounds = grantBounds(row.date);
                const problem = row.problem ?? check.problems[row.key] ?? null;
                const id = `${row.employeeCode}-${row.date}`;
                return (
                  <tr key={row.key} className="align-top" data-testid={`assign-row-${id}`}>
                    <td className="px-3 py-3">
                      <PersonCell name={row.employeeName} code={row.employeeCode} />
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-gray-700">{dateShort(row.date)}</td>
                    <td className="px-3 py-3">
                      <ShiftsPicker
                        value={row.shifts}
                        suggested={row.suggested}
                        label={`Shifts for ${row.employeeName} on ${dateShort(row.date)}`}
                        onChange={(shifts: ShiftsValue) => change(row.key, { shifts })}
                        testId={`assign-shifts-${id}`}
                      />
                      {row.suggested !== null && (
                        <p className="mt-1 text-[11px] text-muted-foreground">Suggested: {shiftsText(row.suggested)}</p>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <Input
                        type="date"
                        aria-label={`Granted date for ${row.employeeName} (OT of ${dateShort(row.date)})`}
                        value={row.claimDate}
                        min={bounds?.min}
                        max={bounds?.max}
                        onChange={(e) => change(row.key, { claimDate: e.target.value })}
                        className="w-40"
                        data-testid={`assign-claim-${id}`}
                      />
                    </td>
                    <td className="px-3 py-3 text-xs leading-snug text-gray-600">
                      {mode ? effectText(mode, row) : "—"}
                      {problem && (
                        <p role="alert" className="mt-1 font-medium text-red-600" data-testid={`assign-problem-${id}`}>
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

        {mode && rows.length > 0 && (
          <Notice accent="slate" testId="assign-summary">
            <p>{assignSummary(mode, rows)}</p>
          </Notice>
        )}
        {error && <ErrorNotice testId="assign-error">{error}</ErrorNotice>}
        {check.general && <p className="text-xs text-red-600">{check.general}</p>}
      </div>

      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={!check.ok || assign.isPending}
          data-testid="assign-submit"
          title={check.ok ? undefined : "Fix the highlighted rows first"}
        >
          {assign.isPending && <Loader2 size={14} className="mr-2 animate-spin" />}
          Assign {total} {total === 1 ? "record" : "records"}
        </Button>
      </DialogFooter>
    </>
  );
}
