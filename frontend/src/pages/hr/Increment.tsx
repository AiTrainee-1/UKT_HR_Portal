import { useMemo, useState } from "react";
import { BarChart3, CalendarClock, History, IndianRupee, Percent, TrendingUp, Users } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useToast } from "@/hooks/use-toast";
import { useListEmployees } from "@/lib/api-client";
import { formatMoney } from "./career/common";
import { monthsLabel, todayYmd } from "./career/dates";
import { PersonCell, StatCard } from "./career/parts";
import { useIncrementHistory } from "./increment/api";
import ApplyTab from "./increment/ApplyTab";
import DueTab from "./increment/DueTab";
import HistoryTab from "./increment/HistoryTab";
import InsightsTab from "./increment/InsightsTab";
import {
  dueForIncrement,
  fullName,
  NO_DUE_FILTERS,
  NO_FILTERS,
  salaryPath,
  summarizeIncrements,
  type DueFilters,
  type HistoryFilters,
  type IncrementEmployee,
  type IncrementRecord,
} from "./increment/logic";
import SalaryTimeline from "./increment/SalaryTimeline";

type TabKey = "apply" | "history" | "due" | "insights";

/** Salary Increment: apply a percentage increment with the new salary previewed to the paisa, read every increment, see who may be due, and the company-wide picture. */
export default function Increment() {
  const { toast } = useToast();
  const today = todayYmd();

  const employeesQuery = useListEmployees({ status: "active" });
  const historyQuery = useIncrementHistory();

  const employees = useMemo<IncrementEmployee[]>(() => employeesQuery.data ?? [], [employeesQuery.data]);
  const records = useMemo<IncrementRecord[]>(() => historyQuery.data?.results ?? [], [historyQuery.data]);
  const total = historyQuery.data?.total ?? 0;

  const [tab, setTab] = useState<TabKey>("apply");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>(NO_FILTERS);
  const [dueFilters, setDueFilters] = useState<DueFilters>(NO_DUE_FILTERS);
  const [threshold, setThreshold] = useState(12);
  const [timelineFor, setTimelineFor] = useState<IncrementRecord | null>(null);

  const summary = useMemo(() => summarizeIncrements(records, today), [records, today]);
  const due = useMemo(
    () => dueForIncrement(employees, records, threshold, today),
    [employees, records, threshold, today],
  );
  const loadingStats = historyQuery.isLoading;

  const retry = () => {
    historyQuery.refetch();
    employeesQuery.refetch();
  };

  const openApply = (employeeId: number) => {
    if (!employees.some((e) => e.id === employeeId)) {
      toast({ title: "That employee is not active, so an increment cannot be given", variant: "destructive" });
      return;
    }
    setSelectedId(employeeId);
    setTab("apply");
    setTimelineFor(null);
  };

  const timelineEmployee = timelineFor ? (employees.find((e) => e.id === timelineFor.employeeId) ?? null) : null;
  const timelineSteps = salaryPath(timelineFor ? records.filter((r) => r.employeeId === timelineFor.employeeId) : []);
  const startSalary = timelineSteps.length ? timelineSteps[timelineSteps.length - 1].from : null;

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Salary Increment</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Track salary growth and apply percentage-based increments
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard
            testId="stat-total"
            label="Total increments"
            value={summary.total}
            sub={`${summary.thisYear.count} this year`}
            icon={History}
            tone="bg-slate-100 text-slate-800"
            loading={loadingStats}
          />
          <StatCard
            testId="stat-employees"
            label="Employees incremented"
            value={summary.employees}
            sub={employeesQuery.isLoading ? undefined : `of ${employees.length} active`}
            icon={Users}
            tone="bg-blue-50 text-blue-800"
            loading={loadingStats}
          />
          <StatCard
            testId="stat-amount"
            label="Total amount increased"
            value={formatMoney(summary.totalAmount)}
            sub={`${formatMoney(summary.thisYear.amount)} this year`}
            icon={IndianRupee}
            tone="bg-green-50 text-green-800"
            loading={loadingStats}
          />
          <StatCard
            testId="stat-avg"
            label="Average increment"
            value={`${summary.avgPercent}%`}
            sub={summary.thisYear.count ? `${summary.thisYear.avgPercent}% this year` : "none this year"}
            icon={Percent}
            tone="bg-purple-50 text-purple-800"
            loading={loadingStats}
          />
          <div className="col-span-2 lg:col-span-1">
            <StatCard
              testId="stat-due"
              label="Due for an increment"
              value={due.rows.length}
              sub={`no increment in ${monthsLabel(threshold)} or more`}
              icon={CalendarClock}
              tone="bg-amber-50 text-amber-800"
              loading={loadingStats || employeesQuery.isLoading}
            />
          </div>
        </div>

        <div>
          <PillTabs
            items={[
              { value: "apply", label: "Apply increment", icon: <TrendingUp size={14} /> },
              { value: "history", label: "History", icon: <History size={14} />, count: total || records.length },
              { value: "due", label: "Due for increment", icon: <CalendarClock size={14} />, count: due.rows.length },
              { value: "insights", label: "Insights", icon: <BarChart3 size={14} /> },
            ]}
            value={tab}
            onChange={(v) => setTab(v as TabKey)}
          />

          {tab === "apply" && (
            <ApplyTab
              employees={employees}
              loading={employeesQuery.isLoading}
              increments={records}
              selectedId={selectedId}
              onSelect={setSelectedId}
              today={today}
            />
          )}
          {tab === "history" && (
            <HistoryTab
              records={records}
              total={total}
              loading={historyQuery.isLoading}
              failed={historyQuery.isError}
              onRetry={retry}
              filters={historyFilters}
              onFilters={setHistoryFilters}
              onTimeline={setTimelineFor}
              onApply={openApply}
              today={today}
            />
          )}
          {tab === "due" && (
            <DueTab
              employees={employees}
              increments={records}
              loading={historyQuery.isLoading || employeesQuery.isLoading}
              failed={historyQuery.isError || employeesQuery.isError}
              onRetry={retry}
              filters={dueFilters}
              onFilters={setDueFilters}
              threshold={threshold}
              onThreshold={setThreshold}
              today={today}
              onApply={openApply}
            />
          )}
          {tab === "insights" && (
            <InsightsTab
              records={records}
              loading={historyQuery.isLoading}
              failed={historyQuery.isError}
              onRetry={retry}
              today={today}
            />
          )}
        </div>

        <Dialog open={timelineFor !== null} onOpenChange={(o) => !o && setTimelineFor(null)}>
          <DialogContent className="max-w-lg" data-testid="timeline-dialog">
            <DialogHeader>
              <DialogTitle>Salary history</DialogTitle>
              <DialogDescription className="sr-only">
                Every increment recorded for this employee, newest first.
              </DialogDescription>
            </DialogHeader>
            {timelineFor && (
              <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
                <PersonCell
                  name={timelineEmployee ? fullName(timelineEmployee) : timelineFor.employeeName}
                  code={timelineFor.employeeCode}
                  photoUrl={timelineEmployee?.photoUrl}
                  size={44}
                  sub={[timelineFor.designation, timelineFor.department].filter(Boolean).join(" · ") || undefined}
                />
                <SalaryTimeline steps={timelineSteps} startSalary={startSalary} />
              </div>
            )}
            {timelineEmployee && (
              <Button
                className="gap-1.5 bg-green-600 hover:bg-green-700"
                onClick={() => openApply(timelineEmployee.id)}
              >
                <TrendingUp size={14} /> Give {timelineEmployee.firstName} an increment
              </Button>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </HrLayout>
  );
}
