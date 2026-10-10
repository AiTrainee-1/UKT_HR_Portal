import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  History,
  IndianRupee,
  Info,
  Loader2,
  TrendingUp,
  TriangleAlert,
  UserSearch,
  Wallet,
} from "lucide-react";
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
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import { useToast } from "@/hooks/use-toast";
import { useAddIncrement, useIncrementSummary } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { formatMoney } from "../career/common";
import { formatDate, monthsBetween, tenureLabel } from "../career/dates";
import { EmptyState, ErrorState, PersonCell, StatCard } from "../career/parts";
import { INCREMENT_HISTORY_KEY } from "./api";
import {
  checkIncrement,
  fullName,
  lastIncrements,
  salaryPath,
  type IncrementEmployee,
  type IncrementRecord,
} from "./logic";
import SalaryTimeline from "./SalaryTimeline";

const QUICK_PERCENTS = [5, 10, 15, 20];

type Props = {
  employees: IncrementEmployee[];
  loading: boolean;
  increments: IncrementRecord[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  today: string;
};

export default function ApplyTab({ employees, loading, increments, selectedId, onSelect, today }: Props) {
  const employee = useMemo(() => employees.find((e) => e.id === selectedId) ?? null, [employees, selectedId]);
  const summary = useIncrementSummary(employee?.employeeCode ?? "", !!employee);
  const last = employee ? (lastIncrements(increments).get(employee.id) ?? null) : null;

  return (
    <div className="space-y-4 pt-3">
      <Card className="rounded-2xl">
        <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-700 sm:w-48">
            <UserSearch size={16} className="text-gray-400" /> Employee to give an increment
          </div>
          <div className="max-w-md flex-1">
            <EmployeeSearchSelect
              employees={employees}
              value={selectedId ? String(selectedId) : ""}
              onChange={(v) => onSelect(v ? Number(v) : null)}
              placeholder={loading ? "Loading employees…" : "Search by employee code or name…"}
              dataTestId="increment-employee-select"
            />
          </div>
        </CardContent>
      </Card>

      {!employee ? (
        <Card className="rounded-2xl">
          <CardContent className="p-0">
            <EmptyState
              testId="apply-empty"
              icon={TrendingUp}
              tone="bg-green-50 text-green-600"
              title="Pick an employee to give an increment"
              text="Search by code or name. You will see their salary picture, the increments they have had, and the new salary before you apply anything."
            />
          </CardContent>
        </Card>
      ) : summary.isLoading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
      ) : summary.isError || !summary.data ? (
        <Card className="rounded-2xl">
          <CardContent className="p-0">
            <ErrorState what="the salary picture" onRetry={() => summary.refetch()} testId="apply-error" />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              testId="emp-current"
              label="Current salary"
              value={formatMoney(summary.data.currentSalary)}
              sub={employee.salaryType === "weekly" ? "per week" : "per month"}
              icon={IndianRupee}
              tone="bg-slate-100 text-slate-800"
            />
            <StatCard
              testId="emp-initial"
              label="Initial salary"
              value={formatMoney(summary.data.initialSalary)}
              sub="when they joined"
              icon={History}
              tone="bg-blue-50 text-blue-800"
            />
            <StatCard
              testId="emp-total"
              label="Total increment"
              value={formatMoney(summary.data.totalIncrementAmount)}
              sub={
                summary.data.initialSalary > 0
                  ? `${Math.round((summary.data.totalIncrementAmount / summary.data.initialSalary) * 1000) / 10}% above the initial salary`
                  : undefined
              }
              icon={TrendingUp}
              tone="bg-green-50 text-green-800"
            />
            <StatCard
              testId="emp-count"
              label="Increments given"
              value={summary.data.totalIncrements}
              sub={last ? `last: ${formatDate(last.date)} (+${last.percent}%)` : "none yet"}
              icon={Wallet}
              tone="bg-purple-50 text-purple-800"
            />
          </div>

          <div className="grid items-start gap-4 lg:grid-cols-5">
            <IncrementForm
              key={employee.id}
              employee={employee}
              currentSalary={summary.data.currentSalary}
              last={last}
              today={today}
            />
            <Card className="rounded-2xl lg:col-span-2">
              <CardContent className="space-y-3 p-4">
                <PersonCell
                  name={fullName(employee)}
                  code={employee.employeeCode}
                  photoUrl={employee.photoUrl}
                  size={40}
                  sub={[employee.designationTitle, employee.departmentName].filter(Boolean).join(" · ")}
                />
                <p className="text-xs font-bold uppercase tracking-wider text-gray-400">
                  Increment history ({summary.data.history.length})
                </p>
                {summary.data.history.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="no-increments">
                    No increments recorded yet. The current salary is the joining salary.
                  </p>
                ) : (
                  <div className="max-h-[28rem] overflow-y-auto pr-1">
                    <SalaryTimeline steps={salaryPath(summary.data.history)} startSalary={summary.data.initialSalary} />
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function IncrementForm({
  employee,
  currentSalary,
  last,
  today,
}: {
  employee: IncrementEmployee;
  currentSalary: number;
  last: { date: string; percent: number } | null;
  today: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const addMutation = useAddIncrement();
  const [percent, setPercent] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [notes, setNotes] = useState("");
  const [confirming, setConfirming] = useState(false);

  const check = checkIncrement({ percent, effectiveDate, currentSalary, joinDate: employee.joinDate }, today, last);
  const untouched = percent.trim() === "";
  const ago = last ? monthsBetween(last.date, today) : null;

  const apply = async () => {
    setConfirming(false);
    if (!check.projection) return;
    const pct = Number(percent);
    try {
      await addMutation.mutateAsync({
        employeeId: employee.id,
        percent: pct,
        effectiveDate,
        notes: notes || undefined,
      });
      queryClient.invalidateQueries({ queryKey: INCREMENT_HISTORY_KEY });
      toast({
        title: "Increment applied",
        description: `${fullName(employee)}: ${formatMoney(currentSalary)} → ${formatMoney(check.projection.newSalary)} (+${pct}%)`,
      });
      setPercent("");
      setNotes("");
    } catch (err: unknown) {
      toast({ title: err instanceof Error ? err.message : "Failed to apply increment", variant: "destructive" });
    }
  };

  return (
    <Card className="rounded-2xl border-2 border-green-100 bg-green-50/20 lg:col-span-3" data-testid="increment-form">
      <CardContent className="space-y-4 p-4">
        <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-green-700">
          <TrendingUp size={13} /> Add salary increment: {fullName(employee)}
        </p>

        <div className="space-y-2">
          <Label className="text-xs">Quick select</Label>
          <div className="flex flex-wrap items-center gap-2">
            {QUICK_PERCENTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPercent(String(p))}
                aria-pressed={percent === String(p)}
                data-testid={`quick-${p}`}
                className={cn(
                  "rounded-xl border-2 px-4 py-2 text-sm font-bold transition-all",
                  percent === String(p)
                    ? "border-green-500 bg-green-50 text-green-700"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300",
                )}
              >
                +{p}%
              </button>
            ))}
            <Input
              type="number"
              min={0.01}
              max={500}
              step={0.01}
              inputMode="decimal"
              placeholder="Custom %"
              aria-label="Custom percentage"
              value={QUICK_PERCENTS.map(String).includes(percent) ? "" : percent}
              onChange={(e) => setPercent(e.target.value)}
              className="h-10 w-28 bg-white"
              data-testid="custom-percent"
            />
          </div>
        </div>

        {/* before / after */}
        <div className="grid items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr]" data-testid="salary-preview">
          <div className="rounded-xl border bg-white p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Now</p>
            <p className="text-lg font-black text-gray-900">{formatMoney(currentSalary)}</p>
          </div>
          <div className="flex flex-col items-center justify-center text-green-600">
            <ArrowRight size={18} className="rotate-90 sm:rotate-0" />
            {check.projection && (
              <span className="text-[11px] font-bold" data-testid="preview-increase">
                +{formatMoney(check.projection.increase)}
              </span>
            )}
          </div>
          <div
            className={cn(
              "rounded-xl border p-3",
              check.projection ? "border-green-200 bg-green-50" : "border-dashed bg-white",
            )}
          >
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">After increment</p>
            {check.projection ? (
              <p className="text-lg font-black text-green-700" data-testid="preview-new-salary">
                {formatMoney(check.projection.newSalary)}
                <span className="ml-2 text-xs font-semibold text-green-600">+{Number(percent)}%</span>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Enter a percentage to see the new salary.</p>
            )}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="inc-date" className="text-xs">
              Effective date
            </Label>
            <Input
              id="inc-date"
              type="date"
              className="h-10 bg-white"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              data-testid="inc-date"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="inc-notes" className="text-xs">
              Notes (optional)
            </Label>
            <Input
              id="inc-notes"
              className="h-10 bg-white"
              placeholder="e.g. Annual appraisal"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="inc-notes"
            />
          </div>
        </div>

        {!untouched && check.errors.length > 0 && (
          <ul className="space-y-1 text-xs text-red-600" role="alert" data-testid="inc-errors">
            {check.errors.map((m) => (
              <li key={m} className="flex items-start gap-1.5">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {m}
              </li>
            ))}
          </ul>
        )}
        {untouched && !(currentSalary > 0) && (
          <p className="flex items-start gap-1.5 text-xs text-red-600" role="alert" data-testid="inc-errors">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {check.errors[0]}
          </p>
        )}
        {check.errors.length === 0 &&
          check.warnings.map((m) => (
            <p key={m} className="flex items-start gap-1.5 text-xs text-amber-700" data-testid="inc-warning">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {m}
            </p>
          ))}
        {last && ago != null && ago >= 6 && (
          <p className="text-xs text-gray-500">
            Last increment: {formatDate(last.date)} ({tenureLabel(ago)} ago, +{last.percent}%).
          </p>
        )}

        <Button
          className="w-full gap-2 bg-green-600 hover:bg-green-700"
          onClick={() => setConfirming(true)}
          disabled={addMutation.isPending || check.errors.length > 0 || !check.projection}
          data-testid="increment-submit"
        >
          {addMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <TrendingUp size={14} />}
          {addMutation.isPending ? "Applying…" : "Apply increment"}
        </Button>
        <p className="flex items-start gap-1.5 text-[11px] text-green-800/70">
          <Info size={12} className="mt-0.5 shrink-0" />
          The salary on the employee's record changes straight away, and the 50% + 50% salary split follows the new
          salary. Each increment is kept in the history.
        </p>
      </CardContent>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid="increment-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Apply a {percent || "0"}% increment to {fullName(employee)}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {check.projection && (
                  <p>
                    <b>{formatMoney(currentSalary)}</b> becomes <b>{formatMoney(check.projection.newSalary)}</b> ( +
                    {formatMoney(check.projection.increase)}), effective {formatDate(effectiveDate)}.
                  </p>
                )}
                <p>The salary on their record changes straight away. An increment cannot be deleted afterwards.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="increment-confirm-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={apply}
              className="bg-green-600 hover:bg-green-700"
              data-testid="increment-confirm-yes"
            >
              Apply increment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
