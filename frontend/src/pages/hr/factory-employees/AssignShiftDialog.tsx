import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useDebounced } from "@/hooks/use-debounced";
import { useToast } from "@/hooks/use-toast";
import {
  useApplyFactoryShift,
  useFactoryEmployees,
  useFactoryShiftPlan,
  type FactoryEmployee,
  type FactoryPayrollCategory,
  type FactoryShiftBody,
  type FactoryShiftGroup,
} from "@/lib/api-client/custom-hooks";
import { addDaysIso, applyBlocker, confirmLabel, prettyDate, summaryLine, todayIso } from "../shifts/shift-logic";
import { EmployeePicker } from "./EmployeePicker";
import {
  CATEGORY_LABEL,
  categoriesIn,
  categoryOf,
  employees,
  errorText,
  shiftApplyToast,
  shiftBody,
  shiftsFor,
} from "./logic";
import { ChoiceCards, Field, Lines, SELECT_CLASS } from "./parts";

export type ShiftTarget = { rows: FactoryEmployee[]; shiftId?: number };

/**
 * Put factory employees on an existing shift (or move them to another) from a day. The Manage Shifts planner is
 * underneath (through this page's own endpoints), so the summary shows what will happen before anything is saved, and
 * whoever is on another shift is moved (their old shift ends the day before). A staff shift is for Staff Payroll
 * employees, a production one for Production Payroll ones, so one kind is done at a time. Shifts themselves are created
 * and changed on Manage Shifts.
 */
