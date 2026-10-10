import { useMemo, useState } from "react";
import { Award, Building2, CalendarClock, History, TrendingUp, Users } from "lucide-react";
import HrLayout from "@/components/HrLayout";
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
import { PillTabs } from "@/components/ui/pill-tabs";
import { useToast } from "@/hooks/use-toast";
import { useListDepartments, useListEmployees } from "@/lib/api-client";
import { useDeletePromotion, useListDesignations } from "@/lib/api-client/custom-hooks";
import { formatDate, monthsLabel, todayYmd } from "./career/dates";
import { PersonCell, StatCard } from "./career/parts";
import { PROMOTION_LIMIT, usePromotionHistory } from "./promotion/api";
import DueTab from "./promotion/DueTab";
import HistoryTab from "./promotion/HistoryTab";
import {
  dueForReview,
  employeeTimeline,
  fullName,
  NO_DUE_FILTERS,
  NO_FILTERS,
  summarizePromotions,
  type DueFilters,
  type HistoryFilters,
  type PromoEmployee,
  type PromotionRecord,
} from "./promotion/logic";
import PromoteTab from "./promotion/PromoteTab";
import Timeline from "./promotion/Timeline";

type TabKey = "promote" | "history" | "due";

/** Promotion: promote an employee (designation / department) with a before / after, read the whole history, and see who may be due for review. */
export default function Promotion() {
  const { toast } = useToast();
  const today = todayYmd();

  const employeesQuery = useListEmployees({ status: "active" });
  const { data: departments } = useListDepartments();
  const { data: designations } = useListDesignations();
  const historyQuery = usePromotionHistory();
  const deleteMutation = useDeletePromotion();

  const employees = useMemo<PromoEmployee[]>(() => employeesQuery.data ?? [], [employeesQuery.data]);
  const history = useMemo<PromotionRecord[]>(() => historyQuery.data ?? [], [historyQuery.data]);

  const [tab, setTab] = useState<TabKey>("promote");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>(NO_FILTERS);
  const [dueFilters, setDueFilters] = useState<DueFilters>(NO_DUE_FILTERS);
  const [threshold, setThreshold] = useState(24);
  const [toDelete, setToDelete] = useState<PromotionRecord | null>(null);
  const [timelineFor, setTimelineFor] = useState<PromotionRecord | null>(null);

  const summary = useMemo(() => summarizePromotions(history, today), [history, today]);
  const due = useMemo(() => dueForReview(employees, history, threshold, today), [employees, history, threshold, today]);
  const loadingStats = historyQuery.isLoading;

  const retry = () => {
    historyQuery.refetch();
    employeesQuery.refetch();
  };

  const openPromote = (employeeId: number) => {
    setSelectedId(employeeId);
    setTab("promote");
    setTimelineFor(null);
  };

  const runDelete = async () => {
    const record = toDelete;
    setToDelete(null);
    if (!record) return;
    try {
      await deleteMutation.mutateAsync(record.id);
      toast({ title: "Promotion record deleted" });
    } catch {
      toast({ title: "Delete failed", variant: "destructive" });
    }
  };

  const timelineEmployee = timelineFor ? (employees.find((e) => e.id === timelineFor.employeeId) ?? null) : null;
  const timelineRecords = timelineFor ? history.filter((p) => p.employeeId === timelineFor.employeeId) : [];

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Promotion</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Promote employees, update designation and department, and track the full promotion history
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            testId="stat-this-year"
            label="Promotions this year"
            value={summary.thisYear}
            sub={`${summary.thisMonth} this month`}
            icon={Award}
            tone="bg-emerald-50 text-emerald-800"
            loading={loadingStats}
          />
          <StatCard
            testId="stat-employees"
            label="Employees promoted"
            value={summary.employees}
            sub={
              employeesQuery.isLoading
                ? undefined
                : `of ${employees.length} active · ${summary.total} promotions in all`
            }
            icon={Users}
            tone="bg-blue-50 text-blue-800"
            loading={loadingStats}
          />
          <StatCard
            testId="stat-dept-moves"
            label="Department moves"
            value={summary.departmentMoves}
            sub="this year, to another department"
            icon={Building2}
            tone="bg-violet-50 text-violet-800"
            loading={loadingStats}
          />
          <StatCard
            testId="stat-due"
            label="Due for review"
            value={due.rows.length}
            sub={`no promotion in ${monthsLabel(threshold)} or more`}
            icon={CalendarClock}
            tone="bg-amber-50 text-amber-800"
            loading={loadingStats || employeesQuery.isLoading}
          />
        </div>

        <div>
          <PillTabs
            items={[
              { value: "promote", label: "Promote", icon: <TrendingUp size={14} /> },
              { value: "history", label: "History", icon: <History size={14} />, count: history.length },
              { value: "due", label: "Due for review", icon: <CalendarClock size={14} />, count: due.rows.length },
            ]}
            value={tab}
            onChange={(v) => setTab(v as TabKey)}
          />

          {tab === "promote" && (
            <PromoteTab
              employees={employees}
              loading={employeesQuery.isLoading}
              designations={designations ?? []}
              departments={departments ?? []}
              promotions={history}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onDeleteRequest={setToDelete}
              today={today}
            />
          )}
          {tab === "history" && (
            <HistoryTab
              records={history}
              loading={historyQuery.isLoading}
              failed={historyQuery.isError}
              onRetry={retry}
              filters={historyFilters}
              onFilters={setHistoryFilters}
              onTimeline={setTimelineFor}
              onDeleteRequest={setToDelete}
              today={today}
              truncated={history.length >= PROMOTION_LIMIT}
            />
          )}
          {tab === "due" && (
            <DueTab
              employees={employees}
              promotions={history}
              loading={historyQuery.isLoading || employeesQuery.isLoading}
              failed={historyQuery.isError || employeesQuery.isError}
              onRetry={retry}
              filters={dueFilters}
              onFilters={setDueFilters}
              threshold={threshold}
              onThreshold={setThreshold}
              today={today}
              onPromote={openPromote}
            />
          )}
        </div>

        <Dialog open={timelineFor !== null} onOpenChange={(o) => !o && setTimelineFor(null)}>
          <DialogContent className="max-w-lg" data-testid="timeline-dialog">
            <DialogHeader>
              <DialogTitle>Career timeline</DialogTitle>
              <DialogDescription className="sr-only">
                Every promotion recorded for this employee, newest first.
              </DialogDescription>
            </DialogHeader>
            {timelineFor && (
              <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
                <PersonCell
                  name={timelineEmployee ? fullName(timelineEmployee) : timelineFor.employeeName}
                  code={timelineFor.employeeCode}
                  photoUrl={timelineEmployee?.photoUrl}
                  size={44}
                  sub={
                    timelineEmployee
                      ? [timelineEmployee.designationTitle, timelineEmployee.departmentName].filter(Boolean).join(" · ")
                      : `Last position: ${timelineFor.newDesignation ?? "-"}`
                  }
                />
                <Timeline
                  entries={employeeTimeline(
                    timelineEmployee ?? {
                      joinDate: null,
                      designationTitle: timelineFor.newDesignation,
                      departmentName: timelineFor.newDepartment,
                    },
                    timelineRecords,
                  )}
                />
              </div>
            )}
            {timelineEmployee && (
              <Button
                className="gap-1.5 bg-emerald-600 hover:bg-emerald-700"
                onClick={() => openPromote(timelineEmployee.id)}
              >
                <Award size={14} /> Promote {timelineEmployee.firstName}
              </Button>
            )}
          </DialogContent>
        </Dialog>

        <AlertDialog open={toDelete !== null} onOpenChange={(o) => !o && setToDelete(null)}>
          <AlertDialogContent data-testid="confirm-delete">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this promotion record?</AlertDialogTitle>
              <AlertDialogDescription>
                {toDelete &&
                  `The ${formatDate(toDelete.effectiveDate)} promotion of ${toDelete.employeeName} will be removed from the history. `}
                This only removes the history entry: the employee keeps their current designation and department. To
                change those, promote them again.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="confirm-cancel">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={runDelete}
                className="bg-red-600 text-white hover:bg-red-700"
                data-testid="confirm-delete-yes"
              >
                Delete record
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </HrLayout>
  );
}