export function AssignShiftDialog({
  target,
  shifts,
  onClose,
}: {
  target: ShiftTarget;
  shifts: FactoryShiftGroup[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const apply = useApplyFactoryShift();
  // every active factory employee: the people this assignment can include
  const pool = useFactoryEmployees({ status: "active" });
  const lockedShift = target.shiftId ? (shifts.find((s) => s.id === target.shiftId) ?? null) : null;
  const kinds = categoriesIn(target.rows);
  const [category, setCategory] = useState<FactoryPayrollCategory>(
    lockedShift ? lockedShift.shiftType : (kinds[0] ?? "staff"),
  );
  const [shiftId, setShiftId] = useState<string>(target.shiftId ? String(target.shiftId) : "");
  const [from, setFrom] = useState(todayIso());
  const [saturdayOff, setSaturdayOff] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(
    () => new Set(target.rows.filter((r) => r.status === "active" && categoryOf(r) === category).map((r) => r.id)),
  );

  const offered = shiftsFor(shifts, category);
  const shift = shifts.find((s) => String(s.id) === shiftId) ?? null;
  const inactive = target.rows.filter((r) => r.status !== "active").length;
  const otherKind = target.rows.filter((r) => r.status === "active" && categoryOf(r) !== category).length;

  const people = useMemo(() => {
    const byId = new Map<number, FactoryEmployee>();
    for (const r of pool.data?.employees ?? []) if (r.status === "active") byId.set(r.id, r);
    for (const r of target.rows) if (r.status === "active" && !byId.has(r.id)) byId.set(r.id, r);
    return [...byId.values()].filter((r) => categoryOf(r) === category).sort((a, b) => a.name.localeCompare(b.name));
  }, [pool.data, target.rows, category]);

  const pickCategory = (c: FactoryPayrollCategory) => {
    setCategory(c);
    setShiftId("");
    setSaturdayOff(false);
    setPicked(new Set(target.rows.filter((r) => r.status === "active" && categoryOf(r) === c).map((r) => r.id)));
  };

  const ids = [...picked].sort((a, b) => a - b);
  const ready = !!shift && ids.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(from);
  const body = shiftBody(ids, shift?.id ?? 0, from, category === "staff" && saturdayOff);
  const bodyKey = JSON.stringify(body);
  const settledKey = useDebounced(bodyKey, 250);
  const settled = useMemo(() => JSON.parse(settledKey) as FactoryShiftBody, [settledKey]);
  const plan = useFactoryShiftPlan(settled, ready && settled.shiftId > 0 && settled.employeeIds.length > 0);
  const waiting = ready && (plan.isFetching || settledKey !== bodyKey);
  const current = ready ? plan.data : undefined;
  const blocker = ready
    ? applyBlocker(current, waiting)
    : !shift
      ? "Choose a shift"
      : ids.length === 0
        ? "Choose who gets it"
        : "Pick the start day";

  const run = async () => {
    if (blocker) return;
    try {
      const result = await apply.mutateAsync(body);
      const names = new Map(people.map((r) => [r.id, r.name]));
      const words = shiftApplyToast(result, names);
      toast({
        title: words.title,
        description: words.lines.length ? <Lines lines={words.lines} /> : undefined,
        variant: words.failed ? "destructive" : undefined,
      });
      onClose();
    } catch (e) {
      toast({ title: "The shift was not assigned", description: errorText(e), variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex max-h-[92vh] w-[calc(100%-1.5rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0"
        data-testid="fe-shift-dialog"
      >
        <DialogHeader className="border-b bg-gradient-to-br from-teal-50 via-white to-sky-50/60 px-5 py-4 pr-14">
          <DialogTitle className="text-lg font-black">
            {lockedShift ? `Assign ${lockedShift.name}` : "Assign a shift"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            From the start day, attendance uses this shift. Anyone on another shift is moved: their old shift ends the
            day before, so past attendance and payroll do not change.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {!lockedShift && kinds.length > 1 && (
            <Field
              label="Which employees"
              hint="A staff shift is for Staff Payroll employees and a production shift for Production Payroll ones."
            >
              <ChoiceCards<FactoryPayrollCategory>
                value={category}
                onChange={pickCategory}
                testId="fe-shift-kind"
                options={kinds.map((k) => ({
                  value: k,
                  label: CATEGORY_LABEL[k],
                  sub: `${employees(target.rows.filter((r) => categoryOf(r) === k).length)} in the selection`,
                }))}
              />
            </Field>
          )}

          {lockedShift ? (
            <div className="rounded-xl border bg-gray-50/70 px-3 py-2.5" data-testid="fe-shift-locked">
              <p className="text-sm font-bold text-gray-900">{lockedShift.name}</p>
              <p className="text-xs text-muted-foreground">
                {lockedShift.startTime}-{lockedShift.endTime} · {lockedShift.shiftType} shift ·{" "}
                {employees(lockedShift.employees.length)} from this page on it
              </p>
            </div>
          ) : (
            <Field label="Shift" htmlFor="fe-shift-select" required>
              <select
                id="fe-shift-select"
                className={SELECT_CLASS}
                value={shiftId}
                onChange={(e) => setShiftId(e.target.value)}
                data-testid="fe-shift-select"
              >
                <option value="">Choose a {category} shift…</option>
                {offered.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name} ({s.startTime}-{s.endTime}){s.genderRule !== "all" ? ` · ${s.genderRule} only` : ""}
                  </option>
                ))}
              </select>
              {offered.length === 0 && (
                <p className="text-xs text-amber-800">
                  There is no {category} shift yet. Shifts are created on{" "}
                  <Link href="/hr/shifts" className="font-semibold underline">
                    Manage Shifts
                  </Link>
                  .
                </p>
              )}
              {shift && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock size={12} /> {shift.startTime}-{shift.endTime}
                  {shift.graceMinutes != null && ` · grace ${shift.graceMinutes} min`} ·{" "}
                  {employees(shift.employees.length)} from this page on it
                </p>
              )}
            </Field>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Starts on"
              htmlFor="fe-shift-from"
              required
              hint={from ? `From ${prettyDate(from)}` : undefined}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="fe-shift-from"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="h-10 w-44"
                  data-testid="fe-shift-from"
                />
                <button
                  type="button"
                  className="text-xs font-semibold text-blue-600 hover:underline"
                  onClick={() => setFrom(todayIso())}
                >
                  Today
                </button>
                <button
                  type="button"
                  className="text-xs font-semibold text-blue-600 hover:underline"
                  onClick={() => setFrom(addDaysIso(todayIso(), 1))}
                >
                  Tomorrow
                </button>
              </div>
            </Field>
            {category === "staff" && (
              <label className="flex cursor-pointer items-center justify-between gap-3 self-end rounded-xl border px-3 py-2.5">
                <span>
                  <span className="block text-sm font-semibold text-gray-900">Saturday off</span>
                  <span className="block text-xs text-muted-foreground">Monday to Friday only</span>
                </span>
                <Switch
                  checked={saturdayOff}
                  onCheckedChange={setSaturdayOff}
                  aria-label="Saturday off"
                  data-testid="fe-shift-saturday"
                />
              </label>
            )}
          </div>

          <Field label="Who gets it" required>
            <EmployeePicker
              rows={people}
              picked={picked}
              onPicked={setPicked}
              loading={pool.isLoading && target.rows.length === 0}
              emptyText={`No active ${CATEGORY_LABEL[category]} factory employees.`}
            />
            {(inactive > 0 || otherKind > 0) && (
              <p className="text-xs text-muted-foreground" data-testid="fe-shift-left-out">
                {inactive > 0 &&
                  `${employees(inactive)} in the selection ${inactive === 1 ? "is" : "are"} inactive and left out. `}
                {otherKind > 0 &&
                  `${employees(otherKind)} of the other payroll ${otherKind === 1 ? "is" : "are"} not changed by this shift.`}
              </p>
            )}
          </Field>
        </div>

        <div className="flex flex-col gap-2 border-t bg-white px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 text-xs text-muted-foreground" data-testid="fe-shift-summary">
            {blocker ?? (current ? summaryLine(current.counts) : "")}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void run()} disabled={!!blocker || apply.isPending} data-testid="fe-shift-apply">
              {apply.isPending ? "Saving…" : confirmLabel(current?.counts)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
